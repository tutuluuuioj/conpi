use crate::types::{Balance, Deal, DefaultReason};

pub struct DefaultDistribution {
    pub seller_payout: Balance,
    pub buyer_refund: Balance,
    pub slashed_collateral: Balance,
}

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

        // 3. Unused purchase price returned to buyer
        let unused_price = deal.price.saturating_sub(seller_earned);

        // 4. Determine slashing rate based on default reason
        let slash_bps = match reason {
            DefaultReason::ProviderBan => deal.slash_bps_provider_ban as u128,
            DefaultReason::InvalidKey
            | DefaultReason::InsufficientQuota
            | DefaultReason::KeyNotSubmitted
            | DefaultReason::ValidationFailed => deal.slash_bps_revoke as u128,
        };

        let slash_amount = (slash_bps * deal.seller_collateral) / 10_000;
        let seller_collateral_refund = deal.seller_collateral.saturating_sub(slash_amount);

        // 5. Compute final totals to transfer
        let seller_payout = remaining_owed_to_seller + seller_collateral_refund;
        let buyer_refund = unused_price + deal.buyer_collateral + slash_amount;

        DefaultDistribution {
            seller_payout,
            buyer_refund,
            slashed_collateral: slash_amount,
        }
    }

    /// Calculates settlement distributions when TEE liveness timeout passes.
    /// Neither party is faulted: both collaterals are returned in full.
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
        let unused_price = deal.price.saturating_sub(seller_earned);

        let seller_payout = additional_seller_owed + deal.seller_collateral;
        let buyer_refund = unused_price + deal.buyer_collateral;

        TimeoutDistribution {
            seller_payout,
            buyer_refund,
        }
    }
}
