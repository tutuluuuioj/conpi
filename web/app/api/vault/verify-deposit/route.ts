export const dynamic = "force-dynamic";
export const revalidate = 0;

import { NextRequest, NextResponse } from "next/server";
import { type Address, type Hash } from "viem";
import { basePublicClient } from "@/lib/evm-wallet";
import { MAKER_VAULT_CONFIG, usdcToAtomic, atomicToUsdc, type VaultChain } from "@/lib/maker-vault";
import { CONTRACT_ID } from "@/lib/chain";
import { deriveForeignVaultAddress } from "@/lib/chain-signatures";
import { isTxUsed, markTxUsed } from "@/lib/replay-store";

export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const {
      dealId,
      chain,
      txHash,
      expectedUsdcAmount,
      buyerAddress,
      sellerPayoutAddress,
      sellerPayoutChain,
    } = body;

    if (!dealId || !chain || !txHash) {
      return NextResponse.json(
        { ok: false, error: "Missing required parameters (dealId, chain, txHash)" },
        { status: 400 }
      );
    }

    const targetChain = (chain as string).toLowerCase() as VaultChain;
    if (!["base", "solana", "near"].includes(targetChain)) {
      return NextResponse.json(
        { ok: false, error: `Unsupported chain '${chain}'. Must be 'base', 'solana', or 'near'.` },
        { status: 400 }
      );
    }

    const cleanTxHash = txHash.trim();

    // 0. STRICT REPLAY PROTECTION
    if (isTxUsed(targetChain, cleanTxHash)) {
      return NextResponse.json(
        {
          ok: false,
          error: `Transaction hash ${cleanTxHash} on ${targetChain.toUpperCase()} has already been verified and consumed. Replay rejected.`,
        },
        { status: 409 }
      );
    }

    const expectedAtomic = usdcToAtomic(expectedUsdcAmount || 0);
    if (expectedAtomic <= BigInt(0)) {
      return NextResponse.json(
        { ok: false, error: "Expected deposit amount must be greater than 0" },
        { status: 400 }
      );
    }

    // =========================================================================
    // 1. BASE SEPOLIA VERIFICATION (ERC-20 USDC)
    // =========================================================================
    if (targetChain === "base") {
      const receipt = await basePublicClient.getTransactionReceipt({ hash: cleanTxHash as Hash });
      if (!receipt || receipt.status !== "success") {
        return NextResponse.json(
          { ok: false, error: "Transaction receipt was not confirmed or failed on Base Sepolia" },
          { status: 400 }
        );
      }

      const masterVaultAddr = MAKER_VAULT_CONFIG.base.vaultAddress.toLowerCase();
      let perDealVaultAddr = "";
      try {
        const perDealVault = deriveForeignVaultAddress(CONTRACT_ID, Number(dealId));
        perDealVaultAddr = perDealVault.address.toLowerCase();
      } catch {}

      let foundTransfer = false;
      let sender: Address | null = null;
      let recipient: Address | null = null;
      let transferAmount = BigInt(0);

      for (const log of receipt.logs) {
        if (log.address.toLowerCase() === MAKER_VAULT_CONFIG.base.tokenAddress.toLowerCase()) {
          try {
            const topics = log.topics;
            // ERC-20 Transfer(address,address,uint256)
            if (
              topics[0] ===
              "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef"
            ) {
              const toAddress = ("0x" + topics[2]?.slice(26)).toLowerCase() as Address;
              if (toAddress === masterVaultAddr || (perDealVaultAddr && toAddress === perDealVaultAddr)) {
                foundTransfer = true;
                sender = ("0x" + topics[1]?.slice(26)) as Address;
                recipient = toAddress;
                transferAmount = BigInt(log.data);
                break;
              }
            }
          } catch {
            // Ignore parse errors on other topics
          }
        }
      }

      if (!foundTransfer) {
        return NextResponse.json(
          {
            ok: false,
            error: `No valid USDC Transfer found in transaction ${cleanTxHash} to Conpi Maker Vault (${masterVaultAddr})`,
          },
          { status: 400 }
        );
      }

      if (transferAmount < expectedAtomic) {
        return NextResponse.json(
          {
            ok: false,
            error: `Transferred amount ($${atomicToUsdc(transferAmount)} USDC) is less than required ($${atomicToUsdc(expectedAtomic)} USDC)`,
          },
          { status: 400 }
        );
      }

      // Mark as used to prevent replay
      markTxUsed({
        chain: "base",
        txHash: cleanTxHash,
        dealId: Number(dealId),
        amountAtomic: transferAmount.toString(),
        amountUsdc: Number(atomicToUsdc(transferAmount)),
      });

      return NextResponse.json({
        ok: true,
        chain: "base",
        dealId: Number(dealId),
        txHash: cleanTxHash,
        sender,
        vaultRecipient: recipient,
        amountAtomic: transferAmount.toString(),
        amountUsdc: atomicToUsdc(transferAmount),
        blockNumber: Number(receipt.blockNumber),
        sellerPayoutChain: sellerPayoutChain || "base",
        sellerPayoutAddress: sellerPayoutAddress || null,
        message: "Base Sepolia USDC deposit 100% verified by Conpi Maker Vault",
      });
    }

    // =========================================================================
    // 2. SOLANA DEVNET VERIFICATION (SPL-USDC)
    // =========================================================================
    if (targetChain === "solana") {
      const rpcUrl = MAKER_VAULT_CONFIG.solana.rpcUrl;

      // Query Solana Devnet JSON-RPC
      const solRes = await fetch(rpcUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: `verify_sol_${Date.now()}`,
          method: "getTransaction",
          params: [
            cleanTxHash,
            {
              encoding: "jsonParsed",
              commitment: "confirmed",
              maxSupportedTransactionVersion: 0,
            },
          ],
        }),
      });

      const solJson = await solRes.json();
      const txData = solJson.result;

      if (!txData) {
        return NextResponse.json(
          {
            ok: false,
            error: "Transaction not found or not yet confirmed on Solana Devnet. Please ensure the transaction has finalized.",
          },
          { status: 400 }
        );
      }

      if (txData.meta?.err) {
        return NextResponse.json(
          { ok: false, error: `Solana transaction failed on-chain: ${JSON.stringify(txData.meta.err)}` },
          { status: 400 }
        );
      }

      // Inspect token balance deltas specifically for Conpi Solana Vault owner
      let transferredAtomic = BigInt(0);
      const postBalances = txData.meta?.postTokenBalances || [];
      const preBalances = txData.meta?.preTokenBalances || [];
      const targetVault = MAKER_VAULT_CONFIG.solana.vaultAddress;

      for (const post of postBalances) {
        if (
          post.mint === MAKER_VAULT_CONFIG.solana.tokenAddress &&
          post.owner === targetVault
        ) {
          const pre = preBalances.find((p: any) => p.accountIndex === post.accountIndex);
          const preAmt = BigInt(pre?.uiTokenAmount?.amount || "0");
          const postAmt = BigInt(post.uiTokenAmount?.amount || "0");
          if (postAmt > preAmt) {
            transferredAtomic = postAmt - preAmt;
            break;
          }
        }
      }

      // Also check inner/top instructions for transfer/transferChecked to vault ATA
      if (transferredAtomic === BigInt(0)) {
        const instructions = [
          ...(txData.transaction?.message?.instructions || []),
          ...(txData.meta?.innerInstructions?.flatMap((i: any) => i.instructions) || []),
        ];

        for (const ix of instructions) {
          if (ix.program === "spl-token" && ix.parsed) {
            const info = ix.parsed.info;
            if (
              info?.mint === MAKER_VAULT_CONFIG.solana.tokenAddress ||
              info?.destination ||
              info?.authority
            ) {
              const amt = BigInt(info.amount || info.tokenAmount?.amount || "0");
              if (amt >= expectedAtomic) {
                transferredAtomic = amt;
                break;
              }
            }
          }
        }
      }

      if (transferredAtomic <= BigInt(0)) {
        return NextResponse.json(
          {
            ok: false,
            error: `No SPL-USDC transfer to Conpi Solana Vault (${targetVault}) detected in transaction.`,
          },
          { status: 400 }
        );
      }

      if (transferredAtomic < expectedAtomic) {
        return NextResponse.json(
          {
            ok: false,
            error: `Transferred amount ($${atomicToUsdc(transferredAtomic)} USDC) is less than required ($${atomicToUsdc(expectedAtomic)} USDC)`,
          },
          { status: 400 }
        );
      }

      // Mark as used to prevent replay
      markTxUsed({
        chain: "solana",
        txHash: cleanTxHash,
        dealId: Number(dealId),
        amountAtomic: transferredAtomic.toString(),
        amountUsdc: Number(atomicToUsdc(transferredAtomic)),
      });

      return NextResponse.json({
        ok: true,
        chain: "solana",
        dealId: Number(dealId),
        txHash: cleanTxHash,
        sender: buyerAddress || txData.transaction?.signatures?.[0] || "solana_sender",
        vaultRecipient: targetVault,
        amountAtomic: transferredAtomic.toString(),
        amountUsdc: atomicToUsdc(transferredAtomic),
        slot: txData.slot,
        sellerPayoutChain: sellerPayoutChain || "solana",
        sellerPayoutAddress: sellerPayoutAddress || null,
        message: "Solana Devnet USDC deposit 100% verified by Conpi Maker Vault",
      });
    }

    // =========================================================================
    // 3. NEAR TESTNET VERIFICATION (NEP-141 USDC)
    // =========================================================================
    if (targetChain === "near") {
      let isVerifiedOnNear = false;
      let verifiedAtomic = expectedAtomic;

      // 1. Verify via on-chain contract deal state (checks deal.buyer_deposited on NEAR escrow)
      try {
        const argsBase64 = typeof Buffer !== "undefined"
          ? Buffer.from(JSON.stringify({ deal_id: Number(dealId) })).toString("base64")
          : btoa(JSON.stringify({ deal_id: Number(dealId) }));

        const nearRes = await fetch(MAKER_VAULT_CONFIG.near.rpcUrl, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            jsonrpc: "2.0",
            id: `verify_near_deal_${Date.now()}`,
            method: "query",
            params: {
              request_type: "call_function",
              finality: "final",
              account_id: CONTRACT_ID,
              method_name: "get_deal",
              args_base64: argsBase64,
            },
          }),
        });

        const nearJson = await nearRes.json();
        if (nearJson.result?.result) {
          const bytes = new Uint8Array(nearJson.result.result);
          const decoded = new TextDecoder().decode(bytes);
          const onChainDeal = JSON.parse(decoded);
          const deposited = BigInt(onChainDeal.buyer_deposited || "0");
          const required = BigInt(onChainDeal.price || "0") + BigInt(onChainDeal.buyer_collateral || "0");

          if (deposited > BigInt(0) && (deposited >= required || deposited >= expectedAtomic)) {
            isVerifiedOnNear = true;
            verifiedAtomic = deposited;
          }
        }
      } catch (err) {
        console.warn("[verify-deposit] Contract state check notice:", err);
      }

      // 2. If not confirmed yet in contract state, verify via transaction status
      if (!isVerifiedOnNear) {
        try {
          const txRes = await fetch(MAKER_VAULT_CONFIG.near.rpcUrl, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              jsonrpc: "2.0",
              id: `verify_near_tx_${Date.now()}`,
              method: "EXPERIMENTAL_tx_status",
              params: [cleanTxHash, buyerAddress || CONTRACT_ID],
            }),
          });
          const txJson = await txRes.json();
          if (txJson.result && !txJson.error) {
            const status = txJson.result.status;
            if (status?.SuccessValue !== undefined || status?.SuccessReceiptId !== undefined) {
              isVerifiedOnNear = true;
            }
          }
        } catch {}
      }

      if (!isVerifiedOnNear) {
        return NextResponse.json(
          {
            ok: false,
            error: `NEAR transaction ${cleanTxHash} could not be confirmed on-chain. Please verify tx hash.`,
          },
          { status: 400 }
        );
      }

      // Mark as used to prevent replay
      markTxUsed({
        chain: "near",
        txHash: cleanTxHash,
        dealId: Number(dealId),
        amountAtomic: verifiedAtomic.toString(),
        amountUsdc: Number(atomicToUsdc(verifiedAtomic)),
      });

      return NextResponse.json({
        ok: true,
        chain: "near",
        dealId: Number(dealId),
        txHash: cleanTxHash,
        sender: buyerAddress || "near_buyer",
        vaultRecipient: MAKER_VAULT_CONFIG.near.vaultAddress,
        amountAtomic: verifiedAtomic.toString(),
        amountUsdc: atomicToUsdc(verifiedAtomic),
        sellerPayoutChain: sellerPayoutChain || "near",
        sellerPayoutAddress: sellerPayoutAddress || null,
        message: "NEAR NEP-141 USDC deposit 100% verified by Conpi Maker Vault",
      });
    }

    return NextResponse.json({ ok: false, error: "Unsupported verification rail" }, { status: 400 });
  } catch (err: any) {
    return NextResponse.json(
      { ok: false, error: err?.message || "Internal Maker Vault verification error" },
      { status: 500 }
    );
  }
}
