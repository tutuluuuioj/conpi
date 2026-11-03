use ed25519_dalek::{Signer, SigningKey};
use near_sdk::borsh::BorshSerialize;
use near_sdk::json_types::U128;
use near_sdk::PublicKey;
use near_workspaces::types::NearToken;
use rand::rngs::OsRng;
use serde::{Deserialize, Serialize};

const WASM_PATH: &str = "./target/near/conpi_escrow.wasm";

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
    msg_bytes.extend_from_slice(b"conpi:v1:terms:testnet:");
    msg_bytes.extend_from_slice(contract_id.as_bytes());
    msg_bytes.extend_from_slice(b":");
    msg_bytes.extend_from_slice(&deal_id.to_le_bytes());
    msg_bytes.extend_from_slice(terms_hash);
    signing_key.sign(&msg_bytes).to_bytes().to_vec()
}

#[tokio::test]
async fn test_workspaces_full_lifecycle() -> Result<(), Box<dyn std::error::Error>> {
    // 1. Start NEAR Sandbox
    let worker = near_workspaces::sandbox().await?;

    // 2. Read compiled WASM contract (with embedded ABI and wasm-opt from cargo-near)
    let wasm = std::fs::read(WASM_PATH)?;
    let contract = worker.dev_deploy(&wasm).await?;

    let owner = worker.root_account()?;
    let buyer = worker.dev_create_account().await?;
    let seller = worker.dev_create_account().await?;

    // 3. Register TEE Signer with genuine TDX format measurement at initialization
    let (tee_sk, tee_pk) = generate_tee_keypair();
    let init_res = contract
        .call("new")
        .args_json(serde_json::json!({
            "owner": owner.id(),
            "chain_id": "testnet",
            "config": null,
            "initial_tee_signer": [
                tee_pk,
                "tdx_mrtd:c7b60e6e7655074d2e772e737c385b08fb8e15d8628bb9fb3d0ff08b98263ef26e5a40733568c07f45778a4f91ef2c01"
            ]
        }))
        .transact()
        .await?;
    assert!(init_res.is_success());

    // 4. Create Deal on-chain: Price = 5 NEAR, Buyer Collateral = 1 NEAR, Seller Collateral = 2 NEAR
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
                "slash_bps_revoke": 8000,
                "slash_bps_buyer_breach": 8000
            }
        }))
        .deposit(NearToken::from_millinear(50))
        .transact()
        .await?;
    assert!(create_res.is_success());
    let deal_id: u64 = create_res.json()?;
    assert_eq!(deal_id, 1);

    // 5. Inspect Deal on-chain to retrieve canonical terms_hash computed on-chain
    let deal_view: serde_json::Value = contract
        .view("get_deal")
        .args_json(serde_json::json!({ "deal_id": deal_id }))
        .await?
        .json()?;
    let terms_hash_raw: Vec<u8> = serde_json::from_value(deal_view["terms_hash"].clone())?;
    let mut terms_hash = [0u8; 32];
    terms_hash.copy_from_slice(&terms_hash_raw);

    // 6. Counterparty (seller) explicitly accepts the deal terms on-chain
    let accept_res = seller
        .call(contract.id(), "accept_deal")
        .args_json(serde_json::json!({
            "deal_id": deal_id,
            "expected_hash": terms_hash
        }))
        .transact()
        .await?;
    assert!(accept_res.is_success());

    // 7. TEE submits attestation for terms hash
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

    // 8. Buyer Deposit: 5 NEAR + 1 NEAR = 6 NEAR attached deposit
    let buyer_dep_res = buyer
        .call(contract.id(), "deposit")
        .args_json(serde_json::json!({ "deal_id": deal_id }))
        .deposit(NearToken::from_near(6))
        .transact()
        .await?;
    assert!(buyer_dep_res.is_success());

    // 9. Seller Deposit: 2 NEAR attached deposit
    let seller_dep_res = seller
        .call(contract.id(), "deposit")
        .args_json(serde_json::json!({ "deal_id": deal_id }))
        .deposit(NearToken::from_near(2))
        .transact()
        .await?;
    assert!(seller_dep_res.is_success());

    // Verify Deal state is now FUNDED on-chain
    let deal_view_funded: serde_json::Value = contract
        .view("get_deal")
        .args_json(serde_json::json!({ "deal_id": deal_id }))
        .await?
        .json()?;
    assert_eq!(deal_view_funded["status"], "Funded");

    // 10. Activate Deal on-chain via TEE SignedPayload
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

