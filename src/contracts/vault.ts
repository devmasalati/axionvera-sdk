import { ethers } from 'ethers';
import { VaultABI } from './abis/VaultABI';
import { ValidationError, InsufficientFundsError, ContractError } from '../errors/axionveraError';

export interface VaultConfig {
  contractAddress: string;
  provider: ethers.Provider | ethers.Signer;
}

export interface DepositParams {
  amount: bigint;
  asset?: string;
  referralCode?: string;
}

export interface WithdrawParams {
  amount: bigint;
  asset?: string;
}

export interface VaultInfo {
  totalAssets: bigint;
  totalSupply: bigint;
  apy: number;
  lockPeriod: number;
}

export class Vault {
  private contract: ethers.Contract;
  private provider: ethers.Provider | ethers.Signer;
  private address: string;

  constructor(config: VaultConfig) {
    this.address = config.contractAddress;
    this.provider = config.provider;
    this.contract = new ethers.Contract(
      config.contractAddress,
      VaultABI,
      config.provider
    );
  }

  /**
   * Connects the vault instance with a signer for write operations.
   * @param signer - The signer to use for transactions
   * @returns A new Vault instance connected with the signer
   * @example
   * ```typescript
   * import { Vault } from "axionvera-sdk";
   * import { ethers } from "ethers";
   *
   * const vault = new Vault({
   *   contractAddress: "0x123...",
   *   provider: provider
   * });
   *
   * const signer = wallet.getSigner();
   * const vaultWithSigner = vault.connect(signer);
   * ```
   */
  connect(signer: ethers.Signer): Vault {
    return new Vault({
      contractAddress: this.address,
      provider: signer,
    });
  }

  /**
   * Retrieves vault information including total assets, total supply, APY, and lock period.
   * @returns Vault information object with metrics
   * @example
   * ```typescript
   * import { Vault } from "axionvera-sdk";
   *
   * const vault = new Vault({
   *   contractAddress: "0x123...",
   *   provider: provider
   * });
   *
   * const info = await vault.getVaultInfo();
   * console.log("Total assets:", info.totalAssets.toString());
   * console.log("APY:", info.apy);
   * console.log("Lock period:", info.lockPeriod);
   * ```
   */
  async getVaultInfo(): Promise<VaultInfo> {
    const [totalAssets, totalSupply, apy, lockPeriod] = await Promise.all([
      this.contract.totalAssets(),
      this.contract.totalSupply(),
      this.contract.apy(),
      this.contract.lockPeriod(),
    ]);

    return {
      totalAssets: BigInt(totalAssets.toString()),
      totalSupply: BigInt(totalSupply.toString()),
      apy: Number(apy) / 10000,
      lockPeriod: Number(lockPeriod),
      apy: apy.toNumber() / 10000,
      lockPeriod: lockPeriod.toNumber(),
    };
  }

  /**
   * Retrieves the user's vault balance in shares.
   * @param userAddress - The wallet address of the user
   * @returns The user's balance as a bigint of vault shares
   * @example
   * ```typescript
   * import { Vault } from "axionvera-sdk";
   *
   * const vault = new Vault({
   *   contractAddress: "0x123...",
   *   provider: provider
   * });
   *
   * const balance = await vault.getBalance("0xuser...");
   * console.log("Vault shares:", balance);
   * ```
   */
  async getBalance(userAddress: string): Promise<bigint> {
    const balance = await this.contract.balanceOf(userAddress);
    return BigInt(balance.toString());
    const result = await this.contract.balanceOf(userAddress);
    return BigInt(result.toString());
  }

  /**
   * Retrieves the user's balance converted to underlying assets.
   * @param userAddress - The wallet address of the user
   * @returns The user's balance as a bigint of underlying assets
   * @example
   * ```typescript
   * import { Vault } from "axionvera-sdk";
   *
   * const vault = new Vault({
   *   contractAddress: "0x123...",
   *   provider: provider
   * });
   *
   * const assetBalance = await vault.getAssetsBalance("0xuser...");
   * console.log("Underlying assets:", assetBalance);
   * ```
   */
  async getAssetsBalance(userAddress: string): Promise<bigint> {
    const shares = await this.getBalance(userAddress);
    return this.convertToAssets(shares);
  }

