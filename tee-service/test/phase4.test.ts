process.env.NODE_ENV = "test";

import { CONFIG } from "../src/config.js";
import { nearRelayer } from "../src/chain/relayer.js";
import { enclaveKeys } from "../src/crypto/keys.js";
import { DefaultReason, PayloadKind, serializeSignedPayload } from "../src/crypto/borsh.js";
import { meterEngine } from "../src/proxy/meter.js";
import { settlementEngine } from "../src/settlement/engine.js";
import { publicKeyFromSolanaAddress } from "../src/chain/solana-client.js";
import type { VaultEntry } from "../src/vault/preflight.js";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function entry(dealId: number, usedUsd = 0): VaultEntry {
  return {
    dealId,
    provider: "OpenAI",
    apiKey: "mock_phase4_key",
    model: "gpt-4o",
    models: ["gpt-4o"],
    proxyKey: `cpk_live_phase4_${dealId}`,
    termsHashHex: "44".repeat(32),
    creditUsd: 100,
    priceUsd: 80,
    usedUsd,
    tokensTotal: 0,
    lockedPricing: Object.freeze({ "gpt-4o": Object.freeze({ inputPerMillion: 2.5, outputPerMillion: 10 }) }),
    rateLimitPerMinute: 60,
    creditAmountYocto: "100000000",
    active: true,
    registeredAt: new Date().toISOString(),
    signedPayloads: [],
    lastCheckpointAt: 0,
    relayReceipts: [],
    onChainStatus: "Active",
  };
}

