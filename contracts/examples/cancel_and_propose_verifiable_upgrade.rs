use conpi_escrow::types::AdminAction;
use near_sdk::json_types::Base64VecU8;
use near_workspaces::types::SecretKey;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::fs;
use std::path::Path;
use std::str::FromStr;

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

#[derive(Serialize)]
struct ProposeArgs {
    action: AdminAction,
}

#[derive(Serialize)]
struct CancelArgs {
    proposal_id: u64,
}

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    println!("=== CANCEL FAKE PROPOSAL #2 & STAGE VERIFIABLE UPGRADE PROPOSAL VIA MULTISIG ===");

    let creds_p1 = Path::new(".credentials/dao_member_keys.json");
    let creds_p2 = Path::new("contracts/.credentials/dao_member_keys.json");
    let credentials_path = if creds_p1.exists() {
        creds_p1
    } else if creds_p2.exists() {
        creds_p2
    } else {
        eprintln!(
            "Error: Credentials file not found at .credentials/dao_member_keys.json or contracts/.credentials/dao_member_keys.json."
        );
        std::process::exit(1);
    };

    let file_content = fs::read_to_string(credentials_path)?;
    let dao_keys: DaoKeysFile = serde_json::from_str(&file_content)?;

    let escrow_id: near_workspaces::AccountId = "dev-20261103021728-21839689153509.testnet".parse()?;
    let dao_id: near_workspaces::AccountId = dao_keys.dao_account_id.parse()?;

    println!("Escrow Contract:   {}", escrow_id);
    println!("Multisig DAO:      {}", dao_id);

    let member1_sk = SecretKey::from_str(&dao_keys.members[0].secret_key)?;
    let member2_sk = SecretKey::from_str(&dao_keys.members[1].secret_key)?;

    println!("Member 1 Key:      {}", member1_sk.public_key());
    println!("Member 2 Key:      {}", member2_sk.public_key());

    let wasm_path = Path::new("contracts/res/conpi_escrow.wasm");
    let wasm_bytes = fs::read(wasm_path)?;
    let mut hasher = Sha256::new();
    hasher.update(&wasm_bytes);
    let code_hash_bytes: [u8; 32] = hasher.finalize().into();

    let hex_hash = hex::encode(code_hash_bytes);
    let bs58_hash = near_sdk::bs58::encode(&code_hash_bytes).into_string();

    println!("Target WASM Path:  {:?}", wasm_path);
    println!("WASM Size:         {} bytes", wasm_bytes.len());
    println!("SHA-256 (Hex):     {}", hex_hash);
    println!("SHA-256 (Base58):  {}", bs58_hash);

    let worker = near_workspaces::testnet().await?;
    let escrow_contract = near_workspaces::Contract::from_secret_key(
        escrow_id.clone(),
        near_workspaces::types::SecretKey::from_random(near_workspaces::types::KeyType::ED25519),
        &worker,
    );

    let member1_signer =
        near_workspaces::Account::from_secret_key(dao_id.clone(), member1_sk, &worker);
    let member2_signer =
        near_workspaces::Account::from_secret_key(dao_id.clone(), member2_sk, &worker);

    // -------------------------------------------------------------------------
    // PART 1: Cancel Proposal #2
    // -------------------------------------------------------------------------
    println!("\n--- [PART 1/2] Cancelling Staged Proposal #2 ---");
    let cancel_call_args = serde_json::to_vec(&CancelArgs { proposal_id: 2 })?;
    let cancel_b64 = Base64VecU8::from(cancel_call_args);

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
        .gas(near_workspaces::types::Gas::from_tgas(100))
        .transact()
        .await?;

    if !cancel_req_res.is_success() {
        eprintln!("Cancel add_request_and_confirm failed: {:?}", cancel_req_res.failures());
        std::process::exit(1);
    }
    let cancel_req_tx = cancel_req_res.outcome().transaction_hash;
    let cancel_req_id: u32 = cancel_req_res.json()?;
    println!("Cancel Request #{} created by Member 1 (Tx: {})", cancel_req_id, cancel_req_tx);

    let cancel_confirm_res = member2_signer
        .call(&dao_id, "confirm")
        .args_json(serde_json::json!({ "request_id": cancel_req_id }))
        .gas(near_workspaces::types::Gas::from_tgas(100))
        .transact()
        .await?;

    if !cancel_confirm_res.is_success() {
        eprintln!("Cancel confirm failed: {:?}", cancel_confirm_res.failures());
        std::process::exit(1);
    }
    let cancel_confirm_tx = cancel_confirm_res.outcome().transaction_hash;
    println!("Cancel Request #{} confirmed by Member 2 (Tx: {})", cancel_req_id, cancel_confirm_tx);

    // Verify Proposal #2 is gone
    let check_prop_2: Option<serde_json::Value> = escrow_contract
        .view("get_staged_proposal")
        .args_json(serde_json::json!({ "proposal_id": 2 }))
        .await?
        .json()?;
    assert!(check_prop_2.is_none(), "Proposal #2 should now be cancelled");
    println!("Verified: Proposal #2 successfully cancelled on Escrow contract!");

    // -------------------------------------------------------------------------
    // PART 2: Propose Verifiable Upgrade (Proposal #3)
    // -------------------------------------------------------------------------
    println!("\n--- [PART 2/2] Staging Proposal #3 (Verifiable WASM Upgrade) ---");
    let propose_call_args = serde_json::to_vec(&ProposeArgs {
        action: AdminAction::Upgrade {
            code_hash: code_hash_bytes,
        },
    })?;
    let propose_b64 = Base64VecU8::from(propose_call_args);

    let prop_req_res = member1_signer
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
        .await?;

    if !prop_req_res.is_success() {
        eprintln!("Upgrade add_request_and_confirm failed: {:?}", prop_req_res.failures());
        std::process::exit(1);
    }
    let prop_req_tx = prop_req_res.outcome().transaction_hash;
    let prop_req_id: u32 = prop_req_res.json()?;
    println!("Upgrade Request #{} created by Member 1 (Tx: {})", prop_req_id, prop_req_tx);

    let prop_confirm_res = member2_signer
        .call(&dao_id, "confirm")
        .args_json(serde_json::json!({ "request_id": prop_req_id }))
        .gas(near_workspaces::types::Gas::from_tgas(100))
        .transact()
        .await?;

    if !prop_confirm_res.is_success() {
        eprintln!("Upgrade confirm failed: {:?}", prop_confirm_res.failures());
        std::process::exit(1);
    }
    let prop_confirm_tx = prop_confirm_res.outcome().transaction_hash;
    println!("Upgrade Request #{} confirmed by Member 2 (Tx: {})", prop_req_id, prop_confirm_tx);

    // Verify Proposal #3 is staged on Escrow
    let check_prop_3: Option<serde_json::Value> = escrow_contract
        .view("get_staged_proposal")
        .args_json(serde_json::json!({ "proposal_id": 3 }))
        .await?
        .json()?;

    if let Some(prop3) = check_prop_3 {
        println!("\nSUCCESS: Proposal #3 staged on NEAR Testnet!");
        println!("  - Action:        {:?}", prop3["action"]);
        println!("  - Ready At (ns): {}", prop3["ready_at"]);
        let ready_at_ns = prop3["ready_at"].as_u64().unwrap();
        let ready_at_sec = ready_at_ns / 1_000_000_000;
        println!("  - Ready At (sec):{}", ready_at_sec);
    } else {
        panic!("Proposal #3 failed to stage on Escrow!");
    }

    Ok(())
}
