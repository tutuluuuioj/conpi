import { CONFIG } from "../config.js";

export class NearRelayer {
  private rpcUrl: string;

  constructor() {
    this.rpcUrl = CONFIG.nodeUrl;
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
        return JSON.parse(resultStr);
      } catch {
        return resultStr;
      }
    }
    return null;
  }

  public async getDeal(dealId: number): Promise<any> {
    return this.callView("get_deal", { deal_id: dealId });
  }

  public async getTeeSigners(): Promise<any> {
    return this.callView("get_tee_signers", {});
  }

  public async getConfig(): Promise<any> {
    return this.callView("get_config", {});
  }
}

export const nearRelayer = new NearRelayer();