async function runPhase4Tests() {
  console.log("=== RUNNING CONPI PHASE 4 ACCEPTANCE TESTS ===");
  await enclaveKeys.init();
  settlementEngine.resetForTests();
  meterEngine.reset();
  nearRelayer.setRelayerCredentials("phase4-relayer.testnet", "ed25519:test-only-stub-key");
  (CONFIG as any).relayerRetryBaseMs = 25;

  const originalGetDeal = nearRelayer.getDeal.bind(nearRelayer);
  const originalStage = nearRelayer.submitReleaseStage.bind(nearRelayer);
  const originalCheckpoint = nearRelayer.submitCheckpoint.bind(nearRelayer);
  const originalDefault = nearRelayer.submitSettleDefault.bind(nearRelayer);

  try {
    console.log("[P4-1] Hardware-signed 25/50/75/100 stage payloads relay in nonce order...");
    const stageEntry = entry(4001, 100);
    const stageChain = { status: "Active", stage_reached: 0, last_nonce: 1 };
    const stageCalls: number[] = [];
    (nearRelayer as any).getDeal = async (dealId: number) => dealId === 4001 ? { ...stageChain } : null;
    (nearRelayer as any).submitReleaseStage = async (_dealId: number, stage: number, payload: any) => {
      assert(Number(payload.nonce) > stageChain.last_nonce, "Stage nonce did not increase");
      stageCalls.push(stage);
      stageChain.stage_reached = stage;
      stageChain.last_nonce = Number(payload.nonce);
      if (stage === 100) stageChain.status = "Completed";
      return { transactionHash: `stage-${stage}-tx`, status: { SuccessValue: "" } };
    };
    meterEngine.seedNonce(4001, 1);
    const stages = meterEngine.checkAndEmitStages(stageEntry, stageEntry.termsHashHex);
    stageEntry.signedPayloads.push(...stages);
    const stageReceipts = await settlementEngine.relayStages(stageEntry, stages);
    assert(stages.map((item) => item.payload.stage).join(",") === "25,50,75,100", "Milestone payload set is incomplete");
    assert(stageCalls.join(",") === "25,50,75,100", "Stage transactions were not serialized in order");
    assert(stageReceipts.every((receipt) => receipt.state === "applied" && receipt.transactionHash), "A stage relay did not finalize");
    assert(stages.every((item) => enclaveKeys.verify(
      serializeSignedPayload(item.payload),
      Buffer.from(item.signatureHex, "hex")
    )), "A stage payload signature is invalid");

    console.log("[P4-1b] A checkpoint cannot interleave a multi-stage payout batch...");
    settlementEngine.resetForTests();
    meterEngine.reset(4011);
    const batchedEntry = entry(4011, 80);
    const batchedChain = { status: "Active", stage_reached: 0, last_nonce: 1 };
    const relayOrder: string[] = [];
    let interleavedCheckpoint: Promise<any> | undefined;
    (nearRelayer as any).getDeal = async (dealId: number) => dealId === 4011 ? { ...batchedChain } : null;
    (nearRelayer as any).submitReleaseStage = async (_dealId: number, stage: number, payload: any) => {
      if (stage === 25) {
        interleavedCheckpoint = settlementEngine.createAndRelayCheckpoint(batchedEntry);
        // Let checkpoint creation enqueue while the first stage is in-flight.
        await Promise.resolve();
      }
      assert(Number(payload.nonce) > batchedChain.last_nonce, "A checkpoint invalidated a queued stage nonce");
      relayOrder.push(`stage-${stage}`);
      batchedChain.stage_reached = stage;
      batchedChain.last_nonce = Number(payload.nonce);
      return { transactionHash: `batch-stage-${stage}`, status: { SuccessValue: "" } };
    };
    (nearRelayer as any).submitCheckpoint = async (_dealId: number, payload: any) => {
      assert(Number(payload.nonce) > batchedChain.last_nonce, "Checkpoint nonce did not follow staged payouts");
      relayOrder.push("checkpoint");
      batchedChain.last_nonce = Number(payload.nonce);
      return { transactionHash: "batch-checkpoint", status: { SuccessValue: "" } };
    };
    meterEngine.seedNonce(4011, 1);
    const batchedStages = meterEngine.checkAndEmitStages(batchedEntry, batchedEntry.termsHashHex);
    batchedEntry.signedPayloads.push(...batchedStages);
    await settlementEngine.relayStages(batchedEntry, batchedStages);
    await interleavedCheckpoint;
    assert(
      relayOrder.join(",") === "stage-25,stage-50,stage-75,checkpoint",
      `Checkpoint interleaved a staged payout batch: ${relayOrder.join(",")}`
    );

    console.log("[P4-2] Periodic checkpoints sign exact metered usage and refresh liveness...");
    settlementEngine.resetForTests();
    meterEngine.reset(4002);
    const checkpointEntry = entry(4002, 40);
    const checkpointChain = { status: "Active", stage_reached: 25, last_nonce: 2 };
    let checkpointCalls = 0;
    (nearRelayer as any).getDeal = async (dealId: number) => dealId === 4002 ? { ...checkpointChain } : null;
    (nearRelayer as any).submitCheckpoint = async (_dealId: number, payload: any) => {
      checkpointCalls += 1;
      checkpointChain.last_nonce = Number(payload.nonce);
      return { transactionHash: "checkpoint-tx", status: { SuccessValue: "" } };
    };
    const checkpointReceipt = await settlementEngine.createAndRelayCheckpoint(checkpointEntry);
    const checkpoint = checkpointEntry.signedPayloads.at(-1)!;
    assert(checkpoint.payload.kind === PayloadKind.Checkpoint, "Checkpoint payload kind is wrong");
    assert(checkpoint.payload.meteredValueYocto === 40_000_000n, "Checkpoint did not preserve exact metered usage");
    assert(checkpointCalls === 1 && checkpointReceipt?.state === "applied", "Checkpoint was not relayed exactly once");

    console.log("[P4-3] Lost RPC responses retry safely without duplicate settlement...");
    settlementEngine.resetForTests();
    meterEngine.reset(4003);
    const retryEntry = entry(4003, 40);
    const retryChain = { status: "Active", stage_reached: 0, last_nonce: 1 };
    let retryAttempts = 0;
    (nearRelayer as any).getDeal = async (dealId: number) => dealId === 4003 ? { ...retryChain } : null;
    (nearRelayer as any).submitCheckpoint = async (_dealId: number, payload: any) => {
      retryAttempts += 1;
      if (retryAttempts === 1) throw new Error("temporary RPC timeout");
      retryChain.last_nonce = Number(payload.nonce);
      return { transactionHash: "checkpoint-retry-tx", status: { SuccessValue: "" } };
    };
    const retryReceipt = await settlementEngine.createAndRelayCheckpoint(retryEntry);
    assert(retryAttempts === 2, "Transient checkpoint failure was not retried once");
    assert(retryReceipt?.state === "applied" && retryReceipt.attempts === 2, "Retried checkpoint did not finalize");

    console.log("[P4-4] Concurrent default triggers produce one signed payload and one settlement tx...");
    settlementEngine.resetForTests();
    meterEngine.reset(4004);
    const defaultEntry = entry(4004, 40);
    const defaultChain = { status: "Active", stage_reached: 25, last_nonce: 2 };
    let defaultCalls = 0;
    (nearRelayer as any).getDeal = async (dealId: number) => dealId === 4004 ? { ...defaultChain } : null;
    (nearRelayer as any).submitSettleDefault = async (_dealId: number, payload: any) => {
      defaultCalls += 1;
      defaultChain.last_nonce = Number(payload.nonce);
      defaultChain.status = "Defaulted";
      return { transactionHash: "default-tx", status: { SuccessValue: "" } };
    };
    meterEngine.seedNonce(4004, 2);
    const defaultPayload = meterEngine.emitDefault(defaultEntry, defaultEntry.termsHashHex, DefaultReason.SellerSelfDrain);
    defaultEntry.signedPayloads.push(defaultPayload);
    const defaults = await Promise.all([
      settlementEngine.relayDefault(defaultEntry, defaultPayload),
      settlementEngine.relayDefault(defaultEntry, defaultPayload),
      settlementEngine.relayDefault(defaultEntry, defaultPayload),
    ]);
    assert(defaultCalls === 1, "Concurrent default relay submitted more than one transaction");
    assert(new Set(defaults.map((receipt) => receipt.nonce)).size === 1, "Default nonce changed between callers");
    assert(defaults.every((receipt) => receipt.state === "applied"), "Default settlement did not finalize");

    console.log("[P4-5] Checkpoint and default metering are capped at the locked credit...");
    const cappedEntry = entry(4005, 150);
    meterEngine.reset(4005);
    meterEngine.seedNonce(4005, 1);
    const cappedCheckpoint = meterEngine.emitCheckpoint(cappedEntry, cappedEntry.termsHashHex);
    const cappedDefault = meterEngine.emitDefault(cappedEntry, cappedEntry.termsHashHex, DefaultReason.ProviderBan);
    assert(cappedCheckpoint.payload.meteredValueYocto === 100_000_000n, "Checkpoint exceeded locked credit");
    assert(cappedDefault.payload.meteredValueYocto === 100_000_000n, "Default exceeded locked credit");

    console.log("[P4-6] Solana hex wallets preserve the seller's signed address representation...");
    const sellerHex = "bbd65d65de6e15e11d9f887423339a4acc257184d59e6cbc5d4afe1e556e0273";
    assert(
      publicKeyFromSolanaAddress(sellerHex).toBase58() === "DeEpqiydVZLN7xoFvD6ARyW6bjgum9UUdpK5wWA7UftN",
      "The locked Solana hex address did not decode to the seller's public key"
    );

    console.log("[P4-7] Failed stages are re-signed with fresh nonces and recovered in order...");
    settlementEngine.resetForTests();
    meterEngine.reset(4007);
    const recoveryEntry = entry(4007, 100);
    const recoveryChain = { status: "Active", stage_reached: 0, last_nonce: 32 };
    const recoveryStages: number[] = [];
    const recoveryNonces: number[] = [];
    (nearRelayer as any).getDeal = async (dealId: number) => dealId === 4007 ? { ...recoveryChain } : null;
    (nearRelayer as any).submitReleaseStage = async (_dealId: number, stage: number, payload: any) => {
      recoveryStages.push(stage);
      recoveryNonces.push(Number(payload.nonce));
      assert(Number(payload.nonce) > recoveryChain.last_nonce, "Recovered stage reused a stale checkpoint nonce");
      recoveryChain.stage_reached = stage;
      recoveryChain.last_nonce = Number(payload.nonce);
      if (stage === 100) recoveryChain.status = "Completed";
      return { transactionHash: `recovered-${stage}-tx`, status: { SuccessValue: "" } };
    };
    const recovered = await settlementEngine.recoverDueStages([recoveryEntry]);
    assert(recoveryStages.join(",") === "25,50,75,100", "Due stages were not recovered in order");
    assert(recoveryNonces[0] > 32, "Recovery did not continue after the latest on-chain checkpoint nonce");
    assert(recovered.length === 4 && recovered.every((receipt) => receipt.state === "applied"), "Recovered stages did not finalize");
    assert(recoveryEntry.active === false, "Completed recovery left the proxy entry active");

    console.log("=======================================================");
    console.log("  ALL PHASE 4 ACCEPTANCE TESTS PASSED (7/7)           ");
    console.log("=======================================================");
  } finally {
    (nearRelayer as any).getDeal = originalGetDeal;
    (nearRelayer as any).submitReleaseStage = originalStage;
    (nearRelayer as any).submitCheckpoint = originalCheckpoint;
    (nearRelayer as any).submitSettleDefault = originalDefault;
    settlementEngine.resetForTests();
  }
}

runPhase4Tests().catch((error) => {
  console.error("Phase 4 acceptance test failed:", error);
  process.exit(1);
});
