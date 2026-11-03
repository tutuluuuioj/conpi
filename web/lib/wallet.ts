import { setupWalletSelector, WalletSelector, AccountState } from "@near-wallet-selector/core";
import { setupModal, WalletSelectorModal } from "@near-wallet-selector/modal-ui";
import { setupMyNearWallet } from "@near-wallet-selector/my-near-wallet";
import { setupMeteorWallet } from "@near-wallet-selector/meteor-wallet";
import { setupHereWallet } from "@near-wallet-selector/here-wallet";
import { transactions } from "near-api-js";
import { CONTRACT_ID } from "./chain";

let selectorPromise: Promise<{ selector: WalletSelector; modal: WalletSelectorModal }> | null = null;

export async function getWalletSelector() {
  if (typeof window === "undefined") return null;

  if (!selectorPromise) {
    selectorPromise = (async () => {
      const selector = await setupWalletSelector({
        network: "testnet",
        modules: [
          setupMyNearWallet(),
          setupMeteorWallet(),
          setupHereWallet(),
        ],
      });

      const modal = setupModal(selector, {
        contractId: CONTRACT_ID,
        description: "Connect your testnet wallet to escrow funds, sign payloads, and settle deals securely on Conpi.",
      });

      return { selector, modal };
    })();
  }

  return selectorPromise;
}

export async function connectWalletModal() {
  const ws = await getWalletSelector();
  if (ws) {
    ws.modal.show();
  }
}

export async function disconnectWallet() {
  const ws = await getWalletSelector();
  if (!ws) return;
  const wallet = await ws.selector.wallet();
  await wallet.signOut();
}

export async function signAndSendCall(
  methodName: string,
  args: Record<string, any>,
  gas = "50000000000000", // 50 TGas
  deposit = "0",
  receiverId = CONTRACT_ID
) {
  const ws = await getWalletSelector();
  if (!ws) throw new Error("Wallet selector not initialized");

  const state = ws.selector.store.getState();
  if (!state.accounts.length) {
    ws.modal.show();
    throw new Error("Please connect your wallet first");
  }

  const wallet = await ws.selector.wallet();
  const argsBytes = Buffer.from(JSON.stringify(args));
  const action = transactions.functionCall(
    methodName,
    argsBytes,
    BigInt(gas),
    BigInt(deposit)
  );

  const outcome = await wallet.signAndSendTransaction({
    receiverId,
    actions: [action as any],
  });

  return outcome;
}

// 1. Create Deal on Escrow
export async function txCreateDeal(params: any, storageDepositYocto = "50000000000000000000000") {
  return signAndSendCall("create_deal", { params }, "100000000000000", storageDepositYocto);
}

// 2. Deposit Native NEAR for Deal
export async function txDepositNear(dealId: number, depositYocto: string) {
  return signAndSendCall("deposit", { deal_id: dealId }, "50000000000000", depositYocto);
}

// 3. Deposit Fungible Token (USDC / USDT) via ft_transfer_call
export async function txDepositFt(tokenContractId: string, dealId: number, amountRaw: string) {
  return signAndSendCall(
    "ft_transfer_call",
    {
      receiver_id: CONTRACT_ID,
      amount: amountRaw,
      msg: JSON.stringify({ deal_id: dealId }),
    },
    "100000000000000",
    "1", // 1 yocto attached for security
    tokenContractId
  );
}

// 4. Activate Deal with TEE Signed Payload
export async function txActivateDeal(dealId: number, payload: any, sigHex: string) {
  const sigBytes = Array.from(Buffer.from(sigHex, "hex"));
  return signAndSendCall("activate", { deal_id: dealId, payload, sig: sigBytes }, "50000000000000");
}

// 5. Release Stage with TEE Signed Payload
export async function txReleaseStage(dealId: number, stage: number, payload: any, sigHex: string) {
  const sigBytes = Array.from(Buffer.from(sigHex, "hex"));
  return signAndSendCall(
    "release_stage",
    { deal_id: dealId, stage, payload, sig: sigBytes },
    "50000000000000"
  );
}

// 6. Settle Default with TEE Signed Payload
export async function txSettleDefault(dealId: number, payload: any, sigHex: string) {
  const sigBytes = Array.from(Buffer.from(sigHex, "hex"));
  return signAndSendCall(
    "settle_default",
    { deal_id: dealId, payload, sig: sigBytes },
    "50000000000000"
  );
}

// 7. Claim Payouts
export async function txClaim(token: string | null = null) {
  return signAndSendCall("claim", { token }, "50000000000000");
}
