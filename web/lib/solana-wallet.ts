import {
  Connection,
  PublicKey,
  Transaction,
} from "@solana/web3.js";
import {
  getAssociatedTokenAddressSync,
  createAssociatedTokenAccountInstruction,
  createTransferCheckedInstruction,
} from "@solana/spl-token";
import { Buffer } from "buffer";

export const SOLANA_DEVNET_RPC = process.env.NEXT_PUBLIC_SOLANA_RPC || "https://api.devnet.solana.com";
export const SOLANA_DEVNET_USDC_MINT = "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU"; // Official Devnet USDC mint
export const SOLANA_DEVNET_EXPLORER = "https://explorer.solana.com";

export function isPhantomInstalled(): boolean {
  if (typeof window === "undefined") return false;
  return Boolean((window as any).phantom?.solana?.isPhantom || (window as any).solana?.isPhantom);
}

export function isSolflareInstalled(): boolean {
  if (typeof window === "undefined") return false;
  return Boolean((window as any).solflare?.isSolflare);
}

export function getSolanaProvider(walletName?: "Phantom" | "Solflare" | "Injected"): any | null {
  if (typeof window === "undefined") return null;

  if (walletName === "Phantom") {
    return (window as any).phantom?.solana || ((window as any).solana?.isPhantom ? (window as any).solana : null);
  }

  if (walletName === "Solflare") {
    return (window as any).solflare || null;
  }

  return (
    (window as any).phantom?.solana ||
    (window as any).solflare ||
    (window as any).solana ||
    null
  );
}

export async function connectSolanaWallet(walletName?: "Phantom" | "Solflare" | "Injected"): Promise<{
  address: string;
  walletName: string;
}> {
  const provider = getSolanaProvider(walletName);
  if (!provider) {
    throw new Error(
      walletName
        ? `${walletName} wallet not detected. Please install the ${walletName} browser extension.`
        : "No Solana wallet detected. Please install Phantom or Solflare."
    );
  }

  try {
    const resp = await provider.connect();
    const pubkey = resp?.publicKey || provider.publicKey;
    if (!pubkey) {
      throw new Error("Solana wallet connected but did not provide a public key.");
    }
    const address = pubkey.toString();
    const detectedName = provider.isPhantom ? "Phantom" : provider.isSolflare ? "Solflare" : "Solana";

    if (typeof window !== "undefined") {
      try {
        localStorage.setItem("conpi_solana_address", address);
        localStorage.setItem("conpi_solana_wallet", detectedName);
      } catch {}
    }

    return { address, walletName: detectedName };
  } catch (err: any) {
    if (err?.code === 4001) {
      throw new Error("Connection request was rejected by the user in Solana wallet.");
    }
    throw new Error(err?.message || "Failed to connect Solana wallet");
  }
}

export async function disconnectSolanaWallet(): Promise<void> {
  const provider = getSolanaProvider();
  if (provider && typeof provider.disconnect === "function") {
    try {
      await provider.disconnect();
    } catch {}
  }
  if (typeof window !== "undefined") {
    try {
      localStorage.removeItem("conpi_solana_address");
      localStorage.removeItem("conpi_solana_wallet");
    } catch {}
  }
}

export async function getSolanaBalance(addressStr: string): Promise<string> {
  try {
    const res = await fetch(SOLANA_DEVNET_RPC, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: `sol_bal_${Date.now()}`,
        method: "getBalance",
        params: [addressStr],
      }),
    });
    const json = await res.json();
    const lamports = json.result?.value ?? 0;
    return (Number(lamports) / 1e9).toFixed(4);
  } catch (err) {
    console.warn("getSolanaBalance error:", err);
    return "0.0000";
  }
}

export async function getSolanaUsdcBalance(addressStr: string): Promise<string> {
  try {
    const res = await fetch(SOLANA_DEVNET_RPC, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: `sol_usdc_${Date.now()}`,
        method: "getTokenAccountsByOwner",
        params: [
          addressStr,
          { mint: SOLANA_DEVNET_USDC_MINT },
          { encoding: "jsonParsed" },
        ],
      }),
    });
    const json = await res.json();
    const accounts = json.result?.value;
    if (!accounts || !accounts.length) return "0.00";
    const balance = accounts[0].account?.data?.parsed?.info?.tokenAmount?.uiAmountString;
    return balance || "0.00";
  } catch {
    return "0.00";
  }
}

/**
 * Creates the seller's domain-separated acceptance signature for a NEAR
 * escrow deal. It is intentionally a wallet message rather than a Solana
 * transaction, because the NEAR contract verifies it before accepting the
 * cross-chain counterparty.
 */
