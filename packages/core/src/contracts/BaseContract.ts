import {
  TransactionBuilder,
  rpc,
  xdr,
} from "@stellar/stellar-sdk";

import { StellarClient } from "../client/stellarClient";
import { WalletConnector } from "../wallet/walletConnector";
import { TransactionSigner, ContractCallParams, TransactionResult } from "../transaction/transactionSigner";
import { buildContractCallOperation, ContractCallArg } from "../utils/transactionBuilder";
import { decodeXdrBase64 } from "../utils/xdrCache";

/**
 * Configuration for the contract wrapper.
 */
export type ContractConfig = {
  /** The stellar client for network operations */
  client: StellarClient;
  /** The contract ID */
  contractId: string;
  /** The wallet connector for signing transactions */
import { TransactionBuilder, xdr } from '@stellar/stellar-sdk';

import { StellarClient } from '../client/stellarClient';
import { TransactionSigner, ContractCallParams, TransactionResult } from '../transaction/transactionSigner';
import { WalletConnector } from '../wallet/walletConnector';
import { buildContractCallOperation } from '../utils/transactionBuilder';
import { addAuthEntry, SorobanAuthEntry } from '../utils/sorobanAuth';

export type BaseContractConfig = {
  /** The stellar client for network operations. */
  client: StellarClient;
  /** The on-chain contract ID (C…). */
  contractId: string;
  /** The wallet connector used for signing. */
  wallet: WalletConnector;
};

/** Options forwarded to every invokeMethod call. */
export type InvokeMethodOptions = {
  /**
   * When provided, the operation is appended to this builder and the builder
   * is returned instead of signing/submitting a new transaction. Useful for
   * composing multiple operations into a single atomic transaction.
   */
  txBuilder?: TransactionBuilder;
  /**
   * Additional Soroban authorization entries to inject into the transaction
   * envelope after simulation — e.g. for multisig or delegated-authority flows.
   * Entries are applied in order via {@link addAuthEntry}.
   */
  authEntries?: SorobanAuthEntry[];
  /** Override the source account (defaults to the wallet's public key). */
  sourceAccount?: string;
};

/**
 * Abstract base for Soroban contract wrappers.
 *
 * Provides a generic `invokeMethod` helper that enforces strongly-typed
 * argument interfaces at compile time and handles the full
 * build → simulate → (inject auth) → sign → submit lifecycle.
 *
 * Concrete contracts extend this class and call `invokeMethod` with their
 * own typed arg interfaces, so that a typo like `{ amout: 1n }` instead of
 * `{ amount: 1n }` is caught immediately in the consumer's IDE.
 *
 * @example
 * ```ts
 * class VaultContract extends BaseContract {
 *   async deposit(params: DepositParams) {
 *     return this.invokeMethod<DepositArgs, TransactionResult>(
 *       'deposit',
 *       { amount: params.amount, from: params.from },
 *       (args) => [
 *         nativeToScVal(args.amount, { type: 'i128' }),
 *         new Address(args.from!).toScVal(),
 *       ],
 *       { txBuilder: params.txBuilder, authEntries: params.authEntries },
 *     );
 *   }
 * }
 * ```
import { Address, nativeToScVal, rpc, xdr } from "@stellar/stellar-sdk";
import { StellarClient } from "../client/stellarClient";
import { WalletConnector } from "../wallet/walletConnector";
import { TransactionSigner, ContractCallParams } from "../transaction/transactionSigner";
import { buildContractCallOperation, ContractCallArg } from "../utils/transactionBuilder";
import { decodeXdrBase64 } from "../utils/xdrCache";

export type BaseContractConfig = {
  client: StellarClient;
  contractId: string;
  wallet: WalletConnector;
};

/**
 * Base class for all Axionvera contract wrappers.
 * 
 * Provides shared logic for transaction building, simulation, signing, and polling.
 * This allows specialized contract wrappers to focus on defining their specific methods
 * and type conversions.
 * Abstract base class for all generated Soroban contract wrappers.
 * Provides shared infrastructure for building, signing, and simulating transactions.
 */
export abstract class BaseContract {
  protected readonly client: StellarClient;
  protected readonly contractId: string;
  protected readonly wallet: WalletConnector;
  protected readonly transactionSigner: TransactionSigner;

  /**
   * Creates a new BaseContract instance.
   * @param config - Configuration for the contract
   */
  constructor(config: ContractConfig) {
  protected readonly signer: TransactionSigner;

  constructor(config: BaseContractConfig) {
    this.client = config.client;
    this.contractId = config.contractId;
    this.wallet = config.wallet;
    this.transactionSigner = new TransactionSigner({
      client: this.client,
      wallet: this.wallet
    });
  }

  /**
   * Invokes a contract method that modifies state.
   * 
   * This method handles simulation, transaction building, wallet signing, and polling automatically.
   * If a txBuilder is provided, the operation is appended to it and the builder is returned.
   * 
   * @param methodName - The name of the contract method to invoke
   * @param args - Arguments for the contract method
   * @param txBuilder - Optional transaction builder for composite transactions
   * @returns The transaction result, or the transaction builder if provided
   */
  protected async invokeMethod(
    methodName: string,
    args: ContractCallArg[] = [],
    txBuilder?: TransactionBuilder
  ): Promise<TransactionResult | TransactionBuilder> {
    const sourceAccount = await this.wallet.getPublicKey();

    const operation = buildContractCallOperation({
      contractId: this.contractId,
      method: methodName,
      args
    });

    // If txBuilder is provided, append operation and return the builder
    if (txBuilder) {
      txBuilder.addOperation(operation);
      return txBuilder;
    }

    // Otherwise, build and sign the transaction normally
    const contractCall: ContractCallParams = {
      contractId: this.contractId,
      method: methodName,
      args
    };

    return await this.transactionSigner.buildAndSignTransaction({
      sourceAccount,
      operations: [contractCall]
    });
  }

  /**
   * Queries a contract method (read-only).
   * 
   * This method builds a transaction and simulates it to get the return value.
   * 
   * @param methodName - The name of the contract method to query
   * @param args - Arguments for the contract method
   * @param sourceAccount - Optional source account for the query (defaults to wallet public key)
   * @returns The decoded ScVal result from the simulation
   */
  protected async queryMethod(
    methodName: string,
    args: ContractCallArg[] = [],
    sourceAccount?: string
  ): Promise<xdr.ScVal> {
    const targetAccount = sourceAccount ?? await this.wallet.getPublicKey();

    const contractCall: ContractCallParams = {
      contractId: this.contractId,
      method: methodName,
      args
    };

    // Build a read-only transaction for querying
    const transaction = await this.transactionSigner.buildTransaction({
      sourceAccount: targetAccount,
      operations: [contractCall]
    });

    // Simulate to get the result
    const simulation = await this.client.simulateTransaction(transaction);

    if (!rpc.Api.isSimulationSuccess(simulation)) {
      throw new Error(`Query failed: ${simulation.error}`);
    }

    // Extract the return value from simulation
    const result = simulation.results?.[0];
    if (!result) {
      throw new Error("No result in simulation");
    }

    return decodeXdrBase64(result.xdr);
  }

  /**
   * Estimates the optimal fee for a contract method call.
   * 
   * @param methodName - The name of the contract method
   * @param args - Arguments for the contract method
   * @param sourceAccount - Optional source account for estimation (defaults to wallet public key)
   * @returns Estimated fee in stroops
   */
  protected async estimateFee(
    methodName: string,
    args: ContractCallArg[] = [],
    sourceAccount?: string
  ): Promise<number> {
    const targetAccount = sourceAccount ?? await this.wallet.getPublicKey();

    const contractCall: ContractCallParams = {
      contractId: this.contractId,
      method: methodName,
      args
    };

    return await this.transactionSigner.estimateOptimalFee({
      sourceAccount: targetAccount,
      operations: [contractCall]
    });
      wallet: this.wallet,
    });
  }

  /**
   * Invokes a Soroban contract method with strongly-typed arguments.
   *
   * The generic `TArgs` parameter is the precise argument interface for this
   * method — passing an object with a misspelled or extra key is a compile-time
   * error. `TReturn` links the return type at the call site.
   *
   * When `options.txBuilder` is provided the operation is added to the builder
   * and the builder is returned (no network call). Otherwise the full
   * build → simulate → [inject custom auth] → sign → submit flow runs.
   *
   * @param method    - The Soroban function name to call.
   * @param args      - Strongly-typed arguments consumed by `toScVals`.
   * @param toScVals  - Maps `TArgs` to the `xdr.ScVal[]` the contract expects.
   * @param options   - txBuilder, authEntries, sourceAccount overrides.
   */
  protected async invokeMethod<TArgs extends object, TReturn = TransactionResult>(
    method: string,
    args: TArgs,
    toScVals: (args: TArgs) => xdr.ScVal[],
    options?: InvokeMethodOptions,
  ): Promise<TReturn> {
    const scVals = toScVals(args);
    const sourceAccount =
      options?.sourceAccount ?? (await this.wallet.getPublicKey());

    const operation = buildContractCallOperation({
      contractId: this.contractId,
      method,
      args: scVals,
    });

    // ── txBuilder (compose) path ────────────────────────────────────────────
    if (options?.txBuilder) {
      options.txBuilder.addOperation(operation);
      return options.txBuilder as unknown as TReturn;
    }

    const contractCallParams: ContractCallParams = {
      contractId: this.contractId,
      method,
      args: scVals,
    };

    // ── Auth-entries path ───────────────────────────────────────────────────
    if (options?.authEntries?.length) {
      // Build → simulate → prepare → inject custom auth → sign → submit.
      const tx = await this.transactionSigner.buildTransaction({
        sourceAccount,
        operations: [contractCallParams],
      });

      const simulation = await this.client.simulateTransaction(tx);

      const { rpc } = await import('@stellar/stellar-sdk');
      if (!rpc.Api.isSimulationSuccess(simulation)) {
        throw new Error(`Transaction simulation failed: ${(simulation as any).error}`);
      }

      const preparedTx = await this.client.prepareTransaction(tx, simulation);

      // Inject each custom auth entry after the standard auth is assembled.
      let envelopeXdr = preparedTx.toXDR();
      for (const entry of options.authEntries) {
        envelopeXdr = addAuthEntry(envelopeXdr, entry);
      }

      const signedXdr = await this.wallet.signTransaction(
        envelopeXdr,
        this.client.networkPassphrase,
      );

      const sendResult = await this.client.sendTransaction(signedXdr);
      const finalResult = await this.client.pollTransaction(sendResult.hash);

      return {
        hash: sendResult.hash,
        status: finalResult.status,
        successful: finalResult.status === 'SUCCESS',
        raw: finalResult,
        signedXdr,
        simulation,
      } as unknown as TReturn;
    }

    // ── Standard path ───────────────────────────────────────────────────────
    const result = await this.transactionSigner.buildAndSignTransaction({
      sourceAccount,
      operations: [contractCallParams],
    });

    return result as unknown as TReturn;
    this.signer = new TransactionSigner({ client: this.client, wallet: this.wallet });
  }

  /**
   * Invoke a mutating contract method (builds, signs, and submits a transaction).
   */
  protected async invoke(method: string, args: ContractCallArg[]): Promise<any> {
    const sourceAccount = await this.wallet.getPublicKey();
    const call: ContractCallParams = { contractId: this.contractId, method, args };
    return this.signer.buildAndSignTransaction({ sourceAccount, operations: [call] });
  }

  /**
   * Query a read-only contract method via simulation (no transaction submitted).
   */
  protected async query(method: string, args: ContractCallArg[]): Promise<xdr.ScVal> {
    const sourceAccount = await this.wallet.getPublicKey();
    const call: ContractCallParams = { contractId: this.contractId, method, args };
    const tx = await this.signer.buildTransaction({ sourceAccount, operations: [call] });
    const simulation = await this.client.simulateTransaction(tx);

    if (!rpc.Api.isSimulationSuccess(simulation)) {
      throw new Error(`Simulation failed for ${method}: ${(simulation as any).error}`);
    }

    const result = simulation.results?.[0];
    if (!result) throw new Error(`No simulation result for ${method}`);
    return decodeXdrBase64(result.xdr);
  }

  /** Decode an i128 ScVal to bigint. */
  protected decodeI128(val: xdr.ScVal): bigint {
    if (val.switch() !== xdr.ScValType.scvI128()) throw new Error("Expected i128");
    const i = val.i128();
    return BigInt(i.low().toString()) + (BigInt(i.high().toString()) << 64n);
  }

  /** Decode a u128 ScVal to bigint. */
  protected decodeU128(val: xdr.ScVal): bigint {
    if (val.switch() !== xdr.ScValType.scvU128()) throw new Error("Expected u128");
    const u = val.u128();
    return BigInt(u.lo().toString()) + (BigInt(u.hi().toString()) << 64n);
  }

  /** Decode a u64 ScVal to bigint. */
  protected decodeU64(val: xdr.ScVal): bigint {
    if (val.switch() !== xdr.ScValType.scvU64()) throw new Error("Expected u64");
    return BigInt(val.u64().toString());
  }

  /** Decode a bool ScVal. */
  protected decodeBool(val: xdr.ScVal): boolean {
    if (val.switch() !== xdr.ScValType.scvBool()) throw new Error("Expected bool");
    return val.b();
  }

  /** Decode a string/symbol ScVal. */
  protected decodeString(val: xdr.ScVal): string {
    const t = val.switch();
    if (t === xdr.ScValType.scvString()) return val.str().toString();
    if (t === xdr.ScValType.scvSymbol()) return val.sym().toString();
    throw new Error("Expected string or symbol");
  }

  /** Encode an address arg. */
  protected encodeAddress(addr: string): xdr.ScVal {
    return new Address(addr).toScVal();
  }

  /** Encode a bigint as i128. */
  protected encodeI128(n: bigint): xdr.ScVal {
    return nativeToScVal(n, { type: "i128" });
  }

  /** Encode a bigint as u128. */
  protected encodeU128(n: bigint): xdr.ScVal {
    return nativeToScVal(n, { type: "u128" });
  }
}
