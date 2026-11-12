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
}

runNearRelayerTests().catch((error) => {
  console.error("Test failed:", error);
  process.exit(1);
});
