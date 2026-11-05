import { CONTRACT_ID } from "./chain";

const TEE_BASE_URL =
  process.env.NEXT_PUBLIC_TEE_URL ||
  "https://b1b35377079ac7b7937afc607481587bc6d22665-3000.dstack-pha-prod9.phala.network";
const NEAR_RPC_URL = process.env.NEXT_PUBLIC_NEAR_RPC || "https://rpc.testnet.near.org";

export interface TeeAttestation {
  inEnclave: boolean;
  provider: string;
  mrtd: string;
  signerPublicKeyNear: string;
  signerPublicKeyHex: string;
  encryptionPublicKeyHex: string;
  reportDataHex: string;
  rawQuoteHex: string | null;
  timestamp: string;
}

export interface TicketResponse {
  ticketId: string;
  dealId: number;
  buyer: string;
  seller: string;
  matched: boolean;
  buyerSubmitted: boolean;
  sellerSubmitted: boolean;
  messages: Array<{ id: string; sender: string; text: string; createdAt: string }>;
  diffFields?: string[];
  termsHashHex?: string;
  signatureHex?: string;
  updatedAt: string;
}

export interface KeyCheckApiResponse {
  ok: boolean;
  modelAvailable: boolean;
  balanceCoversCredit: boolean;
  proxyKey?: string;
  activatePayload?: any;
  activateSignatureHex?: string;
  error?: string;
}

export interface MeterResponse {
  dealId: number;
  usedUsd: number;
  tokensTotal: number;
  active: boolean;
  provider: string;
  model: string;
  models: string[];
  lockedPricing: Record<string, { inputPerMillion: number; outputPerMillion: number; cachedInputPerMillion?: number }>;
  creditUsd: number;
  priceUsd: number;
  lastCheckpointAt?: string;
  relayReceipts?: Array<{
    kind: "stage" | "checkpoint" | "default";
    nonce: string;
    state: "queued" | "awaiting_credentials" | "submitted" | "applied" | "failed";
    attempts: number;
    transactionHash?: string;
    error?: string;
    updatedAt: string;
  }>;
  timestamp: string;
}

export interface MeterStreamEvent extends MeterResponse {
  type: "meter.update";
  reason: "snapshot" | "usage" | "stage" | "checkpoint" | "default";
  percent: number;
  stages: number[];
}

