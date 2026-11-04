use near_sdk::collections::{LookupMap, UnorderedMap};
use near_sdk::json_types::U128;
use near_sdk::near;
use near_sdk::{env, require, AccountId, Duration, PanicOnDefault, PublicKey, Timestamp};

pub type DealId = u64;
pub type Balance = u128;

#[near(serializers = [json, borsh])]
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum DealStatus {
    Created,
    Funded,
    Active,
    Completed,
    Defaulted,
    Cancelled,
    SettledTimeout,
}

#[near(serializers = [json, borsh])]
#[derive(Clone, Debug, PartialEq)]
pub struct SignedState {
    pub stage: u8,
    pub metered_value: U128,
    pub nonce: u64,
    pub issued_at: u64,
}

#[near(serializers = [json, borsh])]
#[derive(Clone, Debug)]
pub struct Deal {
    pub id: DealId,
    pub buyer: AccountId,
    pub seller: AccountId,
    pub token: Option<AccountId>,
    pub price: Balance,
    pub credit_amount: Balance,
    pub buyer_collateral: Balance,
    pub seller_collateral: Balance,
    pub terms_hash: Option<[u8; 32]>,
    pub tee_pubkey: PublicKey,
    pub deposit_deadline: Timestamp,
    pub key_deadline: Timestamp,
    pub usage_deadline: Timestamp,
    pub notice_deadline: Option<Timestamp>,
    pub tee_liveness_timeout: Duration,
    pub slash_bps_provider_ban: u16,
    pub slash_bps_revoke: u16,
    pub slash_bps_buyer_breach: u16,
    pub buyer_deposited: Balance,
    pub seller_deposited: Balance,
    pub released_to_seller: Balance,
    pub stage_reached: u8,
    pub last_signed: Option<SignedState>,
    pub last_nonce: u64,
    pub last_tee_seen: Timestamp,
    pub status: DealStatus,
    pub counterparty_accepted: bool,
}

#[near(serializers = [json, borsh])]
#[derive(Clone, Debug, PartialEq)]
pub struct Config {
    pub min_deposit_duration: Duration,
    pub max_deposit_duration: Duration,
    pub min_tee_liveness_timeout: Duration,
    pub default_usage_duration: Duration,
    pub notice_period_duration: Duration,
    pub min_slash_bps: u16,
    pub max_slash_bps: u16,
    pub storage_deposit_fee: Balance,
}

#[near(serializers = [json, borsh])]
#[derive(Clone, Debug)]
pub struct TeeSigner {
    pub measurement: String,
    pub registered_at: Timestamp,
    pub active: bool,
}

#[near(serializers = [json, borsh])]
#[derive(Clone, Debug, PartialEq)]
pub enum AdminAction {
    TransferOwnership { new_owner: AccountId },
    UpdateConfig { config: Config },
    AddTeeSigner { public_key: PublicKey, measurement: String },
    RevokeTeeSigner { public_key: PublicKey },
    Upgrade { code_hash: [u8; 32] },
    Unpause,
}

#[near(serializers = [json, borsh])]
#[derive(Clone, Debug, PartialEq)]
pub struct StagedAction {
    pub action: AdminAction,
    pub ready_at: Timestamp,
}

#[near(serializers = [borsh])]
pub struct ConpiEscrowCurrent {
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

#[near(serializers = [borsh])]
pub struct ConpiEscrowV2State {
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
}

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

#[near(contract_state)]
#[derive(PanicOnDefault)]
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
    pub v2_feature_message: String,
}

#[near]
impl ConpiEscrowV2 {
    #[private]
    #[init(ignore_state)]
    pub fn migrate() -> Self {
        use near_sdk::borsh::BorshDeserialize;
        let state_bytes = env::storage_read(b"STATE").expect("Contract state not found");
        let (owner, chain_id, paused, tee_signers, deals, deal_creators, pending_payouts, next_deal_id, config, next_proposal_id, staged_proposals, timelock_duration, state_version) =
            if let Ok(cur) = ConpiEscrowCurrent::try_from_slice(&state_bytes) {
                (cur.owner, cur.chain_id, cur.paused, cur.tee_signers, cur.deals, cur.deal_creators, cur.pending_payouts, cur.next_deal_id, cur.config, cur.next_proposal_id, cur.staged_proposals, cur.timelock_duration, cur.state_version)
            } else if let Ok(v2) = ConpiEscrowV2State::try_from_slice(&state_bytes) {
                (v2.owner, v2.chain_id, v2.paused, v2.tee_signers, v2.deals, v2.deal_creators, v2.pending_payouts, v2.next_deal_id, v2.config, v2.next_proposal_id, v2.staged_proposals, v2.timelock_duration, v2.state_version)
            } else if let Ok(v1) = ConpiEscrowV1::try_from_slice(&state_bytes) {
                (v1.owner, v1.chain_id, v1.paused, v1.tee_signers, v1.deals, v1.deal_creators, v1.pending_payouts, v1.next_deal_id, v1.config, v1.next_proposal_id, v1.staged_proposals, v1.timelock_duration, v1.state_version)
            } else {
                env::panic_str("Failed to deserialize old contract state in V2 migrate");
            };

        require!(
            state_version >= 1,
            "Unsupported contract state version for migration"
        );
        env::log_str("Contract upgraded and migrated to V2 successfully");
        Self {
            owner,
            chain_id,
            paused,
            tee_signers,
            deals,
            deal_creators,
            pending_payouts,
            next_deal_id,
            config,
            next_proposal_id,
            staged_proposals,
            timelock_duration,
            state_version: 2,
            v2_feature_message: "conpi-v2-active".to_string(),
        }
    }

    pub fn get_owner(&self) -> AccountId {
        self.owner.clone()
    }

    pub fn get_state_version(&self) -> u32 {
        self.state_version
    }

    pub fn get_v2_feature(&self) -> String {
        self.v2_feature_message.clone()
    }

    pub fn get_deal(&self, deal_id: u64) -> Option<Deal> {
        self.deals.get(&deal_id)
    }

    pub fn get_pending_payout(&self, account_id: AccountId, token_id: Option<AccountId>) -> U128 {
        U128(self.pending_payouts.get(&(account_id, token_id)).unwrap_or(0))
    }

    pub fn get_config(&self) -> Config {
        self.config.clone()
    }

    pub fn get_timelock_duration(&self) -> u64 {
        self.timelock_duration
    }

    pub fn get_staged_proposal(&self, proposal_id: u64) -> Option<StagedAction> {
        self.staged_proposals.get(&proposal_id)
    }
}
