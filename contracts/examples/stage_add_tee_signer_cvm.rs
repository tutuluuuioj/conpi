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
const DSTACK_HARDWARE_SIGNER: &str = "ed25519:CLHhDLsLCCqFeTjz7g31NkfbtN1UqT2mJRmRZgcRPTj3";
const NEW_MEASUREMENT: &str = "mrtd:7fe60787222bd394cb516abca2435f22f035ab2cc9c0a4b4b3b148e46297f3d931a237b72f359052c6e657d8c1409173|compose:a1f7be33786348bc8345d889ebf74f08e026a450552a6d64bcea0595b0ef4a97";

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    println!("============================================================");
    println!("  STAGE ADD TEE SIGNER WITH NEW CVM COMPOSE HASH");
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

    let action = AdminAction::AddTeeSigner {
        public_key: DSTACK_HARDWARE_SIGNER.parse()?,
        measurement: NEW_MEASUREMENT.to_string(),
    };

    let propose_res = seller_signer
        .call(&escrow_id, "propose_admin_action")
        .args_json(serde_json::json!({ "action": action }))
        .gas(near_workspaces::types::Gas::from_tgas(50))
        .transact()
        .await?
        .into_result()?;

    let prop_id: u64 = propose_res.json()?;
    println!("SUCCESS: Staged AddTeeSigner (Proposal #{}). Tx: {}", prop_id, propose_res.outcome().transaction_hash);

    Ok(())
}
