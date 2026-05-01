import {
  Address,
  rpc,
  nativeToScVal,
  xdr,
  TransactionBuilder
} from "@stellar/stellar-sdk";

import { StellarClient } from "../client/stellarClient";
import { WalletConnector } from "../wallet/walletConnector";
import { ContractCallParams } from "../transaction/transactionSigner";
import { decodeXdrBase64 } from "../utils/xdrCache";
import { SorobanAuthEntry } from "../utils/sorobanAuth";
import { BaseContract, BaseContractConfig } from "./BaseContract";

// Re-export so consumers never need to import BaseContract separately.
export { BaseContractConfig };

// ─── Strict argument interfaces ───────────────────────────────────────────────
// These are the precise shapes passed to the underlying contract methods.
// Using them (instead of a generic Record) means typos like { amout: 1n }
// are caught at compile time in the consumer's IDE.

/** Core arguments for the vault `deposit` contract call. */
export type DepositArgs = {
  /** Amount of tokens to deposit (i128). */
  readonly amount: bigint;
  /** Depositing address; defaults to the wallet's public key when omitted. */
  readonly from?: string;
};

/** Core arguments for the vault `withdraw` contract call. */
export type WithdrawArgs = {
  /** Amount of tokens to withdraw (i128). */
  readonly amount: bigint;
  /** Destination address; defaults to the wallet's public key when omitted. */
  readonly to?: string;
};

/** Core arguments for the vault `claim_rewards` contract call (no required fields). */
export type ClaimArgs = Record<string, never>;

// ─── Extended param types (args + SDK plumbing) ───────────────────────────────

/**
 * Configuration for the Vault contract wrapper.
 */
export type VaultConfig = {
  /** The stellar client for network operations */
  client: StellarClient;
  /** The contract ID of the Vault */
  contractId: string;
  /** The wallet connector for signing transactions */
  wallet: WalletConnector;
};

/**
 * Parameters for deposit operations.
 */
export type DepositParams = DepositArgs & {
  /** Optional transaction builder to append operation to existing transaction */
  txBuilder?: TransactionBuilder;
  /** Additional Soroban auth entries for multisig / delegation flows. */
  authEntries?: SorobanAuthEntry[];
};

/**
 * Parameters for withdraw operations.
 */
export type WithdrawParams = WithdrawArgs & {
  /** Optional transaction builder to append operation to existing transaction */
  txBuilder?: TransactionBuilder;
  /** Additional Soroban auth entries for multisig / delegation flows. */
  authEntries?: SorobanAuthEntry[];
};

/**
 * Parameters for claim rewards operations.
 */
export type ClaimRewardsParams = {
  /** Optional transaction builder to append operation to existing transaction */
  txBuilder?: TransactionBuilder;
  /** Additional Soroban auth entries for multisig / delegation flows. */
  authEntries?: SorobanAuthEntry[];
};

/**
 * Vault contract information.
 */
export type VaultInfo = {
  /** Total assets in the vault */
  totalAssets: bigint;
  /** Total supply of vault tokens */
  totalSupply: bigint;
  /** Current APY */
  apy: number;
  /** Lock period in seconds */
  lockPeriod: number;
};

/**
 * High-level wrapper for the Axionvera Vault smart contract.
 *
 * Extends {@link BaseContract} to inherit the strongly-typed generic
 * `invokeMethod` helper, which enforces that callers pass the exact
 * {@link DepositArgs} / {@link WithdrawArgs} / {@link ClaimArgs} shapes —
 * a typo such as `{ amout: 1n }` is a compile-time error.
 *
 * Also supports injecting custom Soroban authorization entries (e.g. for
 * multisig or delegated-authority dApps) via the `authEntries` option on
 * every mutating method.
 *
 * Supports composing multiple operations into a single transaction via the
 * optional `txBuilder` parameter, enabling atomic multi-operation transactions.
 *
 * @example
 * ```typescript
 * const vault = new VaultContract({
 *   client,
 *   contractId: "C...",
 *   wallet
 * });
 *
 * // Simple deposit
 * const result = await vault.deposit({ amount: 1000n });
 *
 * // Deposit with a custom admin auth entry (multisig)
 * const adminAuth = buildSorobanAddressAuthEntry({ ... });
 * const result = await vault.deposit({ amount: 1000n, authEntries: [adminAuth] });
 *
 * // Composite transaction: Deposit + Claim Rewards
 * const builder = buildBaseTransaction({ sourceAccount: account, networkPassphrase });
 * await vault.deposit({ amount: 1000n, txBuilder: builder });
 * await vault.claimRewards({ txBuilder: builder });
 * const tx = builder.build();
 * ```
 */
export class VaultContract extends BaseContract {
  /**
   * Creates a new VaultContract instance for interacting with the Axionvera Vault smart contract.
   * @param config - Configuration including client, contract ID, and wallet connector
   * @example
   * ```typescript
   * import { VaultContract, StellarClient, LocalKeypairWalletConnector } from "axionvera-sdk";
   * import { Keypair } from "@stellar/stellar-sdk";
   *
   * const client = new StellarClient({ network: "testnet" });
   * const keypair = Keypair.fromSecret("S...");
   * const wallet = new LocalKeypairWalletConnector(keypair);
   *
   * const vault = new VaultContract({
   *   client,
   *   contractId: "C...",
   *   wallet
   * });
   * ```
   */
  constructor(config: VaultConfig) {
    super(config);
  }

