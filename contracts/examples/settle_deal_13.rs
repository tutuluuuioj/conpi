use conpi_escrow::types::{Deal, DefaultReason, PayloadKind, SignedPayload};
use near_sdk::json_types::U128;
use near_workspaces::types::SecretKey;
use serde::Deserialize;
use serde_json::Value;
use std::fs;
use std::path::Path;

const ESCROW_ID: &str = "dev-20261103062448-30583839049419.testnet";
const CVM_BASE_URL: &str = "https://b1b35377079ac7b7937afc607481587bc6d22665-3000.dstack-pha-prod9.phala.network";
const DEAL_ID: u64 = 13;

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
    } else if let Some(arr) = val["terms_hash"].as_array().or_else(|| val["termsHash"].as_array()) {
        let v: Vec<u8> = arr.iter().filter_map(|x| x.as_u64().map(|n| n as u8)).collect();
        v.try_into().map_err(|_| "terms_hash array not 32 bytes")?
    } else {
        return Err("missing terms hash".into());
    };

    let kind_num = val["kind"].as_u64().unwrap_or(4);
    let kind = match kind_num {
        0 => PayloadKind::Terms,
        1 => PayloadKind::Activate,
        2 => PayloadKind::Stage,
        3 => PayloadKind::Checkpoint,
        4 => PayloadKind::Default,
        _ => PayloadKind::Default,
    };

    let metered_value: u128 = if let Some(s) = val["meteredValueYocto"].as_str().or_else(|| val["metered_value"].as_str()) {
        s.parse().unwrap_or(0)
    } else if let Some(n) = val["meteredValueYocto"].as_u64().or_else(|| val["metered_value"].as_u64()) {
        n as u128
    } else {
        0
    };

    let reason = if val["reason"].is_null() {
        None
    } else if let Some(r) = val["reason"].as_u64() {
        match r {
            0 => Some(DefaultReason::InvalidKey),
            1 => Some(DefaultReason::InsufficientQuota),
            2 => Some(DefaultReason::KeyNotSubmitted),
            3 => Some(DefaultReason::ValidationFailed),
            4 => Some(DefaultReason::ProviderBan),
            5 => Some(DefaultReason::SellerSelfDrain),
            6 => Some(DefaultReason::BuyerBreach),
            _ => Some(DefaultReason::ProviderBan),
        }
    } else if let Some(s) = val["reason"].as_str() {
        match s {
            "InvalidKey" => Some(DefaultReason::InvalidKey),
            "InsufficientQuota" => Some(DefaultReason::InsufficientQuota),
            "KeyNotSubmitted" => Some(DefaultReason::KeyNotSubmitted),
            "ValidationFailed" => Some(DefaultReason::ValidationFailed),
            "ProviderBan" => Some(DefaultReason::ProviderBan),
            "SellerSelfDrain" => Some(DefaultReason::SellerSelfDrain),
            "BuyerBreach" => Some(DefaultReason::BuyerBreach),
            _ => Some(DefaultReason::ProviderBan),
        }
    } else {
        None
    };

    let nonce = if let Some(n) = val["nonce"].as_u64() {
        n
    } else if let Some(s) = val["nonce"].as_str() {
        s.parse().unwrap_or(0)
    } else {
        0
    };

    let issued_at = if let Some(n) = val["issuedAtNs"].as_u64().or_else(|| val["issued_at"].as_u64()) {
        n
    } else if let Some(s) = val["issuedAtNs"].as_str().or_else(|| val["issued_at"].as_str()) {
        s.parse().unwrap_or(0)
    } else {
        0
    };

    Ok(SignedPayload {
        domain: "conpi:v1".to_string(),
        contract_id: ESCROW_ID.parse()?,
        chain_id: "testnet".to_string(),
        deal_id: val["dealId"].as_u64().or_else(|| val["deal_id"].as_u64()).unwrap_or(DEAL_ID),
        terms_hash,
        kind,
        stage: val["stage"].as_u64().unwrap_or(0) as u8,
        metered_value: U128(metered_value),
        reason,
        foreign_tx_sighash: None,
        issued_at,
        nonce,
    })
}

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    println!("============================================================");
    println!("  SETTLING DEAL #13 ON-CHAIN VIA CVM SIGNED DEFAULT PROOF   ");
    println!("============================================================");

    let http_client = reqwest::Client::new();
    let worker = near_workspaces::testnet().await?;
    let escrow_id: near_sdk::AccountId = ESCROW_ID.parse()?;

    let buyer_p1 = Path::new(".credentials/buyer89a.json");
    let buyer_p2 = Path::new("contracts/.credentials/buyer89a.json");
    let buyer_path = if buyer_p1.exists() { buyer_p1 } else { buyer_p2 };
    let buyer_key: KeyFile = serde_json::from_str(&fs::read_to_string(buyer_path)?)?;
    let buyer_signer = near_workspaces::Account::from_secret_key(buyer_key.account_id.parse()?, buyer_key.secret_key.parse()?, &worker);

    // Get CVM default proof
    println!("Requesting default settlement payload from CVM for Deal #{}...", DEAL_ID);
    let default_url = format!("{}/v1/deals/{}/default", CVM_BASE_URL, DEAL_ID);
    let default_trigger_res = http_client
        .post(&default_url)
        .json(&serde_json::json!({ "reason": "ProviderBan" }))
        .send()
        .await?
        .json::<Value>()
        .await?;

    let default_payload_json = if default_trigger_res["defaultPayload"]["payload"].is_object() {
        &default_trigger_res["defaultPayload"]["payload"]
    } else {
        &default_trigger_res["defaultPayload"]
    };
    let default_sig_hex = default_trigger_res["defaultPayload"]["signatureHex"]
        .as_str()
        .or_else(|| default_trigger_res["defaultSignatureHex"].as_str())
        .expect("missing default signature");

    let default_payload = parse_signed_payload(default_payload_json)?;
    let default_sig = hex::decode(default_sig_hex)?;

    println!("CVM Signed DEFAULT payload: nonce={}, kind={:?}, reason={:?}, metered_value={}",
        default_payload.nonce, default_payload.kind, default_payload.reason, default_payload.metered_value.0);
    println!("Signature: {}...", &default_sig_hex[..20]);

    println!("\nSubmitting settle_default on-chain...");
    let default_res = buyer_signer
        .call(&escrow_id, "settle_default")
        .args_json(serde_json::json!({
            "deal_id": DEAL_ID,
            "payload": default_payload,
            "sig": default_sig
        }))
        .gas(near_workspaces::types::Gas::from_tgas(100))
        .transact()
        .await?
        .into_result()?;

    let tx_settle = default_res.outcome().transaction_hash;
    println!("SUCCESS! Deal #{} defaulted and settled on-chain. Tx: {}", DEAL_ID, tx_settle);

    let final_deal: Deal = worker
        .view(&escrow_id, "get_deal")
        .args_json(serde_json::json!({ "deal_id": DEAL_ID }))
        .await?
        .json()?;

    println!("Final Deal Status:   {:?}", final_deal.status);
    println!("Released to Seller:  {} yoctoNEAR", final_deal.released_to_seller);

    Ok(())
}
