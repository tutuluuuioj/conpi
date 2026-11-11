export const dynamic = "force-dynamic";
export const revalidate = 0;

import { NextResponse } from "next/server";

/**
 * Browser-supplied pooled-vault deposits cannot change escrow state. Base
 * deposits are verified by the TEE against the seller-locked foreign_amount
 * and then recorded through a TEE-signed contract payload. NEAR deposits use
 * ft_transfer_call directly into the escrow contract.
 */
export async function POST() {
  return NextResponse.json(
    {
      ok: false,
      error: "Shared Maker Vault verification is disabled. Use TEE-verified per-deal escrow funding.",
    },
    { status: 410, headers: { "Cache-Control": "no-store" } }
  );
}