  /**
* Deposits tokens into the vault and receives vault shares in return.
   *
   * @param params - Deposit parameters including amount as bigint and optional source account (see {@link DepositParams}).
   * @returns The transaction result, or the transaction builder if txBuilder was provided for composition.
   * @example
   * ```typescript
   * import { VaultContract } from "axionvera-sdk";
   *
   * // Simple deposit
   * const result = await vault.deposit({ amount: 1000n });
   * console.log("Deposit successful:", result);
   *
   * // Deposit with specific source account
   * const result2 = await vault.deposit({
   * amount: 5000n,
   * from: "GD5JPQ7VKFOVRWPOEX74JYXHHFNTFZ2JE5WZ4K2MWTROVHMWHD7KUZ2V"
   * });
   * ```
   */
  async deposit(params: DepositParams): Promise<any> {
    const from = params.from ?? await this.wallet.getPublicKey();

    return this.invokeMethod<DepositArgs>(
      'deposit',
      { amount: params.amount, from },
      (args) => [
        nativeToScVal(args.amount, { type: 'i128' }),
        new Address(args.from!).toScVal(),
      ],
      {
        txBuilder: params.txBuilder,
        authEntries: params.authEntries,
        sourceAccount: from,
      },
    );
  }

  /**
* Withdraws tokens from the vault by burning vault shares.
   *
   * @param params - Withdraw parameters including amount as bigint and optional destination account (see {@link WithdrawParams}).
   * @returns The transaction result, or the transaction builder if txBuilder was provided for composition.
   * @example
   * ```typescript
   * import { VaultContract } from "axionvera-sdk";
   *
   * // Simple withdrawal
   * const result = await vault.withdraw({ amount: 1000n });
   * console.log("Withdrawal successful:", result);
   *
   * // Withdraw to specific destination
   * const result2 = await vault.withdraw({
   * amount: 5000n,
   * to: "GD5JPQ7VKFOVRWPOEX74JYXHHFNTFZ2JE5WZ4K2MWTROVHMWHD7KUZ2V"
   * });
   * ```
   */
  async withdraw(params: WithdrawParams): Promise<any> {
    const to = params.to ?? await this.wallet.getPublicKey();
    const sourceAccount = await this.wallet.getPublicKey();

    return this.invokeMethod<WithdrawArgs>(
      'withdraw',
      { amount: params.amount, to },
      (args) => [
        nativeToScVal(args.amount, { type: 'i128' }),
        new Address(args.to!).toScVal(),
      ],
      {
        txBuilder: params.txBuilder,
        authEntries: params.authEntries,
        sourceAccount,
      },
    );
  }

  /**
   * Claims pending rewards for the caller.
   *
   * @param params - Claim rewards parameters (optional).
   * @returns The transaction result, or the transaction builder if txBuilder was provided.
   */
  async claimRewards(params?: ClaimRewardsParams): Promise<any> {
    const sourceAccount = await this.wallet.getPublicKey();

    return this.invokeMethod<ClaimArgs>(
      'claim_rewards',
      {},
      () => [],
      {
        txBuilder: params?.txBuilder,
        authEntries: params?.authEntries,
        sourceAccount,
      },
    );
  }

  /**
   * Retrieves the vault balance for a specific account as a bigint.
   * @param account - The account address to check (optional, defaults to wallet public key)
   * @returns The vault balance as a bigint
   * @example
   * ```typescript
   * import { VaultContract } from "axionvera-sdk";
   *
   * // Get balance for connected wallet
   * const balance = await vault.getBalance();
   * console.log("Your vault shares:", balance);
   *
   * // Get balance for specific account
   * const otherBalance = await vault.getBalance(
   *   "GD5JPQ7VKFOVRWPOEX74JYXHHFNTFZ2JE5WZ4K2MWTROVHMWHD7KUZ2V"
   * );
   * console.log("Other account shares:", otherBalance);
   * ```
   */
  async getBalance(account?: string): Promise<bigint> {
    const targetAccount = account ?? await this.wallet.getPublicKey();

    const contractCall: ContractCallParams = {
      contractId: this.contractId,
      method: "balance",
      args: [new Address(targetAccount).toScVal()]
    };

    // Build a read-only transaction for querying
    const transaction = await this.transactionSigner.buildTransaction({
      sourceAccount: targetAccount,
      operations: [contractCall]
    });

    // Simulate to get the result
    const simulation = await this.client.simulateTransaction(transaction);

    if (!rpc.Api.isSimulationSuccess(simulation)) {
      throw new Error(`Failed to get balance: ${simulation.error}`);
    }

    // Extract the return value from simulation
    const result = simulation.results?.[0];
    if (!result) {
      throw new Error("No result in simulation");
    }

    // Decode only the return value of the first result; cache avoids redundant
    // XDR parsing when the same account balance is queried multiple times.
    const returnValue = result.xdr;
    const scVal = decodeXdrBase64(returnValue);

    // Convert ScVal to bigint (this is a simplified conversion)
    if (scVal.switch() === xdr.ScValType.scvI128()) {
      const i128 = scVal.i128();
      return BigInt(i128.low().toString()) + (BigInt(i128.high().toString()) << 64n);
    }

    throw new Error("Unexpected return value type");
  }

