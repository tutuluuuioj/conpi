use conpi_escrow::types::{AdminAction, TeeSigner};
use near_sdk::json_types::Base64VecU8;
use near_workspaces::types::SecretKey;
use serde::Deserialize;
use std::fs;
use std::path::Path;

#[derive(Deserialize)]
#[allow(dead_code)]
struct MemberKeyEntry {
    member_index: u8,
    role: String,
    holder_entity: String,
    public_key: String,
    secret_key: String,
}

#[derive(Deserialize)]
#[allow(dead_code)]
struct DaoKeysFile {
    network: String,
    dao_account_id: String,
    members: [MemberKeyEntry; 3],
}

#[derive(serde::Serialize)]
struct ProposeArgs {
    action: AdminAction,
}

#[derive(serde::Serialize)]
struct ExecuteArgs {
    proposal_id: u64,
    code: Option<Vec<u8>>,
}

const ESCROW_ID: &str = "dev-20261103062448-30583839049419.testnet";
const DSTACK_HARDWARE_SIGNER: &str = "ed25519:F4YtyCFTEj9rca8fJQxcQd7F1UHuuGQBxP8WmcAC7cbi";
const HARDWARE_MEASUREMENT: &str = "mrtd:7fe60787222bd394cb516abca2435f22f035ab2cc9c0a4b4b3b148e46297f3d931a237b72f359052c6e657d8c1409173|compose:557feb0b971efff249c80a9e4ddd3546a89dab75902250fb10608bab61cd118a";

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    println!("============================================================");
    println!("  REGISTER PHALA TEE SIGNER & MRTD/COMPOSE VIA DAO          ");
    println!("============================================================");

    // 1. Load keys
    let creds_p1 = Path::new(".credentials/dao_member_keys.json");
    let creds_p2 = Path::new("contracts/.credentials/dao_member_keys.json");
    let credentials_path = if creds_p1.exists() { creds_p1 } else { creds_p2 };

    println!("Loading DAO member keys from {:?}...", credentials_path);
    let keys_content = fs::read_to_string(credentials_path)?;
    let keys_file: DaoKeysFile = serde_json::from_str(&keys_content)?;
    let dao_id: near_sdk::AccountId = keys_file.dao_account_id.parse()?;
    let escrow_id: near_sdk::AccountId = ESCROW_ID.parse()?;

    println!("DAO Multisig Account: {}", dao_id);
    println!("Target Escrow Contract: {}", escrow_id);
    println!("Dstack Derived Signer:  {}", DSTACK_HARDWARE_SIGNER);
    println!("Hardware Measurement:   {}", HARDWARE_MEASUREMENT);

    let member1_sk: SecretKey = keys_file.members[0].secret_key.parse()?;
    let member2_sk: SecretKey = keys_file.members[1].secret_key.parse()?;

    // 2. Connect to Testnet
    println!("\nConnecting to NEAR Testnet...");
    let worker = near_workspaces::testnet()
        .rpc_addr("https://test.rpc.fastnear.com")
        .await?;
    let member1_signer = near_workspaces::Account::from_secret_key(dao_id.clone(), member1_sk, &worker);
    let member2_signer = near_workspaces::Account::from_secret_key(dao_id.clone(), member2_sk, &worker);

    // 3. Prepare AdminAction::AddTeeSigner
    let action = AdminAction::AddTeeSigner {
        public_key: DSTACK_HARDWARE_SIGNER.parse()?,
        measurement: HARDWARE_MEASUREMENT.to_string(),
    };
    let propose_call_args = serde_json::to_vec(&ProposeArgs { action })?;
    let propose_b64 = Base64VecU8::from(propose_call_args);

    println!("\n[1/4] Member 1 submitting add_request_and_confirm for AddTeeSigner on Multisig DAO...");
    let add_req_res = member1_signer
        .call(&dao_id, "add_request_and_confirm")
        .args_json(serde_json::json!({
            "request": {
                "receiver_id": escrow_id,
                "actions": [
                    {
                        "type": "FunctionCall",
                        "method_name": "propose_admin_action",
                        "args": propose_b64,
                        "deposit": "0",
                        "gas": "50000000000000"
                    }
                ]
            }
        }))
        .gas(near_workspaces::types::Gas::from_tgas(100))
        .transact()
        .await?
        .into_result()?;
    let req1_tx = add_req_res.outcome().transaction_hash;
    let request_id: u32 = add_req_res.json()?;
    println!("Multisig Request #{} created. Tx: {}", request_id, req1_tx);

    println!("\n[2/4] Member 2 submitting confirm on Multisig DAO (reaching 2-of-3 quorum)...");
    let confirm1_res = member2_signer
        .call(&dao_id, "confirm")
        .args_json(serde_json::json!({ "request_id": request_id }))
        .gas(near_workspaces::types::Gas::from_tgas(150))
        .transact()
        .await?
        .into_result()?;
    let confirm1_tx = confirm1_res.outcome().transaction_hash;
    println!("Quorum (2/2) reached! Proposal staged on Escrow contract. Tx: {}", confirm1_tx);

    // Query staged proposals
    let staged_proposals: Vec<(u64, serde_json::Value)> = worker
        .view(&escrow_id, "list_staged_proposals")
        .args_json(serde_json::json!({}))
        .await?
        .json()?;

    println!("\nActive Staged Proposals on Escrow: {:?}", staged_proposals);
    if staged_proposals.is_empty() {
        let current: Option<TeeSigner> = worker
            .view(&escrow_id, "get_tee_signer")
            .args_json(serde_json::json!({ "public_key": DSTACK_HARDWARE_SIGNER }))
            .await?
            .json()?;
        if let Some(signer) = current {
            println!("Current signer measurement after quorum: {}", signer.measurement);
            if signer.active && signer.measurement == HARDWARE_MEASUREMENT {
                println!("The DAO action was idempotent: the requested measurement is already active.");
                return Ok(());
            }
        }
        panic!("No staged proposal found after confirmation and the requested measurement is not active");
    }

    let (proposal_id, staged_val) = staged_proposals.last().unwrap();
    let proposal_id = *proposal_id;
    let ready_at_ns = if let Some(n) = staged_val["ready_at"].as_u64() {
        n
    } else if let Some(s) = staged_val["ready_at"].as_str() {
        s.parse::<u64>().expect("parse ready_at")
    } else {
        panic!("unexpected ready_at format: {:?}", staged_val["ready_at"]);
    };
    let ready_at_secs = ready_at_ns / 1_000_000_000;

    println!("Staged Proposal ID: {}", proposal_id);
    println!("Ready At (Unix):    {}", ready_at_secs);

    // 4. Wait for 5-minute timelock to mature
    println!("\n[3/4] WAITING FOR 5-MINUTE TIMELOCK TO MATURE...");
    loop {
        let now_secs = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)?
            .as_secs();

        if now_secs >= ready_at_secs {
            println!("\nTimelock period (5 minutes) has fully matured! (now={} >= ready_at={})", now_secs, ready_at_secs);
            break;
        }

        let remaining = ready_at_secs - now_secs;
        println!("Waiting for timelock maturity... {} seconds remaining ({}m {}s)", remaining, remaining / 60, remaining % 60);
        tokio::time::sleep(std::time::Duration::from_secs(20)).await;
    }

    // 5. Execute proposal through multisig
    println!("\n[4/4] Executing Proposal #{} via Multisig DAO...", proposal_id);
    let exec_call_args = serde_json::to_vec(&ExecuteArgs { proposal_id, code: None })?;
    let exec_b64 = Base64VecU8::from(exec_call_args);

    println!("Member 1 submitting add_request_and_confirm for execute_admin_action...");
    let add_exec_res = member1_signer
        .call(&dao_id, "add_request_and_confirm")
        .args_json(serde_json::json!({
            "request": {
                "receiver_id": escrow_id,
                "actions": [
                    {
                        "type": "FunctionCall",
                        "method_name": "execute_admin_action",
                        "args": exec_b64,
                        "deposit": "0",
                        "gas": "50000000000000"
                    }
                ]
            }
        }))
        .gas(near_workspaces::types::Gas::from_tgas(100))
        .transact()
        .await?
        .into_result()?;
    let exec_req_tx = add_exec_res.outcome().transaction_hash;
    let exec_request_id: u32 = add_exec_res.json()?;
    println!("Multisig Request #{} created. Tx: {}", exec_request_id, exec_req_tx);

    println!("Member 2 submitting confirm for execution (reaching 2-of-3 quorum)...");
    let confirm_exec_res = member2_signer
        .call(&dao_id, "confirm")
        .args_json(serde_json::json!({ "request_id": exec_request_id }))
        .gas(near_workspaces::types::Gas::from_tgas(150))
        .transact()
        .await?
        .into_result()?;
    let confirm_exec_tx = confirm_exec_res.outcome().transaction_hash;
    println!("Execution confirmed! Tx: {}", confirm_exec_tx);

    // 6. Verify TEE Signer on Escrow
    println!("\nVerifying on-chain state for TEE Signer...");
    let tee_signer_info: Option<TeeSigner> = worker
        .view(&escrow_id, "get_tee_signer")
        .args_json(serde_json::json!({ "public_key": DSTACK_HARDWARE_SIGNER }))
        .await?
        .json()?;

    if let Some(signer) = tee_signer_info {
        println!("SUCCESS! TEE Signer registered on Escrow contract:");
        println!("  Signer Public Key: {}", DSTACK_HARDWARE_SIGNER);
        println!("  Measurement:       {}", signer.measurement);
        println!("  Registered At:     {}", signer.registered_at);
        println!("  Active:            {}", signer.active);
        assert!(signer.active, "Signer must be active");
        assert_eq!(signer.measurement, HARDWARE_MEASUREMENT, "Measurement must match");
    } else {
        panic!("TEE Signer was not found on Escrow contract!");
    }

    println!("\n============================================================");
    println!("  PHALA TEE SIGNER & MEASUREMENT REGISTRATION COMPLETE!     ");
    println!("============================================================");
    println!("Proposal Creation Tx:     {}", req1_tx);
    println!("Proposal Confirmation Tx: {}", confirm1_tx);
    println!("Execution Proposal Tx:    {}", exec_req_tx);
    println!("Execution Confirmation Tx:{}", confirm_exec_tx);
    println!("Escrow Contract:          {}", escrow_id);
    println!("TEE Signer:               {}", DSTACK_HARDWARE_SIGNER);
    println!("Measurement (MRTD+RTMR3): {}", HARDWARE_MEASUREMENT);
    println!("============================================================");

    Ok(())
}
