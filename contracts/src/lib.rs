use near_sdk::collections::{LookupMap, UnorderedMap};
use near_sdk::json_types::U128;
use near_sdk::{
    env, near, require, AccountId, Gas, NearToken, PanicOnDefault, Promise, PromiseOrValue,
    PublicKey,
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

const GAS_FOR_FT_TRANSFER: Gas = Gas::from_tgas(30);
const ONE_YOCTO: Balance = 1;

#[near(contract_state)]
#[derive(PanicOnDefault)]
pub struct ConpiEscrow {
    pub owner: AccountId,
    pub paused: bool,
    pub tee_signers: UnorderedMap<PublicKey, TeeSigner>,
    pub deals: LookupMap<DealId, Deal>,
    pub deal_creators: LookupMap<DealId, AccountId>,
    pub pending_payouts: LookupMap<(AccountId, Option<AccountId>), Balance>,
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
            paused: false,
            tee_signers: UnorderedMap::new(b"t"),
            deals: LookupMap::new(b"d"),
            deal_creators: LookupMap::new(b"c"),
            pending_payouts: LookupMap::new(b"p"),
            next_deal_id: 1,
            config: config.unwrap_or_default(),
        }
    }

    /* -------------------------------------------------------------------------
       ADMIN METHODS
    ------------------------------------------------------------------------- */

    pub fn transfer_ownership(&mut self, new_owner: AccountId) {
        self.assert_owner();
        self.owner = new_owner;
    }

    pub fn set_paused(&mut self, paused: bool) {
        self.assert_owner();
        self.paused = paused;
    }

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
        require!(
            config.min_deposit_duration <= config.max_deposit_duration,
            "min_deposit_duration must be <= max_deposit_duration"
        );
        require!(
            config.min_slash_bps <= config.max_slash_bps && config.max_slash_bps <= 10_000,
            "Invalid slash bounds"
        );
        self.config = config;
    }

    /* -------------------------------------------------------------------------
       DEAL CREATION & TERMS REGISTRATION
    ------------------------------------------------------------------------- */

    #[payable]
    pub fn create_deal(&mut self, params: CreateDealParams) -> u64 {
        self.assert_not_paused();
        let caller = env::predecessor_account_id();
        require!(
            caller == params.buyer || caller == params.seller,
            "Only buyer or seller can create deal"
        );
        require!(params.buyer != params.seller, "Buyer and seller must differ");

        // Anti-spam storage deposit check
        let attached = env::attached_deposit().as_yoctonear();
        require!(
            attached >= self.config.storage_deposit_fee,
            "Must attach required storage deposit fee"
        );

        // Verify specified TEE signer is registered and active
        self.assert_active_tee_signer(&params.tee_pubkey);

        // Safe duration multiplication (prevent u64 overflow)
        let deposit_duration = params
            .deposit_duration_sec
            .checked_mul(1_000_000_000)
            .expect("deposit_duration overflow");
        require!(
            deposit_duration >= self.config.min_deposit_duration
                && deposit_duration <= self.config.max_deposit_duration,
            "Deposit duration out of bounds"
        );

        let key_duration = params
            .key_duration_sec
            .checked_mul(1_000_000_000)
            .expect("key_duration overflow");

        let liveness_timeout = params
            .tee_liveness_timeout_sec
            .checked_mul(1_000_000_000)
            .expect("tee_liveness_timeout overflow");
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
            key_deadline: now + deposit_duration + key_duration,
            usage_deadline: 0,
            notice_deadline: None,
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
            counterparty_accepted: false,
        };

        self.deals.insert(&deal_id, &deal);
        self.deal_creators.insert(&deal_id, &caller);

        emit_event(ConpiEvent::DealCreated {
            deal_id,
            buyer: &params.buyer,
            seller: &params.seller,
            price: params.price,
            token: &params.token,
        });

        deal_id
    }

    /// Counterparty explicitly accepts the deal terms before funding.
    pub fn accept_deal(&mut self, deal_id: u64) {
        self.assert_not_paused();
        let mut deal = self.get_deal_or_panic(deal_id);
        require!(
            deal.status == DealStatus::Created,
            "Deal must be in Created status"
        );
        let caller = env::predecessor_account_id();
        let creator = self.deal_creators.get(&deal_id).expect("Creator not found");
        let counterparty = if creator == deal.buyer {
            &deal.seller
        } else {
            &deal.buyer
        };

        require!(
            &caller == counterparty,
            "Only counterparty can accept this deal"
        );
        deal.counterparty_accepted = true;

        self.check_and_transition_funded(&mut deal);
        self.deals.insert(&deal_id, &deal);

        emit_event(ConpiEvent::DealAccepted {
            deal_id,
            account: &caller,
        });
    }

    /// Registers the canonical terms_hash verified and signed by the TEE.
    pub fn register_terms_hash(&mut self, deal_id: u64, terms_hash: [u8; 32], sig: Vec<u8>) {
        self.assert_not_paused();
        let mut deal = self.get_deal_or_panic(deal_id);
        require!(
            deal.status == DealStatus::Created,
            "Deal must be in Created status"
        );
        require!(deal.terms_hash.is_none(), "terms_hash already registered");

        // Verify TEE signer is still active
        self.assert_active_tee_signer(&deal.tee_pubkey);

        // Build canonical terms message: "conpi:v1:terms:" + chain_id + contract_id + deal_id + terms_hash
        let msg_bytes = CryptoHelper::build_terms_message(
            &self.config.chain_id,
            &env::current_account_id(),
            deal_id,
            &terms_hash,
        );

        let is_valid =
            CryptoHelper::verify_signature_raw(&msg_bytes, &sig, &deal.tee_pubkey);
        require!(is_valid, "Invalid TEE signature on terms_hash");

        deal.terms_hash = Some(terms_hash);
        deal.last_tee_seen = env::block_timestamp();

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
        self.assert_not_paused();
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

        // Depositing signals counterparty agreement
        let creator = self.deal_creators.get(&deal_id).unwrap_or(deal.buyer.clone());
        if caller != creator {
            deal.counterparty_accepted = true;
        }

        self.check_and_transition_funded(&mut deal);
        self.deals.insert(&deal_id, &deal);
    }

    /// Production-grade NEP-141 token receiver callback.
    pub fn ft_on_transfer(
        &mut self,
        sender_id: AccountId,
        amount: U128,
        msg: String,
    ) -> PromiseOrValue<U128> {
        let token_account = env::predecessor_account_id();

        // 1. Robust message parsing: support JSON {"deal_id": 123}, number 123, or string "123"
        let deal_id: u64 = if let Ok(val) = near_sdk::serde_json::from_str::<serde_json::Value>(&msg) {
            if let Some(obj) = val.as_object() {
                if let Some(id) = obj.get("deal_id") {
                    id.as_u64()
                        .or_else(|| id.as_str().and_then(|s| s.parse::<u64>().ok()))
                        .unwrap_or(0)
                } else {
                    0
                }
            } else if let Some(num) = val.as_u64() {
                num
            } else if let Some(str_val) = val.as_str() {
                str_val.parse::<u64>().unwrap_or(0)
            } else {
                0
            }
        } else {
            msg.trim().parse::<u64>().unwrap_or(0)
        };

        if deal_id == 0 {
            env::log_str("ft_on_transfer: Invalid deal_id in msg, refunding full amount");
            return PromiseOrValue::Value(amount);
        }

        let mut deal = match self.deals.get(&deal_id) {
            Some(d) => d,
            None => {
                env::log_str("ft_on_transfer: Deal not found, refunding full amount");
                return PromiseOrValue::Value(amount);
            }
        };

        if deal.token != Some(token_account.clone()) {
            env::log_str("ft_on_transfer: Token contract mismatch, refunding full amount");
            return PromiseOrValue::Value(amount);
        }

        if deal.status != DealStatus::Created || env::block_timestamp() > deal.deposit_deadline {
            env::log_str("ft_on_transfer: Deal not accepting deposits, refunding full amount");
            return PromiseOrValue::Value(amount);
        }

        let amt = amount.0;
        let refund_amount: u128;

        if sender_id == deal.buyer {
            let required_total = deal.price + deal.buyer_collateral;
            let needed = required_total.saturating_sub(deal.buyer_deposited);
            let accepted = std::cmp::min(amt, needed);
            refund_amount = amt.saturating_sub(accepted);

            deal.buyer_deposited += accepted;
            emit_event(ConpiEvent::DepositReceived {
                deal_id,
                account: &sender_id,
                amount: U128(accepted),
                is_buyer: true,
            });
        } else if sender_id == deal.seller {
            let required_total = deal.seller_collateral;
            let needed = required_total.saturating_sub(deal.seller_deposited);
            let accepted = std::cmp::min(amt, needed);
            refund_amount = amt.saturating_sub(accepted);

            deal.seller_deposited += accepted;
            emit_event(ConpiEvent::DepositReceived {
                deal_id,
                account: &sender_id,
                amount: U128(accepted),
                is_buyer: false,
            });
        } else {
            env::log_str("ft_on_transfer: Sender is neither buyer nor seller, refunding full amount");
            return PromiseOrValue::Value(amount);
        }

        let creator = self.deal_creators.get(&deal_id).unwrap_or(deal.buyer.clone());
        if sender_id != creator {
            deal.counterparty_accepted = true;
        }

        self.check_and_transition_funded(&mut deal);
        self.deals.insert(&deal_id, &deal);

        PromiseOrValue::Value(U128(refund_amount))
    }

    /* -------------------------------------------------------------------------
       DEAL LIFECYCLE (ACTIVATION, STAGED RELEASE, CHECKPOINTS, DEFAULT)
    ------------------------------------------------------------------------- */

    pub fn activate(&mut self, deal_id: u64, payload: SignedPayload, sig: Vec<u8>) {
        self.assert_not_paused();
        let mut deal = self.get_deal_or_panic(deal_id);
        require!(
            deal.status == DealStatus::Funded,
            "Deal must be in Funded status to activate"
        );
        require!(
            env::block_timestamp() <= deal.key_deadline,
            "Key submission deadline has passed"
        );

        // Verify TEE signer is active
        self.assert_active_tee_signer(&deal.tee_pubkey);

        CryptoHelper::verify_signed_payload(
            &payload,
            &sig,
            &deal.tee_pubkey,
            &deal,
            &env::current_account_id(),
            &self.config.chain_id,
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

    pub fn release_stage(
        &mut self,
        deal_id: u64,
        stage: u8,
        payload: SignedPayload,
        sig: Vec<u8>,
    ) {
        self.assert_not_paused();
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

        // Enforce that metered_value is at least the fraction for this stage
        let required_metered = (stage as u128 * deal.credit_amount) / 100;
        require!(
            payload.metered_value.0 >= required_metered,
            "Metered value is below threshold for this stage"
        );

        self.assert_active_tee_signer(&deal.tee_pubkey);

        CryptoHelper::verify_signed_payload(
            &payload,
            &sig,
            &deal.tee_pubkey,
            &deal,
            &env::current_account_id(),
            &self.config.chain_id,
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
            let total_to_seller = incremental_payout + deal.seller_collateral;
            self.payout(&deal.seller, total_to_seller, &deal.token);
            self.payout(&deal.buyer, deal.buyer_collateral, &deal.token);

            // Refund storage deposit fee to creator
            self.refund_storage_deposit(deal_id);

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

    pub fn checkpoint(&mut self, deal_id: u64, payload: SignedPayload, sig: Vec<u8>) {
        self.assert_not_paused();
        let mut deal = self.get_deal_or_panic(deal_id);
        require!(
            deal.status == DealStatus::Active,
            "Deal must be Active to record checkpoint"
        );

        self.assert_active_tee_signer(&deal.tee_pubkey);

        CryptoHelper::verify_signed_payload(
            &payload,
            &sig,
            &deal.tee_pubkey,
            &deal,
            &env::current_account_id(),
            &self.config.chain_id,
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

    pub fn settle_default(&mut self, deal_id: u64, payload: SignedPayload, sig: Vec<u8>) {
        self.assert_not_paused();
        let mut deal = self.get_deal_or_panic(deal_id);
        require!(
            deal.status == DealStatus::Active || deal.status == DealStatus::Funded,
            "Deal must be Active or Funded to settle default"
        );

        self.assert_active_tee_signer(&deal.tee_pubkey);

        CryptoHelper::verify_signed_payload(
            &payload,
            &sig,
            &deal.tee_pubkey,
            &deal,
            &env::current_account_id(),
            &self.config.chain_id,
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

        if distribution.seller_payout > 0 {
            self.payout(&deal.seller, distribution.seller_payout, &deal.token);
        }
        if distribution.buyer_refund > 0 {
            self.payout(&deal.buyer, distribution.buyer_refund, &deal.token);
        }

        self.refund_storage_deposit(deal_id);
        self.deals.insert(&deal_id, &deal);

        emit_event(ConpiEvent::DealDefaulted {
            deal_id,
            reason: match reason {
                DefaultReason::InvalidKey => "INVALID_KEY",
                DefaultReason::InsufficientQuota => "INSUFFICIENT_QUOTA",
                DefaultReason::KeyNotSubmitted => "KEY_NOT_SUBMITTED",
                DefaultReason::ValidationFailed => "VALIDATION_FAILED",
                DefaultReason::ProviderBan => "PROVIDER_BAN",
                DefaultReason::SellerSelfDrain => "SELLER_SELF_DRAIN",
            },
            seller_payout: U128(distribution.seller_payout),
            buyer_refund: U128(distribution.buyer_refund),
            slashed_collateral: U128(distribution.slashed_collateral),
        });
    }

    /* -------------------------------------------------------------------------
       TIMEOUTS & SAFE FALLBACKS
    ------------------------------------------------------------------------- */

    /// Handles timeouts across Created, Funded, and Active deals:
    /// 1. Created: Deposit deadline passed -> Refund both parties, cancel deal.
    /// 2. Funded: Key deadline passed (seller failed to submit key) -> Refund both parties without TEE signature.
    /// 3. Active: TEE went offline beyond liveness timeout -> Settle from last checkpoint.
    pub fn timeout_refund(&mut self, deal_id: u64) {
        self.assert_not_paused();
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

                self.refund_storage_deposit(deal_id);
                self.deals.insert(&deal_id, &deal);
                emit_event(ConpiEvent::DealCancelled {
                    deal_id,
                    reason: "DEPOSIT_TIMEOUT",
                });
            }
            DealStatus::Funded => {
                // Key deadline passed without seller submitting key
                require!(
                    now > deal.key_deadline,
                    "Key submission deadline has not passed yet"
                );
                deal.status = DealStatus::Cancelled;

                if deal.buyer_deposited > 0 {
                    self.payout(&deal.buyer, deal.buyer_deposited, &deal.token);
                }
                if deal.seller_deposited > 0 {
                    self.payout(&deal.seller, deal.seller_deposited, &deal.token);
                }

                self.refund_storage_deposit(deal_id);
                self.deals.insert(&deal_id, &deal);
                emit_event(ConpiEvent::DealCancelled {
                    deal_id,
                    reason: "KEY_DEADLINE_EXPIRED",
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

                self.refund_storage_deposit(deal_id);
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

    /// Step 1 of auto-release: Emits notice after 30-day usage deadline.
    pub fn request_auto_release(&mut self, deal_id: u64) {
        self.assert_not_paused();
        let mut deal = self.get_deal_or_panic(deal_id);
        require!(
            deal.status == DealStatus::Active,
            "Deal must be Active to request auto-release"
        );
        require!(
            env::block_timestamp() > deal.usage_deadline,
            "Usage deadline has not passed yet"
        );
        require!(
            deal.notice_deadline.is_none(),
            "Auto-release notice already active"
        );

        let notice_deadline = env::block_timestamp() + self.config.notice_period_duration;
        deal.notice_deadline = Some(notice_deadline);

        self.deals.insert(&deal_id, &deal);

        emit_event(ConpiEvent::AutoReleaseNotice {
            deal_id,
            notice_deadline,
        });
    }

    /// Step 2 of auto-release: Finalizes release after notice period expires.
    pub fn finalize_auto_release(&mut self, deal_id: u64) {
        self.assert_not_paused();
        let mut deal = self.get_deal_or_panic(deal_id);
        require!(
            deal.status == DealStatus::Active,
            "Deal must be Active for auto-release finalization"
        );
        let notice_deadline = deal
            .notice_deadline
            .expect("Notice period has not been initiated");
        require!(
            env::block_timestamp() > notice_deadline,
            "Notice period has not passed yet"
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

        self.refund_storage_deposit(deal_id);
        self.deals.insert(&deal_id, &deal);

        emit_event(ConpiEvent::DealCompleted {
            deal_id,
            seller_total: U128(deal.released_to_seller + total_to_seller),
        });
    }

    /* -------------------------------------------------------------------------
       CLAIM PENDING PAYOUTS (PULL-PAYMENT SAFEGUARD)
    ------------------------------------------------------------------------- */

    /// Allows any user to claim accumulated pending payouts (e.g. if ft_transfer failed due to storage).
    pub fn claim(&mut self, token: Option<AccountId>) -> PromiseOrValue<U128> {
        self.assert_not_paused();
        let caller = env::predecessor_account_id();
        let key = (caller.clone(), token.clone());
        let amount = self.pending_payouts.get(&key).unwrap_or(0);
        require!(amount > 0, "No pending payouts to claim");

        self.pending_payouts.remove(&key);

        emit_event(ConpiEvent::PendingPayoutClaimed {
            account: &caller,
            token: &token,
            amount: U128(amount),
        });

        match token {
            None => {
                let _ = Promise::new(caller).transfer(NearToken::from_yoctonear(amount));
                PromiseOrValue::Value(U128(amount))
            }
            Some(token_account) => {
                let args = near_sdk::serde_json::json!({
                    "receiver_id": caller,
                    "amount": U128(amount),
                    "memo": "Conpi Claim Payout"
                })
                .to_string()
                .into_bytes();

                let prom = Promise::new(token_account).function_call(
                    "ft_transfer".to_string(),
                    args,
                    NearToken::from_yoctonear(ONE_YOCTO),
                    GAS_FOR_FT_TRANSFER,
                );
                PromiseOrValue::Promise(prom)
            }
        }
    }

    /* -------------------------------------------------------------------------
       VIEW METHODS
    ------------------------------------------------------------------------- */

    pub fn get_deal(&self, deal_id: u64) -> Option<Deal> {
        self.deals.get(&deal_id)
    }

    pub fn list_deals(&self, from_index: Option<u64>, limit: Option<u64>) -> Vec<Deal> {
        let start = from_index.unwrap_or(1);
        let lim = limit.unwrap_or(50);
        let end = std::cmp::min(self.next_deal_id, start + lim);

        (start..end)
            .filter_map(|id| self.deals.get(&id))
            .collect()
    }

    pub fn get_pending_payout(&self, account_id: AccountId, token: Option<AccountId>) -> U128 {
        U128(self.pending_payouts.get(&(account_id, token)).unwrap_or(0))
    }

    pub fn get_tee_signer(&self, public_key: PublicKey) -> Option<TeeSigner> {
        self.tee_signers.get(&public_key)
    }

    pub fn get_config(&self) -> Config {
        self.config.clone()
    }

    pub fn is_paused(&self) -> bool {
        self.paused
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

    fn assert_not_paused(&self) {
        require!(!self.paused, "Contract is currently paused");
    }

    fn assert_active_tee_signer(&self, pk: &PublicKey) {
        let signer = self.tee_signers.get(pk).expect("TEE signer not registered");
        require!(signer.active, "TEE signer is revoked or inactive");
    }

    fn check_and_transition_funded(&mut self, deal: &mut Deal) {
        let buyer_required = deal.price + deal.buyer_collateral;
        let seller_required = deal.seller_collateral;

        if deal.buyer_deposited >= buyer_required
            && deal.seller_deposited >= seller_required
            && deal.terms_hash.is_some()
            && deal.counterparty_accepted
        {
            deal.status = DealStatus::Funded;
            emit_event(ConpiEvent::DealFunded { deal_id: deal.id });
        }
    }

    fn refund_storage_deposit(&mut self, deal_id: u64) {
        if let Some(creator) = self.deal_creators.get(&deal_id) {
            let fee = self.config.storage_deposit_fee;
            if fee > 0 {
                let _ = Promise::new(creator).transfer(NearToken::from_yoctonear(fee));
            }
        }
    }

    fn payout(&self, recipient: &AccountId, amount: Balance, token: &Option<AccountId>) {
        if amount == 0 {
            return;
        }
        match token {
            None => {
                let _ = Promise::new(recipient.clone())
                    .transfer(NearToken::from_yoctonear(amount));
            }
            Some(token_account) => {
                let args = near_sdk::serde_json::json!({
                    "receiver_id": recipient,
                    "amount": U128(amount),
                    "memo": "Conpi settlement transfer"
                })
                .to_string()
                .into_bytes();

                let _ = Promise::new(token_account.clone()).function_call(
                    "ft_transfer".to_string(),
                    args,
                    NearToken::from_yoctonear(ONE_YOCTO),
                    GAS_FOR_FT_TRANSFER,
                );
            }
        }
    }
}
