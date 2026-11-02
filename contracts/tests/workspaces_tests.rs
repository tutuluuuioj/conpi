use ed25519_dalek::{Signer, SigningKey};
use near_sdk::borsh::BorshSerialize;
use near_sdk::json_types::U128;
use near_sdk::PublicKey;
use near_workspaces::types::NearToken;
use rand::rngs::OsRng;
use serde::{Deserialize, Serialize};

const WASM_PATH: &str = "./target/wasm32-unknown-unknown/release/conpi_escrow.wasm";

#[derive(BorshSerialize, Serialize, Deserialize)]
#[borsh(crate = "near_sdk::borsh")]
enum PayloadKind {
    Terms,
    Activate,
    Stage,
    Checkpoint,
    Default,
}

#[derive(BorshSerialize, Serialize, Deserialize)]
#[borsh(crate = "near_sdk::borsh")]
struct SignedPayload {
    pub domain: String,
    pub contract_id: near_sdk::AccountId,
    pub chain_id: String,
    pub deal_id: u64,
    pub terms_hash: [u8; 32],
    pub kind: PayloadKind,
    pub stage: u8,
    pub metered_value: U128,
    pub reason: Option<u8>,
    pub nonce: u64,
    pub issued_at: u64,
}

fn generate_tee_keypair() -> (SigningKey, PublicKey) {
    let signing_key = SigningKey::generate(&mut OsRng);
    let verifying_key = signing_key.verifying_key();
    let mut pk_bytes = vec![0x00];
    pk_bytes.extend_from_slice(verifying_key.as_bytes());
    let near_pk = PublicKey::try_from(pk_bytes).expect("Valid near PublicKey");
    (signing_key, near_pk)
}

fn sign_terms_hash(
    signing_key: &SigningKey,
    contract_id: &str,
    deal_id: u64,
    terms_hash: &[u8; 32],
) -> Vec<u8> {
    let mut msg_bytes = Vec::new();
    msg_bytes.extend_from_slice(b"conpi:v1:terms:");
    msg_bytes.extend_from_slice(contract_id.as_bytes());
    msg_bytes.extend_from_slice(&deal_id.to_le_bytes());
    msg_bytes.extend_from_slice(terms_hash);
    signing_key.sign(&msg_bytes).to_bytes().to_vec()
}

