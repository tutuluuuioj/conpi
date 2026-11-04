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

const ESCROW_ID: &str = "dev-20261103062448-30583839049419.testnet";
const PROP_14_TRANSFER: u64 = 14;
const PROP_13_UPGRADE: u64 = 13;

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    println!("============================================================");
    println!("  EXECUTE PROPOSAL #14 (TRANSFER), #13 (UPGRADE), RETURN DAO");
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
    println!("Funder/EOA:  {}", seller_id);
    println!("WASM Base58: {}", bs58_hash);

    let worker = near_workspaces::testnet().await?;
    let member1_signer = near_workspaces::Account::from_secret_key(dao_id.clone(), member1_sk, &worker);
    let member2_signer = near_workspaces::Account::from_secret_key(dao_id.clone(), member2_sk, &worker);
    let seller_signer = near_workspaces::Account::from_secret_key(seller_id.clone(), seller_sk, &worker);

    // 2. Wait for Proposal #14 (TransferOwnership)
    let prop14_ready_at_secs = 1793766201u64;

    println!("\n[1/4] Waiting for Proposal #14 (TransferOwnership) to mature...");
    loop {
        let now_secs = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)?
            .as_secs();
        if now_secs >= prop14_ready_at_secs {
            println!("Proposal #14 timelock matured! (now={} >= ready_at={})", now_secs, prop14_ready_at_secs);
            break;
        }
        let rem = prop14_ready_at_secs - now_secs;
        println!("Waiting for Proposal #14... {}s remaining ({}m {}s)", rem, rem / 60, rem % 60);
        tokio::time::sleep(std::time::Duration::from_secs(15)).await;
    }

    // 3. DAO executes Proposal #14 (TransferOwnership to seller)
    println!("\n[2/4] Multisig DAO executing Proposal #14 (TransferOwnership)...");
    let exec_call_args = serde_json::to_vec(&serde_json::json!({
        "proposal_id": PROP_14_TRANSFER,
        "code": null
    }))?;
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
    let req_id: u32 = add_exec_res.json()?;
    println!("Multisig Request #{} created to execute Proposal #14.", req_id);

    let confirm_res = member2_signer
        .call(&dao_id, "confirm")
        .args_json(serde_json::json!({ "request_id": req_id }))
        .gas(Gas::from_tgas(150))
        .transact()
        .await?
        .into_result()?;
    println!("Proposal #14 executed via DAO! Tx: {}", confirm_res.outcome().transaction_hash);

    let current_owner: String = worker.view(&escrow_id, "get_owner").await?.json()?;
    println!("Verified Owner on Escrow: {}", current_owner);
    assert_eq!(current_owner, seller_id.to_string(), "Owner must now be temporary deployer");

    // 4. Seller executes Proposal #13 (WASM Upgrade) directly with full 300 Tgas!
    println!("\n[3/4] Executing Proposal #13 (WASM Upgrade) directly as owner with 300 Tgas...");
    let upgrade_res = seller_signer
        .call(&escrow_id, "execute_admin_action")
        .args_json(serde_json::json!({
            "proposal_id": PROP_13_UPGRADE,
            "code": wasm_bytes
        }))
        .gas(Gas::from_tgas(300))
        .transact()
        .await?
        .into_result()?;
    let upgrade_tx = upgrade_res.outcome().transaction_hash;
    println!("SUCCESS! Proposal #13 (WASM Upgrade) executed! Tx: {}", upgrade_tx);

    // 5. Seller immediately stages and executes TransferOwnership back to Multisig DAO
    println!("\n[4/4] Returning ownership to Multisig DAO...");
    let return_res = seller_signer
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
    let prop_back_id: u64 = return_res.json()?;
    println!("Staged Proposal #{} to return ownership to DAO.", prop_back_id);

    // Verify updated code hash on NEAR testnet RPC
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
    println!("\n============================================================");
    println!("NEW CONTRACT CODE HASH ON-CHAIN: {}", new_code_hash);
    println!("EXPECTED WASM BASE58 CODE HASH:  {}", bs58_hash);
    println!("UPGRADE TX HASH:                 {}", upgrade_tx);
    println!("============================================================");
    assert_eq!(new_code_hash, bs58_hash, "Code hash must match!");

    Ok(())
}
