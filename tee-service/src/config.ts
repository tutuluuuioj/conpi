import dotenv from "dotenv";
dotenv.config();

export const CONFIG = {
  port: parseInt(process.env.PORT || "3000", 10),
  host: process.env.HOST || "0.0.0.0",
  networkId: process.env.NEAR_NETWORK || "testnet",
  nodeUrl: process.env.NEAR_NODE_URL || "https://rpc.testnet.near.org",
  contractId: process.env.CONTRACT_ID || "dev-20261103062448-30583839049419.testnet",
  daoId: process.env.DAO_ID || "dev-20261103021740-59711933581376.testnet",
  dstackSocketPath: process.env.DSTACK_SOCKET_PATH || "/var/run/tappd.sock",
  isEnclave: process.env.IS_ENCLAVE === "true" || process.env.NODE_ENV === "production",
  // Real measured MRTD from Phala Intel TDX CVM
  mrtd: process.env.TEE_MRTD || "7fe60787222bd394cb516abca2435f22f035ab2cc9c0a4b4b3b148e46297f3d931a237b72f359052c6e657d8c1409173",
};
