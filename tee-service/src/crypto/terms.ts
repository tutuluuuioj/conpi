import { sha256 } from "@noble/hashes/sha256";

export interface DealTermsParams {
  dealId: bigint | number;
  buyer: string;
  seller: string;
  token: string | null; // null for native NEAR
  priceYocto: bigint;
  creditAmountYocto: bigint;
  buyerCollateralYocto: bigint;
  sellerCollateralYocto: bigint;
  teePubKeyBytes: Uint8Array; // 32 bytes ed25519 public key
  depositDurationNs: bigint;
  keyDurationNs: bigint;
  teeLivenessTimeoutNs: bigint;
  slashBpsProviderBan: number;
  slashBpsRevoke: number;
  slashBpsBuyerBreach: number;
}

function writeU64LE(val: bigint | number): Buffer {
  const buf = Buffer.alloc(8);
  buf.writeBigUInt64LE(BigInt(val));
  return buf;
}

function writeU128LE(val: bigint): Buffer {
  const buf = Buffer.alloc(16);
  // low 64 bits
  buf.writeBigUInt64LE(val & 0xffffffffffffffffn, 0);
  // high 64 bits
  buf.writeBigUInt64LE(val >> 64n, 8);
  return buf;
}

function writeU16LE(val: number): Buffer {
  const buf = Buffer.alloc(2);
  buf.writeUInt16LE(val);
  return buf;
}

/**
 * Computes canonical terms_hash on-chain from the agreed deal parameters.
 * Exactly matches CryptoHelper::compute_terms_hash in Rust contract.
 */
export function computeTermsHash(params: DealTermsParams): Uint8Array {
  const chunks: Buffer[] = [];

  chunks.push(Buffer.from("conpi:v1:terms_hash:"));
  chunks.push(writeU64LE(params.dealId));
  chunks.push(Buffer.from(params.buyer));
  chunks.push(Buffer.from(":"));
  chunks.push(Buffer.from(params.seller));
  chunks.push(Buffer.from(":"));

  if (params.token) {
    chunks.push(Buffer.from(params.token));
  } else {
    chunks.push(Buffer.from("native_near"));
  }

  chunks.push(writeU128LE(params.priceYocto));
  chunks.push(writeU128LE(params.creditAmountYocto));
  chunks.push(writeU128LE(params.buyerCollateralYocto));
  chunks.push(writeU128LE(params.sellerCollateralYocto));

  // near_sdk::PublicKey for ED25519 starts with curve_type 0, followed by 32 bytes
  const nearPkBytes = Buffer.concat([Buffer.from([0]), Buffer.from(params.teePubKeyBytes)]);
  chunks.push(nearPkBytes);

  chunks.push(writeU64LE(params.depositDurationNs));
  chunks.push(writeU64LE(params.keyDurationNs));
  chunks.push(writeU64LE(params.teeLivenessTimeoutNs));

  chunks.push(writeU16LE(params.slashBpsProviderBan));
  chunks.push(writeU16LE(params.slashBpsRevoke));
  chunks.push(writeU16LE(params.slashBpsBuyerBreach));

  const total = Buffer.concat(chunks);
  return sha256(total);
}

/**
 * Constructs the canonical message for register_terms_hash:
 * b"conpi:v1:terms:" + chain_id + b":" + contract_id + b":" + deal_id (u64 LE) + terms_hash (32 bytes)
 * Exactly matches CryptoHelper::build_terms_message in Rust contract.
 */
export function buildTermsMessage(
  chainId: string,
  contractId: string,
  dealId: bigint | number,
  termsHash: Uint8Array
): Uint8Array {
  const chunks: Buffer[] = [
    Buffer.from("conpi:v1:terms:"),
    Buffer.from(chainId),
    Buffer.from(":"),
    Buffer.from(contractId),
    Buffer.from(":"),
    writeU64LE(dealId),
    Buffer.from(termsHash),
  ];
  return Buffer.concat(chunks);
}
