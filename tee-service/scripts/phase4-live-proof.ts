import fs from "node:fs";
import path from "node:path";
import { Account, JsonRpcProvider, KeyPairSigner } from "near-api-js";
import { encryptToEnclave } from "../src/crypto/encryption.js";

const REPOSITORY = path.resolve(import.meta.dirname, "../..");
const CONTRACT_ID = "dev-20261103062448-30583839049419.testnet";
const CVM_URL = "https://ce5044ca834d2da5bb1252706bfa3b2c91d7d934-3000.dstack-pha1-prod5.phala.network";
const RPC_URL = "https://rpc.testnet.near.org";
const MODEL = "meta-llama/llama-3.2-1b-instruct";
const REQUIRED_CONFIRMATION = "I_APPROVE_ENCRYPTED_OPENROUTER_KEY_UPLOAD";

type Credential = { accountId: string; privateKey: string };

function credential(relativePath: string): Credential {
  return JSON.parse(fs.readFileSync(path.join(REPOSITORY, relativePath), "utf8"));
}

async function view(methodName: string, args: Record<string, unknown>): Promise<any> {
  const response = await fetch(RPC_URL, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: `phase4-${methodName}`,
      method: "query",
      params: {
        request_type: "call_function",
        finality: "final",
        account_id: CONTRACT_ID,
        method_name: methodName,
        args_base64: Buffer.from(JSON.stringify(args)).toString("base64"),
      },
    }),
  });
  const body: any = await response.json();
  if (body.error) throw new Error(`RPC ${methodName} failed: ${JSON.stringify(body.error)}`);
  return JSON.parse(Buffer.from(body.result.result).toString("utf8"));
}

async function call(account: Account, methodName: string, args: Record<string, unknown>, deposit = 0n) {
  return account.callFunctionRaw({
    contractId: CONTRACT_ID,
    methodName,
    args,
    gas: 100_000_000_000_000n,
    deposit,
  });
}

function transactionHash(result: any): string {
  return String(result.transaction?.hash || result.transaction_outcome?.id || "");
}

function returnedDealId(result: any): number {
  const encoded = result.status?.SuccessValue;
  if (typeof encoded !== "string") throw new Error("create_deal did not return a deal id");
  return Number(JSON.parse(Buffer.from(encoded, "base64").toString("utf8")));
}

function contractPayload(payload: any, kind: "Activate" | "Stage") {
  return {
    domain: payload.domain,
    contract_id: payload.contractId,
    chain_id: payload.chainId,
    deal_id: Number(payload.dealId),
    terms_hash: Array.from(Buffer.from(payload.termsHashHex, "hex")),
    kind,
    stage: Number(payload.stage),
    metered_value: String(payload.meteredValueYocto),
    reason: null,
    nonce: Number(payload.nonce),
    issued_at: Number(payload.issuedAtNs),
  };
}

