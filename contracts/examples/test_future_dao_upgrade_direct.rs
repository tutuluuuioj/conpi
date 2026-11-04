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

const ESCROW_ID: &str = "dev-20261103062448-30583839049419.testnet";

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    println!("============================================================");
    println!("  TEST FUTURE ZERO-CODE DAO UPGRADE ON LIVE TESTNET         ");
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

    println!("Connecting to NEAR Testnet...");
    let worker = near_workspaces::testnet().await?;
    let member1_signer = near_workspaces::Account::from_secret_key(dao_id.clone(), member1_sk, &worker);
    let member2_signer = near_workspaces::Account::from_secret_key(dao_id.clone(), member2_sk, &worker);
    let deployer_signer = near_workspaces::Account::from_secret_key(deployer_id.clone(), deployer_sk, &worker);

    // 1. Verify owner is DAO
    let owner: String = worker.view(&escrow_id, "get_owner").await?.json()?;
    println!("Escrow Owner: {}", owner);
    assert_eq!(owner, dao_id.to_string(), "Owner must be Multisig DAO");

    // 2. Check initial has_staged_upgrade_code
    let has_staged: bool = worker.view(&escrow_id, "has_staged_upgrade_code").await?.json()?;
    println!("Initial has_staged_upgrade_code: {}", has_staged);
    assert!(!has_staged, "Initially must have no staged upgrade code");

    // 3. Prepare test upgrade payload
    // Using a valid test WASM header or reproducible bytecode
    let wasm_bytes = fs::read("res/verifiable_ci/conpi_escrow.wasm")?;
    let mut hasher = Sha256::new();
    hasher.update(&wasm_bytes);
    let test_hash_bytes: [u8; 32] = hasher.finalize().into();

    println!("Target Upgrade Code Hash (Hex): {}", hex::encode(test_hash_bytes));

    // 4. DAO stages Upgrade proposal
    println!("\n[Step 1] DAO Member 1 proposing Upgrade proposal...");
    let upg_action = AdminAction::Upgrade { code_hash: test_hash_bytes };
    let upg_b64 = Base64VecU8::from(serde_json::to_vec(&ProposeArgs { action: upg_action })?);

    let add_upg_res = member1_signer
        .call(&dao_id, "add_request_and_confirm")
        .args_json(serde_json::json!({
            "request": {
                "receiver_id": escrow_id,
                "actions": [
                    {
                        "type": "FunctionCall",
                        "method_name": "propose_admin_action",
                        "args": upg_b64,
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
    let req_id: u32 = add_upg_res.json()?;
    println!("Multisig Request #{} created. Tx: {}", req_id, add_upg_res.outcome().transaction_hash);

    let conf_res = member2_signer
        .call(&dao_id, "confirm")
        .args_json(serde_json::json!({ "request_id": req_id }))
        .gas(Gas::from_tgas(150))
        .transact()
        .await?
        .into_result()?;
    println!("Confirmed by Member 2! Tx: {}", conf_res.outcome().transaction_hash);

    // Retrieve the staged proposal ID on Escrow
    let staged_proposals: Vec<(u64, serde_json::Value)> = worker
        .view(&escrow_id, "list_staged_proposals")
        .args_json(serde_json::json!({}))
        .await?
        .json()?;
    let (prop_id, _) = staged_proposals.iter().find(|(_, val)| {
        val["action"].get("Upgrade").is_some()
    }).expect("Upgrade proposal must be staged on Escrow");
    println!("Active Staged Upgrade Proposal ID on Escrow: #{}", prop_id);

    // 5. Direct bytecode upload via stage_upgrade_code by deployer/CI (full 300 Tgas available!)
    println!("\n[Step 2] Staging WASM code directly on Escrow via stage_upgrade_code (NO ownership transfer!)...");
    let stage_code_tx = deployer_signer
        .call(&escrow_id, "stage_upgrade_code")
        .args_json(serde_json::json!({ "code": wasm_bytes }))
        .gas(Gas::from_tgas(300))
        .transact()
        .await?
        .into_result()?;
    println!("WASM bytecode staged successfully on Escrow! Tx: {}", stage_code_tx.outcome().transaction_hash);

    // 6. Verify has_staged_upgrade_code is true
    let has_staged_now: bool = worker.view(&escrow_id, "has_staged_upgrade_code").await?.json()?;
    println!("Verified has_staged_upgrade_code on-chain: {}", has_staged_now);
    assert!(has_staged_now, "has_staged_upgrade_code must now be true!");

    // 7. Verify ownership NEVER left the DAO
    let check_owner: String = worker.view(&escrow_id, "get_owner").await?.json()?;
    println!("Verified Escrow Owner remains Multisig DAO: {}", check_owner);
    assert_eq!(check_owner, dao_id.to_string());

    // 8. Clean up test proposal by having DAO cancel it
    println!("\n[Step 3] DAO cancelling test proposal...");
    #[derive(serde::Serialize)]
    struct CancelArgs {
        proposal_id: u64,
    }
    let cancel_b64 = Base64VecU8::from(serde_json::to_vec(&CancelArgs { proposal_id: *prop_id })?);

    let cancel_req_res = member1_signer
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
    let cancel_req_id: u32 = cancel_req_res.json()?;

    let conf_cancel = member2_signer
        .call(&dao_id, "confirm")
        .args_json(serde_json::json!({ "request_id": cancel_req_id }))
        .gas(Gas::from_tgas(150))
        .transact()
        .await?
        .into_result()?;
    println!("Test proposal cancelled by DAO! Tx: {}", conf_cancel.outcome().transaction_hash);

    println!("\n============================================================");
    println!("  DIRECT ZERO-CODE DAO UPGRADE ARCHITECTURE VERIFIED ON-CHAIN! ");
    println!("============================================================");

    Ok(())
}