export async function signSolanaDealAcceptance(params: {
  contractId: string;
  network: string;
  dealId: number;
  termsHashHex: string;
  vaultAddress: string;
  tokenMint: string;
  sellerCollateralAtomic: string;
  sellerCanonicalAddress?: string;
}): Promise<{
  sellerAddress: string;
  publicKeyBase58: string;
  nonce: number;
  expiresAtNs: string;
  signatureBase64: string;
}> {
  const provider = getSolanaProvider();
  if (!provider) throw new Error("No Solana wallet found. Please connect Phantom or Solflare.");
  if (!provider.publicKey) await provider.connect();
  const sellerAddress = provider.publicKey?.toString();
  if (!sellerAddress || typeof provider.signMessage !== "function") {
    throw new Error("The connected Solana wallet cannot sign the deal acceptance message.");
  }
  const nonce = Date.now();
  const expiresAtNs = (BigInt(Date.now() + 5 * 60_000) * BigInt(1_000_000)).toString();
  const termsHashHex = params.termsHashHex.replace(/^0x/, "").toLowerCase();
  const message = [
    "CONPI_SOLANA_ACCEPT_V1",
    `contract:${params.contractId}`,
    `network:${params.network}`,
    `deal:${params.dealId}`,
    `terms:${termsHashHex}`,
    `seller:${params.sellerCanonicalAddress || sellerAddress}`,
    `vault:${params.vaultAddress}`,
    `mint:${params.tokenMint}`,
    `collateral:${params.sellerCollateralAtomic}`,
    `nonce:${nonce}`,
    `expires_at:${expiresAtNs}`,
  ].join("\n");
  const signed = await provider.signMessage(new TextEncoder().encode(message), "utf8");
  const signature = signed?.signature || signed;
  if (!signature) throw new Error("Solana deal acceptance was cancelled.");
  return {
    sellerAddress,
    publicKeyBase58: sellerAddress,
    nonce,
    expiresAtNs,
    signatureBase64: Buffer.from(signature).toString("base64"),
  };
}

/**
 * 1-Click Pay: Builds an SPL-Token transfer transaction on Solana Devnet,
 * prompts the user's connected Solana wallet (Phantom / Solflare), broadcasts it,
 * waits for on-chain confirmation, and returns the transaction signature.
 */
export async function sendSolanaUsdcDeposit(params: {
  vaultAddress: string;
  amountUsdc: number | string;
}): Promise<{ txHash: string }> {
  const provider = getSolanaProvider();
  if (!provider) {
    throw new Error("No Solana wallet found. Please install Phantom or Solflare.");
  }

  // Ensure provider is connected
  if (!provider.publicKey) {
    try {
      await provider.connect();
    } catch (cErr: any) {
      if (cErr?.code === 4001) throw new Error("Wallet connection was rejected.");
      throw new Error("Please connect your Solana wallet.");
    }
  }

  const senderPubkeyStr = provider.publicKey?.toString();
  if (!senderPubkeyStr) {
    throw new Error("Solana wallet public key not available.");
  }

  const senderPubkey = new PublicKey(senderPubkeyStr);
  const vaultPubkey = new PublicKey(params.vaultAddress);
  const mintPubkey = new PublicKey(SOLANA_DEVNET_USDC_MINT);

  const amountNum = typeof params.amountUsdc === "string" ? parseFloat(params.amountUsdc) : params.amountUsdc;
  if (isNaN(amountNum) || amountNum <= 0) {
    throw new Error("Invalid deposit amount.");
  }
  const amountAtomic = BigInt(Math.round(amountNum * 1e6));

  const connection = new Connection(SOLANA_DEVNET_RPC, "confirmed");

  const senderAta = getAssociatedTokenAddressSync(mintPubkey, senderPubkey);
  const vaultAta = getAssociatedTokenAddressSync(mintPubkey, vaultPubkey);

  const tx = new Transaction();

  // Check if Vault ATA exists (if not, add creation instruction)
  try {
    const vaultAtaInfo = await connection.getAccountInfo(vaultAta);
    if (!vaultAtaInfo) {
      tx.add(
        createAssociatedTokenAccountInstruction(
          senderPubkey,
          vaultAta,
          vaultPubkey,
          mintPubkey
        )
      );
    }
  } catch (ataErr) {
    console.warn("Notice checking vault ATA:", ataErr);
  }

  // Add SPL-Token transfer instruction
  tx.add(
    createTransferCheckedInstruction(
      senderAta,
      mintPubkey,
      vaultAta,
      senderPubkey,
      amountAtomic,
      6
    )
  );

  const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash("confirmed");
  tx.recentBlockhash = blockhash;
  tx.feePayer = senderPubkey;

  let signature = "";
  try {
    if (typeof provider.signAndSendTransaction === "function") {
      const res = await provider.signAndSendTransaction(tx);
      signature = typeof res === "string" ? res : res?.signature || "";
    } else if (typeof provider.signTransaction === "function") {
      const signed = await provider.signTransaction(tx);
      signature = await connection.sendRawTransaction(signed.serialize());
    } else {
      throw new Error("Connected Solana wallet does not support signing transactions.");
    }
  } catch (signErr: any) {
    if (signErr?.code === 4001 || signErr?.message?.includes("User rejected")) {
      throw new Error("Transaction cancelled in Solana wallet.");
    }
    throw new Error(signErr?.message || "Failed to sign Solana transaction.");
  }

  if (!signature) {
    throw new Error("No transaction signature returned from Solana wallet.");
  }

  // Wait for confirmation
  try {
    await connection.confirmTransaction(
      {
        signature,
        blockhash,
        lastValidBlockHeight,
      },
      "confirmed"
    );
  } catch (confErr) {
    console.warn("Solana transaction confirmation notice:", confErr);
  }

  return { txHash: signature };
}
