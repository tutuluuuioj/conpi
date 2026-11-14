import { Buffer } from "buffer";
if (typeof window !== "undefined") {
  (window as any).Buffer = (window as any).Buffer || Buffer;
}
import { setupWalletSelector, WalletSelector, AccountState } from "@near-wallet-selector/core";
import { setupModal, WalletSelectorModal } from "@near-wallet-selector/modal-ui";
import { setupMyNearWallet } from "@near-wallet-selector/my-near-wallet";
import { setupMeteorWallet } from "@near-wallet-selector/meteor-wallet";
import { setupHereWallet } from "@near-wallet-selector/here-wallet";
import { transactions } from "near-api-js";
import { CONTRACT_ID } from "./chain";
import { PRIMARY_NEAR_RPC } from "./rpc-endpoints";

let selectorPromise: Promise<{ selector: WalletSelector; modal: WalletSelectorModal }> | null = null;

export async function getWalletSelector() {
  if (typeof window === "undefined") return null;

  if (!selectorPromise) {
    selectorPromise = (async () => {
      const selector = await setupWalletSelector({
        network: {
          networkId: "testnet",
          nodeUrl: PRIMARY_NEAR_RPC,
          helperUrl: "https://helper.testnet.near.org",
          explorerUrl: "https://testnet.nearblocks.io",
          indexerUrl: "https://testnet-api.kitwallet.app",
        },
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
  try {
    const ws = await getWalletSelector();
    if (!ws) return;
    const state = ws.selector.store.getState();
    if (state.selectedWalletId || (state.accounts && state.accounts.length > 0)) {
      const wallet = await ws.selector.wallet();
      if (wallet && typeof wallet.signOut === "function") {
        await wallet.signOut();
      }
    }
  } catch (err) {
    console.warn("disconnectWallet notice:", err);
  }
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
  const walletId = state.selectedWalletId || "browser-account-wallet";
  const wallet = await ws.selector.wallet(walletId);

  if (!state.accounts.length) {
    await wallet.signIn({ contractId: receiverId } as any);
  }

  let jsonString = JSON.stringify(args);
  if (args.payload && (args.payload as any)._raw_issued_at) {
    const rawVal = String((args.payload as any)._raw_issued_at);
    delete (args.payload as any)._raw_issued_at;
    jsonString = JSON.stringify(args).replace(/"issued_at":\s*"?\d+"?/, `"issued_at": ${rawVal}`);
  }
  const argsBytes = Buffer.from(jsonString);
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
  else if (cvmPayload.kind === 5 || cvmPayload.kind === "ForeignDeposit") kindStr = "ForeignDeposit";

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

  const rawIssued = cvmPayload.issuedAtNs ?? cvmPayload.issued_at;
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
    issued_at: Number(rawIssued),
    _raw_issued_at: rawIssued !== undefined && rawIssued !== null ? String(rawIssued) : undefined,
    foreign_tx_sighash: cvmPayload.foreign_tx_sighash || cvmPayload.foreignTxSighash || null,
  };
}

// 1. Create Deal on Escrow
export async function txCreateDeal(params: any, storageDepositYocto = "50000000000000000000000") {
  return signAndSendCall("create_deal", { params }, "100000000000000", storageDepositYocto);
}

// 1b. Register Foreign Chain Parameters (Base Sepolia USDC)
export async function txRegisterForeignChainDeal(
  dealId: number,
  chainId: number,
  vaultAddress: string,
  tokenAddress: string,
  buyerAddress: string,
  sellerAddress: string,
  foreignAmountAtomic: string
) {
  return signAndSendCall(
    "register_foreign_chain_deal",
    {
      deal_id: dealId,
      chain_id: chainId,
      vault_address: vaultAddress,
      token_address: tokenAddress,
      buyer_address: buyerAddress,
      seller_address: sellerAddress,
      foreign_amount: foreignAmountAtomic,
    },
    "50000000000000"
  );
}

export async function txConfirmForeignDeposit(dealId: number) {
  return signAndSendCall("confirm_foreign_deposit", { deal_id: dealId }, "50000000000000");
}

// 2. Accept Deal on Escrow
export async function txAcceptDeal(dealId: number, expectedHashBytes: number[]) {
  return signAndSendCall("accept_deal", { deal_id: dealId, expected_hash: expectedHashBytes }, "50000000000000");
}

// 2b. Atomic Accept & Deposit Native NEAR
export async function txAcceptAndDepositNear(dealId: number, expectedHashBytes: number[], depositYocto: string) {
  const ws = await getWalletSelector();
  if (!ws) throw new Error("Wallet selector not initialized");

  const state = ws.selector.store.getState();
  const walletId = state.selectedWalletId || "browser-account-wallet";
  const wallet = await ws.selector.wallet(walletId);

  const action1 = transactions.functionCall(
    "accept_deal",
    Buffer.from(JSON.stringify({ deal_id: dealId, expected_hash: expectedHashBytes })),
    BigInt("30000000000000"), // 30 TGas
    BigInt(0)
  );
  const action2 = transactions.functionCall(
    "deposit",
    Buffer.from(JSON.stringify({ deal_id: dealId })),
    BigInt("40000000000000"), // 40 TGas
    BigInt(depositYocto)
  );

  return wallet.signAndSendTransaction({
    receiverId: CONTRACT_ID,
    actions: [action1 as any, action2 as any],
  });
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

// 4b. Standard NEP-141 ft_transfer to Maker Vault
export async function txFtTransfer(tokenContractId: string, receiverId: string, amountRaw: string, memo = "Conpi Escrow Deposit") {
  return signAndSendCall(
    "ft_transfer",
    {
      receiver_id: receiverId,
      amount: amountRaw,
      memo,
    },
    "50000000000000",
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

// 10. Timeout Refund Foreign
export async function txTimeoutRefundForeign(
  dealId: number,
  foreignTx: {
    nonce: number;
    recipient: string;
    amount: string;
    sighash: number[];
  }
) {
  return signAndSendCall(
    "timeout_refund_foreign",
    {
      deal_id: dealId,
      foreign_tx: foreignTx,
    },
    "290000000000000" // 290 Tgas required for NEAR MPC signing promise + callback
  );
}

// 11. Claim Seller Foreign Payout
export async function txClaimSellerForeignPayout(
  dealId: number,
  foreignTx: {
    nonce: number;
    recipient: string;
    amount: string;
    sighash: number[];
  }
) {
  return signAndSendCall(
    "claim_seller_foreign_payout",
    {
      deal_id: dealId,
      foreign_tx: foreignTx,
    },
    "290000000000000" // 290 Tgas required for NEAR MPC signing promise + callback
  );
}

// 12. Set Foreign Seller Address
export async function txSetForeignSellerAddress(
  dealId: number,
  sellerAddress: string
) {
  return signAndSendCall(
    "set_foreign_seller_address",
    {
      deal_id: dealId,
      seller_address: sellerAddress,
    },
    "50000000000000"
  );
}

// 12b. Set Foreign Buyer Address
export async function txSetForeignBuyerAddress(
  dealId: number,
  buyerAddress: string
) {
  return signAndSendCall(
    "set_foreign_buyer_address",
    {
      deal_id: dealId,
      buyer_address: buyerAddress,
    },
    "50000000000000"
  );
}

// 13. Release Stage Foreign
export async function txReleaseStageForeign(
  dealId: number,
  stage: number,
  payloadDto: any,
  sigHex: string,
  foreignTx: {
    nonce: number;
    recipient: string;
    amount: string;
    sighash: number[];
  }
) {
  const formattedPayload = formatSignedPayloadForContract(payloadDto);
  const sigBytes = Array.from(Buffer.from(sigHex.replace(/^0x/, ""), "hex"));
  return signAndSendCall(
    "release_stage_foreign",
    {
      deal_id: dealId,
      stage,
      payload: formattedPayload,
      sig: sigBytes,
      foreign_tx: foreignTx,
    },
    "290000000000000" // 290 Tgas required for NEAR MPC signing promise + callback
  );
}

// 14. Settle Default Foreign
export async function txSettleDefaultForeign(
  dealId: number,
  payloadDto: any,
  sigHex: string,
  foreignTx: {
    nonce: number;
    recipient: string;
    amount: string;
    sighash: number[];
  }
) {
  const formattedPayload = formatSignedPayloadForContract(payloadDto);
  const sigBytes = Array.from(Buffer.from(sigHex.replace(/^0x/, ""), "hex"));
  return signAndSendCall(
    "settle_default_foreign",
    {
      deal_id: dealId,
      payload: formattedPayload,
      sig: sigBytes,
      foreign_tx: foreignTx,
    },
    "290000000000000" // 290 Tgas required for NEAR MPC signing promise + callback
  );
}

// 15. Record Foreign Deposit
export async function txRecordForeignDeposit(
  dealId: number,
  txHash: string,
  payloadDto: any,
  sigHex: string
) {
  const formattedPayload = formatSignedPayloadForContract(payloadDto);
  const sigBytes = Array.from(Buffer.from(sigHex.replace(/^0x/, ""), "hex"));
  return signAndSendCall(
    "record_foreign_deposit",
    {
      deal_id: dealId,
      tx_hash: txHash,
      payload: formattedPayload,
      sig: sigBytes,
    },
    "50000000000000"
  );
}

// 16. Request Auto Release
export async function txRequestAutoRelease(dealId: number) {
  return signAndSendCall(
    "request_auto_release",
    { deal_id: dealId },
    "50000000000000"
  );
}

// 17. Finalize Auto Release (Native Escrow)
export async function txFinalizeAutoRelease(dealId: number) {
  return signAndSendCall(
    "finalize_auto_release",
    { deal_id: dealId },
    "50000000000000"
  );
}

// 18. Finalize Auto Release Foreign (Base Sepolia Escrow with NEAR MPC)
export async function txFinalizeAutoReleaseForeign(
  dealId: number,
  foreignTx: {
    nonce: number;
    recipient: string;
    amount: string;
    sighash: number[];
  }
) {
  return signAndSendCall(
    "finalize_auto_release_foreign",
    {
      deal_id: dealId,
      foreign_tx: foreignTx,
    },
    "290000000000000" // 290 Tgas required for MPC signing promise + callback
  );
}

if (typeof window !== "undefined") {
  (window as any).__conpiWallet = {
    getWalletSelector,
    signAndSendCall,
    txCreateDeal,
    txRegisterForeignChainDeal,
    txConfirmForeignDeposit,
    txSetForeignSellerAddress,
    txSetForeignBuyerAddress,
    txAcceptDeal,
    txAcceptAndDepositNear,
    txDepositNear,
    txDepositFt,
    txFtTransfer,
    txActivateDeal,
    txReleaseStage,
    txReleaseStageForeign,
    txSettleDefault,
    txSettleDefaultForeign,
    txRecordForeignDeposit,
    txTimeoutRefundForeign,
    txClaimSellerForeignPayout,
    txRequestAutoRelease,
    txFinalizeAutoRelease,
    txFinalizeAutoReleaseForeign,
    txClaim,
  };
}
