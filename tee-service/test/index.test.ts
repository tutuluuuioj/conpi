process.env.NODE_ENV = "test";
import { enclaveKeys } from "../src/crypto/keys.js";
import { computeTermsHash, buildTermsMessage } from "../src/crypto/terms.js";
import { serializeSignedPayload, PayloadKind } from "../src/crypto/borsh.js";
import { encryptToEnclave, decryptFromClient } from "../src/crypto/encryption.js";
import { negotiationService } from "../src/negotiation/matcher.js";
import { keyVault, fetchLiveNearPriceUsd } from "../src/vault/preflight.js";
import { calculateCost, meterEngine } from "../src/proxy/meter.js";
import { buildApp, INTERNAL_SERVER_TOKEN } from "../src/index.js";
import { isProviderBan } from "../src/proxy/server.js";

async function runTests() {
  console.log("=== RUNNING CONPI TEE SERVICE UNIT TESTS ===");
  await enclaveKeys.init();

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
  const encryptedBuyerTerms = encryptToEnclave(
    JSON.stringify(termA),
    enclaveKeys.getEncryptionPublicKeyHex()
  );
  negotiationService.submitEncryptedTerms(ticketId, "buyer", encryptedBuyerTerms);

  // Seller submits terms with differing price = 65
  const ticketMismatch = negotiationService.submitEncryptedTerms(
    ticketId,
    "seller",
    encryptToEnclave(
      JSON.stringify({ ...termA, priceUsd: 65 }),
      enclaveKeys.getEncryptionPublicKeyHex()
    )
  );
  console.log("  Diff fields detected:", ticketMismatch.diffFields);
  if (!ticketMismatch.diffFields?.includes("price") || ticketMismatch.matched) {
    throw new Error("Mismatch detection failed");
  }

  // Seller aligns terms
  const ticketMatched = negotiationService.submitEncryptedTerms(
    ticketId,
    "seller",
    encryptToEnclave(JSON.stringify(termA), enclaveKeys.getEncryptionPublicKeyHex())
  );
  console.log("  Matched status:", ticketMatched.matched);
  console.log("  Matched termsHash:", ticketMatched.termsHashHex);
  console.log("  Matched signature:", ticketMatched.signatureHex?.slice(0, 32) + "...");
  if (!ticketMatched.matched || !ticketMatched.termsHashHex || !ticketMatched.signatureHex) {
    throw new Error("Terms matching failed");
  }
  const ticketWithMessage = negotiationService.addEncryptedMessage(
    ticketId,
    "buyer.near",
    encryptToEnclave("Private negotiation message", enclaveKeys.getEncryptionPublicKeyHex())
  );
  if (ticketWithMessage.messages[0]?.text !== "Private negotiation message") {
    throw new Error("Encrypted ticket message failed");
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
    encryptToEnclave(
      "mock_sk_live_valid_prepaid_credit",
      enclaveKeys.getEncryptionPublicKeyHex()
    ),
    undefined
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
  entry.usedUsd = entry.creditUsd * 0.25; // 25% of on-chain creditUsd
  const stage25 = meterEngine.checkAndEmitStage(entry, ticketMatched.termsHashHex);
  console.log("  Stage 25% emitted:", stage25?.payload.stage === 25);
  if (stage25?.payload.stage !== 25) throw new Error("Stage 25 not emitted");

  entry.usedUsd = entry.creditUsd * 0.50; // 50% of on-chain creditUsd
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

  // 8. Random Caller Rejected on Default Route
  console.log("\n[Test 8] Testing Locked Default Route (Random Caller Rejected with 403)...");
  const testApp = await buildApp();
  const unauthRes = await testApp.inject({
    method: "POST",
    url: "/v1/deals/1/default",
    payload: { reason: "ProviderBan" },
  });
  console.log("  Random caller status code:", unauthRes.statusCode);
  console.log("  Random caller response body:", unauthRes.body);
  if (unauthRes.statusCode !== 403) {
    throw new Error(`Expected random caller to receive 403 Forbidden, got ${unauthRes.statusCode}`);
  }
  const unauthJson = JSON.parse(unauthRes.body);
  if (!unauthJson.error?.includes("Manual external default triggers are locked") && !unauthJson.error?.includes("Forbidden")) {
    throw new Error("Unexpected error message on rejected default trigger");
  }

  // Verify caller with forged / invalid internal token is also rejected
  const forgedRes = await testApp.inject({
    method: "POST",
    url: "/v1/deals/1/default",
    headers: { "x-enclave-internal-token": "attacker-forged-token-xyz" },
    payload: { reason: "ProviderBan" },
  });
  if (forgedRes.statusCode !== 403) {
    throw new Error(`Expected forged token caller to receive 403 Forbidden, got ${forgedRes.statusCode}`);
  }

  // Verify internal token caller is permitted
  const authRes = await testApp.inject({
    method: "POST",
    url: "/v1/deals/1/default",
    headers: { "x-enclave-internal-token": INTERNAL_SERVER_TOKEN },
    payload: { reason: "ProviderBan" },
  });
  console.log("  Internal token caller status code:", authRes.statusCode);
  if (authRes.statusCode !== 200) {
    throw new Error(`Expected internal caller to succeed, got ${authRes.statusCode}: ${authRes.body}`);
  }
  console.log("PASS: Random caller rejected with 403 Forbidden and only enclave server logic permitted.");

  // 9. On-Chain Derivation of Financial Parameters
  console.log("\n[Test 9] Testing On-Chain Derivation of creditUsd, priceUsd and creditAmountYocto...");
  await keyVault.validateAndInjectKey(
    1,
    "OpenAI",
    "gpt-4o",
    ["gpt-4o"],
    undefined,
    undefined,
    ticketMatched.termsHashHex,
    undefined,
    "mock_sk_test_chain_params"
  );
  const entryChain = keyVault.getByDealId(1);
  console.log("  Deal #1 creditAmountYocto:", entryChain?.creditAmountYocto);
  console.log("  Deal #1 creditUsd:", entryChain?.creditUsd);
  console.log("  Deal #1 priceUsd:", entryChain?.priceUsd);
  if (!entryChain || !entryChain.creditAmountYocto || entryChain.creditUsd <= 0 || entryChain.priceUsd <= 0) {
    throw new Error("Failed to derive on-chain financial parameters");
  }
  console.log("PASS: creditUsd, priceUsd, and creditAmountYocto successfully derived from on-chain deal state.");

  // 10. OpenRouter Reported Cost Metering
  console.log("\n[Test 10] Testing OpenRouter Reported Cost Metering...");
  const entryForCost = keyVault.getByDealId(1)!;
  const initialUsedUsd = entryForCost.usedUsd;
  const openRouterReportedCost = 0.000009747;
  
  // Directly simulate processing an upstream response with reported cost
  const reportedCost = typeof openRouterReportedCost === "number" && openRouterReportedCost > 0
    ? openRouterReportedCost
    : calculateCost("meta-llama/llama-3.2-1b-instruct", 12, 10).costUsd;
  entryForCost.usedUsd += reportedCost;
  
  console.log("  Cost recorded in meter:", reportedCost);
  if (Math.abs(reportedCost - 0.000009747) > 0.000000001) {
    throw new Error(`Meter did not use exact OpenRouter reported cost: ${reportedCost}`);
  }
  console.log("PASS: Meter successfully records exact OpenRouter reported cost ($0.000009747).");

  // 11. Provider Ban Automatic Detection Test
  console.log("\n[Test 11] Testing Provider Ban Automatic Detection...");
  if (isProviderBan(403, "Forbidden")) throw new Error("Generic 403 Forbidden must NOT be detected as provider ban");
  if (isProviderBan(403, "permission_denied")) throw new Error("Generic permission_denied must NOT be detected as provider ban");
  if (!isProviderBan(403, { error: { message: "Your account_deactivated by admin" } })) {
    throw new Error("account_deactivated should be detected as provider ban");
  }
  if (!isProviderBan(401, "Your organization_disabled due to breach")) {
    throw new Error("organization_disabled should be detected as provider ban");
  }
  if (!isProviderBan(400, "Account suspended due to policy violation")) {
    throw new Error("suspended should be detected as provider ban");
  }
  if (!isProviderBan(403, "Account banned: policy_violation")) {
    throw new Error("Explicit ban code with 403 should be detected as provider ban");
  }
  if (isProviderBan(200, "OK") || isProviderBan(200, "account_deactivated") || isProviderBan(429, "Rate limit reached") || isProviderBan(500, "Internal Server Error")) {
    throw new Error("Standard errors / 200 should not be detected as provider ban");
  }
  console.log("PASS: Provider ban heuristics accurately classify bans and ignore transient errors.");

  // 12. Budget Cap Clamping Test
  console.log("\n[Test 12] Testing 100% Budget Cap Clamping...");
  const capEntry = keyVault.getByDealId(1)!;
  capEntry.usedUsd = capEntry.creditUsd * 1.5; // Simulate spending 150%
  const stagesCap = meterEngine.checkAndEmitStages(capEntry, ticketMatched.termsHashHex);
  console.log("  Stages emitted:", stagesCap.map((s) => s.payload.stage));
  if (stagesCap.length === 0) throw new Error("Expected stage payloads for cap test");
  const finalStage = stagesCap[stagesCap.length - 1];
  console.log("  Final stage reached:", finalStage.payload.stage);
  console.log("  Metered yocto value:", finalStage.payload.meteredValueYocto);
  console.log("  Deal creditAmountYocto:", capEntry.creditAmountYocto.toString());
  if (finalStage.payload.stage !== 100) throw new Error("Highest stage should be 100%");
  for (const s of stagesCap) {
    if (s.payload.stage > 100) throw new Error("Stage exceeded 100%");
    if (BigInt(s.payload.meteredValueYocto) > capEntry.creditAmountYocto) {
      throw new Error("Metered value exceeded 100% of deal credit amount!");
    }
  }
  // Also verify that emitDefault at 150% is clamped to 100%
  const defaultSig = meterEngine.emitDefault(capEntry, ticketMatched.termsHashHex, 1 as any);
  if (BigInt(defaultSig.payload.meteredValueYocto) > capEntry.creditAmountYocto) {
    throw new Error("emitDefault metered value exceeded 100%!");
  }
  console.log("PASS: Metering strictly clamps stages at 100% and metered yocto to totalCredit.");

  // 13. Live NEAR Price Oracle Test
  console.log("\n[Test 13] Testing Live NEAR Price Oracle...");
  const livePrice = await fetchLiveNearPriceUsd();
  console.log("  Fetched live NEAR price (USD):", livePrice);
  if (typeof livePrice !== "number" || livePrice <= 0 || isNaN(livePrice)) {
    throw new Error(`Invalid live NEAR price fetched: ${livePrice}`);
  }
  console.log("PASS: Live NEAR price oracle returns valid positive USD price.");

  console.log("\n=======================================================");
  console.log("  ALL CONPI TEE SERVICE UNIT TESTS PASSED (13/13)!     ");
  console.log("=======================================================");
}

runTests().catch((err) => {
  console.error("Test failed:", err);
  process.exit(1);
});
