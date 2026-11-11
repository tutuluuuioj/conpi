import { baseClient, BASE_SEPOLIA_USDC } from "../src/chain/base-client.js";

async function runTests() {
  console.log("=== BaseClient Live Integration Test ===");

  const blockNumber = await baseClient.getBlockNumber();
  console.log(`[PASS] Base Sepolia block number fetched: ${blockNumber}`);
  if (blockNumber <= 0n) {
    throw new Error("Invalid block number from Base Sepolia");
  }

  // Test non-existent tx rejection
  const fakeTx = "0x0000000000000000000000000000000000000000000000000000000000000001";
  const fakeVault = "0x0aA750e83Dae45e4bA17EbAd07A2Fb800988155f";
  const result = await baseClient.verifyDeposit({
    txHash: fakeTx,
    expectedVault: fakeVault,
    expectedAmountAtomic: 1000000n, // 1 USDC
  });

  console.log(`[PASS] Non-existent tx correctly rejected:`, result.error);
  if (result.ok) {
    throw new Error("Expected fake tx to fail verification");
  }

  console.log("=== All BaseClient tests passed 100% ===");
}

runTests().catch((err) => {
  console.error("Test failed:", err);
  process.exit(1);
});
