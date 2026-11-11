export const dynamic = "force-dynamic";
export const revalidate = 0;

import { NextResponse } from "next/server";
import { fetchMakerVaultReserves, MAKER_VAULT_CONFIG } from "@/lib/maker-vault";

export async function GET() {
  try {
    const reserves = await fetchMakerVaultReserves();
    return NextResponse.json({
      ok: true,
      vaults: MAKER_VAULT_CONFIG,
      reserves,
    });
  } catch (err: any) {
    return NextResponse.json(
      { ok: false, error: err?.message || "Failed to fetch maker vault reserves" },
      { status: 500 }
    );
  }
}
