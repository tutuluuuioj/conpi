import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  Account,
  JsonRpcProvider,
  KeyPairEd25519,
  KeyPairSigner,
  actions,
} from "near-api-js";
import { RELAYER_METHODS } from "./relayer-methods.mjs";

const directory = path.dirname(fileURLToPath(import.meta.url));
const repository = path.resolve(directory, "../..");
const funderPath = process.env.FUNDER_CREDENTIALS || path.join(repository, "contracts/.credentials/testnet_funder.json");
const outputPath = process.env.RELAYER_CREDENTIALS || path.join(repository, ".credentials/phase4-relayer.json");
const contractId = process.env.CONTRACT_ID || "dev-20261103062448-30583839049419.testnet";
const rpcUrl = process.env.NEAR_NODE_URL || "https://test.rpc.fastnear.com";

if (fs.existsSync(outputPath)) {
  throw new Error(`Refusing to overwrite existing relayer credential: ${outputPath}`);
}

const funder = JSON.parse(fs.readFileSync(funderPath, "utf8"));
if (!funder.accountId || !funder.privateKey) throw new Error("Funder credential is incomplete");

const relayerKey = KeyPairEd25519.fromRandom();
const provider = new JsonRpcProvider({ url: rpcUrl });
const signer = KeyPairSigner.fromSecretKey(funder.privateKey);
const account = new Account(funder.accountId, provider, signer);
const methods = [...RELAYER_METHODS];
const allowance = 1_000_000_000_000_000_000_000_000n; // 1 NEAR maximum gas spend

const result = await account.signAndSendTransaction({
  receiverId: funder.accountId,
  actions: [actions.addFunctionCallAccessKey(relayerKey.publicKey, contractId, methods, allowance)],
  waitUntil: "FINAL",
  throwOnFailure: true,
});

fs.mkdirSync(path.dirname(outputPath), { recursive: true, mode: 0o700 });
fs.writeFileSync(outputPath, JSON.stringify({
  accountId: funder.accountId,
  privateKey: relayerKey.toString(),
  publicKey: relayerKey.publicKey.toString(),
  receiverId: contractId,
  methodNames: methods,
  allowanceYocto: allowance.toString(),
  network: "testnet",
}, null, 2), { encoding: "utf8", mode: 0o600, flag: "wx" });

console.log(JSON.stringify({
  accountId: funder.accountId,
  publicKey: relayerKey.publicKey.toString(),
  receiverId: contractId,
  methodNames: methods,
  transactionHash: result.transaction.hash,
  credentialPath: outputPath,
}, null, 2));
