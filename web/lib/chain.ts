export const CONTRACT_ID = "dev-20261103062448-30583839049419.testnet";
export const DAO_ID = "dev-20261103021740-59711933581376.testnet";
export const CODE_HASH = "443254174227e76be673a8036d663cf7fe2bc70f2414773129b3f008423ad21f";
export const BASE_URL =
  process.env.NEXT_PUBLIC_TEE_BASE_URL ||
  "https://2dba4d4f68ab082e126801c1271d5fbc1abff3bd-3000.dstack-pha-prod5.phala.network/v1";
export const TERMS_HASH = "0xe7961b7787dc9887582f06fae01cd4004e8e6f904098f2bb43815ead3b1bd6f4";

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
  proposeTeeSigner_Member1: "8rb7GuSuotayeBsLn9ZXrXUuCXGgKtXMSvqzL6yKaCZK",
  confirmTeeSigner_Member2: "E8vvmgVpWbYJxgENSwADVx8wQN7HhYvGkve8NiPC3RnA",
  executeTeeSigner_Member1: "5WcH7sQ9fxqTuihSeN4kEuVDPj6tTJVCfNdQUpkK3sxJ",
  confirmExecuteTeeSigner_Member2: "F88i9ZMfRnfAqStcAkErw7A5w2D1FNfg8Gx5U4K6GmHw",
  create: "7BYAhhJpVfhFcHM4dZKpcMRQudtC7bXPtwYdSw3ii77i",
  terms: "3fH8aLk2pQv9sNwE6rTbYc4uXd1Zm7GjA5kP8hCqR2e",
  accept: "7oCqc5PDP7AGsVioKCbHVp5ki54jxthf6DJsFpJucgjB",
  depositBuyer: "9GMsf3VtjZ2b56WZF1zPSpy7c7NxNHfFZrqvzfH7YgyW",
  depositSeller: "JBcGUPuRSS2fbtmMT5U1qq5XsCfWBuUXcVAbBp9Qu2dZ",
  activate: "FtUNLdjWnTcdDVpYznd7VNqr5juKwSCwpnyaakZCFJMH",
  stage25: "BeqVL6fsgCaPHEE1kz4MPxc5y5Q5bN3YRhPG8X18ZF8G",
  stage50: "1pQ8eYt4uHbK6cLp2sVm9xZ3fGj5NkC7aDqW8rTbY",
  stage75: "5nR2kP9sLm7vXc1hYw4eQa8uZd6fGj3CkA9pNqE2d",
  stage100: "8eYt1uHbK4cLp6sVm2xZ9fGj5NkC3aDqW7rTbY8hN",
  def: "F5ToQujxGn763jQGsY5ccT1AN4nePoodgBRp5oiC1pMu",
  claim: "6cLp2sVm8xZ1fGj4NkC7aDqW3rTbY5hN9pLq2eYt8",
  claim2: "9uHbK1cLp4sVm7xZ2fGj6NkC8aDqW3rTbY5hN1pLq",
  pause: "3aDqW8rTbY1hN5pLq9eYt2uHbK6cLp4sVm7xZ8fGj",
};
