import { NextResponse } from "next/server";

let cachedPrice: { price: number; timestamp: number } | null = null;
const CACHE_TTL_MS = 60_000; // 60 seconds cache

async function fetchFromCoinGecko(): Promise<number | null> {
  try {
    const res = await fetch("https://api.coingecko.com/api/v3/simple/price?ids=near&vs_currencies=usd", {
      signal: AbortSignal.timeout(3000),
      cache: "no-store",
    });
    if (res.ok) {
      const data = await res.json();
      const p = Number(data?.near?.usd);
      if (p > 0) return p;
    }
  } catch {}
  return null;
}

async function fetchFromBinance(): Promise<number | null> {
  try {
    const res = await fetch("https://api.binance.com/api/v3/ticker/price?symbol=NEARUSDT", {
      signal: AbortSignal.timeout(3000),
      cache: "no-store",
    });
    if (res.ok) {
      const data = await res.json();
      const p = parseFloat(data?.price);
      if (!isNaN(p) && p > 0) return p;
    }
  } catch {}
  return null;
}

async function fetchFromCoinbase(): Promise<number | null> {
  try {
    const res = await fetch("https://api.coinbase.com/v2/prices/NEAR-USD/spot", {
      signal: AbortSignal.timeout(3000),
      cache: "no-store",
    });
    if (res.ok) {
      const data = await res.json();
      const p = parseFloat(data?.data?.amount);
      if (!isNaN(p) && p > 0) return p;
    }
  } catch {}
  return null;
}

export async function GET() {
  const now = Date.now();
  if (cachedPrice && now - cachedPrice.timestamp < CACHE_TTL_MS) {
    return NextResponse.json({ ok: true, price: cachedPrice.price, cached: true, timestamp: cachedPrice.timestamp });
  }

  const price = (await fetchFromCoinGecko()) || (await fetchFromBinance()) || (await fetchFromCoinbase()) || (cachedPrice ? cachedPrice.price : 4.02);

  cachedPrice = { price, timestamp: now };
  return NextResponse.json({ ok: true, price, cached: false, timestamp: now });
}
