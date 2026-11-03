import { enclaveKeys } from "../src/crypto/keys.js";
import { computeTermsHash, buildTermsMessage } from "../src/crypto/terms.js";
import { serializeSignedPayload, PayloadKind } from "../src/crypto/borsh.js";
import { encryptToEnclave, decryptFromClient } from "../src/crypto/encryption.js";
import { negotiationService } from "../src/negotiation/matcher.js";
import { keyVault } from "../src/vault/preflight.js";
import { calculateCost, meterEngine } from "../src/proxy/meter.js";

async function runTests() {
  console.log("=== RUNNING CONPI TEE SERVICE UNIT TESTS ===");

  // 1. Keys Test
  console.log("\n[Test 1] Testing Enclave Key Generation & Signing...");
  const pubKeyNear = enclaveKeys.getSignerPublicKeyNear();
  console.log("  Signer Public Key (NEAR):", pubKeyNear);
  if (!pubKeyNear.startsWith("ed25519:")) {
    throw new Error("Invalid NEAR public key format");
  }

  const testMsg = Buffer.from("conpi-enclave-test-message");
  const signature = enclaveKeys.sign(testMsg);
  const valid = enclaveKeys.verify(testMsg, signature);
  console.log("  Signature verification:", valid);
  if (!valid) throw new Error("Ed25519 signature verification failed");
  console.log("PASS: Enclave keys generated and signatures verified.");

  // 2. Encryption Test
  console.log("\n[Test 2] Testing Client-to-Enclave X25519 Encryption...");
  const secretApiKey = "sk-proj-super-secret-key-123456789";
  const encrypted = encryptToEnclave(secretApiKey, enclaveKeys.getEncryptionPublicKeyHex());
  console.log("  Ciphertext (hex):", encrypted.ciphertextHex.slice(0, 32) + "...");

  const decrypted = decryptFromClient(encrypted);
  console.log("  Decrypted successfully:", decrypted === secretApiKey);
  if (decrypted !== secretApiKey) throw new Error("Decryption mismatch");
  console.log("PASS: X25519 ECDH authenticated encryption verified.");

  // 3. Terms Hash & Borsh Test
  console.log("\n[Test 3] Testing Canonical Terms Hash & Borsh Payload Serialization...");
  const termsHash = computeTermsHash({
    dealId: 1n,
    buyer: "buyer.testnet",
    seller: "seller.testnet",
    token: null,
    priceYocto: 3_000_000_000_000_000_000_000_000n, // 3 NEAR
    creditAmountYocto: 5_000_000_000_000_000_000_000_000n, // 5 NEAR
    buyerCollateralYocto: 1_000_000_000_000_000_000_000_000n,
    sellerCollateralYocto: 1_000_000_000_000_000_000_000_000n,
    teePubKeyBytes: enclaveKeys.getSignerPublicKeyBytes(),
    depositDurationNs: 86400_000_000_000n,
    keyDurationNs: 86400_000_000_000n,
    teeLivenessTimeoutNs: 3600_000_000_000n,
    slashBpsProviderBan: 5000,
    slashBpsRevoke: 8000,
    slashBpsBuyerBreach: 5000,
  });
  console.log("  Computed termsHash (hex):", Buffer.from(termsHash).toString("hex"));

  const borshBytes = serializeSignedPayload({
    domain: "conpi:v1",
    contractId: "conpi.testnet",
    chainId: "testnet",
    dealId: 1n,
    termsHash,
    kind: PayloadKind.Activate,
    stage: 0,
    meteredValueYocto: 0n,
    reason: null,
    nonce: 1n,
    issuedAtNs: 1730000000_000_000_000n,
  });
  console.log("  Borsh payload bytes length:", borshBytes.length);
  const payloadSig = enclaveKeys.sign(borshBytes);
  if (!enclaveKeys.verify(borshBytes, payloadSig)) {
    throw new Error("Payload signature failed");
  }
  console.log("PASS: Terms hash and Borsh SignedPayload verified.");

  // 4. Negotiation Matcher Test
  console.log("\n[Test 4] Testing Negotiation Ticket & Terms Matcher...");
  const ticketId = "ticket-test-01";
  negotiationService.getOrCreateTicket(ticketId, 1, "buyer.near", "seller.near");

  const termA = {
    provider: "OpenAI" as const,
    models: ["gpt-4o"],
    creditAmountUsd: 80,
    priceUsd: 60,
    buyerCollateralPct: 10,
    sellerCollateralPct: 20,
    token: null,
    depositDurationSec: 86400,
    keyDurationSec: 86400,
    teeLivenessTimeoutSec: 3600,
    slashBpsProviderBan: 5000,
    slashBpsRevoke: 8000,
    slashBpsBuyerBreach: 5000,
    deadline: "2026-12-01",
  };

  // Buyer submits terms with price = 60
  negotiationService.submitTerms(ticketId, "buyer", termA);

  // Seller submits terms with differing price = 65
  const ticketMismatch = negotiationService.submitTerms(ticketId, "seller", { ...termA, priceUsd: 65 });
  console.log("  Diff fields detected:", ticketMismatch.diffFields);
  if (!ticketMismatch.diffFields?.includes("price") || ticketMismatch.matched) {
    throw new Error("Mismatch detection failed");
  }

  // Seller aligns terms
  const ticketMatched = negotiationService.submitTerms(ticketId, "seller", termA);
  console.log("  Matched status:", ticketMatched.matched);
  console.log("  Matched termsHash:", ticketMatched.termsHashHex);
  console.log("  Matched signature:", ticketMatched.signatureHex?.slice(0, 32) + "...");
  if (!ticketMatched.matched || !ticketMatched.termsHashHex || !ticketMatched.signatureHex) {
    throw new Error("Terms matching failed");
  }
  console.log("PASS: Negotiation terms matching and diffing verified.");

  // 5. Key Injection & Pre-flight Test
  console.log("\n[Test 5] Testing Key Injection & Pre-flight Validation...");
  const keyResult = await keyVault.validateAndInjectKey(
    1,
    "OpenAI",
    "gpt-4o",
    ["gpt-4o", "gpt-4o-mini"],
    80,
    60,
    ticketMatched.termsHashHex,
    undefined,
    "mock_sk_live_valid_prepaid_credit"
  );
  console.log("  Preflight result ok:", keyResult.ok);
  console.log("  Proxy key generated:", keyResult.proxyKey);
  console.log("  Activate signature:", keyResult.activateSignatureHex?.slice(0, 32) + "...");
  if (!keyResult.ok || !keyResult.proxyKey) {
    throw new Error("Key injection failed");
  }
  console.log("PASS: In-enclave key vault & preflight validation verified.");

  // 6. Token Metering & Milestone Stage Releases
  console.log("\n[Test 6] Testing Token Metering & 25/50/75/100% Stage Releases...");
  const cost1 = calculateCost("gpt-4o", 1000, 500); // 1000 in ($0.0025) + 500 out ($0.005) = $0.0075
  console.log("  Calculated cost for 1k in / 500 out:", cost1.costUsd);
  if (Math.abs(cost1.costUsd - 0.0075) > 0.0001) throw new Error("Cost calculation mismatch");

  const entry = keyVault.getByDealId(1)!;
  entry.usedUsd = 20; // 25% of $80
  const stage25 = meterEngine.checkAndEmitStage(entry, ticketMatched.termsHashHex);
  console.log("  Stage 25% emitted:", stage25?.payload.stage === 25);
  if (stage25?.payload.stage !== 25) throw new Error("Stage 25 not emitted");

  entry.usedUsd = 40; // 50% of $80
  const stage50 = meterEngine.checkAndEmitStage(entry, ticketMatched.termsHashHex);
  console.log("  Stage 50% emitted:", stage50?.payload.stage === 50);
  if (stage50?.payload.stage !== 50) throw new Error("Stage 50 not emitted");

  console.log("PASS: Precision token meter & milestone stages verified.");

  // 7. Mock Key Rejection Outside Test Mode
  console.log("\n[Test 7] Testing Mock Key Rejection Outside Test Mode...");
  const oldEnv = process.env.NODE_ENV;
  try {
    process.env.NODE_ENV = "production";
    const prodKeyResult = await keyVault.validateAndInjectKey(
      2,
      "OpenAI",
      "gpt-4o",
      ["gpt-4o"],
      100,
      80,
      "00".repeat(32),
      undefined,
      "mock_sk_forbidden_prod"
    );
    console.log("  Mock key in production ok:", prodKeyResult.ok);
    console.log("  Error message:", prodKeyResult.error);
    if (prodKeyResult.ok || !prodKeyResult.error?.includes("rejected outside test mode")) {
      throw new Error("Expected mock key to be rejected in production!");
    }
    console.log("PASS: Mock keys properly rejected outside test mode.");
  } finally {
    process.env.NODE_ENV = oldEnv;
  }

  console.log("\n=======================================================");
  console.log("  ALL CONPI TEE SERVICE UNIT TESTS PASSED (7/7)!       ");
  console.log("=======================================================");
}

runTests().catch((err) => {
  console.error("Test failed:", err);
  process.exit(1);
});
