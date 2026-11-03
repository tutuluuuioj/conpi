use near_sdk::collections::{LookupMap, UnorderedMap};
use near_sdk::json_types::U128;
use near_sdk::{
    env, near, require, AccountId, Duration, Gas, NearToken, PanicOnDefault, Promise,
    PromiseOrValue, PublicKey,
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
    AdminAction, Balance, Config, CreateDealParams, Deal, DealId, DealStatus, DefaultReason,
    PayloadKind, SignedPayload, SignedState, StagedAction, TeeSigner,
};

const GAS_FOR_FT_TRANSFER: Gas = Gas::from_tgas(20);
const GAS_FOR_RESOLVE_TRANSFER: Gas = Gas::from_tgas(10);
const ONE_YOCTO: Balance = 1;

#[near(contract_state)]
#[derive(PanicOnDefault)]
pub struct ConpiEscrow {
    pub owner: AccountId,
    pub chain_id: String,
    pub paused: bool,
    pub tee_signers: UnorderedMap<PublicKey, TeeSigner>,
    pub deals: LookupMap<DealId, Deal>,
    pub deal_creators: LookupMap<DealId, AccountId>,
    pub pending_payouts: LookupMap<(AccountId, Option<AccountId>), Balance>,
    pub next_deal_id: u64,
    pub config: Config,
    pub next_proposal_id: u64,
    pub staged_proposals: UnorderedMap<u64, StagedAction>,
    pub timelock_duration: Duration,
    pub state_version: u32,
}

#[near]
impl ConpiEscrow {
    #[init]
    pub fn new(
        owner: AccountId,
        chain_id: Option<String>,
        config: Option<Config>,
        initial_tee_signer: Option<(PublicKey, String)>,
        timelock_duration: Option<u64>,
    ) -> Self {
        require!(!env::state_exists(), "Already initialized");
        let mut contract = Self {
            owner,
            chain_id: chain_id.unwrap_or_else(|| "testnet".to_string()),
            paused: false,
            tee_signers: UnorderedMap::new(b"t"),
            deals: LookupMap::new(b"d"),
            deal_creators: LookupMap::new(b"c"),
            pending_payouts: LookupMap::new(b"p"),
            next_deal_id: 1,
            config: config.unwrap_or_default(),
            next_proposal_id: 1,
            staged_proposals: UnorderedMap::new(b"s"),
            timelock_duration: timelock_duration.unwrap_or(172_800_000_000_000), // 48-hour default timelock
            state_version: 1,
        };

        if let Some((pk, measurement)) = initial_tee_signer {
            contract.tee_signers.insert(
                &pk,
                &TeeSigner {
                    measurement,
                    registered_at: env::block_timestamp(),
                    active: true,
                },
            );
        }

        contract
    }

    /* -------------------------------------------------------------------------
       TIMELOCKED GOVERNANCE (48-HOUR DELAY FOR ALL ADMIN ACTIONS)
    ------------------------------------------------------------------------- */

    pub fn set_paused(&mut self, paused: bool) {
        self.assert_owner();
        if paused {
            self.paused = true;
            env::log_str("Contract paused by owner in emergency circuit-breaker mode");
        } else {
            env::panic_str("Unpausing requires timelocked governance via propose_admin_action(AdminAction::Unpause)");
        }
    }

    /// Proposes an administrative action (update config, add/revoke signer, transfer ownership, upgrade, unpause).
    /// Enforces a strict 48-hour delay before execution can take place.
    pub fn propose_admin_action(&mut self, action: AdminAction) -> u64 {
        self.assert_owner();

        // Validate action invariants upfront before staging
        match &action {
            AdminAction::UpdateConfig { config } => {
                Self::validate_config(config);
            }
            AdminAction::AddTeeSigner { public_key, .. } => {
                CryptoHelper::extract_ed25519_bytes(public_key);
            }
            AdminAction::RevokeTeeSigner { public_key } => {
                require!(
                    self.tee_signers.get(public_key).is_some(),
                    "TEE signer not registered"
                );
            }
            AdminAction::TransferOwnership { new_owner } => {
                require!(new_owner != &self.owner, "New owner must differ from current");
            }
            AdminAction::Upgrade { .. } => {}
            AdminAction::Unpause => {
                require!(self.paused, "Contract is not paused");
            }
        }

        let ready_at = env::block_timestamp() + self.timelock_duration;
        let proposal_id = self.next_proposal_id;
        self.next_proposal_id += 1;

        self.staged_proposals.insert(
            &proposal_id,
            &StagedAction {
                action: action.clone(),
                ready_at,
            },
        );

        let action_type = match &action {
            AdminAction::TransferOwnership { .. } => "TRANSFER_OWNERSHIP",
            AdminAction::UpdateConfig { .. } => "UPDATE_CONFIG",
            AdminAction::AddTeeSigner { .. } => "ADD_TEE_SIGNER",
            AdminAction::RevokeTeeSigner { .. } => "REVOKE_TEE_SIGNER",
            AdminAction::Upgrade { .. } => "UPGRADE",
            AdminAction::Unpause => "UNPAUSE",
        };

        emit_event(ConpiEvent::GovernanceActionProposed {
            proposal_id,
            ready_at,
            action_type,
        });

        proposal_id
    }

