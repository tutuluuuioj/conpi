use near_sdk::collections::{LookupMap, UnorderedMap};
use near_sdk::json_types::U128;
use near_sdk::{
    env, near, require, AccountId, Gas, PanicOnDefault, Promise, PromiseOrValue, PublicKey,
};

pub mod crypto;
pub mod events;
pub mod settlement;
pub mod types;

#[cfg(test)]
mod tests;

use crypto::CryptoHelper;
use events::{emit_event, ConpiEvent};
use settlement::SettlementCalculator;
use types::{
    Balance, Config, CreateDealParams, Deal, DealId, DealStatus, DefaultReason, PayloadKind,
    SignedPayload, SignedState, TeeSigner,
};

const GAS_FOR_FT_TRANSFER: Gas = Gas::from_tgas(20);
const ONE_YOCTO: Balance = 1;

#[near(contract_state)]
#[derive(PanicOnDefault)]
pub struct ConpiEscrow {
    pub owner: AccountId,
    pub tee_signers: UnorderedMap<PublicKey, TeeSigner>,
    pub deals: LookupMap<DealId, Deal>,
    pub all_deal_ids: Vec<DealId>,
    pub next_deal_id: u64,
    pub config: Config,
}

#[near]
impl ConpiEscrow {
    #[init]
    pub fn new(owner: AccountId, config: Option<Config>) -> Self {
        require!(!env::state_exists(), "Already initialized");
        Self {
            owner,
            tee_signers: UnorderedMap::new(b"t"),
            deals: LookupMap::new(b"d"),
            all_deal_ids: Vec::new(),
            next_deal_id: 1,
            config: config.unwrap_or_default(),
        }
    }

    /* -------------------------------------------------------------------------
       ADMIN METHODS
    ------------------------------------------------------------------------- */

    pub fn add_tee_signer(&mut self, public_key: PublicKey, measurement: String) {
        self.assert_owner();
        self.tee_signers.insert(
            &public_key,
            &TeeSigner {
                measurement,
                registered_at: env::block_timestamp(),
                active: true,
            },
        );
    }

    pub fn revoke_tee_signer(&mut self, public_key: PublicKey) {
        self.assert_owner();
        let mut signer = self
            .tee_signers
            .get(&public_key)
            .expect("TEE signer not registered");
        signer.active = false;
        self.tee_signers.insert(&public_key, &signer);
    }

    pub fn update_config(&mut self, config: Config) {
        self.assert_owner();
        self.config = config;
    }

    /* -------------------------------------------------------------------------
       DEAL CREATION & TERMS REGISTRATION
    ------------------------------------------------------------------------- */

    pub fn create_deal(&mut self, params: CreateDealParams) -> u64 {
        let caller = env::predecessor_account_id();
        require!(
            caller == params.buyer || caller == params.seller,
            "Only buyer or seller can create deal"
        );
        require!(params.buyer != params.seller, "Buyer and seller must differ");

        // Verify that the specified TEE signer is registered and active
        let signer = self
            .tee_signers
            .get(&params.tee_pubkey)
            .expect("Specified TEE public key is not registered");
        require!(signer.active, "Specified TEE signer is revoked/inactive");

        let deposit_duration = params.deposit_duration_sec * 1_000_000_000;
        require!(
            deposit_duration >= self.config.min_deposit_duration
                && deposit_duration <= self.config.max_deposit_duration,
            "Deposit duration out of bounds"
        );

        let liveness_timeout = params.tee_liveness_timeout_sec * 1_000_000_000;
        require!(
            liveness_timeout >= self.config.min_tee_liveness_timeout,
            "TEE liveness timeout too short"
        );

        require!(
            params.slash_bps_revoke <= self.config.max_slash_bps
                && params.slash_bps_revoke >= self.config.min_slash_bps,
            "Revoke slash bps out of bounds"
        );
        require!(
            params.slash_bps_provider_ban <= self.config.max_slash_bps
                && params.slash_bps_provider_ban >= self.config.min_slash_bps,
            "Provider ban slash bps out of bounds"
        );

        let now = env::block_timestamp();
        let deal_id = self.next_deal_id;
        self.next_deal_id += 1;

        let deal = Deal {
            id: deal_id,
            buyer: params.buyer.clone(),
            seller: params.seller.clone(),
            token: params.token.clone(),
            price: params.price.0,
            credit_amount: params.credit_amount.0,
            buyer_collateral: params.buyer_collateral.0,
            seller_collateral: params.seller_collateral.0,
            terms_hash: None,
            tee_pubkey: params.tee_pubkey,
            deposit_deadline: now + deposit_duration,
            key_deadline: now + deposit_duration + (params.key_duration_sec * 1_000_000_000),
            usage_deadline: 0, // set upon activation
            tee_liveness_timeout: liveness_timeout,
            slash_bps_provider_ban: params.slash_bps_provider_ban,
            slash_bps_revoke: params.slash_bps_revoke,
            buyer_deposited: 0,
            seller_deposited: 0,
            released_to_seller: 0,
            stage_reached: 0,
            last_signed: None,
            last_nonce: 0,
            last_tee_seen: now,
            status: DealStatus::Created,
        };

        self.deals.insert(&deal_id, &deal);
        self.all_deal_ids.push(deal_id);

        emit_event(ConpiEvent::DealCreated {
            deal_id,
            buyer: &params.buyer,
            seller: &params.seller,
            price: params.price,
            token: &params.token,
        });

        deal_id
    }