#[tokio::test]
async fn test_workspaces_failed_transfer_and_claim() -> Result<(), Box<dyn std::error::Error>> {
    // 1. Start NEAR Sandbox
    let worker = near_workspaces::sandbox().await?;

    // 2. Read compiled WASM contract
    let wasm = std::fs::read(WASM_PATH)?;
    let contract = worker.dev_deploy(&wasm).await?;

    let owner = worker.root_account()?;
    let user = worker.dev_create_account().await?;

    // 3. Initialize Contract
    let init_res = contract
        .call("new")
        .args_json(serde_json::json!({
            "owner": owner.id(),
            "chain_id": "testnet",
            "config": null,
            "initial_tee_signer": null
        }))
        .transact()
        .await?;
    assert!(init_res.is_success());

    // 4. Fund contract account with NEAR balance so it can execute claim payouts
    let _ = owner
        .transfer_near(contract.id(), NearToken::from_near(10))
        .await?;

    // 5. Trigger on_transfer_resolved as a failed transfer callback from contract itself
    let failed_amount = NearToken::from_near(4).as_yoctonear();
    let resolve_res = contract
        .as_account()
        .call(contract.id(), "on_transfer_resolved")
        .args_json(serde_json::json!({
            "recipient": user.id(),
            "amount": U128(failed_amount),
            "token": null
        }))
        .max_gas()
        .transact()
        .await?;
    assert!(resolve_res.is_success());

    // 6. Verify pending payout is recorded in contract state
    let pending_view: U128 = contract
        .view("get_pending_payout")
        .args_json(serde_json::json!({
            "account_id": user.id(),
            "token": null
        }))
        .await?
        .json()?;
    assert_eq!(pending_view.0, failed_amount, "Failed transfer must be credited to pending payouts");
    println!("near-workspaces: Verified {} yoctoNEAR credited to pending payouts for {}", failed_amount, user.id());

    // 7. User calls claim() to pull their funds safely
    let user_balance_before = user.view_account().await?.balance;
    let claim_res = user
        .call(contract.id(), "claim")
        .args_json(serde_json::json!({
            "token": null
        }))
        .max_gas()
        .transact()
        .await?;
    assert!(claim_res.is_success(), "claim() must succeed");

    // 8. Verify pending payout is now 0
    let pending_after: U128 = contract
        .view("get_pending_payout")
        .args_json(serde_json::json!({
            "account_id": user.id(),
            "token": null
        }))
        .await?
        .json()?;
    assert_eq!(pending_after.0, 0, "Pending payouts must be 0 after claim");

    // 9. Verify user received the funds
    let user_balance_after = user.view_account().await?.balance;
    assert!(
        user_balance_after > user_balance_before,
        "User balance must increase by claimed amount"
    );
    println!("near-workspaces: Successfully claimed pending payout! Balance increased from {} to {}", user_balance_before, user_balance_after);

    Ok(())
}

#[tokio::test]
async fn test_workspaces_timelocked_governance() -> Result<(), Box<dyn std::error::Error>> {
    let worker = near_workspaces::sandbox().await?;
    let wasm = std::fs::read(WASM_PATH)?;
    let contract = worker.dev_deploy(&wasm).await?;

    let owner = worker.root_account()?;
    let new_owner = worker.dev_create_account().await?;

    // Initialize contract
    let init_res = contract
        .call("new")
        .args_json(serde_json::json!({
            "owner": owner.id(),
            "chain_id": "testnet",
            "config": null,
            "initial_tee_signer": null
        }))
        .transact()
        .await?;
    assert!(init_res.is_success());

    // Propose ownership transfer
    let propose_res = owner
        .call(contract.id(), "propose_admin_action")
        .args_json(serde_json::json!({
            "action": {
                "TransferOwnership": {
                    "new_owner": new_owner.id()
                }
            }
        }))
        .max_gas()
        .transact()
        .await?;
    assert!(propose_res.is_success());
    let proposal_id: u64 = propose_res.json()?;
    assert_eq!(proposal_id, 1);

    // Immediate execution must fail on sandbox (timelock delay not passed)
    let early_exec = owner
        .call(contract.id(), "execute_admin_action")
        .args_json(serde_json::json!({
            "proposal_id": proposal_id,
            "code": null
        }))
        .max_gas()
        .transact()
        .await?;
    assert!(early_exec.is_failure(), "Immediate execution must fail 48h timelock");
    println!("near-workspaces: Proved that premature admin execution is rejected by 48h timelock!");

    // Verify proposal is still staged and unexecuted
    let staged_prop: Option<serde_json::Value> = contract
        .view("get_staged_proposal")
        .args_json(serde_json::json!({ "proposal_id": proposal_id }))
        .await?
        .json()?;
    assert!(staged_prop.is_some(), "Proposal must remain staged after rejected early execution");

    // Verify owner remains unchanged
    let current_owner: near_sdk::AccountId = contract
        .view("get_owner")
        .args_json(serde_json::json!({}))
        .await?
        .json()?;
    assert_eq!(&current_owner, owner.id());

    Ok(())
}

