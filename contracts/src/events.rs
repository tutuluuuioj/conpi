use near_sdk::json_types::U128;
use near_sdk::serde::Serialize;
use near_sdk::{env, AccountId, Timestamp};

#[derive(Serialize, Debug)]
#[serde(crate = "near_sdk::serde")]
#[serde(untagged)]
pub enum ConpiEvent<'a> {
    #[serde(rename = "deal_created")]
    DealCreated {
        deal_id: u64,
        buyer: &'a AccountId,
        seller: &'a AccountId,
        price: U128,
        token: &'a Option<AccountId>,
    },
    #[serde(rename = "deal_accepted")]
    DealAccepted {
        deal_id: u64,
        account: &'a AccountId,
    },
    #[serde(rename = "terms_registered")]
    TermsRegistered {
        deal_id: u64,
        terms_hash: &'a str,
    },
    #[serde(rename = "deposit_received")]
    DepositReceived {
        deal_id: u64,
        account: &'a AccountId,
        amount: U128,
        is_buyer: bool,
    },
    #[serde(rename = "deal_funded")]
    DealFunded {
        deal_id: u64,
    },
    #[serde(rename = "deal_activated")]
    DealActivated {
        deal_id: u64,
        usage_deadline: u64,
    },
    #[serde(rename = "stage_released")]
    StageReleased {
        deal_id: u64,
        stage: u8,
        amount_released: U128,
        cumulative_released: U128,
    },
    #[serde(rename = "checkpoint_recorded")]
    CheckpointRecorded {
        deal_id: u64,
        metered_value: U128,
        nonce: u64,
    },
    #[serde(rename = "auto_release_notice")]
    AutoReleaseNotice {
        deal_id: u64,
        notice_deadline: u64,
    },
    #[serde(rename = "deal_defaulted")]
    DealDefaulted {
        deal_id: u64,
        reason: &'static str,
        seller_payout: U128,
        buyer_refund: U128,
        slashed_collateral: U128,
    },
    #[serde(rename = "deal_completed")]
    DealCompleted {
        deal_id: u64,
        seller_total: U128,
    },
    #[serde(rename = "deal_cancelled")]
    DealCancelled {
        deal_id: u64,
        reason: &'static str,
    },
    #[serde(rename = "deal_settled_timeout")]
    DealSettledTimeout {
        deal_id: u64,
        seller_payout: U128,
        buyer_refund: U128,
    },
    #[serde(rename = "pending_payout_claimed")]
    PendingPayoutClaimed {
        account: &'a AccountId,
        token: &'a Option<AccountId>,
        amount: U128,
    },
    #[serde(rename = "transfer_failed_credited")]
    TransferFailedCredited {
        account: &'a AccountId,
        token: &'a Option<AccountId>,
        amount: U128,
    },
    #[serde(rename = "governance_action_proposed")]
    GovernanceActionProposed {
        proposal_id: u64,
        ready_at: Timestamp,
        action_type: &'static str,
    },
    #[serde(rename = "governance_action_executed")]
    GovernanceActionExecuted {
        proposal_id: u64,
        action_type: &'static str,
    },
    #[serde(rename = "governance_action_cancelled")]
    GovernanceActionCancelled {
        proposal_id: u64,
    },
    #[serde(rename = "foreign_deposit_recorded")]
    ForeignDepositRecorded {
        deal_id: u64,
        chain_id: u64,
        tx_hash: &'a str,
        amount: U128,
    },
    #[serde(rename = "foreign_tx_signed")]
    ForeignTxSigned {
        deal_id: u64,
        stage: u8,
        chain_id: u64,
        recipient: &'a str,
        amount: U128,
        sighash_hex: &'a str,
        r_hex: &'a str,
        s_hex: &'a str,
        recovery_id: u8,
    },
    #[serde(rename = "contract_migrated")]
    ContractMigrated,
}

#[derive(Serialize, Debug)]
#[serde(crate = "near_sdk::serde")]
pub struct Nep297Event<'a> {
    pub standard: &'static str,
    pub version: &'static str,
    pub event: &'static str,
    pub data: [&'a ConpiEvent<'a>; 1],
}

pub fn emit_event(event: ConpiEvent) {
    let event_name = match &event {
        ConpiEvent::DealCreated { .. } => "deal_created",
        ConpiEvent::DealAccepted { .. } => "deal_accepted",
        ConpiEvent::TermsRegistered { .. } => "terms_registered",
        ConpiEvent::DepositReceived { .. } => "deposit_received",
        ConpiEvent::DealFunded { .. } => "deal_funded",
        ConpiEvent::DealActivated { .. } => "deal_activated",
        ConpiEvent::StageReleased { .. } => "stage_released",
        ConpiEvent::CheckpointRecorded { .. } => "checkpoint_recorded",
        ConpiEvent::AutoReleaseNotice { .. } => "auto_release_notice",
        ConpiEvent::DealDefaulted { .. } => "deal_defaulted",
        ConpiEvent::DealCompleted { .. } => "deal_completed",
        ConpiEvent::DealCancelled { .. } => "deal_cancelled",
        ConpiEvent::DealSettledTimeout { .. } => "deal_settled_timeout",
        ConpiEvent::PendingPayoutClaimed { .. } => "pending_payout_claimed",
        ConpiEvent::TransferFailedCredited { .. } => "transfer_failed_credited",
        ConpiEvent::GovernanceActionProposed { .. } => "governance_action_proposed",
        ConpiEvent::GovernanceActionExecuted { .. } => "governance_action_executed",
        ConpiEvent::GovernanceActionCancelled { .. } => "governance_action_cancelled",
        ConpiEvent::ForeignDepositRecorded { .. } => "foreign_deposit_recorded",
        ConpiEvent::ForeignTxSigned { .. } => "foreign_tx_signed",
        ConpiEvent::ContractMigrated => "contract_migrated",
    };

    let nep297 = Nep297Event {
        standard: "conpi",
        version: "1.0.0",
        event: event_name,
        data: [&event],
    };
    let json = near_sdk::serde_json::to_string(&nep297).expect("Failed to serialize event");
    env::log_str(&format!("EVENT_JSON:{}", json));
}
