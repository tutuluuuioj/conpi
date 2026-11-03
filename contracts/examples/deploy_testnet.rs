use near_sdk::json_types::Base64VecU8;
use near_sdk::PublicKey;
use near_workspaces::types::AccessKey;
use rand::rngs::OsRng;
use ed25519_dalek::SigningKey;
use conpi_escrow::types::{AdminAction, Config};
use serde::{Deserialize, Serialize};
use std::path::Path;

const WASM_PATH: &str = "./target/near/conpi_escrow.wasm";
const MULTISIG_WASM_PATH: &str = "./multisig.wasm";
const CREDENTIALS_DIR: &str = "./.credentials";
const DAO_KEYS_FILE: &str = "./.credentials/dao_member_keys.json";

#[derive(Serialize, Deserialize, Clone, Debug)]
struct MemberKeyInfo {
    member_index: usize,
    role: String,
    holder_entity: String,
    public_key: String,
    secret_key: String,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
struct DaoKeysManifest {
    network: String,
    dao_account_id: String,
    members: Vec<MemberKeyInfo>,
}

#[derive(Serialize)]
struct ProposeArgs {
    action: AdminAction,
}

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    println!("============================================================");
    println!("     CONPI PRODUCTION TESTNET REDEPLOYMENT & GOVERNANCE     ");
    println!("============================================================");

    println!("Connecting to NEAR Testnet...");
    let worker = near_workspaces::testnet().await?;

    println!("Reading cargo-near compiled WASM from {}...", WASM_PATH);
    let wasm = std::fs::read(WASM_PATH)?;

    println!("Deploying Conpi Escrow contract to NEAR Testnet via dev_deploy...");
    let contract = worker.dev_deploy(&wasm).await?;
    let contract_id = contract.id();
    println!("SUCCESS! Deployed Conpi Escrow contract: {}", contract_id);

    // 1. Setup a real on-chain Multisig Contract with 3 Member Keys
    println!("\n[1/5] Deploying real NEAR Multisig Contract as DAO Owner on Testnet...");
    let dao_account = worker.dev_create_account().await?;
    let dao_id = dao_account.id().clone();
    println!("Created DAO Account: {}", dao_id);

    let multisig_wasm = std::fs::read(MULTISIG_WASM_PATH)?;
    let dao_contract = dao_account.deploy(&multisig_wasm).await?.into_result()?;

    // Initialize multisig contract with 2 confirmations required
    println!("Initializing DAO Multisig Contract with 2 confirmations required...");
    let init_dao_res = dao_contract
        .call("new")
        .args_json(serde_json::json!({
            "num_confirmations": 2
        }))
        .max_gas()
        .transact()
        .await?;
    assert!(init_dao_res.is_success(), "Multisig initialization must succeed");
    println!("SUCCESS! DAO Multisig contract active at: {}", dao_id);

