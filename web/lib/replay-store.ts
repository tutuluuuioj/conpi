import fs from "fs";
import path from "path";

function getStorePath(): string {
  const possiblePaths = [
    path.join(process.cwd(), ".vault_used_txs.json"),
    path.join(process.cwd(), "web", ".vault_used_txs.json"),
  ];
  for (const p of possiblePaths) {
    if (fs.existsSync(p)) return p;
  }
  return possiblePaths[0];
}

const STORE_PATH = getStorePath();

interface UsedTxRecord {
  chain: string;
  txHash: string;
  dealId: number;
  amountAtomic: string;
  amountUsdc: number;
  timestamp: number;
}

let memoryCache: Map<string, UsedTxRecord> = new Map();
let isInitialized = false;

function loadStore() {
  if (isInitialized) return;
  try {
    if (fs.existsSync(STORE_PATH)) {
      const raw = fs.readFileSync(STORE_PATH, "utf-8");
      const data = JSON.parse(raw);
      if (Array.isArray(data)) {
        for (const record of data) {
          const key = `${record.chain.toLowerCase()}:${record.txHash.toLowerCase()}`;
          memoryCache.set(key, record);
        }
      }
    }
  } catch (err) {
    console.warn("[replay-store] Warning loading used txs store:", err);
  }
  isInitialized = true;
}

function persistStore() {
  try {
    const list = Array.from(memoryCache.values());
    fs.writeFileSync(STORE_PATH, JSON.stringify(list, null, 2), "utf-8");
  } catch (err) {
    console.warn("[replay-store] Warning writing used txs store:", err);
  }
}

export function isTxUsed(chain: string, txHash: string): boolean {
  loadStore();
  const key = `${chain.toLowerCase()}:${txHash.toLowerCase()}`;
  return memoryCache.has(key);
}

export function markTxUsed(params: {
  chain: string;
  txHash: string;
  dealId: number;
  amountAtomic: string;
  amountUsdc: number;
}): void {
  loadStore();
  const key = `${params.chain.toLowerCase()}:${params.txHash.toLowerCase()}`;
  memoryCache.set(key, {
    ...params,
    timestamp: Date.now(),
  });
  persistStore();
}

export function getUsedTxRecord(chain: string, txHash: string): UsedTxRecord | undefined {
  loadStore();
  const key = `${chain.toLowerCase()}:${txHash.toLowerCase()}`;
  return memoryCache.get(key);
}
