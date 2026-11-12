use near_sdk::json_types::U128;
use near_sdk::near;
use near_sdk::{AccountId, Duration, PublicKey, Timestamp};

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
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum DefaultReason {
    InvalidKey,
    InsufficientQuota,
    KeyNotSubmitted,
    ValidationFailed,
    ProviderBan,
    SellerSelfDrain,
    BuyerBreach,
}

#[near(serializers = [json, borsh])]
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum PayloadKind {
    Terms,
    Activate,
    Stage,
    Checkpoint,
    Default,
    ForeignDeposit,
    ForeignPayout,
}

#[near(serializers = [json, borsh])]
#[derive(Clone, Debug, PartialEq)]
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
    pub foreign_tx_sighash: Option<[u8; 32]>,
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
pub struct TeeSigner {
    pub measurement: String,
    pub registered_at: Timestamp,
    pub active: bool,
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

impl Default for Config {
    fn default() -> Self {
        Self {
            min_deposit_duration: 300_000_000_000,          // 5 minutes
            max_deposit_duration: 7 * 86_400_000_000_000,    // 7 days
            min_tee_liveness_timeout: 3_600_000_000_000,     // 1 hour
            default_usage_duration: 30 * 86_400_000_000_000, // 30 days
            notice_period_duration: 86_400_000_000_000,      // 24 hours notice for auto_release
            min_slash_bps: 1_000,                           // 10%
            max_slash_bps: 10_000,                          // 100%
            storage_deposit_fee: 50_000_000_000_000_000_000_000, // 0.05 NEAR
        }
    }
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
#[derive(Clone, Debug)]
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
    pub slash_bps_buyer_breach: u16,
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
    UpdateTimelock { timelock_duration: u64 },
    SetApprovedMeasurement { measurement: String },
    SetSolanaVault {
        vault_address: String,
        token_mint: String,
        mpc_path: String,
        mpc_domain_id: u32,
    },
}

#[near(serializers = [json, borsh])]
#[derive(Clone, Debug, PartialEq)]
pub struct StagedAction {
    pub action: AdminAction,
    pub ready_at: Timestamp,
}

#[near(serializers = [json, borsh])]
#[derive(Clone, Debug, PartialEq)]
pub struct ForeignChainInfo {
    pub chain_id: u64,
    pub vault_address: String,
    pub token_address: String,
    pub buyer_address: String,
    pub seller_address: String,
    pub foreign_amount: U128,
    pub evm_nonce: u64,
    pub seller_claimed: bool,
}

/// Solana-side state for a mixed-chain deal. The buyer's USDC remains in the
/// NEAR escrow while the seller collateral and seller payouts use the
/// Chain-Signatures-controlled Solana vault.
#[near(serializers = [json, borsh])]
#[derive(Clone, Debug, PartialEq)]
pub struct SolanaDealInfo {
    pub vault_address: String,
    pub token_mint: String,
    /// Chain Signatures settings are fixed at seller acceptance. Governance
    /// may rotate defaults for future deals, but an existing seller must never
    /// have their payout authority changed underneath an accepted deal.
    pub mpc_path: String,
    pub mpc_domain_id: u32,
    pub seller_address: String,
    pub collateral_amount: U128,
    pub collateral_deposited: bool,
    pub deposit_tx: Option<String>,
    pub payout_sequence: u64,
    pub last_payout_tx: Option<String>,
}

#[near(serializers = [json, borsh])]
#[derive(Clone, Debug, PartialEq)]
pub struct SolanaTxRequest {
    /// Hex-encoded Solana legacy message bytes. Solana signs the message
    /// directly with Ed25519; it must not be pre-hashed for MPC signing.
    pub message_hex: String,
    pub message_hash: [u8; 32],
    pub recipient: String,
    pub amount: U128,
    pub last_valid_block_height: u64,
}

#[near(serializers = [json, borsh])]
#[derive(Clone, Debug, PartialEq)]
pub struct PendingSolanaPayout {
    pub stage: u8,
    pub message_hex: String,
    pub message_hash: [u8; 32],
    pub recipient: String,
    pub amount: U128,
    pub last_valid_block_height: u64,
    pub requested_at: Timestamp,
    pub stage_payload: SignedPayload,
    /// Stored after the MPC callback so an enclave restart can broadcast the
    /// exact already-authorized Solana transaction instead of requesting a
    /// second signature for the same stage.
    pub signature_hex: Option<String>,
}

#[near(serializers = [json, borsh])]
#[derive(Clone, Debug, PartialEq)]
pub enum MpcCallbackAction {
    Stage { stage: u8 },
    Default {
        seller_slashed: U128,
        buyer_slashed: U128,
        seller_collateral_remaining: U128,
    },
    Timeout { status: DealStatus, seller_payout: U128 },
    SellerClaim,
}

#[near(serializers = [json, borsh])]
#[derive(Clone, Debug, PartialEq)]
pub struct ForeignTxRequest {
    pub sighash: [u8; 32],
    pub recipient: String,
    pub amount: U128,
    pub nonce: u64,
}

#[near(serializers = [json, borsh])]
#[derive(Clone, Debug)]
pub struct SignRequest {
    pub payload_v2: PayloadV2,
    pub path: String,
    pub domain_id: u32,
}

#[near(serializers = [json, borsh])]
#[derive(Clone, Debug)]
pub enum PayloadV2 {
    Ecdsa(String),
    Eddsa(String),
}

#[near(serializers = [json, borsh])]
#[derive(Clone, Debug)]
pub struct AffinePoint {
    pub affine_point: String,
}

#[near(serializers = [json, borsh])]
#[derive(Clone, Debug)]
pub struct Scalar {
    pub scalar: String,
}

#[near(serializers = [json, borsh])]
#[derive(Clone, Debug)]
pub struct SignatureResponse {
    pub scheme: String,
    pub big_r: AffinePoint,
    pub s: Scalar,
    pub recovery_id: u8,
}

/// Current Chain Signatures response shape for the Ed25519/FROST domain.
/// It is intentionally separate from the legacy ECDSA callback response so
/// existing Base settlement remains wire-compatible.
#[near(serializers = [json])]
#[derive(Clone, Debug)]
#[serde(tag = "scheme")]
pub enum Ed25519SignatureResponse {
    Ed25519 { signature: Vec<u8> },
    Secp256k1 {
        big_r: AffinePoint,
        s: Scalar,
        recovery_id: u8,
    },
}
