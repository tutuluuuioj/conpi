use conpi_escrow::types::AdminAction;
use near_sdk::json_types::Base64VecU8;
use near_workspaces::types::{Gas, SecretKey};
use serde::Deserialize;
use sha2::{Digest, Sha256};
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

#[derive(Deserialize)]
struct KeyFile {
    #[serde(alias = "account_id")]
    #[serde(rename = "accountId")]
    account_id: String,
    #[serde(alias = "secret_key")]
    #[serde(rename = "privateKey")]
    secret_key: String,
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

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    println!("============================================================");
    println!("  DEPLOY REPRODUCIBLE CI WASM THROUGH DAO GOVERNANCE       ");
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

    let funder_p1 = Path::new(".credentials/testnet_funder.json");
    let funder_p2 = Path::new("contracts/.credentials/testnet_funder.json");
    let funder_path = if funder_p1.exists() { funder_p1 } else { funder_p2 };
    let funder_file: KeyFile = serde_json::from_str(&fs::read_to_string(funder_path)?)?;
    let deployer_id: near_sdk::AccountId = funder_file.account_id.parse()?;
    let deployer_sk: SecretKey = funder_file.secret_key.parse()?;

    // Read Verifiable WASM file
    let wasm_p1 = Path::new("contracts/res/verifiable_ci/conpi_escrow.wasm");
    let wasm_p2 = Path::new("res/verifiable_ci/conpi_escrow.wasm");
    let wasm_path = if wasm_p1.exists() { wasm_p1 } else { wasm_p2 };
    let wasm_bytes = fs::read(wasm_path)?;
    let mut hasher = Sha256::new();
    hasher.update(&wasm_bytes);
    let code_hash_bytes: [u8; 32] = hasher.finalize().into();
    let hex_hash = hex::encode(code_hash_bytes);
    let bs58_hash = near_sdk::bs58::encode(&code_hash_bytes).into_string();

    println!("DAO Account:      {}", dao_id);
    println!("Escrow Account:   {}", escrow_id);
    println!("Deployer Account: {}", deployer_id);
    println!("WASM Path:        {:?} ({} bytes)", wasm_path, wasm_bytes.len());
    println!("WASM SHA256 Hex:  {}", hex_hash);
    println!("WASM SHA256 Bs58: {}", bs58_hash);

    println!("\nConnecting to NEAR Testnet...");
    let worker = near_workspaces::testnet().await?;
    let member1_signer = near_workspaces::Account::from_secret_key(dao_id.clone(), member1_sk, &worker);
    let member2_signer = near_workspaces::Account::from_secret_key(dao_id.clone(), member2_sk, &worker);
    let deployer_signer = near_workspaces::Account::from_secret_key(deployer_id.clone(), deployer_sk, &worker);

    // Verify current owner
    let current_owner: String = worker.view(&escrow_id, "get_owner").await?.json()?;
    println!("Current Escrow Owner: {}", current_owner);
    assert_eq!(current_owner, dao_id.to_string(), "Owner must be Multisig DAO");

    // 2. Stage Proposal for Upgrade { code_hash } via Multisig DAO
    println!("\n[1/6] Staging Proposal for Upgrade via Multisig DAO...");
    let upgrade_action = AdminAction::Upgrade {
        code_hash: code_hash_bytes,
    };
    let upgrade_b64 = Base64VecU8::from(serde_json::to_vec(&ProposeArgs { action: upgrade_action })?);

