import dotenv from "dotenv";
dotenv.config();

export const CONFIG = {
  port: parseInt(process.env.PORT || "8080", 10),
  host: process.env.HOST || "0.0.0.0",
  networkId: process.env.NEAR_NETWORK || "testnet",
  nodeUrl: process.env.NEAR_NODE_URL || "https://rpc.testnet.near.org",
  contractId: process.env.CONTRACT_ID || "dev-20261103062448-30583839049419.testnet",
  daoId: process.env.DAO_ID || "dev-20261103021740-59711933581376.testnet",
  dstackSocketPath: process.env.DSTACK_SOCKET_PATH || "/var/run/tappd.sock",
  isEnclave: process.env.IS_ENCLAVE === "true" || process.env.NODE_ENV === "production",
  // Expected measurement (MRTD) published on-chain
  mrtd: process.env.TEE_MRTD || "c7b60e6e7655074d2e772e737c385b08fb8e15d8628bb9fb3d0ff08b98263ef26e5a40733568c07f45778a4f91ef2c01",
};
