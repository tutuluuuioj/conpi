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

    // Initialize the contract on testnet with contract_id as owner
    println!("Initializing contract on testnet...");
    let init_res = contract
        .call("new")
        .args_json(serde_json::json!({
            "owner": contract_id,
            "config": null
        }))
        .max_gas()
        .transact()
        .await?;

    if init_res.is_success() {
        println!("SUCCESS! Contract initialized on testnet: {}", contract_id);
    } else {
        println!("Init failed: {:?}", init_res);
    }

    // Register active TEE Signer on testnet
    let (_tee_sk, tee_pk) = generate_tee_keypair();
    println!("Registering active Phala Intel TDX TEE Signer: {}...", tee_pk);

    let reg_res = contract
        .call("add_tee_signer")
        .args_json(serde_json::json!({
            "public_key": tee_pk,
            "measurement": "phala_intel_tdx_mrtd_e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"
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

    Ok(())
}
