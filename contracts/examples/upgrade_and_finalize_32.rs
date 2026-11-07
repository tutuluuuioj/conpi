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
    println!("  UPGRADE CONTRACT AND FINALIZE DEAL #32 AS 100% EXHAUSTED  ");
    println!("============================================================");

    // 1. Load keys
    let credentials_path = if Path::new("contracts/.credentials/dao_member_keys.json").exists() {
        Path::new("contracts/.credentials/dao_member_keys.json")
    } else if Path::new(".credentials/dao_member_keys.json").exists() {
        Path::new(".credentials/dao_member_keys.json")
    } else {
        Path::new("../contracts/.credentials/dao_member_keys.json")
    };
    let keys_content = fs::read_to_string(credentials_path)?;
    let keys_file: DaoKeysFile = serde_json::from_str(&keys_content)?;
    let dao_id: near_sdk::AccountId = keys_file.dao_account_id.parse()?;
    let escrow_id: near_sdk::AccountId = ESCROW_ID.parse()?;

    let funder_path = if Path::new("contracts/.credentials/testnet_funder.json").exists() {
        Path::new("contracts/.credentials/testnet_funder.json")
    } else if Path::new(".credentials/testnet_funder.json").exists() {
        Path::new(".credentials/testnet_funder.json")
    } else {
        Path::new("../contracts/.credentials/testnet_funder.json")
    };
    let funder_file: KeyFile = serde_json::from_str(&fs::read_to_string(funder_path)?)?;
    let deployer_id: near_sdk::AccountId = funder_file.account_id.parse()?;
    let deployer_sk: SecretKey = funder_file.secret_key.parse()?;

    let member1_sk: SecretKey = keys_file.members[0].secret_key.parse()?;
    let member2_sk: SecretKey = keys_file.members[1].secret_key.parse()?;

    // Read WASM file
    let wasm_path = if Path::new("contracts/target/near/conpi_escrow.wasm").exists() {
        Path::new("contracts/target/near/conpi_escrow.wasm")
    } else if Path::new("target/near/conpi_escrow.wasm").exists() {
        Path::new("target/near/conpi_escrow.wasm")
    } else {
        Path::new("../contracts/target/near/conpi_escrow.wasm")
    };
    let wasm_bytes = fs::read(wasm_path)?;
    let mut hasher = Sha256::new();
    hasher.update(&wasm_bytes);
    let code_hash_bytes: [u8; 32] = hasher.finalize().into();
    let bs58_hash = near_sdk::bs58::encode(&code_hash_bytes).into_string();

    println!("WASM Path:      {:?} ({} bytes)", wasm_path, wasm_bytes.len());
    println!("WASM Base58:    {}", bs58_hash);

    println!("\nConnecting to NEAR Testnet...");
    let worker = near_workspaces::testnet().await?;
    let deployer_signer = near_workspaces::Account::from_secret_key(deployer_id.clone(), deployer_sk, &worker);
    let member1_signer = near_workspaces::Account::from_secret_key(dao_id.clone(), member1_sk, &worker);
    let member2_signer = near_workspaces::Account::from_secret_key(dao_id.clone(), member2_sk, &worker);

    // 2. Propose upgrade via DAO FIRST so the code_hash is registered
    println!("\n[1/4] Proposing AdminAction::Upgrade via DAO...");
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
    println!("Multisig Request #{} created. Tx: {}", upg_req_id, add_upg_res.outcome().transaction_hash);

    let conf_upg_res = member2_signer
        .call(&dao_id, "confirm")
        .args_json(serde_json::json!({ "request_id": upg_req_id }))
        .gas(Gas::from_tgas(150))
        .transact()
        .await?
        .into_result()?;
    println!("Upgrade proposal confirmed by Member 2. Tx: {}", conf_upg_res.outcome().transaction_hash);

    // Check list of staged proposals
    let proposals: Vec<(u64, serde_json::Value)> = worker.view(&escrow_id, "list_staged_proposals").await?.json()?;
    let proposal_id = proposals.last().map(|(id, _)| *id).expect("No staged proposal found!");
    println!("Staged Escrow Proposal ID: {}", proposal_id);

    // 3. Stage WASM bytecode directly via stage_upgrade_code
    println!("\n[2/4] Staging WASM bytecode directly on Escrow via stage_upgrade_code...");
    let stage_res = deployer_signer
        .call(&escrow_id, "stage_upgrade_code")
        .args_json(serde_json::json!({ "code": wasm_bytes }))
        .gas(Gas::from_tgas(300))
        .transact()
        .await?
        .into_result()?;
    println!("WASM bytecode staged! Tx: {}", stage_res.outcome().transaction_hash);

    // 4. Execute upgrade
    println!("\n[3/4] Multisig executing Upgrade with code: None...");
    let exec_args = serde_json::to_vec(&ExecuteArgs {
        proposal_id,
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

    let conf_exec_res = member2_signer
        .call(&dao_id, "confirm")
        .args_json(serde_json::json!({ "request_id": exec_req_id }))
        .gas(Gas::from_tgas(300))
        .transact()
        .await?
        .into_result()?;
    println!("Upgrade executed! Tx: {}", conf_exec_res.outcome().transaction_hash);

    // 5. Finalize Deal #32
    println!("\n[4/4] Calling finalize_exhausted_deal(32)...");
    let fin_res = deployer_signer
        .call(&escrow_id, "finalize_exhausted_deal")
        .args_json(serde_json::json!({ "deal_id": 32 }))
        .gas(Gas::from_tgas(100))
        .transact()
        .await?
        .into_result()?;
    println!("SUCCESS! Deal #32 Finalized! Tx: {}", fin_res.outcome().transaction_hash);

    // 6. Verify Deal #32 state
    let deal: serde_json::Value = worker.view(&escrow_id, "get_deal").args_json(serde_json::json!({ "deal_id": 32 })).await?.json()?;
    println!("\nDeal #32 On-Chain Status: {}", deal["status"]);
    println!("Deal #32 Stage Reached:    {}", deal["stage_reached"]);
    println!("Deal #32 Released:         {}", deal["released_to_seller"]);

    Ok(())
}
