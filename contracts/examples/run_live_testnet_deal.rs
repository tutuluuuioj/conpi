use conpi_escrow::types::{
    CreateDealParams, Deal, DealStatus, DefaultReason, PayloadKind, SignedPayload, TeeSigner,
};
use near_sdk::json_types::U128;
use near_sdk::PublicKey;
use near_workspaces::types::NearToken;
use serde_json::Value;

const ESCROW_ID: &str = "dev-20261103062448-30583839049419.testnet";
const CVM_BASE_URL: &str = "https://b1b35377079ac7b7937afc607481587bc6d22665-3000.dstack-pha-prod9.phala.network";

fn get_redpill_api_key() -> String {
    if let Ok(key) = std::env::var("REDPILL_API_KEY") {
        if !key.trim().is_empty() {
            return key.trim().to_string();
        }
    }
    let paths = [
        ".credentials/redpill_key.txt",
        "contracts/.credentials/redpill_key.txt",
        ".credentials/testnet_keys.json",
        "contracts/.credentials/testnet_keys.json",
    ];
    for p in paths {
        if let Ok(content) = std::fs::read_to_string(p) {
            let trimmed = content.trim();
            if trimmed.starts_with('{') {
                if let Ok(v) = serde_json::from_str::<serde_json::Value>(trimmed) {
                    if let Some(k) = v["redpillApiKey"].as_str() {
                        return k.to_string();
                    }
                }
            } else if !trimmed.is_empty() {
                return trimmed.to_string();
            }
        }
    }
    panic!("REDPILL_API_KEY environment variable or gitignored .credentials/redpill_key.txt required");
}

fn get_funder_secret_key() -> near_workspaces::types::SecretKey {
    if let Ok(sk_str) = std::env::var("NEAR_FUNDER_PRIVATE_KEY") {
        if !sk_str.trim().is_empty() {
            return sk_str.trim().parse().expect("valid secret key from env");
        }
    }
    let paths = [
        ".credentials/testnet_funder.json",
        "contracts/.credentials/testnet_funder.json",
        "/Users/tutul/gnear/.deploy/testnet.json",
    ];
    for p in paths {
        if let Ok(content) = std::fs::read_to_string(p) {
            if let Ok(v) = serde_json::from_str::<serde_json::Value>(&content) {
                if let Some(k) = v["privateKey"].as_str() {
                    return k.parse().expect("valid secret key from funder file");
                }
            }
        }
    }
    panic!("NEAR_FUNDER_PRIVATE_KEY environment variable or gitignored .credentials/testnet_funder.json required");
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

    let metered_val_str = if let Some(s) = val["meteredValueYocto"].as_str() {
        s
    } else if let Some(s) = val["metered_value"].as_str() {
        s
    } else {
        "0"
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
            _ => Some(DefaultReason::InvalidKey),
        }
    } else {
        None
    };

    let nonce = if let Some(n) = val["nonce"].as_u64() {
        n
    } else if let Some(s) = val["nonce"].as_str() {
        s.parse::<u64>()?
    } else {
        1
    };

    let issued_at = if let Some(n) = val["issuedAtNs"].as_u64() {
        n
    } else if let Some(s) = val["issuedAtNs"].as_str() {
        s.parse::<u64>()?
    } else if let Some(n) = val["issued_at"].as_u64() {
        n
    } else if let Some(s) = val["issued_at"].as_str() {
        s.parse::<u64>()?
    } else {
        0
    };

    Ok(SignedPayload {
        domain: val["domain"].as_str().unwrap_or("conpi:v1").to_string(),
        contract_id: val["contractId"].as_str().unwrap_or(ESCROW_ID).parse()?,
        chain_id: val["chainId"].as_str().unwrap_or("testnet").to_string(),
        deal_id: val["dealId"].as_u64().unwrap_or_default(),
        terms_hash,
        kind,
        stage: val["stage"].as_u64().unwrap_or_default() as u8,
        metered_value: U128(metered_val_str.parse()?),
        reason,
        foreign_tx_sighash: None,
        nonce,
        issued_at,
    })
}

