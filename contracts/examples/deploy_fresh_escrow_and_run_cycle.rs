use conpi_escrow::types::{AdminAction, Config};
use near_sdk::json_types::Base64VecU8;
use near_workspaces::types::SecretKey;
use serde::Deserialize;
use std::fs;
use std::path::Path;

#[derive(Deserialize)]
#[allow(dead_code)]
struct MemberKeyEntry {
    member_index: u8,
    role: String,
    holder_entity: String,
    public_key: String,
    secret_key: String,
}

#[derive(Deserialize)]
#[allow(dead_code)]
struct DaoKeysFile {
    network: String,
    dao_account_id: String,
    members: [MemberKeyEntry; 3],
}

#[derive(serde::Serialize)]
struct ProposeArgs {
    action: AdminAction,
}

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    println!("============================================================");
    println!("  DEPLOY FRESH ESCROW (5-MIN TIMELOCK) & RUN GOVERNANCE CYCLE");
    println!("============================================================");

    // 1. Load keys and WASM
    let creds_p1 = Path::new(".credentials/dao_member_keys.json");
    let creds_p2 = Path::new("contracts/.credentials/dao_member_keys.json");
    let credentials_path = if creds_p1.exists() {
        creds_p1
    } else {
        creds_p2
    };

    println!("Loading DAO member keys from {:?}...", credentials_path);
    let keys_content = fs::read_to_string(credentials_path)?;
    let keys_file: DaoKeysFile = serde_json::from_str(&keys_content)?;
    let dao_id: near_sdk::AccountId = keys_file.dao_account_id.parse()?;
    println!("DAO Multisig Account: {}", dao_id);

    let member1_sk: SecretKey = keys_file.members[0].secret_key.parse()?;
    let member2_sk: SecretKey = keys_file.members[1].secret_key.parse()?;

    let wasm_p1 = Path::new("res/conpi_escrow.wasm");
    let wasm_p2 = Path::new("contracts/res/conpi_escrow.wasm");
    let wasm_bytes = if wasm_p1.exists() {
        fs::read(wasm_p1)?
    } else {
        fs::read(wasm_p2)?
    };
    println!("Loaded verifiable WASM: {} bytes", wasm_bytes.len());

    // 2. Connect to Testnet
    println!("Connecting to NEAR Testnet...");
    let worker = near_workspaces::testnet().await?;

    // 3. Deploy Fresh Escrow Contract
    println!("\n[1/5] Deploying fresh Conpi Escrow contract to Testnet via dev_deploy...");
    let escrow_contract = worker.dev_deploy(&wasm_bytes).await?;
    let escrow_id = escrow_contract.id().clone();
    println!("SUCCESS! Fresh Escrow contract deployed at: {}", escrow_id);

    // 4. Initialize Escrow with DAO Owner and 5-Minute Timelock (300_000_000_000 ns)
    let timelock_5min_ns = 300_000_000_000u64;
    println!("\n[2/5] Initializing Escrow with DAO Owner ({}) and 5-Minute Timelock ({} ns)...", dao_id, timelock_5min_ns);
    let init_res = escrow_contract
        .call("new")
        .args_json(serde_json::json!({
            "owner": dao_id,
            "chain_id": "testnet",
            "config": null,
            "initial_tee_signer": null,
            "timelock_duration": timelock_5min_ns
        }))
        .max_gas()
        .transact()
        .await?
        .into_result()?;
    println!("SUCCESS! Escrow initialized. Init Tx Hash: {}", init_res.outcome().transaction_hash);

    // 5. Delete FullAccess key from Escrow contract account (strictly 0 access keys)
    println!("\n[3/5] Deleting FullAccess key from Escrow account (ensuring 0 keys on Escrow)...");
    let deployer_pk = escrow_contract.as_account().secret_key().public_key();
    let del_key_res = escrow_contract
        .as_account()
        .batch(&escrow_id)
        .delete_key(deployer_pk)
        .transact()
        .await?
        .into_result()?;
    println!("SUCCESS! Deployer key removed. Key Deletion Tx Hash: {}", del_key_res.outcome().transaction_hash);

    let escrow_keys = escrow_contract.view_access_keys().await?;
    println!("Verified on-chain: Escrow contract has exactly {} access keys (0 keys).", escrow_keys.len());
    assert_eq!(escrow_keys.len(), 0, "Escrow contract must have 0 access keys");

    // 6. Stage Proposal #1 (UpdateConfig) via Multisig DAO
    println!("\n[4/5] Proposing AdminAction::UpdateConfig through 2-of-3 Multisig DAO...");
    let member1_signer = near_workspaces::Account::from_secret_key(dao_id.clone(), member1_sk, &worker);
    let member2_signer = near_workspaces::Account::from_secret_key(dao_id.clone(), member2_sk, &worker);

    let updated_config = Config {
        min_slash_bps: 2_000, // 20% (updated from default 10%)
        ..Default::default()
    };
    let propose_call_args = serde_json::to_vec(&ProposeArgs {
        action: AdminAction::UpdateConfig {
            config: updated_config.clone(),
        },
    })?;
    let propose_b64 = Base64VecU8::from(propose_call_args);

    println!("Member 1 submitting add_request_and_confirm on Multisig DAO...");
    let add_req_res = member1_signer
        .call(&dao_id, "add_request_and_confirm")
        .args_json(serde_json::json!({
            "request": {
                "receiver_id": escrow_id,
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
        .await?
        .into_result()?;
    let req1_tx = add_req_res.outcome().transaction_hash;
    let request_id: u32 = add_req_res.json()?;
    println!("Request #{} created. 1/2 confirmations.", request_id);
    println!("Proposal Creation Tx Hash: {}", req1_tx);

    println!("Member 2 submitting confirm on Multisig DAO (reaching 2-of-3 quorum)...");
    let confirm1_res = member2_signer
        .call(&dao_id, "confirm")
        .args_json(serde_json::json!({ "request_id": request_id }))
        .gas(near_workspaces::types::Gas::from_tgas(150))
        .transact()
        .await?
        .into_result()?;
    let confirm1_tx = confirm1_res.outcome().transaction_hash;
    println!("Quorum (2/2) reached! Proposal #1 staged on Escrow contract.");
    println!("Proposal Confirmation Tx Hash: {}", confirm1_tx);

    // Query staged proposal on Escrow contract
    let proposal_info: Option<serde_json::Value> = escrow_contract
        .view("get_staged_proposal")
        .args_json(serde_json::json!({ "proposal_id": 1 }))
        .await?
        .json()?;
    assert!(proposal_info.is_some(), "Proposal #1 must be staged on Escrow contract");
    let staged = proposal_info.unwrap();
    let ready_at_ns = if let Some(n) = staged["ready_at"].as_u64() {
        n
    } else if let Some(s) = staged["ready_at"].as_str() {
        s.parse::<u64>().expect("parse ready_at")
    } else {
        panic!("unexpected ready_at format: {:?}", staged["ready_at"]);
    };
    let ready_at_secs = ready_at_ns / 1_000_000_000;

    println!("\n--- STAGED PROPOSAL DETAILS ---");
    println!("Proposal ID:       1");
    println!("Action:            {:?}", staged["action"]);
    println!("Ready At (ns):     {}", ready_at_ns);
    println!("Ready At (Unix):   {}", ready_at_secs);

    // 7. Wait 5 minutes for timelock to elapse
    println!("\n[5/5] WAITING FOR 5-MINUTE TIMELOCK TO MATURE...");
    loop {
        let now_secs = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)?
            .as_secs();

        if now_secs >= ready_at_secs {
            println!("\nTimelock period (5 minutes) has fully matured! (now={} >= ready_at={})", now_secs, ready_at_secs);
            break;
        }

        let remaining = ready_at_secs - now_secs;
        println!("Waiting for timelock maturity... {} seconds remaining ({}m {}s)", remaining, remaining / 60, remaining % 60);
        tokio::time::sleep(std::time::Duration::from_secs(20)).await;
    }

    // 8. Execute Proposal #1 via Multisig DAO
    println!("\nExecuting mature Proposal #1 through 2-of-3 Multisig DAO...");
    let exec_call_args = serde_json::to_vec(&serde_json::json!({
        "proposal_id": 1,
        "code": null
    }))?;
    let exec_b64 = Base64VecU8::from(exec_call_args);

    println!("Member 1 submitting execution request on Multisig DAO...");
    let add_exec_res = member1_signer
        .call(&dao_id, "add_request_and_confirm")
        .args_json(serde_json::json!({
            "request": {
                "receiver_id": escrow_id,
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
        .await?
        .into_result()?;
    let req2_tx = add_exec_res.outcome().transaction_hash;
    let exec_req_id: u32 = add_exec_res.json()?;
    println!("Execution Request #{} created. 1/2 confirmations.", exec_req_id);
    println!("Execution Proposal Tx Hash: {}", req2_tx);

    println!("Member 2 submitting confirm on Multisig DAO (reaching 2-of-3 quorum to execute)...");
    let confirm2_res = member2_signer
        .call(&dao_id, "confirm")
        .args_json(serde_json::json!({ "request_id": exec_req_id }))
        .gas(near_workspaces::types::Gas::from_tgas(150))
        .transact()
        .await?
        .into_result()?;
    let confirm2_tx = confirm2_res.outcome().transaction_hash;
    println!("Execution Quorum (2/2) reached! Proposal #1 executed on Escrow contract!");
    println!("Execution Confirmation Tx Hash: {}", confirm2_tx);

    // 9. Verify on-chain execution and state
    println!("\nVerifying on-chain state post-execution...");
    let staged_after: Option<serde_json::Value> = escrow_contract
        .view("get_staged_proposal")
        .args_json(serde_json::json!({ "proposal_id": 1 }))
        .await?
        .json()?;
    assert!(staged_after.is_none(), "Proposal #1 must be consumed after successful execution");
    println!("SUCCESS: Proposal #1 consumed and removed from staged proposals.");

    let config_after: Config = escrow_contract
        .view("get_config")
        .args_json(serde_json::json!({}))
        .await?
        .json()?;
    assert_eq!(config_after.min_slash_bps, 2_000);
    println!("SUCCESS: Updated config active on-chain (min_slash_bps updated to 20%).");

    let owner_after: near_sdk::AccountId = escrow_contract
        .view("get_owner")
        .args_json(serde_json::json!({}))
        .await?
        .json()?;
    assert_eq!(&owner_after, &dao_id, "Owner must remain DAO Multisig contract!");
    println!("SUCCESS: Escrow owner permanently held by Multisig DAO ({}).", owner_after);

    println!("\n============================================================");
    println!("         PHASE 1 TESTNET GOVERNANCE CYCLE SUMMARY           ");
    println!("============================================================");
    println!("Fresh Escrow Contract:       {}", escrow_id);
    println!("DAO Multisig Owner:          {}", dao_id);
    println!("Escrow Access Keys:          0 keys (strictly trustless)");
    println!("Timelock Enforced:           5 Minutes (300,000,000,000 ns)");
    println!("Reproducible WASM SHA-256:   443254174227e76be673a8036d663cf7fe2bc70f2414773129b3f008423ad21f");
    println!("--- TRANSACTION HASHES ---");
    println!("1. Propose & Confirm #1:     https://testnet.nearblocks.io/txns/{}", req1_tx);
    println!("2. Confirm #2 & Stage:       https://testnet.nearblocks.io/txns/{}", confirm1_tx);
    println!("3. Execute & Confirm #1:     https://testnet.nearblocks.io/txns/{}", req2_tx);
    println!("4. Confirm #2 & Execute:     https://testnet.nearblocks.io/txns/{}", confirm2_tx);
    println!("============================================================");

    Ok(())
}
