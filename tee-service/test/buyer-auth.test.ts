process.env.NODE_ENV = "test";

import { ed25519 } from "@noble/curves/ed25519";
import bs58 from "bs58";
import { privateKeyToAccount } from "viem/accounts";
import {
  buildBuyerKeyAuthorizationMessage,
  verifyBuyerKeyAuthorization,
  type BuyerKeyAuthorizationRequest,
} from "../src/auth/buyer-key.js";
import { canonicalSellerAccount } from "../src/auth/seller-key.js";
import { sellerSafeKeyResult } from "../src/index.js";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

async function expectReject(task: () => Promise<unknown>, pattern: RegExp) {
  try {
    await task();
    throw new Error("Expected authorization to be rejected");
  } catch (error: any) {
    assert(pattern.test(error?.message || ""), `Unexpected rejection: ${error?.message}`);
  }
}

async function run() {
  const now = 1_800_000_100_000;
  const evm = privateKeyToAccount(`0x${"34".repeat(32)}`);
  const evmAuth: any = {
    chain: "base",
    address: evm.address,
    nonce: Buffer.alloc(32, 11).toString("base64"),
    issuedAtMs: now,
    signature: "",
  };
  const evmRequest: BuyerKeyAuthorizationRequest = {
    dealId: 81,
    buyer: canonicalSellerAccount("base", evm.address),
    authorization: evmAuth,
  };
  evmAuth.signature = await evm.signMessage({ message: buildBuyerKeyAuthorizationMessage(evmRequest) });
  await verifyBuyerKeyAuthorization(evmRequest, { now: () => now });
  await expectReject(() => verifyBuyerKeyAuthorization(evmRequest, { now: () => now }), /already been used/i);

  const solanaKeys = ed25519.keygen();
  const solanaAddress = bs58.encode(solanaKeys.publicKey);
  const solanaAuth: any = {
    chain: "solana",
    address: solanaAddress,
    nonce: Buffer.alloc(32, 12).toString("base64"),
    issuedAtMs: now,
    signature: "",
  };
  const solanaRequest: BuyerKeyAuthorizationRequest = {
    dealId: 82,
    buyer: canonicalSellerAccount("solana", solanaAddress),
    authorization: solanaAuth,
  };
  solanaAuth.signature = Buffer.from(
    ed25519.sign(new TextEncoder().encode(buildBuyerKeyAuthorizationMessage(solanaRequest)), solanaKeys.secretKey)
  ).toString("base64");
  await verifyBuyerKeyAuthorization(solanaRequest, { now: () => now });

  const nearAuth: any = {
    chain: "near",
    address: "buyer.testnet",
    nonce: Buffer.alloc(32, 13).toString("base64"),
    issuedAtMs: now,
    signature: Buffer.alloc(64, 14).toString("base64"),
    publicKey: `ed25519:${bs58.encode(Buffer.alloc(32, 15))}`,
  };
  const nearRequest: BuyerKeyAuthorizationRequest = {
    dealId: 83,
    buyer: "buyer.testnet",
    authorization: nearAuth,
  };
  let nearVerified = false;
  await verifyBuyerKeyAuthorization(nearRequest, {
    now: () => now,
    verifyNear: (async ({ signerAccountId, payload }) => {
      nearVerified = signerAccountId === "buyer.testnet" && payload.message === buildBuyerKeyAuthorizationMessage(nearRequest);
    }) as any,
  });
  assert(nearVerified, "NEAR buyer challenge was not verified");

  await expectReject(
    () => verifyBuyerKeyAuthorization({ ...solanaRequest, dealId: 999 }, { now: () => now }),
    /signature/i
  );
  await expectReject(
    () => verifyBuyerKeyAuthorization({ ...nearRequest, buyer: "attacker.testnet" }, { now: () => now }),
    /not the deal buyer/i
  );
  await expectReject(
    () => verifyBuyerKeyAuthorization({ ...nearRequest, authorization: { ...nearAuth, nonce: Buffer.alloc(32, 16).toString("base64") } }, { now: () => now + 6 * 60_000 }),
    /expired/i
  );

  const sellerResponse = sellerSafeKeyResult({
    ok: true,
    proxyKey: "cpk_live_must_never_reach_seller",
    activateSignatureHex: "ab",
  });
  assert(!("proxyKey" in sellerResponse), "Seller activation response leaked the buyer proxy key");

  console.log("Buyer-key authorization tests passed (wallet ownership, replay, tamper, expiry, seller redaction)");
}

run().catch((error) => {
  console.error(error);
  process.exit(1);
});
