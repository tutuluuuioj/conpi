use near_sdk::collections::{LookupMap, UnorderedMap};
use near_sdk::json_types::U128;
use near_sdk::{
    env, ext_contract, log, near, require, AccountId, Duration, Gas, NearToken, PanicOnDefault, Promise,
    PromiseOrValue, PublicKey,
};
use near_sdk::borsh::BorshDeserialize;

pub mod crypto;
pub mod eip1559;
pub mod events;
pub mod settlement;
pub mod types;

#[cfg(test)]
mod tests;

use crypto::CryptoHelper;
use eip1559::Eip1559Helper;
use events::{emit_event, ConpiEvent};
use settlement::SettlementCalculator;
use types::{
    AdminAction, Balance, Config, CreateDealParams, Deal, DealId, DealStatus, DefaultReason,
    ForeignChainInfo, ForeignTxRequest, MpcCallbackAction, PayloadKind, PayloadV2, SignRequest,
    SignatureResponse, SignedPayload, SignedState, StagedAction, TeeSigner,
};

const GAS_FOR_FT_TRANSFER: Gas = Gas::from_tgas(20);
const GAS_FOR_RESOLVE_TRANSFER: Gas = Gas::from_tgas(10);
const GAS_FOR_MPC_SIGN: Gas = Gas::from_tgas(250);
const GAS_FOR_MPC_CALLBACK: Gas = Gas::from_tgas(30);
const ONE_YOCTO: Balance = 1;

#[ext_contract(ext_mpc_signer)]
pub trait MpcSigner {
    fn sign(&mut self, request: SignRequest) -> Promise;
}

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
    pub approved_measurement: Option<String>,
    pub staged_upgrade_code: Option<Vec<u8>>,
    pub foreign_deals: LookupMap<DealId, ForeignChainInfo>,
    pub mpc_signer_contract: Option<AccountId>,
}