    /// Registers the canonical terms_hash verified and signed by the TEE.
    pub fn register_terms_hash(&mut self, deal_id: u64, terms_hash: [u8; 32], sig: Vec<u8>) {
        let mut deal = self.get_deal_or_panic(deal_id);
        require!(
            deal.status == DealStatus::Created,
            "Deal must be in Created status"
        );
        require!(deal.terms_hash.is_none(), "terms_hash already registered");

        // Message to verify: "conpi:v1" + contract_id + chain_id + deal_id + terms_hash
        let mut msg_bytes = Vec::new();
        msg_bytes.extend_from_slice(b"conpi:v1:terms:");
        msg_bytes.extend_from_slice(env::current_account_id().as_bytes());
        msg_bytes.extend_from_slice(&deal_id.to_le_bytes());
        msg_bytes.extend_from_slice(&terms_hash);

        let is_valid =
            CryptoHelper::verify_signature_raw(&msg_bytes, &sig, &deal.tee_pubkey);
        require!(is_valid, "Invalid TEE signature on terms_hash");

        deal.terms_hash = Some(terms_hash);
        deal.last_tee_seen = env::block_timestamp();

        // Check if both deposits arrived before terms_hash was set
        self.check_and_transition_funded(&mut deal);

        self.deals.insert(&deal_id, &deal);

        emit_event(ConpiEvent::TermsRegistered {
            deal_id,
            terms_hash: &hex::encode(terms_hash),
        });
    }

    /* -------------------------------------------------------------------------
       DEPOSITS (NATIVE NEAR & NEP-141)
    ------------------------------------------------------------------------- */

    #[payable]
    pub fn deposit(&mut self, deal_id: u64) {
        let mut deal = self.get_deal_or_panic(deal_id);
        require!(
            deal.token.is_none(),
            "This deal uses a NEP-141 token, use ft_transfer_call"
        );
        require!(
            deal.status == DealStatus::Created,
            "Deal is not accepting deposits"
        );
        require!(
            env::block_timestamp() <= deal.deposit_deadline,
            "Deposit deadline has passed"
        );

        let caller = env::predecessor_account_id();
        let attached = env::attached_deposit().as_yoctonear();

        if caller == deal.buyer {
            let required = deal.price + deal.buyer_collateral;
            require!(
                deal.buyer_deposited + attached <= required,
                "Exceeds required buyer deposit"
            );
            deal.buyer_deposited += attached;
            emit_event(ConpiEvent::DepositReceived {
                deal_id,
                account: &caller,
                amount: U128(attached),
                is_buyer: true,
            });
        } else if caller == deal.seller {
            let required = deal.seller_collateral;
            require!(
                deal.seller_deposited + attached <= required,
                "Exceeds required seller deposit"
            );
            deal.seller_deposited += attached;
            emit_event(ConpiEvent::DepositReceived {
                deal_id,
                account: &caller,
                amount: U128(attached),
                is_buyer: false,
            });
        } else {
            env::panic_str("Caller is neither buyer nor seller for this deal");
        }

        self.check_and_transition_funded(&mut deal);
        self.deals.insert(&deal_id, &deal);
    }

