use near_sdk::json_types::Base64VecU8;
use near_workspaces::types::{Gas, SecretKey};
use serde::Deserialize;
use std::fs;
use std::path::Path;
use std::time::{Duration, Instant};

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
const PROPOSAL_ID: u64 = 35;

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    println!("============================================================");
    println!("  WAIT FOR TIMELOCK & EXECUTE PROPOSAL #{}                  ", PROPOSAL_ID);
    println!("============================================================");

    let credentials_path = if Path::new("contracts/.credentials/dao_member_keys.json").exists() {
        Path::new("contracts/.credentials/dao_member_keys.json")
    } else {
        Path::new(".credentials/dao_member_keys.json")
    };
    let keys_content = fs::read_to_string(credentials_path)?;
    let keys_file: DaoKeysFile = serde_json::from_str(&keys_content)?;
    let dao_id: near_sdk::AccountId = keys_file.dao_account_id.parse()?;
    let escrow_id: near_sdk::AccountId = ESCROW_ID.parse()?;

    let funder_path = if Path::new("contracts/.credentials/testnet_funder.json").exists() {
        Path::new("contracts/.credentials/testnet_funder.json")
    } else {
        Path::new(".credentials/testnet_funder.json")
    };
    let funder_file: KeyFile = serde_json::from_str(&fs::read_to_string(funder_path)?)?;
    let deployer_id: near_sdk::AccountId = funder_file.account_id.parse()?;
    let deployer_sk: SecretKey = funder_file.secret_key.parse()?;

    let member1_sk: SecretKey = keys_file.members[0].secret_key.parse()?;
    let member2_sk: SecretKey = keys_file.members[1].secret_key.parse()?;

    let worker = near_workspaces::testnet().await?;
    let deployer_signer = near_workspaces::Account::from_secret_key(deployer_id.clone(), deployer_sk, &worker);
    let member1_signer = near_workspaces::Account::from_secret_key(dao_id.clone(), member1_sk, &worker);
    let member2_signer = near_workspaces::Account::from_secret_key(dao_id.clone(), member2_sk, &worker);

    // Check proposal details
    let prop: serde_json::Value = worker.view(&escrow_id, "get_staged_proposal")
        .args_json(serde_json::json!({ "proposal_id": PROPOSAL_ID }))
        .await?
        .json()?;
    let eta_ns: u64 = prop["ready_at"].as_u64().unwrap_or(0);
    println!("Proposal #{} ready_at (ns): {}", PROPOSAL_ID, eta_ns);

    loop {
        let block = worker.view_block().await?;
        let now_ns = block.timestamp();
        if now_ns > eta_ns {
            println!("Timelock elapsed! (block timestamp > eta)");
            break;
        }
        let diff_sec = (eta_ns.saturating_sub(now_ns)) / 1_000_000_000;
        println!("Waiting for timelock... {} seconds remaining", diff_sec);
        tokio::time::sleep(Duration::from_secs(15)).await;
    }

    // Execute upgrade via DAO
    println!("\nExecuting Proposal #{} via Multisig DAO...", PROPOSAL_ID);
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
    println!("Multisig Request #{} created.", exec_req_id);

    let conf_exec_res = member2_signer
        .call(&dao_id, "confirm")
        .args_json(serde_json::json!({ "request_id": exec_req_id }))
        .gas(Gas::from_tgas(300))
        .transact()
        .await?
        .into_result()?;
    println!("SUCCESS! Upgrade Proposal #{} Executed! Tx: {}", PROPOSAL_ID, conf_exec_res.outcome().transaction_hash);

    // Finalize Deal #32
    println!("\nCalling finalize_exhausted_deal(32)...");
    let fin_res = deployer_signer
        .call(&escrow_id, "finalize_exhausted_deal")
        .args_json(serde_json::json!({ "deal_id": 32 }))
        .gas(Gas::from_tgas(100))
        .transact()
        .await?
        .into_result()?;
    println!("SUCCESS! Deal #32 100% Finalized on NEAR! Tx: {}", fin_res.outcome().transaction_hash);

    let deal: serde_json::Value = worker.view(&escrow_id, "get_deal")
        .args_json(serde_json::json!({ "deal_id": 32 }))
        .await?
        .json()?;
    println!("\n============================================================");
    println!("Deal #32 On-Chain Status:    {}", deal["status"]);
    println!("Deal #32 Stage Reached:       {}", deal["stage_reached"]);
    println!("Deal #32 Released to Seller:  {} yoctoNEAR", deal["released_to_seller"]);
    println!("============================================================");

    Ok(())
}
