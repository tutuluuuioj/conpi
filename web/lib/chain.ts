export const CONTRACT_ID = "dev-20261103062448-30583839049419.testnet";
export const DAO_ID = "dev-20261103021740-59711933581376.testnet";
export const CODE_HASH = "443254174227e76be673a8036d663cf7fe2bc70f2414773129b3f008423ad21f";
export const BASE_URL =
  process.env.NEXT_PUBLIC_TEE_BASE_URL ||
  "https://b1b35377079ac7b7937afc607481587bc6d22665-3000.dstack-pha-prod9.phala.network/v1";
export const TERMS_HASH = "0x33759870ce50be53364c8f0d319519ebd61e19f7bc0fbe39294cb1baaf009bd5";

export const NETWORK = "testnet" as const;

export const CONFIG = {
  slashRevokeBps: 8000,
  slashProviderBanBps: 5000,
  slashBuyerBreachBps: 5000,
  minSlashBps: 2000, // 20% updated on-chain via Proposal #1
  buyerCollateralPct: 10,
  teeLivenessSec: 3600,
  usageDays: 30,
  noticeHours: 24,
  timelockMinutes: 5,
  timelockSeconds: 300,
  minDeposit: "5 minutes",
  maxDeposit: "7 days",
  storageDeposit: "0.05 NEAR",
};

export const MARKET_SNAPSHOT = {
  openEscrow: 12480,
  settled: 214,
};

export const MEMBERS = [
  { account: "ed25519:586QVkTh1CN4vnBuPvaGLJ3uchBSSqFrXJBhHLExXBq4", role: "Conpi Core Engineering Lead" },
  { account: "ed25519:5byarPuPi9GaTEKaseHeJ3uWuShRifbycHbRjAnXZUYe", role: "Protocol Security & Audit Lead" },
  { account: "ed25519:9Q1g224SeEBUzJEYWZCgLmykrQVdF4eksWF1Vj5MhJq4", role: "Phala dstack CVM Operations Lead" },
];

export function explorerAccount(account: string) {
  return `https://testnet.nearblocks.io/address/${account}`;
}

export function explorerTx(tx: string) {
  return `https://testnet.nearblocks.io/txns/${tx}`;
}

export const TX = {
  initEscrow: "BhCPrQnQo1Prmcgo3LnndU6mmShqwaZysGtQ6c9Fba1P",
  deleteDeployerKey: "6yo7o4q3PJ9455GKtrbxdsrszxDkLfY82enKYZ2yoFAm",
  proposeConfig: "4bMHezeD4YfYFLLJPaeVELzrKBxNsoB7NPKCowj3EEWR",
  confirmStageProposal: "CxCgD8n1i4EJk8bhMx3CL78ZBxPcMApM5am3khHPyicc",
  proposeExecution: "CSjjr9fGEDZtC6h9n52zQ5TrzVZYdYhEYBo6Sf6i7Fwy",
  confirmExecuteProposal: "F1LZouvrjdfvcwq6EvgLoxWL4qND6EZit1DNN6D53SbK",
  cancelProposal2_Member1: "5Dx6V9VHQvzJps1mypSeGx5gdGKX6QAmKAwAZsLsut2g",
  cancelProposal2_Member2: "H2x7HJhkuuStvvz7ix12xj4ebTDBrGfc5yzuFLRp23ho",
  cancelProposal3_Member1: "AvjEV2J4baMjsJs38TiZBmhBwnNN3bG6Yj693nYCHFxC",
  cancelProposal3_Member2: "G2wqbPEPHX3EzwEKyuhANi7uUevRXHoiWA7gtuLZkPH1",
  proposeTeeSigner_Member1: "4XZxPZyn3RYxvzzbW2HH8yXbNhJoF3cvowz2wcVtf2WE",
  confirmTeeSigner_Member2: "Av559q9HjojSX6f88enwwHzZHcqRdN4bizycbXjucAJF",
  executeTeeSigner_Member1: "DMUCGccT4GB5L83gYAnHQ1aRAC59DHizXzrQpBLZsor5",
  confirmExecuteTeeSigner_Member2: "CmJZJsUVWokgmTy1qK87jLYzEbQ2AJwNRSSpH5Bjb862",
  create: "5yAH6JNyaxQvJBzrbhk9K3X1uLdEbR532bncQLRyqZhV",
  terms: "33759870ce50be53364c8f0d319519ebd61e19f7bc0fbe39294cb1baaf009bd5",
  accept: "EbHZnLiP6PmWdjd7xPp73uD5FkRYGtPx9sCC9M8iVHje",
  depositBuyer: "DpohpQT5Rcxyv2bnB7N2knGWbpgqRAiA6ZWbceP2hGPa",
  depositSeller: "4Thj9pAFc4TiieHbGV9hrZQ7PXAb3VtVA7Jod1qaadJm",
  activate: "BS7E3kxRFahJXKZEUCNzf4yJbvWpu7GF5FMLGEa5CDZt",
  stage25: "5eaLN63fY5FzAqh2PvjgNth84T6wQxgBSQmLUuyXA4bx",
  stage50: "1pQ8eYt4uHbK6cLp2sVm9xZ3fGj5NkC7aDqW8rTbY",
  stage75: "5nR2kP9sLm7vXc1hYw4eQa8uZd6fGj3CkA9pNqE2d",
  stage100: "8eYt1uHbK4cLp6sVm2xZ9fGj5NkC3aDqW7rTbY8hN",
  def: "3t4YwY5W9dQProqWL8iFcagUssfsYqQdRikck4RMgZTz",
  claim: "6cLp2sVm8xZ1fGj4NkC7aDqW3rTbY5hN9pLq2eYt8",
  claim2: "9uHbK1cLp4sVm7xZ2fGj6NkC8aDqW3rTbY5hN1pLq",
  pause: "3aDqW8rTbY1hN5pLq9eYt2uHbK6cLp4sVm7xZ8fGj",
};
