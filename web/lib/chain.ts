export const CONTRACT_ID = "dev-20261103062448-30583839049419.testnet";
export const DAO_ID = "dev-20261103021740-59711933581376.testnet";
export const CODE_HASH = "443254174227e76be673a8036d663cf7fe2bc70f2414773129b3f008423ad21f";
export const TEE_SIGNER = "ed25519:Hq4DqffDiM6pHXzwRXzLrjbPGUKkM2WMkpTZB13dZh8G";
export const MRTD =
  "c7b60e6e7655074d2e772e737c385b08fb8e15d8628bb9fb3d0ff08b98263ef26e5a40733568c07f45778a4f91ef2c01";
export const BASE_URL = "https://tee.conpi.network/v1";
export const PROXY_KEY = "cpk_live_9f83a0e1c841bb45";
export const TERMS_HASH = "0x7f3a91c4d8e20b11c21e";

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
  create: "8sKp2mQn7vLx4RcTdYh1aWbUe3Nf6GjH9ZkC5DpA2qR",
  terms: "3fH8aLk2pQv9sNwE6rTbYc4uXd1Zm7GjA5kP8hCqR2e",
  accept: "6dR1nQw8eYt4uHbK2cLp9sVmA3xZ7fGj5NkC1pDqW8a",
  depositBuyer: "2kP9sLm4vXc7nRbT1hYw6eQa8uZd3fGj5CkA9pNqE4r",
  depositSeller: "9aWc3nQe6rTb8uYd1kLp4sVm7xZ2fGj5HkC8pDqA1n",
  activate: "4hN2pLq8eYt6uRbK1cVm9sXd3aZ7fGj5WkC2nDpQ8e",
  stage25: "7cK4mNq1pLs8vXbT3hYw6eRa9uZd2fGj5AkC8pDqW1n",
  stage50: "1pQ8eYt4uHbK6cLp2sVm9xZ3fGj5NkC7aDqW8rTbY",
  stage75: "5nR2kP9sLm7vXc1hYw4eQa8uZd6fGj3CkA9pNqE2d",
  stage100: "8eYt1uHbK4cLp6sVm2xZ9fGj5NkC3aDqW7rTbY8hN",
  def: "2sVm9xZ4fGj7NkC1aDqW5rTbY8hN3pLq6eYt9uHbK",
  claim: "6cLp2sVm8xZ1fGj4NkC7aDqW3rTbY5hN9pLq2eYt8",
  claim2: "9uHbK1cLp4sVm7xZ2fGj6NkC8aDqW3rTbY5hN1pLq",
  pause: "3aDqW8rTbY1hN5pLq9eYt2uHbK6cLp4sVm7xZ8fGj",
};