async function main() {
  if (process.env.CONPI_LIVE_PROOF_CONFIRMATION !== REQUIRED_CONFIRMATION) {
    throw new Error(
      `Refusing to mutate testnet or upload an encrypted provider key. Set CONPI_LIVE_PROOF_CONFIRMATION=${REQUIRED_CONFIRMATION} after reviewing the CVM destination and test accounts.`
    );
  }

  const provider = new JsonRpcProvider({ url: RPC_URL });
  const buyerCredential = credential("contracts/.credentials/buyer89a.json");
  const sellerCredential = credential("contracts/.credentials/testnet_funder.json");
  const buyer = new Account(buyerCredential.accountId, provider, KeyPairSigner.fromSecretKey(buyerCredential.privateKey as any));
  const seller = new Account(sellerCredential.accountId, provider, KeyPairSigner.fromSecretKey(sellerCredential.privateKey as any));
  const openRouterKey = fs.readFileSync(path.join(REPOSITORY, ".credentials/openrouter_key.txt"), "utf8").trim();

  const attestationResponse = await fetch(`${CVM_URL}/v1/attestation?nonce=5068617365344c69766550726f6f66`);
  const attestation: any = await attestationResponse.json();
  if (!attestation.inEnclave || !attestation.rawQuoteHex || !attestation.encryptionPublicKeyHex) {
    throw new Error("Live CVM hardware attestation is incomplete");
  }

  const price = "50000000000000000000"; // 0.00005 NEAR
  const credit = "50000000000000000000";
  const buyerCollateral = "10000000000000000000";
  const sellerCollateral = "20000000000000000000";

  const create = await call(buyer, "create_deal", {
    params: {
      buyer: buyerCredential.accountId,
      seller: sellerCredential.accountId,
      token: null,
      price,
      credit_amount: credit,
      buyer_collateral: buyerCollateral,
      seller_collateral: sellerCollateral,
      tee_pubkey: attestation.signerPublicKeyNear,
      deposit_duration_sec: 600,
      key_duration_sec: 600,
      tee_liveness_timeout_sec: 3600,
      slash_bps_provider_ban: 5000,
      slash_bps_revoke: 8000,
      slash_bps_buyer_breach: 5000,
    },
  }, 50_000_000_000_000_000_000_000n);
  const dealId = returnedDealId(create);
  const created = await view("get_deal", { deal_id: dealId });
  const termsHash = created.terms_hash;
  const termsHashHex = Buffer.from(termsHash).toString("hex");

  const accept = await call(seller, "accept_deal", { deal_id: dealId, expected_hash: termsHash });
  const buyerDeposit = await call(buyer, "deposit", { deal_id: dealId }, BigInt(price) + BigInt(buyerCollateral));
  const sellerDeposit = await call(seller, "deposit", { deal_id: dealId }, BigInt(sellerCollateral));

  const encryptedEnvelope = encryptToEnclave(openRouterKey, attestation.encryptionPublicKeyHex);
  const injectResponse = await fetch(`${CVM_URL}/v1/deals/${dealId}/key`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      provider: "openrouter",
      model: MODEL,
      models: [MODEL],
      termsHashHex,
      encryptedEnvelope,
    }),
  });
  const inject: any = await injectResponse.json();
  if (!inject.ok || !inject.proxyKey) throw new Error(`TEE key injection failed: ${inject.error || injectResponse.status}`);

  const activate = await call(seller, "activate", {
    deal_id: dealId,
    payload: contractPayload(inject.activatePayload, "Activate"),
    sig: Array.from(Buffer.from(inject.activateSignatureHex, "hex")),
  });

  let meter: any = null;
  let onChain: any = null;
  for (let attempt = 1; attempt <= 30; attempt += 1) {
    const chatResponse = await fetch(`${CVM_URL}/v1/chat/completions`, {
      method: "POST",
      headers: { authorization: `Bearer ${inject.proxyKey}`, "content-type": "application/json" },
      body: JSON.stringify({
        model: MODEL,
        messages: [{ role: "user", content: `In one short sentence, define confidential computing. Attempt ${attempt}.` }],
        max_tokens: 40,
        temperature: 0,
      }),
    });
    if (!chatResponse.ok) {
      const error: any = await chatResponse.json();
      throw new Error(`Live inference failed (${chatResponse.status}): ${JSON.stringify(error)}`);
    }
    await chatResponse.json();

    const meterResponse = await fetch(`${CVM_URL}/v1/deals/${dealId}/meter`, {
      headers: { authorization: `Bearer ${inject.proxyKey}` },
    });
    meter = await meterResponse.json();
    onChain = await view("get_deal", { deal_id: dealId });
    if (Number(onChain.stage_reached || 0) >= 25) break;
    await new Promise((resolve) => setTimeout(resolve, 1_500));
  }

  // Allow the relayer receipt to be published if the chain view won the race.
  await new Promise((resolve) => setTimeout(resolve, 2_000));
  onChain = await view("get_deal", { deal_id: dealId });
  const payloads: any = await (await fetch(`${CVM_URL}/v1/deals/${dealId}/payloads`)).json();
  const stageReceipt = (payloads.relayReceipts || []).find((item: any) => item.kind === "stage" && item.state === "applied");

  if (buyerCredential.accountId === sellerCredential.accountId) throw new Error("Buyer and seller must differ");
  if (Number(onChain.stage_reached || 0) < 25) throw new Error("Automatic stage relay did not reach 25% on-chain");
  if (!stageReceipt?.transactionHash) throw new Error("TEE did not record an applied automatic stage transaction");

  console.log(JSON.stringify({
    dealId,
    buyer: buyerCredential.accountId,
    seller: sellerCredential.accountId,
    composeHash: attestation.composeHash,
    createDealTx: transactionHash(create),
    acceptDealTx: transactionHash(accept),
    buyerDepositTx: transactionHash(buyerDeposit),
    sellerDepositTx: transactionHash(sellerDeposit),
    activateTx: transactionHash(activate),
    automaticStageTx: stageReceipt.transactionHash,
    stageReached: Number(onChain.stage_reached),
    usedUsd: Number(meter?.usedUsd || 0),
    creditUsd: Number(meter?.creditUsd || 0),
    relayerState: stageReceipt.state,
  }, null, 2));
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
