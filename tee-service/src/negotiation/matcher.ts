import crypto from "crypto";
import { computeTermsHash, buildTermsMessage, DealTermsParams } from "../crypto/terms.js";
import { enclaveKeys } from "../crypto/keys.js";
import { decryptFromClient, EncryptedEnvelope } from "../crypto/encryption.js";
import { CONFIG } from "../config.js";

export interface TermSheet {
  provider: "OpenAI" | "Anthropic" | "OpenRouter";
  models: string[];
  creditAmountUsd: number;
  priceUsd: number;
  buyerCollateralPct: number;
  sellerCollateralPct: number;
  token: string | null; // null for NEAR, or AccountId
  depositDurationSec: number;
  keyDurationSec: number;
  teeLivenessTimeoutSec: number;
  slashBpsProviderBan: number;
  slashBpsRevoke: number;
  slashBpsBuyerBreach: number;
  deadline: string;
}

export interface TicketState {
  ticketId: string;
  dealId: number;
  buyer: string;
  seller: string;
  onChainTermsHashHex?: string;
  buyerTerms?: TermSheet;
  sellerTerms?: TermSheet;
  matched: boolean;
  termsHashHex?: string;
  signatureHex?: string;
  diffFields?: string[];
  messages: TicketMessage[];
  updatedAt: string;
}

export interface TicketMessage {
  id: string;
  sender: string;
  text: string;
  createdAt: string;
}

export type TicketView = Omit<TicketState, "buyerTerms" | "sellerTerms"> & {
  buyerSubmitted: boolean;
  sellerSubmitted: boolean;
};

export function normalizeTerms(input: any): TermSheet {
  const creditAmountUsd = Number(input.creditAmountUsd ?? input.creditUsd ?? 100);
  const priceUsd = Number(input.priceUsd ?? input.price ?? creditAmountUsd);
  return {
    provider: input.provider || "OpenAI",
    models: Array.isArray(input.models) && input.models.length > 0 ? input.models : [input.model || "gpt-4o"],
    creditAmountUsd: isNaN(creditAmountUsd) ? 100 : creditAmountUsd,
    priceUsd: isNaN(priceUsd) ? 100 : priceUsd,
    buyerCollateralPct: Number(input.buyerCollateralPct ?? 10),
    sellerCollateralPct: Number(input.sellerCollateralPct ?? 10),
    token: input.token ?? null,
    depositDurationSec: Number(input.depositDurationSec ?? 3600),
    keyDurationSec: Number(input.keyDurationSec ?? 86400),
    teeLivenessTimeoutSec: Number(input.teeLivenessTimeoutSec ?? 3600),
    slashBpsProviderBan: Number(input.slashBpsProviderBan ?? 1000),
    slashBpsRevoke: Number(input.slashBpsRevoke ?? 1000),
    slashBpsBuyerBreach: Number(input.slashBpsBuyerBreach ?? 1000),
    deadline: input.deadline || new Date(Date.now() + 86400_000).toISOString(),
  };
}

class NegotiationService {
  private tickets = new Map<string, TicketState>();

  public getOrCreateTicket(
    ticketId: string,
    dealId: number,
    buyer: string,
    seller: string,
    onChainTermsHashHex?: string
  ): TicketState {
    const normalizedHash = onChainTermsHashHex?.replace(/^0x/, "").trim().toLowerCase();
    if (normalizedHash && !/^[0-9a-f]{64}$/.test(normalizedHash)) {
      throw new Error("On-chain terms hash must be exactly 32 bytes of hex");
    }
    let ticket = this.tickets.get(ticketId);
    if (!ticket) {
      ticket = {
        ticketId,
        dealId,
        buyer,
        seller,
        onChainTermsHashHex: normalizedHash,
        matched: false,
        messages: [],
        updatedAt: new Date().toISOString(),
      };
      this.tickets.set(ticketId, ticket);
    } else {
      if (ticket.dealId !== dealId || ticket.buyer !== buyer || ticket.seller !== seller) {
        throw new Error(`Ticket ${ticketId} is already bound to different deal participants`);
      }
      if (ticket.onChainTermsHashHex && normalizedHash && ticket.onChainTermsHashHex !== normalizedHash) {
        throw new Error(`Ticket ${ticketId} is already bound to a different on-chain terms hash`);
      }
      if (!ticket.onChainTermsHashHex && normalizedHash) ticket.onChainTermsHashHex = normalizedHash;
    }
    return ticket;
  }

