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

#[derive(serde::Serialize)]
struct CancelArgs {
    proposal_id: u64,
}

const ESCROW_ID: &str = "dev-20261103062448-30583839049419.testnet";

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    println!("============================================================");
    println!("  REAL DIRECT DAO CONTRACT UPGRADE (ZERO OWNERSHIP CHANGE)  ");
    println!("============================================================");

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

    let wasm_path = Path::new("res/verifiable_ci/conpi_escrow.wasm");
    let wasm_bytes = fs::read(wasm_path)?;
    let mut hasher = Sha256::new();
    hasher.update(&wasm_bytes);
    let code_hash_bytes: [u8; 32] = hasher.finalize().into();
    let hex_hash = hex::encode(code_hash_bytes);
    let bs58_hash = near_sdk::bs58::encode(&code_hash_bytes).into_string();

    println!("DAO Account:        {}", dao_id);
    println!("Escrow Account:     {}", escrow_id);
    println!("WASM Path:          {:?} ({} bytes)", wasm_path, wasm_bytes.len());
    println!("Target SHA256 Hex:  {}", hex_hash);
    println!("Target SHA256 Bs58: {}", bs58_hash);

    println!("\nConnecting to NEAR Testnet...");
    let worker = near_workspaces::testnet().await?;
    let member1_signer = near_workspaces::Account::from_secret_key(dao_id.clone(), member1_sk, &worker);
    let member2_signer = near_workspaces::Account::from_secret_key(dao_id.clone(), member2_sk, &worker);
    let deployer_signer = near_workspaces::Account::from_secret_key(deployer_id.clone(), deployer_sk, &worker);

    // 1. Verify owner is DAO
    let initial_owner: String = worker.view(&escrow_id, "get_owner").await?.json()?;
    println!("Current Escrow Owner: {}", initial_owner);
    assert_eq!(initial_owner, dao_id.to_string(), "Owner must be Multisig DAO");

    // 2. Stage Proposal for Upgrade via Multisig DAO
    println!("\n[1/5] Staging Upgrade Proposal via Multisig DAO...");
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
    let stage_prop_tx = add_upg_res.outcome().transaction_hash;
    println!("Multisig Request #{} created for Upgrade. Tx: {}", upg_req_id, stage_prop_tx);

    let conf_upg_res = member2_signer
        .call(&dao_id, "confirm")
        .args_json(serde_json::json!({ "request_id": upg_req_id }))
        .gas(Gas::from_tgas(150))
        .transact()
        .await?
        .into_result()?;
    let conf_prop_tx = conf_upg_res.outcome().transaction_hash;
    println!("Upgrade proposal confirmed by Member 2. Tx: {}", conf_prop_tx);

    // Retrieve active staged proposal on Escrow
    let staged_proposals: Vec<(u64, serde_json::Value)> = worker
        .view(&escrow_id, "list_staged_proposals")
        .args_json(serde_json::json!({}))
        .await?
        .json()?;
    let (prop_id, prop_val) = staged_proposals
        .iter()
        .find(|(_, val)| val["action"].get("Upgrade").is_some())
        .expect("Upgrade proposal must be staged on Escrow");
    let prop_id = *prop_id;

    let ready_at_ns: u64 = if let Some(n) = prop_val["ready_at"].as_u64() {
        n
    } else {
        prop_val["ready_at"].as_str().unwrap().parse()?
    };
    let ready_at_secs = ready_at_ns / 1_000_000_000;
    println!("Active Escrow Upgrade Proposal ID: #{}", prop_id);
    println!("Timelock Ready At:                 {}", ready_at_secs);

    // 3. Stage Bytecode directly via stage_upgrade_code (NO ownership change!)
    println!("\n[2/5] Staging WASM code directly via stage_upgrade_code (Owner remains DAO)...");
    let stage_code_res = deployer_signer
        .call(&escrow_id, "stage_upgrade_code")
        .args_json(serde_json::json!({ "code": wasm_bytes }))
        .gas(Gas::from_tgas(300))
        .transact()
        .await?
        .into_result()?;
    let stage_code_tx = stage_code_res.outcome().transaction_hash;
    println!("WASM staged directly on Escrow! Tx: {}", stage_code_tx);

    let has_staged_now: bool = worker.view(&escrow_id, "has_staged_upgrade_code").await?.json()?;
    println!("has_staged_upgrade_code: {}", has_staged_now);
    assert!(has_staged_now, "WASM must be staged");

    let mid_owner: String = worker.view(&escrow_id, "get_owner").await?.json()?;
    println!("Escrow Owner is strictly DAO: {}", mid_owner);
    assert_eq!(mid_owner, dao_id.to_string());

    // 4. Wait for 5-minute timelock to mature
    println!("\n[3/5] WAITING FOR 5-MINUTE TIMELOCK TO MATURE...");
    loop {
        let now_secs = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)?
            .as_secs();
        if now_secs >= ready_at_secs {
            println!("Timelock period has fully matured! (now={} >= ready_at={})", now_secs, ready_at_secs);
            break;
        }
        let rem = ready_at_secs - now_secs;
        println!("Waiting for timelock... {}s remaining ({}m {}s)", rem, rem / 60, rem % 60);
        tokio::time::sleep(std::time::Duration::from_secs(20)).await;
    }

    // 5. Execute Upgrade DIRECTLY through Multisig DAO with ZERO WASM bytes in call!
    println!("\n[4/5] Multisig DAO executing Upgrade (Proposal #{}) with NULL code argument...", prop_id);
    let exec_args = serde_json::to_vec(&ExecuteArgs {
        proposal_id: prop_id,
        code: None, // ZERO WASM BYTES PASSED THROUGH MULTISIG!
    })?;
    let exec_b64 = Base64VecU8::from(exec_args);

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
                        "gas": "250000000000000"
                    }
                ]
            }
        }))
        .gas(Gas::from_tgas(100))
        .transact()
        .await?
        .into_result()?;
    let exec_req_id: u32 = add_exec_res.json()?;
    let exec_req_tx = add_exec_res.outcome().transaction_hash;
    println!("Multisig Request #{} created for Upgrade Execution. Tx: {}", exec_req_id, exec_req_tx);

    let conf_exec_res = member2_signer
        .call(&dao_id, "confirm")
        .args_json(serde_json::json!({ "request_id": exec_req_id }))
        .gas(Gas::from_tgas(300))
        .transact()
        .await?
        .into_result()?;
    let upgrade_exec_tx = conf_exec_res.outcome().transaction_hash;
    println!("UPGRADE EXECUTED BY DAO! Tx: {}", upgrade_exec_tx);

    // Verify on-chain results
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
    println!("EXECUTION TRANSACTION:  {}", upgrade_exec_tx);
    println!("============================================================");
    assert_eq!(on_chain_code_hash, bs58_hash, "On-chain code hash must match CI artifact!");

    let final_owner: String = worker.view(&escrow_id, "get_owner").await?.json()?;
    println!("Escrow Owner after upgrade: {}", final_owner);
    assert_eq!(final_owner, dao_id.to_string(), "Owner must strictly remain Multisig DAO");

    let has_staged_after: bool = worker.view(&escrow_id, "has_staged_upgrade_code").await?.json()?;
    println!("has_staged_upgrade_code after migration: {}", has_staged_after);
    assert!(!has_staged_after, "Staged upgrade code must be cleared after upgrade/migration");

    // 6. Test on-chain cancellation clears staged upgrade code
    println!("\n[5/5] Testing that cancelling an Upgrade proposal clears staged upgrade code on live contract...");
    let dummy_code = vec![0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00];
    let mut dummy_hasher = Sha256::new();
    dummy_hasher.update(&dummy_code);
    let dummy_hash: [u8; 32] = dummy_hasher.finalize().into();

    let dummy_upg_b64 = Base64VecU8::from(serde_json::to_vec(&ProposeArgs {
        action: AdminAction::Upgrade { code_hash: dummy_hash },
    })?);

    let dummy_add_res = member1_signer
        .call(&dao_id, "add_request_and_confirm")
        .args_json(serde_json::json!({
            "request": {
                "receiver_id": escrow_id,
                "actions": [
                    {
                        "type": "FunctionCall",
                        "method_name": "propose_admin_action",
                        "args": dummy_upg_b64,
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
    let dummy_req_id: u32 = dummy_add_res.json()?;

    member2_signer
        .call(&dao_id, "confirm")
        .args_json(serde_json::json!({ "request_id": dummy_req_id }))
        .gas(Gas::from_tgas(150))
        .transact()
        .await?
        .into_result()?;

    let dummy_proposals: Vec<(u64, serde_json::Value)> = worker
        .view(&escrow_id, "list_staged_proposals")
        .args_json(serde_json::json!({}))
        .await?
        .json()?;
    let (dummy_prop_id, _) = dummy_proposals
        .iter()
        .find(|(_, val)| val["action"].get("Upgrade").is_some())
        .expect("Dummy upgrade proposal must be staged");
    let dummy_prop_id = *dummy_prop_id;
    println!("Dummy Upgrade Proposal Staged: #{}", dummy_prop_id);

    // Stage dummy code
    deployer_signer
        .call(&escrow_id, "stage_upgrade_code")
        .args_json(serde_json::json!({ "code": dummy_code }))
        .gas(Gas::from_tgas(300))
        .transact()
        .await?
        .into_result()?;

    let has_staged_dummy: bool = worker.view(&escrow_id, "has_staged_upgrade_code").await?.json()?;
    println!("has_staged_upgrade_code before cancellation: {}", has_staged_dummy);
    assert!(has_staged_dummy, "Dummy code must be staged");

    // Cancel dummy proposal via DAO
    let cancel_b64 = Base64VecU8::from(serde_json::to_vec(&CancelArgs { proposal_id: dummy_prop_id })?);
    let cancel_add_res = member1_signer
        .call(&dao_id, "add_request_and_confirm")
        .args_json(serde_json::json!({
            "request": {
                "receiver_id": escrow_id,
                "actions": [
                    {
                        "type": "FunctionCall",
                        "method_name": "cancel_admin_action",
                        "args": cancel_b64,
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
    let cancel_req_id: u32 = cancel_add_res.json()?;

    let cancel_conf_res = member2_signer
        .call(&dao_id, "confirm")
        .args_json(serde_json::json!({ "request_id": cancel_req_id }))
        .gas(Gas::from_tgas(150))
        .transact()
        .await?
        .into_result()?;
    let cancel_tx = cancel_conf_res.outcome().transaction_hash;
    println!("Dummy proposal cancelled by DAO! Tx: {}", cancel_tx);

    // Verify has_staged_upgrade_code is now FALSE!
    let has_staged_after_cancel: bool = worker.view(&escrow_id, "has_staged_upgrade_code").await?.json()?;
    println!("has_staged_upgrade_code after cancellation: {}", has_staged_after_cancel);
    assert!(!has_staged_after_cancel, "Staged upgrade code must be cleared when proposal is cancelled!");

    println!("\n============================================================");
    println!("  ALL CHECKS & REAL DIRECT DAO UPGRADE 100% VERIFIED!       ");
    println!("============================================================");

    Ok(())
}
