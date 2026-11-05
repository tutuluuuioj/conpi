export type Provider = "OpenAI" | "Anthropic" | "OpenRouter";
export type Asset = "NEAR" | "USDC" | "USDT";
export type ListingType = "sell" | "buy";
export type ThemeMode = "dark" | "light" | "system";
export type WalletName = "MyNearWallet" | "Meteor" | "HERE" | "Sender" | "Ledger";

export type DealStatus =
  | "Created"
  | "Funded"
  | "Active"
  | "Completed"
  | "Defaulted"
  | "Buyer breach"
  | "Cancelled"
  | "Timeout settled"
  | "Auto-released"
  | "Pending claim";

export type DealStep = "negotiate" | "terms" | "deposit" | "key" | "live" | "settled";

export type Outcome =
  | "completed"
  | "revoked"
  | "quota"
  | "provider_ban"
  | "buyer_breach"
  | "auto_release"
  | "tee_timeout"
  | "deposit_timeout";

export interface Listing {
  id: string;
  dealId?: string;
  type: ListingType;
  provider: Provider;
  model: string;
  models: string[];
  credit: number;
  creditUsd?: number;
  price: number;
  priceUsd?: number;
  collateralPct: number;
  buyerCollateralPct: number;
  seller: string;
  reputation: number;
  tee: boolean;
  token: Asset;
  tokenContract?: string;
  published?: boolean;
  rateLimit: string;
  expectedTest: string;
  createdAt: string;
}

export interface Terms {
  credit: number;
  creditUsd?: number;
  price: number;
  priceUsd?: number;
  buyerCollateralPct: number;
  sellerCollateralPct: number;
  token: Asset;
  models: string[];
  deadline: string;
}

export interface ChatMessage {
  id: string;
  sender: string;
  text: string;
  time: string;
}

export interface Activity {
  id: string;
  title: string;
  detail: string;
  tx?: string;
  time: string;
}

export interface StepMark {
  time: string;
  tx?: string;
}

export interface SplitLine {
  label: string;
  amount: number;
  note: string;
  tone?: "mint" | "orange" | "blue" | "violet" | "muted";
}

export interface Split {
  seller: number;
  buyer: number;
  slashed: number;
  lines: SplitLine[];
}

export interface PriceRow {
  model: string;
  input: string;
  output: string;
}

export interface Deal {
  id: string;
  listingId: string;
  role: "buyer" | "seller";
  status: DealStatus;
  step: DealStep;
  provider: Provider;
  model: string;
  models: string[];
  credit: number;
  creditUsd?: number;
  price: number;
  priceUsd?: number;
  buyerCollateralPct: number;
  sellerCollateralPct: number;
  token: Asset;
  buyer: string;
  seller: string;
  deadline: string;
  termsHash: string | null;
  counterpartyAccepted?: boolean;
  buyerSubmitted: boolean;
  sellerSubmitted: boolean;
  termDiffFields?: string[];
  buyerTerms: Terms;
  sellerTerms: Terms;
  buyerDeposited: boolean;
  sellerDeposited: boolean;
  buyerDepositRemaining?: number;
  sellerDepositRemaining?: number;
  depositDeadline: string;
  keyStatus: "idle" | "checking" | "verified";
  keyChecks: { label: string; ok: boolean }[];
  proxyKey: string;
  proxyRevoked: boolean;
  baseUrl: string;
  usedUsd: number;
  tokens: number;
  stage: number;
  releasedUsd: number;
  lastUpdate: string;
  heartbeat: "live" | "stale";
  lastCheckpoint: string;
  outcome: Outcome | null;
  split: Split | null;
  messages: ChatMessage[];
  activity: Activity[];
  prices: PriceRow[];
  steps: Partial<Record<DealStep, StepMark>>;
  createdAt: string;
  pulseStage: number | null;
}

export interface Claim {
  id: string;
  token: Asset;
  amount: number;
  dealId: string;
  reason: string;
  claimed: boolean;
  tx?: string;
}

export interface Notice {
  id: string;
  kind: string;
  title: string;
  body: string;
  time: string;
  href: string;
  read: boolean;
}

export interface Proposal {
  id: string;
  action: string;
  proposer: string;
  confirmations: number;
  threshold: number;
  stagedAt: string;
  executableAt: string;
  status: "Pending" | "Ready" | "Executed" | "Cancelled";
  diff: { field: string; from: string; to: string }[];
  confirmedByMe: boolean;
}

export interface Toast {
  id: string;
  kind: "success" | "error" | "info" | "pending";
  title: string;
  body?: string;
  href?: string;
}

export interface SignResult {
  ok: boolean;
  title: string;
  href?: string;
  body?: string;
}
