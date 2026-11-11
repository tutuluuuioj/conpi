export const dynamic = "force-dynamic";
export const revalidate = 0;

import { NextRequest, NextResponse } from "next/server";

const TEE_BASE_URL =
  process.env.NEXT_PUBLIC_TEE_URL ||
  "https://b1b35377079ac7b7937afc607481587bc6d22665-3000.dstack-pha-prod9.phala.network";

/**
 * Same-origin bridge to the enclave meter. This route deliberately owns no
 * provider key, price table, usage counter, or payout logic; the attested TEE
 * is the single source of truth.
 */
export async function GET(req: NextRequest) {
  const { searchParams } = new URL(req.url);
  const dealId = searchParams.get("dealId") || searchParams.get("id");
  const authorization = req.headers.get("authorization") || "";

  if (!dealId || !/^\d+$/.test(dealId)) {
    return NextResponse.json({ error: { message: "Valid dealId is required", code: "invalid_deal_id" } }, { status: 400 });
  }
  if (!authorization.toLowerCase().startsWith("bearer cpk_live_")) {
    return NextResponse.json({ error: { message: "TEE proxy key is required", code: "unauthorized" } }, { status: 401 });
  }

  try {
    const upstream = await fetch(`${TEE_BASE_URL}/v1/deals/${dealId}/meter`, {
      headers: { Authorization: authorization },
      cache: "no-store",
      signal: AbortSignal.timeout(8_000),
    });
    const body = await upstream.text();
    return new NextResponse(body, {
      status: upstream.status,
      headers: {
        "content-type": upstream.headers.get("content-type") || "application/json",
        "cache-control": "no-store",
      },
    });
  } catch (error: any) {
    return NextResponse.json(
      { error: { message: error?.message || "TEE meter unavailable", code: "tee_unavailable" } },
      { status: 502 }
    );
  }
}