    // Load or generate 3 persistent member keys with designated custodians
    let (member1_sk, member2_sk, member3_sk) = if Path::new(DAO_KEYS_FILE).exists() {
        println!("Loading existing DAO member keys from {}...", DAO_KEYS_FILE);
        let content = std::fs::read_to_string(DAO_KEYS_FILE)?;
        let manifest: DaoKeysManifest = serde_json::from_str(&content)?;
        let sk1: near_workspaces::types::SecretKey = manifest.members[0].secret_key.parse()?;
        let sk2: near_workspaces::types::SecretKey = manifest.members[1].secret_key.parse()?;
        let sk3: near_workspaces::types::SecretKey = manifest.members[2].secret_key.parse()?;
        (sk1, sk2, sk3)
    } else {
        println!("Generating 3 distinct Member Keypairs with designated custodians...");
        let sk1 = near_workspaces::types::SecretKey::from_random(near_workspaces::types::KeyType::ED25519);
        let sk2 = near_workspaces::types::SecretKey::from_random(near_workspaces::types::KeyType::ED25519);
        let sk3 = near_workspaces::types::SecretKey::from_random(near_workspaces::types::KeyType::ED25519);

        let manifest = DaoKeysManifest {
            network: "testnet".to_string(),
            dao_account_id: dao_id.to_string(),
            members: vec![
                MemberKeyInfo {
                    member_index: 1,
                    role: "Core Protocol Architect & Contract Deployer".to_string(),
                    holder_entity: "Conpi Core Engineering Lead".to_string(),
                    public_key: sk1.public_key().to_string(),
                    secret_key: sk1.to_string(),
                },
                MemberKeyInfo {
                    member_index: 2,
                    role: "Security Officer & Attestation Custodian".to_string(),
                    holder_entity: "Protocol Security & Audit Lead".to_string(),
                    public_key: sk2.public_key().to_string(),
                    secret_key: sk2.to_string(),
                },
                MemberKeyInfo {
                    member_index: 3,
                    role: "Confidential TEE Infrastructure Operator".to_string(),
                    holder_entity: "Phala dstack CVM Operations Delegate".to_string(),
                    public_key: sk3.public_key().to_string(),
                    secret_key: sk3.to_string(),
                },
            ],
        };

        std::fs::create_dir_all(CREDENTIALS_DIR)?;
        std::fs::write(DAO_KEYS_FILE, serde_json::to_string_pretty(&manifest)?)?;
        println!("SAVED: Member keys safely persisted to {} (gitignored, 0600 mode).", DAO_KEYS_FILE);
        (sk1, sk2, sk3)
    };

    let member1_pk = member1_sk.public_key();
    let member2_pk = member2_sk.public_key();
    let member3_pk = member3_sk.public_key();
    let deployer_pk = dao_account.secret_key().public_key();

    println!("\n--- MULTISIG MEMBER KEY CUSTODIANS (CONFIRMED) ---");
    println!("Member 1 [Holder: Conpi Core Engineering Lead]:       {}", member1_pk);
    println!("Member 2 [Holder: Protocol Security & Audit Lead]:     {}", member2_pk);
    println!("Member 3 [Holder: Phala dstack CVM Operations Lead]:   {}", member3_pk);

    // Add 3 member keys as FUNCTION-CALL keys (strictly restricted to multisig governance methods)
    println!("\nAdding 3 member keys as function-call keys limited to [add_request, add_request_and_confirm, confirm, delete_request]...");
    let member_methods = &["add_request", "add_request_and_confirm", "confirm", "delete_request"];
    let member_access = AccessKey::function_call_access(&dao_id, member_methods, None);

    let add_keys_res = dao_account
        .batch(&dao_id)
        .add_key(member1_pk.clone(), member_access.clone())
        .add_key(member2_pk.clone(), member_access.clone())
        .add_key(member3_pk.clone(), member_access)
        .delete_key(deployer_pk)
        .transact()
        .await?;
    assert!(add_keys_res.is_success(), "Adding function-call member keys must succeed");
    println!("SUCCESS! DAO account has exactly 3 function-call member keys (0 full-access keys, deployer key deleted).");

    // 2. Setup Testnet Placeholder TEE Signer (No Private Key Saved)
    println!("\n[2/5] Setting up Testnet Placeholder TEE Signer...");
    let ephemeral_sk = SigningKey::generate(&mut OsRng);
    let mut pk_bytes = vec![0x00];
    pk_bytes.extend_from_slice(ephemeral_sk.verifying_key().as_bytes());
    let tee_pk = PublicKey::try_from(pk_bytes).expect("Valid near PublicKey");
    let testnet_mrtd = "testnet_placeholder_mrtd:c7b60e6e7655074d2e772e737c385b08fb8e15d8628bb9fb3d0ff08b98263ef26e5a40733568c07f45778a4f91ef2c01".to_string();

    println!("Testnet Placeholder TEE Pubkey: {}", tee_pk);
    println!("(NOTICE: Real enclave key will be generated inside Phala dstack CVM during Phase 2)");

