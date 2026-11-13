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
}

runNearRelayerTests().catch((error) => {
  console.error("Test failed:", error);
  process.exit(1);
});
