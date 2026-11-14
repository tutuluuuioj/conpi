use conpi_escrow::types::TeeSigner;
use near_sdk::json_types::Base64VecU8;
use near_workspaces::types::SecretKey;
use serde::Deserialize;
use std::{env, fs};
use std::path::Path;

const ESCROW_ID: &str = "dev-20261103062448-30583839049419.testnet";
const DSTACK_HARDWARE_SIGNER: &str = "ed25519:F4YtyCFTEj9rca8fJQxcQd7F1UHuuGQBxP8WmcAC7cbi";
const DEFAULT_HARDWARE_MEASUREMENT: &str = "mrtd:7fe60787222bd394cb516abca2435f22f035ab2cc9c0a4b4b3b148e46297f3d931a237b72f359052c6e657d8c1409173|compose:c0e721177e14f30af1b8dcca1cbc7fb0e828c035a6551909810e938d109b8182";

#[derive(Deserialize)]
struct MemberKeyEntry { secret_key: String }

#[derive(Deserialize)]
struct DaoKeysFile {
    dao_account_id: String,
    members: [MemberKeyEntry; 3],
}

#[derive(serde::Serialize)]
struct ExecuteArgs { proposal_id: u64, code: Option<Vec<u8>> }

fn ready_at_ns(value: &serde_json::Value) -> Option<u128> {
    value["ready_at"].as_str()
        .and_then(|value| value.parse().ok())
        .or_else(|| value["ready_at"].as_u64().map(u128::from))
}

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    let hardware_measurement = env::var("CONPI_TEE_MEASUREMENT")
        .unwrap_or_else(|_| DEFAULT_HARDWARE_MEASUREMENT.to_string());
    let credentials_path = [".credentials/dao_member_keys.json", "contracts/.credentials/dao_member_keys.json"]
        .into_iter()
        .find(|path| Path::new(path).exists())
        .ok_or("DAO member credential file not found")?;
    let keys: DaoKeysFile = serde_json::from_str(&fs::read_to_string(credentials_path)?)?;
    let dao_id: near_sdk::AccountId = keys.dao_account_id.parse()?;
    let escrow_id: near_sdk::AccountId = ESCROW_ID.parse()?;
    let near_rpc_url = env::var("NEAR_RPC_URL")
        .or_else(|_| env::var("DRPC_NEAR_URL"))
        .unwrap_or_else(|_| "https://rpc.testnet.near.org".to_string());
    let worker = near_workspaces::testnet().rpc_addr(&near_rpc_url).await?;
    let member1 = near_workspaces::Account::from_secret_key(dao_id.clone(), keys.members[0].secret_key.parse::<SecretKey>()?, &worker);
    let member2 = near_workspaces::Account::from_secret_key(dao_id.clone(), keys.members[1].secret_key.parse::<SecretKey>()?, &worker);

    let staged: Vec<(u64, serde_json::Value)> = worker
        .view(&escrow_id, "list_staged_proposals")
        .args_json(serde_json::json!({}))
        .await?
        .json()?;
    let (proposal_id, proposal) = staged.into_iter().find(|(_, proposal)| {
        proposal["action"]["AddTeeSigner"]["public_key"] == DSTACK_HARDWARE_SIGNER
            && proposal["action"]["AddTeeSigner"]["measurement"] == hardware_measurement
    }).ok_or("matching staged TEE measurement proposal was not found")?;
    let ready_at = ready_at_ns(&proposal).ok_or("staged proposal has invalid ready_at")?;
    println!("Found staged TEE measurement proposal #{}.", proposal_id);

    loop {
        let now = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH)?.as_nanos();
        if now >= ready_at { break; }
        let remaining = ((ready_at - now) / 1_000_000_000) as u64;
        println!("Timelock has {} seconds remaining.", remaining);
        tokio::time::sleep(std::time::Duration::from_secs(20)).await;
    }

    let args = Base64VecU8::from(serde_json::to_vec(&ExecuteArgs { proposal_id, code: None })?);
    let execute = member1.call(&dao_id, "add_request_and_confirm")
        .args_json(serde_json::json!({ "request": { "receiver_id": escrow_id, "actions": [{
            "type": "FunctionCall", "method_name": "execute_admin_action", "args": args,
            "deposit": "0", "gas": "50000000000000"
        }]}}))
        .gas(near_workspaces::types::Gas::from_tgas(100))
        .transact().await?.into_result()?;
    let request_id: u32 = execute.json()?;
    println!("DAO execution request #{}: {}", request_id, execute.outcome().transaction_hash);

    let confirm = member2.call(&dao_id, "confirm")
        .args_json(serde_json::json!({ "request_id": request_id }))
        .gas(near_workspaces::types::Gas::from_tgas(150))
        .transact().await?.into_result()?;
    println!("DAO execution confirmed: {}", confirm.outcome().transaction_hash);

    for _ in 0..10 {
        let signer: Option<TeeSigner> = worker.view(&escrow_id, "get_tee_signer")
            .args_json(serde_json::json!({ "public_key": DSTACK_HARDWARE_SIGNER }))
            .await?.json()?;
        if let Some(signer) = signer {
            if signer.active && signer.measurement == hardware_measurement {
                println!("TEE signer measurement is active on-chain.");
                return Ok(());
            }
        }
        tokio::time::sleep(std::time::Duration::from_secs(2)).await;
    }
    Err("TEE signer measurement did not update after the DAO confirmation".into())
}
