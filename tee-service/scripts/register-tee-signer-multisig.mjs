import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { Account, JsonRpcProvider, KeyPairSigner } from "near-api-js";

const ESCROW_ID = "dev-20261103062448-30583839049419.testnet";
const SIGNER_KEY = "ed25519:F4YtyCFTEj9rca8fJQxcQd7F1UHuuGQBxP8WmcAC7cbi";
const RPC_URL = process.env.NEAR_RPC_URL || "https://near-testnet.drpc.org";
const measurement = process.env.CONPI_TEE_MEASUREMENT;

if (!measurement) {
  throw new Error("CONPI_TEE_MEASUREMENT is required");
}

const repoRoot = path.resolve(import.meta.dirname, "../..");
const credentialsPath = path.join(repoRoot, "contracts/.credentials/dao_member_keys.json");
const credentials = JSON.parse(fs.readFileSync(credentialsPath, "utf8"));
const daoId = credentials.dao_account_id;
const provider = new JsonRpcProvider({ url: RPC_URL });

const memberAccount = (member) => new Account(
  daoId,
  provider,
  KeyPairSigner.fromSecretKey(member.secret_key),
);

const member1 = memberAccount(credentials.members[0]);
const member2 = memberAccount(credentials.members[1]);

const view = async (methodName, args = {}) => {
  const response = await fetch(RPC_URL, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: `conpi-governance-${methodName}-${Date.now()}`,
      method: "query",
      params: {
        request_type: "call_function",
        finality: "final",
        account_id: ESCROW_ID,
        method_name: methodName,
        args_base64: Buffer.from(JSON.stringify(args)).toString("base64"),
      },
    }),
  });
  const body = await response.json();
  if (!response.ok || body.error) {
    throw new Error(`View ${methodName} failed: ${JSON.stringify(body.error || body)}`);
  }
  return JSON.parse(Buffer.from(body.result.result).toString("utf8"));
};

const call = async (account, methodName, args, gas = 150_000_000_000_000n) => {
  const result = await account.callFunctionRaw({
    contractId: daoId,
    methodName,
    args,
    gas,
    deposit: 0n,
  });
  const failure = result.status?.Failure;
  if (failure) throw new Error(`${methodName} failed: ${JSON.stringify(failure)}`);
  return result;
};

const successJson = (result) => {
  const encoded = result.status?.SuccessValue;
  if (typeof encoded !== "string") return null;
  const decoded = Buffer.from(encoded, "base64").toString("utf8");
  return decoded ? JSON.parse(decoded) : null;
};

const multisigFunctionCall = (methodName, args) => ({
  receiver_id: ESCROW_ID,
  actions: [{
    type: "FunctionCall",
    method_name: methodName,
    args: Buffer.from(JSON.stringify(args)).toString("base64"),
    deposit: "0",
    gas: "50000000000000",
  }],
});

const createAndConfirm = async (methodName, args) => {
  const created = await call(member1, "add_request_and_confirm", {
    request: multisigFunctionCall(methodName, args),
  });
  const requestId = successJson(created);
  if (!Number.isInteger(requestId)) {
    throw new Error(`Unexpected multisig request id: ${JSON.stringify(requestId)}`);
  }
  const confirmed = await call(member2, "confirm", { request_id: requestId });
  return {
    requestId,
    createTx: created.transaction.hash,
    confirmTx: confirmed.transaction.hash,
  };
};

const waitFor = async (predicate, label, timeoutMs = 420_000) => {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const value = await predicate();
    if (value) return value;
    const seconds = Math.ceil((timeoutMs - (Date.now() - started)) / 1000);
    console.log(`${label}; ${seconds}s remaining`);
    await new Promise((resolve) => setTimeout(resolve, 15_000));
  }
  throw new Error(`Timed out waiting for ${label}`);
};

console.log(`Using DAO ${daoId}`);
console.log(`Using NEAR RPC ${RPC_URL}`);
console.log(`Registering ${SIGNER_KEY}`);
console.log(`Measurement ${measurement}`);

const current = await view("get_tee_signer", { public_key: SIGNER_KEY });
if (current?.active && current.measurement === measurement) {
  console.log("Requested signer measurement is already active.");
  process.exit(0);
}

const action = {
  AddTeeSigner: {
    public_key: SIGNER_KEY,
    measurement,
  },
};

const proposalTxs = await createAndConfirm("propose_admin_action", { action });
console.log(`Proposal multisig request ${proposalTxs.requestId}`);
console.log(`Proposal create tx ${proposalTxs.createTx}`);
console.log(`Proposal confirm tx ${proposalTxs.confirmTx}`);

const proposals = await view("list_staged_proposals");
const matching = [...proposals].reverse().find(([, proposal]) => (
  proposal?.action?.AddTeeSigner?.public_key === SIGNER_KEY
  && proposal?.action?.AddTeeSigner?.measurement === measurement
));
if (!matching) throw new Error("The expected AddTeeSigner proposal was not staged");

const [proposalId, proposal] = matching;
const readyAtNs = BigInt(proposal.ready_at);
await waitFor(async () => BigInt(Date.now()) * 1_000_000n >= readyAtNs, `timelock for proposal ${proposalId}`);

const executionTxs = await createAndConfirm("execute_admin_action", {
  proposal_id: Number(proposalId),
  code: null,
});
console.log(`Execution multisig request ${executionTxs.requestId}`);
console.log(`Execution create tx ${executionTxs.createTx}`);
console.log(`Execution confirm tx ${executionTxs.confirmTx}`);

const verified = await waitFor(async () => {
  const signer = await view("get_tee_signer", { public_key: SIGNER_KEY });
  return signer?.active && signer.measurement === measurement ? signer : null;
}, "final signer state", 120_000);

console.log(`Registered at ${verified.registered_at}`);
console.log("TEE signer measurement registration complete.");
