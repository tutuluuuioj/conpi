export const dynamic = "force-dynamic";
export const revalidate = 0;

import { NextRequest, NextResponse } from "next/server";
import fs from "fs";
import path from "path";

const DEST_FILE = path.join(process.cwd(), ".vault_payout_destinations.json");

function getDestinations(): Record<string, any> {
  try {
    if (fs.existsSync(DEST_FILE)) {
      return JSON.parse(fs.readFileSync(DEST_FILE, "utf-8"));
    }
  } catch {}
  return {};
}

function saveDestination(dealId: number, data: any) {
  try {
    const all = getDestinations();
    all[String(dealId)] = { ...data, updatedAt: Date.now() };
    fs.writeFileSync(DEST_FILE, JSON.stringify(all, null, 2), "utf-8");
  } catch (err) {
    console.warn("Failed to persist payout destination:", err);
  }
}

export async function POST(req: NextRequest) {
  try {
    const { dealId, payoutRail, payoutAddress } = await req.json();
    if (!dealId || !payoutRail || !payoutAddress) {
      return NextResponse.json(
        { ok: false, error: "Missing required parameters (dealId, payoutRail, payoutAddress)" },
        { status: 400 }
      );
    }

    const rail = String(payoutRail).toLowerCase();
    const cleanAddr = String(payoutAddress).trim();

    // Format Validation per chain
    if (rail === "base") {
      if (!/^0x[0-9a-fA-F]{40}$/.test(cleanAddr)) {
        return NextResponse.json({ ok: false, error: "Invalid Base Sepolia EVM address format (must be 0x hex 40 chars)" }, { status: 400 });
      }
    } else if (rail === "solana") {
      if (!/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(cleanAddr)) {
        return NextResponse.json({ ok: false, error: "Invalid Solana address format (must be valid Base58 public key)" }, { status: 400 });
      }
    } else if (rail === "near") {
      if (!/^(([a-z0-9_-]+\.)*[a-z0-9_-]+|[0-9a-f]{64})$/.test(cleanAddr)) {
        return NextResponse.json({ ok: false, error: "Invalid NEAR account ID format" }, { status: 400 });
      }
    } else {
      return NextResponse.json({ ok: false, error: `Unsupported payout rail '${rail}'` }, { status: 400 });
    }

    saveDestination(Number(dealId), { payoutRail: rail, payoutAddress: cleanAddr });

    return NextResponse.json({
      ok: true,
      dealId: Number(dealId),
      payoutRail: rail,
      payoutAddress: cleanAddr,
      message: `Seller payout destination successfully saved and verified for ${rail.toUpperCase()}`,
    });
  } catch (err: any) {
    return NextResponse.json({ ok: false, error: err?.message || "Internal server error" }, { status: 500 });
  }
}

export async function GET(req: NextRequest) {
  const { searchParams } = new URL(req.url);
  const dealId = searchParams.get("dealId");
  if (!dealId) {
    return NextResponse.json({ ok: false, error: "dealId query parameter required" }, { status: 400 });
  }
  const all = getDestinations();
  const dest = all[String(dealId)];
  if (!dest) {
    return NextResponse.json({ ok: false, error: "No custom payout destination found" }, { status: 404 });
  }
  return NextResponse.json({ ok: true, dealId: Number(dealId), ...dest });
}