    /// Executes a staged administrative action after the 48-hour timelock has elapsed.
    pub fn execute_admin_action(
        &mut self,
        proposal_id: u64,
        code: Option<Vec<u8>>,
    ) -> PromiseOrValue<bool> {
        self.assert_owner();
        let staged = self
            .staged_proposals
            .get(&proposal_id)
            .expect("Proposal not found");

        require!(
            env::block_timestamp() >= staged.ready_at,
            "48-hour timelock delay has not elapsed yet"
        );

        self.staged_proposals.remove(&proposal_id);

        match staged.action {
            AdminAction::TransferOwnership { new_owner } => {
                self.owner = new_owner;
                emit_event(ConpiEvent::GovernanceActionExecuted {
                    proposal_id,
                    action_type: "TRANSFER_OWNERSHIP",
                });
                PromiseOrValue::Value(true)
            }
            AdminAction::UpdateConfig { config } => {
                Self::validate_config(&config);
                self.config = config;
                emit_event(ConpiEvent::GovernanceActionExecuted {
                    proposal_id,
                    action_type: "UPDATE_CONFIG",
                });
                PromiseOrValue::Value(true)
            }
            AdminAction::AddTeeSigner {
                public_key,
                measurement,
            } => {
                self.tee_signers.insert(
                    &public_key,
                    &TeeSigner {
                        measurement,
                        registered_at: env::block_timestamp(),
                        active: true,
                    },
                );
                emit_event(ConpiEvent::GovernanceActionExecuted {
                    proposal_id,
                    action_type: "ADD_TEE_SIGNER",
                });
                PromiseOrValue::Value(true)
            }
            AdminAction::RevokeTeeSigner { public_key } => {
                let mut signer = self
                    .tee_signers
                    .get(&public_key)
                    .expect("TEE signer not registered");
                signer.active = false;
                self.tee_signers.insert(&public_key, &signer);
                emit_event(ConpiEvent::GovernanceActionExecuted {
                    proposal_id,
                    action_type: "REVOKE_TEE_SIGNER",
                });
                PromiseOrValue::Value(true)
            }
            AdminAction::Upgrade { code_hash } => {
                let code_bytes = code.expect("WASM code bytes required for contract upgrade");
                require!(
                    env::sha256_array(&code_bytes) == code_hash,
                    "Code hash mismatch with staged upgrade proposal"
                );

                emit_event(ConpiEvent::GovernanceActionExecuted {
                    proposal_id,
                    action_type: "UPGRADE",
                });

                let prom = Promise::new(env::current_account_id())
                    .deploy_contract(code_bytes)
                    .function_call(
                        "migrate".to_string(),
                        vec![],
                        NearToken::from_yoctonear(0),
                        Gas::from_tgas(30),
                    );
                PromiseOrValue::Promise(prom)
            }
            AdminAction::Unpause => {
                self.paused = false;
                emit_event(ConpiEvent::GovernanceActionExecuted {
                    proposal_id,
                    action_type: "UNPAUSE",
                });
                PromiseOrValue::Value(true)
            }
        }
    }

    pub fn cancel_admin_action(&mut self, proposal_id: u64) {
        self.assert_owner();
        require!(
            self.staged_proposals.get(&proposal_id).is_some(),
            "Proposal not found"
        );
        self.staged_proposals.remove(&proposal_id);
        emit_event(ConpiEvent::GovernanceActionCancelled { proposal_id });
    }

    /// Migration entry point executed immediately after contract code deployment.
    #[private]
    #[init(ignore_state)]
    pub fn migrate() -> Self {
        let prev: ConpiEscrow = env::state_read().expect("Old contract state not found");
        require!(prev.state_version >= 1, "Unsupported contract state version for migration");
        emit_event(ConpiEvent::ContractMigrated);
        Self {
            state_version: prev.state_version + 1,
            ..prev
        }
    }

