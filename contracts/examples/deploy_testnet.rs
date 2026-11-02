use near_workspaces::types::NearToken;

const WASM_PATH: &str = "./target/wasm32-unknown-unknown/release/conpi_escrow.wasm";

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
        println!("Explorer link: https://testnet.nearblocks.io/address/{}", contract_id);
    } else {
        println!("Init response: {:?}", init_res);
    }

    Ok(())
}
