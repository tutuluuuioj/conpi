import { NextResponse } from "next/server";
import { callServerNearView } from "@/lib/server-near-rpc";

export const dynamic = "force-dynamic";
export const revalidate = 0;

export async function GET() {
  try {
    const vault = await callServerNearView("get_solana_vault_config", {});
    return NextResponse.json({ ok: true, vault });
  } catch (error) {
    return NextResponse.json(
      { ok: false, error: error instanceof Error ? error.message : "NEAR RPC unavailable" },
      { status: 503 },
    );
  }
}