  public getTicket(ticketId: string): TicketState | undefined {
    return this.tickets.get(ticketId);
  }

  public assertMatchedDealTerms(
    dealId: number,
    provider: string,
    models: string[],
    termsHashHex: string
  ): TermSheet | undefined {
    const ticket = [...this.tickets.values()].find((item) => item.dealId === dealId);
    if (!ticket) {
      if (process.env.NODE_ENV === "test") return undefined;
      throw new Error(`Matched TEE term sheet for deal #${dealId} was not found`);
    }
    if (!ticket.matched || !ticket.buyerTerms || !ticket.sellerTerms || !ticket.termsHashHex) {
      throw new Error(`Both parties must submit matching TEE terms before deal #${dealId} can be activated`);
    }

    const normalizedProvider = provider.trim().toLowerCase();
    if (ticket.sellerTerms.provider.trim().toLowerCase() !== normalizedProvider) {
      throw new Error(`Provider does not match the agreed TEE term sheet for deal #${dealId}`);
    }
    const normalizeModels = (items: string[]) => [...new Set(items.map((item) => item.trim().toLowerCase()).filter(Boolean))].sort();
    if (JSON.stringify(normalizeModels(ticket.sellerTerms.models)) !== JSON.stringify(normalizeModels(models))) {
      throw new Error(`Model allowlist does not match the agreed TEE term sheet for deal #${dealId}`);
    }
    if (ticket.termsHashHex.replace(/^0x/, "").toLowerCase() !== termsHashHex.replace(/^0x/, "").toLowerCase()) {
      throw new Error(`Terms hash does not match the agreed TEE term sheet for deal #${dealId}`);
    }
    return ticket.sellerTerms;
  }

  /**
   * Returns only negotiation status and messages. Counterparty term sheets stay
   * private inside the enclave and are never returned by the public API.
   */
  public getTicketView(ticketId: string): TicketView | undefined {
    const ticket = this.tickets.get(ticketId);
    if (!ticket) return undefined;
    const { buyerTerms, sellerTerms, ...view } = ticket;
    return {
      ...view,
      buyerSubmitted: Boolean(buyerTerms),
      sellerSubmitted: Boolean(sellerTerms),
    };
  }

  public submitEncryptedTerms(
    ticketId: string,
    party: "buyer" | "seller",
    envelope: EncryptedEnvelope
  ): TicketView {
    const plaintext = decryptFromClient(envelope);
    let terms: unknown;
    try {
      terms = JSON.parse(plaintext);
    } catch {
      throw new Error("Encrypted term sheet is not valid JSON");
    }
    this.submitTerms(ticketId, party, terms);
    return this.getTicketView(ticketId)!;
  }

  public addEncryptedMessage(
    ticketId: string,
    sender: string,
    envelope: EncryptedEnvelope
  ): TicketView {
    const ticket = this.tickets.get(ticketId);
    if (!ticket) throw new Error(`Ticket ${ticketId} not found`);
    if (sender !== ticket.buyer && sender !== ticket.seller) {
      throw new Error("Message sender is not a ticket participant");
    }

    const text = decryptFromClient(envelope).trim();
    if (!text) throw new Error("Message cannot be empty");
    if (text.length > 4_000) throw new Error("Message exceeds 4,000 characters");

    ticket.messages.push({
      id: crypto.randomUUID(),
      sender,
      text,
      createdAt: new Date().toISOString(),
    });
    ticket.updatedAt = new Date().toISOString();
    return this.getTicketView(ticketId)!;
  }