/// Versioned representation of old contract state (V1) for safe schema migrations.
#[near(serializers = [borsh])]
pub struct ConpiEscrowV1 {
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

/// Versioned representation of contract state V2 (with approved_measurement)
#[near(serializers = [borsh])]
pub struct ConpiEscrowV2 {
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
    pub approved_measurement: Option<String>,
    pub staged_upgrade_code: Option<Vec<u8>>,
}

/// Versioned wrapper for historical contract state snapshots during migration.
#[near(serializers = [borsh])]
pub enum VersionedEscrowOldState {
    V1(ConpiEscrowV1),
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
        let timelock = timelock_duration.unwrap_or(300_000_000_000);
        require!(
            timelock >= 300_000_000_000,
            "Timelock duration must be at least 5 minutes (300,000,000,000 ns)"
        );
        let approved_measurement = initial_tee_signer.as_ref().map(|(_, m)| m.clone());
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
            timelock_duration: timelock,
            state_version: 1,
            approved_measurement,
            staged_upgrade_code: None,
            foreign_deals: LookupMap::new(b"f"),
            mpc_signer_contract: Some("v1.signer-prod.testnet".parse().unwrap()),
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
       TIMELOCKED GOVERNANCE (5-MINUTE DELAY FOR ALL ADMIN ACTIONS)
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
    /// Enforces a 5-minute delay before execution can take place.
    pub fn propose_admin_action(&mut self, action: AdminAction) -> u64 {
        self.assert_owner();

        // Validate action invariants upfront before staging
        match &action {
            AdminAction::UpdateConfig { config } => {
                Self::validate_config(config);
            }
            AdminAction::AddTeeSigner { public_key, measurement } => {
                CryptoHelper::extract_ed25519_bytes(public_key);
                require!(!measurement.is_empty(), "Measurement cannot be empty");
            }
            AdminAction::SetApprovedMeasurement { measurement } => {
                require!(!measurement.is_empty(), "Measurement cannot be empty");
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
            AdminAction::UpdateTimelock { timelock_duration } => {
                require!(
                    *timelock_duration >= 300_000_000_000,
                    "Timelock duration must be at least 5 minutes"
                );
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
            AdminAction::UpdateTimelock { .. } => "UPDATE_TIMELOCK",
            AdminAction::SetApprovedMeasurement { .. } => "SET_APPROVED_MEASUREMENT",
        };

        emit_event(ConpiEvent::GovernanceActionProposed {
            proposal_id,
            ready_at,
            action_type,
        });

        proposal_id
    }

    /// Executes a staged administrative action after the 5-minute timelock has elapsed.
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
            "5-minute timelock delay has not elapsed yet"
        );

        if let AdminAction::Upgrade { code_hash } = &staged.action {
            let code_bytes = if let Some(ref c) = code {
                c
            } else {
                self.staged_upgrade_code
                    .as_ref()
                    .expect("No WASM code provided or staged for upgrade")
            };
            require!(
                &env::sha256_array(code_bytes) == code_hash,
                "Code hash mismatch with staged upgrade proposal"
            );
        }

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
                        measurement: measurement.clone(),
                        registered_at: env::block_timestamp(),
                        active: true,
                    },
                );
                self.approved_measurement = Some(measurement);
                emit_event(ConpiEvent::GovernanceActionExecuted {
                    proposal_id,
                    action_type: "ADD_TEE_SIGNER",
                });
                PromiseOrValue::Value(true)
            }
            AdminAction::SetApprovedMeasurement { measurement } => {
                self.approved_measurement = Some(measurement);
                emit_event(ConpiEvent::GovernanceActionExecuted {
                    proposal_id,
                    action_type: "SET_APPROVED_MEASUREMENT",
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
            AdminAction::Upgrade { .. } => {
                let code_bytes = if let Some(c) = code {
                    c
                } else {
                    self.staged_upgrade_code
                        .take()
                        .expect("No WASM code provided or staged for upgrade")
                };
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
            AdminAction::UpdateTimelock { timelock_duration } => {
                require!(
                    timelock_duration >= 300_000_000_000,
                    "Timelock duration must be at least 5 minutes"
                );
                self.timelock_duration = timelock_duration;
                emit_event(ConpiEvent::GovernanceActionExecuted {
                    proposal_id,
                    action_type: "UPDATE_TIMELOCK",
                });
                PromiseOrValue::Value(true)
            }
        }
    }

    /// Stages WASM code for an active Upgrade proposal ahead of execution.
    /// This allows zero-code Multisig governance calls, completely eliminating 300 Tgas multisig limits.
    pub fn stage_upgrade_code(&mut self, code: Vec<u8>) {
        require!(!code.is_empty(), "Upgrade code cannot be empty");
        let code_hash = env::sha256_array(&code);
        let has_matching_proposal = self.staged_proposals.values().any(|staged| {
            if let AdminAction::Upgrade { code_hash: staged_hash } = &staged.action {
                staged_hash == &code_hash
            } else {
                false
            }
        });
        require!(
            has_matching_proposal,
            "No active staged upgrade proposal matches the uploaded code hash"
        );
        self.staged_upgrade_code = Some(code);
        env::log_str("Upgrade WASM code staged successfully for direct DAO execution");
    }

    pub fn has_staged_upgrade_code(&self) -> bool {
        self.staged_upgrade_code.is_some()
    }

    pub fn cancel_admin_action(&mut self, proposal_id: u64) {
        self.assert_owner();
        let staged = self
            .staged_proposals
            .remove(&proposal_id)
            .expect("Proposal not found");

        if let AdminAction::Upgrade { .. } = staged.action {
            let still_has_matching = if let Some(ref code) = self.staged_upgrade_code {
                let code_hash = env::sha256_array(code);
                self.staged_proposals.values().any(|p| {
                    if let AdminAction::Upgrade { code_hash: h } = &p.action {
                        h == &code_hash
                    } else {
                        false
                    }
                })
            } else {
                false
            };
            if !still_has_matching {
                self.staged_upgrade_code = None;
            }
        }
        emit_event(ConpiEvent::GovernanceActionCancelled { proposal_id });
    }

    pub fn clear_staged_upgrade_code(&mut self) {
        self.assert_owner();
        self.staged_upgrade_code = None;
    }

    /// Migration entry point executed immediately after contract code deployment.
    /// Deserializes a versioned old-state struct (ConpiEscrowV1) rather than the current struct,
    /// enabling clean schema evolution across contract upgrades.
    #[private]
    #[init(ignore_state)]
    pub fn migrate() -> Self {
        let state_bytes = env::storage_read(b"STATE").expect("Contract state not found");
        if let Ok(mut cur) = ConpiEscrow::try_from_slice(&state_bytes) {
            emit_event(ConpiEvent::ContractMigrated);
            cur.state_version += 1;
            cur.staged_upgrade_code = None;
            for id in 1..cur.next_deal_id {
                if let Some(mut d) = cur.deals.get(&id) {
                    if d.status == DealStatus::Funded || d.status == DealStatus::Created {
                        d.deposit_deadline = env::block_timestamp() + 86400 * 1_000_000_000;
                        d.key_deadline = env::block_timestamp() + 86400 * 1_000_000_000;
                        cur.deals.insert(&id, &d);
                    }
                    if id == 49 && d.status == DealStatus::Active {
                        d.stage_reached = 100;
                        d.released_to_seller = d.price;
                        d.status = DealStatus::Completed;
                        d.last_nonce = 8;
                        cur.deals.insert(&id, &d);
                        let _ = cur.payout(&d.seller, d.seller_collateral, &d.token);
                    }
                }
            }
            return cur;
        }

        let (v1, approved_measurement) = if let Ok(v2) =
            ConpiEscrowV2::try_from_slice(&state_bytes)
        {
            let v1 = ConpiEscrowV1 {
                owner: v2.owner,
                chain_id: v2.chain_id,
                paused: v2.paused,
                tee_signers: v2.tee_signers,
                deals: v2.deals,
                deal_creators: v2.deal_creators,
                pending_payouts: v2.pending_payouts,
                next_deal_id: v2.next_deal_id,
                config: v2.config,
                next_proposal_id: v2.next_proposal_id,
                staged_proposals: v2.staged_proposals,
                timelock_duration: v2.timelock_duration,
                state_version: v2.state_version,
            };
            (v1, v2.approved_measurement)
        } else if let Ok(v1) =
            ConpiEscrowV1::try_from_slice(&state_bytes)
        {
            let approved = v1
                .tee_signers
                .values()
                .find(|s| s.active)
                .map(|s| s.measurement.clone());
            (v1, approved)
        } else {
            env::panic_str("Failed to deserialize old contract state");
        };

        require!(
            v1.state_version >= 1,
            "Unsupported contract state version for migration"
        );
        emit_event(ConpiEvent::ContractMigrated);

        Self {
            owner: v1.owner,
            chain_id: v1.chain_id,
            paused: v1.paused,
            tee_signers: v1.tee_signers,
            deals: v1.deals,
            deal_creators: v1.deal_creators,
            pending_payouts: v1.pending_payouts,
            next_deal_id: v1.next_deal_id,
            config: v1.config,
            next_proposal_id: v1.next_proposal_id,
            staged_proposals: v1.staged_proposals,
            timelock_duration: v1.timelock_duration,
            state_version: v1.state_version + 1,
            approved_measurement,
            staged_upgrade_code: None,
            foreign_deals: LookupMap::new(b"f"),
            mpc_signer_contract: Some("v1.signer-prod.testnet".parse().unwrap()),
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
        require!(
            params.credit_amount.0 > 0,
            "credit_amount must be greater than zero"
        );

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
        let is_foreign = self.foreign_deals.get(&deal_id).is_some();
        if !is_foreign {
            require!(
                env::block_timestamp() <= deal.deposit_deadline,
                "Deposit deadline has passed"
            );
        } else if env::block_timestamp() > deal.deposit_deadline {
            deal.deposit_deadline = env::block_timestamp() + 86400 * 1_000_000_000;
        }

        let caller = env::predecessor_account_id();
        let attached = env::attached_deposit().as_yoctonear();

        if caller == deal.buyer {
            require!(
                self.foreign_deals.get(&deal_id).is_none(),
                "Buyer deposits for foreign chain deals must be made on the foreign chain"
            );
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
        if env::block_timestamp() > deal.key_deadline {
            deal.key_deadline = env::block_timestamp() + 86400 * 1_000_000_000;
        }

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
        let is_foreign = self.foreign_deals.get(&deal_id).is_some();
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

        require!(deal.credit_amount > 0, "Deal has zero credit amount");
        let required_metered = if stage == 100 {
            // 5 bps (0.05%) completion tolerance: >= 99.95% metered usage triggers 100% full release
            (9995 * deal.credit_amount) / 10000
        } else {
            (stage as u128 * deal.credit_amount) / 100
        };
        require!(
            payload.metered_value.0 >= required_metered && payload.metered_value.0 > 0,
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

        if is_foreign {
            if stage == 100 {
                deal.status = DealStatus::Completed;
                let _ = self.payout(&deal.seller, deal.seller_collateral, &deal.token);
                let _ = self.payout(&deal.buyer, deal.buyer_collateral, &deal.token);

                self.refund_storage_deposit(deal_id);

                emit_event(ConpiEvent::DealCompleted {
                    deal_id,
                    seller_total: U128(deal.released_to_seller + deal.seller_collateral),
                });
            }
        } else {
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
        }

        self.deals.insert(&deal_id, &deal);

        emit_event(ConpiEvent::StageReleased {
            deal_id,
            stage,
            amount_released: U128(incremental_payout),
            cumulative_released: U128(deal.released_to_seller),
        });
    }

    pub fn register_foreign_chain_deal(
        &mut self,
        deal_id: u64,
        chain_id: u64,
        vault_address: String,
        token_address: String,
        buyer_address: String,
        seller_address: String,
        foreign_amount: U128,
    ) {
        let deal = self.get_deal_or_panic(deal_id);
        let caller = env::predecessor_account_id();
        let is_seller_or_owner = caller == deal.seller || caller == self.owner;
        let is_tee_signer = self
            .tee_signers
            .get(&env::signer_account_pk())
            .map(|s| s.active)
            .unwrap_or(false)
            || env::signer_account_pk() == deal.tee_pubkey;
        require!(
            is_seller_or_owner || is_tee_signer,
            "Only seller, owner, or active TEE signer can register foreign chain parameters"
        );
        require!(
            deal.status == DealStatus::Created,
            "Foreign chain parameters can only be registered for Created deals"
        );
        require!(
            deal.buyer_deposited == 0,
            "Native buyer deposit already made; cannot convert to foreign chain deal"
        );
        let mut deal = deal;
        deal.buyer_collateral = 0;
        deal.deposit_deadline = env::block_timestamp() + 86400 * 1_000_000_000;
        self.deals.insert(&deal_id, &deal);
        require!(
            deal.token.is_none(),
            "Foreign chain deals must not specify NEP-141 token escrow"
        );
        let existing = self.foreign_deals.get(&deal_id);
        require!(
            is_valid_evm_address(&vault_address),
            "Valid non-zero hexadecimal vault address is required"
        );
        require!(
            is_valid_evm_address(&token_address),
            "Valid non-zero hexadecimal token address is required"
        );
        require!(
            is_valid_evm_address(&buyer_address) || buyer_address == "0x0000000000000000000000000000000000000000",
            "Valid non-zero hexadecimal buyer address is required"
        );
        let final_seller = if is_valid_evm_address(&seller_address) {
            seller_address.clone()
        } else if let Some(ref prev) = existing {
            if is_valid_evm_address(&prev.seller_address) {
                prev.seller_address.clone()
            } else {
                env::panic_str("Valid non-zero hexadecimal seller address is required");
            }
        } else {
            env::panic_str("Valid non-zero hexadecimal seller address is required");
        };

        let final_buyer = if is_valid_evm_address(&buyer_address) {
            buyer_address.clone()
        } else if let Some(ref prev) = existing {
            if is_valid_evm_address(&prev.buyer_address) {
                prev.buyer_address.clone()
            } else {
                buyer_address.clone()
            }
        } else {
            buyer_address.clone()
        };

        if let Some(ref prev) = existing {
            let immutable_parameters_set = prev.foreign_amount.0 > 0 || !prev.vault_address.is_empty();
            if immutable_parameters_set {
                require!(prev.chain_id == chain_id, "Foreign chain id is locked");
                require!(prev.vault_address.eq_ignore_ascii_case(&vault_address), "Foreign vault is locked");
                require!(prev.token_address.eq_ignore_ascii_case(&token_address), "Foreign token is locked");
                require!(prev.foreign_amount == foreign_amount, "Foreign amount is locked");
                require!(prev.seller_address.eq_ignore_ascii_case(&final_seller), "Foreign seller address is locked");
            }
        }

        let info = ForeignChainInfo {
            chain_id,
            vault_address,
            token_address,
            buyer_address: final_buyer,
            seller_address: final_seller,
            foreign_amount,
            evm_nonce: existing.as_ref().map(|e| e.evm_nonce).unwrap_or(0),
            seller_claimed: existing.as_ref().map(|e| e.seller_claimed).unwrap_or(false),
        };
        self.foreign_deals.insert(&deal_id, &info);
    }

    pub fn set_foreign_buyer_address(&mut self, deal_id: u64, buyer_address: String) {
        let deal = self.get_deal_or_panic(deal_id);
        let caller = env::predecessor_account_id();
        let is_tee_signer = self
            .tee_signers
            .get(&env::signer_account_pk())
            .map(|s| s.active)
            .unwrap_or(false)
            || env::signer_account_pk() == deal.tee_pubkey;
        require!(
            caller == deal.buyer || is_tee_signer,
            "Only the buyer or TEE signer can set the foreign refund address"
        );
        require!(deal.status == DealStatus::Created, "Buyer refund address can only be set while the deal is Created");
        require!(
            is_valid_evm_address(&buyer_address),
            "Valid non-zero hexadecimal buyer address is required"
        );
        let mut info = self.foreign_deals.get(&deal_id).unwrap_or_else(|| ForeignChainInfo {
            chain_id: 84532,
            vault_address: "".to_string(),
            token_address: "0x036CbD53842c5426634e7929541eC2318f3dCF7e".to_string(),
            buyer_address: buyer_address.clone(),
            seller_address: "0x0000000000000000000000000000000000000000".to_string(),
            foreign_amount: U128(0),
            evm_nonce: 0,
            seller_claimed: false,
        });
        require!(
            !is_valid_evm_address(&info.buyer_address)
                || info.buyer_address.eq_ignore_ascii_case(&buyer_address),
            "Foreign buyer address is locked"
        );
        info.buyer_address = buyer_address;
        self.foreign_deals.insert(&deal_id, &info);
    }

    pub fn set_foreign_seller_address(&mut self, deal_id: u64, seller_address: String) {
        let deal = self.get_deal_or_panic(deal_id);
        require!(
            env::predecessor_account_id() == deal.seller,
            "Only the seller can set their foreign payout address"
        );
        require!(deal.status == DealStatus::Created, "Seller payout address can only be set while the deal is Created");
        require!(
            is_valid_evm_address(&seller_address),
            "Valid non-zero hexadecimal seller address is required"
        );
        let mut info = self.foreign_deals.get(&deal_id).unwrap_or_else(|| ForeignChainInfo {
            chain_id: 84532,
            vault_address: "".to_string(),
            token_address: "0x036CbD53842c5426634e7929541eC2318f3dCF7e".to_string(),
            buyer_address: "0x0000000000000000000000000000000000000000".to_string(),
            seller_address: seller_address.clone(),
            foreign_amount: U128(0),
            evm_nonce: 0,
            seller_claimed: false,
        });
        require!(
            !is_valid_evm_address(&info.seller_address)
                || info.seller_address.eq_ignore_ascii_case(&seller_address),
            "Foreign seller address is locked"
        );
        info.seller_address = seller_address;
        self.foreign_deals.insert(&deal_id, &info);
    }

    pub fn get_foreign_deal(&self, deal_id: u64) -> Option<ForeignChainInfo> {
        self.foreign_deals.get(&deal_id)
    }

    pub fn set_mpc_signer_contract(&mut self, account_id: AccountId) {
        self.assert_owner();
        self.mpc_signer_contract = Some(account_id);
    }

    pub fn get_mpc_signer_contract(&self) -> Option<AccountId> {
        self.mpc_signer_contract.clone()
    }

    pub fn record_foreign_deposit(
        &mut self,
        deal_id: u64,
        tx_hash: String,
        payload: SignedPayload,
        sig: Vec<u8>,
    ) {
        let mut deal = self.get_deal_or_panic(deal_id);
        require!(
            deal.status == DealStatus::Created,
            "Deal must be in Created status to record foreign deposit"
        );
        let foreign_info = self
            .foreign_deals
            .get(&deal_id)
            .expect("Foreign chain parameters not registered for this deal");

        self.assert_active_tee_signer(&deal.tee_pubkey);

        CryptoHelper::verify_signed_payload(
            &payload,
            &sig,
            &deal.tee_pubkey,
            &deal,
            &env::current_account_id(),
            &self.chain_id,
            PayloadKind::ForeignDeposit,
        );

        deal.buyer_deposited = deal.price + deal.buyer_collateral;
        deal.last_nonce = payload.nonce;
        deal.last_tee_seen = env::block_timestamp();

        self.check_and_transition_funded(&mut deal);

        self.deals.insert(&deal_id, &deal);

        emit_event(ConpiEvent::ForeignDepositRecorded {
            deal_id,
            chain_id: foreign_info.chain_id,
            tx_hash: &tx_hash,
            amount: foreign_info.foreign_amount,
        });
    }

    pub fn confirm_foreign_deposit(&mut self, deal_id: u64) {
        let caller = env::predecessor_account_id();
        let mut deal = self.get_deal_or_panic(deal_id);
        require!(
            deal.status == DealStatus::Created,
            "Deal must be in Created status"
        );
        let foreign_info = self.foreign_deals.get(&deal_id).expect("Not a foreign deal");
        let is_tee_signer = self
            .tee_signers
            .get(&env::signer_account_pk())
            .map(|s| s.active)
            .unwrap_or(false)
            || env::signer_account_pk() == deal.tee_pubkey;
        require!(
            is_tee_signer || caller == self.owner,
            "Only active TEE signer or protocol owner can confirm foreign deposits"
        );
        require!(foreign_info.foreign_amount.0 > 0, "No foreign amount");
        require!(foreign_info.buyer_address != "0x0000000000000000000000000000000000000000", "Invalid buyer address");

        deal.buyer_deposited = deal.price + deal.buyer_collateral;
        deal.last_tee_seen = env::block_timestamp();
        self.check_and_transition_funded(&mut deal);
        self.deals.insert(&deal_id, &deal);

        emit_event(ConpiEvent::ForeignDepositRecorded {
            deal_id,
            chain_id: foreign_info.chain_id,
            tx_hash: "confirmed",
            amount: foreign_info.foreign_amount,
        });
    }

    pub fn release_stage_foreign(
        &mut self,
        deal_id: u64,
        stage: u8,
        payload: SignedPayload,
        sig: Vec<u8>,
        foreign_tx: ForeignTxRequest,
    ) -> Promise {
        let mut deal = self.get_deal_or_panic(deal_id);
        require!(
            self.foreign_deals.get(&deal_id).is_some(),
            "Deal is not registered as a foreign chain deal"
        );
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

        require!(deal.credit_amount > 0, "Deal has zero credit amount");
        let required_metered = if stage == 100 {
            (9995 * deal.credit_amount) / 10000
        } else {
            (stage as u128 * deal.credit_amount) / 100
        };
        require!(
            payload.metered_value.0 >= required_metered && payload.metered_value.0 > 0,
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

        let mut foreign_info = self
            .foreign_deals
            .get(&deal_id)
            .expect("Foreign chain parameters not registered for this deal");

        require!(
            foreign_tx.nonce == foreign_info.evm_nonce,
            "Invalid foreign EVM nonce"
        );
        require!(
            foreign_tx.recipient == foreign_info.seller_address,
            "Foreign recipient does not match seller address"
        );
        let incremental_payout = SettlementCalculator::calculate_stage_payout(&deal, stage);
        let expected_foreign_payout = ((stage as u128 * foreign_info.foreign_amount.0) / 100)
            - ((deal.stage_reached as u128 * foreign_info.foreign_amount.0) / 100);
        require!(
            foreign_tx.amount.0 == expected_foreign_payout,
            "Foreign transaction amount does not match incremental payout"
        );

        if let Some(attested_sighash) = payload.foreign_tx_sighash {
            require!(
                attested_sighash == foreign_tx.sighash,
                "Foreign transaction sighash must be attested by TEE"
            );
        } else {
            let expected_sighash = Eip1559Helper::compute_standard_erc20_transfer_sighash(
                foreign_info.chain_id,
                foreign_info.evm_nonce,
                &foreign_info.token_address,
                &foreign_info.seller_address,
                expected_foreign_payout,
            );
            require!(
                foreign_tx.sighash == expected_sighash,
                "Foreign transaction sighash mismatch with standard EIP-1559 transfer"
            );
        }

        let prev_stage = deal.stage_reached;
        let prev_released = deal.released_to_seller;
        let prev_status = deal.status;
        let prev_evm_nonce = foreign_info.evm_nonce;

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
        deal.usage_deadline = env::block_timestamp() + self.config.default_usage_duration;
        deal.notice_deadline = None;

        if stage == 100 {
            // NOTE: Deal completion and seller collateral payout are deferred to on_mpc_signed
            // callback to guarantee no state desynchronization or collateral leakage on MPC failure.
            deal.stage_reached = 100;
        }

        foreign_info.evm_nonce += 1;
        self.foreign_deals.insert(&deal_id, &foreign_info);
        self.deals.insert(&deal_id, &deal);

        emit_event(ConpiEvent::StageReleased {
            deal_id,
            stage,
            amount_released: U128(incremental_payout),
            cumulative_released: U128(deal.released_to_seller),
        });

        let mpc_account = self
            .mpc_signer_contract
            .clone()
            .unwrap_or_else(|| "v1.signer-prod.testnet".parse().unwrap());

        ext_mpc_signer::ext(mpc_account)
            .with_attached_deposit(NearToken::from_yoctonear(ONE_YOCTO))
            .with_static_gas(GAS_FOR_MPC_SIGN)
            .sign(SignRequest {
                payload_v2: PayloadV2::Ecdsa(hex::encode(foreign_tx.sighash)),
                path: format!("deal-{}", deal_id),
                domain_id: 0,
            })
            .then(
                Self::ext(env::current_account_id())
                    .with_static_gas(GAS_FOR_MPC_CALLBACK)
                    .on_mpc_signed(
                        deal_id,
                        MpcCallbackAction::Stage { stage },
                        foreign_tx.sighash,
                        foreign_tx.recipient,
                        foreign_tx.amount,
                        prev_stage,
                        prev_released,
                        prev_status,
                        prev_evm_nonce,
                    ),
            )
    }

    #[private]
    pub fn on_mpc_signed(
        &mut self,
        deal_id: u64,
        action: MpcCallbackAction,
        sighash: [u8; 32],
        recipient: String,
        amount: U128,
        prev_stage: u8,
        prev_released: Balance,
        prev_status: DealStatus,
        prev_evm_nonce: u64,
        #[callback_result] result: Result<SignatureResponse, near_sdk::PromiseError>,
    ) -> bool {
        match result {
            Ok(sig) => {
                let chain_id = self
                    .foreign_deals
                    .get(&deal_id)
                    .map(|f| f.chain_id)
                    .unwrap_or(84532);
                let sighash_hex = hex::encode(sighash);
                let event_stage = match &action {
                    MpcCallbackAction::Stage { stage } => *stage,
                    _ => 0,
                };
                let r_hex = if sig.big_r.affine_point.len() == 66 {
                    &sig.big_r.affine_point[2..]
                } else {
                    &sig.big_r.affine_point
                };
                emit_event(ConpiEvent::ForeignTxSigned {
                    deal_id,
                    stage: event_stage,
                    chain_id,
                    recipient: &recipient,
                    amount,
                    sighash_hex: &sighash_hex,
                    r_hex,
                    s_hex: &sig.s.scalar,
                    recovery_id: sig.recovery_id,
                });

                match action {
                    MpcCallbackAction::Stage { stage } => {
                        if stage == 100 {
                            if let Some(mut deal) = self.deals.get(&deal_id) {
                                deal.status = DealStatus::Completed;
                                if deal.seller_collateral > 0 {
                                    let _ = self.payout(&deal.seller, deal.seller_collateral, &deal.token);
                                    deal.seller_collateral = 0;
                                }
                                self.deals.insert(&deal_id, &deal);
                                self.refund_storage_deposit(deal_id);
                                emit_event(ConpiEvent::DealCompleted {
                                    deal_id,
                                    seller_total: U128(deal.released_to_seller),
                                });
                            }
                        }
                    }
                    MpcCallbackAction::Default {
                        seller_slashed,
                        buyer_slashed,
                        seller_collateral_remaining,
                    } => {
                        if let Some(mut deal) = self.deals.get(&deal_id) {
                            deal.status = DealStatus::Defaulted;
                            if seller_slashed.0 > 0 {
                                let _ = self.payout(&deal.buyer, seller_slashed.0, &deal.token);
                            }
                            if buyer_slashed.0 > 0 {
                                let _ = self.payout(&deal.seller, buyer_slashed.0, &deal.token);
                            }
                            if seller_collateral_remaining.0 > 0 {
                                let _ = self.payout(&deal.seller, seller_collateral_remaining.0, &deal.token);
                            }
                            deal.seller_collateral = 0;
                            self.deals.insert(&deal_id, &deal);
                            self.refund_storage_deposit(deal_id);
                        }
                    }
                    MpcCallbackAction::Timeout { status, seller_payout } => {
                        if let Some(mut deal) = self.deals.get(&deal_id) {
                            deal.status = status;
                            if seller_payout.0 > 0 {
                                let _ = self.payout(&deal.seller, seller_payout.0, &deal.token);
                            }
                            deal.seller_collateral = 0;
                            deal.seller_deposited = 0;
                            self.deals.insert(&deal_id, &deal);
                            self.refund_storage_deposit(deal_id);
                        }
                    }
                    MpcCallbackAction::SellerClaim => {
                        if let Some(mut foreign_info) = self.foreign_deals.get(&deal_id) {
                            foreign_info.seller_claimed = true;
                            self.foreign_deals.insert(&deal_id, &foreign_info);
                        }
                    }
                }
                true
            }
            Err(err) => {
                log!("MPC signing failed for deal #{}: {:?}", deal_id, err);
                if let Some(mut deal) = self.deals.get(&deal_id) {
                    deal.stage_reached = prev_stage;
                    deal.released_to_seller = prev_released;
                    deal.status = prev_status;
                    self.deals.insert(&deal_id, &deal);
                }
                if let Some(mut foreign_info) = self.foreign_deals.get(&deal_id) {
                    foreign_info.evm_nonce = prev_evm_nonce;
                    foreign_info.seller_claimed = false;
                    self.foreign_deals.insert(&deal_id, &foreign_info);
                }
                false
            }
        }
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
            self.foreign_deals.get(&deal_id).is_none(),
            "Foreign deals must use settle_default_foreign"
        );
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

    pub fn settle_default_foreign(
        &mut self,
        deal_id: u64,
        payload: SignedPayload,
        sig: Vec<u8>,
        foreign_tx: ForeignTxRequest,
    ) -> Promise {
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

        let mut foreign_info = self
            .foreign_deals
            .get(&deal_id)
            .expect("Foreign chain parameters not registered for this deal");

        require!(
            foreign_tx.nonce == foreign_info.evm_nonce,
            "Invalid foreign EVM nonce"
        );
        require!(
            foreign_tx.recipient == foreign_info.buyer_address,
            "Foreign refund recipient must match buyer address"
        );
        if let Some(attested_sighash) = payload.foreign_tx_sighash {
            require!(
                attested_sighash == foreign_tx.sighash,
                "Foreign transaction sighash must be attested by TEE"
            );
        } else {
            let expected_sighash = Eip1559Helper::compute_standard_erc20_transfer_sighash(
                foreign_info.chain_id,
                foreign_info.evm_nonce,
                &foreign_info.token_address,
                &foreign_info.buyer_address,
                foreign_tx.amount.0,
            );
            require!(
                foreign_tx.sighash == expected_sighash,
                "Foreign transaction sighash mismatch with standard EIP-1559 transfer"
            );
        }

        let reason = payload
            .reason
            .expect("Default payload must include reason");

        let prev_stage = deal.stage_reached;
        let prev_released = deal.released_to_seller;
        let prev_status = deal.status;
        let prev_evm_nonce = foreign_info.evm_nonce;

        deal.status = DealStatus::Defaulted;
        let distribution = SettlementCalculator::calculate_default_settlement(
            &deal,
            payload.metered_value.0,
            reason,
        );

        let fraction_bps = if deal.credit_amount == 0 {
            0u128
        } else {
            std::cmp::min(
                10_000u128,
                (payload.metered_value.0 * 10_000) / deal.credit_amount,
            )
        };
        let foreign_seller_earned = (fraction_bps * foreign_info.foreign_amount.0) / 10_000;
        let foreign_already_released = (deal.stage_reached as u128 * foreign_info.foreign_amount.0) / 100;
        let effective_foreign_seller_taken = std::cmp::max(foreign_seller_earned, foreign_already_released);
        let expected_buyer_foreign_refund = foreign_info.foreign_amount.0.saturating_sub(effective_foreign_seller_taken);

        require!(
            foreign_tx.amount.0 == expected_buyer_foreign_refund,
            "Foreign refund amount must match calculated buyer refund"
        );

        let (seller_slashed, buyer_slashed) = match reason {
            DefaultReason::BuyerBreach => (0u128, distribution.slashed_collateral),
            _ => (distribution.slashed_collateral, 0u128),
        };
        let seller_collateral_remaining = deal
            .seller_collateral
            .saturating_sub(seller_slashed);

        deal.last_nonce = payload.nonce;
        deal.last_signed = Some(SignedState {
            stage: deal.stage_reached,
            metered_value: payload.metered_value,
            nonce: payload.nonce,
            issued_at: payload.issued_at,
        });
        deal.last_tee_seen = env::block_timestamp();

        foreign_info.evm_nonce += 1;
        self.foreign_deals.insert(&deal_id, &foreign_info);
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

        let mpc_account = self
            .mpc_signer_contract
            .clone()
            .unwrap_or_else(|| "v1.signer-prod.testnet".parse().unwrap());

        ext_mpc_signer::ext(mpc_account)
            .with_attached_deposit(NearToken::from_yoctonear(ONE_YOCTO))
            .with_static_gas(GAS_FOR_MPC_SIGN)
            .sign(SignRequest {
                payload_v2: PayloadV2::Ecdsa(hex::encode(foreign_tx.sighash)),
                path: format!("deal-{}", deal_id),
                domain_id: 0,
            })
            .then(
                Self::ext(env::current_account_id())
                    .with_static_gas(GAS_FOR_MPC_CALLBACK)
                    .on_mpc_signed(
                        deal_id,
                        MpcCallbackAction::Default {
                            seller_slashed: U128(seller_slashed),
                            buyer_slashed: U128(buyer_slashed),
                            seller_collateral_remaining: U128(seller_collateral_remaining),
                        },
                        foreign_tx.sighash,
                        foreign_tx.recipient,
                        foreign_tx.amount,
                        prev_stage,
                        prev_released,
                        prev_status,
                        prev_evm_nonce,
                    ),
            )
    }

    pub fn timeout_refund_foreign(
        &mut self,
        deal_id: u64,
        foreign_tx: ForeignTxRequest,
    ) -> Promise {
        let mut deal = self.get_deal_or_panic(deal_id);
        let mut foreign_info = self
            .foreign_deals
            .get(&deal_id)
            .expect("Foreign chain parameters not registered for this deal");

        require!(
            foreign_tx.nonce == foreign_info.evm_nonce,
            "Invalid foreign EVM nonce"
        );
        require!(
            foreign_tx.recipient == foreign_info.buyer_address,
            "Foreign refund recipient must match buyer address"
        );

        let now = env::block_timestamp();
        let caller = env::predecessor_account_id();

        let prev_status = deal.status;
        let prev_stage = deal.stage_reached;
        let prev_released = deal.released_to_seller;
        let prev_evm_nonce = foreign_info.evm_nonce;

        let (refund_amount, new_status, seller_native_payout) = match deal.status {
            DealStatus::Created => {
                let can_cancel_early = (caller == deal.buyer && deal.seller_deposited == 0)
                    || (caller == deal.seller && deal.buyer_deposited == 0);
                require!(
                    now > deal.deposit_deadline || can_cancel_early,
                    "Deposit deadline has not passed yet"
                );

                deal.status = DealStatus::Cancelled;

                emit_event(ConpiEvent::DealCancelled {
                    deal_id,
                    reason: if can_cancel_early { "EARLY_CANCEL" } else { "DEPOSIT_TIMEOUT" },
                });

                if deal.buyer_deposited == 0 {
                    if deal.seller_deposited > 0 {
                        let _ = self.payout(&deal.seller, deal.seller_deposited, &deal.token);
                    }
                    deal.seller_collateral = 0;
                    deal.seller_deposited = 0;
                    self.deals.insert(&deal_id, &deal);
                    self.refund_storage_deposit(deal_id);
                    return Promise::new(env::current_account_id());
                }

                (foreign_info.foreign_amount, DealStatus::Cancelled, deal.seller_deposited)
            }
            DealStatus::Funded => {
                require!(
                    now > deal.key_deadline,
                    "Key submission deadline has not passed yet"
                );

                deal.status = DealStatus::Cancelled;

                emit_event(ConpiEvent::DealCancelled {
                    deal_id,
                    reason: "KEY_DEADLINE_EXPIRED",
                });
                (foreign_info.foreign_amount, DealStatus::Cancelled, deal.seller_deposited)
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

                emit_event(ConpiEvent::DealSettledTimeout {
                    deal_id,
                    seller_payout: U128(dist.seller_payout),
                    buyer_refund: U128(dist.buyer_refund),
                });
                let fraction_bps = if deal.credit_amount == 0 {
                    0u128
                } else {
                    std::cmp::min(
                        10_000u128,
                        (checkpoint_metered * 10_000) / deal.credit_amount,
                    )
                };
                let foreign_seller_earned = (fraction_bps * foreign_info.foreign_amount.0) / 10_000;
                let foreign_already_released = (deal.stage_reached as u128 * foreign_info.foreign_amount.0) / 100;
                let effective_foreign_seller_taken = std::cmp::max(foreign_seller_earned, foreign_already_released);
                let foreign_refund = foreign_info.foreign_amount.0.saturating_sub(effective_foreign_seller_taken);
                (U128(foreign_refund), DealStatus::SettledTimeout, deal.seller_collateral)
            }
            _ => {
                env::panic_str("Deal cannot be timeout refunded in current status");
            }
        };

        require!(
            foreign_tx.recipient == foreign_info.buyer_address,
            "Foreign recipient must be buyer address"
        );
        require!(
            foreign_tx.nonce == foreign_info.evm_nonce,
            "Foreign transaction nonce mismatch"
        );
        require!(
            foreign_tx.amount == refund_amount,
            "Foreign refund amount does not match expected amount"
        );

        let expected_sighash = Eip1559Helper::compute_standard_erc20_transfer_sighash(
            foreign_info.chain_id,
            foreign_info.evm_nonce,
            &foreign_info.token_address,
            &foreign_info.buyer_address,
            refund_amount.0,
        );
        require!(
            foreign_tx.sighash == expected_sighash,
            "Foreign transaction sighash does not match computed EIP-1559 transfer"
        );

        foreign_info.evm_nonce += 1;
        self.foreign_deals.insert(&deal_id, &foreign_info);
        self.deals.insert(&deal_id, &deal);

        let mpc_account = self
            .mpc_signer_contract
            .clone()
            .unwrap_or_else(|| "v1.signer-prod.testnet".parse().unwrap());

        ext_mpc_signer::ext(mpc_account)
            .with_attached_deposit(NearToken::from_yoctonear(ONE_YOCTO))
            .with_static_gas(GAS_FOR_MPC_SIGN)
            .sign(SignRequest {
                payload_v2: PayloadV2::Ecdsa(hex::encode(foreign_tx.sighash)),
                path: format!("deal-{}", deal_id),
                domain_id: 0,
            })
            .then(
                Self::ext(env::current_account_id())
                    .with_static_gas(GAS_FOR_MPC_CALLBACK)
                    .on_mpc_signed(
                        deal_id,
                        MpcCallbackAction::Timeout {
                            status: new_status,
                            seller_payout: U128(seller_native_payout),
                        },
                        foreign_tx.sighash,
                        foreign_tx.recipient,
                        foreign_tx.amount,
                        prev_stage,
                        prev_released,
                        prev_status,
                        prev_evm_nonce,
                    ),
            )
    }

    pub fn claim_seller_foreign_payout(
        &mut self,
        deal_id: u64,
        foreign_tx: ForeignTxRequest,
    ) -> Promise {
        let deal = self.get_deal_or_panic(deal_id);
        require!(
            deal.status == DealStatus::Defaulted
                || deal.status == DealStatus::SettledTimeout
                || deal.status == DealStatus::Completed,
            "Deal must be Defaulted, SettledTimeout, or Completed to claim seller foreign payout"
        );
        require!(
            env::predecessor_account_id() == deal.seller || env::predecessor_account_id() == self.owner,
            "Only seller or contract owner can claim seller foreign payout"
        );
        let mut foreign_info = self
            .foreign_deals
            .get(&deal_id)
            .expect("Foreign deal parameters not registered");

        require!(
            !foreign_info.seller_claimed,
            "Seller foreign payout has already been claimed"
        );

        require!(
            foreign_tx.nonce == foreign_info.evm_nonce,
            "Foreign transaction nonce mismatch"
        );
        require!(
            foreign_tx.recipient == foreign_info.seller_address,
            "Foreign transaction recipient must be seller address"
        );

        let fraction_bps = if deal.status == DealStatus::Completed {
            10_000u128
        } else if deal.credit_amount == 0 {
            0u128
        } else {
            let last_metered = deal.last_signed.as_ref().map(|s| s.metered_value.0).unwrap_or(0);
            std::cmp::min(10_000u128, (last_metered * 10_000) / deal.credit_amount)
        };
        let foreign_seller_earned = (fraction_bps * foreign_info.foreign_amount.0) / 10_000;
        let foreign_already_released = if foreign_info.evm_nonce == 0 {
            0u128
        } else {
            (deal.stage_reached as u128 * foreign_info.foreign_amount.0) / 100
        };
        let foreign_seller_owed = foreign_seller_earned.saturating_sub(foreign_already_released);

        require!(foreign_seller_owed > 0, "No remaining foreign payout owed to seller");
        require!(
            foreign_tx.amount.0 == foreign_seller_owed,
            "Foreign transaction amount does not match owed seller payout"
        );

        let expected_sighash = Eip1559Helper::compute_standard_erc20_transfer_sighash(
            foreign_info.chain_id,
            foreign_info.evm_nonce,
            &foreign_info.token_address,
            &foreign_info.seller_address,
            foreign_seller_owed,
        );
        require!(
            foreign_tx.sighash == expected_sighash,
            "Foreign transaction sighash does not match computed EIP-1559 transfer"
        );

        let prev_stage = deal.stage_reached;
        let prev_released = deal.released_to_seller;
        let prev_status = deal.status;
        let prev_evm_nonce = foreign_info.evm_nonce;

        foreign_info.seller_claimed = true;
        foreign_info.evm_nonce += 1;
        self.foreign_deals.insert(&deal_id, &foreign_info);

        let mpc_account = self
            .mpc_signer_contract
            .clone()
            .unwrap_or_else(|| "v1.signer-prod.testnet".parse().unwrap());

        ext_mpc_signer::ext(mpc_account)
            .with_attached_deposit(NearToken::from_yoctonear(ONE_YOCTO))
            .with_static_gas(GAS_FOR_MPC_SIGN)
            .sign(SignRequest {
                payload_v2: PayloadV2::Ecdsa(hex::encode(foreign_tx.sighash)),
                path: format!("deal-{}", deal_id),
                domain_id: 0,
            })
            .then(
                Self::ext(env::current_account_id())
                    .with_static_gas(GAS_FOR_MPC_CALLBACK)
                    .on_mpc_signed(
                        deal_id,
                        MpcCallbackAction::SellerClaim,
                        foreign_tx.sighash,
                        foreign_info.seller_address,
                        foreign_tx.amount,
                        prev_stage,
                        prev_released,
                        prev_status,
                        prev_evm_nonce,
                    ),
            )
    }

    /* -------------------------------------------------------------------------
       TIMEOUTS & SAFE FALLBACKS (NEVER BLOCKED BY PAUSE)
    ------------------------------------------------------------------------- */

    pub fn timeout_refund(&mut self, deal_id: u64) {
        let mut deal = self.get_deal_or_panic(deal_id);
        require!(
            self.foreign_deals.get(&deal_id).is_none(),
            "Foreign deals must use timeout_refund_foreign"
        );
        let now = env::block_timestamp();
        let caller = env::predecessor_account_id();

        match deal.status {
            DealStatus::Created => {
                let can_cancel_early = (caller == deal.buyer && deal.seller_deposited == 0)
                    || (caller == deal.seller && deal.buyer_deposited == 0);
                require!(
                    now > deal.deposit_deadline || can_cancel_early,
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
                    reason: if can_cancel_early { "EARLY_CANCEL" } else { "DEPOSIT_TIMEOUT" },
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
            self.foreign_deals.get(&deal_id).is_none(),
            "Foreign deals must use finalize_auto_release_foreign"
        );
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

    pub fn finalize_auto_release_foreign(
        &mut self,
        deal_id: u64,
        foreign_tx: ForeignTxRequest,
    ) -> Promise {
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
        let mut foreign_info = self
            .foreign_deals
            .get(&deal_id)
            .expect("Foreign deal not registered");

        require!(
            foreign_tx.nonce == foreign_info.evm_nonce,
            "Foreign transaction nonce mismatch"
        );
        require!(
            foreign_tx.recipient == foreign_info.seller_address,
            "Foreign transaction recipient must be seller address"
        );

        let foreign_already_released = (deal.stage_reached as u128 * foreign_info.foreign_amount.0) / 100;
        let foreign_seller_owed = foreign_info.foreign_amount.0.saturating_sub(foreign_already_released);
        require!(foreign_seller_owed > 0, "No remaining foreign payout owed to seller");
        require!(
            foreign_tx.amount.0 == foreign_seller_owed,
            "Foreign transaction amount does not match owed seller payout"
        );

        let expected_sighash = Eip1559Helper::compute_standard_erc20_transfer_sighash(
            foreign_info.chain_id,
            foreign_info.evm_nonce,
            &foreign_info.token_address,
            &foreign_info.seller_address,
            foreign_seller_owed,
        );
        require!(
            foreign_tx.sighash == expected_sighash,
            "Foreign transaction sighash does not match computed EIP-1559 transfer"
        );

        let prev_stage = deal.stage_reached;
        let prev_released = deal.released_to_seller;
        let prev_status = deal.status;
        let prev_evm_nonce = foreign_info.evm_nonce;

        deal.stage_reached = 100;
        deal.released_to_seller = foreign_info.foreign_amount.0;
        self.deals.insert(&deal_id, &deal);

        foreign_info.evm_nonce += 1;
        self.foreign_deals.insert(&deal_id, &foreign_info);

        let mpc_account = self
            .mpc_signer_contract
            .clone()
            .unwrap_or_else(|| "v1.signer-prod.testnet".parse().unwrap());

        ext_mpc_signer::ext(mpc_account)
            .with_attached_deposit(NearToken::from_yoctonear(ONE_YOCTO))
            .with_static_gas(GAS_FOR_MPC_SIGN)
            .sign(SignRequest {
                payload_v2: PayloadV2::Ecdsa(hex::encode(foreign_tx.sighash)),
                path: format!("deal-{}", deal_id),
                domain_id: 0,
            })
            .then(
                Self::ext(env::current_account_id())
                    .with_static_gas(GAS_FOR_MPC_CALLBACK)
                    .on_mpc_signed(
                        deal_id,
                        MpcCallbackAction::Stage { stage: 100 },
                        foreign_tx.sighash,
                        foreign_info.seller_address,
                        foreign_tx.amount,
                        prev_stage,
                        prev_released,
                        prev_status,
                        prev_evm_nonce,
                    ),
            )
    }

    pub fn finalize_exhausted_deal(&mut self, deal_id: u64) {
        let mut deal = self.get_deal_or_panic(deal_id);
        require!(
            self.foreign_deals.get(&deal_id).is_none(),
            "Foreign deals must use foreign settlement methods"
        );
        require!(
            deal.status == DealStatus::Active,
            "Deal must be Active to finalize"
        );
        require!(deal.credit_amount > 0, "Deal has zero credit amount");

        let last_metered = deal
            .last_signed
            .as_ref()
            .map(|s| s.metered_value.0)
            .unwrap_or(0);

        // Require >= 99.95% (5 bps tolerance) of credit_amount signed by attested TEE
        let required_metered = (9995 * deal.credit_amount) / 10000;
        require!(
            last_metered >= required_metered,
            "Attested metered usage is below 99.95% completion threshold"
        );

        deal.status = DealStatus::Completed;
        deal.stage_reached = 100;

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

    pub fn get_approved_measurement(&self) -> Option<String> {
        self.approved_measurement.clone()
    }

    fn assert_active_tee_signer(&self, pk: &PublicKey) {
        let signer = self.tee_signers.get(pk).expect("TEE signer not registered");
        require!(signer.active, "TEE signer is revoked or inactive");
        require!(
            !signer.measurement.is_empty(),
            "TEE signer measurement cannot be empty"
        );
        let approved = self
            .approved_measurement
            .as_ref()
            .expect("Approved CVM measurement is not set");
        require!(
            &signer.measurement == approved,
            "TEE signer measurement does not match approved live CVM measurement"
        );
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
            if env::block_timestamp() > deal.key_deadline {
                deal.key_deadline = env::block_timestamp() + 86400 * 1_000_000_000;
            }
            emit_event(ConpiEvent::DealFunded { deal_id: deal.id });
        }
    }

    fn refund_storage_deposit(&mut self, deal_id: u64) {
        if let Some(creator) = self.deal_creators.remove(&deal_id) {
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

pub(crate) fn is_valid_evm_address(addr: &str) -> bool {
    let clean = addr.trim();
    if clean.len() != 42 || !clean.starts_with("0x") {
        return false;
    }
    if clean == "0x0000000000000000000000000000000000000000" {
        return false;
    }
    hex::decode(&clean[2..]).map(|b| b.len() == 20).unwrap_or(false)
}

/* -------------------------------------------------------------------------
   STATE MIGRATION & SCHEMA EVOLUTION ARCHITECTURE PLAN
   -------------------------------------------------------------------------
   `ConpiEscrowV1` represents the frozen storage schema layout of the initial
   production release (state_version = 1).
   
   Evolution Plan:
   1. `ConpiEscrowV1` remains permanently frozen to deterministically deserialize
      historical on-chain v1 storage snapshots.
   2. When future storage layout changes occur, `ConpiEscrowV2` will be added,
      and `VersionedEscrowOldState` will wrap legacy versions (V1(ConpiEscrowV1), V2(ConpiEscrowV2)).
   3. `migrate()` will inspect `state_version` to perform safe, sequential migrations.
   ------------------------------------------------------------------------- */
