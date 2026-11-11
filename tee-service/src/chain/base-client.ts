import {
  createPublicClient,
  http,
  erc20Abi,
  decodeEventLog,
  getAddress,
  type Hash,
  type Address,
} from "viem";
import { baseSepolia } from "viem/chains";

export const BASE_SEPOLIA_USDC: Address = "0x036CbD53842c5426634e7929541eC2318f3dCF7e";
export const BASE_SEPOLIA_CHAIN_ID = 84532;

export interface DepositVerificationResult {
  ok: boolean;
  error?: string;
  txHash?: Hash;
  blockNumber?: bigint;
  confirmations?: bigint;
  sender?: Address;
  vault?: Address;
  amountAtomic?: string;
}

export class BaseClient {
  private client;
  public readonly chainId = BASE_SEPOLIA_CHAIN_ID;
  public readonly usdcAddress = BASE_SEPOLIA_USDC;

  constructor(rpcUrl: string = process.env.BASE_SEPOLIA_RPC || "https://sepolia.base.org") {
    this.client = createPublicClient({
      chain: baseSepolia,
      transport: http(rpcUrl),
    });
  }

  public async getBlockNumber(): Promise<bigint> {
    return this.client.getBlockNumber();
  }

  public async getUsdcBalance(address: Address): Promise<bigint> {
    return this.client.readContract({
      address: this.usdcAddress,
      abi: erc20Abi,
      functionName: "balanceOf",
      args: [address],
    });
  }

  public async getEthBalance(address: Address): Promise<bigint> {
    return this.client.getBalance({ address });
  }

  public async getNonce(address: Address): Promise<number> {
    return this.client.getTransactionCount({ address });
  }

  public async verifyDeposit(params: {
    txHash: Hash;
    expectedVault: Address;
    expectedAmountAtomic: bigint | string;
    minConfirmations?: bigint;
  }): Promise<DepositVerificationResult> {
    try {
      const receipt = await this.client.getTransactionReceipt({ hash: params.txHash });
      if (!receipt) {
        return { ok: false, error: "Transaction receipt not found on Base Sepolia" };
      }

      if (receipt.status !== "success") {
        return { ok: false, error: "Transaction reverted on Base Sepolia" };
      }

      const latestBlock = await this.client.getBlockNumber();
      const confirmations = latestBlock - receipt.blockNumber + 1n;
      const minConf = params.minConfirmations ?? 1n;
      if (confirmations < minConf) {
        return {
          ok: false,
          error: `Insufficient confirmations: ${confirmations} < ${minConf}`,
        };
      }

      const targetVault = getAddress(params.expectedVault);
      const minAmount = BigInt(params.expectedAmountAtomic);

      // Find valid USDC transfer log
      let matchingTransfer: { from: Address; to: Address; value: bigint } | null = null;
      for (const log of receipt.logs) {
        if (getAddress(log.address) !== this.usdcAddress) continue;
        try {
          const decoded = decodeEventLog({
            abi: erc20Abi,
            data: log.data,
            topics: log.topics,
          });

          if (decoded.eventName === "Transfer") {
            const { from, to, value } = decoded.args;
            if (getAddress(to) === targetVault && value >= minAmount) {
              matchingTransfer = { from: getAddress(from), to: getAddress(to), value };
              break;
            }
          }
        } catch {
          // Log not a standard Transfer event; ignore
        }
      }

      if (!matchingTransfer) {
        return {
          ok: false,
          error: `No matching USDC Transfer to vault ${targetVault} with minimum amount ${minAmount}`,
        };
      }

      return {
        ok: true,
        txHash: params.txHash,
        blockNumber: receipt.blockNumber,
        confirmations,
        sender: matchingTransfer.from,
        vault: matchingTransfer.to,
        amountAtomic: matchingTransfer.value.toString(),
      };
    } catch (err: any) {
      return { ok: false, error: err?.message || String(err) };
    }
  }

  public async waitForTransactionReceipt(hash: Hash): Promise<any> {
    return this.client.waitForTransactionReceipt({ hash });
  }

  public async broadcastRawTransaction(serializedTxHex: `0x${string}`): Promise<Hash> {
    return this.client.sendRawTransaction({
      serializedTransaction: serializedTxHex,
    });
  }
}

export const baseClient = new BaseClient();
