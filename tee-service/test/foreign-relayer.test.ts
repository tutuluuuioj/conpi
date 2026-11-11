import { foreignVaultManager } from "../src/chain/foreign-vault.js";
import { foreignRelayer } from "../src/chain/foreign-relayer.js";
import { baseClient, BASE_SEPOLIA_USDC } from "../src/chain/base-client.js";
import { secp256k1 } from "@noble/curves/secp256k1";
import { keccak_256 } from "@noble/hashes/sha3";
import { getAddress, parseTransaction, type Address } from "viem";

function assert(condition: unknown, msg: string): asserts condition {
  if (!condition) throw new Error(msg);
}

async function runForeignRelayerTests() {
  console.log("=== RUNNING FOREIGN RELAYER ACCEPTANCE TESTS ===");

  // 1. Vault Derivation Test (Phase 1 match)
  console.log("[Test 1] Testing MPC EVM Vault Derivation on Base Sepolia...");
  const derived = foreignVaultManager.deriveVaultAddress("gnear-89a6413e.testnet", 49);
  console.log("  Derived Vault:", derived.address);
  assert(
    derived.address === "0x0aA750e83Dae45e4bA17EbAd07A2Fb800988155f",
    "Derived address does not match known Phase 1 testnet address"
  );
  console.log("  [PASS] Deterministic EVM Vault address matches Phase 1 derivation 100%");

  // 2. Build EIP-1559 transfer tx
  console.log("[Test 2] Building EIP-1559 USDC Transfer Transaction...");
  const recipient = "0x2222222222222222222222222222222222222222" as Address;
  const amount = 1_250_000n; // 1.25 USDC
  const prepared = foreignVaultManager.buildErc20TransferTx({
    recipient,
    amountAtomic: amount,
    nonce: 0,
  });
  assert(prepared.sighash.startsWith("0x") && prepared.sighash.length === 66, "Invalid sighash generated");
  assert(prepared.tx.chainId === 84532, "Chain ID is not Base Sepolia (84532)");
  assert(prepared.tx.to === BASE_SEPOLIA_USDC, "Target contract is not Base Sepolia USDC");
  console.log("  [PASS] EIP-1559 tx sighash generated:", prepared.sighash);

  // 3. Assemble and verify signed transaction
  console.log("[Test 3] Testing Signature Assembly & Mathematical Verification...");
  const ephemeralPrivKey = secp256k1.utils.randomPrivateKey();
  const ephemeralPubKey = secp256k1.getPublicKey(ephemeralPrivKey, false);
  const expectedSigner = getAddress(
    "0x" + Buffer.from(keccak_256(ephemeralPubKey.subarray(1)).subarray(12)).toString("hex")
  );

  const hashBytes = Buffer.from(prepared.sighash.slice(2), "hex");
  const rawSig = secp256k1.sign(hashBytes, ephemeralPrivKey);

  const rHex = rawSig.r.toString(16).padStart(64, "0");
  const sHex = rawSig.s.toString(16).padStart(64, "0");
  const recoveryId = rawSig.recovery;

  const signedRawTx = foreignVaultManager.assembleSignedTransaction(prepared.tx, {
    rHex,
    sHex,
    recoveryId,
  });

  const parsed = parseTransaction(signedRawTx);
  assert(parsed.chainId === 84532, "Parsed chain ID mismatch");
  assert(parsed.type === "eip1559", "Parsed tx type is not eip1559");

  const verified = await foreignVaultManager.verifySignatureMatchesVault(
    prepared.sighash,
    { rHex, sHex, recoveryId },
    expectedSigner
  );
  assert(verified, "Cryptographic verification of signature failed");
  console.log("  [PASS] Signed raw EVM transaction bytes validated & verified 100%");

  // 3b. Test 33-byte 02-prefixed affine point normalization
  console.log("[Test 3b] Testing Compressed Affine Point (33-byte 02/03 prefix) Normalization...");
  const prefixedRHex = "02" + rHex;
  const normalized = foreignVaultManager.normalizeRS({ rHex: prefixedRHex, sHex });
  assert(normalized.r.length === 66 && normalized.r.startsWith("0x"), "Normalized r must be 32-byte 0x-prefixed hex");
  assert(normalized.r.slice(2) === rHex, "Normalized r scalar must match original 32-byte r");
  const verifiedPrefixed = await foreignVaultManager.verifySignatureMatchesVault(
    prepared.sighash,
    { rHex: prefixedRHex, sHex, recoveryId },
    expectedSigner
  );
  assert(verifiedPrefixed, "Recovery must succeed with 33-byte affine point input");
  console.log("  [PASS] Affine point 33-byte prefix correctly stripped and signature verified 100%");

  // 4. Test live Base Sepolia RPC gas check
  console.log("[Test 4] Querying Base Sepolia RPC for Vault Gas Balance...");
  const gasCheck = await foreignRelayer.checkVaultGas(derived.address);
  console.log("  Vault Gas Balance:", gasCheck.balanceEth.toString(), "wei");
  assert(typeof gasCheck.hasGas === "boolean", "Gas check returned invalid boolean");
  console.log("  [PASS] Live Base Sepolia RPC communication confirmed 100%");

  // 5. Test Relayer Broadcast Rejection on Invalid Signature
  console.log("[Test 5] Ensuring Relayer Rejects Invalid / Mismatched Signatures...");
  const result = await foreignRelayer.broadcastSignedPayout({
    dealId: 49,
    stage: 25,
    chainId: 84532,
    recipient,
    amountAtomic: amount,
    sighashHex: prepared.sighash,
    rHex,
    sHex,
    recoveryId,
    nonce: 0,
  });
  // Since ephemeral key doesn't match derived vault, it MUST be safely rejected
  assert(!result.success, "Broadcast should have failed due to signer mismatch");
  assert(result.error?.includes("MPC signature does not recover to expected Base Sepolia vault"), "Error message mismatch");
  console.log("  [PASS] Invalid signatures safely caught before on-chain submission:", result.error);

  // 6. Test MeterEngine Stage Emission with Foreign Deal Sighash Binding
  console.log("[Test 6] Testing MeterEngine Foreign Stage Release Sighash Binding...");
  const { enclaveKeys } = await import("../src/crypto/keys.js");
  await enclaveKeys.init();
  const { meterEngine } = await import("../src/proxy/meter.js");
  const { DefaultReason } = await import("../src/crypto/borsh.js");
  const { settlementEngine } = await import("../src/settlement/engine.js");
  const { nearRelayer } = await import("../src/chain/relayer.js");

  meterEngine.reset(49);
  meterEngine.seedEvmNonce(49, 0);

  const fakeEntry: any = {
    dealId: 49,
    creditUsd: 5.0,
    priceUsd: 5.0,
    usedUsd: 1.25, // 25%
    termsHashHex: "00".repeat(32),
    relayReceipts: [],
    signedPayloads: [],
    foreignDeal: {
      chainId: 84532,
      vaultAddress: "0x0aA750e83Dae45e4bA17EbAd07A2Fb800988155f",
      tokenAddress: BASE_SEPOLIA_USDC,
      buyerAddress: "0x1111111111111111111111111111111111111111",
      sellerAddress: "0x2222222222222222222222222222222222222222",
      foreignAmount: 5_000_000n, // 5 USDC
      evmNonce: 0,
    },
  };

  const stages = meterEngine.checkAndEmitStages(fakeEntry, "00".repeat(32));
  assert(stages.length === 1, "Should emit stage 25");
  assert(stages[0].payload.stage === 25, "Stage should be 25");
  assert(stages[0].payload.foreignTxSighash !== null && stages[0].payload.foreignTxSighash !== undefined, "Foreign sighash must be present in payload");
  const foreignTx = (stages[0].payload as any).foreignTx;
  assert(foreignTx, "foreignTx helper object must be attached to payload");
  assert(foreignTx.nonce === 0, "First stage EVM nonce should be 0");
  assert(foreignTx.amount === 1_250_000n, "25% of 5 USDC is 1.25 USDC");
  assert(foreignTx.recipient === fakeEntry.foreignDeal.sellerAddress, "Stage payout recipient must be seller");
  assert(
    Buffer.from(stages[0].payload.foreignTxSighash!).toString("hex") === foreignTx.sighashHex.replace(/^0x/, ""),
    "Payload foreign sighash must match EIP-1559 transaction sighash"
  );
  console.log("  [PASS] MeterEngine emits cryptographically bound EIP-1559 sighash for stage release 100%");

  // 7. Test MeterEngine Default Emission with Foreign Refund Sighash Binding
  console.log("[Test 7] Testing MeterEngine Foreign Default Refund Sighash Binding...");
  fakeEntry.usedUsd = 2.0; // 40% delivery, 60% refund
  const defaultSigned = meterEngine.emitDefault(fakeEntry, "00".repeat(32), DefaultReason.InvalidKey);
  assert(defaultSigned.payload.foreignTxSighash !== null && defaultSigned.payload.foreignTxSighash !== undefined, "Default foreign sighash must be present");
  const defTx = (defaultSigned.payload as any).foreignTx;
  assert(defTx, "foreignTx helper object must be attached to default payload");
  assert(defTx.recipient === fakeEntry.foreignDeal.buyerAddress, "Refund recipient must be buyer");
  assert(defTx.nonce === 1, "Default EVM nonce should be incremented to 1");
  console.log("  [PASS] MeterEngine emits cryptographically bound EIP-1559 sighash for default buyer refund 100%");

  // 8. Test SettlementEngine Foreign Method Routing
  console.log("[Test 8] Testing SettlementEngine Foreign Relaying Method Routing...");
  let stageForeignCalled = false;
  let defaultForeignCalled = false;
  const originalIsConfigured = nearRelayer.isConfigured.bind(nearRelayer);
  const originalGetDeal = nearRelayer.getDeal.bind(nearRelayer);
  (nearRelayer as any).isConfigured = () => true;
  (nearRelayer as any).getDeal = async () => null;
  (nearRelayer as any).submitReleaseStageForeign = async (
    dealId: number,
    stage: number,
    payloadDto: any,
    sigHex: string,
    fTx: any
  ) => {
    stageForeignCalled = true;
    assert(dealId === 49, "Deal ID mismatch in foreign stage release");
    assert(fTx.recipient === fakeEntry.foreignDeal.sellerAddress, "Seller address mismatch");
    return { transactionHash: "0x_fake_stage_foreign_hash", status: {} };
  };
  (nearRelayer as any).submitSettleDefaultForeign = async (
    dealId: number,
    payloadDto: any,
    sigHex: string,
    fTx: any
  ) => {
    defaultForeignCalled = true;
    assert(dealId === 49, "Deal ID mismatch in foreign default settle");
    assert(fTx.recipient === fakeEntry.foreignDeal.buyerAddress, "Buyer address mismatch");
    return { transactionHash: "0x_fake_default_foreign_hash", status: {} };
  };

  await settlementEngine.relayStage(fakeEntry, stages[0]);
  assert(stageForeignCalled, "SettlementEngine.relayStage must route to submitReleaseStageForeign");

  await settlementEngine.relayDefault(fakeEntry, defaultSigned);
  assert(defaultForeignCalled, "SettlementEngine.relayDefault must route to submitSettleDefaultForeign");

  (nearRelayer as any).isConfigured = originalIsConfigured;
  (nearRelayer as any).getDeal = originalGetDeal;
  console.log("  [PASS] SettlementEngine properly routes foreign deals to submitReleaseStageForeign and submitSettleDefaultForeign 100%");

  console.log("=== ALL FOREIGN RELAYER ACCEPTANCE TESTS PASSED (100%) ===");
}

runForeignRelayerTests().catch((err) => {
  console.error("Test failed:", err);
  process.exit(1);
});
