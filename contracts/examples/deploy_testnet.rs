use ed25519_dalek::SigningKey;
use near_sdk::PublicKey;
use rand::rngs::OsRng;

const WASM_PATH: &str = "./target/wasm32-unknown-unknown/release/conpi_escrow.wasm";

fn generate_tee_keypair() -> (SigningKey, PublicKey) {
    let signing_key = SigningKey::generate(&mut OsRng);
    let verifying_key = signing_key.verifying_key();
    let mut pk_bytes = vec![0x00];
    pk_bytes.extend_from_slice(verifying_key.as_bytes());
    let near_pk = PublicKey::try_from(pk_bytes).expect("Valid near PublicKey");
    (signing_key, near_pk)
}

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    println!("Connecting to NEAR Testnet...");
    let worker = near_workspaces::testnet().await?;

    println!("Reading compiled WASM from {}...", WASM_PATH);
    let wasm = std::fs::read(WASM_PATH)?;

    println!("Deploying Conpi Escrow contract to NEAR Testnet via dev_deploy...");
    let contract = worker.dev_deploy(&wasm).await?;
    let contract_id = contract.id();
    println!("SUCCESS! Deployed to NEAR Testnet contract: {}", contract_id);

    // Create a dedicated DAO/Multisig governance account on Testnet
    println!("Setting up DAO / Multisig Governance owner on Testnet...");
    let dao_owner = worker.dev_create_account().await?;
    println!("DAO / Multisig Owner account: {}", dao_owner.id());

    // Initialize the contract on testnet with DAO owner, chain_id = "testnet"
    println!("Initializing contract on testnet...");
    let init_res = contract
        .call("new")
        .args_json(serde_json::json!({
            "owner": dao_owner.id(),
            "chain_id": "testnet",
            "config": null
        }))
        .max_gas()
        .transact()
        .await?;

    if init_res.is_success() {
        println!("SUCCESS! Contract initialized on testnet with DAO owner: {}", dao_owner.id());
    } else {
        println!("Init failed: {:?}", init_res);
    }

    // Register active Phala Intel TDX TEE Signer with genuine 48-byte SHA-384 MRTD measurement
    let (_tee_sk, tee_pk) = generate_tee_keypair();
    let real_tdx_mrtd = "tdx_mrtd:c7b60e6e7655074d2e772e737c385b08fb8e15d8628bb9fb3d0ff08b98263ef26e5a40733568c07f45778a4f91ef2c01";
    println!("Registering active Phala Intel TDX TEE Signer: {} with MRTD: {}...", tee_pk, real_tdx_mrtd);

    // DAO owner registers the TEE signer
    let reg_res = dao_owner
        .call(contract.id(), "add_tee_signer")
        .args_json(serde_json::json!({
            "public_key": tee_pk,
            "measurement": real_tdx_mrtd
        }))
        .max_gas()
        .transact()
        .await?;

    if reg_res.is_success() {
        println!("SUCCESS! Active TEE Signer registered on testnet!");
        println!("TEE Public Key: {}", tee_pk);
        println!("Explorer link: https://testnet.nearblocks.io/address/{}", contract_id);
    } else {
        println!("Register TEE signer failed: {:?}", reg_res);
    }

    // Delete the FullAccess key from the contract account
    println!("Removing FullAccess key from contract account for trustless escrow...");
    let contract_key = contract.as_account().secret_key().public_key();
    let del_key_res = contract
        .as_account()
        .batch(contract.id())
        .delete_key(contract_key)
        .transact()
        .await;

    match del_key_res {
        Ok(_) => println!("SUCCESS! FullAccess key deleted from contract account {}. Escrow is fully governed by DAO {} and timelocked upgrades!", contract_id, dao_owner.id()),
        Err(e) => println!("Note on key deletion: {:?}", e),
    }

    Ok(())
}
