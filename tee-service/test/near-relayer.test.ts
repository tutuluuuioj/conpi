import { NearRelayer } from "../src/chain/relayer.js";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

async function runNearRelayerTests() {
  console.log("=== RUNNING NEAR RELAYER SERIALIZATION TESTS ===");

  const relayer = new NearRelayer();
  let capturedMethod = "";
  let capturedArgs: Record<string, any> | null = null;
  (relayer as any).submitFunctionCall = async (method: string, args: Record<string, any>) => {
    capturedMethod = method;
    capturedArgs = args;
    return { transactionHash: "test", status: {} };
  };

  const expiresAtNs = "1794487270900000000";
  await relayer.submitAcceptDealSolana({
    dealId: 55,
    expectedHashHex: "41".repeat(32),
    sellerAddress: "bbd65d65de6e15e11d9f887423339a4acc257184d59e6cbc5d4afe1e556e0273",
    publicKey: new Uint8Array(32).fill(1),
    nonce: 1,
    expiresAtNs,
    signature: new Uint8Array(64).fill(2),
  });

  assert(capturedMethod === "accept_deal_solana", "Wrong contract method");
  assert(capturedArgs !== null, "Contract arguments were not captured");
  const args = capturedArgs as Record<string, any>;
  assert(typeof args.expires_at === "number", "expires_at must be a JSON number for Rust u64");
  assert(Number.isInteger(args.expires_at), "expires_at must serialize as an integer");
  assert(!JSON.stringify(args).includes(`\"expires_at\":\"`), "expires_at must not be quoted in JSON");

  console.log("[PASS] Solana acceptance expiry serializes as the contract's u64");

  const termsHash = Buffer.alloc(32, 0x41);
  const solanaTxHash = Buffer.alloc(32, 0x55);
  capturedMethod = "";
  capturedArgs = null;
  await relayer.submitRecordSolanaCollateral(
    55,
    "4cASSracKaykpEM1DjSyDba2MnhsQXFCs1ebRH47xveKVjnsAk8moJ53SVs71U7zgG4KfMdUeWJGYJLWXQpdmhcx",
    {
      domain: "conpi:v1",
      contractId: "dev-20261103062448-30583839049419.testnet",
      chainId: "testnet",
      dealId: 55,
      termsHash,
      nonce: 1n,
      issuedAtNs: 1_794_531_571_000_000_000n,
      meteredValueYocto: 0n,
      foreignTxSighash: solanaTxHash,
    },
    "22".repeat(64),
  );

  assert(capturedMethod === "record_solana_collateral", "Wrong collateral contract method");
  assert(capturedArgs !== null, "Collateral contract arguments were not captured");
  const collateralArgs = capturedArgs as Record<string, any>;
  assert(collateralArgs.payload.terms_hash.length === 32, "terms_hash must contain 32 bytes");
  assert(collateralArgs.payload.foreign_tx_sighash.length === 32, "foreign_tx_sighash must contain 32 bytes");
  assert(
    collateralArgs.payload.foreign_tx_sighash.every((value: number) => value === 0x55),
    "The Solana transaction hash bytes must be preserved",
  );

  console.log("[PASS] Solana collateral Buffer hashes serialize as contract byte arrays");

  capturedMethod = "";
  capturedArgs = null;
  await relayer.submitClearExpiredSolanaPayout(57);
  assert(capturedMethod === "clear_expired_solana_payout", "Wrong stale payout cleanup method");
  assert((capturedArgs as Record<string, any>).deal_id === 57, "Stale payout cleanup deal id mismatch");
  console.log("[PASS] Expired Solana payout cleanup is relayed with the locked deal id");

  const originalFetch = globalThis.fetch;
  try {
    (relayer as any).rpcUrls = ["https://rate-limited.invalid", "https://healthy.invalid"];
    const expected = { id: 61, status: "Active" };
    globalThis.fetch = (async (input: string | URL | Request) => {
      const url = String(input);
      if (url.includes("rate-limited")) {
        return new Response(JSON.stringify({
          jsonrpc: "2.0",
          id: "test",
          error: { code: -429, message: "Rate limits exceeded" },
        }), { status: 200, headers: { "Content-Type": "application/json" } });
      }
      return new Response(JSON.stringify({
        jsonrpc: "2.0",
        id: "test",
        result: { result: Array.from(Buffer.from(JSON.stringify(expected), "utf8")) },
      }), { status: 200, headers: { "Content-Type": "application/json" } });
    }) as typeof fetch;

    const view = await relayer.callView("get_deal", { deal_id: 61 });
    assert(view.id === 61 && view.status === "Active", "View calls must fail over after an RPC 429");
    console.log("[PASS] RPC 429 automatically fails over to the next NEAR provider");
  } finally {
    globalThis.fetch = originalFetch;
  }
}

runNearRelayerTests().catch((error) => {
  console.error("Test failed:", error);
  process.exit(1);
});
