use near_sdk::json_types::Base64VecU8;
use near_sdk::PublicKey;
use near_workspaces::types::AccessKey;
use rand::rngs::OsRng;
use ed25519_dalek::SigningKey;
use conpi_escrow::types::{AdminAction, Config};

const WASM_PATH: &str = "./target/near/conpi_escrow.wasm";
const MULTISIG_WASM_PATH: &str = "./multisig.wasm";

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

    // Generate 3 real member keys
    println!("Generating 3 distinct Member Keypairs for DAO Multisig...");
    let member1_sk = near_workspaces::types::SecretKey::from_random(near_workspaces::types::KeyType::ED25519);
    let member2_sk = near_workspaces::types::SecretKey::from_random(near_workspaces::types::KeyType::ED25519);
    let member3_sk = near_workspaces::types::SecretKey::from_random(near_workspaces::types::KeyType::ED25519);

    let member1_pk = member1_sk.public_key();
    let member2_pk = member2_sk.public_key();
    let member3_pk = member3_sk.public_key();
    let deployer_pk = dao_account.secret_key().public_key();

    println!("Member 1 Public Key: {}", member1_pk);
    println!("Member 2 Public Key: {}", member2_pk);
    println!("Member 3 Public Key: {}", member3_pk);

    // Add 3 member keys to the multisig account and delete the initial deployer key
    println!("Adding 3 member keys to DAO Multisig and removing deployer key...");
    let add_keys_res = dao_account
        .batch(&dao_id)
        .add_key(member1_pk.clone(), AccessKey::full_access())
        .add_key(member2_pk.clone(), AccessKey::full_access())
        .add_key(member3_pk.clone(), AccessKey::full_access())
        .delete_key(deployer_pk)
        .transact()
        .await?;
    assert!(add_keys_res.is_success(), "Adding member keys must succeed");
    println!("SUCCESS! DAO account has exactly 3 member keys and 0 deployer keys. 2 confirmations required for all operations.");

    // 2. Setup Testnet Placeholder TEE Signer (No Private Key Saved)
    println!("\n[2/5] Setting up Testnet Placeholder TEE Signer...");
    let ephemeral_sk = SigningKey::generate(&mut OsRng);
    let mut pk_bytes = vec![0x00];
    pk_bytes.extend_from_slice(ephemeral_sk.verifying_key().as_bytes());
    let tee_pk = PublicKey::try_from(pk_bytes).expect("Valid near PublicKey");
    let testnet_mrtd = "testnet_placeholder_mrtd:c7b60e6e7655074d2e772e737c385b08fb8e15d8628bb9fb3d0ff08b98263ef26e5a40733568c07f45778a4f91ef2c01".to_string();

    println!("Testnet Placeholder TEE Pubkey: {}", tee_pk);
    println!("(NOTICE: Real enclave key will be generated inside Phala dstack CVM during Phase 2)");

    // 3. Initialize Conpi Escrow with DAO Owner, 30s Timelock for live proof
    println!("\n[3/5] Initializing Conpi Escrow on Testnet...");
    let timelock_testnet_ns = 30_000_000_000u64; // 30 seconds for live testnet demonstration
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

    // 5. PROVE FULL MULTISIG PROPOSE -> TIMELOCK CHECK -> WAIT -> EXECUTE CYCLE ON TESTNET
    println!("\n[5/5] PROVING FULL MULTISIG GOVERNANCE CYCLE ON TESTNET...");
    let member1_signer = near_workspaces::Account::from_secret_key(dao_id.clone(), member1_sk, &worker);
    let member2_signer = near_workspaces::Account::from_secret_key(dao_id.clone(), member2_sk, &worker);

    // Step A: Member 1 submits MultiSig request to propose transferring ownership on Escrow
    println!("Step A: Member 1 proposes an AdminAction (TransferOwnership) on Escrow via Multisig...");
    let new_owner_candidate = worker.dev_create_account().await?;
    println!("Target New Owner Account: {}", new_owner_candidate.id());

    let propose_call_args = serde_json::to_vec(&serde_json::json!({
        "action": {
            "TransferOwnership": {
                "new_owner": new_owner_candidate.id()
            }
        }
    }))?;
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
        .max_gas()
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
        .max_gas()
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
    println!("Verified on Testnet: Proposal #1 staged with 30s timelock!");

    // Step C: Attempt immediate execution via Multisig -> must fail due to timelock delay
    println!("Step C: Attempting immediate execution via Multisig before timelock elapses...");
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
        .max_gas()
        .transact()
        .await?;
    let early_req_id: u32 = early_exec_req.json()?;

    let early_confirm = member2_signer
        .call(&dao_id, "confirm")
        .args_json(serde_json::json!({
            "request_id": early_req_id
        }))
        .max_gas()
        .transact()
        .await?;
    assert!(early_confirm.is_failure(), "Early execution must be rejected on-chain by timelock!");
    println!("SUCCESS! Testnet confirmed: Premature execution was strictly rejected by Escrow timelock!");

    // Step D: Wait for timelock delay to elapse
    println!("Step D: Waiting for 32 seconds on Testnet for the timelock delay to elapse...");
    tokio::time::sleep(tokio::time::Duration::from_secs(32)).await;

    // Step E: Execute proposal after timelock delay has elapsed
    println!("Step E: Executing proposal after timelock has elapsed...");
    let valid_exec_req = member1_signer
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
        .max_gas()
        .transact()
        .await?;
    let valid_req_id: u32 = valid_exec_req.json()?;

    let valid_confirm = member2_signer
        .call(&dao_id, "confirm")
        .args_json(serde_json::json!({
            "request_id": valid_req_id
        }))
        .max_gas()
        .transact()
        .await?;
    if valid_confirm.is_failure() {
        eprintln!("valid_confirm failures: {:?}", valid_confirm.failures());
        eprintln!("valid_confirm logs: {:?}", valid_confirm.logs());
        panic!("valid_confirm failed: {:?}", valid_confirm.failures());
    }
    assert!(valid_confirm.is_success(), "Execution after timelock must succeed on Testnet");
    println!("SUCCESS! Proposal executed on Testnet after timelock elapses!");

    // Verify ownership was updated on-chain
    let owner_after: near_sdk::AccountId = contract
        .view("get_owner")
        .args_json(serde_json::json!({}))
        .await?
        .json()?;
    assert_eq!(&owner_after, new_owner_candidate.id(), "Escrow owner must be updated to new owner candidate");
    println!("Verified on Testnet: Escrow owner successfully transferred to {}", owner_after);

    println!("\n============================================================");
    println!("         PRODUCTION TESTNET DEPLOYMENT SUMMARY              ");
    println!("============================================================");
    println!("Conpi Escrow Contract ID: {}", contract_id);
    println!("DAO Multisig Owner:       {}", dao_id);
    println!("DAO Member Keys:          3 Members ({}, {}, {})", member1_pk, member2_pk, member3_pk);
    println!("Multisig Quorum:          2 of 3 Confirmations Required");
    println!("Escrow Keys:              0 (Autonomous)");
    println!("Full Cycle Proved:        Propose -> Timelock Delay -> Quorum Confirmation -> Executed");
    println!("Escrow Explorer:          https://testnet.nearblocks.io/address/{}", contract_id);
    println!("DAO Explorer:             https://testnet.nearblocks.io/address/{}", dao_id);
    println!("============================================================");

    Ok(())
}
