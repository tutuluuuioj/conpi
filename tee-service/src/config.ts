import dotenv from "dotenv";
dotenv.config();

export const CONFIG = {
  port: parseInt(process.env.PORT || "3000", 10),
  host: process.env.HOST || "0.0.0.0",
  networkId: process.env.NEAR_NETWORK || "testnet",
  nodeUrl: process.env.NEAR_NODE_URL || "https://rpc.testnet.near.org",
  contractId: process.env.CONTRACT_ID || "dev-20261103062448-30583839049419.testnet",
  daoId: process.env.DAO_ID || "dev-20261103021740-59711933581376.testnet",
  dstackSocketPath: process.env.DSTACK_SOCKET_PATH || "/var/run/tappd.sock",
  isEnclave: process.env.IS_ENCLAVE === "true" || process.env.NODE_ENV === "production",
  rateLimitPerMinute: Math.max(1, parseInt(process.env.RATE_LIMIT_REQUESTS_PER_MINUTE || "60", 10)),
  transientRateLimitRetries: Math.max(0, parseInt(process.env.TRANSIENT_RATE_LIMIT_RETRIES || "2", 10)),
  transientRateLimitBackoffMs: Math.max(25, parseInt(process.env.TRANSIENT_RATE_LIMIT_BACKOFF_MS || "250", 10)),
  upstreamFetchTimeoutMs: Math.max(1_000, parseInt(process.env.UPSTREAM_FETCH_TIMEOUT_MS || "60000", 10)),
  websocketAuthTimeoutMs: Math.max(1_000, parseInt(process.env.WEBSOCKET_AUTH_TIMEOUT_MS || "10000", 10)),
  checkpointIntervalMs: Math.max(10_000, parseInt(process.env.CHECKPOINT_INTERVAL_MS || "300000", 10)),
  billingQueueTimeoutMs: Math.max(1_000, parseInt(process.env.BILLING_QUEUE_TIMEOUT_MS || "65000", 10)),
  billingQueueMaxWaiters: Math.max(1, parseInt(process.env.BILLING_QUEUE_MAX_WAITERS || "32", 10)),
  relayerMaxAttempts: Math.max(1, parseInt(process.env.RELAYER_MAX_ATTEMPTS || "5", 10)),
  relayerRetryBaseMs: Math.max(25, parseInt(process.env.RELAYER_RETRY_BASE_MS || "500", 10)),
  meteringStateDir: process.env.METERING_STATE_DIR || (process.env.NODE_ENV === "test" ? `/tmp/conpi-metering-${process.pid}` : "/var/lib/conpi"),
  // Real measured MRTD from Phala Intel TDX CVM
  mrtd: process.env.TEE_MRTD || "7fe60787222bd394cb516abca2435f22f035ab2cc9c0a4b4b3b148e46297f3d931a237b72f359052c6e657d8c1409173",
};