#[tokio::test]
async fn test_workspaces_multisig_dao_governance_cycle() -> Result<(), Box<dyn std::error::Error>> {
    use near_sdk::json_types::Base64VecU8;
    use near_workspaces::types::AccessKey;

    let worker = near_workspaces::sandbox().await?;
    let wasm = std::fs::read(WASM_PATH)?;
    let escrow_contract = worker.dev_deploy(&wasm).await?;

    // Deploy Multisig DAO Contract
    let multisig_wasm = std::fs::read("./multisig.wasm")?;
    let dao_account = worker.dev_create_account().await?;
    dao_account.deploy(&multisig_wasm).await?.into_result()?;

    // Init multisig with 2 confirmations required
    dao_account
        .call(dao_account.id(), "new")
        .args_json(serde_json::json!({
            "num_confirmations": 2
        }))
        .max_gas()
        .transact()
        .await?
        .into_result()?;

    // Generate 3 real member keypairs
    let member1_sk = near_workspaces::types::SecretKey::from_random(near_workspaces::types::KeyType::ED25519);
    let member2_sk = near_workspaces::types::SecretKey::from_random(near_workspaces::types::KeyType::ED25519);
    let member3_sk = near_workspaces::types::SecretKey::from_random(near_workspaces::types::KeyType::ED25519);

    let deployer_pk = dao_account.secret_key().public_key();

    // Add 3 member keys to the multisig account as function-call keys limited to
    // add_request, add_request_and_confirm, confirm, delete_request, and delete deployer key
    let member_methods = &["add_request", "add_request_and_confirm", "confirm", "delete_request"];
    let member_access = AccessKey::function_call_access(dao_account.id(), member_methods, None);
    let batch_res = dao_account
        .batch(dao_account.id())
        .add_key(member1_sk.public_key(), member_access.clone())
        .add_key(member2_sk.public_key(), member_access.clone())
        .add_key(member3_sk.public_key(), member_access)
        .delete_key(deployer_pk)
        .transact()
        .await?;
    assert!(batch_res.is_success(), "Batch add member keys must succeed");

    println!("near-workspaces: Multisig DAO initialized with 3 function-call member keys and 2 required confirmations. Deployer key deleted!");

    // Verify DAO has 3 function-call keys and 0 full-access keys
    let keys = dao_account.view_access_keys().await?;
    assert_eq!(keys.len(), 3, "DAO must have exactly 3 member access keys");
    for k in &keys {
        match &k.access_key.permission {
            near_workspaces::types::AccessKeyPermission::FunctionCall(fc) => {
                assert_eq!(&fc.receiver_id, dao_account.id().as_str());
                assert_eq!(
                    fc.method_names,
                    vec![
                        "add_request".to_string(),
                        "add_request_and_confirm".to_string(),
                        "confirm".to_string(),
                        "delete_request".to_string()
                    ]
                );
            }
            _ => panic!("Expected FunctionCall access key, found FullAccess"),
        }
    }

    // Verify 5-minute minimum enforcement at initialization (< 5min must fail)
    let short_init = escrow_contract
        .call("new")
        .args_json(serde_json::json!({
            "owner": dao_account.id(),
            "chain_id": "testnet",
            "config": null,
            "initial_tee_signer": null,
            "timelock_duration": 30_000_000_000u64 // 30 seconds
        }))
        .transact()
        .await?;
    assert!(short_init.is_failure(), "Contract initialization with timelock < 5min must fail");

    // Initialize Escrow with DAO as owner and 5-minute timelock (300_000_000_000 ns)
    let init_escrow = escrow_contract
        .call("new")
        .args_json(serde_json::json!({
            "owner": dao_account.id(),
            "chain_id": "testnet",
            "config": null,
            "initial_tee_signer": null,
            "timelock_duration": 300_000_000_000u64
        }))
        .max_gas()
        .transact()
        .await?;
    assert!(init_escrow.is_success(), "Escrow init with 5min timelock must succeed");

    let initial_owner: near_sdk::AccountId = escrow_contract
        .view("get_owner")
        .args_json(serde_json::json!({}))
        .await?
        .json()?;
    assert_eq!(&initial_owner, dao_account.id(), "Escrow owner must initially be DAO account");

    // Member signers acting on behalf of the DAO account
    let member1_account = near_workspaces::Account::from_secret_key(dao_account.id().clone(), member1_sk, &worker);
    let member2_account = near_workspaces::Account::from_secret_key(dao_account.id().clone(), member2_sk, &worker);

    // Prepare payload to propose UpdateConfig on escrow (NOT TransferOwnership)
    let new_config = conpi_escrow::types::Config {
        notice_period_duration: 172_800_000_000_000, // 48h notice
        min_slash_bps: 2_000,                        // 20%
        ..Default::default()
    };
    #[derive(serde::Serialize)]
    struct ProposeArgs {
        action: conpi_escrow::types::AdminAction,
    }
    let propose_args = serde_json::to_vec(&ProposeArgs {
        action: conpi_escrow::types::AdminAction::UpdateConfig { config: new_config },
    })?;
    let base64_args = Base64VecU8::from(propose_args);

    println!("near-workspaces: Member 1 submits MultiSig proposal for UpdateConfig on Escrow...");
    let add_req_res = member1_account
        .call(dao_account.id(), "add_request_and_confirm")
        .args_json(serde_json::json!({
            "request": {
                "receiver_id": escrow_contract.id(),
                "actions": [
                    {
                        "type": "FunctionCall",
                        "method_name": "propose_admin_action",
                        "args": base64_args,
                        "deposit": "0",
                        "gas": "50000000000000"
                    }
                ]
            }
        }))
        .max_gas()
        .transact()
        .await?;
    assert!(add_req_res.is_success());

    let request_id: u32 = add_req_res.json()?;
    println!("near-workspaces: Proposal created on Multisig with request_id = {}. 1/2 confirmations.", request_id);

    // Verify escrow does NOT have the proposal yet (only 1 confirmation so far)
    let pending_prop: Option<serde_json::Value> = escrow_contract
        .view("get_staged_proposal")
        .args_json(serde_json::json!({ "proposal_id": 1 }))
        .await?
        .json()?;
    assert!(pending_prop.is_none(), "Proposal must not be staged until quorum is reached");

    // Member 2 confirms the proposal
    println!("near-workspaces: Member 2 confirms request {}. Quorum reached (2/2) -> Multisig executes cross-contract call!", request_id);
    let confirm_res = member2_account
        .call(dao_account.id(), "confirm")
        .args_json(serde_json::json!({
            "request_id": request_id
        }))
        .max_gas()
        .transact()
        .await?;
    assert!(confirm_res.is_success());

    // Verify escrow now HAS the proposal staged (proposal_id: 1)!
    let staged_prop: Option<serde_json::Value> = escrow_contract
        .view("get_staged_proposal")
        .args_json(serde_json::json!({ "proposal_id": 1 }))
        .await?
        .json()?;
    assert!(staged_prop.is_some(), "Proposal #1 must be staged on Escrow contract!");
    println!("near-workspaces: Successfully verified Proposal #1 is staged on Escrow via Multisig DAO!");

    // Attempt immediate execution via multisig -> must fail due to 48h timelock delay
    let exec_args = serde_json::to_vec(&serde_json::json!({
        "proposal_id": 1,
        "code": null
    }))?;
    let exec_b64 = Base64VecU8::from(exec_args);

    let early_exec_req = member1_account
        .call(dao_account.id(), "add_request_and_confirm")
        .args_json(serde_json::json!({
            "request": {
                "receiver_id": escrow_contract.id(),
                "actions": [
                    {
                        "type": "FunctionCall",
                        "method_name": "execute_admin_action",
                        "args": exec_b64,
                        "deposit": "0",
                        "gas": "50000000000000"
                    }
                ]
            }
        }))
        .max_gas()
        .transact()
        .await?;
    assert!(early_exec_req.is_success());
    let early_req_id: u32 = early_exec_req.json()?;

    let early_confirm = member2_account
        .call(dao_account.id(), "confirm")
        .args_json(serde_json::json!({
            "request_id": early_req_id
        }))
        .max_gas()
        .transact()
        .await?;
    assert!(early_confirm.is_failure(), "Early execution must fail 48h timelock on Escrow!");
    println!("near-workspaces: Verified that premature multisig execution is rejected by Escrow timelock!");

    // Verify proposal remains staged and uncorrupted after rejected early execution
    let staged_after_early: Option<serde_json::Value> = escrow_contract
        .view("get_staged_proposal")
        .args_json(serde_json::json!({ "proposal_id": 1 }))
        .await?
        .json()?;
    assert!(staged_after_early.is_some(), "Proposal #1 must remain staged after rejected early execution");

    // CRITICAL: Verify Escrow owner MUST remain the DAO Multisig contract!
    let owner_after: near_sdk::AccountId = escrow_contract
        .view("get_owner")
        .args_json(serde_json::json!({}))
        .await?
        .json()?;
    assert_eq!(&owner_after, dao_account.id(), "Escrow owner MUST remain the DAO Multisig contract!");
    println!("near-workspaces: SUCCESS! Verified DAO Multisig remains the owner of Escrow!");

    Ok(())
}

