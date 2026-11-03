use near_workspaces::types::NearToken;

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    println!("Connecting to NEAR Testnet...");
    let worker = near_workspaces::testnet().await?;
    let dao_id: near_workspaces::AccountId = "dev-20261103021740-59711933581376.testnet".parse()?;

    let dao_acc = worker.view_account(&dao_id).await?;
    println!("Initial Multisig DAO Balance: {} NEAR", dao_acc.balance.as_near());

    println!("Creating funding dev accounts to top up DAO...");
    for i in 1..=3 {
        println!("Creating funding account #{}...", i);
        let donor = worker.dev_create_account().await?;
        let donor_bal = donor.view_account().await?.balance;
        println!("Donor #{} ({}) balance: {} NEAR", i, donor.id(), donor_bal.as_near());
        
        let transfer_amount = NearToken::from_near(9);
        donor.transfer_near(&dao_id, transfer_amount).await?.into_result()?;
        println!("Transferred 9 NEAR to DAO.");
    }

    let final_acc = worker.view_account(&dao_id).await?;
    println!("Final Multisig DAO Balance: {} NEAR", final_acc.balance.as_near());
    Ok(())
}