  /**
   * Converts a given amount of vault shares to the equivalent amount of underlying assets.
   * @param shares - The amount of shares to convert as bigint
   * @returns The equivalent amount of underlying assets as a bigint
   * @example
   * ```typescript
   * import { Vault } from "axionvera-sdk";
   *
   * const vault = new Vault({
   *   contractAddress: "0x123...",
   *   provider: provider
   * });
   *
   * const assets = await vault.convertToAssets(100n);
   * console.log("Assets for 100 shares:", assets);
   * ```
   */
  async convertToAssets(shares: bigint): Promise<bigint> {
    const result = await this.contract.convertToAssets(shares);
    return BigInt(result.toString());
  }

  /**
   * Converts a given amount of underlying assets to the equivalent amount of vault shares.
   * @param assets - The amount of assets to convert as bigint
   * @returns The equivalent amount of vault shares as a bigint
   * @example
   * ```typescript
   * import { Vault } from "axionvera-sdk";
   *
   * const vault = new Vault({
   *   contractAddress: "0x123...",
   *   provider: provider
   * });
   *
   * const shares = await vault.convertToShares(100n);
   * console.log("Shares for 100 assets:", shares);
   * ```
   */
  async convertToShares(assets: bigint): Promise<bigint> {
    const result = await this.contract.convertToShares(assets);
    return BigInt(result.toString());
  }

