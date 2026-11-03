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

/**
 * Converts a TEE CVM payload (camelCase / hex) to the exact Borsh/JSON SignedPayload
 * struct expected by the NEAR smart contract.
 */
export function formatSignedPayloadForContract(cvmPayload: any) {
  let termsHashArr: number[];
  if (cvmPayload.termsHashHex) {
    const cleanHex = cvmPayload.termsHashHex.replace(/^0x/, "");
    termsHashArr = Array.from(Buffer.from(cleanHex, "hex"));
  } else if (Array.isArray(cvmPayload.terms_hash)) {
    termsHashArr = cvmPayload.terms_hash;
  } else if (Array.isArray(cvmPayload.termsHash)) {
    termsHashArr = cvmPayload.termsHash;
  } else {
    termsHashArr = new Array(32).fill(0);
  }

  let kindStr = "Activate";
  if (cvmPayload.kind === 0 || cvmPayload.kind === "Terms") kindStr = "Terms";
  else if (cvmPayload.kind === 1 || cvmPayload.kind === "Activate") kindStr = "Activate";
  else if (cvmPayload.kind === 2 || cvmPayload.kind === "Stage") kindStr = "Stage";
  else if (cvmPayload.kind === 3 || cvmPayload.kind === "Checkpoint") kindStr = "Checkpoint";
  else if (cvmPayload.kind === 4 || cvmPayload.kind === "Default") kindStr = "Default";

  const REASONS = [
    "InvalidKey",
    "InsufficientQuota",
    "KeyNotSubmitted",
    "ValidationFailed",
    "ProviderBan",
    "SellerSelfDrain",
    "BuyerBreach",
  ];
  let reasonVal: string | null = null;
  if (cvmPayload.reason !== null && cvmPayload.reason !== undefined) {
    if (typeof cvmPayload.reason === "number" && REASONS[cvmPayload.reason]) {
      reasonVal = REASONS[cvmPayload.reason];
    } else if (typeof cvmPayload.reason === "string") {
      reasonVal = cvmPayload.reason;
    }
  }

  return {
    domain: cvmPayload.domain || "conpi:v1",
    contract_id: cvmPayload.contractId || cvmPayload.contract_id || CONTRACT_ID,
    chain_id: cvmPayload.chainId || cvmPayload.chain_id || "testnet",
    deal_id: Number(cvmPayload.dealId ?? cvmPayload.deal_id),
    terms_hash: termsHashArr,
    kind: kindStr,
    stage: Number(cvmPayload.stage || 0),
    metered_value: String(cvmPayload.meteredValueYocto ?? cvmPayload.metered_value ?? "0"),
    reason: reasonVal,
    nonce: Number(cvmPayload.nonce),
    issued_at: Number(cvmPayload.issuedAtNs ?? cvmPayload.issued_at),
  };
}

// 1. Create Deal on Escrow
export async function txCreateDeal(params: any, storageDepositYocto = "50000000000000000000000") {
  return signAndSendCall("create_deal", { params }, "100000000000000", storageDepositYocto);
}

// 2. Accept Deal on Escrow
export async function txAcceptDeal(dealId: number, expectedHashBytes: number[]) {
  return signAndSendCall("accept_deal", { deal_id: dealId, expected_hash: expectedHashBytes }, "50000000000000");
}

// 3. Deposit Native NEAR for Deal
export async function txDepositNear(dealId: number, depositYocto: string) {
  return signAndSendCall("deposit", { deal_id: dealId }, "50000000000000", depositYocto);
}

// 4. Deposit Fungible Token (USDC / USDT) via ft_transfer_call
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

// 5. FT Storage Deposit (register receiver on NEP-141 token)
export async function txStorageDeposit(tokenContractId: string, accountId: string = CONTRACT_ID, depositNear = "0.00125") {
  const depositYocto = (BigInt(Math.round(parseFloat(depositNear) * 1e6)) * BigInt(1e18)).toString();
  return signAndSendCall(
    "storage_deposit",
    { account_id: accountId, registration_only: true },
    "30000000000000",
    depositYocto,
    tokenContractId
  );
}

// 6. Activate Deal with TEE Signed Payload
export async function txActivateDeal(dealId: number, payload: any, sigHex: string) {
  const formattedPayload = formatSignedPayloadForContract(payload);
  const sigBytes = Array.from(Buffer.from(sigHex, "hex"));
  return signAndSendCall("activate", { deal_id: dealId, payload: formattedPayload, sig: sigBytes }, "50000000000000");
}

// 7. Release Stage with TEE Signed Payload
export async function txReleaseStage(dealId: number, stage: number, payload: any, sigHex: string) {
  const formattedPayload = formatSignedPayloadForContract(payload);
  const sigBytes = Array.from(Buffer.from(sigHex, "hex"));
  return signAndSendCall(
    "release_stage",
    { deal_id: dealId, stage, payload: formattedPayload, sig: sigBytes },
    "50000000000000"
  );
}

// 8. Settle Default with TEE Signed Payload
export async function txSettleDefault(dealId: number, payload: any, sigHex: string) {
  const formattedPayload = formatSignedPayloadForContract(payload);
  const sigBytes = Array.from(Buffer.from(sigHex, "hex"));
  return signAndSendCall(
    "settle_default",
    { deal_id: dealId, payload: formattedPayload, sig: sigBytes },
    "50000000000000"
  );
}

// 9. Claim Payouts
export async function txClaim(token: string | null = null) {
  return signAndSendCall("claim", { token }, "50000000000000");
}
