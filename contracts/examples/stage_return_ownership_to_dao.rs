use conpi_escrow::types::AdminAction;
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
const DAO_ID: &str = "dev-20261103021740-59711933581376.testnet";

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    let seller_p1 = Path::new(".credentials/testnet_funder.json");
    let seller_p2 = Path::new("contracts/.credentials/testnet_funder.json");
    let seller_path = if seller_p1.exists() { seller_p1 } else { seller_p2 };
    let seller_key_file: KeyFile = serde_json::from_str(&fs::read_to_string(seller_path)?)?;
    let seller_id: near_sdk::AccountId = seller_key_file.account_id.parse()?;
    let seller_sk: SecretKey = seller_key_file.secret_key.parse()?;
    let escrow_id: near_sdk::AccountId = ESCROW_ID.parse()?;
    let dao_id: near_sdk::AccountId = DAO_ID.parse()?;

    let worker = near_workspaces::testnet().await?;
    let seller_signer = near_workspaces::Account::from_secret_key(seller_id.clone(), seller_sk, &worker);

    let action = AdminAction::TransferOwnership {
        new_owner: dao_id.clone(),
    };

    let propose_res = seller_signer
        .call(&escrow_id, "propose_admin_action")
        .args_json(serde_json::json!({ "action": action }))
        .gas(near_workspaces::types::Gas::from_tgas(50))
        .transact()
        .await?
        .into_result()?;

    let prop_id: u64 = propose_res.json()?;
    println!("SUCCESS: Staged TransferOwnership back to DAO (Proposal #{}). Tx: {}", prop_id, propose_res.outcome().transaction_hash);

    Ok(())
}
