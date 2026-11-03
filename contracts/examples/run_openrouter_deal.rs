use conpi_escrow::types::{
    CreateDealParams, Deal, DealStatus, DefaultReason, PayloadKind, SignedPayload, TeeSigner,
};
use near_sdk::json_types::U128;
use near_sdk::PublicKey;
use near_workspaces::types::{NearToken, SecretKey};
use serde::Deserialize;
use serde_json::Value;
use std::fs;
use std::path::Path;

const ESCROW_ID: &str = "dev-20261103062448-30583839049419.testnet";
const CVM_BASE_URL: &str = "https://b1b35377079ac7b7937afc607481587bc6d22665-3000.dstack-pha-prod9.phala.network";

#[derive(Deserialize)]
struct KeyFile {
    #[serde(alias = "account_id")]
    #[serde(rename = "accountId")]
    account_id: String,
    #[serde(alias = "secret_key")]
    #[serde(rename = "privateKey")]
    secret_key: String,
}

fn get_openrouter_api_key() -> String {
    let paths = [
        ".credentials/openrouter_key.txt",
        "contracts/.credentials/openrouter_key.txt",
    ];
    for p in paths {
        if let Ok(c) = fs::read_to_string(p) {
            let trimmed = c.trim();
            if !trimmed.is_empty() {
                return trimmed.to_string();
            }
        }
    }
    panic!("OpenRouter key file not found");
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

    let kind_num = val["kind"].as_u64().unwrap_or(1);
    let kind = match kind_num {
        0 => PayloadKind::Terms,
        1 => PayloadKind::Activate,
        2 => PayloadKind::Stage,
        3 => PayloadKind::Checkpoint,
        4 => PayloadKind::Default,
        _ => PayloadKind::Activate,
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
        deal_id: val["dealId"].as_u64().or_else(|| val["deal_id"].as_u64()).unwrap_or(0),
        terms_hash,
        kind,
        stage: val["stage"].as_u64().unwrap_or(0) as u8,
        metered_value: U128(metered_value),
        reason,
        issued_at,
        nonce,
    })
}

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    println!("============================================================");
    println!("   RUN LIVE ON-CHAIN TESTNET DEAL (OPENROUTER IN INTEL TDX)  ");
    println!("   NEW CONTRACT 3Ks71Tby... & NEW CVM COMPOSE 3b2df174...    ");
    println!("============================================================");

    let http_client = reqwest::Client::new();

    // 1. Fetch live CVM attestation
    println!("Fetching live attestation from Phala CVM ({}/v1/attestation)...", CVM_BASE_URL);
    let att_resp = http_client.get(&format!("{}/v1/attestation", CVM_BASE_URL)).send().await?.json::<Value>().await?;

    let in_enclave = att_resp["inEnclave"].as_bool().unwrap_or(false);
    let tee_signer_near = att_resp["signerPublicKeyNear"].as_str().unwrap_or_default();
    let compose_hash = att_resp["composeHash"].as_str().unwrap_or_default();
    let mrtd = att_resp["mrtd"].as_str().unwrap_or_default();

    println!("CVM inEnclave:       {}", in_enclave);
    println!("CVM Hardware Signer: {}", tee_signer_near);
    println!("CVM Compose Hash:    {}", compose_hash);
    println!("CVM Measured MRTD:   {}", mrtd);
    assert!(in_enclave, "CVM must be running in hardware enclave");

    // 2. Connect to Testnet & Verify Signer on Escrow Contract
    println!("\nConnecting to NEAR Testnet...");
    let worker = near_workspaces::testnet().await?;
    let escrow_id: near_sdk::AccountId = ESCROW_ID.parse()?;
    let tee_pubkey: PublicKey = tee_signer_near.parse()?;

    println!("Verifying on-chain state of TEE signer on {}...", escrow_id);
    let signer_info: Option<TeeSigner> = worker
        .view(&escrow_id, "get_tee_signer")
        .args_json(serde_json::json!({ "public_key": tee_signer_near }))
        .await?
        .json()?;

    if let Some(s) = signer_info {
        println!("Verified on-chain TEE Signer (active: {}, measurement: {})", s.active, s.measurement);
        assert!(s.active, "Signer must be active on-chain");
    } else {
        panic!("TEE Signer {} not registered on escrow contract!", tee_signer_near);
    }

    // Load Seller & Buyer accounts
    let seller_p1 = Path::new(".credentials/testnet_funder.json");
    let seller_p2 = Path::new("contracts/.credentials/testnet_funder.json");
    let seller_path = if seller_p1.exists() { seller_p1 } else { seller_p2 };
    let seller_key: KeyFile = serde_json::from_str(&fs::read_to_string(seller_path)?)?;

    let buyer_p1 = Path::new(".credentials/buyer89a.json");
    let buyer_p2 = Path::new("contracts/.credentials/buyer89a.json");
    let buyer_path = if buyer_p1.exists() { buyer_p1 } else { buyer_p2 };
    let buyer_key: KeyFile = serde_json::from_str(&fs::read_to_string(buyer_path)?)?;

    let seller_signer = near_workspaces::Account::from_secret_key(seller_key.account_id.parse()?, seller_key.secret_key.parse()?, &worker);
    let buyer_signer = near_workspaces::Account::from_secret_key(buyer_key.account_id.parse()?, buyer_key.secret_key.parse()?, &worker);

    println!("Buyer Account:  {}", buyer_signer.id());
    println!("Seller Account: {}", seller_signer.id());

    // Deal Economics (yoctoNEAR)
    let price_yocto: u128 = 50_000_000_000_000_000_000_000;         // 0.05 NEAR
    let credit_amount_yocto: u128 = 50_000_000_000_000_000_000_000; // 0.05 NEAR (> 0!)
    let buyer_collateral_yocto: u128 = 20_000_000_000_000_000_000_000; // 0.02 NEAR
    let seller_collateral_yocto: u128 = 40_000_000_000_000_000_000_000;// 0.04 NEAR
    let buyer_total_deposit = price_yocto + buyer_collateral_yocto;     // 0.07 NEAR
    let storage_deposit_fee: u128 = 50_000_000_000_000_000_000_000;    // 0.05 NEAR

    // Step 1: Buyer creates deal on-chain
    println!("\n[1/7] Buyer calling create_deal on Escrow contract...");
    let create_params = CreateDealParams {
        buyer: buyer_signer.id().clone(),
        seller: seller_signer.id().clone(),
        token: None,
        price: U128(price_yocto),
        credit_amount: U128(credit_amount_yocto),
        buyer_collateral: U128(buyer_collateral_yocto),
        seller_collateral: U128(seller_collateral_yocto),
        tee_pubkey: tee_pubkey.clone(),
        deposit_duration_sec: 600,
        key_duration_sec: 600,
        tee_liveness_timeout_sec: 3600,
        slash_bps_provider_ban: 5000,
        slash_bps_revoke: 8000,
        slash_bps_buyer_breach: 5000,
    };

    let create_res = buyer_signer
        .call(&escrow_id, "create_deal")
        .args_json(serde_json::json!({ "params": create_params }))
        .deposit(NearToken::from_yoctonear(storage_deposit_fee))
        .gas(near_workspaces::types::Gas::from_tgas(50))
        .transact()
        .await?
        .into_result()?;
    let tx_create_deal = create_res.outcome().transaction_hash;
    let deal_id: u64 = create_res.json()?;
    println!("Deal #{} created successfully. Tx: {}", deal_id, tx_create_deal);

    // Fetch canonical terms hash
    let deal_created: Deal = worker
        .view(&escrow_id, "get_deal")
        .args_json(serde_json::json!({ "deal_id": deal_id }))
        .await?
        .json()?;
    let terms_hash = deal_created.terms_hash.expect("on-chain terms hash");
    let terms_hash_hex = hex::encode(terms_hash);
    println!("Canonical Terms Hash: {}", terms_hash_hex);

    // Step 2: Seller accepts deal
    println!("\n[2/7] Seller calling accept_deal with terms hash...");
    let accept_res = seller_signer
        .call(&escrow_id, "accept_deal")
        .args_json(serde_json::json!({
            "deal_id": deal_id,
            "expected_hash": terms_hash.to_vec(),
        }))
        .gas(near_workspaces::types::Gas::from_tgas(50))
        .transact()
        .await?
        .into_result()?;
    let tx_accept_deal = accept_res.outcome().transaction_hash;
    println!("Seller accepted deal. Tx: {}", tx_accept_deal);

    // Step 3: Deposits (Buyer deposits 0.07 NEAR, Seller deposits 0.04 NEAR)
    println!("\n[3/7] Buyer depositing 0.07 NEAR (price + collateral)...");
    let buyer_dep_res = buyer_signer
        .call(&escrow_id, "deposit")
        .args_json(serde_json::json!({ "deal_id": deal_id }))
        .deposit(NearToken::from_yoctonear(buyer_total_deposit))
        .gas(near_workspaces::types::Gas::from_tgas(50))
        .transact()
        .await?
        .into_result()?;
    let tx_buyer_deposit = buyer_dep_res.outcome().transaction_hash;
    println!("Buyer deposit confirmed. Tx: {}", tx_buyer_deposit);

    println!("\n[4/7] Seller depositing 0.04 NEAR collateral...");
    let seller_dep_res = seller_signer
        .call(&escrow_id, "deposit")
        .args_json(serde_json::json!({ "deal_id": deal_id }))
        .deposit(NearToken::from_yoctonear(seller_collateral_yocto))
        .gas(near_workspaces::types::Gas::from_tgas(50))
        .transact()
        .await?
        .into_result()?;
    let tx_seller_deposit = seller_dep_res.outcome().transaction_hash;
    println!("Seller deposit confirmed. Tx: {}", tx_seller_deposit);

    // Read on-chain deal state to verify Funded
    let deal: Deal = worker
        .view(&escrow_id, "get_deal")
        .args_json(serde_json::json!({ "deal_id": deal_id }))
        .await?
        .json()?;
    assert_eq!(deal.status, DealStatus::Funded, "Deal must be Funded");
    println!("Deal #{} Status: FUNDED (verified on-chain)", deal_id);

    // Step 4: Seller injects real OpenRouter key into Phala CVM vault
    println!("\n[5/7] Seller injecting real OpenRouter API key into Phala CVM vault...");
    let key_inject_url = format!("{}/v1/deals/{}/key", CVM_BASE_URL, deal_id);
    let openrouter_key = get_openrouter_api_key();
    let credit_usd = 0.000030;
    let key_inject_body = serde_json::json!({
        "provider": "openrouter",
        "model": "meta-llama/llama-3.2-1b-instruct",
        "models": ["meta-llama/llama-3.2-1b-instruct"],
        "creditUsd": credit_usd,
        "priceUsd": credit_usd,
        "creditAmountYocto": credit_amount_yocto.to_string(),
        "termsHashHex": terms_hash_hex,
        "plainApiKey": openrouter_key
    });

    let inject_res = http_client
        .post(&key_inject_url)
        .json(&key_inject_body)
        .send()
        .await?
        .json::<Value>()
        .await?;

    println!("CVM Key Injection Response: ok={}", inject_res["ok"]);
    if !inject_res["ok"].as_bool().unwrap_or(false) {
        panic!("Key injection failed on CVM: {:?}", inject_res);
    }

    let proxy_key = inject_res["proxyKey"].as_str().unwrap().to_string();
    println!("Generated CVM Proxy Key: {}", proxy_key);

    let activate_payload_json = if inject_res["activatePayload"]["payload"].is_object() {
        &inject_res["activatePayload"]["payload"]
    } else {
        &inject_res["activatePayload"]
    };
    let activate_sig_hex = inject_res["activateSignatureHex"]
        .as_str()
        .or_else(|| inject_res["activatePayload"]["signatureHex"].as_str())
        .expect("activate signature hex missing");
    let activate_payload = parse_signed_payload(activate_payload_json)?;
    let activate_sig = hex::decode(activate_sig_hex)?;

    println!("CVM signed ACTIVATE payload: kind=1, nonce={}, sig={}...", activate_payload.nonce, &activate_sig_hex[..16]);

    // Submit ACTIVATE on-chain
    println!("Submitting activate transaction on-chain...");
    let activate_res = seller_signer
        .call(&escrow_id, "activate")
        .args_json(serde_json::json!({
            "deal_id": deal_id,
            "payload": activate_payload,
            "sig": activate_sig
        }))
        .gas(near_workspaces::types::Gas::from_tgas(80))
        .transact()
        .await?
        .into_result()?;
    let tx_activate = activate_res.outcome().transaction_hash;
    println!("SUCCESS! Deal activated on-chain via CVM-signed proof. Tx: {}", tx_activate);

    // Step 5: Buyer sends LLM queries through CVM Reverse Proxy with OpenRouter!
    println!("\n[6/7] SENDING REQUESTS THROUGH CVM PROXY & RECORDING USAGE + METER...");
    let chat_url = format!("{}/v1/chat/completions", CVM_BASE_URL);

    let prompts = [
        ("Explain what an Intel TDX hardware enclave is in 35 words.", 45),
        ("Explain zero knowledge proofs and cryptographic succinctness in 35 words.", 45),
        ("Explain decentralized escrow on NEAR blockchain with confidential compute in 35 words.", 45),
        ("State the speed of light in vacuum and why nothing travels faster in 20 words.", 25),
    ];

    for (i, (prompt, max_tok)) in prompts.iter().enumerate() {
        println!("\n------------------------------------------------------------");
        println!("  REQUEST #{}: \"{}\"", i + 1, prompt);
        println!("------------------------------------------------------------");

        let chat_body = serde_json::json!({
            "model": "meta-llama/llama-3.2-1b-instruct",
            "messages": [{"role": "user", "content": prompt}],
            "max_tokens": max_tok
        });

        let chat_res = http_client
            .post(&chat_url)
            .header("Authorization", format!("Bearer {}", proxy_key))
            .header("Content-Type", "application/json")
            .json(&chat_body)
            .send()
            .await?
            .json::<Value>()
            .await?;

        let response_text = chat_res["choices"][0]["message"]["content"]
            .as_str()
            .unwrap_or("");
        let usage_json = serde_json::to_string_pretty(&chat_res["usage"])?;

        println!("OpenRouter Model:       {}", chat_res["model"].as_str().unwrap_or("unknown"));
        println!("Response Output:        \"{}\"", response_text.trim());
        println!("OpenRouter Usage JSON:\n{}", usage_json);

        // Query live meter snapshot from CVM
        let meter_url = format!("{}/v1/deals/{}/meter", CVM_BASE_URL, deal_id);
        let meter_res = http_client.get(&meter_url).send().await?.json::<Value>().await?;
        println!("Live CVM Meter:         usedUsd=${}, tokensTotal={}, active={}",
            meter_res["usedUsd"],
            meter_res["tokensTotal"],
            meter_res["active"]);

        // Query signed payloads from CVM
        let payloads_url = format!("{}/v1/deals/{}/payloads", CVM_BASE_URL, deal_id);
        let payloads_res = http_client.get(&payloads_url).send().await?.json::<Value>().await?;
        if let Some(payloads_arr) = payloads_res["signedPayloads"].as_array() {
            println!("Signed Payloads Count:  {}", payloads_arr.len());
            for p in payloads_arr {
                let kind = p["payload"]["kind"].as_u64().unwrap_or(0);
                let stage = p["payload"]["stage"].as_u64().unwrap_or(0);
                let val = p["payload"]["meteredValueYocto"].as_str().unwrap_or("0");
                let nonce = p["payload"]["nonce"].as_str().unwrap_or("0");
                println!("  -> Payload kind={}, stage={}%, meteredValueYocto={}, nonce={}", kind, stage, val, nonce);
            }
        }
    }

    // Retrieve all signed Stage payloads from CVM and submit them in sequence
    println!("\nRetrieving signed Stage release payloads from CVM...");
    let payloads_url = format!("{}/v1/deals/{}/payloads", CVM_BASE_URL, deal_id);
    let payloads_res = http_client.get(&payloads_url).send().await?.json::<Value>().await?;
    let signed_payloads = payloads_res["signedPayloads"].as_array().expect("signedPayloads array");

    let mut released_stages = std::collections::HashSet::new();
    let mut stage_txs = Vec::new();

    for item in signed_payloads {
        if item["payload"]["kind"].as_u64() == Some(2) {
            let stage_num = item["payload"]["stage"].as_u64().unwrap_or(0) as u8;
            if !released_stages.contains(&stage_num) {
                released_stages.insert(stage_num);
                let stage_payload = parse_signed_payload(&item["payload"])?;
                let stage_sig = hex::decode(item["signatureHex"].as_str().unwrap())?;

                println!("\nSubmitting release_stage for Stage {}% on-chain (metered: {} yoctoNEAR)...",
                    stage_num, stage_payload.metered_value.0);

                let stage_res = seller_signer
                    .call(&escrow_id, "release_stage")
                    .args_json(serde_json::json!({
                        "deal_id": deal_id,
                        "stage": stage_num,
                        "payload": stage_payload,
                        "sig": stage_sig
                    }))
                    .gas(near_workspaces::types::Gas::from_tgas(80))
                    .transact()
                    .await?
                    .into_result()?;

                let tx_hash = stage_res.outcome().transaction_hash;
                println!("SUCCESS! Stage {}% released on-chain. Tx: {}", stage_num, tx_hash);
                stage_txs.push((stage_num, tx_hash));
            }
        }
    }

    // Trigger completion or breach default to settle the deal
    println!("\n[7/7] Settling deal with breach default proof from CVM (POST /v1/deals/{}/default)...", deal_id);
    let default_url = format!("{}/v1/deals/{}/default", CVM_BASE_URL, deal_id);
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

    println!("CVM signed DEFAULT payload: kind=4, reason={:?}, sig={}...", default_payload.reason, &default_sig_hex[..16]);

    println!("Submitting settle_default on-chain...");
    let default_res = buyer_signer
        .call(&escrow_id, "settle_default")
        .args_json(serde_json::json!({
            "deal_id": deal_id,
            "payload": default_payload,
            "sig": default_sig
        }))
        .gas(near_workspaces::types::Gas::from_tgas(100))
        .transact()
        .await?
        .into_result()?;
    let tx_settle_default = default_res.outcome().transaction_hash;
    println!("SUCCESS! Deal defaulted and settled on-chain. Tx: {}", tx_settle_default);

    // Final on-chain verification
    let final_deal: Deal = worker
        .view(&escrow_id, "get_deal")
        .args_json(serde_json::json!({ "deal_id": deal_id }))
        .await?
        .json()?;

    println!("\n============================================================");
    println!("   FRESH DEAL COMPLETE (OPENROUTER IN INTEL TDX VERIFIED)   ");
    println!("============================================================");
    println!("Deal ID:                   #{}", deal_id);
    println!("Buyer Account:             {}", buyer_signer.id());
    println!("Seller Account:            {}", seller_signer.id());
    println!("Escrow Contract:           {}", escrow_id);
    println!("Escrow Code Hash:          {}", "3Ks71TbyLdhaVqFSaNy3Yv2AvxFtsuwJcecVaYkBEoqL");
    println!("TEE Signer:                {}", tee_signer_near);
    println!("TEE Compose Hash:          {}", compose_hash);
    println!("Terms Hash:                {}", terms_hash_hex);
    println!("Tx 1 (Create Deal):        {}", tx_create_deal);
    println!("Tx 2 (Accept Deal):        {}", tx_accept_deal);
    println!("Tx 3 (Buyer Deposit):      {}", tx_buyer_deposit);
    println!("Tx 4 (Seller Deposit):     {}", tx_seller_deposit);
    println!("Tx 5 (Activate - CVM):     {}", tx_activate);
    println!("Tx 6 (Stage Releases):     {:?}", stage_txs);
    println!("Tx 7 (Settle Default - CVM):{}", tx_settle_default);
    println!("Final Deal Status:         {:?}", final_deal.status);
    println!("Released to Seller:        {} yoctoNEAR", final_deal.released_to_seller);
    println!("============================================================");

    Ok(())
}
