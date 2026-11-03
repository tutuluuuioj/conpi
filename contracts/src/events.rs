use near_sdk::json_types::U128;
use near_sdk::serde::Serialize;
use near_sdk::{env, AccountId, Timestamp};

#[derive(Serialize, Debug)]
#[serde(crate = "near_sdk::serde")]
#[serde(tag = "standard", content = "event")]
#[serde(rename = "nep297")]
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
    #[serde(rename = "contract_migrated")]
    ContractMigrated,
}

pub fn emit_event(event: ConpiEvent) {
    let json = near_sdk::serde_json::to_string(&event).expect("Failed to serialize event");
    env::log_str(&format!("EVENT_JSON:{}", json));
}
