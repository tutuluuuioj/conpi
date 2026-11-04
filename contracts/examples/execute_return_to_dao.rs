use near_sdk::AccountId;
use near_workspaces::types::{Gas, SecretKey};
use serde::Deserialize;
use std::fs;
use std::path::Path;

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
const PROP_15_RETURN_DAO: u64 = 15;
const PROP_15_READY_AT: u64 = 1793766539;

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    println!("============================================================");
    println!("  WAITING TO EXECUTE PROPOSAL #15 (RETURN OWNERSHIP TO DAO)");
    println!("============================================================");

    let seller_p1 = Path::new(".credentials/testnet_funder.json");
    let seller_p2 = Path::new("contracts/.credentials/testnet_funder.json");
    let seller_path = if seller_p1.exists() { seller_p1 } else { seller_p2 };
    let seller_key_file: KeyFile = serde_json::from_str(&fs::read_to_string(seller_path)?)?;
    let seller_id: AccountId = seller_key_file.account_id.parse()?;
    let seller_sk: SecretKey = seller_key_file.secret_key.parse()?;
    let escrow_id: AccountId = ESCROW_ID.parse()?;

    let worker = near_workspaces::testnet().await?;
    let seller_signer = near_workspaces::Account::from_secret_key(seller_id.clone(), seller_sk, &worker);

    loop {
        let now_secs = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)?
            .as_secs();
        if now_secs >= PROP_15_READY_AT {
            println!("Proposal #15 timelock matured! Executing execute_admin_action...");
            break;
        }
        let rem = PROP_15_READY_AT - now_secs;
        println!("Waiting for Proposal #15 maturity... {}s remaining", rem);
        tokio::time::sleep(std::time::Duration::from_secs(15)).await;
    }

    let exec_res = seller_signer
        .call(&escrow_id, "execute_admin_action")
        .args_json(serde_json::json!({
            "proposal_id": PROP_15_RETURN_DAO,
            "code": null
        }))
        .gas(Gas::from_tgas(50))
        .transact()
        .await?
        .into_result()?;

    println!("SUCCESS: Proposal #15 executed! Tx: {}", exec_res.outcome().transaction_hash);
    let owner: String = worker.view(&escrow_id, "get_owner").await?.json()?;
    println!("VERIFIED ON-CHAIN: Escrow Owner is now: {}", owner);

    Ok(())
}
