import dotenv from "dotenv";
dotenv.config();

export const CONFIG = {
  port: parseInt(process.env.PORT || "3000", 10),
  host: process.env.HOST || "0.0.0.0",
  networkId: process.env.NEAR_NETWORK || "testnet",
  nodeUrl: process.env.NEAR_NODE_URL || "https://rpc.testnet.fastnear.com",
  contractId: process.env.CONTRACT_ID || "dev-20261103062448-30583839049419.testnet",
  daoId: process.env.DAO_ID || "dev-20261103021740-59711933581376.testnet",
  dstackSocketPath: process.env.DSTACK_SOCKET_PATH || "/var/run/tappd.sock",
  isEnclave: process.env.IS_ENCLAVE === "true" || process.env.NODE_ENV === "production",
  rateLimitPerMinute: Math.max(1, parseInt(process.env.RATE_LIMIT_REQUESTS_PER_MINUTE || "60", 10)),
  transientRateLimitRetries: Math.max(0, parseInt(process.env.TRANSIENT_RATE_LIMIT_RETRIES || "2", 10)),
  transientRateLimitBackoffMs: Math.max(25, parseInt(process.env.TRANSIENT_RATE_LIMIT_BACKOFF_MS || "250", 10)),
  // Generations may legitimately take longer than a minute.  A timeout only
  // stops waiting for the upstream response; it must never turn a reservation
  // into a completed charge.
  upstreamFetchTimeoutMs: Math.max(1_000, parseInt(process.env.UPSTREAM_FETCH_TIMEOUT_MS || "300000", 10)),
  websocketAuthTimeoutMs: Math.max(1_000, parseInt(process.env.WEBSOCKET_AUTH_TIMEOUT_MS || "10000", 10)),
  checkpointIntervalMs: Math.max(10_000, parseInt(process.env.CHECKPOINT_INTERVAL_MS || "300000", 10)),
  billingQueueTimeoutMs: Math.max(1_000, parseInt(process.env.BILLING_QUEUE_TIMEOUT_MS || "65000", 10)),
  billingQueueMaxWaiters: Math.max(1, parseInt(process.env.BILLING_QUEUE_MAX_WAITERS || "32", 10)),
  // NEAR public RPCs can briefly throttle bursts of adjacent 25% stages. Keep
  // the settlement queue intact and back off for long enough to recover
  // automatically instead of abandoning later stages after a few seconds.
  relayerMaxAttempts: Math.max(1, parseInt(process.env.RELAYER_MAX_ATTEMPTS || "8", 10)),
  relayerRetryBaseMs: Math.max(25, parseInt(process.env.RELAYER_RETRY_BASE_MS || "1000", 10)),
  meteringStateDir: process.env.METERING_STATE_DIR || (process.env.NODE_ENV === "test" ? `/tmp/conpi-metering-${process.pid}` : "/var/lib/conpi"),
  solanaRpcUrl: process.env.SOLANA_RPC || "https://api.devnet.solana.com",
  solanaUsdcMint: process.env.SOLANA_USDC_MINT || "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU",
  solanaMpcVault: process.env.SOLANA_MPC_VAULT || "CtHaZkSC8e58VGtUmggu8WiH6fJ7RvUgiZNJtXu6SGp6",
  solanaMpcPath: process.env.SOLANA_MPC_PATH || "conpi-solana-maker-v1",
  solanaMpcDomainId: Math.max(1, parseInt(process.env.MPC_EDDSA_DOMAIN_ID || "1", 10)),
  // Real measured MRTD from Phala Intel TDX CVM
  mrtd: process.env.TEE_MRTD || "7fe60787222bd394cb516abca2435f22f035ab2cc9c0a4b4b3b148e46297f3d931a237b72f359052c6e657d8c1409173",
};
