import { computeTermsHash, buildTermsMessage, DealTermsParams } from "../crypto/terms.js";
import { enclaveKeys } from "../crypto/keys.js";
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
  buyerTerms?: TermSheet;
  sellerTerms?: TermSheet;
  matched: boolean;
  termsHashHex?: string;
  signatureHex?: string;
  diffFields?: string[];
  updatedAt: string;
}

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

  public getOrCreateTicket(ticketId: string, dealId: number, buyer: string, seller: string): TicketState {
    let ticket = this.tickets.get(ticketId);
    if (!ticket) {
      ticket = {
        ticketId,
        dealId,
        buyer,
        seller,
        matched: false,
        updatedAt: new Date().toISOString(),
      };
      this.tickets.set(ticketId, ticket);
    }
    return ticket;
  }

  public getTicket(ticketId: string): TicketState | undefined {
    return this.tickets.get(ticketId);
  }

  public submitTerms(ticketId: string, party: "buyer" | "seller", inputTerms: any): TicketState {
    const ticket = this.tickets.get(ticketId);
    if (!ticket) {
      throw new Error(`Ticket ${ticketId} not found`);
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
        ticket.termsHashHex = Buffer.from(termsHashBytes).toString("hex");

        const msgBytes = buildTermsMessage(CONFIG.networkId, CONFIG.contractId, ticket.dealId, termsHashBytes);
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
    if (Math.abs(a.creditAmountUsd - b.creditAmountUsd) > 0.01) diffs.push("creditAmount");
    if (Math.abs(a.priceUsd - b.priceUsd) > 0.01) diffs.push("price");
    if (a.buyerCollateralPct !== b.buyerCollateralPct) diffs.push("buyerCollateralPct");
    if (a.sellerCollateralPct !== b.sellerCollateralPct) diffs.push("sellerCollateralPct");
    if (a.token !== b.token) diffs.push("token");
    if (a.depositDurationSec !== b.depositDurationSec) diffs.push("depositDurationSec");
    if (a.keyDurationSec !== b.keyDurationSec) diffs.push("keyDurationSec");
    if (a.teeLivenessTimeoutSec !== b.teeLivenessTimeoutSec) diffs.push("teeLivenessTimeoutSec");
    if (a.slashBpsProviderBan !== b.slashBpsProviderBan) diffs.push("slashBpsProviderBan");
    if (a.slashBpsRevoke !== b.slashBpsRevoke) diffs.push("slashBpsRevoke");
    if (a.slashBpsBuyerBreach !== b.slashBpsBuyerBreach) diffs.push("slashBpsBuyerBreach");
    if (JSON.stringify(a.models.slice().sort()) !== JSON.stringify(b.models.slice().sort())) diffs.push("models");
    return diffs;
  }
}

export const negotiationService = new NegotiationService();
