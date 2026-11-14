import { NextResponse } from "next/server";
import { callServerNearView } from "@/lib/server-near-rpc";

export const dynamic = "force-dynamic";
export const revalidate = 0;

export async function GET(_request: Request, { params }: { params: { id: string } }) {
  const dealId = Number(params.id);
  if (!Number.isSafeInteger(dealId) || dealId <= 0) {
    return NextResponse.json({ ok: false, error: "Invalid deal id" }, { status: 400 });
  }

  try {
    const deal = await callServerNearView("get_deal", { deal_id: dealId });
    return NextResponse.json({ ok: true, deal });
  } catch (error) {
    return NextResponse.json(
      { ok: false, error: error instanceof Error ? error.message : "NEAR RPC unavailable" },
      { status: 503 },
    );
  }
}
