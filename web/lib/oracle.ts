let cachedPrice: { price: number; timestamp: number } | null = null;

export async function getLiveNearPrice(): Promise<number> {
  const now = Date.now();
  if (cachedPrice && now - cachedPrice.timestamp < 30_000) {
    return cachedPrice.price;
  }

  try {
    const res = await fetch("/api/oracle/price", { cache: "no-store" });
    if (res.ok) {
      const data = await res.json();
      if (typeof data.price === "number" && data.price > 0) {
        cachedPrice = { price: data.price, timestamp: now };
        return data.price;
      }
    }
  } catch {}

  // Direct client fallback if API is unreachable
  try {
    const res = await fetch("https://api.binance.com/api/v3/ticker/price?symbol=NEARUSDT");
    if (res.ok) {
      const data = await res.json();
      const p = parseFloat(data.price);
      if (!isNaN(p) && p > 0) {
        cachedPrice = { price: p, timestamp: now };
        return p;
      }
    }
  } catch {}

  return cachedPrice ? cachedPrice.price : 4.02;
}

export function usdToNear(usd: number, nearPrice: number): number {
  if (!nearPrice || nearPrice <= 0) return usd;
  return Number((usd / nearPrice).toFixed(6));
}

export function nearToUsd(near: number, nearPrice: number): number {
  if (!nearPrice || nearPrice <= 0) return near;
  return Number((near * nearPrice).toFixed(4));
}