#[tokio::test]
async fn test_workspaces_multisig_dao_upgrade_proposal_staged() -> Result<(), Box<dyn std::error::Error>> {
    use near_sdk::json_types::Base64VecU8;
    use near_workspaces::types::AccessKey;
    use sha2::{Digest, Sha256};

    let worker = near_workspaces::sandbox().await?;
    let wasm = std::fs::read(WASM_PATH)?;
    let escrow_contract = worker.dev_deploy(&wasm).await?;

    // Deploy Multisig DAO Contract
    let multisig_wasm = std::fs::read("./multisig.wasm")?;
    let dao_account = worker.dev_create_account().await?;
    dao_account.deploy(&multisig_wasm).await?.into_result()?;

    // Init multisig with 2 confirmations required
    dao_account
        .call(dao_account.id(), "new")
        .args_json(serde_json::json!({
            "num_confirmations": 2
        }))
        .max_gas()
        .transact()
        .await?
        .into_result()?;

    // Generate 3 real member keypairs
    let member1_sk = near_workspaces::types::SecretKey::from_random(near_workspaces::types::KeyType::ED25519);
    let member2_sk = near_workspaces::types::SecretKey::from_random(near_workspaces::types::KeyType::ED25519);
    let member3_sk = near_workspaces::types::SecretKey::from_random(near_workspaces::types::KeyType::ED25519);

    let deployer_pk = dao_account.secret_key().public_key();

    let member_methods = &["add_request", "add_request_and_confirm", "confirm", "delete_request"];
    let member_access = AccessKey::function_call_access(dao_account.id(), member_methods, None);
    dao_account
        .batch(dao_account.id())
        .add_key(member1_sk.public_key(), member_access.clone())
        .add_key(member2_sk.public_key(), member_access.clone())
        .add_key(member3_sk.public_key(), member_access)
        .delete_key(deployer_pk)
        .transact()
        .await?
        .into_result()?;

    // Initialize Escrow with DAO as owner and 5-minute timelock (300_000_000_000 ns)
    escrow_contract
        .call("new")
        .args_json(serde_json::json!({
            "owner": dao_account.id(),
            "chain_id": "testnet",
            "config": null,
            "initial_tee_signer": null,
            "timelock_duration": 300_000_000_000u64
        }))
        .max_gas()
        .transact()
        .await?
        .into_result()?;

    let member1_account = near_workspaces::Account::from_secret_key(dao_account.id().clone(), member1_sk, &worker);
    let member2_account = near_workspaces::Account::from_secret_key(dao_account.id().clone(), member2_sk, &worker);

    // Compute code hash of mock upgrade code
    let mock_upgrade_wasm = b"mock_verifiable_upgrade_wasm".to_vec();
    let mut hasher = Sha256::new();
    hasher.update(&mock_upgrade_wasm);
    let code_hash_bytes: [u8; 32] = hasher.finalize().into();

    #[derive(serde::Serialize)]
    struct ProposeArgs {
        action: conpi_escrow::types::AdminAction,
    }
    let propose_args = serde_json::to_vec(&ProposeArgs {
        action: conpi_escrow::types::AdminAction::Upgrade {
            code_hash: code_hash_bytes,
        },
    })?;
    let base64_args = Base64VecU8::from(propose_args);

    let add_req_res = member1_account
        .call(dao_account.id(), "add_request_and_confirm")
        .args_json(serde_json::json!({
            "request": {
                "receiver_id": escrow_contract.id(),
                "actions": [
                    {
                        "type": "FunctionCall",
                        "method_name": "propose_admin_action",
                        "args": base64_args,
                        "deposit": "0",
                        "gas": "50000000000000"
                    }
                ]
            }
        }))
        .max_gas()
        .transact()
        .await?;
    assert!(add_req_res.is_success());
    let req_id: u32 = add_req_res.json()?;

    // Quorum reached by Member 2 confirmation
    let confirm_res = member2_account
        .call(dao_account.id(), "confirm")
        .args_json(serde_json::json!({ "request_id": req_id }))
        .max_gas()
        .transact()
        .await?;
    assert!(confirm_res.is_success());

    // Verify Proposal #1 is staged with Upgrade action
    let staged_prop: Option<serde_json::Value> = escrow_contract
        .view("get_staged_proposal")
        .args_json(serde_json::json!({ "proposal_id": 1 }))
        .await?
        .json()?;
    assert!(staged_prop.is_some(), "Upgrade proposal must be staged on Escrow contract");
    let staged = staged_prop.unwrap();
    assert!(staged["action"].get("Upgrade").is_some(), "Staged action must be Upgrade");

    // Attempt early execution via multisig -> must fail due to 48h timelock
    let exec_args = serde_json::to_vec(&serde_json::json!({
        "proposal_id": 1,
        "code": mock_upgrade_wasm
    }))?;
    let exec_b64 = Base64VecU8::from(exec_args);

    let early_exec_req = member1_account
        .call(dao_account.id(), "add_request_and_confirm")
        .args_json(serde_json::json!({
            "request": {
                "receiver_id": escrow_contract.id(),
                "actions": [
                    {
                        "type": "FunctionCall",
                        "method_name": "execute_admin_action",
                        "args": exec_b64,
                        "deposit": "0",
                        "gas": "250000000000000"
                    }
                ]
            }
        }))
        .max_gas()
        .transact()
        .await?;
    assert!(early_exec_req.is_success());
    let early_req_id: u32 = early_exec_req.json()?;

    let early_confirm = member2_account
        .call(dao_account.id(), "confirm")
        .args_json(serde_json::json!({ "request_id": early_req_id }))
        .max_gas()
        .transact()
        .await?;
    assert!(early_confirm.is_failure(), "Early execution of upgrade must fail 48h timelock");
    println!("near-workspaces: Verified upgrade proposal staged and premature execution rejected by timelock!");

    Ok(())
}

