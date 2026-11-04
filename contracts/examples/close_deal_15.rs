use near_sdk::AccountId;
use near_workspaces::types::Gas;
use serde::Deserialize;
use std::fs;
use std::path::Path;

const ESCROW_ID: &str = "dev-20261103062448-30583839049419.testnet";

#[derive(Deserialize)]
struct KeyFile {
    #[serde(alias = "account_id")]
    #[serde(rename = "accountId")]
    account_id: String,
    #[serde(alias = "secret_key")]
    #[serde(rename = "privateKey")]
    secret_key: String,
}

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    println!("============================================================");
    println!("      CLOSING DEAL #15 ON TESTNET VIA TIMEOUT_REFUND        ");
    println!("============================================================");

    let worker = near_workspaces::testnet().await?;
    let escrow_id: AccountId = ESCROW_ID.parse()?;

    let buyer_p1 = Path::new(".credentials/buyer89a.json");
    let buyer_p2 = Path::new("contracts/.credentials/buyer89a.json");
    let buyer_path = if buyer_p1.exists() { buyer_p1 } else { buyer_p2 };
    let buyer_key: KeyFile = serde_json::from_str(&fs::read_to_string(buyer_path)?)?;
    let buyer_signer = near_workspaces::Account::from_secret_key(
        buyer_key.account_id.parse()?,
        buyer_key.secret_key.parse()?,
        &worker,
    );

    println!("Caller Account (Buyer): {}", buyer_signer.id());

    let res = buyer_signer
        .call(&escrow_id, "timeout_refund")
        .args_json(serde_json::json!({ "deal_id": 15u64 }))
        .gas(Gas::from_tgas(100))
        .transact()
        .await?
        .into_result()?;

    let tx_hash = res.outcome().transaction_hash;
    println!("SUCCESS: Deal #15 closed via timeout_refund! Tx Hash: {}", tx_hash);

    let deal: serde_json::Value = worker
        .view(&escrow_id, "get_deal")
        .args_json(serde_json::json!({ "deal_id": 15u64 }))
        .await?
        .json()?;

    println!("\n============================================================");
    println!("Deal #15 Status: {}", deal["status"]);
    println!("Stage Reached:   {}%", deal["stage_reached"]);
    println!("Released to Seller: {} yoctoNEAR", deal["released_to_seller"]);
    println!("Full Deal:\n{}", serde_json::to_string_pretty(&deal)?);
    println!("============================================================");

    Ok(())
}
