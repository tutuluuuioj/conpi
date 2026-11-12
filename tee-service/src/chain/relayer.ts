import { CONFIG } from "../config.js";
import { Account, JsonRpcProvider, KeyPairSigner } from "near-api-js";
import { foreignRelayer } from "./foreign-relayer.js";

export class NearRelayer {
  private rpcUrl: string;
  private relayerAccountId: string | null;
  private relayerPrivateKey: string | null;

  constructor() {
    this.rpcUrl = CONFIG.nodeUrl;
    this.relayerAccountId = process.env.RELAYER_ACCOUNT_ID || null;
    this.relayerPrivateKey = process.env.RELAYER_PRIVATE_KEY || null;
  }

  public setRelayerCredentials(accountId: string, privateKey: string) {
    this.relayerAccountId = accountId;
    this.relayerPrivateKey = privateKey;
  }

  public isConfigured(): boolean {
    return Boolean(this.relayerAccountId && this.relayerPrivateKey);
  }

  public async callView(methodName: string, args: Record<string, any> = {}): Promise<any> {
    const argsBase64 = Buffer.from(JSON.stringify(args)).toString("base64");
    const response = await fetch(this.rpcUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: "conpi-tee-view",
        method: "query",
        params: {
          request_type: "call_function",
          finality: "final",
          account_id: CONFIG.contractId,
          method_name: methodName,
          args_base64: argsBase64,
        },
      }),
    });

    const data: any = await response.json();
    if (data.error) {
      throw new Error(`RPC Error in ${methodName}: ${JSON.stringify(data.error)}`);
    }

    if (data.result && data.result.result) {
      const resultStr = Buffer.from(data.result.result).toString("utf8");
      try {
        const sanitized = resultStr.replace(/:\s*([0-9]{15,})\b/g, ':"$1"');
        return JSON.parse(sanitized);
      } catch {
        return resultStr;
      }
    }
    return null;
  }

  public async submitFunctionCall(
    methodName: string,
    args: Record<string, any>,
    gasYocto: string = "100000000000000",
    attachedDeposit: string = "0"
  ): Promise<{ transactionHash: string; status: any; receiptsOutcome?: any[] }> {
    if (!this.relayerAccountId || !this.relayerPrivateKey) {
      throw new Error("Relayer account credentials not configured (RELAYER_ACCOUNT_ID and RELAYER_PRIVATE_KEY)");
    }

    const provider = new JsonRpcProvider({ url: this.rpcUrl });
    const signer = KeyPairSigner.fromSecretKey(this.relayerPrivateKey as any);
    const account = new Account(this.relayerAccountId, provider, signer);
    const result: any = await account.callFunctionRaw({
      contractId: CONFIG.contractId,
      methodName,
      args,
      gas: BigInt(gasYocto),
      deposit: BigInt(attachedDeposit),
    });

    return {
      transactionHash: result.transaction.hash,
      status: result.status,
      receiptsOutcome: result.receipts_outcome,
    };
  }

  private extractForeignTxSignedEvent(receiptsOutcome?: any[]): any {
    if (!Array.isArray(receiptsOutcome)) return null;
    for (const receipt of receiptsOutcome) {
      const logs = receipt?.outcome?.logs || [];
      for (const log of logs) {
        if (typeof log === "string" && log.startsWith("EVENT_JSON:")) {
          try {
            const parsed = JSON.parse(log.slice("EVENT_JSON:".length));
            if (parsed.standard === "conpi" && parsed.event === "foreign_tx_signed" && (parsed.data?.[0] || parsed.data)) {
              return parsed.data?.[0] || parsed.data;
            }
            if (parsed.standard === "foreign_tx_signed" && parsed.event) {
              return parsed.event;
            }
            if (parsed.event === "foreign_tx_signed" && (parsed.data?.[0] || parsed.data)) {
              return parsed.data?.[0] || parsed.data;
            }
          } catch {}
        }
      }
    }
    return null;
  }

  private extractSolanaTxSignedEvent(receiptsOutcome?: any[]): any {
    if (!Array.isArray(receiptsOutcome)) return null;
    for (const receipt of receiptsOutcome) {
      const logs = receipt?.outcome?.logs || [];
      for (const log of logs) {
        if (typeof log !== "string" || !log.startsWith("EVENT_JSON:")) continue;
        try {
          const parsed = JSON.parse(log.slice("EVENT_JSON:".length));
          if (parsed.standard === "conpi" && parsed.event === "solana_tx_signed") {
            return parsed.data?.[0] || parsed.data || null;
          }
        } catch {
          // A malformed log cannot make the relayer trust a payout event.
        }
      }
    }
    return null;
  }

  private payloadForContract(payloadDto: any, kind: string, stage = 0, reason: string | null = null) {
    const termsHash = payloadDto.termsHash || payloadDto.termsHashHex;
    const termsHashBytes = Array.from(
      Buffer.isBuffer(termsHash) ? termsHash : Buffer.from(String(termsHash).replace(/^0x/, ""), "hex")
    );
    const sighash = payloadDto.foreignTxSighash || payloadDto.foreign_tx_sighash;
    const foreignTxSighash = !sighash
      ? null
      : Array.isArray(sighash)
        ? sighash
        : Array.from(Buffer.from(String(sighash).replace(/^0x/, ""), "hex"));
    return {
      domain: payloadDto.domain,
      contract_id: payloadDto.contractId,
      chain_id: payloadDto.chainId,
      deal_id: Number(payloadDto.dealId),
      terms_hash: termsHashBytes,
      kind,
      stage: Number(stage),
      metered_value: payloadDto.meteredValueYocto ? payloadDto.meteredValueYocto.toString() : "0",
      reason,
      nonce: Number(payloadDto.nonce),
      issued_at: Number(payloadDto.issuedAtNs),
      foreign_tx_sighash: foreignTxSighash,
    };
  }

  public async submitActivate(dealId: number, payloadDto: any, signatureHex: string) {
    const termsHashBytes = Array.from(
      Buffer.isBuffer(payloadDto.termsHash) ? payloadDto.termsHash : Buffer.from(payloadDto.termsHashHex, "hex")
    );
    const sigBytes = Array.from(Buffer.from(signatureHex, "hex"));

    const formatSighash = (val: any) => {
      if (!val) return null;
      if (Array.isArray(val)) return val;
      if (typeof val === "string") return Array.from(Buffer.from(val.replace(/^0x/, ""), "hex"));
      if (Buffer.isBuffer(val) || val instanceof Uint8Array) return Array.from(val);
      return null;
    };

    const payload = {
      domain: payloadDto.domain,
      contract_id: payloadDto.contractId,
      chain_id: payloadDto.chainId,
      deal_id: Number(dealId),
      terms_hash: termsHashBytes,
      kind: "Activate",
      stage: Number(payloadDto.stage || 0),
      metered_value: payloadDto.meteredValueYocto ? payloadDto.meteredValueYocto.toString() : "0",
      reason: null,
      nonce: Number(payloadDto.nonce),
      issued_at: Number(payloadDto.issuedAtNs),
      foreign_tx_sighash: formatSighash(payloadDto.foreignTxSighash || payloadDto.foreign_tx_sighash),
    };

    return this.submitFunctionCall("activate", {
      deal_id: dealId,
      payload,
      sig: sigBytes,
    });
  }

  public async submitReleaseStage(dealId: number, stage: number, payloadDto: any, signatureHex: string) {
    const termsHashBytes = Array.from(
      Buffer.isBuffer(payloadDto.termsHash) ? payloadDto.termsHash : Buffer.from(payloadDto.termsHashHex, "hex")
    );
    const sigBytes = Array.from(Buffer.from(signatureHex, "hex"));

    const formatSighash = (val: any) => {
      if (!val) return null;
      if (Array.isArray(val)) return val;
      if (typeof val === "string") return Array.from(Buffer.from(val.replace(/^0x/, ""), "hex"));
      if (Buffer.isBuffer(val) || val instanceof Uint8Array) return Array.from(val);
      return null;
    };

    const payload = {
      domain: payloadDto.domain,
      contract_id: payloadDto.contractId,
      chain_id: payloadDto.chainId,
      deal_id: Number(dealId),
      terms_hash: termsHashBytes,
      kind: "Stage",
      stage: Number(stage),
      metered_value: payloadDto.meteredValueYocto ? payloadDto.meteredValueYocto.toString() : "0",
      reason: null,
      nonce: Number(payloadDto.nonce),
      issued_at: Number(payloadDto.issuedAtNs),
      foreign_tx_sighash: formatSighash(payloadDto.foreignTxSighash || payloadDto.foreign_tx_sighash),
    };

    return this.submitFunctionCall("release_stage", {
      deal_id: dealId,
      stage,
      payload,
      sig: sigBytes,
    });
  }

  public async submitReleaseStageForeign(
    dealId: number,
    stage: number,
    payloadDto: any,
    signatureHex: string,
    foreignTx: { nonce: number; recipient: string; amount: bigint | string; sighashHex: string }
  ) {
    const termsHashBytes = Array.from(
      Buffer.isBuffer(payloadDto.termsHash) ? payloadDto.termsHash : Buffer.from(payloadDto.termsHashHex, "hex")
    );
    const sigBytes = Array.from(Buffer.from(signatureHex, "hex"));
    const sighashBytes = Array.from(Buffer.from(foreignTx.sighashHex.replace(/^0x/, ""), "hex"));

    const payload = {
      domain: payloadDto.domain,
      contract_id: payloadDto.contractId,
      chain_id: payloadDto.chainId,
      deal_id: Number(dealId),
      terms_hash: termsHashBytes,
      kind: "Stage",
      stage: Number(stage),
      metered_value: payloadDto.meteredValueYocto ? payloadDto.meteredValueYocto.toString() : "0",
      reason: null,
      nonce: Number(payloadDto.nonce),
      issued_at: Number(payloadDto.issuedAtNs),
      foreign_tx_sighash: sighashBytes,
    };

    const res = await this.submitFunctionCall(
      "release_stage_foreign",
      {
        deal_id: dealId,
        stage,
        payload,
        sig: sigBytes,
        foreign_tx: {
          nonce: foreignTx.nonce,
          recipient: foreignTx.recipient,
          amount: foreignTx.amount.toString(),
          sighash: sighashBytes,
        },
      },
      "290000000000000" // 290 Tgas required for NEAR MPC signing promise + callback
    );

    const ev = this.extractForeignTxSignedEvent(res.receiptsOutcome);
    if (ev) {
      try {
        await foreignRelayer.broadcastSignedPayout({
          dealId: Number(ev.deal_id),
          stage: Number(ev.stage),
          chainId: Number(ev.chain_id),
          recipient: ev.recipient as any,
          amountAtomic: BigInt(ev.amount),
          sighashHex: ev.sighash_hex.startsWith("0x") ? ev.sighash_hex : `0x${ev.sighash_hex}`,
          rHex: ev.r_hex,
          sHex: ev.s_hex,
          recoveryId: Number(ev.recovery_id),
          nonce: foreignTx.nonce,
        });
      } catch (err) {
        console.warn(`[NearRelayer] Auto-broadcast foreign stage payout warning:`, err);
      }
    }

    return res;
  }

  public async submitCheckpoint(dealId: number, payloadDto: any, signatureHex: string) {
    const termsHashBytes = Array.from(
      Buffer.isBuffer(payloadDto.termsHash) ? payloadDto.termsHash : Buffer.from(payloadDto.termsHashHex, "hex")
    );
    const sigBytes = Array.from(Buffer.from(signatureHex, "hex"));

    const payload = {
      domain: payloadDto.domain,
      contract_id: payloadDto.contractId,
      chain_id: payloadDto.chainId,
      deal_id: Number(dealId),
      terms_hash: termsHashBytes,
      kind: "Checkpoint",
      stage: Number(payloadDto.stage || 0),
      metered_value: payloadDto.meteredValueYocto ? payloadDto.meteredValueYocto.toString() : "0",
      reason: null,
      nonce: Number(payloadDto.nonce),
      issued_at: Number(payloadDto.issuedAtNs),
      foreign_tx_sighash: null,
    };

    return this.submitFunctionCall("checkpoint", {
      deal_id: dealId,
      payload,
      sig: sigBytes,
    });
  }

  public async submitSettleDefault(dealId: number, payloadDto: any, signatureHex: string) {
    const termsHashBytes = Array.from(
      Buffer.isBuffer(payloadDto.termsHash) ? payloadDto.termsHash : Buffer.from(payloadDto.termsHashHex, "hex")
    );
    const sigBytes = Array.from(Buffer.from(signatureHex, "hex"));

    // Reason name mapping
    const reasonNames: Record<number, string> = {
      0: "InvalidKey",
      1: "InsufficientQuota",
      2: "KeyNotSubmitted",
      3: "ValidationFailed",
      4: "ProviderBan",
      5: "SellerSelfDrain",
      6: "BuyerBreach",
    };
    const reasonStr = typeof payloadDto.reason === "number" ? reasonNames[payloadDto.reason] || "InvalidKey" : payloadDto.reason || "InvalidKey";

    const payload = {
      domain: payloadDto.domain,
      contract_id: payloadDto.contractId,
      chain_id: payloadDto.chainId,
      deal_id: Number(dealId),
      terms_hash: termsHashBytes,
      kind: "Default",
      stage: Number(payloadDto.stage || 0),
      metered_value: payloadDto.meteredValueYocto ? payloadDto.meteredValueYocto.toString() : "0",
      reason: reasonStr,
      nonce: Number(payloadDto.nonce),
      issued_at: Number(payloadDto.issuedAtNs),
      foreign_tx_sighash: null,
    };

    return this.submitFunctionCall("settle_default", {
      deal_id: dealId,
      payload,
      sig: sigBytes,
    });
  }

  public async submitSettleDefaultForeign(
    dealId: number,
    payloadDto: any,
    signatureHex: string,
    foreignTx: { nonce: number; recipient: string; amount: bigint | string; sighashHex: string }
  ) {
    const termsHashBytes = Array.from(
      Buffer.isBuffer(payloadDto.termsHash) ? payloadDto.termsHash : Buffer.from(payloadDto.termsHashHex, "hex")
    );
    const sigBytes = Array.from(Buffer.from(signatureHex, "hex"));
    const sighashBytes = Array.from(Buffer.from(foreignTx.sighashHex.replace(/^0x/, ""), "hex"));

    const reasonNames: Record<number, string> = {
      0: "InvalidKey",
      1: "InsufficientQuota",
      2: "KeyNotSubmitted",
      3: "ValidationFailed",
      4: "ProviderBan",
      5: "SellerSelfDrain",
      6: "BuyerBreach",
    };
    const reasonStr = typeof payloadDto.reason === "number" ? reasonNames[payloadDto.reason] || "InvalidKey" : payloadDto.reason || "InvalidKey";

    const payload = {
      domain: payloadDto.domain,
      contract_id: payloadDto.contractId,
      chain_id: payloadDto.chainId,
      deal_id: Number(dealId),
      terms_hash: termsHashBytes,
      kind: "Default",
      stage: Number(payloadDto.stage || 0),
      metered_value: payloadDto.meteredValueYocto ? payloadDto.meteredValueYocto.toString() : "0",
      reason: reasonStr,
      nonce: Number(payloadDto.nonce),
      issued_at: Number(payloadDto.issuedAtNs),
      foreign_tx_sighash: sighashBytes,
    };

    const res = await this.submitFunctionCall(
      "settle_default_foreign",
      {
        deal_id: dealId,
        payload,
        sig: sigBytes,
        foreign_tx: {
          nonce: foreignTx.nonce,
          recipient: foreignTx.recipient,
          amount: foreignTx.amount.toString(),
          sighash: sighashBytes,
        },
      },
      "290000000000000" // 290 Tgas required for NEAR MPC signing promise + callback
    );

    const ev = this.extractForeignTxSignedEvent(res.receiptsOutcome);
    if (ev) {
      try {
        await foreignRelayer.broadcastSignedPayout({
          dealId: Number(ev.deal_id),
          stage: Number(ev.stage),
          chainId: Number(ev.chain_id),
          recipient: ev.recipient as any,
          amountAtomic: BigInt(ev.amount),
          sighashHex: ev.sighash_hex.startsWith("0x") ? ev.sighash_hex : `0x${ev.sighash_hex}`,
          rHex: ev.r_hex,
          sHex: ev.s_hex,
          recoveryId: Number(ev.recovery_id),
          nonce: foreignTx.nonce,
        });
      } catch (err) {
        console.warn(`[NearRelayer] Auto-broadcast foreign default payout warning:`, err);
      }
    }

    return res;
  }

  public async submitForeignDeposit(
    dealId: number,
    txHash: string,
    payloadDto: any,
    signatureHex: string
  ) {
    const termsHashBytes = Array.from(
      Buffer.isBuffer(payloadDto.termsHash)
        ? payloadDto.termsHash
        : Buffer.from(payloadDto.termsHashHex, "hex")
    );
    const sigBytes = Array.from(Buffer.from(signatureHex, "hex"));

    const payload = {
      domain: payloadDto.domain,
      contract_id: payloadDto.contractId,
      chain_id: payloadDto.chainId,
      deal_id: Number(dealId),
      terms_hash: termsHashBytes,
      kind: "ForeignDeposit",
      stage: 0,
      metered_value: "0",
      reason: null,
      nonce: Number(payloadDto.nonce),
      issued_at: Number(payloadDto.issuedAtNs),
      foreign_tx_sighash: null,
    };

    return this.submitFunctionCall("record_foreign_deposit", {
      deal_id: dealId,
      tx_hash: txHash,
      payload,
      sig: sigBytes,
    });
  }

  public async submitAcceptDealSolana(params: {
    dealId: number;
    expectedHashHex: string;
    sellerAddress: string;
    publicKey: Uint8Array | number[];
    nonce: number;
    expiresAtNs: bigint | number | string;
    signature: Uint8Array | number[];
  }) {
    return this.submitFunctionCall("accept_deal_solana", {
      deal_id: params.dealId,
      expected_hash: Array.from(Buffer.from(params.expectedHashHex.replace(/^0x/, ""), "hex")),
      seller_address: params.sellerAddress,
      public_key: Array.from(params.publicKey),
      nonce: params.nonce,
      // The deployed contract accepts a plain Rust `u64`, so NEAR JSON must
      // contain a number here. A string is only valid when the contract uses
      // `near_sdk::json_types::U64` and causes deserialization to fail before
      // signature verification. Nanosecond timestamps are larger than JS's
      // exact integer range, but IEEE-754 rounding is sub-microsecond and does
      // not affect the contract's five-minute expiry window.
      expires_at: Number(params.expiresAtNs),
      signature: Array.from(params.signature),
    });
  }

  public async submitRecordSolanaCollateral(
    dealId: number,
    txSignature: string,
    payloadDto: any,
    signatureHex: string,
  ) {
    return this.submitFunctionCall("record_solana_collateral", {
      deal_id: dealId,
      tx_signature: txSignature,
      payload: this.payloadForContract(payloadDto, "ForeignDeposit"),
      sig: Array.from(Buffer.from(signatureHex, "hex")),
    });
  }

  public async submitRequestSolanaStagePayout(
    dealId: number,
    stage: number,
    payloadDto: any,
    signatureHex: string,
    solanaTx: {
      messageHex: string;
      messageHashHex: string;
      recipient: string;
      amountAtomic: bigint | string;
      lastValidBlockHeight: number;
    },
  ) {
    let result: { transactionHash: string; status: any; receiptsOutcome?: any[] };
    try {
      result = await this.submitFunctionCall(
        "request_solana_stage_payout",
        {
        deal_id: dealId,
        stage,
        payload: this.payloadForContract(payloadDto, "Stage", stage),
        sig: Array.from(Buffer.from(signatureHex, "hex")),
        solana_tx: {
          message_hex: solanaTx.messageHex,
          message_hash: Array.from(Buffer.from(solanaTx.messageHashHex.replace(/^0x/, ""), "hex")),
          recipient: solanaTx.recipient,
          amount: solanaTx.amountAtomic.toString(),
          last_valid_block_height: solanaTx.lastValidBlockHeight,
        },
        },
        "290000000000000",
      );
    } catch (error) {
      // A lost RPC response can happen after the contract saved the pending
      // transaction. Read that state instead of generating another payout.
      const pending = await this.getSolanaPendingPayout(dealId).catch(() => null);
      if (!pending?.signature_hex || Number(pending.stage) !== stage) throw error;
      return {
        transactionHash: "",
        status: "recovered_pending_solana_payout",
        solanaTxSigned: {
          deal_id: dealId,
          stage,
          recipient: pending.recipient,
          amount: pending.amount,
          message_hex: pending.message_hex,
          message_hash_hex: Buffer.from(pending.message_hash).toString("hex"),
          signature_hex: pending.signature_hex,
          last_valid_block_height: Number(pending.last_valid_block_height),
        },
      };
    }
    const solanaTxSigned = this.extractSolanaTxSignedEvent(result.receiptsOutcome)
      || await this.getSolanaPendingPayout(dealId).catch(() => null);
    if (!solanaTxSigned?.signature_hex) {
      throw new Error("NEAR Chain Signatures did not return a Solana payout signature");
    }
    return { ...result, solanaTxSigned };
  }

  public async submitConfirmSolanaStagePayout(
    dealId: number,
    txSignature: string,
    payloadDto: any,
    signatureHex: string,
  ) {
    return this.submitFunctionCall("confirm_solana_stage_payout", {
      deal_id: dealId,
      tx_signature: txSignature,
      payload: this.payloadForContract(payloadDto, "ForeignPayout", Number(payloadDto.stage || 0)),
      sig: Array.from(Buffer.from(signatureHex, "hex")),
    });
  }

  public async submitRegisterForeignChainDeal(params: {
    dealId: number;
    chainId: number;
    vaultAddress: string;
    tokenAddress: string;
    buyerAddress: string;
    sellerAddress: string;
    foreignAmount: string;
  }) {
    return this.submitFunctionCall("register_foreign_chain_deal", {
      deal_id: params.dealId,
      chain_id: params.chainId,
      vault_address: params.vaultAddress,
      token_address: params.tokenAddress,
      buyer_address: params.buyerAddress,
      seller_address: params.sellerAddress,
      foreign_amount: params.foreignAmount,
    });
  }

  public async getForeignDeal(dealId: number): Promise<any> {
    return this.callView("get_foreign_deal", { deal_id: dealId });
  }

  public async getSolanaDeal(dealId: number): Promise<any> {
    return this.callView("get_solana_deal", { deal_id: dealId });
  }

  public async getSolanaPendingPayout(dealId: number): Promise<any> {
    return this.callView("get_solana_pending_payout", { deal_id: dealId });
  }

  public async getDeal(dealId: number): Promise<any> {
    return this.callView("get_deal", { deal_id: dealId });
  }

  public async getTeeSigner(publicKey: string): Promise<any> {
    return this.callView("get_tee_signer", { public_key: publicKey });
  }

  public async getConfig(): Promise<any> {
    return this.callView("get_config", {});
  }
}

export const nearRelayer = new NearRelayer();