#[tokio::test]
async fn test_workspaces_full_lifecycle() -> Result<(), Box<dyn std::error::Error>> {
    // 1. Start NEAR Sandbox
    let worker = near_workspaces::sandbox().await?;

    // 2. Read compiled WASM contract
    let wasm = std::fs::read(WASM_PATH)?;
    let contract = worker.dev_deploy(&wasm).await?;

    let owner = worker.root_account()?;
    let buyer = worker.dev_create_account().await?;
    let seller = worker.dev_create_account().await?;

    // 3. Initialize Contract
    let init_res = contract
        .call("new")
        .args_json(serde_json::json!({
            "owner": owner.id(),
            "config": null
        }))
        .transact()
        .await?;
    assert!(init_res.is_success());

    // 4. Register TEE Signer
    let (tee_sk, tee_pk) = generate_tee_keypair();
    let add_signer_res = owner
        .call(contract.id(), "add_tee_signer")
        .args_json(serde_json::json!({
            "public_key": tee_pk,
            "measurement": "phala_intel_tdx_quote_sha256_mock"
        }))
        .transact()
        .await?;
    assert!(add_signer_res.is_success());

    // 5. Create Deal on-chain: Price = 5 NEAR, Buyer Collateral = 1 NEAR, Seller Collateral = 2 NEAR
    let price = NearToken::from_near(5);
    let credit_amount = NearToken::from_near(8);
    let buyer_collateral = NearToken::from_near(1);
    let seller_collateral = NearToken::from_near(2);

    let create_res = buyer
        .call(contract.id(), "create_deal")
        .args_json(serde_json::json!({
            "params": {
                "buyer": buyer.id(),
                "seller": seller.id(),
                "token": null,
                "price": U128(price.as_yoctonear()),
                "credit_amount": U128(credit_amount.as_yoctonear()),
                "buyer_collateral": U128(buyer_collateral.as_yoctonear()),
                "seller_collateral": U128(seller_collateral.as_yoctonear()),
                "tee_pubkey": tee_pk,
                "deposit_duration_sec": 86400,
                "key_duration_sec": 86400,
                "tee_liveness_timeout_sec": 3600,
                "slash_bps_provider_ban": 5000,
                "slash_bps_revoke": 8000
            }
        }))
        .transact()
        .await?;
    assert!(create_res.is_success());
    let deal_id: u64 = create_res.json()?;
    assert_eq!(deal_id, 1);

    // 6. Register Terms Hash
    let terms_hash = [55u8; 32];
    let terms_sig = sign_terms_hash(&tee_sk, contract.id().as_str(), deal_id, &terms_hash);
    let reg_terms_res = contract
        .call("register_terms_hash")
        .args_json(serde_json::json!({
            "deal_id": deal_id,
            "terms_hash": terms_hash,
            "sig": terms_sig
        }))
        .transact()
        .await?;
    assert!(reg_terms_res.is_success());

    // 7. Buyer Deposit: 5 NEAR + 1 NEAR = 6 NEAR attached deposit
    let buyer_dep_res = buyer
        .call(contract.id(), "deposit")
        .args_json(serde_json::json!({ "deal_id": deal_id }))
        .deposit(NearToken::from_near(6))
        .transact()
        .await?;
    assert!(buyer_dep_res.is_success());

    // 8. Seller Deposit: 2 NEAR attached deposit
    let seller_dep_res = seller
        .call(contract.id(), "deposit")
        .args_json(serde_json::json!({ "deal_id": deal_id }))
        .deposit(NearToken::from_near(2))
        .transact()
        .await?;
    assert!(seller_dep_res.is_success());

    // Verify Deal state is now FUNDED on-chain
    let deal_view: serde_json::Value = contract
        .view("get_deal")
        .args_json(serde_json::json!({ "deal_id": deal_id }))
        .await?
        .json()?;
    assert_eq!(deal_view["status"], "Funded");

    // 9. Activate Deal on-chain via TEE SignedPayload
    let activate_payload = serde_json::json!({
        "domain": "conpi:v1",
        "contract_id": contract.id().to_string(),
        "chain_id": "testnet",
        "deal_id": deal_id,
        "terms_hash": terms_hash,
        "kind": "Activate",
        "stage": 0,
        "metered_value": "0",
        "reason": null,
        "nonce": 1,
        "issued_at": 1000
    });

    // Canonical Borsh payload for signature
    let signed_payload_struct = SignedPayload {
        domain: "conpi:v1".to_string(),
        contract_id: contract.id().to_string().parse().unwrap(),
        chain_id: "testnet".to_string(),
        deal_id,
        terms_hash,
        kind: PayloadKind::Activate,
        stage: 0,
        metered_value: U128(0),
        reason: None,
        nonce: 1,
        issued_at: 1000,
    };
    let payload_bytes = borsh::to_vec(&signed_payload_struct)?;
    let act_sig = tee_sk.sign(&payload_bytes).to_bytes().to_vec();

    let act_res = contract
        .call("activate")
        .args_json(serde_json::json!({
            "deal_id": deal_id,
            "payload": activate_payload,
            "sig": act_sig
        }))
        .transact()
        .await?;
    assert!(act_res.is_success());

    // Verify Deal state is now ACTIVE on-chain
    let active_deal: serde_json::Value = contract
        .view("get_deal")
        .args_json(serde_json::json!({ "deal_id": deal_id }))
        .await?
        .json()?;
    assert_eq!(active_deal["status"], "Active");

    println!("near-workspaces: Deal #{} successfully activated on real blockchain sandbox!", deal_id);
    Ok(())
}
