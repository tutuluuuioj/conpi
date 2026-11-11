export const dynamic = "force-dynamic";
export const revalidate = 0;

import { NextResponse } from "next/server";

function escrowOnlyResponse() {
  return NextResponse.json(
    {
      ok: false,
      error: "Off-chain payout destinations are disabled. The seller must register the destination on the escrow contract.",
    },
    { status: 410, headers: { "Cache-Control": "no-store" } }
  );
}

export async function POST() {
  return escrowOnlyResponse();
}

export async function GET() {
  return escrowOnlyResponse();
}