  /**
* Claims pending rewards for the connected wallet.
   * @param params - Optional claim rewards parameters including txBuilder for composition
   * @returns The transaction result, or the transaction builder if txBuilder was provided
   * @example
   * ```typescript
   * import { VaultContract } from "axionvera-sdk";
   *
   * // Simple claim rewards
   * const result = await vault.claimRewards();
   * console.log("Rewards claimed:", result);
   * ```
   */
  async claimRewards(params?: ClaimRewardsParams): Promise<any> {
    const sourceAccount = await this.wallet.getPublicKey();

    const operation = buildContractCallOperation({
      contractId: this.contractId,
      method: "claim_rewards",
      args: []
    });

    // If txBuilder is provided, append operation and return the builder
    if (params?.txBuilder) {
      params.txBuilder.addOperation(operation);
      return params.txBuilder;
    }

    // Otherwise, build and sign the transaction normally
    const contractCall: ContractCallParams = {
      contractId: this.contractId,
      method: "claim_rewards",
      args: []
    };

    return await this.transactionSigner.buildAndSignTransaction({
      sourceAccount,
      operations: [contractCall]
    });
  }

  /**
   * Retrieves general vault information including total assets, total supply, APY, and lock period.
   * @returns Vault information object with metrics as bigints and numbers
   * @example
   * ```typescript
   * import { VaultContract } from "axionvera-sdk";
   *
   * const info = await vault.getVaultInfo();
   * console.log("Total assets:", info.totalAssets);
   * console.log("Total supply:", info.totalSupply);
   * console.log("APY:", info.apy);
   * console.log("Lock period (seconds):", info.lockPeriod);
   * ```
   */
  async getVaultInfo(): Promise<VaultInfo> {
    const contractCall: ContractCallParams = {
      contractId: this.contractId,
      method: "get_vault_info",
      args: []
    };

    const transaction = await this.transactionSigner.buildTransaction({
      sourceAccount: await this.wallet.getPublicKey(),
      operations: [contractCall]
    });

    const simulation = await this.client.simulateTransaction(transaction);

    if (!rpc.Api.isSimulationSuccess(simulation)) {
      throw new Error(`Failed to get vault info: ${simulation.error}`);
    }

    const result = simulation.results?.[0];
    if (!result) {
      throw new Error("No result in simulation");
    }

    // Decode only the return value of the first result; cache avoids redundant
    // XDR parsing when vault info is queried repeatedly.
    const returnValue = result.xdr;
    const _scVal = decodeXdrBase64(returnValue);

    // For now, return mock data - in practice, you'd parse the actual contract response
    return {
      totalAssets: 0n,
      totalSupply: 0n,
      apy: 0,
      lockPeriod: 0
    };
  }

  /**
   * Estimates the gas fee for a deposit operation.
   * @param amount - The deposit amount as a bigint
   * @returns Estimated fee in stroops as a number
   * @example
   * ```typescript
   * import { VaultContract } from "axionvera-sdk";
   *
   * const fee = await vault.estimateDepositFee(1000n);
   * console.log("Estimated deposit fee (stroops):", fee);
   * console.log("Estimated fee (XLM):", fee / 10_000_000);
   * ```
   */
  async estimateDepositFee(amount: bigint): Promise<number> {
    const contractCall: ContractCallParams = {
      contractId: this.contractId,
      method: "deposit",
      args: [
        nativeToScVal(amount, { type: "i128" }),
        new Address(await this.wallet.getPublicKey()).toScVal()
      ]
    };

    return await this.transactionSigner.estimateOptimalFee({
      sourceAccount: await this.wallet.getPublicKey(),
      operations: [contractCall]
    });
  }

  /**
   * Estimates the gas fee for a withdrawal operation.
   * @param amount - The withdrawal amount as a bigint
   * @returns Estimated fee in stroops as a number
   * @example
   * ```typescript
   * import { VaultContract } from "axionvera-sdk";
   *
   * const fee = await vault.estimateWithdrawFee(1000n);
   * console.log("Estimated withdrawal fee (stroops):", fee);
   * console.log("Estimated fee (XLM):", fee / 10_000_000);
   * ```
   */
  async estimateWithdrawFee(amount: bigint): Promise<number> {
    const contractCall: ContractCallParams = {
      contractId: this.contractId,
      method: "withdraw",
      args: [
        nativeToScVal(amount, { type: "i128" }),
        new Address(await this.wallet.getPublicKey()).toScVal()
      ]
    };

    return await this.transactionSigner.estimateOptimalFee({
      sourceAccount: await this.wallet.getPublicKey(),
      operations: [contractCall]
    });
  }
}
