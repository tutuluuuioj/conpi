use near_sdk::json_types::Base64VecU8;
use near_workspaces::types::SecretKey;
use serde::Deserialize;
use std::fs;
use std::path::Path;
use std::str::FromStr;

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

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    println!("=== EXECUTE TIMELOCKED MULTISIG PROPOSAL #1 ON NEAR TESTNET ===");

    let credentials_path = Path::new(".credentials/dao_member_keys.json");
    if !credentials_path.exists() {
        eprintln!(
            "Error: Credentials file not found at {}. Ensure you run from contracts/ directory.",
            credentials_path.display()
        );
        std::process::exit(1);
    }

    let file_content = fs::read_to_string(credentials_path)?;
    let dao_keys: DaoKeysFile = serde_json::from_str(&file_content)?;

    let escrow_id: near_workspaces::AccountId = "dev-20261103021728-21839689153509.testnet".parse()?;
    let dao_id: near_workspaces::AccountId = dao_keys.dao_account_id.parse()?;

    println!("Escrow Contract:   {}", escrow_id);
    println!("Multisig DAO:      {}", dao_id);

    let member1_sk = SecretKey::from_str(&dao_keys.members[0].secret_key)?;
    let member2_sk = SecretKey::from_str(&dao_keys.members[1].secret_key)?;

    println!("Member 1 Key:      {}", member1_sk.public_key());
    println!("Member 2 Key:      {}", member2_sk.public_key());

    let worker = near_workspaces::testnet().await?;
    let escrow_contract = near_workspaces::Contract::from_secret_key(
        escrow_id.clone(),
        near_workspaces::types::SecretKey::from_random(near_workspaces::types::KeyType::ED25519),
        &worker,
    );

    // 1. Query proposal status on Escrow contract
    let proposal_info: Option<serde_json::Value> = escrow_contract
        .view("get_staged_proposal")
        .args_json(serde_json::json!({ "proposal_id": 1 }))
        .await?
        .json()?;

    match proposal_info {
        Some(staged) => {
            let ready_at_ns = staged["ready_at"]
                .as_u64()
                .expect("ready_at timestamp in nanoseconds");
            let ready_at_secs = ready_at_ns / 1_000_000_000;
            let now_secs = std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)?
                .as_secs();

            println!("\nStaged Action:     {:?}", staged["action"]);
            println!("Ready At (ns):     {}", ready_at_ns);
            println!("Ready At (Unix):   {}", ready_at_secs);
            println!("Current Time:      {}", now_secs);

            if now_secs < ready_at_secs {
                let remaining_secs = ready_at_secs - now_secs;
                let hours = remaining_secs / 3600;
                let mins = (remaining_secs % 3600) / 60;
                let secs = remaining_secs % 60;
                eprintln!(
                    "\n[TIMELOCK ENFORCED] Proposal #1 is not mature yet! Remaining time: {}h {}m {}s.",
                    hours, mins, secs
                );
                eprintln!("Execution will unlock at 2026-11-05T08:36:33+06:00 (Dhaka Time).");
                return Ok(());
            }

            println!("\nTimelock period has elapsed! Proceeding with 2-of-3 Multisig execution...");
        }
        None => {
            println!("Proposal #1 is no longer staged (it may have already been executed or cancelled).");
            return Ok(());
        }
    }

    // 2. Prepare function-call arguments for execute_admin_action
    let exec_call_args = serde_json::to_vec(&serde_json::json!({
        "proposal_id": 1,
        "code": null
    }))?;
    let exec_b64 = Base64VecU8::from(exec_call_args);

    let member1_signer =
        near_workspaces::Account::from_secret_key(dao_id.clone(), member1_sk, &worker);
    let member2_signer =
        near_workspaces::Account::from_secret_key(dao_id.clone(), member2_sk, &worker);

    // 3. Member 1 creates and confirms MultiSig request
    println!("\n[1/2] Member 1 submitting add_request_and_confirm to DAO...");
    let req_res = member1_signer
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
        .await?;

    let req_tx_hash = req_res.receipt_outcomes().first().map(|r| r.transaction_hash.to_string());
    println!("Step 1 Success! Member 1 Tx Hash: {:?}", req_tx_hash);

    let req_id: u32 = req_res.json()?;
    println!("Multisig Request ID: {}", req_id);

    // 4. Member 2 confirms request -> Quorum reached (2/2) -> Multisig calls Escrow
    println!("\n[2/2] Member 2 confirming request ID {}...", req_id);
    let confirm_res = member2_signer
        .call(&dao_id, "confirm")
        .args_json(serde_json::json!({
            "request_id": req_id
        }))
        .gas(near_workspaces::types::Gas::from_tgas(150))
        .transact()
        .await?;

    if confirm_res.is_failure() {
        eprintln!("Execution failed: {:?}", confirm_res.failures());
        std::process::exit(1);
    }

    let confirm_tx_hash = confirm_res.receipt_outcomes().first().map(|r| r.transaction_hash.to_string());
    println!("Step 2 Success! Member 2 Tx Hash: {:?}", confirm_tx_hash);
    println!("Proposal #1 successfully executed on-chain through 2-of-3 Multisig!");

    // 5. Verify proposal is no longer staged and new config is live
    let staged_after: Option<serde_json::Value> = escrow_contract
        .view("get_staged_proposal")
        .args_json(serde_json::json!({ "proposal_id": 1 }))
        .await?
        .json()?;
    assert!(staged_after.is_none(), "Proposal #1 should be cleared after execution");

    let live_config: serde_json::Value = escrow_contract
        .view("get_config")
        .args_json(serde_json::json!({}))
        .await?
        .json()?;
    println!("\nUpdated Live Escrow Config: {:#?}", live_config);
    println!("\n=== GOVERNANCE CYCLE SUCCESSFULLY COMPLETED ===");

    Ok(())
}