    /// NEP-141 token receiver callback
    pub fn ft_on_transfer(
        &mut self,
        sender_id: AccountId,
        amount: U128,
        msg: String,
    ) -> PromiseOrValue<U128> {
        let token_account = env::predecessor_account_id();
        let deal_id: u64 = msg
            .parse::<u64>()
            .expect("ft_on_transfer msg must contain valid numeric deal_id");

        let mut deal = self.get_deal_or_panic(deal_id);
        require!(
            deal.token == Some(token_account),
            "Token does not match deal asset"
        );
        require!(
            deal.status == DealStatus::Created,
            "Deal is not accepting deposits"
        );
        require!(
            env::block_timestamp() <= deal.deposit_deadline,
            "Deposit deadline has passed"
        );

        let amt = amount.0;
        if sender_id == deal.buyer {
            let required = deal.price + deal.buyer_collateral;
            require!(
                deal.buyer_deposited + amt <= required,
                "Exceeds required buyer deposit"
            );
            deal.buyer_deposited += amt;
            emit_event(ConpiEvent::DepositReceived {
                deal_id,
                account: &sender_id,
                amount,
                is_buyer: true,
            });
        } else if sender_id == deal.seller {
            let required = deal.seller_collateral;
            require!(
                deal.seller_deposited + amt <= required,
                "Exceeds required seller deposit"
            );
            deal.seller_deposited += amt;
            emit_event(ConpiEvent::DepositReceived {
                deal_id,
                account: &sender_id,
                amount,
                is_buyer: false,
            });
        } else {
            env::panic_str("Sender is neither buyer nor seller for this deal");
        }

        self.check_and_transition_funded(&mut deal);
        self.deals.insert(&deal_id, &deal);

        PromiseOrValue::Value(U128(0))
    }

    /* -------------------------------------------------------------------------
       DEAL LIFECYCLE (ACTIVATION, STAGED RELEASE, CHECKPOINTS, DEFAULT)
    ------------------------------------------------------------------------- */

    /// TEE verifies the real API key and signs an ACTIVATE payload.
    pub fn activate(&mut self, deal_id: u64, payload: SignedPayload, sig: Vec<u8>) {
        let mut deal = self.get_deal_or_panic(deal_id);
        require!(
            deal.status == DealStatus::Funded,
            "Deal must be in Funded status to activate"
        );
        require!(
            env::block_timestamp() <= deal.key_deadline,
            "Key submission deadline has passed"
        );

        // Verify TEE signature on ACTIVATE payload
        CryptoHelper::verify_signed_payload(
            &payload,
            &sig,
            &deal.tee_pubkey,
            &deal,
            &env::current_account_id(),
            PayloadKind::Activate,
        );

        let now = env::block_timestamp();
        deal.status = DealStatus::Active;
        deal.usage_deadline = now + self.config.default_usage_duration;
        deal.last_nonce = payload.nonce;
        deal.last_tee_seen = now;

        self.deals.insert(&deal_id, &deal);

        emit_event(ConpiEvent::DealActivated {
            deal_id,
            usage_deadline: deal.usage_deadline,
        });
    }

    /// Releases payment to the seller in stages: 25%, 50%, 75%, 100%.
    pub fn release_stage(
        &mut self,
        deal_id: u64,
        stage: u8,
        payload: SignedPayload,
        sig: Vec<u8>,
    ) {
        let mut deal = self.get_deal_or_panic(deal_id);
        require!(
            deal.status == DealStatus::Active,
            "Deal must be Active for stage release"
        );
        require!(
            stage > deal.stage_reached,
            "Stage must be strictly greater than stage_reached"
        );
        require!(
            payload.stage == stage,
            "Payload stage must match parameter"
        );

        CryptoHelper::verify_signed_payload(
            &payload,
            &sig,
            &deal.tee_pubkey,
            &deal,
            &env::current_account_id(),
            PayloadKind::Stage,
        );

        let incremental_payout = SettlementCalculator::calculate_stage_payout(&deal, stage);
        deal.released_to_seller += incremental_payout;
        deal.stage_reached = stage;
        deal.last_nonce = payload.nonce;
        deal.last_signed = Some(SignedState {
            stage,
            metered_value: payload.metered_value,
            nonce: payload.nonce,
            issued_at: payload.issued_at,
        });
        deal.last_tee_seen = env::block_timestamp();

        if stage == 100 {
            deal.status = DealStatus::Completed;
            // Transfer incremental payout + seller collateral to seller
            let total_to_seller = incremental_payout + deal.seller_collateral;
            self.payout(&deal.seller, total_to_seller, &deal.token);
            // Return buyer collateral to buyer
            self.payout(&deal.buyer, deal.buyer_collateral, &deal.token);

            emit_event(ConpiEvent::DealCompleted {
                deal_id,
                seller_total: U128(deal.released_to_seller + deal.seller_collateral),
            });
        } else {
            self.payout(&deal.seller, incremental_payout, &deal.token);
        }

        self.deals.insert(&deal_id, &deal);

        emit_event(ConpiEvent::StageReleased {
            deal_id,
            stage,
            amount_released: U128(incremental_payout),
            cumulative_released: U128(deal.released_to_seller),
        });
    }

