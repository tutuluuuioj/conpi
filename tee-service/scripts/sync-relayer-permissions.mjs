import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  Account,
  JsonRpcProvider,
  KeyPair,
  KeyPairSigner,
  actions,
} from "near-api-js";
import { RELAYER_METHODS } from "./relayer-methods.mjs";

const directory = path.dirname(fileURLToPath(import.meta.url));
const repository = path.resolve(directory, "../..");
const funderPath = process.env.FUNDER_CREDENTIALS || path.join(repository, "contracts/.credentials/testnet_funder.json");
const relayerPath = process.env.RELAYER_CREDENTIALS || path.join(repository, ".credentials/phase4-relayer.json");
const rpcUrl = process.env.NEAR_NODE_URL || "https://test.rpc.fastnear.com";
const allowance = 1_000_000_000_000_000_000_000_000n;

const funder = JSON.parse(fs.readFileSync(funderPath, "utf8"));
const relayer = JSON.parse(fs.readFileSync(relayerPath, "utf8"));
if (!funder.accountId || !funder.privateKey || !relayer.accountId || !relayer.privateKey || !relayer.receiverId) {
  throw new Error("Funder or relayer credential is incomplete");
}
if (funder.accountId !== relayer.accountId) {
  throw new Error("The full-access signer and restricted relayer key must belong to the same NEAR account");
}

const funderKey = KeyPair.fromString(funder.privateKey);
const relayerKey = KeyPair.fromString(relayer.privateKey);
if (funder.publicKey && funderKey.publicKey.toString() !== funder.publicKey) {
  throw new Error("Funder private key does not match its declared public key");
}
if (relayer.publicKey && relayerKey.publicKey.toString() !== relayer.publicKey) {
  throw new Error("Relayer private key does not match its declared public key");
}

const provider = new JsonRpcProvider({ url: rpcUrl });
const accessKeyList = await provider.query({
  request_type: "view_access_key_list",
  finality: "final",
  account_id: relayer.accountId,
});
const keys = Array.isArray(accessKeyList?.keys) ? accessKeyList.keys : [];
const fullAccessPresent = keys.some((entry) => (
  entry.public_key === funderKey.publicKey.toString() && entry.access_key?.permission === "FullAccess"
));
if (!fullAccessPresent) {
  throw new Error("The configured funder key is not a live full-access key on the relayer account");
}

const existing = keys.find((entry) => entry.public_key === relayerKey.publicKey.toString());
const existingPermission = existing?.access_key?.permission?.FunctionCall;
const currentMethods = Array.isArray(existingPermission?.method_names)
  ? [...existingPermission.method_names].sort()
  : [];
const wantedMethods = [...RELAYER_METHODS].sort();
const alreadyCurrent = existingPermission?.receiver_id === relayer.receiverId
  && currentMethods.length === wantedMethods.length
  && currentMethods.every((method, index) => method === wantedMethods[index]);

if (alreadyCurrent) {
  console.log(JSON.stringify({
    updated: false,
    accountId: relayer.accountId,
    publicKey: relayerKey.publicKey.toString(),
    receiverId: relayer.receiverId,
    methodNames: wantedMethods,
  }, null, 2));
  process.exit(0);
}

const account = new Account(
  relayer.accountId,
  provider,
  KeyPairSigner.fromSecretKey(funder.privateKey),
);
const txActions = [];
if (existing) txActions.push(actions.deleteKey(relayerKey.publicKey));
txActions.push(actions.addFunctionCallAccessKey(
  relayerKey.publicKey,
  relayer.receiverId,
  wantedMethods,
  allowance,
));

const result = await account.signAndSendTransaction({
  receiverId: relayer.accountId,
  actions: txActions,
  waitUntil: "FINAL",
  throwOnFailure: true,
});

const updatedCredential = {
  ...relayer,
  publicKey: relayerKey.publicKey.toString(),
  methodNames: wantedMethods,
  allowanceYocto: allowance.toString(),
};
fs.writeFileSync(relayerPath, `${JSON.stringify(updatedCredential, null, 2)}\n`, {
  encoding: "utf8",
  mode: 0o600,
});

console.log(JSON.stringify({
  updated: true,
  accountId: relayer.accountId,
  publicKey: relayerKey.publicKey.toString(),
  receiverId: relayer.receiverId,
  methodNames: wantedMethods,
  transactionHash: result.transaction.hash,
}, null, 2));