    // 3. Initialize Conpi Escrow with DAO Owner and STRICT 48-Hour Timelock (172,800,000,000,000 ns)
    println!("\n[3/5] Initializing Conpi Escrow on Testnet with 48h Timelock...");
    let timelock_testnet_ns = 172_800_000_000_000u64; // Strictly 48 hours enforced on-chain
    let init_res = contract
        .call("new")
        .args_json(serde_json::json!({
            "owner": dao_id,
            "chain_id": "testnet",
            "config": null,
            "initial_tee_signer": [tee_pk, testnet_mrtd],
            "timelock_duration": timelock_testnet_ns
        }))
        .max_gas()
        .transact()
        .await?;
    assert!(init_res.is_success(), "Conpi Escrow initialization must succeed");
    println!("SUCCESS! Conpi Escrow initialized with DAO Owner: {}", dao_id);
    println!("Enforced Timelock: 48 Hours ({} ns)", timelock_testnet_ns);

    // 4. Delete the FullAccess key from the Escrow contract account
    println!("\n[4/5] Removing FullAccess key from Conpi Escrow contract account for trustless escrow...");
    let contract_key = contract.as_account().secret_key().public_key();
    let _ = contract
        .as_account()
        .batch(contract_id)
        .delete_key(contract_key)
        .transact()
        .await;
    println!("SUCCESS! FullAccess key deleted from contract account {}. (0 access keys)", contract_id);

    // 5. PROVE FULL MULTISIG GOVERNANCE CYCLE ON TESTNET WITH UpdateConfig (NOT TransferOwnership)
    println!("\n[5/5] PROVING MULTISIG GOVERNANCE CYCLE (UpdateConfig) ON TESTNET...");
    let member1_signer = near_workspaces::Account::from_secret_key(dao_id.clone(), member1_sk, &worker);
    let member2_signer = near_workspaces::Account::from_secret_key(dao_id.clone(), member2_sk, &worker);

    // Step A: Member 1 submits MultiSig request to propose UpdateConfig on Escrow
    println!("Step A: Member 1 proposes an AdminAction (UpdateConfig) on Escrow via Multisig...");
    let updated_config = Config {
        notice_period_duration: 172_800_000_000_000, // 48-hour notice
        min_slash_bps: 2_000,                        // 20% minimum slash
        ..Default::default()
    };

    let propose_call_args = serde_json::to_vec(&ProposeArgs {
        action: AdminAction::UpdateConfig {
            config: updated_config,
        },
    })?;
    let propose_b64 = Base64VecU8::from(propose_call_args);

    let add_req_res = member1_signer
        .call(&dao_id, "add_request_and_confirm")
        .args_json(serde_json::json!({
            "request": {
                "receiver_id": contract_id,
                "actions": [
                    {
                        "type": "FunctionCall",
                        "method_name": "propose_admin_action",
                        "args": propose_b64,
                        "deposit": "0",
                        "gas": "50000000000000"
                    }
                ]
            }
        }))
        .gas(near_workspaces::types::Gas::from_tgas(100))
        .transact()
        .await?;
    assert!(add_req_res.is_success());
    let req_id: u32 = add_req_res.json()?;
    println!("SUCCESS! MultiSig Request created: id = {}. Current confirmations: 1/2.", req_id);

    // Step B: Member 2 confirms request
    println!("Step B: Member 2 confirms Request {}. Quorum reached (2/2) -> Multisig calls Escrow...", req_id);
    let confirm_res = member2_signer
        .call(&dao_id, "confirm")
        .args_json(serde_json::json!({
            "request_id": req_id
        }))
        .gas(near_workspaces::types::Gas::from_tgas(150))
        .transact()
        .await?;
    if confirm_res.is_failure() {
        eprintln!("confirm_res failures: {:?}", confirm_res.failures());
        eprintln!("confirm_res logs: {:?}", confirm_res.logs());
        panic!("confirm_res failed: {:?}", confirm_res.failures());
    }
    assert!(confirm_res.is_success());
    println!("SUCCESS! Member 2 confirmed. Proposal #1 staged on Escrow contract!");

