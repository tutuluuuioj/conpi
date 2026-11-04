use conpi_escrow::types::AdminAction;
use near_sdk::json_types::Base64VecU8;
use near_workspaces::types::{Gas, SecretKey};
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
const LIVE_MEASUREMENT: &str = "mrtd:7fe60787222bd394cb516abca2435f22f035ab2cc9c0a4b4b3b148e46297f3d931a237b72f359052c6e657d8c1409173|compose:c847677bcdbe7d532fa96beabe82cb19e5c7ae44feed9e2c0d941660257d4ed0";

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    println!("============================================================");
    println!("  SET APPROVED CVM MEASUREMENT VIA MULTISIG DAO             ");
    println!("============================================================");

    // 1. Load keys
    let creds_p1 = Path::new(".credentials/dao_member_keys.json");
    let creds_p2 = Path::new("contracts/.credentials/dao_member_keys.json");
    let credentials_path = if creds_p1.exists() { creds_p1 } else { creds_p2 };

    let keys_content = fs::read_to_string(credentials_path)?;
    let keys_file: DaoKeysFile = serde_json::from_str(&keys_content)?;
    let dao_id: near_sdk::AccountId = keys_file.dao_account_id.parse()?;
    let escrow_id: near_sdk::AccountId = ESCROW_ID.parse()?;

    let member1_sk: SecretKey = keys_file.members[0].secret_key.parse()?;
    let member2_sk: SecretKey = keys_file.members[1].secret_key.parse()?;

    println!("DAO Account:    {}", dao_id);
    println!("Escrow Account: {}", escrow_id);
    println!("Measurement:    {}", LIVE_MEASUREMENT);

    let worker = near_workspaces::testnet().await?;
    let member1_signer = near_workspaces::Account::from_secret_key(dao_id.clone(), member1_sk, &worker);
    let member2_signer = near_workspaces::Account::from_secret_key(dao_id.clone(), member2_sk, &worker);

    // Wait until owner is DAO
    loop {
        let current_owner: String = worker.view(&escrow_id, "get_owner").await?.json()?;
        println!("Current Escrow Owner: {}", current_owner);
        if current_owner == dao_id.to_string() {
            println!("Confirmed owner is Multisig DAO!");
            break;
        }
        println!("Waiting for return of ownership to DAO... (current = {})", current_owner);
        tokio::time::sleep(std::time::Duration::from_secs(15)).await;
    }

    // 2. Stage SetApprovedMeasurement proposal via DAO
    println!("\n[1/4] Member 1 proposing SetApprovedMeasurement on Multisig DAO...");
    let action = AdminAction::SetApprovedMeasurement {
        measurement: LIVE_MEASUREMENT.to_string(),
    };
    let propose_call_args = serde_json::to_vec(&ProposeArgs { action })?;
    let propose_b64 = Base64VecU8::from(propose_call_args);

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
        .gas(Gas::from_tgas(100))
        .transact()
        .await?
        .into_result()?;
    let request_id: u32 = add_req_res.json()?;
    println!("Multisig Request #{} created. Tx: {}", request_id, add_req_res.outcome().transaction_hash);

    println!("\n[2/4] Member 2 confirming on Multisig DAO...");
    let confirm_res = member2_signer
        .call(&dao_id, "confirm")
        .args_json(serde_json::json!({ "request_id": request_id }))
        .gas(Gas::from_tgas(150))
        .transact()
        .await?
        .into_result()?;
    println!("Quorum (2/2) reached! Proposal staged on Escrow. Tx: {}", confirm_res.outcome().transaction_hash);

    // Query staged proposals
    let staged_proposals: Vec<(u64, serde_json::Value)> = worker
        .view(&escrow_id, "list_staged_proposals")
        .args_json(serde_json::json!({}))
        .await?
        .json()?;
    let (prop_id, prop_val) = staged_proposals.last().unwrap();
    let proposal_id = *prop_id;
    let ready_at_ns: u64 = if let Some(n) = prop_val["ready_at"].as_u64() {
        n
    } else {
        prop_val["ready_at"].as_str().unwrap().parse()?
    };
    let ready_at_secs = ready_at_ns / 1_000_000_000;

    println!("Staged Proposal ID: {}", proposal_id);
    println!("Ready At (Unix):    {}", ready_at_secs);

    // 3. Wait for 5-minute timelock
    println!("\n[3/4] WAITING FOR 5-MINUTE TIMELOCK TO MATURE...");
    loop {
        let now_secs = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)?
            .as_secs();
        if now_secs >= ready_at_secs {
            println!("Timelock period has matured! (now={} >= ready_at={})", now_secs, ready_at_secs);
            break;
        }
        let rem = ready_at_secs - now_secs;
        println!("Waiting for timelock... {}s remaining ({}m {}s)", rem, rem / 60, rem % 60);
        tokio::time::sleep(std::time::Duration::from_secs(20)).await;
    }

    // 4. Execute SetApprovedMeasurement via DAO
    println!("\n[4/4] Executing Proposal #{} via Multisig DAO...", proposal_id);
    let exec_call_args = serde_json::to_vec(&ExecuteArgs { proposal_id, code: None })?;
    let exec_b64 = Base64VecU8::from(exec_call_args);

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
        .gas(Gas::from_tgas(100))
        .transact()
        .await?
        .into_result()?;
    let exec_req_id: u32 = add_exec_res.json()?;

    let confirm_exec_res = member2_signer
        .call(&dao_id, "confirm")
        .args_json(serde_json::json!({ "request_id": exec_req_id }))
        .gas(Gas::from_tgas(150))
        .transact()
        .await?
        .into_result()?;
    println!("Execution confirmed! Tx: {}", confirm_exec_res.outcome().transaction_hash);

    let final_approved: Option<String> = worker.view(&escrow_id, "get_approved_measurement").await?.json()?;
    println!("\n============================================================");
    println!("ON-CHAIN APPROVED MEASUREMENT: {:?}", final_approved);
    println!("EXPECTED MEASUREMENT:          {:?}", Some(LIVE_MEASUREMENT.to_string()));
    println!("============================================================");
    assert_eq!(final_approved, Some(LIVE_MEASUREMENT.to_string()));

    Ok(())
}