#[tokio::test]
async fn test_workspaces_multisig_dao_upgrade_execution_with_timelock_and_migrate() -> Result<(), Box<dyn std::error::Error>> {
    use near_sdk::json_types::Base64VecU8;
    use near_workspaces::types::AccessKey;
    use sha2::{Digest, Sha256};

    let worker = near_workspaces::sandbox().await?;

    let wasm_p1 = std::path::Path::new("res/conpi_escrow.wasm");
    let wasm_p2 = std::path::Path::new("contracts/res/conpi_escrow.wasm");
    let wasm_p3 = std::path::Path::new("./target/near/conpi_escrow.wasm");
    let wasm_bytes = if wasm_p1.exists() {
        std::fs::read(wasm_p1)?
    } else if wasm_p2.exists() {
        std::fs::read(wasm_p2)?
    } else {
        std::fs::read(wasm_p3)?
    };
    println!("Loaded real WASM bytes: {} bytes", wasm_bytes.len());

    let escrow_contract = worker.dev_deploy(&wasm_bytes).await?;

    // Deploy Multisig DAO Contract
    let multisig_wasm = std::fs::read("./multisig.wasm")
        .or_else(|_| std::fs::read("contracts/multisig.wasm"))?;
    let dao_account = worker.dev_create_account().await?;
    dao_account.deploy(&multisig_wasm).await?.into_result()?;

    // Init multisig with 2 confirmations required
    dao_account
        .call(dao_account.id(), "new")
        .args_json(serde_json::json!({
            "num_confirmations": 2
        }))
        .max_gas()
        .transact()
        .await?
        .into_result()?;

    // Generate 3 real member keypairs
    let member1_sk = near_workspaces::types::SecretKey::from_random(near_workspaces::types::KeyType::ED25519);
    let member2_sk = near_workspaces::types::SecretKey::from_random(near_workspaces::types::KeyType::ED25519);
    let member3_sk = near_workspaces::types::SecretKey::from_random(near_workspaces::types::KeyType::ED25519);

    let deployer_pk = dao_account.secret_key().public_key();

    let member_methods = &["add_request", "add_request_and_confirm", "confirm", "delete_request"];
    let member_access = AccessKey::function_call_access(dao_account.id(), member_methods, None);
    dao_account
        .batch(dao_account.id())
        .add_key(member1_sk.public_key(), member_access.clone())
        .add_key(member2_sk.public_key(), member_access.clone())
        .add_key(member3_sk.public_key(), member_access)
        .delete_key(deployer_pk)
        .transact()
        .await?
        .into_result()?;

    // Generate TEE signer keypair for initial escrow state
    let (tee_sk, tee_pk) = generate_tee_keypair();

    // Initialize Escrow with DAO as owner, 5-minute timelock (300_000_000_000 ns), and initial TEE signer
    escrow_contract
        .call("new")
        .args_json(serde_json::json!({
            "owner": dao_account.id(),
            "chain_id": "testnet",
            "config": null,
            "initial_tee_signer": [tee_pk.clone(), "intel_sgx_mrenclave_v1"],
            "timelock_duration": 300_000_000_000u64
        }))
        .max_gas()
        .transact()
        .await?
        .into_result()?;

    let member1_account = near_workspaces::Account::from_secret_key(dao_account.id().clone(), member1_sk, &worker);
    let member2_account = near_workspaces::Account::from_secret_key(dao_account.id().clone(), member2_sk, &worker);

    // 1. Populate real pre-upgrade state on Escrow:
    // Create buyer and seller accounts
    let buyer = worker.dev_create_account().await?;
    let seller = worker.dev_create_account().await?;

    let price = NearToken::from_near(3);
    let credit_amount = NearToken::from_near(5);
    let buyer_collateral = NearToken::from_near(1);
    let seller_collateral = NearToken::from_near(1);

    let create_res = buyer
        .call(escrow_contract.id(), "create_deal")
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
                "slash_bps_revoke": 8000,
                "slash_bps_buyer_breach": 8000
            }
        }))
        .deposit(NearToken::from_millinear(50))
        .transact()
        .await?;
    assert!(create_res.is_success());
    let deal_id: u64 = create_res.json()?;
    assert_eq!(deal_id, 1);

    // Retrieve terms hash and seller accepts
    let deal_view: serde_json::Value = escrow_contract
        .view("get_deal")
        .args_json(serde_json::json!({ "deal_id": deal_id }))
        .await?
        .json()?;
    let terms_hash_raw: Vec<u8> = serde_json::from_value(deal_view["terms_hash"].clone())?;
    let mut terms_hash = [0u8; 32];
    terms_hash.copy_from_slice(&terms_hash_raw);

    let accept_res = seller
        .call(escrow_contract.id(), "accept_deal")
        .args_json(serde_json::json!({
            "deal_id": deal_id,
            "expected_hash": terms_hash
        }))
        .transact()
        .await?;
    assert!(accept_res.is_success());

    // TEE attestation
    let terms_sig = sign_terms_hash(&tee_sk, escrow_contract.id().as_str(), deal_id, &terms_hash);
    let reg_terms_res = escrow_contract
        .call("register_terms_hash")
        .args_json(serde_json::json!({
            "deal_id": deal_id,
            "terms_hash": terms_hash,
            "sig": terms_sig
        }))
        .transact()
        .await?;
    assert!(reg_terms_res.is_success());

    // Buyer deposits 4 NEAR (3 price + 1 collateral)
    let buyer_dep_res = buyer
        .call(escrow_contract.id(), "deposit")
        .args_json(serde_json::json!({ "deal_id": deal_id }))
        .deposit(NearToken::from_near(4))
        .transact()
        .await?;
    assert!(buyer_dep_res.is_success());

    // Seller deposits 1 NEAR collateral
    let seller_dep_res = seller
        .call(escrow_contract.id(), "deposit")
        .args_json(serde_json::json!({ "deal_id": deal_id }))
        .deposit(NearToken::from_near(1))
        .transact()
        .await?;
    assert!(seller_dep_res.is_success());

    // Verify Deal state is FUNDED on-chain
    let deal_view_funded: serde_json::Value = escrow_contract
        .view("get_deal")
        .args_json(serde_json::json!({ "deal_id": deal_id }))
        .await?
        .json()?;
    assert_eq!(deal_view_funded["status"].as_str().unwrap(), "Funded");
    println!("near-workspaces: Pre-upgrade state established: Deal #1 is FUNDED with 4 NEAR buyer deposit + 1 NEAR seller deposit");

    // 2. Load genuinely distinct V2 WASM bytecode
    let v2_p1 = std::path::Path::new("res/conpi_escrow_v2.wasm");
    let v2_p2 = std::path::Path::new("contracts/res/conpi_escrow_v2.wasm");
    let v2_p3 = std::path::Path::new("./target/wasm32-unknown-unknown/release/conpi_escrow_v2.wasm");
    let v2_p4 = std::path::Path::new("./test_v2/target/wasm32-unknown-unknown/release/conpi_escrow_v2.wasm");
    let v2_bytes = if v2_p1.exists() {
        std::fs::read(v2_p1)?
    } else if v2_p2.exists() {
        std::fs::read(v2_p2)?
    } else if v2_p3.exists() {
        std::fs::read(v2_p3)?
    } else {
        std::fs::read(v2_p4)?
    };
    println!("Loaded distinct V2 WASM: {} bytes", v2_bytes.len());

    let mut hasher = Sha256::new();
    hasher.update(&v2_bytes);
    let v2_code_hash_bytes: [u8; 32] = hasher.finalize().into();

    #[derive(serde::Serialize)]
    struct ProposeArgs {
        action: conpi_escrow::types::AdminAction,
    }
    let propose_args = serde_json::to_vec(&ProposeArgs {
        action: conpi_escrow::types::AdminAction::Upgrade {
            code_hash: v2_code_hash_bytes,
        },
    })?;
    let base64_args = Base64VecU8::from(propose_args);

    // Member 1 proposes upgrade to V2
    let add_req_res = member1_account
        .call(dao_account.id(), "add_request_and_confirm")
        .args_json(serde_json::json!({
            "request": {
                "receiver_id": escrow_contract.id(),
                "actions": [
                    {
                        "type": "FunctionCall",
                        "method_name": "propose_admin_action",
                        "args": base64_args,
                        "deposit": "0",
                        "gas": "50000000000000"
                    }
                ]
            }
        }))
        .max_gas()
        .transact()
        .await?
        .into_result()?;
    let req_id: u32 = add_req_res.json()?;

    // Member 2 confirms upgrade proposal -> Quorum reached (2/2)
    member2_account
        .call(dao_account.id(), "confirm")
        .args_json(serde_json::json!({ "request_id": req_id }))
        .max_gas()
        .transact()
        .await?
        .into_result()?;

    // Verify Proposal #1 is staged on Escrow
    let staged_prop: Option<serde_json::Value> = escrow_contract
        .view("get_staged_proposal")
        .args_json(serde_json::json!({ "proposal_id": 1 }))
        .await?
        .json()?;
    assert!(staged_prop.is_some(), "Upgrade proposal must be staged on Escrow");
    let ready_at = staged_prop.as_ref().unwrap()["ready_at"].as_u64().unwrap();
    println!("near-workspaces: Upgrade proposal staged behind 5min timelock (ready_at = {})", ready_at);

    // 3. Early execution must fail timelock enforcement
    let exec_args = serde_json::to_vec(&serde_json::json!({
        "proposal_id": 1,
        "code": v2_bytes
    }))?;
    let exec_b64 = Base64VecU8::from(exec_args);

    let early_exec_res = member1_account
        .call(dao_account.id(), "add_request_and_confirm")
        .args_json(serde_json::json!({
            "request": {
                "receiver_id": escrow_contract.id(),
                "actions": [
                    {
                        "type": "FunctionCall",
                        "method_name": "execute_admin_action",
                        "args": exec_b64.clone(),
                        "deposit": "0",
                        "gas": "250000000000000"
                    }
                ]
            }
        }))
        .max_gas()
        .transact()
        .await?
        .into_result()?;
    let early_req_id: u32 = early_exec_res.json()?;

    let early_confirm_res = member2_account
        .call(dao_account.id(), "confirm")
        .args_json(serde_json::json!({ "request_id": early_req_id }))
        .max_gas()
        .transact()
        .await?;
    assert!(early_confirm_res.is_failure(), "Early upgrade execution before 5min timelock must fail!");
    println!("near-workspaces: Verified premature upgrade execution rejected by 5-minute timelock");

    // 4. Natural timelock fast-forward (NO state patching!)
    println!("near-workspaces: Naturally fast-forwarding sandbox past 5-minute timelock...");
    worker.fast_forward(1200).await?;

    let current_block = worker.view_block().await?;
    let current_ts = current_block.header().timestamp_nanosec();
    assert!(
        current_ts >= ready_at,
        "Current block timestamp ({}) must be >= ready_at ({}) after fast_forward",
        current_ts, ready_at
    );
    println!("near-workspaces: Timelock naturally matured: current_ts ({}) >= ready_at ({}) with NO state patching!", current_ts, ready_at);

    // 5. Mature execution via Multisig DAO
    println!("near-workspaces: Executing mature upgrade proposal through Multisig DAO with real V2 WASM...");
    let mature_exec_res = member1_account
        .call(dao_account.id(), "add_request_and_confirm")
        .args_json(serde_json::json!({
            "request": {
                "receiver_id": escrow_contract.id(),
                "actions": [
                    {
                        "type": "FunctionCall",
                        "method_name": "execute_admin_action",
                        "args": exec_b64,
                        "deposit": "0",
                        "gas": "250000000000000"
                    }
                ]
            }
        }))
        .max_gas()
        .transact()
        .await?
        .into_result()?;
    let mature_req_id: u32 = mature_exec_res.json()?;

    let confirm_res = member2_account
        .call(dao_account.id(), "confirm")
        .args_json(serde_json::json!({ "request_id": mature_req_id }))
        .max_gas()
        .transact()
        .await?;
    assert!(confirm_res.is_success(), "Upgrade execution confirmation must succeed: {:?}", confirm_res);
    println!("near-workspaces: Upgrade transaction confirmed and executed successfully!");

    // 6. Assertions on upgraded V2 state:
    // (a) State version is bumped to 2
    let version_after: u32 = escrow_contract
        .view("get_state_version")
        .args_json(serde_json::json!({}))
        .await?
        .json()?;
    assert_eq!(version_after, 2, "State version must be bumped to 2 after V2 migration");

    // (b) New V2 feature method is live and callable
    let v2_feature: String = escrow_contract
        .view("get_v2_feature")
        .args_json(serde_json::json!({}))
        .await?
        .json()?;
    assert_eq!(v2_feature, "conpi-v2-active", "V2 feature method must return expected message");

    // (c) Owner remains the Multisig DAO contract
    let owner_after: near_sdk::AccountId = escrow_contract
        .view("get_owner")
        .args_json(serde_json::json!({}))
        .await?
        .json()?;
    assert_eq!(&owner_after, dao_account.id(), "Owner must remain DAO after upgrade");

    // (d) Pre-upgrade deal #1 survived migration with all state intact
    let deal_after: conpi_escrow::types::Deal = escrow_contract
        .view("get_deal")
        .args_json(serde_json::json!({ "deal_id": deal_id }))
        .await?
        .json()?;
    println!("near-workspaces: Verified pre-upgrade deal #1 survived: {:?}", deal_after);
    assert_eq!(deal_after.id, deal_id);
    assert_eq!(&deal_after.buyer, buyer.id());
    assert_eq!(&deal_after.seller, seller.id());
    assert_eq!(deal_after.status, conpi_escrow::types::DealStatus::Funded);
    assert_eq!(deal_after.buyer_deposited, NearToken::from_near(4).as_yoctonear());
    assert_eq!(deal_after.seller_deposited, NearToken::from_near(1).as_yoctonear());

    // (e) Config survived migration
    let config_after: serde_json::Value = escrow_contract
        .view("get_config")
        .args_json(serde_json::json!({}))
        .await?
        .json()?;
    assert!(config_after.get("min_slash_bps").is_some());

    // (f) Proposal #1 is consumed
    let staged_after: Option<serde_json::Value> = escrow_contract
        .view("get_staged_proposal")
        .args_json(serde_json::json!({ "proposal_id": 1 }))
        .await?
        .json()?;
    assert!(staged_after.is_none(), "Staged proposal #1 must be consumed after successful execution");

    println!("near-workspaces: Full upgrade and migrate verified! Deals, balances, config, owner survived migration with NO state patching!");
    Ok(())
}


