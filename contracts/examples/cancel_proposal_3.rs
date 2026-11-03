use near_sdk::json_types::Base64VecU8;
use near_workspaces::types::SecretKey;
use serde::{Deserialize, Serialize};
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

#[derive(Serialize)]
struct CancelArgs {
    proposal_id: u64,
}

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    println!("=== CANCEL PROPOSAL #3 ON OLD ESCROW VIA MULTISIG ===");

    let creds_p1 = Path::new(".credentials/dao_member_keys.json");
    let creds_p2 = Path::new("contracts/.credentials/dao_member_keys.json");
    let credentials_path = if creds_p1.exists() {
        creds_p1
    } else if creds_p2.exists() {
        creds_p2
    } else {
        eprintln!("Error: Credentials file not found.");
        std::process::exit(1);
    };

    let file_content = fs::read_to_string(credentials_path)?;
    let dao_keys: DaoKeysFile = serde_json::from_str(&file_content)?;

    let escrow_id: near_workspaces::AccountId = "dev-20261103021728-21839689153509.testnet".parse()?;
    let dao_id: near_workspaces::AccountId = dao_keys.dao_account_id.parse()?;

    let member1_sk = SecretKey::from_str(&dao_keys.members[0].secret_key)?;
    let member2_sk = SecretKey::from_str(&dao_keys.members[1].secret_key)?;

    let worker = near_workspaces::testnet().await?;
    let escrow_contract = near_workspaces::Contract::from_secret_key(
        escrow_id.clone(),
        near_workspaces::types::SecretKey::from_random(near_workspaces::types::KeyType::ED25519),
        &worker,
    );

    let member1_signer = near_workspaces::Account::from_secret_key(dao_id.clone(), member1_sk, &worker);
    let member2_signer = near_workspaces::Account::from_secret_key(dao_id.clone(), member2_sk, &worker);

    let cancel_call_args = serde_json::to_vec(&CancelArgs { proposal_id: 3 })?;
    let cancel_b64 = Base64VecU8::from(cancel_call_args);

    println!("Member 1 submitting add_request_and_confirm on Multisig DAO...");
    let cancel_req_res = member1_signer
        .call(&dao_id, "add_request_and_confirm")
        .args_json(serde_json::json!({
            "request": {
                "receiver_id": escrow_id,
                "actions": [
                    {
                        "type": "FunctionCall",
                        "method_name": "cancel_admin_action",
                        "args": cancel_b64,
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

    let cancel_req_tx = cancel_req_res.outcome().transaction_hash;
    let cancel_req_id: u32 = cancel_req_res.json()?;
    println!("Cancel Request #{} created by Member 1 (Tx: {})", cancel_req_id, cancel_req_tx);

    println!("Member 2 submitting confirm on Multisig DAO (reaching 2-of-3 quorum)...");
    let cancel_confirm_res = member2_signer
        .call(&dao_id, "confirm")
        .args_json(serde_json::json!({ "request_id": cancel_req_id }))
        .gas(near_workspaces::types::Gas::from_tgas(100))
        .transact()
        .await?
        .into_result()?;

    let cancel_confirm_tx = cancel_confirm_res.outcome().transaction_hash;
    println!("Cancel Request #{} confirmed by Member 2 (Tx: {})", cancel_req_id, cancel_confirm_tx);

    // Verify Proposal #3 is gone
    let check_prop_3: Option<serde_json::Value> = escrow_contract
        .view("get_staged_proposal")
        .args_json(serde_json::json!({ "proposal_id": 3 }))
        .await?
        .json()?;
    assert!(check_prop_3.is_none(), "Proposal #3 should now be cancelled");
    println!("Verified on-chain: Proposal #3 successfully cancelled on Escrow contract!");

    Ok(())
}
