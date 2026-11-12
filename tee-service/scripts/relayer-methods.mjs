// The CVM relayer remains a function-call-only key scoped to the escrow
// contract. Keep this list synchronized with every submitFunctionCall target in
// src/chain/relayer.ts so newly deployed flows cannot fail after wallet signing.
export const RELAYER_METHODS = Object.freeze([
  "accept_deal_solana",
  "activate",
  "checkpoint",
  "confirm_solana_stage_payout",
  "record_foreign_deposit",
  "record_solana_collateral",
  "register_foreign_chain_deal",
  "release_stage",
  "release_stage_foreign",
  "request_solana_stage_payout",
  "settle_default",
  "settle_default_foreign",
]);

