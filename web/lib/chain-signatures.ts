import { utils } from "near-api-js";
import { secp256k1 } from "@noble/curves/secp256k1.js";
import { sha3_256, keccak_256 } from "@noble/hashes/sha3.js";
import {
  getAddress,
  encodeFunctionData,
  erc20Abi,
  serializeTransaction,
  keccak256,
  type Address,
  type TransactionSerializableEIP1559,
} from "viem";

export const NEAR_MPC_ROOT_KEY_TESTNET =
  "secp256k1:4NfTiv3UsGahebgTaHyD9vF8KYKMBnfd6kh94mK6xv8fGBiJB8TBtFMP5WWXz6B89Ac1fbpzPwAvoyQebemHFwx3";

function bytesToHex(bytes: Uint8Array | number[]): string {
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

function hexToBytes(hex: string): Uint8Array {
  const clean = hex.startsWith("0x") ? hex.slice(2) : hex;
  const len = clean.length;
  const out = new Uint8Array(len / 2);
  for (let i = 0; i < len; i += 2) {
    out[i / 2] = parseInt(clean.substring(i, i + 2), 16);
  }
  return out;
}

export const BASE_SEPOLIA_CHAIN_ID = 84532;
export const BASE_SEPOLIA_USDC: Address = "0x036CbD53842c5426634e7929541eC2318f3dCF7e";
export const BASE_SEPOLIA_RPC = "https://sepolia.base.org";
export const BASE_SEPOLIA_EXPLORER = "https://sepolia.basescan.org";

export interface DerivedForeignVault {
  address: Address;
  uncompressedPubKey: string;
  path: string;
  chainId: number;
}

/**
 * Deterministically derives the MPC EVM vault address on Base Sepolia
 * for a given NEAR account and deal ID.
 */
export function deriveForeignVaultAddress(
  accountId: string,
  dealId: string | number,
  rootPublicKeyStr: string = NEAR_MPC_ROOT_KEY_TESTNET
): DerivedForeignVault {
  const path = `deal-${dealId}`;
  const pk = utils.PublicKey.fromString(rootPublicKeyStr);
  const hex = "04" + bytesToHex(pk.data);
  const rootPoint = secp256k1.Point.fromHex(hex);

  const derivationInput = `near-mpc-recovery v0.1.0 epsilon derivation:${accountId},${path}`;
  const tweakBytes = sha3_256(new TextEncoder().encode(derivationInput));
  const tweakScalar = BigInt("0x" + bytesToHex(tweakBytes));

  const tweakPoint = secp256k1.Point.BASE.multiply(tweakScalar);
  const derivedPoint = rootPoint.add(tweakPoint);

  const derivedHex = derivedPoint.toHex(false);
  const pubKeyBytesNoPrefix = hexToBytes(derivedHex.slice(2));
  const hash = keccak_256(pubKeyBytesNoPrefix);
  const rawAddress = "0x" + bytesToHex(hash.subarray(12));

  return {
    address: getAddress(rawAddress),
    uncompressedPubKey: derivedHex,
    path,
    chainId: BASE_SEPOLIA_CHAIN_ID,
  };
}

export function computeForeignTransferSighash(params: {
  recipient: string;
  amountAtomic: bigint;
  nonce: number;
  tokenAddress?: string;
  chainId?: number;
}): { tx: TransactionSerializableEIP1559; sighash: `0x${string}`; sighashBytes: number[] } {
  const token = (params.tokenAddress || BASE_SEPOLIA_USDC) as Address;
  const data = encodeFunctionData({
    abi: erc20Abi,
    functionName: "transfer",
    args: [getAddress(params.recipient), params.amountAtomic],
  });

  const tx: TransactionSerializableEIP1559 = {
    chainId: params.chainId ?? BASE_SEPOLIA_CHAIN_ID,
    to: token,
    data,
    nonce: params.nonce,
    maxFeePerGas: BigInt(1_500_000_000), // 1.5 gwei
    maxPriorityFeePerGas: BigInt(1_000_000), // 0.001 gwei
    gas: BigInt(65_000),
    type: "eip1559",
  };

  const serialized = serializeTransaction(tx);
  const sighash = keccak256(serialized);
  const sighashBytes = Array.from(hexToBytes(sighash.slice(2)));

  return { tx, sighash, sighashBytes };
}
