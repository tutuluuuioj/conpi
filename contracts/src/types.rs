use borsh::{BorshDeserialize, BorshSerialize};
use near_sdk::json_types::U128;
use near_sdk::serde::{Deserialize, Serialize};
use near_sdk::{AccountId, Duration, PublicKey, Timestamp};

pub type DealId = u64;
pub type Balance = u128;

#[derive(BorshSerialize, BorshDeserialize, Serialize, Deserialize, Clone, Copy, Debug, PartialEq, Eq)]
#[serde(crate = "near_sdk::serde")]
#[borsh(crate = "borsh")]
pub enum DealStatus {
    Created,
    Funded,
    Active,
    Completed,
    Defaulted,
    Cancelled,
    SettledTimeout,
}

#[derive(BorshSerialize, BorshDeserialize, Serialize, Deserialize, Clone, Copy, Debug, PartialEq, Eq)]
#[serde(crate = "near_sdk::serde")]
#[borsh(crate = "borsh")]
pub enum DefaultReason {
    InvalidKey,
    InsufficientQuota,
    KeyNotSubmitted,
    ValidationFailed,
    ProviderBan,
}

#[derive(BorshSerialize, BorshDeserialize, Serialize, Deserialize, Clone, Copy, Debug, PartialEq, Eq)]
#[serde(crate = "near_sdk::serde")]
#[borsh(crate = "borsh")]
pub enum PayloadKind {
    Terms,
    Activate,
    Stage,
    Checkpoint,
    Default,
}

#[derive(BorshSerialize, BorshDeserialize, Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(crate = "near_sdk::serde")]
#[borsh(crate = "borsh")]
pub struct SignedPayload {
    pub domain: String,
    pub contract_id: AccountId,
    pub chain_id: String,
    pub deal_id: u64,
    pub terms_hash: [u8; 32],
    pub kind: PayloadKind,
    pub stage: u8,
    pub metered_value: U128,
    pub reason: Option<DefaultReason>,
    pub nonce: u64,
    pub issued_at: u64,
}

#[derive(BorshSerialize, BorshDeserialize, Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(crate = "near_sdk::serde")]
#[borsh(crate = "borsh")]
pub struct SignedState {
    pub stage: u8,
    pub metered_value: U128,
    pub nonce: u64,
    pub issued_at: u64,
}

#[derive(BorshSerialize, BorshDeserialize, Serialize, Deserialize, Clone, Debug)]
#[serde(crate = "near_sdk::serde")]
#[borsh(crate = "borsh")]
pub struct TeeSigner {
    pub measurement: String,
    pub registered_at: Timestamp,
    pub active: bool,
}

#[derive(BorshSerialize, BorshDeserialize, Serialize, Deserialize, Clone, Debug)]
#[serde(crate = "near_sdk::serde")]
#[borsh(crate = "borsh")]
pub struct Config {
    pub min_deposit_duration: Duration,
    pub max_deposit_duration: Duration,
    pub min_tee_liveness_timeout: Duration,
    pub default_usage_duration: Duration,
    pub max_slash_bps: u16,
    pub min_slash_bps: u16,
}

impl Default for Config {
    fn default() -> Self {
        Self {
            min_deposit_duration: 300_000_000_000,          // 5 minutes
            max_deposit_duration: 7 * 86_400_000_000_000,    // 7 days
            min_tee_liveness_timeout: 3_600_000_000_000,     // 1 hour
            default_usage_duration: 30 * 86_400_000_000_000, // 30 days
            max_slash_bps: 10_000,                          // 100%
            min_slash_bps: 1_000,                           // 10%
        }
    }
}

#[derive(BorshSerialize, BorshDeserialize, Serialize, Deserialize, Clone, Debug)]
#[serde(crate = "near_sdk::serde")]
#[borsh(crate = "borsh")]
pub struct Deal {
    pub id: DealId,
    pub buyer: AccountId,
    pub seller: AccountId,
    /// None = Native NEAR; Some(account_id) = NEP-141 token
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
    pub tee_liveness_timeout: Duration,
    pub slash_bps_provider_ban: u16,
    pub slash_bps_revoke: u16,
    pub buyer_deposited: Balance,
    pub seller_deposited: Balance,
    pub released_to_seller: Balance,
    pub stage_reached: u8,
    pub last_signed: Option<SignedState>,
    pub last_nonce: u64,
    pub last_tee_seen: Timestamp,
    pub status: DealStatus,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(crate = "near_sdk::serde")]
pub struct CreateDealParams {
    pub buyer: AccountId,
    pub seller: AccountId,
    pub token: Option<AccountId>,
    pub price: U128,
    pub credit_amount: U128,
    pub buyer_collateral: U128,
    pub seller_collateral: U128,
    pub tee_pubkey: PublicKey,
    pub deposit_duration_sec: u64,
    pub key_duration_sec: u64,
    pub tee_liveness_timeout_sec: u64,
    pub slash_bps_provider_ban: u16,
    pub slash_bps_revoke: u16,
}