    /// Records a signed checkpoint between stages for offline fallback protection.
    pub fn checkpoint(&mut self, deal_id: u64, payload: SignedPayload, sig: Vec<u8>) {
        let mut deal = self.get_deal_or_panic(deal_id);
        require!(
            deal.status == DealStatus::Active,
            "Deal must be Active to record checkpoint"
        );

        CryptoHelper::verify_signed_payload(
            &payload,
            &sig,
            &deal.tee_pubkey,
            &deal,
            &env::current_account_id(),
            PayloadKind::Checkpoint,
        );

        let now = env::block_timestamp();
        deal.last_nonce = payload.nonce;
        deal.last_signed = Some(SignedState {
            stage: deal.stage_reached,
            metered_value: payload.metered_value,
            nonce: payload.nonce,
            issued_at: payload.issued_at,
        });
        deal.last_tee_seen = now;

        self.deals.insert(&deal_id, &deal);

        emit_event(ConpiEvent::CheckpointRecorded {
            deal_id,
            metered_value: payload.metered_value,
            nonce: payload.nonce,
        });
    }

    /// TEE detects dead-key / default (invalid key, insufficient quota, ban) and signs default.
    pub fn settle_default(&mut self, deal_id: u64, payload: SignedPayload, sig: Vec<u8>) {
        let mut deal = self.get_deal_or_panic(deal_id);
        require!(
            deal.status == DealStatus::Active || deal.status == DealStatus::Funded,
            "Deal must be Active or Funded to settle default"
        );

        CryptoHelper::verify_signed_payload(
            &payload,
            &sig,
            &deal.tee_pubkey,
            &deal,
            &env::current_account_id(),
            PayloadKind::Default,
        );

        let reason = payload
            .reason
            .expect("Default payload must include reason");

        let distribution = SettlementCalculator::calculate_default_settlement(
            &deal,
            payload.metered_value.0,
            reason,
        );

        deal.status = DealStatus::Defaulted;
        deal.last_nonce = payload.nonce;
        deal.last_tee_seen = env::block_timestamp();

        // Execute distributions
        if distribution.seller_payout > 0 {
            self.payout(&deal.seller, distribution.seller_payout, &deal.token);
        }
        if distribution.buyer_refund > 0 {
            self.payout(&deal.buyer, distribution.buyer_refund, &deal.token);
        }

        self.deals.insert(&deal_id, &deal);

        emit_event(ConpiEvent::DealDefaulted {
            deal_id,
            reason: match reason {
                DefaultReason::InvalidKey => "INVALID_KEY",
                DefaultReason::InsufficientQuota => "INSUFFICIENT_QUOTA",
                DefaultReason::KeyNotSubmitted => "KEY_NOT_SUBMITTED",
                DefaultReason::ValidationFailed => "VALIDATION_FAILED",
                DefaultReason::ProviderBan => "PROVIDER_BAN",
            },
            seller_payout: U128(distribution.seller_payout),
            buyer_refund: U128(distribution.buyer_refund),
            slashed_collateral: U128(distribution.slashed_collateral),
        });
    }

    /* -------------------------------------------------------------------------
       TIMEOUTS & FALLBACKS
    ------------------------------------------------------------------------- */

    /// Handles timeouts:
    /// 1. If in Created and deposit deadline passed -> Cancel and refund deposits.
    /// 2. If in Active and TEE went offline beyond liveness timeout -> Settle from last checkpoint.
    pub fn timeout_refund(&mut self, deal_id: u64) {
        let mut deal = self.get_deal_or_panic(deal_id);
        let now = env::block_timestamp();

        match deal.status {
            DealStatus::Created => {
                require!(
                    now > deal.deposit_deadline,
                    "Deposit deadline has not passed yet"
                );
                deal.status = DealStatus::Cancelled;

                if deal.buyer_deposited > 0 {
                    self.payout(&deal.buyer, deal.buyer_deposited, &deal.token);
                }
                if deal.seller_deposited > 0 {
                    self.payout(&deal.seller, deal.seller_deposited, &deal.token);
                }

                self.deals.insert(&deal_id, &deal);
                emit_event(ConpiEvent::DealCancelled {
                    deal_id,
                    reason: "DEPOSIT_TIMEOUT",
                });
            }
            DealStatus::Active => {
                require!(
                    now > deal.last_tee_seen + deal.tee_liveness_timeout,
                    "TEE liveness timeout has not passed yet"
                );
                deal.status = DealStatus::SettledTimeout;

                let checkpoint_metered = deal
                    .last_signed
                    .as_ref()
                    .map(|s| s.metered_value.0)
                    .unwrap_or(0);

                let dist = SettlementCalculator::calculate_timeout_settlement(
                    &deal,
                    checkpoint_metered,
                );

                if dist.seller_payout > 0 {
                    self.payout(&deal.seller, dist.seller_payout, &deal.token);
                }
                if dist.buyer_refund > 0 {
                    self.payout(&deal.buyer, dist.buyer_refund, &deal.token);
                }

                self.deals.insert(&deal_id, &deal);
                emit_event(ConpiEvent::DealSettledTimeout {
                    deal_id,
                    seller_payout: U128(dist.seller_payout),
                    buyer_refund: U128(dist.buyer_refund),
                });
            }
            _ => env::panic_str("Deal is not in a refundable timeout status"),
        }
    }

