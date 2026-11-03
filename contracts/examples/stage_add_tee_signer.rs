use conpi_escrow::types::AdminAction;
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

const ESCROW_ID: &str = "dev-20261103062448-30583839049419.testnet";
const DSTACK_HARDWARE_SIGNER: &str = "ed25519:CLHhDLsLCCqFeTjz7g31NkfbtN1UqT2mJRmRZgcRPTj3";
const HARDWARE_MEASUREMENT: &str = "mrtd:7fe60787222bd394cb516abca2435f22f035ab2cc9c0a4b4b3b148e46297f3d931a237b72f359052c6e657d8c1409173|compose:3b2df1746e75e7be40019af7995e73239adcdc3b3b1be82d02d663a009ad1979";

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    println!("============================================================");
    println!("  STAGE NEW COMPOSE HASH REGISTRATION FOR TEE SIGNER");
    println!("============================================================");

    // 1. Load keys
    let creds_p1 = Path::new(".credentials/dao_member_keys.json");
    let creds_p2 = Path::new("contracts/.credentials/dao_member_keys.json");
    let credentials_path = if creds_p1.exists() { creds_p1 } else { creds_p2 };

    let keys_content = fs::read_to_string(credentials_path)?;
    let keys_file: DaoKeysFile = serde_json::from_str(&keys_content)?;
    let dao_id: near_sdk::AccountId = keys_file.dao_account_id.parse()?;
    let escrow_id: near_sdk::AccountId = ESCROW_ID.parse()?;

    let member1_sk: SecretKey = keys_file.members[0].secret_key.parse()?;
    let member2_sk: SecretKey = keys_file.members[1].secret_key.parse()?;

    // 2. Connect to Testnet
    println!("Connecting to NEAR Testnet...");
    let worker = near_workspaces::testnet().await?;
    let member1_signer = near_workspaces::Account::from_secret_key(dao_id.clone(), member1_sk, &worker);
    let member2_signer = near_workspaces::Account::from_secret_key(dao_id.clone(), member2_sk, &worker);

    // 3. Propose AddTeeSigner
    let action = AdminAction::AddTeeSigner {
        public_key: DSTACK_HARDWARE_SIGNER.parse()?,
        measurement: HARDWARE_MEASUREMENT.to_string(),
    };
    let propose_call_args = serde_json::to_vec(&ProposeArgs { action })?;
    let propose_b64 = Base64VecU8::from(propose_call_args);

    println!("\n[1/2] Member 1 submitting add_request_and_confirm for AddTeeSigner...");
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
    let req_tx = add_req_res.outcome().transaction_hash;
    let request_id: u32 = add_req_res.json()?;
    println!("Multisig Request #{} created. Tx: {}", request_id, req_tx);

    println!("\n[2/2] Member 2 submitting confirm on Multisig DAO (reaching 2-of-3 quorum)...");
    let confirm_res = member2_signer
        .call(&dao_id, "confirm")
        .args_json(serde_json::json!({ "request_id": request_id }))
        .gas(near_workspaces::types::Gas::from_tgas(150))
        .transact()
        .await?
        .into_result()?;
    let confirm_tx = confirm_res.outcome().transaction_hash;
    println!("Quorum (2/2) reached! AddTeeSigner staged on Escrow contract. Tx: {}", confirm_tx);

    // Query staged proposals
    let staged_proposals: Vec<(u64, serde_json::Value)> = worker
        .view(&escrow_id, "list_staged_proposals")
        .args_json(serde_json::json!({}))
        .await?
        .json()?;

    println!("\nActive Staged Proposals on Escrow: {:?}", staged_proposals);
    let (prop_id, staged_val) = staged_proposals.last().unwrap();
    println!("Newly Staged Proposal ID: {}", prop_id);
    println!("Ready At:                 {:?}", staged_val["ready_at"]);

    Ok(())
}