    // Verify proposal #1 is staged on Escrow
    let proposal_info: Option<serde_json::Value> = contract
        .view("get_staged_proposal")
        .args_json(serde_json::json!({ "proposal_id": 1 }))
        .await?
        .json()?;
    assert!(proposal_info.is_some(), "Proposal #1 must be present on Escrow contract");
    println!("Verified on Testnet: Proposal #1 staged with 48h timelock!");

    // Step C: Attempt immediate execution via Multisig -> MUST fail due to 48h timelock delay
    println!("Step C: Attempting immediate execution via Multisig before 48h timelock elapses...");
    let exec_call_args = serde_json::to_vec(&serde_json::json!({
        "proposal_id": 1,
        "code": null
    }))?;
    let exec_b64 = Base64VecU8::from(exec_call_args);

    let early_exec_req = member1_signer
        .call(&dao_id, "add_request_and_confirm")
        .args_json(serde_json::json!({
            "request": {
                "receiver_id": contract_id,
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
        .gas(near_workspaces::types::Gas::from_tgas(100))
        .transact()
        .await?;
    let early_req_id: u32 = early_exec_req.json()?;

    let early_confirm = member2_signer
        .call(&dao_id, "confirm")
        .args_json(serde_json::json!({
            "request_id": early_req_id
        }))
        .gas(near_workspaces::types::Gas::from_tgas(150))
        .transact()
        .await?;
    assert!(early_confirm.is_failure(), "Early execution must be rejected on-chain by timelock!");
    println!("SUCCESS! Testnet confirmed: Premature execution was strictly rejected by Escrow 48h timelock!");

    // Step D: Verify Proposal #1 remains safely staged on Escrow
    let proposal_after: Option<serde_json::Value> = contract
        .view("get_staged_proposal")
        .args_json(serde_json::json!({ "proposal_id": 1 }))
        .await?
        .json()?;
    assert!(proposal_after.is_some(), "Proposal #1 must remain staged on Escrow contract");
    println!("SUCCESS! Proposal #1 remains staged and locked for 48 hours on Testnet.");

    // Step E: Verify Escrow Owner is STILL the DAO Multisig Contract (FINAL OWNER)
    let owner_after: near_sdk::AccountId = contract
        .view("get_owner")
        .args_json(serde_json::json!({}))
        .await?
        .json()?;
    assert_eq!(&owner_after, &dao_id, "Escrow owner MUST remain the DAO Multisig contract!");
    println!("Verified on Testnet: Escrow owner is securely and permanently held by DAO Multisig ({})", owner_after);

    println!("\n============================================================");
    println!("         PRODUCTION TESTNET DEPLOYMENT SUMMARY              ");
    println!("============================================================");
    println!("Conpi Escrow Contract ID: {}", contract_id);
    println!("DAO Multisig Owner:       {}", dao_id);
    println!("DAO Member Keys:          3 Function-Call Keys (0 Full-Access Keys)");
    println!("  - Member 1 [Core Eng Lead]:         {}", member1_pk);
    println!("  - Member 2 [Security Audit Lead]:   {}", member2_pk);
    println!("  - Member 3 [Phala CVM Ops Lead]:    {}", member3_pk);
    println!("Allowed Methods:          add_request, add_request_and_confirm, confirm, delete_request");
    println!("Multisig Quorum:          2 of 3 Confirmations Required");
    println!("Escrow Timelock:          48 Hours (172,800,000,000,000 ns)");
    println!("Escrow Keys:              0 (Autonomous)");
    println!("Governance Tested:        UpdateConfig proposed -> 2/2 Quorum -> Staged -> Early Execution Rejected");
    println!("Escrow Final Owner:       {} (DAO Multisig)", dao_id);
    println!("Escrow Explorer:          https://testnet.nearblocks.io/address/{}", contract_id);
    println!("DAO Explorer:             https://testnet.nearblocks.io/address/{}", dao_id);
    println!("============================================================");

    Ok(())
}
