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
struct ExecuteArgs {
    proposal_id: u64,
    code: Option<Vec<u8>>,
}

const ESCROW_ID: &str = "dev-20261103062448-30583839049419.testnet";
const PROPOSAL_ID: u64 = 31;

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    println!("============================================================");
    println!("  DIRECT ZERO-WASM-OVERHEAD EXECUTION FOR PROPOSAL #{}     ", PROPOSAL_ID);
    println!("============================================================");

    // 1. Load keys
    let creds_p1 = Path::new(".credentials/dao_member_keys.json");
    let creds_p2 = Path::new("contracts/.credentials/dao_member_keys.json");
    let credentials_path = if creds_p1.exists() { creds_p1 } else { creds_p2 };

    let keys_content = fs::read_to_string(credentials_path)?;
    let keys_file: DaoKeysFile = serde_json::from_str(&keys_content)?;
    let dao_id: near_sdk::AccountId = keys_file.dao_account_id.parse()?;
    let escrow_id: near_sdk::AccountId = ESCROW_ID.parse()?;

    let funder_p1 = Path::new(".credentials/testnet_funder.json");
    let funder_p2 = Path::new("contracts/.credentials/testnet_funder.json");
    let funder_path = if funder_p1.exists() { funder_p1 } else { funder_p2 };
    let funder_file: KeyFile = serde_json::from_str(&fs::read_to_string(funder_path)?)?;
    let deployer_id: near_sdk::AccountId = funder_file.account_id.parse()?;
    let deployer_sk: SecretKey = funder_file.secret_key.parse()?;

    // Read WASM file
    let wasm_p1 = Path::new("contracts/res/conpi_escrow.wasm");
    let wasm_p2 = Path::new("res/conpi_escrow.wasm");
    let wasm_path = if wasm_p1.exists() { wasm_p1 } else { wasm_p2 };
    let wasm_bytes = fs::read(wasm_path)?;
    let mut hasher = Sha256::new();
    hasher.update(&wasm_bytes);
    let code_hash_bytes: [u8; 32] = hasher.finalize().into();
    let bs58_hash = near_sdk::bs58::encode(&code_hash_bytes).into_string();

    println!("WASM Path:      {:?} ({} bytes)", wasm_path, wasm_bytes.len());
    println!("WASM Base58:    {}", bs58_hash);

    let member1_sk: SecretKey = keys_file.members[0].secret_key.parse()?;
    let member2_sk: SecretKey = keys_file.members[1].secret_key.parse()?;

    // 2. Connect to Testnet
    println!("\nConnecting to NEAR Testnet...");
    let worker = near_workspaces::testnet().await?;
    let deployer_signer = near_workspaces::Account::from_secret_key(deployer_id.clone(), deployer_sk, &worker);
    let member1_signer = near_workspaces::Account::from_secret_key(dao_id.clone(), member1_sk, &worker);
    let member2_signer = near_workspaces::Account::from_secret_key(dao_id.clone(), member2_sk, &worker);

    // 3. Stage Bytecode directly via stage_upgrade_code
    println!("\n[1/3] Staging WASM bytecode directly on Escrow via stage_upgrade_code...");
    let stage_res = deployer_signer
        .call(&escrow_id, "stage_upgrade_code")
        .args_json(serde_json::json!({ "code": wasm_bytes }))
        .gas(Gas::from_tgas(300))
        .transact()
        .await?
        .into_result()?;
    println!("WASM bytecode staged! Tx: {}", stage_res.outcome().transaction_hash);

    let has_staged: bool = worker.view(&escrow_id, "has_staged_upgrade_code").await?.json()?;
    println!("Verified has_staged_upgrade_code on Escrow: {}", has_staged);
    assert!(has_staged, "Bytecode must be staged!");

    // 4. Submit execute_admin_action with code: None (ZERO WASM BYTES through multisig!)
    println!("\n[2/3] Multisig DAO executing Upgrade with code: None and 250 Tgas...");
    let exec_args = serde_json::to_vec(&ExecuteArgs {
        proposal_id: PROPOSAL_ID,
        code: None,
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
        .gas(Gas::from_tgas(300))
        .transact()
        .await?
        .into_result()?;
    let exec_req_id: u32 = add_exec_res.json()?;
    println!("Multisig Request #{} created. Tx: {}", exec_req_id, add_exec_res.outcome().transaction_hash);

    println!("\n[3/3] Member 2 confirming execution (reaching 2-of-3 quorum)...");
    let confirm_exec_res = member2_signer
        .call(&dao_id, "confirm")
        .args_json(serde_json::json!({ "request_id": exec_req_id }))
        .gas(Gas::from_tgas(300))
        .transact()
        .await?
        .into_result()?;
    let confirm_exec_tx = confirm_exec_res.outcome().transaction_hash;
    println!("Execution confirmed! Tx: {}", confirm_exec_tx);

    // 5. Verify New Code Hash on NEAR Testnet RPC
    println!("\nQuerying updated account code hash from NEAR Testnet RPC...");
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

    let updated_code_hash = rpc_res["result"]["code_hash"]
        .as_str()
        .unwrap_or("unknown");
    println!("SUCCESS! Verified on-chain code hash: {}", updated_code_hash);
    assert_eq!(updated_code_hash, bs58_hash, "Code hash must match compiled WASM!");

    println!("\n============================================================");
    println!("  UPGRADE SUCCESSFULLY DEPLOYED TO LIVE TESTNET!            ");
    println!("============================================================");

    Ok(())
}
