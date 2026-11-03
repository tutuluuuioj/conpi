export enum PayloadKind {
  Terms = 0,
  Activate = 1,
  Stage = 2,
  Checkpoint = 3,
  Default = 4,
}

export enum DefaultReason {
  InvalidKey = 0,
  InsufficientQuota = 1,
  ProviderBan = 2,
  SellerRevokedKey = 3,
  LivenessTimeout = 4,
  RateLimitExhaustion = 5,
  UsageDeadlinePassed = 6,
  BuyerBreach = 7,
}

export interface SignedPayloadDto {
  domain: string; // "conpi:v1"
  contractId: string;
  chainId: string;
  dealId: bigint | number;
  termsHash: Uint8Array; // 32 bytes
  kind: PayloadKind;
  stage: number; // 0 to 100
  meteredValueYocto: bigint;
  reason?: DefaultReason | null;
  nonce: bigint | number;
  issuedAtNs: bigint;
}

function writeString(str: string): Buffer {
  const bytes = Buffer.from(str, "utf8");
  const len = Buffer.alloc(4);
  len.writeUInt32LE(bytes.length, 0);
  return Buffer.concat([len, bytes]);
}

function writeU64LE(val: bigint | number): Buffer {
  const buf = Buffer.alloc(8);
  buf.writeBigUInt64LE(BigInt(val));
  return buf;
}

function writeU128LE(val: bigint): Buffer {
  const buf = Buffer.alloc(16);
  buf.writeBigUInt64LE(val & 0xffffffffffffffffn, 0);
  buf.writeBigUInt64LE(val >> 64n, 8);
  return buf;
}

/**
 * Canonically Borsh-serializes a SignedPayload into exact bytes matching
 * borsh::to_vec(payload) in near-sdk-rs / Rust contract.
 */
export function serializeSignedPayload(payload: SignedPayloadDto): Uint8Array {
  if (payload.termsHash.length !== 32) {
    throw new Error(`termsHash must be exactly 32 bytes, got ${payload.termsHash.length}`);
  }

  const chunks: Buffer[] = [
    writeString(payload.domain),
    writeString(payload.contractId),
    writeString(payload.chainId),
    writeU64LE(payload.dealId),
    Buffer.from(payload.termsHash),
    Buffer.from([payload.kind]),
    Buffer.from([payload.stage]),
    writeU128LE(payload.meteredValueYocto),
  ];

  if (payload.reason === undefined || payload.reason === null) {
    chunks.push(Buffer.from([0])); // Option::None
  } else {
    chunks.push(Buffer.from([1])); // Option::Some
    chunks.push(Buffer.from([payload.reason]));
  }

  chunks.push(writeU64LE(payload.nonce));
  chunks.push(writeU64LE(payload.issuedAtNs));

  return Buffer.concat(chunks);
}