  /**
   * Deposits assets into the vault and receives vault shares in return.
   * @param params - Deposit parameters including amount as bigint and optional asset/referral
   * @param signer - Optional signer for the transaction (uses connected signer if not provided)
   * @returns The contract transaction object
   * @throws ValidationError if no signer is available
   * @throws InsufficientFundsError if the user has insufficient funds
   * @example
   * ```typescript
   * import { Vault } from "axionvera-sdk";
   *
   * const vault = new Vault({
   *   contractAddress: "0x123...",
   *   provider: signer
   * });
   *
   * const tx = await vault.deposit({
   *   amount: 1000000000000000000n // 1 ETH in wei
   * });
   *
   * await tx.wait();
   * console.log("Deposit confirmed");
   * ```
   */
  async deposit(params: DepositParams, signer?: ethers.Signer): Promise<ethers.ContractTransaction> {
    const signerToUse = signer || (this.provider as ethers.Signer);

    if (!signerToUse || !('sendTransaction' in signerToUse)) {
      throw new ValidationError('Signer required for deposit operation');
    }

    try {
      const contractWithSigner = this.contract.connect(signerToUse);
      const depositFunc = this.contract.getFunction('deposit');
      const tx = await depositFunc(params.amount, {
      const tx = await (contractWithSigner as any).deposit(params.amount, {
        value: params.amount,
      });

      return tx;
    } catch (error) {
      if (error instanceof Error && error.message.toLowerCase().includes('insufficient funds')) {
        throw new InsufficientFundsError('Insufficient funds for deposit', { originalError: error });
      }
      throw new ContractError(`Deposit failed: ${error instanceof Error ? error.message : 'Unknown error'}`, { originalError: error });
    }
  }

  /**
   * Withdraws assets from the vault by burning vault shares.
   * @param params - Withdraw parameters including amount as bigint and optional asset
   * @param signer - Optional signer for the transaction (uses connected signer if not provided)
   * @returns The contract transaction object
   * @throws ValidationError if no signer is available
   * @throws InsufficientFundsError if the user has insufficient vault shares
   * @example
   * ```typescript
   * import { Vault } from "axionvera-sdk";
   *
   * const vault = new Vault({
   *   contractAddress: "0x123...",
   *   provider: signer
   * });
   *
   * const tx = await vault.withdraw({
   *   amount: 1000000000000000000n // 1 ETH in wei
   * });
   *
   * await tx.wait();
   * console.log("Withdrawal confirmed");
   * ```
   */
  async withdraw(params: WithdrawParams, signer?: ethers.Signer): Promise<ethers.ContractTransaction> {
    const signerToUse = signer || (this.provider as ethers.Signer);

    if (!signerToUse || !('sendTransaction' in signerToUse)) {
      throw new ValidationError('Signer required for withdraw operation');
    }

    try {
      const contractWithSigner = this.contract.connect(signerToUse);
      const withdrawFunc = this.contract.getFunction('withdraw');
      const tx = await withdrawFunc(
      const tx = await (contractWithSigner as any).withdraw(
        params.amount,
        await signerToUse.getAddress(),
        await signerToUse.getAddress()
      );

      return tx;
    } catch (error) {
      if (error instanceof Error && error.message.toLowerCase().includes('insufficient funds')) {
        throw new InsufficientFundsError('Insufficient funds for withdrawal', { originalError: error });
      }
      throw new ContractError(`Withdrawal failed: ${error instanceof Error ? error.message : 'Unknown error'}`, { originalError: error });
    }
  }

  /**
   * Claims pending rewards for the connected user.
   * @param signer - Optional signer for the transaction (uses connected signer if not provided)
   * @returns The contract transaction object
   * @throws ValidationError if no signer is available
   * @example
   * ```typescript
   * import { Vault } from "axionvera-sdk";
   *
   * const vault = new Vault({
   *   contractAddress: "0x123...",
   *   provider: signer
   * });
   *
   * const tx = await vault.claimRewards();
   * await tx.wait();
   * console.log("Rewards claimed");
   * ```
   */
  async claimRewards(signer?: ethers.Signer): Promise<ethers.ContractTransaction> {
    const signerToUse = signer || (this.provider as ethers.Signer);

    if (!signerToUse || !('sendTransaction' in signerToUse)) {
      throw new ValidationError('Signer required for claim rewards operation');
    }

    try {
      const contractWithSigner = this.contract.connect(signerToUse);
      const claimRewardsFunc = this.contract.getFunction('claimRewards');
      const tx = await claimRewardsFunc();
      const tx = await (contractWithSigner as any).claimRewards();

      return tx;
    } catch (error) {
      throw new ContractError(`Claim rewards failed: ${error instanceof Error ? error.message : 'Unknown error'}`, { originalError: error });
    }
  }

  /**
   * Retrieves the pending rewards for a specific user.
   * @param userAddress - The wallet address of the user
   * @returns The pending rewards amount as a bigint
   * @example
   * ```typescript
   * import { Vault } from "axionvera-sdk";
   *
   * const vault = new Vault({
   *   contractAddress: "0x123...",
   *   provider: provider
   * });
   *
   * const rewards = await vault.getPendingRewards("0xuser...");
   * console.log("Pending rewards:", rewards);
   * ```
   */
  async getPendingRewards(userAddress: string): Promise<bigint> {
    const rewards = await this.contract.pendingRewards(userAddress);
    return BigInt(rewards.toString());
    const result = await this.contract.pendingRewards(userAddress);
    return BigInt(result.toString());
  }

  /**
   * Estimates the gas cost for a deposit transaction.
   * @param amount - The amount to deposit as bigint
   * @returns The estimated gas cost as a bigint
   * @example
   * ```typescript
   * import { Vault } from "axionvera-sdk";
   *
   * const vault = new Vault({
   *   contractAddress: "0x123...",
   *   provider: provider
   * });
   *
   * const gasEstimate = await vault.estimateDepositGas(1000000000000000000n);
   * console.log("Estimated gas:", gasEstimate);
   * ```
   */
  async estimateDepositGas(amount: bigint): Promise<bigint> {
    const depositFunc = this.contract.getFunction('deposit');
    const gas = await depositFunc.estimateGas(amount);
    return BigInt(gas.toString());
    const result = await (this.contract.estimateGas as any).deposit(amount);
    return BigInt(result.toString());
  }

  /**
   * Estimates the gas cost for a withdrawal transaction.
   * @param amount - The amount to withdraw as bigint
   * @returns The estimated gas cost as a bigint
   * @example
   * ```typescript
   * import { Vault } from "axionvera-sdk";
   *
   * const vault = new Vault({
   *   contractAddress: "0x123...",
   *   provider: provider
   * });
   *
   * const gasEstimate = await vault.estimateWithdrawGas(1000000000000000000n);
   * console.log("Estimated gas:", gasEstimate);
   * ```
   */
  async estimateWithdrawGas(amount: bigint): Promise<bigint> {
    const withdrawFunc = this.contract.getFunction('withdraw');
    const gas = await withdrawFunc.estimateGas(amount);
    return BigInt(gas.toString());
    const result = await (this.contract.estimateGas as any).withdraw(amount);
    return BigInt(result.toString());
  }
}

export default Vault;