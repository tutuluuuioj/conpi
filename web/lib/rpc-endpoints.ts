function unique(values: Array<string | undefined>): string[] {
  return Array.from(new Set(values.map((value) => value?.trim()).filter((value): value is string => Boolean(value))));
}

/**
 * Public browser RPC order. Configure the dRPC URLs in the NEXT_PUBLIC_DRPC_*
 * variables; the older configured endpoint and public providers remain
 * automatic fallbacks.
 */
export const NEAR_RPC_ENDPOINTS = unique([
  process.env.NEXT_PUBLIC_DRPC_NEAR_URL,
  process.env.NEXT_PUBLIC_NEAR_RPC,
  "https://archival-rpc.testnet.near.org",
  "https://rpc.testnet.near.org",
  // FastNear is useful as a last-resort provider, but its unauthenticated
  // endpoint throttles frequently. Never bind the wallet or first view read
  // to it when a healthier endpoint is available.
  "https://test.rpc.fastnear.com",
]);

export const SOLANA_RPC_ENDPOINTS = unique([
  process.env.NEXT_PUBLIC_DRPC_SOLANA_URL,
  process.env.NEXT_PUBLIC_SOLANA_RPC,
  "https://api.devnet.solana.com",
]);

export const PRIMARY_NEAR_RPC = NEAR_RPC_ENDPOINTS[0];
export const PRIMARY_SOLANA_RPC = SOLANA_RPC_ENDPOINTS[0];

/** Server routes may use a private dRPC URL without exposing it to browsers. */
export function serverNearRpcEndpoints(): string[] {
  return unique([
    process.env.DRPC_NEAR_URL,
    process.env.NEAR_NODE_URL,
    ...NEAR_RPC_ENDPOINTS,
  ]);
}

export function serverSolanaRpcEndpoints(): string[] {
  return unique([
    process.env.DRPC_SOLANA_URL,
    ...SOLANA_RPC_ENDPOINTS,
  ]);
}
