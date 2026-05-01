import { ethers } from 'ethers';
import { VaultABI } from './abis/VaultABI';

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
   * Connect to vault with signer for write operations
   */
  connect(signer: ethers.Signer): Vault {
    return new Vault({
      contractAddress: this.address,
      provider: signer,
    });
  }

  /**
   * Get vault information (total assets, total supply, APY, lock period)
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
    };
  }

  /**
   * Get user's vault balance
   * @param userAddress - Address of the user
   * @returns User's balance in vault shares
   */
  async getBalance(userAddress: string): Promise<bigint> {
    const balance = await this.contract.balanceOf(userAddress);
    return BigInt(balance.toString());
  }

  /**
   * Get user's underlying assets balance
   * @param userAddress - Address of the user
   * @returns Converted balance in underlying asset
   */
  async getAssetsBalance(userAddress: string): Promise<bigint> {
    const shares = await this.getBalance(userAddress);
    return this.convertToAssets(shares);
  }

  /**
   * Convert shares to underlying assets
   */
  async convertToAssets(shares: bigint): Promise<bigint> {
    const result = await this.contract.convertToAssets(shares);
    return BigInt(result.toString());
  }

  /**
   * Convert underlying assets to shares
   */
  async convertToShares(assets: bigint): Promise<bigint> {
    const result = await this.contract.convertToShares(assets);
    return BigInt(result.toString());
  }

  /**
   * Deposit assets into vault
   * @param params - Deposit parameters
   * @param signer - Optional signer (uses connected signer if not provided)
   */
  async deposit(params: DepositParams, signer?: ethers.Signer): Promise<ethers.ContractTransaction> {
    const signerToUse = signer || (this.provider as ethers.Signer);
    
    if (!signerToUse || !('sendTransaction' in signerToUse)) {
      throw new Error('Signer required for deposit operation');
    }

    const contractWithSigner = this.contract.connect(signerToUse);
    const depositFunc = this.contract.getFunction('deposit');
    const tx = await depositFunc(params.amount, {
      value: params.amount,
    });
    
    return tx;
  }

  /**
   * Withdraw assets from vault
   * @param params - Withdraw parameters
   * @param signer - Optional signer (uses connected signer if not provided)
   */
  async withdraw(params: WithdrawParams, signer?: ethers.Signer): Promise<ethers.ContractTransaction> {
    const signerToUse = signer || (this.provider as ethers.Signer);
    
    if (!signerToUse || !('sendTransaction' in signerToUse)) {
      throw new Error('Signer required for withdraw operation');
    }

    const contractWithSigner = this.contract.connect(signerToUse);
    const withdrawFunc = this.contract.getFunction('withdraw');
    const tx = await withdrawFunc(
      params.amount,
      await signerToUse.getAddress(),
      await signerToUse.getAddress()
    );
    
    return tx;
  }

  /**
   * Claim pending rewards
   * @param signer - Optional signer (uses connected signer if not provided)
   */
  async claimRewards(signer?: ethers.Signer): Promise<ethers.ContractTransaction> {
    const signerToUse = signer || (this.provider as ethers.Signer);
    
    if (!signerToUse || !('sendTransaction' in signerToUse)) {
      throw new Error('Signer required for claim rewards operation');
    }

    const contractWithSigner = this.contract.connect(signerToUse);
    const claimRewardsFunc = this.contract.getFunction('claimRewards');
    const tx = await claimRewardsFunc();
    
    return tx;
  }

  /**
   * Get pending rewards for a user
   * @param userAddress - Address of the user
   */
  async getPendingRewards(userAddress: string): Promise<bigint> {
    const rewards = await this.contract.pendingRewards(userAddress);
    return BigInt(rewards.toString());
  }

  /**
   * Estimate deposit gas cost
   */
  async estimateDepositGas(amount: bigint): Promise<bigint> {
    const depositFunc = this.contract.getFunction('deposit');
    const gas = await depositFunc.estimateGas(amount);
    return BigInt(gas.toString());
  }

  /**
   * Estimate withdraw gas cost
   */
  async estimateWithdrawGas(amount: bigint): Promise<bigint> {
    const withdrawFunc = this.contract.getFunction('withdraw');
    const gas = await withdrawFunc.estimateGas(amount);
    return BigInt(gas.toString());
  }
}

export default Vault;