    pub fn get_staged_proposal(&self, proposal_id: u64) -> Option<StagedAction> {
        self.staged_proposals.get(&proposal_id)
    }

    pub fn list_staged_proposals(&self) -> Vec<(u64, StagedAction)> {
        self.staged_proposals.to_vec()
    }

    /* -------------------------------------------------------------------------
       DEAL CREATION & TERMS VERIFICATION
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

        // Anti-spam storage deposit check & immediate refund of excess
        let attached = env::attached_deposit().as_yoctonear();
        require!(
            attached >= self.config.storage_deposit_fee,
            "Must attach required storage deposit fee"
        );
        let excess = attached - self.config.storage_deposit_fee;
        if excess > 0 {
            let _ = Promise::new(caller.clone()).transfer(NearToken::from_yoctonear(excess));
        }

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
        require!(
            params.slash_bps_buyer_breach <= self.config.max_slash_bps
                && params.slash_bps_buyer_breach >= self.config.min_slash_bps,
            "Buyer breach slash bps out of bounds"
        );

        let now = env::block_timestamp();
        let deal_id = self.next_deal_id;
        self.next_deal_id += 1;

        // Compute canonical terms_hash on-chain directly from parameters
        let terms_hash = CryptoHelper::compute_terms_hash(
            deal_id,
            &params.buyer,
            &params.seller,
            &params.token,
            params.price.0,
            params.credit_amount.0,
            params.buyer_collateral.0,
            params.seller_collateral.0,
            &params.tee_pubkey,
            deposit_duration,
            key_duration,
            liveness_timeout,
            params.slash_bps_provider_ban,
            params.slash_bps_revoke,
            params.slash_bps_buyer_breach,
        );

        let deal = Deal {
            id: deal_id,
            buyer: params.buyer.clone(),
            seller: params.seller.clone(),
            token: params.token.clone(),
            price: params.price.0,
            credit_amount: params.credit_amount.0,
            buyer_collateral: params.buyer_collateral.0,
            seller_collateral: params.seller_collateral.0,
            terms_hash: Some(terms_hash),
            tee_pubkey: params.tee_pubkey,
            deposit_deadline: now + deposit_duration,
            key_deadline: now + deposit_duration + key_duration,
            usage_deadline: 0,
            notice_deadline: None,
            tee_liveness_timeout: liveness_timeout,
            slash_bps_provider_ban: params.slash_bps_provider_ban,
            slash_bps_revoke: params.slash_bps_revoke,
            slash_bps_buyer_breach: params.slash_bps_buyer_breach,
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

    /// Counterparty explicitly verifies and accepts the on-chain terms_hash before funding.
    pub fn accept_deal(&mut self, deal_id: u64, expected_hash: [u8; 32]) {
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

        let computed_hash = deal.terms_hash.expect("Deal terms_hash missing");
        require!(
            computed_hash == expected_hash,
            "expected_hash does not match on-chain terms_hash"
        );

        deal.counterparty_accepted = true;

        self.check_and_transition_funded(&mut deal);
        self.deals.insert(&deal_id, &deal);

        emit_event(ConpiEvent::DealAccepted {
            deal_id,
            account: &caller,
        });
    }

    /// Allows the TEE to submit a signed attestation for the on-chain terms_hash.
    pub fn register_terms_hash(&mut self, deal_id: u64, terms_hash: [u8; 32], sig: Vec<u8>) {
        self.assert_not_paused();
        let mut deal = self.get_deal_or_panic(deal_id);
        require!(
            deal.status == DealStatus::Created,
            "Deal must be in Created status"
        );
        let expected = deal.terms_hash.expect("Deal terms_hash missing");
        require!(
            terms_hash == expected,
            "Submitted terms_hash does not match on-chain deal terms"
        );

        self.assert_active_tee_signer(&deal.tee_pubkey);

        let msg_bytes = CryptoHelper::build_terms_message(
            &self.chain_id,
            &env::current_account_id(),
            deal_id,
            &terms_hash,
        );

        let is_valid =
            CryptoHelper::verify_signature_raw(&msg_bytes, &sig, &deal.tee_pubkey);
        require!(is_valid, "Invalid TEE signature on terms_hash");

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
        if self.paused {
            env::log_str("ft_on_transfer: Contract paused, refunding tokens");
            return PromiseOrValue::Value(amount);
        }

        let token_account = env::predecessor_account_id();

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

        self.assert_active_tee_signer(&deal.tee_pubkey);

        CryptoHelper::verify_signed_payload(
            &payload,
            &sig,
            &deal.tee_pubkey,
            &deal,
            &env::current_account_id(),
            &self.chain_id,
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
            &self.chain_id,
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

        // Fresh usage pushes usage_deadline forward and clears any pending auto-release notice
        deal.usage_deadline = env::block_timestamp() + self.config.default_usage_duration;
        deal.notice_deadline = None;

        if stage == 100 {
            deal.status = DealStatus::Completed;
            let total_to_seller = incremental_payout + deal.seller_collateral;
            let _ = self.payout(&deal.seller, total_to_seller, &deal.token);
            let _ = self.payout(&deal.buyer, deal.buyer_collateral, &deal.token);

            self.refund_storage_deposit(deal_id);

            emit_event(ConpiEvent::DealCompleted {
                deal_id,
                seller_total: U128(deal.released_to_seller + deal.seller_collateral),
            });
        } else {
            let _ = self.payout(&deal.seller, incremental_payout, &deal.token);
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
            &self.chain_id,
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

        // Fresh usage checkpoint pushes usage_deadline forward and clears any auto-release notice
        deal.usage_deadline = now + self.config.default_usage_duration;
        deal.notice_deadline = None;

        self.deals.insert(&deal_id, &deal);

        emit_event(ConpiEvent::CheckpointRecorded {
            deal_id,
            metered_value: payload.metered_value,
            nonce: payload.nonce,
        });
    }

    /// Settle default is NEVER blocked by contract pause so parties can always settle infractions.
    pub fn settle_default(&mut self, deal_id: u64, payload: SignedPayload, sig: Vec<u8>) {
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
            &self.chain_id,
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
            let _ = self.payout(&deal.seller, distribution.seller_payout, &deal.token);
        }
        if distribution.buyer_refund > 0 {
            let _ = self.payout(&deal.buyer, distribution.buyer_refund, &deal.token);
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
                DefaultReason::BuyerBreach => "BUYER_BREACH",
            },
            seller_payout: U128(distribution.seller_payout),
            buyer_refund: U128(distribution.buyer_refund),
            slashed_collateral: U128(distribution.slashed_collateral),
        });
    }

    /* -------------------------------------------------------------------------
       TIMEOUTS & SAFE FALLBACKS (NEVER BLOCKED BY PAUSE)
    ------------------------------------------------------------------------- */

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
                    let _ = self.payout(&deal.buyer, deal.buyer_deposited, &deal.token);
                }
                if deal.seller_deposited > 0 {
                    let _ = self.payout(&deal.seller, deal.seller_deposited, &deal.token);
                }

                self.refund_storage_deposit(deal_id);
                self.deals.insert(&deal_id, &deal);
                emit_event(ConpiEvent::DealCancelled {
                    deal_id,
                    reason: "DEPOSIT_TIMEOUT",
                });
            }
            DealStatus::Funded => {
                require!(
                    now > deal.key_deadline,
                    "Key submission deadline has not passed yet"
                );
                deal.status = DealStatus::Cancelled;

                if deal.buyer_deposited > 0 {
                    let _ = self.payout(&deal.buyer, deal.buyer_deposited, &deal.token);
                }
                if deal.seller_deposited > 0 {
                    let _ = self.payout(&deal.seller, deal.seller_deposited, &deal.token);
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
                    let _ = self.payout(&deal.seller, dist.seller_payout, &deal.token);
                }
                if dist.buyer_refund > 0 {
                    let _ = self.payout(&deal.buyer, dist.buyer_refund, &deal.token);
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

    pub fn request_auto_release(&mut self, deal_id: u64) {
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

    pub fn finalize_auto_release(&mut self, deal_id: u64) {
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
            let _ = self.payout(&deal.seller, total_to_seller, &deal.token);
        }
        if deal.buyer_collateral > 0 {
            let _ = self.payout(&deal.buyer, deal.buyer_collateral, &deal.token);
        }

        self.refund_storage_deposit(deal_id);
        self.deals.insert(&deal_id, &deal);

        emit_event(ConpiEvent::DealCompleted {
            deal_id,
            seller_total: U128(deal.released_to_seller + total_to_seller),
        });
    }

    /* -------------------------------------------------------------------------
       CLAIM PENDING PAYOUTS (PULL-PAYMENT SAFEGUARD - NEVER BLOCKED BY PAUSE)
    ------------------------------------------------------------------------- */

    pub fn claim(&mut self, token: Option<AccountId>) -> PromiseOrValue<U128> {
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

        PromiseOrValue::Promise(self.payout(&caller, amount, &token))
    }

    /* -------------------------------------------------------------------------
       TRANSFER CALLBACK (RECOVERY TO PENDING PAYOUTS ON FAILURE)
    ------------------------------------------------------------------------- */

    #[private]
    pub fn on_transfer_resolved(
        &mut self,
        recipient: AccountId,
        amount: U128,
        token: Option<AccountId>,
    ) -> bool {
        let is_success = if env::promise_results_count() > 0 {
            env::promise_result_checked(0, 1024).is_ok()
        } else {
            false
        };

        if !is_success {
            env::log_str(&format!(
                "Transfer of {} to {} failed. Crediting to pending_payouts for pull-claim.",
                amount.0, recipient
            ));
            let key = (recipient.clone(), token.clone());
            let current = self.pending_payouts.get(&key).unwrap_or(0);
            let updated = current.checked_add(amount.0).expect("pending_payout overflow");
            self.pending_payouts.insert(&key, &updated);

            emit_event(ConpiEvent::TransferFailedCredited {
                account: &recipient,
                token: &token,
                amount,
            });
            false
        } else {
            true
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

    pub fn get_chain_id(&self) -> String {
        self.chain_id.clone()
    }

    pub fn get_owner(&self) -> AccountId {
        self.owner.clone()
    }

    pub fn get_state_version(&self) -> u32 {
        self.state_version
    }

    pub fn get_timelock_duration(&self) -> u64 {
        self.timelock_duration
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
                let _ = self.payout(&creator, fee, &None);
            }
        }
    }

    fn payout(&self, recipient: &AccountId, amount: Balance, token: &Option<AccountId>) -> Promise {
        if amount == 0 {
            return Promise::new(env::current_account_id());
        }
        match token {
            None => Promise::new(recipient.clone())
                .transfer(NearToken::from_yoctonear(amount))
                .then(
                    Self::ext(env::current_account_id())
                        .with_static_gas(GAS_FOR_RESOLVE_TRANSFER)
                        .on_transfer_resolved(recipient.clone(), U128(amount), None),
                ),
            Some(token_account) => {
                let args = near_sdk::serde_json::json!({
                    "receiver_id": recipient,
                    "amount": U128(amount),
                    "memo": "Conpi settlement transfer"
                })
                .to_string()
                .into_bytes();

                Promise::new(token_account.clone())
                    .function_call(
                        "ft_transfer".to_string(),
                        args,
                        NearToken::from_yoctonear(ONE_YOCTO),
                        GAS_FOR_FT_TRANSFER,
                    )
                    .then(
                        Self::ext(env::current_account_id())
                            .with_static_gas(GAS_FOR_RESOLVE_TRANSFER)
                            .on_transfer_resolved(
                                recipient.clone(),
                                U128(amount),
                                Some(token_account.clone()),
                            ),
                    )
            }
        }
    }

    fn validate_config(config: &Config) {
        require!(
            config.storage_deposit_fee >= 10_000_000_000_000_000_000_000,
            "storage_deposit_fee must be at least 0.01 NEAR"
        );
        require!(
            config.min_slash_bps >= 500 && config.max_slash_bps <= 10_000,
            "min_slash_bps must be >= 500 (5%) and max_slash_bps <= 10,000 (100%)"
        );
        require!(
            config.min_slash_bps <= config.max_slash_bps,
            "min_slash_bps must be <= max_slash_bps"
        );
        require!(
            config.min_deposit_duration >= 60_000_000_000,
            "min_deposit_duration must be at least 60 seconds"
        );
        require!(
            config.min_deposit_duration <= config.max_deposit_duration,
            "min_deposit_duration must be <= max_deposit_duration"
        );
        require!(
            config.min_tee_liveness_timeout >= 60_000_000_000,
            "min_tee_liveness_timeout must be at least 60 seconds"
        );
        require!(
            config.default_usage_duration >= 86_400_000_000_000,
            "default_usage_duration must be at least 1 day"
        );
        require!(
            config.notice_period_duration >= 3_600_000_000_000,
            "notice_period_duration must be at least 1 hour"
        );
    }
}