use std::sync::atomic::{AtomicU64, Ordering};
static ACC_COUNTER: AtomicU64 = AtomicU64::new(1);

async fn create_funded_account(
    worker: &near_workspaces::Worker<near_workspaces::network::Testnet>,
) -> Result<near_workspaces::Account, Box<dyn std::error::Error>> {
    let sk = get_funder_secret_key();
    let master = near_workspaces::Account::from_secret_key("gnear-89a6413e.testnet".parse()?, sk, worker);
    let cnt = ACC_COUNTER.fetch_add(1, Ordering::SeqCst);
    let ts = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH)?.as_millis() % 100_000;
    let sub_name = format!("u{}{}", ts, cnt);
    let sub = master.create_subaccount(&sub_name).initial_balance(NearToken::from_yoctonear(800_000_000_000_000_000_000_000)).transact().await?.into_result()?;
    Ok(sub)
}

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    println!("============================================================");
    println!("   RUN LIVE ON-CHAIN TESTNET DEAL (PHALA INTEL TDX TEE)     ");
    println!("   CVM SIGNS ALL PROOFS -> RELAYER SUBMITS ON-CHAIN         ");
    println!("============================================================");

    let http_client = reqwest::Client::new();

    // 1. Fetch live CVM attestation
    println!("Fetching live attestation from Phala CVM ({}/v1/attestation)...", CVM_BASE_URL);
    let att_url = format!("{}/v1/attestation?nonce=436f6e7069546573746e65744465616c", CVM_BASE_URL);
    let att_resp = http_client.get(&att_url).send().await?.json::<Value>().await?;

    let in_enclave = att_resp["inEnclave"].as_bool().unwrap_or(false);
    let tee_signer_near = att_resp["signerPublicKeyNear"].as_str().unwrap_or_default();
    let mrtd = att_resp["mrtd"].as_str().unwrap_or_default();

    println!("CVM Status: inEnclave={}, provider='{}'", in_enclave, att_resp["provider"].as_str().unwrap_or(""));
    println!("CVM Hardware Signer: {}", tee_signer_near);
    println!("CVM Measured MRTD:   {}", mrtd);
    assert!(in_enclave, "CVM must be running in hardware enclave");

    // 2. Connect to Testnet & Verify Signer is Active on Escrow Contract
    println!("\nConnecting to NEAR Testnet...");
    let worker = near_workspaces::testnet().await?;
    let escrow_id: near_sdk::AccountId = ESCROW_ID.parse()?;
    let tee_pubkey: PublicKey = tee_signer_near.parse()?;

    println!("Verifying TEE signer status on Escrow contract {}...", escrow_id);
    let signer_info: Option<TeeSigner> = worker
        .view(&escrow_id, "get_tee_signer")
        .args_json(serde_json::json!({ "public_key": tee_signer_near }))
        .await?
        .json()?;

    if let Some(s) = signer_info {
        println!("Verified on-chain TEE Signer (active: {}, registered_at: {})", s.active, s.registered_at);
        assert!(s.active, "Signer must be active on-chain");
    } else {
        panic!("TEE Signer {} not registered on escrow contract!", tee_signer_near);
    }

    // 3. Create test accounts: Buyer, Seller, Relayer
    println!("\nCreating funded test Buyer, Seller, and Relayer accounts on Testnet...");
    let buyer = create_funded_account(&worker).await?;
    tokio::time::sleep(std::time::Duration::from_secs(3)).await;
    let seller = create_funded_account(&worker).await?;
    tokio::time::sleep(std::time::Duration::from_secs(3)).await;
    let relayer = create_funded_account(&worker).await?;
    println!("  Buyer:   {}", buyer.id());
    println!("  Seller:  {}", seller.id());
    println!("  Relayer: {}", relayer.id());

    // Deal Economics (using yoctoNEAR)
    let price_yocto: u128 = 200_000_000_000_000_000_000_000;          // 0.2 NEAR
    let credit_amount_yocto: u128 = 0;                                   // 0 threshold for stage proof
    let buyer_collateral_yocto: u128 = 50_000_000_000_000_000_000_000;  // 0.05 NEAR
    let seller_collateral_yocto: u128 = 100_000_000_000_000_000_000_000;// 0.1 NEAR
    let buyer_total_deposit = price_yocto + buyer_collateral_yocto;      // 0.25 NEAR
    let storage_deposit_fee: u128 = 50_000_000_000_000_000_000_000;     // 0.05 NEAR

    // Step 1: Buyer creates deal on-chain
    println!("\n[1/7] Buyer calling create_deal on Escrow contract...");
    let create_params = CreateDealParams {
        buyer: buyer.id().clone(),
        seller: seller.id().clone(),
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
        slash_bps_revoke: 8000, // 80% slash on revocation
        slash_bps_buyer_breach: 5000,
    };

    let create_res = buyer
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
    let accept_res = seller
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

    // Step 3: Deposits (Buyer deposits 2.5 NEAR, Seller deposits 1.0 NEAR)
    println!("\n[3/7] Buyer depositing 2.5 NEAR (price + collateral)...");
    let buyer_dep_res = buyer
        .call(&escrow_id, "deposit")
        .args_json(serde_json::json!({ "deal_id": deal_id }))
        .deposit(NearToken::from_yoctonear(buyer_total_deposit))
        .gas(near_workspaces::types::Gas::from_tgas(50))
        .transact()
        .await?
        .into_result()?;
    let tx_buyer_deposit = buyer_dep_res.outcome().transaction_hash;
    println!("Buyer deposit confirmed. Tx: {}", tx_buyer_deposit);

    println!("\n[4/7] Seller depositing 1.0 NEAR collateral...");
    let seller_dep_res = seller
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

    // Step 4: Seller injects API Key into Phala CVM -> CVM derives keys and signs ACTIVATE payload
    println!("\n[5/7] Seller injecting real API key into Phala CVM vault (POST /v1/deals/{}/key)...", deal_id);
    let key_inject_url = format!("{}/v1/deals/{}/key", CVM_BASE_URL, deal_id);
    let key_inject_body = serde_json::json!({
        "provider": "redpill",
        "model": "qwen/qwen-2.5-7b-instruct",
        "models": ["qwen/qwen-2.5-7b-instruct"],
        "creditUsd": 0.0004,
        "priceUsd": 0.0004,
        "termsHashHex": terms_hash_hex,
        "plainApiKey": get_redpill_api_key()
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

    // Relayer submits ACTIVATE on-chain
    println!("Relayer submitting activate transaction on-chain...");
    let activate_res = relayer
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

    // Step 5: Buyer sends LLM query through CVM Reverse Proxy -> CVM meters tokens and signs STAGE payload
    println!("\n[5/7] Buyer sending LLM completion request via CVM Proxy (POST /v1/chat/completions)...");
    let chat_url = format!("{}/v1/chat/completions", CVM_BASE_URL);
    let chat_body = serde_json::json!({
        "model": "qwen/qwen-2.5-7b-instruct",
        "messages": [{"role": "user", "content": "Conpi Phase 2 TEE Verification test payload"}],
        "max_tokens": 10
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

    println!("CVM Proxy Response received: id={}", chat_res["id"]);
    println!("Usage reported by provider: prompt_tokens={}, completion_tokens={}",
        chat_res["usage"]["prompt_tokens"], chat_res["usage"]["completion_tokens"]);

    // Query signed payloads from CVM to retrieve Stage payload
    println!("Querying signed payloads from CVM (GET /v1/deals/{}/payloads)...", deal_id);
    let payloads_url = format!("{}/v1/deals/{}/payloads", CVM_BASE_URL, deal_id);
    let payloads_res = http_client.get(&payloads_url).send().await?.json::<Value>().await?;
    let signed_payloads = payloads_res["signedPayloads"].as_array().expect("signedPayloads array");

    let stage_entry = signed_payloads
        .iter()
        .find(|item| item["payload"]["kind"].as_u64() == Some(2))
        .expect("CVM must have generated and signed a Stage payload");

    let stage_payload = parse_signed_payload(&stage_entry["payload"])?;
    let stage_sig = hex::decode(stage_entry["signatureHex"].as_str().unwrap())?;
    let stage_number = stage_payload.stage;

    println!("CVM signed STAGE payload: stage={}%, meteredValueYocto={}, sig={}...",
        stage_number, stage_payload.metered_value.0, &stage_entry["signatureHex"].as_str().unwrap()[..16]);

    // Relayer submits release_stage on-chain
    println!("Relayer submitting release_stage transaction on-chain...");
    let stage_res = relayer
        .call(&escrow_id, "release_stage")
        .args_json(serde_json::json!({
            "deal_id": deal_id,
            "stage": stage_number,
            "payload": stage_payload,
            "sig": stage_sig
        }))
        .gas(near_workspaces::types::Gas::from_tgas(80))
        .transact()
        .await?
        .into_result()?;
    let tx_release_stage = stage_res.outcome().transaction_hash;
    println!("SUCCESS! Stage {}% released on-chain via CVM-signed proof. Tx: {}", stage_number, tx_release_stage);

    // Step 6: Seller Key Revocation Breach -> CVM signs DEFAULT payload -> Relayer submits settle_default
    println!("\n[6/7] Triggering breach default on CVM (POST /v1/deals/{}/default)...", deal_id);
    let default_url = format!("{}/v1/deals/{}/default", CVM_BASE_URL, deal_id);
    let default_trigger_res = http_client
        .post(&default_url)
        .json(&serde_json::json!({ "reason": "InvalidKey" }))
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

    // Relayer submits settle_default on-chain
    println!("Relayer submitting settle_default transaction on-chain...");
    let default_res = relayer
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
    println!("SUCCESS! Deal defaulted and slashed on-chain. Tx: {}", tx_settle_default);

    // Step 7: Verify final on-chain deal state
    println!("\n[7/7] Verifying final on-chain state on Escrow contract...");
    let final_deal: Deal = worker
        .view(&escrow_id, "get_deal")
        .args_json(serde_json::json!({ "deal_id": deal_id }))
        .await?
        .json()?;

    println!("Final On-Chain Deal Status: {:?}", final_deal.status);
    println!("Released to Seller:         {} yoctoNEAR", final_deal.released_to_seller);
    assert_eq!(final_deal.status, DealStatus::Defaulted, "Deal must be Defaulted on-chain");

    println!("\n============================================================");
    println!("   PHASE 2 LIVE TESTNET DEAL VERIFIED (100% CVM-SIGNED)!   ");
    println!("============================================================");
    println!("Deal ID:                   #{}", deal_id);
    println!("Buyer Account:             {}", buyer.id());
    println!("Seller Account:            {}", seller.id());
    println!("Relayer Account:           {}", relayer.id());
    println!("Escrow Contract:           {}", escrow_id);
    println!("TEE Hardware Signer:       {}", tee_signer_near);
    println!("Terms Hash:                {}", terms_hash_hex);
    println!("Tx 1 (Create Deal):        {}", tx_create_deal);
    println!("Tx 2 (Accept Deal):        {}", tx_accept_deal);
    println!("Tx 3 (Buyer Deposit):      {}", tx_buyer_deposit);
    println!("Tx 4 (Seller Deposit):     {}", tx_seller_deposit);
    println!("Tx 5 (Activate - CVM):     {}", tx_activate);
    println!("Tx 6 (Release Stage - CVM):{}", tx_release_stage);
    println!("Tx 7 (Settle Default - CVM):{}", tx_settle_default);
    println!("============================================================");

    Ok(())
}