  public submitTerms(ticketId: string, party: "buyer" | "seller", inputTerms: any): TicketState {
    const ticket = this.tickets.get(ticketId);
    if (!ticket) {
      throw new Error(`Ticket ${ticketId} not found`);
    }
    if (party !== "buyer" && party !== "seller") {
      throw new Error("Term submitter must be buyer or seller");
    }

    const terms = normalizeTerms(inputTerms);

    if (party === "buyer") {
      ticket.buyerTerms = terms;
    } else {
      ticket.sellerTerms = terms;
    }
    ticket.updatedAt = new Date().toISOString();

    // Check matching if both submitted
    if (ticket.buyerTerms && ticket.sellerTerms) {
      const diffs = this.compareTerms(ticket.buyerTerms, ticket.sellerTerms);
      if (diffs.length === 0) {
        ticket.matched = true;
        ticket.diffFields = [];

        // Convert USD amounts to smallest token units
        // NEAR: 24 decimals (10^24 yoctoNEAR)
        // NEP-141 USDC/USDT: 6 decimals (10^6)
        const decimals = (terms.token === null || terms.token === "NEAR") ? 24n : 6n;
        const multiplier = 10n ** decimals;
        const priceYocto = (BigInt(Math.round(terms.priceUsd * 100)) * multiplier) / 100n;
        const creditYocto = (BigInt(Math.round(terms.creditAmountUsd * 100)) * multiplier) / 100n;
        const buyerCollateralYocto = (priceYocto * BigInt(terms.buyerCollateralPct)) / 100n;
        const sellerCollateralYocto = (priceYocto * BigInt(terms.sellerCollateralPct)) / 100n;

        const params: DealTermsParams = {
          dealId: ticket.dealId,
          buyer: ticket.buyer,
          seller: ticket.seller,
          token: terms.token,
          priceYocto,
          creditAmountYocto: creditYocto,
          buyerCollateralYocto,
          sellerCollateralYocto,
          teePubKeyBytes: enclaveKeys.getSignerPublicKeyBytes(),
          depositDurationNs: BigInt(terms.depositDurationSec) * 1_000_000_000n,
          keyDurationNs: BigInt(terms.keyDurationSec) * 1_000_000_000n,
          teeLivenessTimeoutNs: BigInt(terms.teeLivenessTimeoutSec) * 1_000_000_000n,
          slashBpsProviderBan: terms.slashBpsProviderBan,
          slashBpsRevoke: terms.slashBpsRevoke,
          slashBpsBuyerBreach: terms.slashBpsBuyerBreach,
        };

        const termsHashBytes = computeTermsHash(params);
        ticket.termsHashHex = ticket.onChainTermsHashHex || Buffer.from(termsHashBytes).toString("hex");

        const signedTermsHashBytes = Buffer.from(ticket.termsHashHex, "hex");
        const msgBytes = buildTermsMessage(CONFIG.networkId, CONFIG.contractId, ticket.dealId, signedTermsHashBytes);
        const sig = enclaveKeys.sign(msgBytes);
        ticket.signatureHex = Buffer.from(sig).toString("hex");
      } else {
        ticket.matched = false;
        ticket.diffFields = diffs;
      }
    }

    return ticket;
  }

  private compareTerms(a: TermSheet, b: TermSheet): string[] {
    const diffs: string[] = [];
    if (a.provider !== b.provider) diffs.push("provider");
    if (Math.abs(a.creditAmountUsd - b.creditAmountUsd) > 0.000001) diffs.push("creditAmount");
    if (Math.abs(a.priceUsd - b.priceUsd) > 0.000001) diffs.push("price");
    if (a.buyerCollateralPct !== b.buyerCollateralPct) diffs.push("buyerCollateralPct");
    if (a.sellerCollateralPct !== b.sellerCollateralPct) diffs.push("sellerCollateralPct");
    if (a.token !== b.token) diffs.push("token");
    if (a.depositDurationSec !== b.depositDurationSec) diffs.push("depositDurationSec");
    if (a.keyDurationSec !== b.keyDurationSec) diffs.push("keyDurationSec");
    if (a.teeLivenessTimeoutSec !== b.teeLivenessTimeoutSec) diffs.push("teeLivenessTimeoutSec");
    if (a.slashBpsProviderBan !== b.slashBpsProviderBan) diffs.push("slashBpsProviderBan");
    if (a.slashBpsRevoke !== b.slashBpsRevoke) diffs.push("slashBpsRevoke");
    if (a.slashBpsBuyerBreach !== b.slashBpsBuyerBreach) diffs.push("slashBpsBuyerBreach");
    if (a.deadline !== b.deadline) diffs.push("deadline");
    if (JSON.stringify(a.models.slice().sort()) !== JSON.stringify(b.models.slice().sort())) diffs.push("models");
    return diffs;
  }
}

export const negotiationService = new NegotiationService();
