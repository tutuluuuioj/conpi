import { PublicKey } from "near-api-js";
import { secp256k1 } from "@noble/curves/secp256k1";
import { sha3_256, keccak_256 } from "@noble/hashes/sha3";
import {
  getAddress,
  encodeFunctionData,
  erc20Abi,
  serializeTransaction,
  keccak256,
  recoverAddress,
  type Address,
  type Hash,
  type Hex,
  type TransactionSerializableEIP1559,
} from "viem";
import { BASE_SEPOLIA_CHAIN_ID, BASE_SEPOLIA_USDC } from "./base-client.js";

export const NEAR_MPC_ROOT_KEY_TESTNET =
  "secp256k1:4NfTiv3UsGahebgTaHyD9vF8KYKMBnfd6kh94mK6xv8fGBiJB8TBtFMP5WWXz6B89Ac1fbpzPwAvoyQebemHFwx3";

export interface DerivedVault {
  address: Address;
  uncompressedPubKey: string;
  path: string;
}

export interface PreparedForeignTx {
  tx: TransactionSerializableEIP1559;
  sighash: Hash;
  serializedUnsigned: Hex;
}

export class ForeignVaultManager {
  private rootKeyStr: string;

  constructor(rootKeyStr: string = NEAR_MPC_ROOT_KEY_TESTNET) {
    this.rootKeyStr = rootKeyStr;
  }

  /**
   * Deterministically derives the MPC EVM vault address on Base Sepolia
   * for a given NEAR account and deal ID.
   */
  public deriveVaultAddress(accountId: string, dealId: number): DerivedVault {
    const path = `deal-${dealId}`;
    const pk = PublicKey.fromString(this.rootKeyStr);
    const hex = "04" + Buffer.from(pk.data).toString("hex");
    const rootPoint = secp256k1.Point.fromHex(hex);

    const derivationInput = `near-mpc-recovery v0.1.0 epsilon derivation:${accountId},${path}`;
    const tweakBytes = sha3_256(new TextEncoder().encode(derivationInput));
    const tweakScalar = BigInt("0x" + Buffer.from(tweakBytes).toString("hex"));

    const tweakPoint = secp256k1.Point.BASE.multiply(tweakScalar);
    const derivedPoint = rootPoint.add(tweakPoint);

    const derivedHex = derivedPoint.toHex(false);
    const pubKeyBytesNoPrefix = Buffer.from(derivedHex.slice(2), "hex");
    const hash = keccak_256(pubKeyBytesNoPrefix);
    const rawAddress = "0x" + Buffer.from(hash.subarray(12)).toString("hex");

    return {
      address: getAddress(rawAddress),
      uncompressedPubKey: derivedHex,
      path,
    };
  }

  /**
   * Prepares an EIP-1559 USDC transfer transaction from the vault to recipient.
   */
  public buildErc20TransferTx(params: {
    recipient: Address;
    amountAtomic: bigint;
    nonce: number;
    tokenAddress?: Address;
    maxFeePerGas?: bigint;
    maxPriorityFeePerGas?: bigint;
    gasLimit?: bigint;
  }): PreparedForeignTx {
    const token = params.tokenAddress || BASE_SEPOLIA_USDC;
    const data = encodeFunctionData({
      abi: erc20Abi,
      functionName: "transfer",
      args: [getAddress(params.recipient), params.amountAtomic],
    });

    const tx: TransactionSerializableEIP1559 = {
      chainId: BASE_SEPOLIA_CHAIN_ID,
      to: token,
      data,
      nonce: params.nonce,
      maxFeePerGas: params.maxFeePerGas ?? 1_500_000_000n, // 1.5 gwei
      maxPriorityFeePerGas: params.maxPriorityFeePerGas ?? 1_000_000n, // 0.001 gwei
      gas: params.gasLimit ?? 65_000n,
      type: "eip1559",
    };

    const serializedUnsigned = serializeTransaction(tx);
    const sighash = keccak256(serializedUnsigned);

    return {
      tx,
      sighash,
      serializedUnsigned,
    };
  }

  /**
   * Normalizes NEAR MPC r and s hex strings to exact 32-byte (64-char) scalars.
   * Strips the 1-byte 02/03 prefix from NEAR MPC compressed elliptic curve affine points.
   */
  public normalizeRS(sig: { rHex: string; sHex: string }): { r: Hex; s: Hex } {
    let cleanR = sig.rHex.replace(/^0x/, "");
    if (cleanR.length === 66) {
      cleanR = cleanR.slice(2);
    }
    const r = ("0x" + cleanR.padStart(64, "0")) as Hex;

    let cleanS = sig.sHex.replace(/^0x/, "");
    if (cleanS.length === 66) {
      cleanS = cleanS.slice(2);
    }
    const s = ("0x" + cleanS.padStart(64, "0")) as Hex;

    return { r, s };
  }

  /**
   * Serializes an EIP-1559 transaction using the ECDSA signature components from NEAR MPC.
   */
  public assembleSignedTransaction(
    tx: TransactionSerializableEIP1559,
    sig: { rHex: string; sHex: string; recoveryId: number }
  ): Hex {
    const { r, s } = this.normalizeRS(sig);

    return serializeTransaction(tx, {
      r,
      s,
      yParity: (sig.recoveryId % 2) as 0 | 1,
    });
  }

  /**
   * Cryptographically verifies that the MPC signature recovers to the expected vault address.
   */
  public async verifySignatureMatchesVault(
    sighash: Hash,
    sig: { rHex: string; sHex: string; recoveryId: number },
    expectedVault: Address
  ): Promise<boolean> {
    try {
      const { r, s } = this.normalizeRS(sig);

      const recovered = await recoverAddress({
        hash: sighash,
        signature: {
          r,
          s,
          yParity: (sig.recoveryId % 2) as 0 | 1,
        },
      });

      return getAddress(recovered) === getAddress(expectedVault);
    } catch {
      return false;
    }
  }
}

export const foreignVaultManager = new ForeignVaultManager();
