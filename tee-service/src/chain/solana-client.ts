import crypto from "crypto";
import { ed25519 } from "@noble/curves/ed25519";
import {
  Connection,
  PublicKey,
  Transaction,
} from "@solana/web3.js";
import {
  createAssociatedTokenAccountInstruction,
  createTransferCheckedInstruction,
  getAssociatedTokenAddressSync,
} from "@solana/spl-token";
import { CONFIG } from "../config.js";

export interface PreparedSolanaPayout {
  messageHex: string;
  messageHashHex: string;
  recipient: string;
  amountAtomic: bigint;
  lastValidBlockHeight: number;
}

/**
 * Deal terms keep the exact wallet representation that the seller signed.
 * Solana itself accepts either a base58 public key or the equivalent 32-byte
 * hex value used by Conpi's cross-chain wallet adapter.
 */
export function publicKeyFromSolanaAddress(address: string): PublicKey {
  const bytes = /^[0-9a-f]{64}$/i.test(address)
    ? Buffer.from(address, "hex")
    : address;
  return new PublicKey(bytes);
}

export class SolanaClient {
  private readonly connection: Connection;
  private readonly mint: PublicKey;
  private readonly vault: PublicKey;

  constructor(
    rpcUrl = CONFIG.solanaRpcUrl,
    mintAddress = CONFIG.solanaUsdcMint,
    vaultAddress = CONFIG.solanaMpcVault
  ) {
    this.connection = new Connection(rpcUrl, "confirmed");
    this.mint = new PublicKey(mintAddress);
    this.vault = new PublicKey(vaultAddress);
  }

  public vaultAddress(): string {
    return this.vault.toBase58();
  }

  public vaultTokenAccount(): string {
    return getAssociatedTokenAddressSync(this.mint, this.vault).toBase58();
  }

  public async verifyCollateralDeposit(params: {
    signature: string;
    sellerAddress: string;
    amountAtomic: bigint;
  }): Promise<{ slot: number; vaultTokenAccount: string }> {
    const seller = publicKeyFromSolanaAddress(params.sellerAddress);
    const destination = getAssociatedTokenAddressSync(this.mint, this.vault);
    const status = await this.connection.getSignatureStatuses([params.signature], {
      searchTransactionHistory: true,
    });
    const txStatus = status.value[0];
    if (!txStatus || txStatus.err) throw new Error("Solana collateral transaction is missing or failed");
    if (txStatus.confirmationStatus !== "finalized") {
      throw new Error("Solana collateral transaction is not finalized yet");
    }

    const tx = await this.connection.getParsedTransaction(params.signature, {
      commitment: "finalized",
      maxSupportedTransactionVersion: 0,
    });
    if (!tx || tx.meta?.err) throw new Error("Solana collateral transaction could not be verified");
    const sellerSigned = tx.transaction.message.accountKeys.some(
      (item) => item.signer && item.pubkey.equals(seller)
    );
    if (!sellerSigned) throw new Error("Solana collateral transaction was not signed by the deal seller");

    const matchingTransfers = tx.transaction.message.instructions.filter((instruction: any) => {
      const parsed = instruction?.parsed;
      const info = parsed?.info;
      if (!parsed || parsed.type !== "transferChecked" || !info) return false;
      const rawAmount = info.tokenAmount?.amount ?? info.amount;
      return String(info.mint || "") === this.mint.toBase58()
        && String(info.authority || "") === seller.toBase58()
        && String(info.destination || "") === destination.toBase58()
        && String(rawAmount || "") === params.amountAtomic.toString();
    });
    if (matchingTransfers.length !== 1) {
      throw new Error("Solana transaction does not contain exactly one matching USDC collateral transfer");
    }
    return { slot: tx.slot, vaultTokenAccount: destination.toBase58() };
  }

  public async prepareUsdcPayout(params: {
    recipient: string;
    amountAtomic: bigint;
  }): Promise<PreparedSolanaPayout> {
    if (params.amountAtomic <= 0n) throw new Error("Solana payout amount must be positive");
    const recipient = publicKeyFromSolanaAddress(params.recipient);
    const source = getAssociatedTokenAddressSync(this.mint, this.vault);
    const destination = getAssociatedTokenAddressSync(this.mint, recipient);
    const tx = new Transaction();
    const destinationInfo = await this.connection.getAccountInfo(destination, "confirmed");
    if (!destinationInfo) {
      tx.add(createAssociatedTokenAccountInstruction(
        this.vault,
        destination,
        recipient,
        this.mint
      ));
    }
    tx.add(createTransferCheckedInstruction(
      source,
      this.mint,
      destination,
      this.vault,
      params.amountAtomic,
      6
    ));
    const { blockhash, lastValidBlockHeight } = await this.connection.getLatestBlockhash("confirmed");
    tx.feePayer = this.vault;
    tx.recentBlockhash = blockhash;
    const message = Buffer.from(tx.serializeMessage());
    return {
      messageHex: message.toString("hex"),
      messageHashHex: crypto.createHash("sha256").update(message).digest("hex"),
      // The NEAR contract compares this field with the seller address locked
      // in the deal. Preserve that exact representation (hex or base58), even
      // though the transaction itself uses the canonical PublicKey above.
      recipient: params.recipient,
      amountAtomic: params.amountAtomic,
      lastValidBlockHeight,
    };
  }

  public async broadcastSignedMessage(params: {
    messageHex: string;
    signatureHex: string;
    lastValidBlockHeight: number;
  }): Promise<{ signature: string }> {
    const message = Buffer.from(params.messageHex, "hex");
    const signature = Buffer.from(params.signatureHex, "hex");
    if (signature.length !== 64) throw new Error("MPC Solana signature must be 64 bytes");
    if (!ed25519.verify(signature, message, this.vault.toBytes())) {
      throw new Error("MPC signature does not match the configured Solana vault");
    }
    const currentHeight = await this.connection.getBlockHeight("confirmed");
    if (currentHeight > params.lastValidBlockHeight) {
      throw new Error("Solana payout blockhash expired before broadcast");
    }
    // A legacy Solana transaction starts with compact-u16 signature count.
    // This transaction has exactly one signer: the Chain Signatures vault.
    const raw = Buffer.concat([Buffer.from([1]), signature, message]);
    const txSignature = await this.connection.sendRawTransaction(raw, {
      skipPreflight: false,
      maxRetries: 5,
      preflightCommitment: "confirmed",
    });
    // The NEAR contract advances the payout stage immediately after this
    // method returns.  A merely-confirmed Solana transaction can still be
    // rolled back, so wait for finality before permitting that accounting
    // transition.
    const confirmation = await this.connection.confirmTransaction(txSignature, "finalized");
    if (confirmation.value.err) {
      throw new Error(`Solana payout failed: ${JSON.stringify(confirmation.value.err)}`);
    }
    return { signature: txSignature };
  }
}

export const solanaClient = new SolanaClient();
