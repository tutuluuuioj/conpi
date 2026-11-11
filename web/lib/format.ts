export function round2(n: number) {
  return Math.round(n * 100) / 100;
}

export function usd(n: number) {
  if (n !== 0 && Math.abs(n) < 0.05) {
    return `$${n.toFixed(4)}`;
  }
  return n.toLocaleString("en-US", { style: "currency", currency: "USD" });
}

export function assetAmount(n: number, asset: string) {
  const digits = Math.abs(n) < 1 && n !== 0 ? 4 : 2;
  const text = n.toLocaleString("en-US", { minimumFractionDigits: digits, maximumFractionDigits: digits });
  return `${text} ${asset}`;
}

export function ratioOf(price: number, credit: number) {
  if (!credit) return "0.00×";
  return `${(price / credit).toFixed(2)}×`;
}

export function middle(value: string | null | undefined, lead = 6, tail = 4) {
  if (!value || typeof value !== "string") return "";
  if (value.length <= lead + tail + 1) return value;
  return `${value.slice(0, lead)}…${value.slice(-tail)}`;
}

export function maskKey(value: string) {
  if (value.length <= 8) return "••••••••";
  return `${value.slice(0, 4)}••••••••${value.slice(-4)}`;
}

export function pct(used: number, credit: number) {
  if (!credit) return 0;
  return Math.min(100, Math.round((used / credit) * 100));
}

export function clockTime(value: string) {
  if (!value.includes("T")) return value;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return `${new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit", timeZone: "UTC", hourCycle: "h23" }).format(date)} UTC`;
}

export function absoluteTime(iso: string) {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  return new Intl.DateTimeFormat("en-US", {
    dateStyle: "medium",
    timeStyle: "short",
    timeZone: "UTC",
  }).format(date);
}

export function countdown(iso: string, now = Date.now()) {
  const ms = new Date(iso).getTime() - now;
  const past = ms <= 0;
  const abs = Math.abs(ms);
  const days = Math.floor(abs / 86_400_000);
  const hours = Math.floor((abs % 86_400_000) / 3_600_000);
  const mins = Math.floor((abs % 3_600_000) / 60_000);
  const label = days > 0 ? `${days}d ${hours}h ${String(mins).padStart(2, "0")}m` : `${hours}h ${String(mins).padStart(2, "0")}m`;
  return { label: past ? "0m" : label, past, urgent: !past && ms < 86_400_000 };
}

export function sameTerms(a: { credit: number; price: number; buyerCollateralPct: number; sellerCollateralPct: number; token: string; models: string[]; deadline: string }, b: typeof a) {
  return (
    a.credit === b.credit &&
    a.price === b.price &&
    a.buyerCollateralPct === b.buyerCollateralPct &&
    a.sellerCollateralPct === b.sellerCollateralPct &&
    a.token === b.token &&
    a.deadline === b.deadline &&
    a.models.join("|") === b.models.join("|")
  );
}

export function differingFields(a: { credit: number; price: number; buyerCollateralPct: number; sellerCollateralPct: number; token: string; models: string[]; deadline: string }, b: typeof a) {
  const fields: string[] = [];
  if (a.credit !== b.credit) fields.push("credit");
  if (a.price !== b.price) fields.push("price");
  if (a.buyerCollateralPct !== b.buyerCollateralPct) fields.push("buyer collateral");
  if (a.sellerCollateralPct !== b.sellerCollateralPct) fields.push("seller collateral");
  if (a.token !== b.token) fields.push("token");
  if (a.deadline !== b.deadline) fields.push("deadline");
  if (a.models.join("|") !== b.models.join("|")) fields.push("model allowlist");
  return fields;
}
