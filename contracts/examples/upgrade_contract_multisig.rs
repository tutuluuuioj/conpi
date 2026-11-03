use conpi_escrow::types::AdminAction;
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

#[derive(serde::Serialize)]
struct ProposeArgs {
    action: AdminAction,
}

const ESCROW_ID: &str = "dev-20261103062448-30583839049419.testnet";

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    println!("============================================================");
    println!("  PROPOSE & EXECUTE TIMELOCKED WASM UPGRADE VIA MULTISIG   ");
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

    // Read WASM file
    let wasm_p1 = Path::new("contracts/res/conpi_escrow.wasm");
    let wasm_p2 = Path::new("res/conpi_escrow.wasm");
    let wasm_path = if wasm_p1.exists() { wasm_p1 } else { wasm_p2 };
    let wasm_bytes = fs::read(wasm_path)?;
    let mut hasher = Sha256::new();
    hasher.update(&wasm_bytes);
    let code_hash_bytes: [u8; 32] = hasher.finalize().into();
    let hex_hash = hex::encode(code_hash_bytes);
    let bs58_hash = near_sdk::bs58::encode(&code_hash_bytes).into_string();

    println!("WASM Path:      {:?} ({} bytes)", wasm_path, wasm_bytes.len());
    println!("WASM SHA256:    {}", hex_hash);
    println!("WASM Base58:    {}", bs58_hash);

    let member1_sk: SecretKey = keys_file.members[0].secret_key.parse()?;
    let member2_sk: SecretKey = keys_file.members[1].secret_key.parse()?;

    // 2. Connect to Testnet
    println!("\nConnecting to NEAR Testnet...");
    let worker = near_workspaces::testnet().await?;
    let member1_signer = near_workspaces::Account::from_secret_key(dao_id.clone(), member1_sk, &worker);
    let member2_signer = near_workspaces::Account::from_secret_key(dao_id.clone(), member2_sk, &worker);

    // 3. Prepare AdminAction::Upgrade
    let action = AdminAction::Upgrade {
        code_hash: code_hash_bytes,
    };
    let propose_call_args = serde_json::to_vec(&ProposeArgs { action })?;
    let propose_b64 = Base64VecU8::from(propose_call_args);

    println!("\n[1/4] Member 1 submitting add_request_and_confirm for Upgrade on Multisig DAO...");
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
    println!("Quorum (2/2) reached! Upgrade proposal staged on Escrow contract. Tx: {}", confirm1_tx);

    // Query staged proposals
    let staged_proposals: Vec<(u64, serde_json::Value)> = worker
        .view(&escrow_id, "list_staged_proposals")
        .args_json(serde_json::json!({}))
        .await?
        .json()?;

    println!("\nActive Staged Proposals on Escrow: {:?}", staged_proposals);
    if staged_proposals.is_empty() {
        panic!("No staged proposals found after confirmation!");
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

    // 5. Execute upgrade through multisig
    println!("\n[4/4] Executing Proposal #{} via Multisig DAO with new WASM code...", proposal_id);
    let exec_call_args = serde_json::to_vec(&serde_json::json!({
        "proposal_id": proposal_id,
        "code": wasm_bytes
    }))?;
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
                        "gas": "250000000000000" // 250 Tgas for deploy & migrate
                    }
                ]
            }
        }))
        .gas(near_workspaces::types::Gas::from_tgas(300))
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
        .gas(near_workspaces::types::Gas::from_tgas(300))
        .transact()
        .await?
        .into_result()?;
    let confirm_exec_tx = confirm_exec_res.outcome().transaction_hash;
    println!("Execution confirmed! Tx: {}", confirm_exec_tx);

    // 6. Verify New Code Hash on NEAR Testnet
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

    println!("SUCCESS! Contract successfully upgraded:");
    println!("  Escrow Contract:   {}", escrow_id);
    println!("  New Code Hash:     {}", updated_code_hash);
    println!("  Expected Bs58 Hash:{}", bs58_hash);
    println!("  WASM Size:         {} bytes", wasm_bytes.len());

    println!("\n============================================================");
    println!("  MULTISIG DAO TIMELOCKED CONTRACT UPGRADE COMPLETE!        ");
    println!("============================================================");
    println!("Upgrade Proposal Creation Tx:     {}", req1_tx);
    println!("Upgrade Proposal Confirmation Tx: {}", confirm1_tx);
    println!("Upgrade Execution Creation Tx:    {}", exec_req_tx);
    println!("Upgrade Execution Confirmation Tx:{}", confirm_exec_tx);
    println!("New Contract Code Hash:           {}", updated_code_hash);
    println!("============================================================");

    Ok(())
}
