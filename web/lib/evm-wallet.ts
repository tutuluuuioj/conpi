import {
  createPublicClient,
  createWalletClient,
  custom,
  http,
  erc20Abi,
  parseUnits,
  parseEther,
  formatUnits,
  formatEther,
  type Address,
  type Hash,
} from "viem";
import { baseSepolia } from "viem/chains";
import {
  BASE_SEPOLIA_CHAIN_ID,
  BASE_SEPOLIA_USDC,
  BASE_SEPOLIA_RPC,
} from "./chain-signatures";

export const basePublicClient = createPublicClient({
  chain: baseSepolia,
  transport: http(BASE_SEPOLIA_RPC),
});

export function isMetaMaskInstalled(): boolean {
  if (typeof window === "undefined") return false;
  return Boolean((window as any).ethereum);
}

export function getEvmProvider(): any | null {
  if (typeof window === "undefined") return null;
  return (window as any).ethereum || null;
}

export async function connectMetaMask(): Promise<{ address: Address; chainId: number }> {
  const provider = getEvmProvider();
  if (!provider) {
    throw new Error("No EVM wallet detected. Please install MetaMask or Coinbase Wallet.");
  }

  const walletClient = createWalletClient({
    chain: baseSepolia,
    transport: custom(provider),
  });

  const [address] = await walletClient.requestAddresses();

  // Attempt to switch to Base Sepolia
  try {
    await walletClient.switchChain({ id: baseSepolia.id });
  } catch (err: any) {
    if (err?.code === 4902) {
      await walletClient.addChain({ chain: baseSepolia });
    } else {
      throw err;
    }
  }

  return {
    address: address as Address,
    chainId: baseSepolia.id,
  };
}

export async function getBaseUsdcBalance(address: Address): Promise<string> {
  try {
    const raw = await basePublicClient.readContract({
      address: BASE_SEPOLIA_USDC,
      abi: erc20Abi,
      functionName: "balanceOf",
      args: [address],
    });
    return formatUnits(raw, 6);
  } catch {
    return "0.00";
  }
}

export async function getBaseEthBalance(address: Address): Promise<string> {
  try {
    const raw = await basePublicClient.getBalance({ address });
    return formatUnits(raw, 18);
  } catch {
    return "0.00";
  }
}

export async function sendBaseUsdcDeposit(params: {
  vaultAddress: Address;
  amountUsdc: number | string;
}): Promise<{ txHash: Hash; blockNumber: bigint }> {
  const provider = getEvmProvider();
  if (!provider) {
    throw new Error("No EVM wallet found. Please install MetaMask.");
  }

  const walletClient = createWalletClient({
    chain: baseSepolia,
    transport: custom(provider),
  });

  const [account] = await walletClient.requestAddresses();
  await walletClient.switchChain({ id: baseSepolia.id });

  // Base Sepolia USDC has 6 decimals
  const atomic = parseUnits(params.amountUsdc.toString(), 6);
  if (atomic <= BigInt(0)) {
    throw new Error("Deposit amount must be greater than zero");
  }

  const txHash = await walletClient.writeContract({
    address: BASE_SEPOLIA_USDC,
    abi: erc20Abi,
    functionName: "transfer",
    args: [params.vaultAddress, atomic],
    account,
  });

  const receipt = await basePublicClient.waitForTransactionReceipt({
    hash: txHash,
    confirmations: 1,
  });

  // Automatically seed the vault with a tiny amount of ETH (0.0005 ETH) for automated milestone gas
  // so the user never has to manually send ETH to different vault addresses!
  try {
    const vaultBal = await basePublicClient.getBalance({ address: params.vaultAddress });
    if (vaultBal < parseEther("0.0002")) {
      console.log(`[sendBaseUsdcDeposit] Vault has low gas (${vaultBal.toString()} wei). Auto-seeding 0.0005 ETH...`);
      const gasTx = await walletClient.sendTransaction({
        to: params.vaultAddress,
        value: parseEther("0.0005"),
        account,
      });
      await basePublicClient.waitForTransactionReceipt({ hash: gasTx, confirmations: 1 });
      console.log(`[sendBaseUsdcDeposit] Vault gas auto-seeded: ${gasTx}`);
    }
  } catch (gasErr) {
    console.warn("[sendBaseUsdcDeposit] Vault gas auto-seed warning (proceeding):", gasErr);
  }

  return {
    txHash,
    blockNumber: receipt.blockNumber,
  };
}

export async function seedVaultGas(vaultAddress: Address, amountEth: string = "0.0005"): Promise<Hash> {
  const provider = getEvmProvider();
  if (!provider) {
    throw new Error("No EVM wallet found. Please install MetaMask.");
  }

  const walletClient = createWalletClient({
    chain: baseSepolia,
    transport: custom(provider),
  });

  const [account] = await walletClient.requestAddresses();
  await walletClient.switchChain({ id: baseSepolia.id });

  const txHash = await walletClient.sendTransaction({
    to: vaultAddress,
    value: parseEther(amountEth),
    account,
  });

  await basePublicClient.waitForTransactionReceipt({
    hash: txHash,
    confirmations: 1,
  });

  return txHash;
}

export function disconnectEvmWallet(): void {
  if (typeof window !== "undefined") {
    try {
      localStorage.removeItem("conpi_evm_address");
      localStorage.removeItem("conpi_evm_wallet");
    } catch {}
  }
}
