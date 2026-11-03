use near_workspaces::types::SecretKey;
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

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    println!("============================================================");
    println!("  EXECUTE PROPOSAL #11 (UPDATE TEE SIGNER MEASUREMENT)");
    println!("  EXECUTE PROPOSAL #10 (RETURN OWNERSHIP TO MULTISIG DAO)");
    println!("============================================================");

    let seller_p1 = Path::new(".credentials/testnet_funder.json");
    let seller_p2 = Path::new("contracts/.credentials/testnet_funder.json");
    let seller_path = if seller_p1.exists() { seller_p1 } else { seller_p2 };
    let seller_key_file: KeyFile = serde_json::from_str(&fs::read_to_string(seller_path)?)?;
    let seller_id: near_sdk::AccountId = seller_key_file.account_id.parse()?;
    let seller_sk: SecretKey = seller_key_file.secret_key.parse()?;
    let escrow_id: near_sdk::AccountId = ESCROW_ID.parse()?;

    let worker = near_workspaces::testnet().await?;
    let seller_signer = near_workspaces::Account::from_secret_key(seller_id.clone(), seller_sk, &worker);

    println!("\n[1/2] Executing Proposal #11 (AddTeeSigner with new compose hash)...");
    let exec11_res = seller_signer
        .call(&escrow_id, "execute_admin_action")
        .args_json(serde_json::json!({
            "proposal_id": 11,
            "code": null
        }))
        .gas(near_workspaces::types::Gas::from_tgas(80))
        .transact()
        .await?
        .into_result()?;
    println!("SUCCESS! Proposal #11 executed. Tx: {}", exec11_res.outcome().transaction_hash);

    println!("\n[2/2] Executing Proposal #10 (TransferOwnership back to DAO)...");
    let exec10_res = seller_signer
        .call(&escrow_id, "execute_admin_action")
        .args_json(serde_json::json!({
            "proposal_id": 10,
            "code": null
        }))
        .gas(near_workspaces::types::Gas::from_tgas(80))
        .transact()
        .await?
        .into_result()?;
    println!("SUCCESS! Proposal #10 executed. Tx: {}", exec10_res.outcome().transaction_hash);

    // Verify on-chain state
    let owner: String = worker.view(&escrow_id, "get_owner").await?.json()?;
    println!("\nVerified Escrow Owner is now: {}", owner);

    Ok(())
}
