use near_sdk::json_types::Base64VecU8;
use near_workspaces::types::SecretKey;
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
struct ExecuteArgs {
    proposal_id: u64,
}

const ESCROW_ID: &str = "dev-20261103062448-30583839049419.testnet";
const PROP_8_TRANSFER: u64 = 8;
const PROP_7_UPGRADE: u64 = 7;
const PROP_9_TEE_SIGNER: u64 = 9;

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    println!("============================================================");
    println!("  EXECUTE PROPOSALS #8 (OWNERSHIP), #7 (UPGRADE), #9 (SIGNER) ");
    println!("============================================================");

    // 1. Load keys
    let creds_p1 = Path::new(".credentials/dao_member_keys.json");
    let creds_p2 = Path::new("contracts/.credentials/dao_member_keys.json");
    let dao_creds_path = if creds_p1.exists() { creds_p1 } else { creds_p2 };

    let dao_keys_file: DaoKeysFile = serde_json::from_str(&fs::read_to_string(dao_creds_path)?)?;
    let dao_id: near_sdk::AccountId = dao_keys_file.dao_account_id.parse()?;
    let escrow_id: near_sdk::AccountId = ESCROW_ID.parse()?;

    let member1_sk: SecretKey = dao_keys_file.members[0].secret_key.parse()?;
    let member2_sk: SecretKey = dao_keys_file.members[1].secret_key.parse()?;

    // Load seller / new owner key
    let seller_p1 = Path::new(".credentials/testnet_funder.json");
    let seller_p2 = Path::new("contracts/.credentials/testnet_funder.json");
    let seller_path = if seller_p1.exists() { seller_p1 } else { seller_p2 };
    let seller_key_file: KeyFile = serde_json::from_str(&fs::read_to_string(seller_path)?)?;
    let seller_id: near_sdk::AccountId = seller_key_file.account_id.parse()?;
    let seller_sk: SecretKey = seller_key_file.secret_key.parse()?;

    // Load WASM
    let wasm_p1 = Path::new("contracts/res/conpi_escrow.wasm");
    let wasm_p2 = Path::new("res/conpi_escrow.wasm");
    let wasm_path = if wasm_p1.exists() { wasm_p1 } else { wasm_p2 };
    let wasm_bytes = fs::read(wasm_path)?;
    let mut hasher = Sha256::new();
    hasher.update(&wasm_bytes);
    let code_hash_bytes: [u8; 32] = hasher.finalize().into();
    let bs58_hash = near_sdk::bs58::encode(&code_hash_bytes).into_string();

    println!("Escrow ID:   {}", escrow_id);
    println!("DAO ID:      {}", dao_id);
    println!("New Owner:   {}", seller_id);
    println!("WASM Base58: {}", bs58_hash);

    let worker = near_workspaces::testnet().await?;
    let member1_signer = near_workspaces::Account::from_secret_key(dao_id.clone(), member1_sk, &worker);
    let member2_signer = near_workspaces::Account::from_secret_key(dao_id.clone(), member2_sk, &worker);
    let seller_signer = near_workspaces::Account::from_secret_key(seller_id.clone(), seller_sk, &worker);

    // 2. Wait for Proposal #8 (TransferOwnership)
    let staged_proposals: Vec<(u64, serde_json::Value)> = worker
        .view(&escrow_id, "list_staged_proposals")
        .args_json(serde_json::json!({}))
        .await?
        .json()?;

    let prop8 = staged_proposals.iter().find(|(id, _)| *id == PROP_8_TRANSFER)
        .expect("Proposal #8 not found!");
    let prop8_ready_at_ns: u64 = if let Some(n) = prop8.1["ready_at"].as_u64() {
        n
    } else if let Some(s) = prop8.1["ready_at"].as_str() {
        s.parse().unwrap_or(0)
    } else {
        0
    };
    let prop8_ready_at_secs = prop8_ready_at_ns / 1_000_000_000;

    println!("\n[1/3] Waiting for Proposal #8 (TransferOwnership) to mature at {}...", prop8_ready_at_secs);
    loop {
        let now_secs = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)?
            .as_secs();
        if now_secs >= prop8_ready_at_secs {
            println!("Proposal #8 timelock matured!");
            break;
        }
        let rem = prop8_ready_at_secs - now_secs;
        println!("Waiting for Proposal #8... {}s remaining ({}m {}s)", rem, rem / 60, rem % 60);
        tokio::time::sleep(std::time::Duration::from_secs(15)).await;
    }

    // Execute Proposal #8 via Multisig
    println!("Executing Proposal #8 (TransferOwnership) via Multisig DAO...");
    let exec8_args = serde_json::to_vec(&ExecuteArgs { proposal_id: PROP_8_TRANSFER })?;
    let exec8_b64 = Base64VecU8::from(exec8_args);

    let add8_res = member1_signer
        .call(&dao_id, "add_request_and_confirm")
        .args_json(serde_json::json!({
            "request": {
                "receiver_id": escrow_id,
                "actions": [
                    {
                        "type": "FunctionCall",
                        "method_name": "execute_admin_action",
                        "args": exec8_b64,
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
    let req8_id: u32 = add8_res.json()?;
    println!("Multisig Request #{} created.", req8_id);

    let confirm8_res = member2_signer
        .call(&dao_id, "confirm")
        .args_json(serde_json::json!({ "request_id": req8_id }))
        .gas(near_workspaces::types::Gas::from_tgas(150))
        .transact()
        .await?
        .into_result()?;
    println!("Proposal #8 executed! Tx: {}", confirm8_res.outcome().transaction_hash);

    let owner_on_chain: near_sdk::AccountId = worker
        .view(&escrow_id, "get_owner")
        .args_json(serde_json::json!({}))
        .await?
        .json()?;
    println!("Verified on-chain: Escrow Owner is now: {}", owner_on_chain);
    assert_eq!(owner_on_chain, seller_id, "Owner must match seller");

    // 3. Execute Proposal #7 (WASM Upgrade) directly by new owner with 300 Tgas!
    println!("\n[2/3] Executing Proposal #7 (WASM Upgrade) with full 300 Tgas directly as owner...");
    let upgrade_res = seller_signer
        .call(&escrow_id, "execute_admin_action")
        .args_json(serde_json::json!({
            "proposal_id": PROP_7_UPGRADE,
            "code": wasm_bytes
        }))
        .gas(near_workspaces::types::Gas::from_tgas(300))
        .transact()
        .await?
        .into_result()?;
    println!("Proposal #7 executed! Tx: {}", upgrade_res.outcome().transaction_hash);

    // Verify code hash on RPC
    let client = reqwest::Client::new();
    let rpc_res: serde_json::Value = client
        .post("https://rpc.testnet.fastnear.com")
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

    let new_code_hash = rpc_res["result"]["code_hash"]
        .as_str()
        .unwrap_or("unknown");
    println!("SUCCESS! New Contract Code Hash: {}", new_code_hash);
    assert_eq!(new_code_hash, bs58_hash, "Code hash must match expected");

    // 4. Wait for Proposal #9 (AddTeeSigner with new compose hash)
    let staged_proposals2: Vec<(u64, serde_json::Value)> = worker
        .view(&escrow_id, "list_staged_proposals")
        .args_json(serde_json::json!({}))
        .await?
        .json()?;

    let prop9 = staged_proposals2.iter().find(|(id, _)| *id == PROP_9_TEE_SIGNER)
        .expect("Proposal #9 not found!");
    let prop9_ready_at_ns: u64 = if let Some(n) = prop9.1["ready_at"].as_u64() {
        n
    } else if let Some(s) = prop9.1["ready_at"].as_str() {
        s.parse().unwrap_or(0)
    } else {
        0
    };
    let prop9_ready_at_secs = prop9_ready_at_ns / 1_000_000_000;

    println!("\n[3/3] Waiting for Proposal #9 (AddTeeSigner) to mature at {}...", prop9_ready_at_secs);
    loop {
        let now_secs = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)?
            .as_secs();
        if now_secs >= prop9_ready_at_secs {
            println!("Proposal #9 timelock matured!");
            break;
        }
        let rem = prop9_ready_at_secs - now_secs;
        println!("Waiting for Proposal #9... {}s remaining ({}m {}s)", rem, rem / 60, rem % 60);
        tokio::time::sleep(std::time::Duration::from_secs(15)).await;
    }

    println!("Executing Proposal #9 (AddTeeSigner)...");
    let prop9_res = seller_signer
        .call(&escrow_id, "execute_admin_action")
        .args_json(serde_json::json!({
            "proposal_id": PROP_9_TEE_SIGNER,
            "code": null
        }))
        .gas(near_workspaces::types::Gas::from_tgas(100))
        .transact()
        .await?
        .into_result()?;
    println!("Proposal #9 executed! Tx: {}", prop9_res.outcome().transaction_hash);

    // Verify TEE Signer on Escrow
    let signer_info: Option<serde_json::Value> = worker
        .view(&escrow_id, "get_tee_signer")
        .args_json(serde_json::json!({ "public_key": "ed25519:CLHhDLsLCCqFeTjz7g31NkfbtN1UqT2mJRmRZgcRPTj3" }))
        .await?
        .json()?;
    println!("Verified TEE Signer on Escrow: {:?}", signer_info);

    println!("\n============================================================");
    println!("  ALL GOVERNANCE TIMELOCKED ACTIONS COMPLETED SUCCESSFULLY!  ");
    println!("============================================================");
    println!("New Contract Code Hash: {}", new_code_hash);
    println!("TEE Signer:             ed25519:CLHhDLsLCCqFeTjz7g31NkfbtN1UqT2mJRmRZgcRPTj3");
    println!("Compose Hash:           3b2df1746e75e7be40019af7995e73239adcdc3b3b1be82d02d663a009ad1979");
    println!("============================================================");

    Ok(())
}
