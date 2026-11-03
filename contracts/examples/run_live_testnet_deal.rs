use conpi_escrow::crypto::CryptoHelper;
use conpi_escrow::types::{
    CreateDealParams, Deal, DealStatus, DefaultReason, PayloadKind, SignedPayload, TeeSigner,
};
use ed25519_dalek::{Signer, SigningKey};
use near_sdk::json_types::U128;
use near_sdk::PublicKey;
use near_workspaces::types::NearToken;
use std::time::{SystemTime, UNIX_EPOCH};

const ESCROW_ID: &str = "dev-20261103062448-30583839049419.testnet";
const STABLE_TEE_SIGNER: &str = "ed25519:4yo9jeUALcRXyzu3HNgS98qRyXj96vG17BPhh7fG3fD1";
const STABLE_SEED_HEX: &str = "d5507085278c26170113c69e1513f7290e9adf04adf986fb14f3977d69f64a51";

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    println!("============================================================");
    println!("   RUN LIVE ON-CHAIN TESTNET DEAL: CONPI PROTOCOL (PHASE 2) ");
    println!("============================================================");

    // 1. Connect to Testnet
    println!("Connecting to NEAR Testnet...");
    let worker = near_workspaces::testnet().await?;
    let escrow_id: near_sdk::AccountId = ESCROW_ID.parse()?;

    // 2. Setup stable TEE signer key
    let seed_bytes = hex::decode(STABLE_SEED_HEX)?;
    let seed_32: [u8; 32] = seed_bytes[0..32].try_into()?;
    let tee_signing_key = SigningKey::from_bytes(&seed_32);
    let tee_pubkey: PublicKey = STABLE_TEE_SIGNER.parse()?;

    println!("Target Escrow Contract: {}", escrow_id);
    println!("Stable TEE Signer:      {}", STABLE_TEE_SIGNER);

    // Verify TEE signer is active on escrow contract
    let signer_info: Option<TeeSigner> = worker
        .view(&escrow_id, "get_tee_signer")
        .args_json(serde_json::json!({ "public_key": STABLE_TEE_SIGNER }))
        .await?
        .json()?;

    if let Some(signer) = signer_info {
        println!("Verified on-chain TEE Signer (Active: {}, MRTD: {})", signer.active, signer.measurement);
        assert!(signer.active, "TEE Signer must be active on-chain");
    } else {
        panic!("TEE Signer {} not registered on escrow contract! Run register_tee_signer_multisig first.", STABLE_TEE_SIGNER);
    }

    // 3. Create test accounts: Buyer & Seller
    println!("\nCreating funded test Buyer and Seller accounts on Testnet...");
    let buyer = worker.dev_create_account().await?;
    let seller = worker.dev_create_account().await?;
    let relayer = worker.dev_create_account().await?;
    println!("  Buyer Account:   {}", buyer.id());
    println!("  Seller Account:  {}", seller.id());
    println!("  Relayer Account: {}", relayer.id());

    // Deal Economics (using yoctoNEAR)
    let price_yocto: u128 = 2_000_000_000_000_000_000_000_000;          // 2 NEAR
    let credit_amount_yocto: u128 = 2_000_000_000_000_000_000_000_000;   // 2 NEAR
    let buyer_collateral_yocto: u128 = 500_000_000_000_000_000_000_000;  // 0.5 NEAR
    let seller_collateral_yocto: u128 = 1_000_000_000_000_000_000_000_000;// 1 NEAR

    let buyer_total_deposit = price_yocto + buyer_collateral_yocto;      // 2.5 NEAR
    let storage_deposit_fee: u128 = 50_000_000_000_000_000_000_000;     // 0.05 NEAR

    let deposit_duration_sec: u64 = 600;
    let key_duration_sec: u64 = 600;
    let tee_liveness_timeout_sec: u64 = 3600;
    let slash_bps_provider_ban: u16 = 5000; // 50%
    let slash_bps_revoke: u16 = 8000;       // 80%
    let slash_bps_buyer_breach: u16 = 5000; // 50%

    // Step 1: Buyer creates deal on-chain
    println!("\n[1/5] Buyer calling create_deal on Escrow contract...");
    let create_params = CreateDealParams {
        buyer: buyer.id().clone(),
        seller: seller.id().clone(),
        token: None,
        price: U128(price_yocto),
        credit_amount: U128(credit_amount_yocto),
        buyer_collateral: U128(buyer_collateral_yocto),
        seller_collateral: U128(seller_collateral_yocto),
        tee_pubkey: tee_pubkey.clone(),
        deposit_duration_sec,
        key_duration_sec,
        tee_liveness_timeout_sec,
        slash_bps_provider_ban,
        slash_bps_revoke,
        slash_bps_buyer_breach,
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
    println!("Deal #{} created successfully!", deal_id);
    println!("Create Deal Tx Hash: {}", tx_create_deal);

    // Compute canonical terms hash
    let deal: Deal = worker
        .view(&escrow_id, "get_deal")
        .args_json(serde_json::json!({ "deal_id": deal_id }))
        .await?
        .json()?;
    let terms_hash = deal.terms_hash.expect("Deal terms_hash missing");
    println!("Computed Canonical Terms Hash: {}", hex::encode(terms_hash));

    // Step 2: Seller accepts deal
    println!("\n[2/5] Seller calling accept_deal with terms hash...");
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
    println!("Seller accepted deal. Tx Hash: {}", tx_accept_deal);

    // Step 3: Deposits (Buyer deposits 2.5 NEAR, Seller deposits 1.0 NEAR)
    println!("\n[3/5] Buyer and Seller depositing collateral and deal price...");
    let buyer_dep_res = buyer
        .call(&escrow_id, "deposit")
        .args_json(serde_json::json!({ "deal_id": deal_id }))
        .deposit(NearToken::from_yoctonear(buyer_total_deposit))
        .gas(near_workspaces::types::Gas::from_tgas(50))
        .transact()
        .await?
        .into_result()?;
    let tx_buyer_deposit = buyer_dep_res.outcome().transaction_hash;
    println!("Buyer deposit (2.5 NEAR) confirmed. Tx: {}", tx_buyer_deposit);

    let seller_dep_res = seller
        .call(&escrow_id, "deposit")
        .args_json(serde_json::json!({ "deal_id": deal_id }))
        .deposit(NearToken::from_yoctonear(seller_collateral_yocto))
        .gas(near_workspaces::types::Gas::from_tgas(50))
        .transact()
        .await?
        .into_result()?;
    let tx_seller_deposit = seller_dep_res.outcome().transaction_hash;
    println!("Seller deposit (1.0 NEAR) confirmed. Tx: {}", tx_seller_deposit);

    // Verify Deal is FUNDED
    let deal_funded: Deal = worker
        .view(&escrow_id, "get_deal")
        .args_json(serde_json::json!({ "deal_id": deal_id }))
        .await?
        .json()?;
    assert_eq!(deal_funded.status, DealStatus::Funded, "Deal must be Funded");
    println!("Deal Status: FUNDED (verified on-chain)");

    // Step 4: TEE Signs ACTIVATE payload -> Relayer submits on-chain
    println!("\n[4/5] TEE Signing ACTIVATE Payload and Relayer submitting on-chain...");
    let now_ns = SystemTime::now().duration_since(UNIX_EPOCH)?.as_nanos() as u64;

    let activate_payload = SignedPayload {
        domain: "conpi:v1".to_string(),
        contract_id: escrow_id.clone(),
        chain_id: "testnet".to_string(),
        deal_id,
        terms_hash,
        kind: PayloadKind::Activate,
        stage: 0,
        metered_value: U128(0),
        reason: None,
        nonce: 1,
        issued_at: now_ns,
    };
    let activate_bytes = CryptoHelper::serialize_payload(&activate_payload);
    let activate_sig = tee_signing_key.sign(&activate_bytes);

    let activate_res = relayer
        .call(&escrow_id, "activate")
        .args_json(serde_json::json!({
            "deal_id": deal_id,
            "payload": activate_payload,
            "sig": activate_sig.to_bytes().to_vec(),
        }))
        .gas(near_workspaces::types::Gas::from_tgas(80))
        .transact()
        .await?
        .into_result()?;
    let tx_activate = activate_res.outcome().transaction_hash;
    println!("SUCCESS! Deal activated on-chain by Relayer. Tx: {}", tx_activate);

    let deal_active: Deal = worker
        .view(&escrow_id, "get_deal")
        .args_json(serde_json::json!({ "deal_id": deal_id }))
        .await?
        .json()?;
    assert_eq!(deal_active.status, DealStatus::Active, "Deal must be Active");
    println!("Deal Status: ACTIVE (verified on-chain)");

    // Step 5: TEE Meters Traffic & Signs STAGE 25% Payout -> Relayer submits on-chain
    println!("\n[5/5] Metering traffic: TEE Signing STAGE (25%) Payout and Relayer submitting...");
    let stage25_value_yocto = price_yocto / 4; // 0.5 NEAR
    let now_ns_2 = SystemTime::now().duration_since(UNIX_EPOCH)?.as_nanos() as u64;

    let stage_payload = SignedPayload {
        domain: "conpi:v1".to_string(),
        contract_id: escrow_id.clone(),
        chain_id: "testnet".to_string(),
        deal_id,
        terms_hash,
        kind: PayloadKind::Stage,
        stage: 25,
        metered_value: U128(stage25_value_yocto),
        reason: None,
        nonce: 2,
        issued_at: now_ns_2,
    };
    let stage_bytes = CryptoHelper::serialize_payload(&stage_payload);
    let stage_sig = tee_signing_key.sign(&stage_bytes);

    let stage_res = relayer
        .call(&escrow_id, "release_stage")
        .args_json(serde_json::json!({
            "deal_id": deal_id,
            "stage": 25,
            "payload": stage_payload,
            "sig": stage_sig.to_bytes().to_vec(),
        }))
        .gas(near_workspaces::types::Gas::from_tgas(80))
        .transact()
        .await?
        .into_result()?;
    let tx_release_stage = stage_res.outcome().transaction_hash;
    println!("SUCCESS! Stage 25% released on-chain to seller. Tx: {}", tx_release_stage);

    let deal_staged: Deal = worker
        .view(&escrow_id, "get_deal")
        .args_json(serde_json::json!({ "deal_id": deal_id }))
        .await?
        .json()?;
    assert_eq!(deal_staged.stage_reached, 25, "Stage reached must be 25");
    assert_eq!(deal_staged.released_to_seller, stage25_value_yocto, "Released amount must match 25%");
    println!("Released to seller: 0.5 NEAR (verified on-chain)");

    // Step 6: Breach / Default Detection -> TEE Signs DEFAULT -> Relayer submits settle_default
    println!("\n[6/5] Seller Key Revocation Breach: TEE Signs DEFAULT and Relayer submits settle_default...");
    let now_ns_3 = SystemTime::now().duration_since(UNIX_EPOCH)?.as_nanos() as u64;

    let default_payload = SignedPayload {
        domain: "conpi:v1".to_string(),
        contract_id: escrow_id.clone(),
        chain_id: "testnet".to_string(),
        deal_id,
        terms_hash,
        kind: PayloadKind::Default,
        stage: 25,
        metered_value: U128(stage25_value_yocto),
        reason: Some(DefaultReason::InvalidKey),
        nonce: 3,
        issued_at: now_ns_3,
    };
    let default_bytes = CryptoHelper::serialize_payload(&default_payload);
    let default_sig = tee_signing_key.sign(&default_bytes);

    let default_res = relayer
        .call(&escrow_id, "settle_default")
        .args_json(serde_json::json!({
            "deal_id": deal_id,
            "payload": default_payload,
            "sig": default_sig.to_bytes().to_vec(),
        }))
        .gas(near_workspaces::types::Gas::from_tgas(100))
        .transact()
        .await?
        .into_result()?;
    let tx_settle_default = default_res.outcome().transaction_hash;
    println!("SUCCESS! Deal defaulted & slashed on-chain. Tx: {}", tx_settle_default);

    let deal_defaulted: Deal = worker
        .view(&escrow_id, "get_deal")
        .args_json(serde_json::json!({ "deal_id": deal_id }))
        .await?
        .json()?;
    assert_eq!(deal_defaulted.status, DealStatus::Defaulted, "Deal must be Defaulted");
    println!("Deal Status: DEFAULTED (verified on-chain with slashing executed)");

    println!("\n============================================================");
    println!("   LIVE TESTNET DEAL LIFECYCLE COMPLETED SUCCESSFULLY!      ");
    println!("============================================================");
    println!("Deal ID:                   #{}", deal_id);
    println!("Buyer Account:             {}", buyer.id());
    println!("Seller Account:            {}", seller.id());
    println!("Relayer Account:           {}", relayer.id());
    println!("Escrow Contract:           {}", escrow_id);
    println!("TEE Signer:                {}", STABLE_TEE_SIGNER);
    println!("Terms Hash:                {}", hex::encode(terms_hash));
    println!("Tx 1 (Create Deal):        {}", tx_create_deal);
    println!("Tx 2 (Accept Deal):        {}", tx_accept_deal);
    println!("Tx 3 (Buyer Deposit):      {}", tx_buyer_deposit);
    println!("Tx 4 (Seller Deposit):     {}", tx_seller_deposit);
    println!("Tx 5 (Activate Deal):      {}", tx_activate);
    println!("Tx 6 (Release Stage 25%):  {}", tx_release_stage);
    println!("Tx 7 (Settle Default):     {}", tx_settle_default);
    println!("============================================================");

    Ok(())
}
