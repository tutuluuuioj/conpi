export const dynamic = "force-dynamic";
export const revalidate = 0;

import { NextRequest, NextResponse } from "next/server";
import {
  getAddress,
  serializeTransaction,
  type Hex,
  type Address,
} from "viem";
import { basePublicClient } from "@/lib/evm-wallet";
import {
  BASE_SEPOLIA_CHAIN_ID,
  BASE_SEPOLIA_USDC,
  computeForeignTransferSighash,
  deriveForeignVaultAddress,
} from "@/lib/chain-signatures";
import { CONTRACT_ID } from "@/lib/chain";

export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const {
      dealId,
      recipient,
      amountAtomic,
      rHex,
      sHex,
      recoveryId,
      nonce,
      chainId,
      tokenAddress,
    } = body;

    if (!dealId || !recipient || !amountAtomic || !rHex || !sHex) {
      return NextResponse.json(
        { ok: false, error: "Missing required parameters (dealId, recipient, amountAtomic, rHex, sHex)" },
        { status: 400 }
      );
    }

    const vault = deriveForeignVaultAddress(CONTRACT_ID, Number(dealId));
    const targetChainId = Number(chainId || BASE_SEPOLIA_CHAIN_ID);
    const targetToken = (tokenAddress || BASE_SEPOLIA_USDC) as Address;

    // Determine EVM nonce on Base Sepolia
    const txNonce = nonce !== undefined && nonce !== null
      ? Number(nonce)
      : await basePublicClient.getTransactionCount({ address: vault.address });

    const { tx } = computeForeignTransferSighash({
      recipient,
      amountAtomic: BigInt(amountAtomic),
      nonce: txNonce,
      tokenAddress: targetToken,
      chainId: targetChainId,
    });

    let cleanR = String(rHex).replace(/^0x/, "");
    if (cleanR.length === 66) cleanR = cleanR.slice(2);
    const r = ("0x" + cleanR.padStart(64, "0")) as Hex;

    let cleanS = String(sHex).replace(/^0x/, "");
    if (cleanS.length === 66) cleanS = cleanS.slice(2);
    const s = ("0x" + cleanS.padStart(64, "0")) as Hex;

    const yParity = Number(recoveryId) === 1 ? 1 : 0;

    const signedRawTx = serializeTransaction(tx, {
      r,
      s,
      yParity,
    });

    // Check if vault has sufficient ETH to pay Base Sepolia gas
    const vaultBal = await basePublicClient.getBalance({ address: vault.address });
    const minGasRequired = BigInt("30000000000000"); // 0.00003 ETH
    if (vaultBal < minGasRequired) {
      const operatorKey = (process.env.OPERATOR_EVM_PRIVATE_KEY || process.env.BASE_SEPOLIA_RELAYER_KEY) as Hex | undefined;
      if (operatorKey) {
        console.log(`[broadcast-payout] Vault ${vault.address} has low gas (${vaultBal.toString()} wei). Auto-sponsoring gas...`);
        const { createWalletClient, http } = await import("viem");
        const { privateKeyToAccount } = await import("viem/accounts");
        const { baseSepolia } = await import("viem/chains");
        const opAccount = privateKeyToAccount(operatorKey.startsWith("0x") ? operatorKey : `0x${operatorKey}`);
        const opClient = createWalletClient({
          account: opAccount,
          chain: baseSepolia,
          transport: http(process.env.BASE_SEPOLIA_RPC || "https://sepolia.base.org"),
        });
        const sponsorTx = await opClient.sendTransaction({
          to: vault.address,
          value: BigInt("200000000000000"), // 0.0002 ETH
        });
        await basePublicClient.waitForTransactionReceipt({ hash: sponsorTx, confirmations: 1 });
        console.log(`[broadcast-payout] Gas sponsored successfully: ${sponsorTx}`);
      } else {
        throw new Error(`Vault ${vault.address} has 0 ETH for gas on Base Sepolia. Please fund 0.0005 ETH to the vault, or configure OPERATOR_EVM_PRIVATE_KEY on the server to auto-sponsor.`);
      }
    }

    console.log(`[broadcast-payout] Broadcasting raw tx for Deal #${dealId} from vault ${vault.address}...`);
    const txHash = await basePublicClient.sendRawTransaction({
      serializedTransaction: signedRawTx,
    });

    console.log(`[broadcast-payout] Broadcast successful! Tx Hash: ${txHash}`);

    return NextResponse.json({
      success: true,
      txHash,
      vaultAddress: vault.address,
    });
  } catch (err: any) {
    console.error("[broadcast-payout] Broadcast error:", err);
    return NextResponse.json(
      { success: false, error: err?.message || String(err) },
      { status: 400 }
    );
  }
}
