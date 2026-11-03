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

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    println!("=== PROPOSE TIMELOCKED CONTRACT UPGRADE (PROPOSAL #2) VIA MULTISIG ===");

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

    // Locate the verifiable WASM binary
    let wasm_p1 = Path::new("contracts/res/conpi_escrow.wasm");
    let wasm_p2 = Path::new("res/conpi_escrow.wasm");
    let wasm_p3 = Path::new("contracts/target/near/conpi_escrow.wasm");
    let wasm_p4 = Path::new("target/near/conpi_escrow.wasm");
    let wasm_path = if wasm_p1.exists() {
        wasm_p1
    } else if wasm_p2.exists() {
        wasm_p2
    } else if wasm_p3.exists() {
        wasm_p3
    } else if wasm_p4.exists() {
        wasm_p4
    } else {
        eprintln!("Error: conpi_escrow.wasm not found in res/ or target/near/");
        std::process::exit(1);
    };

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

    // 1. Prepare propose_admin_action call with AdminAction::Upgrade
    let propose_call_args = serde_json::to_vec(&ProposeArgs {
        action: AdminAction::Upgrade {
            code_hash: code_hash_bytes,
        },
    })?;
    let propose_b64 = Base64VecU8::from(propose_call_args);

    // 2. Member 1 proposes AdminAction::Upgrade on Escrow via Multisig
    println!("\n[1/2] Member 1 proposing AdminAction::Upgrade on DAO Multisig...");
    let req_res = member1_signer
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

    if !req_res.is_success() {
        eprintln!("add_request_and_confirm failed: {:?}", req_res.failures());
        std::process::exit(1);
    }

    let req_tx_hash = req_res.outcome().transaction_hash;
    let req_id: u32 = req_res.json()?;
    println!("Step 1 Success!");
    println!("  - Multisig Request ID: {}", req_id);
    println!("  - Member 1 Tx Hash:    {}", req_tx_hash);
    println!("  - Confirmations:       1 of 2");

    // 3. Member 2 confirms request -> Quorum reached (2/2) -> Multisig calls Escrow
    println!("\n[2/2] Member 2 confirming request ID {} to reach 2/2 quorum...", req_id);
    let confirm_res = member2_signer
        .call(&dao_id, "confirm")
        .args_json(serde_json::json!({
            "request_id": req_id
        }))
        .gas(near_workspaces::types::Gas::from_tgas(150))
        .transact()
        .await?;

    if !confirm_res.is_success() {
        eprintln!("confirm failed: {:?}", confirm_res.failures());
        std::process::exit(1);
    }

    let confirm_tx_hash = confirm_res.outcome().transaction_hash;
    println!("Step 2 Success!");
    println!("  - Member 2 Tx Hash:    {}", confirm_tx_hash);
    println!("  - Multisig Quorum Reached: 2/2 confirmations.");

    // 4. Verify Proposal #2 is staged on Escrow
    println!("\nVerifying Proposal #2 on Escrow Contract...");
    let proposal_info: Option<serde_json::Value> = escrow_contract
        .view("get_staged_proposal")
        .args_json(serde_json::json!({ "proposal_id": 2 }))
        .await?
        .json()?;

    match proposal_info {
        Some(staged) => {
            println!("SUCCESS! Proposal #2 staged on-chain:");
            println!("  - Staged Action: {}", staged["action"]);
            println!("  - Ready At (ns): {}", staged["ready_at"]);
            let ready_at_secs = staged["ready_at"].as_u64().unwrap_or(0) / 1_000_000_000;
            println!("  - Ready At (Unix): {}", ready_at_secs);
        }
        None => {
            panic!("Proposal #2 not found on Escrow contract!");
        }
    }

    println!("\n============================================================");
    println!("   UPGRADE PROPOSAL #2 SUCCESSFULLY STAGED ON TESTNET       ");
    println!("============================================================");
    println!("Escrow Contract:       {}", escrow_id);
    println!("DAO Multisig:          {}", dao_id);
    println!("Multisig Request ID:   {}", req_id);
    println!("Member 1 Tx Hash:      {}", req_tx_hash);
    println!("Member 2 Tx Hash:      {}", confirm_tx_hash);
    println!("WASM SHA-256 (Hex):    {}", hex_hash);
    println!("WASM SHA-256 (Base58): {}", bs58_hash);
    println!("Timelock Delay:        48 Hours");
    println!("============================================================");

    Ok(())
}