    /// If buyer does not use credits and 30-day usage deadline passes,
    /// remaining price + collaterals are released.
    pub fn auto_release(&mut self, deal_id: u64) {
        let mut deal = self.get_deal_or_panic(deal_id);
        require!(
            deal.status == DealStatus::Active,
            "Deal must be Active for auto-release"
        );
        require!(
            env::block_timestamp() > deal.usage_deadline,
            "Usage deadline has not passed yet"
        );

        deal.status = DealStatus::Completed;

        let remaining_price = deal.price.saturating_sub(deal.released_to_seller);
        let total_to_seller = remaining_price + deal.seller_collateral;

        if total_to_seller > 0 {
            self.payout(&deal.seller, total_to_seller, &deal.token);
        }
        if deal.buyer_collateral > 0 {
            self.payout(&deal.buyer, deal.buyer_collateral, &deal.token);
        }

        self.deals.insert(&deal_id, &deal);

        emit_event(ConpiEvent::DealCompleted {
            deal_id,
            seller_total: U128(deal.released_to_seller + total_to_seller),
        });
    }

    /* -------------------------------------------------------------------------
       VIEW METHODS
    ------------------------------------------------------------------------- */

    pub fn get_deal(&self, deal_id: u64) -> Option<Deal> {
        self.deals.get(&deal_id)
    }

    pub fn list_deals(&self, from_index: Option<u64>, limit: Option<u64>) -> Vec<Deal> {
        let start = from_index.unwrap_or(0) as usize;
        let lim = limit.unwrap_or(50) as usize;
        self.all_deal_ids
            .iter()
            .skip(start)
            .take(lim)
            .filter_map(|id| self.deals.get(id))
            .collect()
    }

    pub fn get_tee_signer(&self, public_key: PublicKey) -> Option<TeeSigner> {
        self.tee_signers.get(&public_key)
    }

    pub fn get_config(&self) -> Config {
        self.config.clone()
    }

    /* -------------------------------------------------------------------------
       INTERNAL HELPERS
    ------------------------------------------------------------------------- */

    fn get_deal_or_panic(&self, deal_id: u64) -> Deal {
        self.deals.get(&deal_id).expect("Deal not found")
    }

    fn assert_owner(&self) {
        require!(
            env::predecessor_account_id() == self.owner,
            "Only contract owner can call this method"
        );
    }

    fn check_and_transition_funded(&mut self, deal: &mut Deal) {
        let buyer_required = deal.price + deal.buyer_collateral;
        let seller_required = deal.seller_collateral;

        if deal.buyer_deposited >= buyer_required
            && deal.seller_deposited >= seller_required
            && deal.terms_hash.is_some()
        {
            deal.status = DealStatus::Funded;
            emit_event(ConpiEvent::DealFunded { deal_id: deal.id });
        }
    }

    fn payout(&self, recipient: &AccountId, amount: Balance, token: &Option<AccountId>) {
        if amount == 0 {
            return;
        }
        match token {
            None => {
                // Native NEAR transfer
                let _ = Promise::new(recipient.clone())
                    .transfer(near_sdk::NearToken::from_yoctonear(amount));
            }
            Some(token_account) => {
                // NEP-141 ft_transfer function call
                let args = near_sdk::serde_json::json!({
                    "receiver_id": recipient,
                    "amount": U128(amount),
                    "msg": ""
                })
                .to_string()
                .into_bytes();

                let _ = Promise::new(token_account.clone()).function_call(
                    "ft_transfer".to_string(),
                    args,
                    near_sdk::NearToken::from_yoctonear(ONE_YOCTO),
                    GAS_FOR_FT_TRANSFER,
                );
            }
        }
    }
}
