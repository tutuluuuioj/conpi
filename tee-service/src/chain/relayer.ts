import { CONFIG } from "../config.js";
import { Account, JsonRpcProvider, KeyPairSigner } from "near-api-js";

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
  ): Promise<{ transactionHash: string; status: any }> {
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
    };
  }

  public async submitActivate(dealId: number, payloadDto: any, signatureHex: string) {
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
      kind: "Activate",
      stage: Number(payloadDto.stage || 0),
      metered_value: payloadDto.meteredValueYocto ? payloadDto.meteredValueYocto.toString() : "0",
      reason: null,
      nonce: Number(payloadDto.nonce),
      issued_at: Number(payloadDto.issuedAtNs),
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
    };

    return this.submitFunctionCall("release_stage", {
      deal_id: dealId,
      stage,
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
    };

    return this.submitFunctionCall("settle_default", {
      deal_id: dealId,
      payload,
      sig: sigBytes,
    });
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
