export const dynamic = "force-dynamic";
export const revalidate = 0;

import { NextRequest, NextResponse } from "next/server";
import { type Address, type Hash } from "viem";
import { basePublicClient } from "@/lib/evm-wallet";
import { BASE_SEPOLIA_USDC, deriveForeignVaultAddress } from "@/lib/chain-signatures";
import { CONTRACT_ID } from "@/lib/chain";

async function getLockedForeignDeal(dealId: number): Promise<any | null> {
  const argsBase64 = Buffer.from(JSON.stringify({ deal_id: dealId })).toString("base64");
  const response = await fetch(process.env.NEAR_NODE_URL || "https://rpc.testnet.near.org", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    cache: "no-store",
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: `foreign-deal-${dealId}`,
      method: "query",
      params: {
        request_type: "call_function",
        finality: "final",
        account_id: CONTRACT_ID,
        method_name: "get_foreign_deal",
        args_base64: argsBase64,
      },
    }),
  });
  if (!response.ok) throw new Error(`NEAR RPC returned ${response.status}`);
  const rpc = await response.json();
  if (rpc.error) throw new Error(rpc.error?.data || rpc.error?.message || "NEAR RPC query failed");
  const bytes = rpc.result?.result;
  if (!Array.isArray(bytes)) return null;
  return JSON.parse(Buffer.from(bytes).toString("utf8"));
}

export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const { dealId, txHash } = body;

    if (!dealId || !txHash) {
      return NextResponse.json(
        { ok: false, error: "Missing required dealId or txHash" },
        { status: 400 }
      );
    }

    const foreignDeal = await getLockedForeignDeal(Number(dealId));
    if (!foreignDeal || BigInt(foreignDeal.foreign_amount || "0") <= BigInt(0)) {
      return NextResponse.json(
        { ok: false, error: "On-chain foreign deal amount is not registered" },
        { status: 409 }
      );
    }

    const vault = deriveForeignVaultAddress(CONTRACT_ID, Number(dealId));
    if (String(foreignDeal.vault_address || "").toLowerCase() !== vault.address.toLowerCase()) {
      return NextResponse.json(
        { ok: false, error: "Registered vault does not match the deterministic deal vault" },
        { status: 409 }
      );
    }
    const receipt = await basePublicClient.getTransactionReceipt({ hash: txHash as Hash });
    if (!receipt || receipt.status !== "success") {
      return NextResponse.json(
        { ok: false, error: "Transaction receipt was not confirmed or failed on Base Sepolia" },
        { status: 400 }
      );
    }

    // Inspect logs for ERC-20 Transfer to the vault address
    let foundTransfer = false;
    let sender: Address | null = null;
    let transferAmount = BigInt(0);

    for (const log of receipt.logs) {
      if (log.address.toLowerCase() === BASE_SEPOLIA_USDC.toLowerCase()) {
        try {
          const topics = log.topics;
          if (
            topics[0] ===
            "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef"
          ) {
            const toAddress = ("0x" + topics[2]?.slice(26)) as Address;
            if (toAddress.toLowerCase() === vault.address.toLowerCase()) {
              foundTransfer = true;
              sender = ("0x" + topics[1]?.slice(26)) as Address;
              transferAmount = BigInt(log.data);
              break;
            }
          }
        } catch {
          // ignore parse errors on irrelevant topics
        }
      }
    }

    const minAmount = BigInt(foreignDeal.foreign_amount);
    if (!foundTransfer || transferAmount < minAmount) {
      return NextResponse.json(
        {
          ok: false,
          error: foundTransfer
            ? `Transferred amount (${transferAmount.toString()}) is less than expected minimum (${minAmount.toString()})`
            : `No USDC Transfer to vault ${vault.address} found in tx receipt`,
          vaultAddress: vault.address,
        },
        { status: 400 }
      );
    }

    return NextResponse.json({
      ok: true,
      vaultAddress: vault.address,
      verification: {
        ok: true,
        sender,
        vault: vault.address,
        amountAtomic: transferAmount.toString(),
        txHash,
        blockNumber: Number(receipt.blockNumber),
      },
    });
  } catch (err: any) {
    return NextResponse.json(
      { ok: false, error: err?.message || "Internal deposit verification error" },
      { status: 500 }
    );
  }
}
