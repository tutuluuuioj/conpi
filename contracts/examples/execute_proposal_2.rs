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
    println!("=== EXECUTE TIMELOCKED MULTISIG PROPOSAL #2 (CONTRACT UPGRADE) ON NEAR TESTNET ===");

    let creds_p1 = Path::new(".credentials/dao_member_keys.json");
    let creds_p2 = Path::new("contracts/.credentials/dao_member_keys.json");
    let credentials_path = if creds_p1.exists() {
        creds_p1
    } else if creds_p2.exists() {
        creds_p2
    } else {
        eprintln!(
            "Error: Credentials file not found at .credentials/dao_member_keys.json or contracts/.credentials/dao_member_keys.json."
        );
        std::process::exit(1);
    };

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

    let wasm_p1 = Path::new("contracts/res/conpi_escrow.wasm");
    let wasm_p2 = Path::new("res/conpi_escrow.wasm");
    let wasm_p3 = Path::new("contracts/target/near/conpi_escrow.wasm");
    let wasm_path = if wasm_p1.exists() {
        wasm_p1
    } else if wasm_p2.exists() {
        wasm_p2
    } else if wasm_p3.exists() {
        wasm_p3
    } else {
        eprintln!("Error: conpi_escrow.wasm not found in res/ or target/near/");
        std::process::exit(1);
    };

    let wasm_bytes = fs::read(wasm_path)?;
    println!("Read WASM from:    {:?} ({} bytes)", wasm_path, wasm_bytes.len());

    let worker = near_workspaces::testnet().await?;
    let escrow_contract = near_workspaces::Contract::from_secret_key(
        escrow_id.clone(),
        near_workspaces::types::SecretKey::from_random(near_workspaces::types::KeyType::ED25519),
        &worker,
    );

    // 1. Query proposal status on Escrow contract (Proposal #3 is the verifiable container build)
    let proposal_id = 3u64;
    let proposal_info: Option<serde_json::Value> = escrow_contract
        .view("get_staged_proposal")
        .args_json(serde_json::json!({ "proposal_id": proposal_id }))
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

            println!("\nStaged Proposal ID: {}", proposal_id);
            println!("Staged Action:     {:?}", staged["action"]);
            println!("Ready At (ns):     {}", ready_at_ns);
            println!("Ready At (Unix):   {}", ready_at_secs);
            println!("Current Time:      {}", now_secs);

            if now_secs < ready_at_secs {
                let remaining_secs = ready_at_secs - now_secs;
                let hours = remaining_secs / 3600;
                let mins = (remaining_secs % 3600) / 60;
                let secs = remaining_secs % 60;
                eprintln!(
                    "\n[TIMELOCK ENFORCED] Proposal #{} is not mature yet! Remaining time: {}h {}m {}s.",
                    proposal_id, hours, mins, secs
                );
                return Ok(());
            }

            println!("\nTimelock period has elapsed! Proceeding with 2-of-3 Multisig upgrade execution...");
        }
        None => {
            println!("Proposal #{} is not staged (it may have already been executed or not yet proposed).", proposal_id);
            return Ok(());
        }
    }

    // 2. Prepare function-call arguments for execute_admin_action with WASM code
    let exec_call_args = serde_json::to_vec(&serde_json::json!({
        "proposal_id": proposal_id,
        "code": wasm_bytes
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
                        "gas": "250000000000000" // 250 Tgas for contract redeploy & migrate
                    }
                ]
            }
        }))
        .gas(near_workspaces::types::Gas::from_tgas(300))
        .transact()
        .await?;

    if !req_res.is_success() {
        eprintln!("add_request_and_confirm failed: {:?}", req_res.failures());
        std::process::exit(1);
    }

    let req_tx_hash = req_res.outcome().transaction_hash;
    println!("Step 1 Success! Member 1 Tx Hash: {}", req_tx_hash);

    let req_id: u32 = req_res.json()?;
    println!("Multisig Request ID: {}", req_id);

    // 4. Member 2 confirms request -> Quorum reached (2/2) -> Multisig calls Escrow
    println!("\n[2/2] Member 2 confirming request ID {}...", req_id);
    let confirm_res = member2_signer
        .call(&dao_id, "confirm")
        .args_json(serde_json::json!({
            "request_id": req_id
        }))
        .gas(near_workspaces::types::Gas::from_tgas(300))
        .transact()
        .await?;

    if !confirm_res.is_success() {
        eprintln!("Execution failed: {:?}", confirm_res.failures());
        std::process::exit(1);
    }

    let confirm_tx_hash = confirm_res.outcome().transaction_hash;
    println!("Step 2 Success! Member 2 Tx Hash: {}", confirm_tx_hash);
    println!("Proposal #2 successfully executed on-chain through 2-of-3 Multisig!");

    // 5. Verify proposal is no longer staged
    let staged_after: Option<serde_json::Value> = escrow_contract
        .view("get_staged_proposal")
        .args_json(serde_json::json!({ "proposal_id": 2 }))
        .await?
        .json()?;
    assert!(staged_after.is_none(), "Proposal #2 should be cleared after execution");

    println!("\n=== CONTRACT UPGRADE SUCCESSFULLY COMPLETED ===");
    Ok(())
}