export const teeApi = {
  openMeterStream(
    dealId: number,
    proxyKey: string,
    onUpdate: (event: MeterStreamEvent) => void,
    onStatus?: (status: "connected" | "disconnected") => void
  ): () => void {
    let stopped = false;
    let socket: WebSocket | null = null;
    let reconnectTimer: number | null = null;
    const wsBase = TEE_BASE_URL.replace(/^http:/, "ws:").replace(/^https:/, "wss:");

    const connect = () => {
      if (stopped) return;
      socket = new WebSocket(`${wsBase}/v1/deals/${dealId}/ws`);
      socket.onopen = () => socket?.send(JSON.stringify({ proxyKey }));
      socket.onmessage = (message) => {
        try {
          const event = JSON.parse(String(message.data));
          if (event.type === "authenticated") onStatus?.("connected");
          if (event.type === "meter.update") onUpdate(event as MeterStreamEvent);
        } catch {
          // Ignore malformed frames; the authenticated channel remains open.
        }
      };
      socket.onclose = () => {
        onStatus?.("disconnected");
        if (!stopped) reconnectTimer = window.setTimeout(connect, 2_000);
      };
    };

    connect();
    return () => {
      stopped = true;
      if (reconnectTimer !== null) window.clearTimeout(reconnectTimer);
      socket?.close();
    };
  },

  async getAttestation(): Promise<TeeAttestation> {
    const res = await fetch(`${TEE_BASE_URL}/v1/attestation`);
    if (!res.ok) throw new Error(`TEE attestation failed: ${res.statusText}`);
    return res.json();
  },

  async initTicket(ticketId: string, dealId: number, buyer: string, seller: string, onChainTermsHashHex?: string): Promise<TicketResponse> {
    const res = await fetch(`${TEE_BASE_URL}/v1/tickets/${ticketId}/init`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ dealId, buyer, seller, onChainTermsHashHex }),
    });
    if (!res.ok) throw new Error(`Failed to init ticket: ${res.statusText}`);
    return res.json();
  },

  async getTicket(ticketId: string): Promise<TicketResponse> {
    const res = await fetch(`${TEE_BASE_URL}/v1/tickets/${ticketId}`, { cache: "no-store" });
    if (!res.ok) throw new Error(`Failed to fetch ticket: ${res.statusText}`);
    return res.json();
  },

  async submitTerms(ticketId: string, party: "buyer" | "seller", encryptedEnvelope: any): Promise<TicketResponse> {
    const res = await fetch(`${TEE_BASE_URL}/v1/tickets/${ticketId}/terms`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ party, encryptedEnvelope }),
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({ error: res.statusText }));
      throw new Error(err.error || "Failed to submit terms");
    }
    return res.json();
  },

  async sendMessage(ticketId: string, sender: string, encryptedEnvelope: any): Promise<TicketResponse> {
    const res = await fetch(`${TEE_BASE_URL}/v1/tickets/${ticketId}/messages`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sender, encryptedEnvelope }),
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({ error: res.statusText }));
      throw new Error(err.error || "Failed to send encrypted message");
    }
    return res.json();
  },

  async submitKey(dealId: number, data: {
    provider: string;
    model: string;
    models?: string[];
    creditUsd: number;
    priceUsd: number;
    termsHashHex: string;
    plainApiKey?: string;
    encryptedEnvelope?: any;
  }): Promise<KeyCheckApiResponse> {
    const res = await fetch(`${TEE_BASE_URL}/v1/deals/${dealId}/key`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(data),
    });
    return res.json();
  },

  async getMeter(dealId: number, proxyKey: string): Promise<MeterResponse> {
    const res = await fetch(`${TEE_BASE_URL}/v1/deals/${dealId}/meter`, {
      headers: { Authorization: `Bearer ${proxyKey}` },
      cache: "no-store",
    });
    if (!res.ok) throw new Error(`Failed to get meter: ${res.statusText}`);
    return res.json();
  },

  async testCompletion(proxyKey: string, prompt: string, model: string = "gpt-4o"): Promise<any> {
    const res = await fetch(`${TEE_BASE_URL}/v1/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${proxyKey}`,
      },
      body: JSON.stringify({
        model,
        messages: [{ role: "user", content: prompt }],
      }),
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({ error: res.statusText }));
      throw new Error(err.error || "Failed to call proxy completion");
    }
    return res.json();
  },

  async getNearContractConfig(): Promise<any> {
    try {
      const res = await fetch(NEAR_RPC_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: "get_config",
          method: "query",
          params: {
            request_type: "call_function",
            finality: "final",
            account_id: CONTRACT_ID,
            method_name: "get_config",
            args_base64: "",
          },
        }),
      });
      const data = await res.json();
      if (data?.result?.result) {
        const text = new TextDecoder().decode(new Uint8Array(data.result.result));
        return JSON.parse(text);
      }
      return null;
    } catch {
      return null;
    }
  },

  async getNearDeal(dealId: number): Promise<any> {
    try {
      const argsBase64 = btoa(JSON.stringify({ deal_id: dealId }));
      const res = await fetch(NEAR_RPC_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: `deal_${dealId}`,
          method: "query",
          params: {
            request_type: "call_function",
            finality: "final",
            account_id: CONTRACT_ID,
            method_name: "get_deal",
            args_base64: argsBase64,
          },
        }),
      });
      const data = await res.json();
      if (data?.result?.result) {
        const text = new TextDecoder().decode(new Uint8Array(data.result.result));
        return JSON.parse(text);
      }
      return null;
    } catch {
      return null;
    }
  },
};