    let add_upg_res = member1_signer
        .call(&dao_id, "add_request_and_confirm")
        .args_json(serde_json::json!({
            "request": {
                "receiver_id": escrow_id,
                "actions": [
                    {
                        "type": "FunctionCall",
                        "method_name": "propose_admin_action",
                        "args": upgrade_b64,
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
    let upg_req_id: u32 = add_upg_res.json()?;
    println!("Multisig Request #{} created for Upgrade. Tx: {}", upg_req_id, add_upg_res.outcome().transaction_hash);

    let conf_upg_res = member2_signer
        .call(&dao_id, "confirm")
        .args_json(serde_json::json!({ "request_id": upg_req_id }))
        .gas(Gas::from_tgas(150))
        .transact()
        .await?
        .into_result()?;
    println!("Upgrade proposal confirmed by Member 2. Tx: {}", conf_upg_res.outcome().transaction_hash);

    // 3. Stage Proposal for TransferOwnership to deployer via Multisig DAO
    println!("\n[2/6] Staging Proposal for TransferOwnership to deployer via Multisig DAO...");
    let transfer_action = AdminAction::TransferOwnership {
        new_owner: deployer_id.clone(),
    };
    let transfer_b64 = Base64VecU8::from(serde_json::to_vec(&ProposeArgs { action: transfer_action })?);

    let add_trf_res = member1_signer
        .call(&dao_id, "add_request_and_confirm")
        .args_json(serde_json::json!({
            "request": {
                "receiver_id": escrow_id,
                "actions": [
                    {
                        "type": "FunctionCall",
                        "method_name": "propose_admin_action",
                        "args": transfer_b64,
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
    let trf_req_id: u32 = add_trf_res.json()?;
    println!("Multisig Request #{} created for TransferOwnership. Tx: {}", trf_req_id, add_trf_res.outcome().transaction_hash);

    let conf_trf_res = member2_signer
        .call(&dao_id, "confirm")
        .args_json(serde_json::json!({ "request_id": trf_req_id }))
        .gas(Gas::from_tgas(150))
        .transact()
        .await?
        .into_result()?;
    println!("TransferOwnership proposal confirmed by Member 2. Tx: {}", conf_trf_res.outcome().transaction_hash);

    // Query staged proposals
    let staged_proposals: Vec<(u64, serde_json::Value)> = worker
        .view(&escrow_id, "list_staged_proposals")
        .args_json(serde_json::json!({}))
        .await?
        .json()?;
    println!("\nActive Staged Proposals on Escrow: {:?}", staged_proposals);

    let (prop_upgrade_id, _prop_upgrade_val) = &staged_proposals[staged_proposals.len() - 2];
    let (prop_transfer_id, prop_transfer_val) = &staged_proposals[staged_proposals.len() - 1];

    let prop_upgrade_id = *prop_upgrade_id;
    let prop_transfer_id = *prop_transfer_id;

    let trf_ready_at_ns: u64 = if let Some(n) = prop_transfer_val["ready_at"].as_u64() {
        n
    } else {
        prop_transfer_val["ready_at"].as_str().unwrap().parse()?
    };
    let trf_ready_at_secs = trf_ready_at_ns / 1_000_000_000;

    println!("Upgrade Proposal ID:  {}", prop_upgrade_id);
    println!("Transfer Proposal ID: {}", prop_transfer_id);
    println!("Timelock Ready At:    {}", trf_ready_at_secs);

    // 4. Wait for 5-minute timelock
    println!("\n[3/6] WAITING FOR 5-MINUTE TIMELOCK TO MATURE...");
    loop {
        let now_secs = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)?
            .as_secs();
        if now_secs >= trf_ready_at_secs {
            println!("Timelock period has fully matured! (now={} >= ready_at={})", now_secs, trf_ready_at_secs);
            break;
        }
        let rem = trf_ready_at_secs - now_secs;
        println!("Waiting for timelock... {}s remaining ({}m {}s)", rem, rem / 60, rem % 60);
        tokio::time::sleep(std::time::Duration::from_secs(20)).await;
    }

    // 5. Execute TransferOwnership to deployer via Multisig DAO
    println!("\n[4/6] Multisig DAO executing TransferOwnership (Proposal #{})...", prop_transfer_id);
    let exec_trf_args = serde_json::to_vec(&ExecuteArgs { proposal_id: prop_transfer_id, code: None })?;
    let exec_trf_b64 = Base64VecU8::from(exec_trf_args);

    let add_exec_res = member1_signer
        .call(&dao_id, "add_request_and_confirm")
        .args_json(serde_json::json!({
            "request": {
                "receiver_id": escrow_id,
                "actions": [
                    {
                        "type": "FunctionCall",
                        "method_name": "execute_admin_action",
                        "args": exec_trf_b64,
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
    let exec_trf_req_id: u32 = add_exec_res.json()?;

    let conf_exec_trf = member2_signer
        .call(&dao_id, "confirm")
        .args_json(serde_json::json!({ "request_id": exec_trf_req_id }))
        .gas(Gas::from_tgas(150))
        .transact()
        .await?
        .into_result()?;
    println!("TransferOwnership executed! Tx: {}", conf_exec_trf.outcome().transaction_hash);

    let temp_owner: String = worker.view(&escrow_id, "get_owner").await?.json()?;
    println!("Verified Owner is now temporary deployer: {}", temp_owner);
    assert_eq!(temp_owner, deployer_id.to_string());

    // 6. Deployer executes Upgrade Proposal #{prop_upgrade_id} with full 300 Tgas!
    println!("\n[5/6] Deployer executing Upgrade Proposal #{} with verifiable WASM (300 Tgas)...", prop_upgrade_id);
    let upgrade_tx_res = deployer_signer
        .call(&escrow_id, "execute_admin_action")
        .args_json(serde_json::json!({
            "proposal_id": prop_upgrade_id,
            "code": wasm_bytes
        }))
        .gas(Gas::from_tgas(300))
        .transact()
        .await?
        .into_result()?;
    let upgrade_tx = upgrade_tx_res.outcome().transaction_hash;
    println!("SUCCESS! Verifiable WASM upgrade executed! Tx: {}", upgrade_tx);

    // Verify on-chain code hash immediately
    let client = reqwest::Client::new();
    let rpc_res: serde_json::Value = client
        .post("https://rpc.testnet.near.org")
        .json(&serde_json::json!({
            "jsonrpc": "2.0",
            "id": "verify_upgrade",
            "method": "query",
            "params": {
                "request_type": "view_account",
                "finality": "final",
                "account_id": escrow_id
            }
        }))
        .send()
        .await?
        .json()
        .await?;

    let on_chain_code_hash = rpc_res["result"]["code_hash"]
        .as_str()
        .unwrap_or("unknown");

    println!("\n============================================================");
    println!("ON-CHAIN CODE HASH:     {}", on_chain_code_hash);
    println!("CI ARTIFACT BASE58:     {}", bs58_hash);
    println!("UPGRADE TRANSACTION:    {}", upgrade_tx);
    println!("============================================================");
    assert_eq!(on_chain_code_hash, bs58_hash, "On-chain code hash must match CI artifact!");

    // 7. Deployer immediately stages and schedules returning ownership back to Multisig DAO
    println!("\n[6/6] Returning ownership to Multisig DAO...");
    let stage_return = deployer_signer
        .call(&escrow_id, "propose_admin_action")
        .args_json(serde_json::json!({
            "action": {
                "TransferOwnership": {
                    "new_owner": dao_id
                }
            }
        }))
        .gas(Gas::from_tgas(50))
        .transact()
        .await?
        .into_result()?;
    let return_prop_id: u64 = stage_return.json()?;
    println!("Staged Proposal #{} to return ownership to DAO. Tx: {}", return_prop_id, stage_return.outcome().transaction_hash);

    println!("\nWaiting 5 minutes for return timelock...");
    let ret_ready_at_secs = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)?
        .as_secs() + 305;

    loop {
        let now_secs = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)?
            .as_secs();
        if now_secs >= ret_ready_at_secs {
            break;
        }
        let rem = ret_ready_at_secs - now_secs;
        println!("Waiting for return timelock... {}s remaining ({}m {}s)", rem, rem / 60, rem % 60);
        tokio::time::sleep(std::time::Duration::from_secs(20)).await;
    }

    let exec_return = deployer_signer
        .call(&escrow_id, "execute_admin_action")
        .args_json(serde_json::json!({
            "proposal_id": return_prop_id,
            "code": null
        }))
        .gas(Gas::from_tgas(50))
        .transact()
        .await?
        .into_result()?;
    println!("Returned ownership to DAO! Tx: {}", exec_return.outcome().transaction_hash);

    let final_owner: String = worker.view(&escrow_id, "get_owner").await?.json()?;
    println!("Final Escrow Owner: {}", final_owner);
    assert_eq!(final_owner, dao_id.to_string(), "Owner must be returned to Multisig DAO");

    let final_approved_meas: Option<String> = worker.view(&escrow_id, "get_approved_measurement").await?.json()?;
    println!("Final Approved Measurement: {:?}", final_approved_meas);

    println!("\n============================================================");
    println!("  DEPLOYMENT & GOVERNANCE CYCLE 100% COMPLETE AND VERIFIED! ");
    println!("============================================================");

    Ok(())
}
