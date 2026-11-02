use crate::types::{Balance, Deal, DefaultReason};

#[derive(Debug, PartialEq, Eq)]
pub struct DefaultDistribution {
    pub seller_payout: Balance,
    pub buyer_refund: Balance,
    pub slashed_collateral: Balance,
}

#[derive(Debug, PartialEq, Eq)]
pub struct TimeoutDistribution {
    pub seller_payout: Balance,
    pub buyer_refund: Balance,
}

pub struct SettlementCalculator;

impl SettlementCalculator {
    /// Calculates the stage payout to the seller.
    /// Returns the incremental payout amount for this stage.
    pub fn calculate_stage_payout(deal: &Deal, stage: u8) -> Balance {
        assert!(
            stage == 25 || stage == 50 || stage == 75 || stage == 100,
            "Invalid stage: must be 25, 50, 75, or 100"
        );
        let seller_cumulative = (stage as u128 * deal.price) / 100;
        assert!(
            seller_cumulative >= deal.released_to_seller,
            "Cumulative payout cannot decrease"
        );
        seller_cumulative - deal.released_to_seller
    }

    /// Calculates settlement distributions when a seller default occurs.
    ///
    /// GUARANTEE: Exactly conserves the escrow balance (`price - released_to_seller + collaterals`).
    /// Under NO condition can `seller_payout + buyer_refund` exceed the remaining funds in escrow,
    /// even if default happens after a stage release where `released_to_seller > seller_earned`.
    pub fn calculate_default_settlement(
        deal: &Deal,
        metered_value: u128,
        reason: DefaultReason,
    ) -> DefaultDistribution {
        // 1. Calculate fraction of credit delivered (in basis points, max 10,000)
        let fraction_bps = if deal.credit_amount == 0 {
            0u128
        } else {
            std::cmp::min(10_000u128, (metered_value * 10_000) / deal.credit_amount)
        };

        // 2. Seller earned amount for metered tokens (exact pro-rata, not rounded to stage)
        let seller_earned = (fraction_bps * deal.price) / 10_000;
        let remaining_owed_to_seller = seller_earned.saturating_sub(deal.released_to_seller);

        // CRITICAL BUG FIX (settlement.rs:47-50):
        // If the seller already received stage payouts that exceed their final metered usage
        // (e.g. Stage 50% paid $30, but seller metered only 40% = $24), the buyer's price refund
        // must come from the remaining price left in escrow: `price - max(seller_earned, released_to_seller)`.
        let effective_seller_taken = std::cmp::max(seller_earned, deal.released_to_seller);
        let buyer_price_refund = deal.price.saturating_sub(effective_seller_taken);

        // 3. Determine slashing rate based on default reason
        let slash_bps = match reason {
            DefaultReason::ProviderBan => deal.slash_bps_provider_ban as u128,
            DefaultReason::InvalidKey
            | DefaultReason::InsufficientQuota
            | DefaultReason::KeyNotSubmitted
            | DefaultReason::ValidationFailed
            | DefaultReason::SellerSelfDrain => deal.slash_bps_revoke as u128,
        };

        let slash_amount = (slash_bps * deal.seller_collateral) / 10_000;
        let seller_collateral_refund = deal.seller_collateral.saturating_sub(slash_amount);

        // 4. Compute final totals to transfer
        let seller_payout = remaining_owed_to_seller + seller_collateral_refund;
        let buyer_refund = buyer_price_refund + deal.buyer_collateral + slash_amount;

        // MATHEMATICAL CONSERVATION ASSERTION:
        let remaining_escrow = (deal.price - deal.released_to_seller)
            + deal.buyer_collateral
            + deal.seller_collateral;
        assert_eq!(
            seller_payout + buyer_refund,
            remaining_escrow,
            "CRITICAL CONSERVATION INVARIANT VIOLATED: settlement payout does not match remaining escrow"
        );

        DefaultDistribution {
            seller_payout,
            buyer_refund,
            slashed_collateral: slash_amount,
        }
    }

    /// Calculates settlement distributions when TEE liveness timeout passes.
    /// Neither party is faulted: both collaterals are returned in full.
    ///
    /// GUARANTEE: Exactly conserves the escrow balance, even if the last signed checkpoint
    /// is older than the latest stage release.
    pub fn calculate_timeout_settlement(
        deal: &Deal,
        checkpoint_metered_value: u128,
    ) -> TimeoutDistribution {
        let fraction_bps = if deal.credit_amount == 0 {
            0u128
        } else {
            std::cmp::min(
                10_000u128,
                (checkpoint_metered_value * 10_000) / deal.credit_amount,
            )
        };

        let seller_earned = (fraction_bps * deal.price) / 10_000;
        let additional_seller_owed = seller_earned.saturating_sub(deal.released_to_seller);

        // CRITICAL BUG FIX (settlement.rs:95-96):
        // Protect against old checkpoints overpaying the buyer beyond remaining escrow funds.
        let effective_seller_taken = std::cmp::max(seller_earned, deal.released_to_seller);
        let buyer_price_refund = deal.price.saturating_sub(effective_seller_taken);

        let seller_payout = additional_seller_owed + deal.seller_collateral;
        let buyer_refund = buyer_price_refund + deal.buyer_collateral;

        // MATHEMATICAL CONSERVATION ASSERTION:
        let remaining_escrow = (deal.price - deal.released_to_seller)
            + deal.buyer_collateral
            + deal.seller_collateral;
        assert_eq!(
            seller_payout + buyer_refund,
            remaining_escrow,
            "CRITICAL CONSERVATION INVARIANT VIOLATED: timeout payout does not match remaining escrow"
        );

        TimeoutDistribution {
            seller_payout,
            buyer_refund,
        }
    }
}
