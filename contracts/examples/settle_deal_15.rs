use conpi_escrow::types::{Deal, DealStatus, PayloadKind, SignedPayload};
use near_sdk::json_types::U128;
use serde::Deserialize;
use serde_json::Value;
use std::fs;
use std::path::Path;

const ESCROW_ID: &str = "dev-20261103062448-30583839049419.testnet";
const CVM_BASE_URL: &str = "https://b1b35377079ac7b7937afc607481587bc6d22665-3000.dstack-pha-prod9.phala.network";
const DEAL_ID: u64 = 15;

#[derive(Deserialize)]
struct KeyFile {
    #[serde(alias = "account_id")]
    #[serde(rename = "accountId")]
    account_id: String,
    #[serde(alias = "secret_key")]
    #[serde(rename = "privateKey")]
    secret_key: String,
}

fn parse_signed_payload(val: &Value) -> Result<SignedPayload, Box<dyn std::error::Error>> {
    let terms_hash: [u8; 32] = if let Some(s) = val["termsHashHex"].as_str().or_else(|| val["terms_hash"].as_str()) {
        let clean = s.trim_start_matches("0x");
        let v = hex::decode(clean)?;
        v.try_into().map_err(|_| "terms_hash not 32 bytes")?
    } else {
        return Err("missing terms hash".into());
    };

    let metered_value: u128 = if let Some(s) = val["meteredValueYocto"].as_str().or_else(|| val["metered_value"].as_str()) {
        s.parse().unwrap_or(0)
    } else {
        0
    };

    let nonce = val["nonce"].as_u64().unwrap_or_else(|| val["nonce"].as_str().and_then(|s| s.parse().ok()).unwrap_or(0));
    let issued_at = val["issuedAtNs"].as_u64().unwrap_or_else(|| val["issuedAtNs"].as_str().and_then(|s| s.parse().ok()).unwrap_or(0));

    Ok(SignedPayload {
        domain: "conpi:v1".to_string(),
        contract_id: ESCROW_ID.parse()?,
        chain_id: "testnet".to_string(),
        deal_id: DEAL_ID,
        terms_hash,
        kind: PayloadKind::Stage,
        stage: val["stage"].as_u64().unwrap_or(0) as u8,
        metered_value: U128(metered_value),
        reason: None,
        issued_at,
        nonce,
    })
}

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    println!("============================================================");
    println!("  RELEASING STAGES 50% & 75% FOR DEAL #15 ON TESTNET       ");
    println!("============================================================");

    let http_client = reqwest::Client::new();
    let worker = near_workspaces::testnet().await?;
    let escrow_id: near_sdk::AccountId = ESCROW_ID.parse()?;

    let seller_p1 = Path::new(".credentials/testnet_funder.json");
    let seller_p2 = Path::new("contracts/.credentials/testnet_funder.json");
    let seller_path = if seller_p1.exists() { seller_p1 } else { seller_p2 };
    let seller_key: KeyFile = serde_json::from_str(&fs::read_to_string(seller_path)?)?;
    let seller_signer = near_workspaces::Account::from_secret_key(
        seller_key.account_id.parse()?,
        seller_key.secret_key.parse()?,
        &worker,
    );

    let payloads_url = format!("{}/v1/deals/{}/payloads", CVM_BASE_URL, DEAL_ID);
    let payloads_res = http_client.get(&payloads_url).send().await?.json::<Value>().await?;
    let signed_payloads = payloads_res["signedPayloads"].as_array().expect("signedPayloads array");

    for target_stage in [50u8, 75u8] {
        let stage_item = signed_payloads
            .iter()
            .find(|item| item["payload"]["kind"].as_u64() == Some(2) && item["payload"]["stage"].as_u64() == Some(target_stage as u64));

        if let Some(item) = stage_item {
            let stage_payload = parse_signed_payload(&item["payload"])?;
            let stage_sig = hex::decode(item["signatureHex"].as_str().unwrap())?;

            println!("\nSubmitting release_stage({}) on Escrow contract (metered: {} yoctoNEAR)...",
                target_stage, stage_payload.metered_value.0);

            let res = seller_signer
                .call(&escrow_id, "release_stage")
                .args_json(serde_json::json!({
                    "deal_id": DEAL_ID,
                    "stage": target_stage,
                    "payload": stage_payload,
                    "sig": stage_sig
                }))
                .gas(near_workspaces::types::Gas::from_tgas(80))
                .transact()
                .await?
                .into_result()?;

            let tx_hash = res.outcome().transaction_hash;
            println!("SUCCESS! Stage {}% released on-chain. Tx: {}", target_stage, tx_hash);
        }
    }

    let final_deal: Deal = worker
        .view(&escrow_id, "get_deal")
        .args_json(serde_json::json!({ "deal_id": DEAL_ID }))
        .await?
        .json()?;

    println!("\n============================================================");
    println!("Deal #15 Status:       {:?}", final_deal.status);
    println!("Stage Reached:         {}%", final_deal.stage_reached);
    println!("Released to Seller:    {} yoctoNEAR", final_deal.released_to_seller);
    println!("============================================================");

    Ok(())
}
