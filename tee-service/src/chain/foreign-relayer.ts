import {
  getAddress,
  type Address,
  type Hash,
  type Hex,
} from "viem";
import { baseClient, BaseClient } from "./base-client.js";
import { foreignVaultManager, ForeignVaultManager } from "./foreign-vault.js";
import { CONFIG } from "../config.js";

export interface BroadcastResult {
  success: boolean;
  txHash?: Hash;
  vaultAddress?: Address;
  error?: string;
  confirmations?: bigint;
}

export interface ForeignSignEvent {
  dealId: number;
  stage: number;
  chainId: number;
  recipient: Address;
  amountAtomic: bigint;
  sighashHex: Hash;
  rHex: string;
  sHex: string;
  recoveryId: number;
  nonce?: number;
}

export class ForeignRelayer {
  private base: BaseClient;
  private vaultManager: ForeignVaultManager;
  private nearContractId: string;

  constructor(
    base: BaseClient = baseClient,
    vaultManager: ForeignVaultManager = foreignVaultManager,
    nearContractId: string = CONFIG.contractId
  ) {
    this.base = base;
    this.vaultManager = vaultManager;
    this.nearContractId = nearContractId;
  }

  /**
   * Derives vault address for a deal ID.
   */
  public getVaultAddress(dealId: number, accountId?: string): Address {
    const targetAccount = accountId || this.nearContractId;
    return this.vaultManager.deriveVaultAddress(targetAccount, dealId).address;
  }

  /**
   * Checks if a vault on Base Sepolia has sufficient ETH for gas.
   */
  public async checkVaultGas(vaultAddress: Address, minGasEth: bigint = 50_000_000_000_000n): Promise<{
    hasGas: boolean;
    balanceEth: bigint;
  }> {
    const balance = await this.base.getEthBalance(vaultAddress);
    return {
      hasGas: balance >= minGasEth,
      balanceEth: balance,
    };
  }

  /**
   * Sponsors gas for an EVM vault on Base Sepolia if it has insufficient ETH.
   */
  public async sponsorVaultGas(
    vaultAddress: Address,
    amountEth: bigint = 200_000_000_000_000n // 0.0002 ETH
  ): Promise<{ funded: boolean; txHash?: Hash; error?: string }> {
    const gasCheck = await this.checkVaultGas(vaultAddress);
    if (gasCheck.hasGas) {
      return { funded: false };
    }

    const operatorKey = (process.env.OPERATOR_EVM_PRIVATE_KEY || process.env.BASE_SEPOLIA_RELAYER_KEY) as Hex | undefined;
    if (!operatorKey) {
      return {
        funded: false,
        error: "Vault has 0 ETH and no OPERATOR_EVM_PRIVATE_KEY configured to sponsor gas.",
      };
    }

    try {
      const { createWalletClient, http } = await import("viem");
      const { privateKeyToAccount } = await import("viem/accounts");
      const { baseSepolia } = await import("viem/chains");

      const account = privateKeyToAccount(operatorKey.startsWith("0x") ? operatorKey : `0x${operatorKey}`);
      const walletClient = createWalletClient({
        account,
        chain: baseSepolia,
        transport: http(process.env.BASE_SEPOLIA_RPC || "https://sepolia.base.org"),
      });

      const hash = await walletClient.sendTransaction({
        to: vaultAddress,
        value: amountEth,
      });

      // Await confirmation so the gas balance is live on-chain before the vault transaction is broadcast
      await this.base.waitForTransactionReceipt(hash);

      return { funded: true, txHash: hash };
    } catch (err: any) {
      return { funded: false, error: err?.message || String(err) };
    }
  }

  /**
   * Processes a ForeignTxSigned event, builds raw signed EVM transaction,
   * verifies it cryptographically against the derived vault, and broadcasts
   * to Base Sepolia via JSON-RPC.
   */
  public async broadcastSignedPayout(event: ForeignSignEvent): Promise<BroadcastResult> {
    try {
      const recipient = getAddress(event.recipient);
      const vault = this.getVaultAddress(event.dealId);

      // Determine nonce on Base Sepolia if not provided
      const nonce = event.nonce !== undefined ? event.nonce : await this.base.getNonce(vault);

      // Rebuild the expected EIP-1559 transaction
      const prepared = this.vaultManager.buildErc20TransferTx({
        recipient,
        amountAtomic: event.amountAtomic,
        nonce,
      });

      // Verify signature recovers to expected vault
      const sigValid = await this.vaultManager.verifySignatureMatchesVault(
        prepared.sighash,
        {
          rHex: event.rHex,
          sHex: event.sHex,
          recoveryId: event.recoveryId,
        },
        vault
      );

      if (!sigValid) {
        return {
          success: false,
          vaultAddress: vault,
          error: `MPC signature does not recover to expected Base Sepolia vault ${vault}`,
        };
      }

      // Ensure vault has gas to pay the ERC-20 transfer fee on Base Sepolia
      let gas = await this.checkVaultGas(vault);
      if (!gas.hasGas) {
        const sponsorRes = await this.sponsorVaultGas(vault);
        if (sponsorRes.funded) {
          gas = await this.checkVaultGas(vault);
        } else if (sponsorRes.error) {
          console.warn(`[ForeignRelayer] Vault ${vault} low gas warning: ${sponsorRes.error}`);
          return {
            success: false,
            vaultAddress: vault,
            error: `Vault has 0 ETH and gas sponsorship failed: ${sponsorRes.error}`,
          };
        }
      }

      // Assemble final signed raw EVM transaction bytes
      const signedRawTx = this.vaultManager.assembleSignedTransaction(prepared.tx, {
        rHex: event.rHex,
        sHex: event.sHex,
        recoveryId: event.recoveryId,
      });

      // Broadcast to Base Sepolia
      const txHash = await this.base.broadcastRawTransaction(signedRawTx);

      return {
        success: true,
        txHash,
        vaultAddress: vault,
      };
    } catch (err: any) {
      return {
        success: false,
        error: err?.message || String(err),
      };
    }
  }
}

export const foreignRelayer = new ForeignRelayer();
