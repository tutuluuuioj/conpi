process.env.NODE_ENV = "test";

import { ed25519 } from "@noble/curves/ed25519";
import bs58 from "bs58";
import { privateKeyToAccount } from "viem/accounts";
import {
  buildSellerKeyAuthorizationMessage,
  canonicalSellerAccount,
  verifySellerKeyAuthorization,
  type SellerKeyAuthorizationRequest,
} from "../src/auth/seller-key.js";

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
  const now = 1_800_000_000_000;
  const envelope = { ephemeralPublicKey: "aa", iv: "bb", ciphertext: "cc", authTag: "dd" };

  const evm = privateKeyToAccount(`0x${"12".repeat(32)}`);
  const evmAuth: any = {
    chain: "base",
    address: evm.address,
    nonce: Buffer.alloc(32, 1).toString("base64"),
    issuedAtMs: now,
    signature: "",
  };
  const evmRequest: SellerKeyAuthorizationRequest = {
    dealId: 71,
    seller: canonicalSellerAccount("base", evm.address),
    provider: "openrouter",
    model: "deepseek/deepseek-v3.1",
    models: ["deepseek/deepseek-v3.1"],
    termsHashHex: "ab".repeat(32),
    encryptedEnvelope: envelope,
    authorization: evmAuth,
  };
  evmAuth.signature = await evm.signMessage({ message: buildSellerKeyAuthorizationMessage(evmRequest) });
  await verifySellerKeyAuthorization(evmRequest, { now: () => now });
  await expectReject(
    () => verifySellerKeyAuthorization(evmRequest, { now: () => now }),
    /already been used/i
  );

  const solanaKeys = ed25519.keygen();
  const solanaAddress = bs58.encode(solanaKeys.publicKey);
  const solanaAuth: any = {
    chain: "solana",
    address: solanaAddress,
    nonce: Buffer.alloc(32, 2).toString("base64"),
    issuedAtMs: now,
    signature: "",
  };
  const solanaRequest: SellerKeyAuthorizationRequest = {
    ...evmRequest,
    dealId: 72,
    seller: canonicalSellerAccount("solana", solanaAddress),
    authorization: solanaAuth,
  };
  solanaAuth.signature = Buffer.from(
    ed25519.sign(new TextEncoder().encode(buildSellerKeyAuthorizationMessage(solanaRequest)), solanaKeys.secretKey)
  ).toString("base64");
  await verifySellerKeyAuthorization(solanaRequest, { now: () => now });

  const nearAuth: any = {
    chain: "near",
    address: "seller.testnet",
    nonce: Buffer.alloc(32, 3).toString("base64"),
    issuedAtMs: now,
    signature: Buffer.alloc(64, 4).toString("base64"),
    publicKey: `ed25519:${bs58.encode(Buffer.alloc(32, 5))}`,
  };
  const nearRequest: SellerKeyAuthorizationRequest = {
    ...evmRequest,
    dealId: 73,
    seller: "seller.testnet",
    authorization: nearAuth,
  };
  let nearVerified = false;
  await verifySellerKeyAuthorization(nearRequest, {
    now: () => now,
    verifyNear: (async ({ signerAccountId, payload }) => {
      nearVerified = signerAccountId === "seller.testnet" && payload.message === buildSellerKeyAuthorizationMessage(nearRequest);
    }) as any,
  });
  assert(nearVerified, "NEAR NEP-413 verification did not receive the canonical challenge");

  await expectReject(
    () => verifySellerKeyAuthorization({ ...evmRequest, model: "attacker/model" }, { now: () => now }),
    /signature/i
  );
  await expectReject(
    () => verifySellerKeyAuthorization({ ...evmRequest, seller: "buyer.testnet" }, { now: () => now }),
    /not the deal seller/i
  );
  await expectReject(
    () => verifySellerKeyAuthorization(evmRequest, { now: () => now + 6 * 60_000 }),
    /expired/i
  );

  console.log("Seller-key authorization tests passed (NEAR, Solana, Base, replay, tamper, expiry)");
}

run().catch((error) => {
  console.error(error);
  process.exit(1);
});
