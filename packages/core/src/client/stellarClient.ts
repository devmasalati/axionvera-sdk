import {
  Account,
  Address,
  Contract,
  FeeBumpTransaction,
  Keypair,
  nativeToScVal,
  scValToNative,
  rpc,
  SorobanDataBuilder,
  Transaction,
  TransactionBuilder,
  xdr
} from "@stellar/stellar-sdk";

import {
  AxionveraNetwork,
  getNetworkPassphrase,
  resolveNetworkConfig
} from "../utils/networkConfig";
import { ConcurrencyConfig, DEFAULT_CONCURRENCY_CONFIG, createConcurrencyControlledClient } from "../utils/concurrencyQueue";
import { RetryConfig, createHttpClientWithRetry, retry } from "../utils/httpInterceptor";
import { NetworkError, toAxionveraError, InsecureNetworkError, AxionveraError } from "../errors/axionveraError";
import {
  validateRpcResponse,
  GetHealthResponseSchema,
  SimulateTransactionResponseSchema,
  GetTransactionResponseSchema,
  ValidatedGetHealthResponse,
  ValidatedGetTransactionResponse,
} from "../utils/rpcSchemas";
import { NetworkError, toAxionveraError, InsecureNetworkError, AxionveraError, TransactionTimeoutError, ValidationError } from "../errors/axionveraError";
import { LogLevel, Logger } from "../utils/logger";
import { WebSocketManager, EventFilter, SorobanEvent, WebSocketConfig } from "./websocket";
import { CloudWatchConfig } from "../utils/logging/cloudwatch";
import {
  FetchTransactionHistoryOptions,
  TransactionHistoryResult,
  parseTransaction,
  sortByTimestamp,
  filterByActionType
} from "../utils/transactionHistory";

const DEFAULT_FEE_BUFFER_MULTIPLIER = 1.15;

/**
 * Checks if a URL points to a localhost address.
 * @param url - The URL to check
 * @returns true if the URL hostname is localhost, 127.0.0.1, or ::1
 */
function isLocalhostUrl(url: string): boolean {
  try {
    const hostname = new URL(url).hostname;
    return hostname === 'localhost' ||
           hostname === '127.0.0.1' ||
           hostname === '::1';
  } catch {
    return false;
  }
}

export type StellarClientOptions = {
  network?: AxionveraNetwork;
  rpcUrl?: string;
  networkPassphrase?: string;
  rpcClient?: rpc.Server;
  concurrencyConfig?: Partial<ConcurrencyConfig>;
  retryConfig?: Partial<RetryConfig>;
  logLevel?: LogLevel;
  webSocketConfig?: WebSocketConfig;
  cloudWatchConfig?: CloudWatchConfig;
  customHeaders?: Record<string, string>;
  /** Multiplier applied to simulated Soroban resources and fees (default: 1.15). */
  feeBufferMultiplier?: number;
  /** Hard ceiling for the total prepared fee in stroops. */
  maxFeeLimit?: number;
  allowHttp?: boolean;
  /** Timeout in milliseconds for account fetching (default: 2000) */
  accountFetchTimeoutMs?: number;
  /** TTL in milliseconds for cached account sequence (default: 5000) */
  cacheTtlMs?: number;
};

export type TransactionSendResult = {
  hash: string;
  status: string;
  raw: unknown;
};

/** Snapshot version for forward-compatibility of (de)serialized state. */
export const HYDRATION_STATE_VERSION = 1 as const;

/** A JSON-serializable value, with Date allowed inside simulation context. */
export type SerializableValue =
  | string
  | number
  | boolean
  | null
  | Date
  | SerializableValue[]
  | { [key: string]: SerializableValue };

export type SimulationContext = { [key: string]: SerializableValue };

export interface PendingTransaction {
  hash: string;
  simulationContext?: SimulationContext;
  submittedAt: Date;
  intervalMs: number;
  deadline: Date;
  label?: string;
}

export interface TrackedTransaction extends PendingTransaction {
  /** Resolves with the final transaction result; rejects on error/timeout. */
  promise: Promise<unknown>;
  /** Cancels the polling loop without rejecting outstanding awaiters. */
  cancel: () => void;
}

export interface SerializedPendingTransaction {
  hash: string;
  simulationContext?: SimulationContext;
  submittedAt: string;
  intervalMs: number;
  deadline: string;
  label?: string;
}

export interface ExportedState {
  version: typeof HYDRATION_STATE_VERSION;
  exportedAt: string;
  pending: SerializedPendingTransaction[];
}

export interface TrackTransactionOptions {
  hash: string;
  simulationContext?: SimulationContext;
  intervalMs?: number;
  timeoutMs?: number;
  /** Absolute deadline; takes precedence over timeoutMs when restoring. */
  deadline?: Date;
  label?: string;
}

const DATE_MARKER = "__date" as const;

function freezeDates(value: SerializableValue): SerializableValue {
  if (value instanceof Date) {
    return { [DATE_MARKER]: value.toISOString() };
  }
  if (Array.isArray(value)) {
    return value.map((item) => freezeDates(item));
  }
  if (value !== null && typeof value === "object") {
    const out: { [key: string]: SerializableValue } = {};
    for (const key of Object.keys(value)) {
      out[key] = freezeDates(
        (value as { [key: string]: SerializableValue })[key] as SerializableValue
      );
    }
    return out;
  }
  return value;
}

function thawDates(value: SerializableValue): SerializableValue {
  if (Array.isArray(value)) {
    return value.map((item) => thawDates(item));
  }
  if (value !== null && typeof value === "object" && !(value instanceof Date)) {
    const obj = value as { [key: string]: SerializableValue };
    const marker = obj[DATE_MARKER];
    if (typeof marker === "string" && Object.keys(obj).length === 1) {
      const parsed = new Date(marker);
      if (!Number.isNaN(parsed.getTime())) {
        return parsed;
      }
    }
    const out: { [key: string]: SerializableValue } = {};
    for (const key of Object.keys(obj)) {
      out[key] = thawDates(obj[key] as SerializableValue);
    }
    return out;
  }
  return value;
}

function freezeContext(ctx: SimulationContext | undefined): SimulationContext | undefined {
  if (!ctx) return undefined;
  return freezeDates(ctx) as SimulationContext;
}

function thawContext(ctx: SimulationContext | undefined): SimulationContext | undefined {
  if (!ctx) return undefined;
  return thawDates(ctx) as SimulationContext;
}
type TransactionResponseRecord = Record<string, unknown>;

export type TransactionPollResult = TransactionResponseRecord & {
  status: string;
  ledger: number | null;
};

/**
 * RPC gateway for interacting with Soroban networks.
 *
 * Provides methods for querying network state, simulating transactions,
 * preparing transactions with fees, and submitting signed transactions.
 *
 * @example
 * ```typescript
 * import { StellarClient } from "axionvera-sdk";
 *
 * const client = new StellarClient({ network: "testnet" });
 * const health = await client.getHealth();
 * ```
 */
export abstract class BaseStellarRpcClient {
  // ...
}

export class StellarClient extends BaseStellarRpcClient {
  /** The network this client is connected to. */
  readonly network: AxionveraNetwork;
  /** The RPC URL this client uses. */
  readonly rpcUrl: string;
  /** The network passphrase for transaction signing. */
  readonly networkPassphrase: string;
  /** The underlying RPC server instance. */
  readonly rpc: rpc.Server;
  /** The HTTP client with retry interceptors. */
  readonly httpClient;
  /** The effective retry configuration after merging with defaults. */
  readonly retryConfig: Partial<RetryConfig>;
  /** The effective concurrency configuration after merging with defaults. */
  private readonly concurrencyConfig: ConcurrencyConfig;
  /** Indicates whether concurrency control was explicitly enabled. */
  private readonly concurrencyEnabled: boolean;
  /** The internal logger instance. */
  private readonly logger: Logger;
  /** WebSocket manager for real-time events. */
  private webSocketManager: WebSocketManager | null = null;
  /** In-memory registry of currently polling transactions. */
  private readonly pendingTransactions = new Map<string, TrackedTransaction>();
/** Timeout for account fetching in milliseconds. */
  readonly accountFetchTimeoutMs: number;
  /** TTL for cached account sequence in milliseconds. */
  readonly cacheTtlMs: number;

  /** Private cache for account sequences with timestamps. */
  private accountSequenceCache: Map<string, { sequence: bigint; timestamp: number }>;
  /** Multiplier applied to simulated Soroban resources and fees. */
  private readonly feeBufferMultiplier: number;
  /** Optional hard ceiling for the total prepared fee. */
  private readonly maxFeeLimit?: bigint;

   /**
    * Creates a new StellarClient instance.
    * @param options - Configuration options
    */
    constructor(options?: StellarClientOptions) {
      const config = resolveNetworkConfig(options);
      const rpcUrl = config.rpcUrl;
      const network = config.network;
      const networkPassphrase = config.networkPassphrase;

      // Validate RPC URL has a protocol
      if (!rpcUrl.startsWith('http://') && !rpcUrl.startsWith('https://')) {
        throw new AxionveraError('RPC URL must include a protocol (http:// or https://)');
      }

      // Security guard: prevent insecure HTTP in production unless explicitly allowed
      const isProduction = process.env.NODE_ENV === 'production';
      const isHttp = rpcUrl.startsWith('http://');
      const isLocalhost = isLocalhostUrl(rpcUrl);
      const allowHttp = options?.allowHttp ?? false;

      if (isProduction && isHttp && !isLocalhost && !allowHttp) {
        throw new InsecureNetworkError(
          'Insecure RPC connection in production: HTTP endpoint detected. ' +
          'Use HTTPS for production or set allowHttp: true to override. ' +
          'Note: localhost endpoints are always permitted.'
        );
      }

      super();

      this.network = network;
      this.rpcUrl = rpcUrl;
      this.networkPassphrase = networkPassphrase;

     this.concurrencyConfig = {
      ...DEFAULT_CONCURRENCY_CONFIG,
      ...options?.concurrencyConfig
    };
    this.concurrencyEnabled = !!options?.concurrencyConfig;
    this.retryConfig = options?.retryConfig ?? {};
    this.httpClient = createHttpClientWithRetry(this.retryConfig);
    this.logger = new Logger(options?.logLevel ?? 'none', options?.cloudWatchConfig);
this.accountFetchTimeoutMs = options?.accountFetchTimeoutMs ?? 2000;
    this.cacheTtlMs = options?.cacheTtlMs ?? 5000;
    this.accountSequenceCache = new Map();
    this.feeBufferMultiplier = options?.feeBufferMultiplier ?? DEFAULT_FEE_BUFFER_MULTIPLIER;

    if (!Number.isFinite(this.feeBufferMultiplier) || this.feeBufferMultiplier < 1) {
      throw new ValidationError("feeBufferMultiplier must be a finite number greater than or equal to 1");
    }

    if (options?.maxFeeLimit !== undefined) {
      if (!Number.isInteger(options.maxFeeLimit) || options.maxFeeLimit <= 0) {
        throw new ValidationError("maxFeeLimit must be a positive integer");
      }

      this.maxFeeLimit = BigInt(options.maxFeeLimit);
    }

    this.logger.info(`Initializing StellarClient for ${this.network} at ${this.rpcUrl}`);

    // Initialize WebSocket manager if configuration is provided
    if (options?.webSocketConfig) {
      this.webSocketManager = new WebSocketManager(
        this.rpcUrl,
        options.webSocketConfig,
        {
          onEvent: (event) => this.logger.debug('WebSocket event received:', event),
          onConnectionChange: (connected) => this.logger.debug(`WebSocket connection changed: ${connected}`),
        }
      );
    }

    if (options?.rpcClient) {
      this.rpc = options.rpcClient;
    } else {
      const allowHttp = this.rpcUrl.startsWith("http://");
      const baseRpc = new rpc.Server(this.rpcUrl, { allowHttp });

      // Apply concurrency control if enabled
      if (this.concurrencyEnabled) {
        this.rpc = createConcurrencyControlledClient(baseRpc, this.concurrencyConfig);
      } else {
        this.rpc = baseRpc;
      }
    }
  }

  /**
   * Checks the health of the RPC server.
   * Automatically retries on failure.
   * @returns The health check response
   */
  async getHealth(): Promise<ValidatedGetHealthResponse> {
    this.logger.debug("Fetching network health");
    return this.executeWithErrorHandling(async () => {
      const response = await retry(() => this.rpc.getHealth(), this.retryConfig);
      return validateRpcResponse(GetHealthResponseSchema, response, 'getHealth');
    }, "Failed to fetch network health");
  }

  /**
   * Retrieves the network configuration from the RPC server.
   * Automatically retries on failure.
   * @returns The network configuration
   */
  async getNetwork(): Promise<unknown> {
    this.logger.debug("Fetching network configuration");
    return this.executeWithErrorHandling(
      () => retry(() => this.rpc.getNetwork(), this.retryConfig),
      "Failed to fetch network configuration"
    );
  }

  /**
   * Gets the latest ledger sequence number.
   * Automatically retries on failure.
   * @returns The latest ledger info
   */
  async getLatestLedger(): Promise<unknown> {
    this.logger.debug("Fetching latest ledger");
    return this.executeWithErrorHandling(
      () => retry(() => this.rpc.getLatestLedger(), this.retryConfig),
      "Failed to fetch latest ledger"
    );
  }

  /**
   * Retrieves an account's information from the network.
   * Automatically retries on failure.
   * @param publicKey - The account's public key
   * @returns The account information
   */
  async getAccount(publicKey: string): Promise<Account> {
    this.logger.debug(`Fetching account ${publicKey}`);
    return this.executeWithErrorHandling(
      () => retry(() => this.rpc.getAccount(publicKey), this.retryConfig),
      `Failed to fetch account ${publicKey}`
    );
  }

  /**
   * Retrieves an account's information with aggressive timeout and cached fallback.
   * If the network request fails or times out, returns an account with cached sequence + 1.
   * @param publicKey - The account's public key
   * @returns The account information
   * @throws Error if both network request fails and no valid cache exists
   */
  async getAccountWithCache(publicKey: string): Promise<Account> {
    try {
      // Try to fetch account with aggressive timeout
      const account = await this.getAccountWithTimeout(publicKey, this.accountFetchTimeoutMs);
      // Update cache on successful fetch
      this.updateCache(publicKey, account.sequenceNumber().toString());
      return account;
    } catch (error) {
      // Network failed, try to use cached sequence
      const cached = this.getCachedSequence(publicKey);
      if (cached) {
        this.logger.debug(`Using cached sequence for ${publicKey}: ${cached.sequence}`);
        // Increment the cached sequence for sequential offline support
        const newSequence = cached.sequence + 1n;
        // Update cache with the new incremented value
        this.updateCache(publicKey, newSequence.toString());
        // Create account with the incremented sequence
        return new Account(publicKey, newSequence.toString());
      }
      // No cache available, throw error
      throw new AxionveraError(
        `Failed to fetch account and no valid cache available for ${publicKey}`,
        { originalError: error }
      );
    }
  }

  /**
   * Fetches account with a timeout.
   * @param publicKey - The account's public key
   * @param timeoutMs - Timeout in milliseconds
   * @returns The account information
   */
  private async getAccountWithTimeout(publicKey: string, timeoutMs: number): Promise<Account> {
    return Promise.race([
      this.getAccount(publicKey),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error(`Account fetch timeout after ${timeoutMs}ms`)), timeoutMs)
      )
    ]);
  }

  /**
   * Updates the cache with the current account sequence.
   * @param publicKey - The account's public key
   * @param sequence - The current sequence number
   */
  private updateCache(publicKey: string, sequence: string): void {
    this.accountSequenceCache.set(publicKey, {
      sequence: BigInt(sequence),
      timestamp: Date.now()
    });
  }

  /**
   * Retrieves a cached sequence if it's still valid (within TTL).
   * @param publicKey - The account's public key
   * @returns The cached sequence info or undefined if invalid
   */
  private getCachedSequence(publicKey: string): { sequence: bigint; timestamp: number } | undefined {
    const cached = this.accountSequenceCache.get(publicKey);
    if (!cached) return undefined;

    const now = Date.now();
    if (now - cached.timestamp > this.cacheTtlMs) {
      // Cache expired
      this.accountSequenceCache.delete(publicKey);
      return undefined;
    }

    return cached;
  }

  /**
   * Clears the cache for a specific account or all accounts.
   * @param publicKey - Optional public key to clear specific cache
   */
  clearCache(publicKey?: string): void {
    if (publicKey) {
      this.accountSequenceCache.delete(publicKey);
    } else {
      this.accountSequenceCache.clear();
    }
  }

  /**
   * Handles submission errors and invalidates cache on sequence errors.
   * If the error indicates a bad sequence number (tx_bad_seq), the cache is cleared
   * to prevent building transactions on top of an incorrect sequence.
   * @param error - The error from transaction submission
   * @param publicKey - The account public key to clear cache for
   * @returns Whether the cache was cleared
   */
  handleSubmissionError(error: unknown, publicKey?: string): boolean {
    const errorMessage = error instanceof Error ? error.message : String(error);
    
    // Check for Stellar sequence error patterns
    const sequenceErrorPatterns = [
      'tx_bad_seq',
      'bad sequence',
      'sequence number',
      'sequence mismatch'
    ];
    
    const isSequenceError = sequenceErrorPatterns.some(pattern =>
      errorMessage.toLowerCase().includes(pattern)
    );
    
    if (isSequenceError) {
      this.logger.warn(`Sequence error detected, clearing cache for ${publicKey || 'all accounts'}`);
      this.clearCache(publicKey);
      return true;
    }
    
    return false;
  }

  /**
   * Cleans up expired cache entries to prevent memory leaks.
   * This should be called periodically in long-running applications.
   * @returns Number of entries removed
   */
  cleanupExpiredCache(): number {
    let removed = 0;
    const now = Date.now();
    
    for (const [publicKey, cached] of this.accountSequenceCache.entries()) {
      if (now - cached.timestamp > this.cacheTtlMs) {
        this.accountSequenceCache.delete(publicKey);
        removed++;
      }
    }
    
    if (removed > 0) {
      this.logger.debug(`Cleaned up ${removed} expired cache entries`);
    }
    
    return removed;
  }

  /**
   * Submits multiple transactions in sequential order to prevent sequence conflicts.
   * This is critical when building transactions offline with cached sequences.
   * Transactions are submitted one at a time, waiting for each to succeed before submitting the next.
   * 
   * @param transactions - Array of signed transactions to submit
   * @param options - Submission options
   * @param options.onProgress - Callback called after each transaction submission
   * @param options.sourcePublicKey - The source account public key for error handling
   * @returns Array of submission results in the same order as input transactions
   * 
   * @example
   * ```typescript
   * // Build transactions while offline
   * const tx1 = await buildTransactionOffline(account1);
   * const tx2 = await buildTransactionOffline(account1);
   * const tx3 = await buildTransactionOffline(account1);
   * 
   * // Submit them in order when back online
   * const results = await client.submitTransactionsSequentially(
   *   [tx1, tx2, tx3],
   *   {
   *     sourcePublicKey: account1.publicKey(),
   *     onProgress: (index, result) => console.log(`Tx ${index + 1}: ${result.status}`)
   *   }
   * );
   * ```
   */
  async submitTransactionsSequentially(
    transactions: (Transaction | FeeBumpTransaction)[],
    options?: {
      onProgress?: (index: number, result: TransactionSendResult) => void;
      sourcePublicKey?: string;
    }
  ): Promise<TransactionSendResult[]> {
    const results: TransactionSendResult[] = [];
    
    for (let i = 0; i < transactions.length; i++) {
      try {
        const result = await this.sendTransaction(transactions[i]);
        results.push(result);
        
        if (options?.onProgress) {
          options.onProgress(i, result);
        }
        
        // If successful, wait a brief moment for the transaction to be processed
        // This helps prevent race conditions with sequence numbers
        await new Promise(resolve => setTimeout(resolve, 100));
      } catch (error) {
        // Handle submission error and clear cache if it's a sequence error
        const wasSequenceError = this.handleSubmissionError(error, options?.sourcePublicKey);
        
        // Re-throw with additional context
        throw new Error(
          `Transaction ${i + 1}/${transactions.length} failed${wasSequenceError ? ' (cache cleared due to sequence error)' : ''}: ${error instanceof Error ? error.message : String(error)}`
        );
      }
    }
    
    return results;
  }

  /**
   * Validates transaction fee based on current network conditions.
   * This is useful when building transactions offline and needing to validate fees before submission.
   * 
   * @param transaction - The transaction to validate
   * @param options - Fee validation options
   * @param options.minFee - Minimum acceptable fee in stroops
   * @param options.maxFee - Maximum acceptable fee in stroops
   * @param options.simulate - Whether to simulate to get recommended fee (default: true)
   * @returns The recommended fee if simulation succeeds, or current fee if validation passes
   * @throws Error if fee is too low or simulation fails
   * 
   * @example
   * ```typescript
   * // Build transaction offline
   * const tx = await buildTransactionOffline(account);
   * 
   * // Back online - validate fee
   * const recommendedFee = await client.validateFee(tx, {
   *   minFee: 100000,
   *   maxFee: 500000
   * });
   * 
   * // If recommended fee is different, rebuild transaction with new fee
   * if (recommendedFee !== parseInt(tx.fee)) {
   *   const updatedTx = await rebuildTransactionWithNewFee(tx, recommendedFee);
   * }
   * ```
   */
  async validateFee(
    transaction: Transaction,
    options?: {
      minFee?: number;
      maxFee?: number;
      simulate?: boolean;
    }
  ): Promise<number> {
    const simulate = options?.simulate ?? true;
    const minFee = options?.minFee ?? 100_000;
    const maxFee = options?.maxFee ?? 1_000_000;
    
    const currentFee = parseInt(transaction.fee);
    
    if (currentFee < minFee) {
      throw new Error(`Transaction fee ${currentFee} is below minimum ${minFee}`);
    }
    
    if (currentFee > maxFee) {
      throw new Error(`Transaction fee ${currentFee} exceeds maximum ${maxFee}`);
    }
    
    if (simulate) {
      try {
        const simulation = await this.simulateTransaction(transaction);
        
        if (rpc.Api.isSimulationSuccess(simulation)) {
          // Access the resource fee from simulation result
          const minResourceFee = simulation.minResourceFee ?? 100_000;
          const recommendedFee = parseInt(minResourceFee.toString());
          
          // If recommended fee is significantly higher (20% buffer), recommend it
          if (recommendedFee > currentFee * 1.2) {
            this.logger.info(`Recommended fee ${recommendedFee} is significantly higher than current ${currentFee}`);
            return recommendedFee;
          }
        }
      } catch (error) {
        this.logger.warn(`Fee simulation failed, using original fee: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    
    // Return current fee if validation passes
    return currentFee;
  }

  /**
   * Simulates a transaction without submitting it.
   * This is useful for testing transaction validity and getting expected costs.
   * @param tx - The transaction to simulate
   * @returns The simulation result
   */
  async simulateTransaction(
    tx: Transaction | FeeBumpTransaction
  ): Promise<rpc.Api.SimulateTransactionResponse> {
    this.logger.debug("Simulating transaction");
    return this.executeWithErrorHandling(async () => {
      const response = await this.rpc.simulateTransaction(tx);
      validateRpcResponse(SimulateTransactionResponseSchema, response, 'simulateTransaction');
      return response;
    }, "Failed to simulate transaction");
  }

  /**
   * Simulates multiple operations in a single batch transaction.
   * This is more efficient than simulating operations one by one, especially when
   * a user wants to perform multiple actions (e.g., deposit into 3 vaults).
   *
   * All operations are combined into a single transaction and sent to the Soroban RPC
   * simulateTransaction endpoint, which returns results for each operation.
   *
   * Note: Be aware of Soroban transaction limits. A large batch may fail if it exceeds
   * the maximum CPU/RAM limits for a single transaction.
   *
   * @param params - Batch simulation parameters
   * @param params.operations - Array of XDR operations to simulate
   * @param params.sourceAccount - The source account for the transaction
   * @param params.fee - The fee per operation (default: 100_000)
   * @param params.timeoutInSeconds - Transaction timeout in seconds (default: 60)
   * @returns Array of simulation results, one for each operation
   * @throws Error if the batch simulation fails
   *
   * @example
   * ```typescript
   * const client = new StellarClient({ network: "testnet" });
   * const account = await client.getAccount(publicKey);
   *
   * // Build three deposit operations
   * const op1 = buildContractCallOperation({
   *   contractId: vault1,
   *   method: "deposit",
   *   args: [amount1]
   * });
   * const op2 = buildContractCallOperation({
   *   contractId: vault2,
   *   method: "deposit",
   *   args: [amount2]
   * });
   * const op3 = buildContractCallOperation({
   *   contractId: vault3,
   *   method: "deposit",
   *   args: [amount3]
   * });
   *
   * // Simulate all three in one call
   * const results = await client.simulateBatch({
   *   operations: [op1, op2, op3],
   *   sourceAccount: account
   * });
   *
   * // results[0], results[1], results[2] contain the individual results
   * ```
   */
  async simulateBatch(params: {
    operations: xdr.Operation[];
    sourceAccount: Account;
    fee?: number;
    timeoutInSeconds?: number;
  }): Promise<rpc.Api.SimulateTransactionResponse['result']> {
    this.logger.debug(`Simulating batch of ${params.operations.length} operations`);

    return this.executeWithErrorHandling(async () => {
      if (!params.operations || params.operations.length === 0) {
        throw new AxionveraError('At least one operation is required for batch simulation');
      }

      // Calculate fee: multiply by number of operations
      const operationCount = params.operations.length;
      const feePerOperation = params.fee ?? 100_000;
      const totalFee = (feePerOperation * operationCount).toString();
      const timeoutInSeconds = params.timeoutInSeconds ?? 60;

      // Build a transaction with all operations
      const builder = new TransactionBuilder(params.sourceAccount, {
        fee: totalFee,
        networkPassphrase: this.networkPassphrase
      });

      // Add all operations to the transaction
      for (const operation of params.operations) {
        builder.addOperation(operation);
      }

      const tx = builder.setTimeout(timeoutInSeconds).build();

      // Simulate the combined transaction
      const result = await retry(
        () => this.rpc.simulateTransaction(tx),
        this.retryConfig
      );

      // Return only the results array
      if (!result.result) {
        throw new NetworkError('No results returned from batch simulation');
      }

      return result.result;
    }, `Failed to simulate batch of ${params.operations.length} operations`);
  }

  /**
   * Simulates a pure read-only contract call without requiring a source account or sequence number.
   * This dramatically speeds up dashboard loading times because the SDK doesn't need to fetch 
   * the user's ledger sequence number before checking a read-only balance.
   * 
   * @param contractId - The contract ID to call
   * @param method - The method name to call
   * @param args - The arguments to pass to the method (optional)
   * @returns The unwrapped scVal result directly
   */
  async simulateRead(
    contractId: string,
    method: string,
    args?: any[]
  ): Promise<xdr.ScVal> {
    this.logger.debug(`Simulating read-only call to ${contractId}.${method}`);

    return this.executeWithErrorHandling(async () => {
      // Create a dummy account with zeroed-out sequence for read-only simulation
      const dummyAccount = new Account(
        "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAH", // All zeros public key
        "0" // Zero sequence number
      );

      // Convert args to ScVal if provided
      const scVals = args ? args.map(arg => {
        if (typeof arg === 'string') {
          try {
            // Try to parse as address first
            return Address.fromString(arg).toScVal();
          } catch {
            // Fall back to native conversion
            return nativeToScVal(arg);
          }
        } else if (typeof arg === 'number' || typeof arg === 'bigint') {
          return nativeToScVal(arg);
        } else if (typeof arg === 'boolean') {
          return nativeToScVal(arg);
        } else if (arg === null || arg === undefined) {
          return xdr.ScVal.scvVoid();
        } else {
          return nativeToScVal(arg);
        }
      }) : [];

      // Create the contract call operation
      const contract = new Contract(contractId);
      const operation = contract.call(method, ...scVals);

      // Build a minimal transaction for simulation
      const tx = new TransactionBuilder(dummyAccount, {
        fee: "100", // Minimal fee for simulation
        networkPassphrase: this.networkPassphrase
      })
        .addOperation(operation)
        .setTimeout(30) // Short timeout for read operations
        .build();

      // Simulate the transaction
      const simulationResult = await this.rpc.simulateTransaction(tx);

      // Check for simulation errors
      if (simulationResult.error) {
        throw new NetworkError(`Simulation failed: ${simulationResult.error}`);
      }

      // Extract the result from the simulation
      if (!simulationResult.result) {
        throw new NetworkError('No result returned from simulation');
      }

      // Return the first (and typically only) result
      const results = simulationResult.result;
      if (results.length === 0) {
        throw new NetworkError('No results returned from simulation');
      }

      const firstResult = results[0];
      if (!firstResult) {
        throw new NetworkError('Empty result returned from simulation');
      }

      return firstResult;
    }, `Failed to simulate read call to ${contractId}.${method}`);
  }

  /**
   * Prepares a transaction by fetching the current ledger sequence
   * and setting the correct min sequence age.
   * @param tx - The transaction to prepare
   * @returns The prepared transaction
   */
  async prepareTransaction(tx: Transaction | FeeBumpTransaction): Promise<Transaction> {
    this.logger.debug("Preparing transaction");
    if (tx instanceof FeeBumpTransaction) {
      return this.executeWithErrorHandling(
        () => this.rpc.prepareTransaction(tx),
        "Failed to prepare transaction"
      );
    }

    return this.executeWithErrorHandling(
      async () => {
        const simulation = await this.simulateTransaction(tx);
        const assembledTx = rpc.assembleTransaction(tx, simulation).build();
        return this.applyFeeBuffer(assembledTx);
      },
      "Failed to prepare transaction"
    );
  }

  /**
   * Submits a signed transaction to the network.
   * @param tx - The signed transaction to submit
   * @returns The submission result containing hash and status
   */
  async sendTransaction(tx: Transaction | FeeBumpTransaction): Promise<TransactionSendResult> {
    this.logger.info("Sending transaction");
    return this.executeWithErrorHandling(async () => {
      const result = await this.rpc.sendTransaction(tx);
      const hash = (result as any).hash ?? (result as any).id ?? "";
      const status = (result as any).status ?? (result as any).statusText ?? "unknown";
      this.logger.info(`Transaction submitted: ${hash} (Status: ${status})`);
      return { hash, status, raw: result };
    }, "Failed to send transaction");
  }

  /**
   * Retrieves the status of a submitted transaction.
   * Automatically retries on failure.
   * @param hash - The transaction hash
   * @returns The transaction status response
   */
  async getTransaction(hash: string): Promise<ValidatedGetTransactionResponse> {
    this.logger.debug(`Fetching transaction status for ${hash}`);
    return this.executeWithErrorHandling(async () => {
      const response = await retry(() => this.rpc.getTransaction(hash), this.retryConfig);
      return validateRpcResponse(GetTransactionResponseSchema, response, 'getTransaction');
    }, `Failed to fetch transaction ${hash}`);
  }

  /**
   * Polls for a transaction to be confirmed or rejected.
   * @param hash - The transaction hash to wait for
   * @param params - Polling parameters
   * @param params.timeoutMs - Maximum time to wait in milliseconds (default: 30000)
   * @param params.intervalMs - Time between polls in milliseconds (default: 1000)
   * @returns The transaction result when it reaches a final state
   * @throws Error if the transaction times out
   */
  async pollTransaction(
    hash: string,
    params?: {
      timeoutMs?: number;
      intervalMs?: number;
      onProgress?: (status: string, ledger: number) => void | Promise<void>;
    }
  ): Promise<unknown> {
    const tracked = this.trackTransaction({
      hash,
      timeoutMs: params?.timeoutMs,
      intervalMs: params?.intervalMs,
      onProgress: params?.onProgress,
    });
    return tracked.promise;
  }

  /**
   * Registers a transaction in the pending-transaction registry and starts a
   * polling loop in the background. The returned object exposes the polling
   * promise and a cancel handle.
   *
   * If the same hash is already tracked, the existing entry is returned and
   * no new poll is started.
   */
  trackTransaction(
    options: TrackTransactionOptions & {
      onProgress?: (status: string, ledger: number) => void | Promise<void>;
    }
  ): TrackedTransaction {
    const existing = this.pendingTransactions.get(options.hash);
    if (existing) return existing;

    const intervalMs = options.intervalMs ?? 1_000;
    const submittedAt = new Date();
    const deadline =
      options.deadline ??
      new Date(submittedAt.getTime() + (options.timeoutMs ?? 30_000));
    const onProgress = options.onProgress;

    let cancelled: boolean = false;
    const cancel = (): void => {
      cancelled = true;
    };

    // Register the entry *before* starting the polling loop so that the
    // very first getTransaction() call already sees the tracked state.
    const tracked: TrackedTransaction = {
      hash: options.hash,
      simulationContext: options.simulationContext,
      submittedAt,
      intervalMs,
      deadline,
      label: options.label,
      promise: Promise.resolve(),
      cancel,
    };
    this.pendingTransactions.set(options.hash, tracked);

    tracked.promise = this.executeWithErrorHandling(async () => {
      try {
        while (!cancelled && Date.now() < deadline.getTime()) {
          const res = await this.getTransaction(options.hash);

          const status =
            (res as { status?: string } | null | undefined)?.status ?? "UNKNOWN";
          const ledger =
            (res as { ledger?: number } | null | undefined)?.ledger ?? 0;

          if (onProgress) {
            Promise.resolve()
              .then(() => onProgress(status, ledger))
              .catch((err) => {
                this.logger.warn("onProgress callback error", err);
              });
          }

          if (status && status !== "NOT_FOUND" && status !== "UNKNOWN") {
            return res;
          }

          await new Promise<void>((r) => setTimeout(r, intervalMs));
        }
        if (cancelled) {
          throw new AxionveraError(
            `Transaction tracking cancelled for ${options.hash}`
          );
        }
        throw new NetworkError(`Timed out waiting for transaction ${options.hash}`);
      } finally {
        this.pendingTransactions.delete(options.hash);
      }
    }, `Failed while polling transaction ${options.hash}`);

    tracked.promise.catch(() => undefined);

    return tracked;
  }

  /**
   * Returns the list of currently polling transactions (a snapshot).
   */
  getPendingTransactions(): PendingTransaction[] {
    return Array.from(this.pendingTransactions.values()).map((t) => ({
      hash: t.hash,
      simulationContext: t.simulationContext,
      submittedAt: t.submittedAt,
      intervalMs: t.intervalMs,
      deadline: t.deadline,
      label: t.label,
    }));
  }

  /**
   * Serializes the currently polling transactions to a JSON-safe object so
   * the dApp can persist it (e.g. to localStorage) and survive a page
   * refresh.
   *
   * Dates inside `simulationContext` are encoded with a `{ __date: ISO }`
   * marker so {@link importState} can revive them losslessly.
   */
  exportState(): ExportedState {
    const pending: SerializedPendingTransaction[] = [];
    for (const tx of this.pendingTransactions.values()) {
      pending.push({
        hash: tx.hash,
        simulationContext: freezeContext(tx.simulationContext),
        submittedAt: tx.submittedAt.toISOString(),
        intervalMs: tx.intervalMs,
        deadline: tx.deadline.toISOString(),
        label: tx.label,
      });
    }
    return {
      version: HYDRATION_STATE_VERSION,
      exportedAt: new Date().toISOString(),
      pending,
    };
  }

  /**
   * Re-initializes polling loops from a previously {@link exportState}'d
   * snapshot. Accepts the snapshot object or a JSON string.
   *
   * - Entries whose `deadline` has already passed are dropped.
   * - Entries whose hash is already being tracked are kept as-is (idempotent).
   * - Date markers inside `simulationContext` are revived back into Date
   *   instances.
   */
  importState(state: ExportedState | string): TrackedTransaction[] {
    const raw: unknown = typeof state === "string" ? JSON.parse(state) : state;
    if (!raw || typeof raw !== "object") {
      throw new AxionveraError("Invalid hydration state: expected object or JSON string");
    }
    const parsed = raw as { version?: unknown; pending?: unknown };
    if (parsed.version !== HYDRATION_STATE_VERSION) {
      throw new AxionveraError(
        `Unsupported hydration state version: ${String(parsed.version)} (expected ${String(HYDRATION_STATE_VERSION)})`
      );
    }
    if (!Array.isArray(parsed.pending)) {
      throw new AxionveraError("Invalid hydration state: `pending` must be an array");
    }

    const restored: TrackedTransaction[] = [];
    const now = Date.now();
    for (const candidate of parsed.pending as unknown[]) {
      if (!candidate || typeof candidate !== "object") continue;
      const entry = candidate as Partial<SerializedPendingTransaction>;
      if (typeof entry.hash !== "string" || entry.hash.length === 0) continue;

      const existing = this.pendingTransactions.get(entry.hash);
      if (existing) {
        restored.push(existing);
        continue;
      }
      const deadline =
        typeof entry.deadline === "string" ? new Date(entry.deadline) : new Date(NaN);
      if (Number.isNaN(deadline.getTime()) || deadline.getTime() <= now) continue;

      const intervalMs =
        typeof entry.intervalMs === "number" && entry.intervalMs > 0
          ? entry.intervalMs
          : 1_000;
      const tracked = this.trackTransaction({
        hash: entry.hash,
        simulationContext: thawContext(entry.simulationContext),
        intervalMs,
        deadline,
        label: entry.label,
      });
      restored.push(tracked);
    }
    return restored;
  ): Promise<TransactionPollResult> {
    return this.executeWithErrorHandling(async () => {
      const timeoutMs = params?.timeoutMs ?? 30_000;
      const intervalMs = params?.intervalMs ?? 1_000;
      const onProgress = params?.onProgress;

      validatePollingInterval(timeoutMs, "timeoutMs", true);
      validatePollingInterval(intervalMs, "intervalMs", false);

      return await new Promise<TransactionPollResult>((resolve, reject) => {
        let settled = false;
        let pollTimer: ReturnType<typeof setTimeout> | undefined;

        const clearTimers = () => {
          clearTimeout(timeoutTimer);
          if (pollTimer) {
            clearTimeout(pollTimer);
          }
        };

        const settle = (callback: () => void) => {
          if (settled) {
            return;
          }

          settled = true;
          clearTimers();
          callback();
        };

        const scheduleNextPoll = () => {
          if (settled) {
            return;
          }

          pollTimer = setTimeout(() => {
            void pollOnce();
          }, intervalMs);
        };

        const timeoutTimer = setTimeout(() => {
          settle(() => {
            reject(
              new TransactionTimeoutError(
                `Timed out waiting for transaction ${hash} after ${timeoutMs}ms`
              )
            );
          });
        }, timeoutMs);

        const pollOnce = async () => {
          try {
            const res = await this.getTransaction(hash);
            if (settled) {
              return;
            }

            const parsed = parseTransactionPollResult(res);

            if (onProgress) {
              Promise.resolve()
                .then(() => onProgress(parsed.status, parsed.ledger ?? 0))
                .catch((err) => {
                  this.logger.warn("onProgress callback error", err);
                });
            }

            if (parsed.status === "SUCCESS" || parsed.status === "FAILED") {
              settle(() => resolve(parsed));
              return;
            }

            scheduleNextPoll();
          } catch (error) {
            if (settled) {
              return;
            }

            settle(() => reject(error));
          }
        };

        void pollOnce();
      });
    }, `Failed while polling transaction ${hash}`);
  }

  /**
   * Waits for a transaction to be confirmed or rejected with a Promise-based API.
   * 
   * This is a convenience wrapper around pollTransaction that provides a simpler,
   * more intuitive API for the common use case of waiting for a transaction to complete.
   * It resolves when the transaction reaches a final state (SUCCESS or FAILED),
   * or rejects if the transaction times out.
   * 
   * Similar to waitForTransactionReceipt in EVM libraries like viem, making it easier
   * for developers moving from Ethereum to Stellar/Soroban.
   * 
   * @param hash - The transaction hash to wait for
   * @param params - Wait parameters
   * @param params.timeoutMs - Maximum time to wait in milliseconds (default: 30_000)
   * @param params.intervalMs - Time between polls in milliseconds (default: 1_000)
   * @param params.onProgress - Optional callback to track polling progress
   * @returns Promise that resolves with the transaction result when confirmed, or rejects on timeout
   * @throws NetworkError if the transaction doesn't reach a final state within timeoutMs
   * 
   * @example
   * ```typescript
   * // Simple usage - wait for transaction with defaults (30 seconds)
   * const result = await client.waitForTransaction(txHash);
   * console.log('Transaction confirmed:', result);
   * 
   * // With custom timeout and polling interval
   * const result = await client.waitForTransaction(txHash, {
   *   timeoutMs: 60_000,     // Wait up to 60 seconds
   *   intervalMs: 500        // Poll every 500ms
   * });
   * 
   * // With progress tracking
   * const result = await client.waitForTransaction(txHash, {
   *   onProgress: (status, ledger) => {
   *     console.log(`Status: ${status}, Ledger: ${ledger}`);
   *   }
   * });
   * 
   * // In a typical usage flow
   * const signed = await client.sendTransaction(tx);
   * try {
   *   const confirmed = await client.waitForTransaction(signed.hash);
   *   console.log('Success:', confirmed);
   * } catch (error) {
   *   if (error instanceof NetworkError) {
   *     console.log('Transaction took too long to confirm');
   *   } else {
   *     console.log('Transaction failed or errored:', error);
   *   }
   * }
   * ```
   */
  async waitForTransaction(
    hash: string,
    params?: {
      timeoutMs?: number;
      intervalMs?: number;
      onProgress?: (status: string, ledger: number) => void | Promise<void>;
    }
  ): Promise<unknown> {
    return this.pollTransaction(hash, params);
  }

  /**
   * Retrieves the status of a transaction.
   * Alias for getTransaction() - provided for compatibility and clarity.
   * @param hash - The transaction hash
   * @returns The transaction status
   * @deprecated Use getTransaction() instead
   */
  async getTransactionStatus(hash: string): Promise<unknown> {
    this.logger.debug(`Fetching transaction status for ${hash}`);
    return this.executeWithErrorHandling(
      () => retry(() => this.rpc.getTransaction(hash), this.retryConfig),
      `Failed to fetch transaction ${hash}`
    );
  }
  /**
   * Signs a transaction using a local Keypair.
   * This is a convenience method for local signing without a wallet connector.
   * @param tx - The transaction to sign
   * @param keypair - The keypair to sign with
   * @returns The signed transaction
   */
  async signWithKeypair(tx: Transaction, keypair: Keypair): Promise<Transaction> {
    tx.sign(keypair);
    return tx;
  }

  /**
   * Parses a base64-encoded transaction XDR string.
   * @param transactionXdr - The base64-encoded transaction
   * @param networkPassphrase - The network passphrase
   * @returns The parsed Transaction or FeeBumpTransaction
   */
  static parseTransactionXdr(
    transactionXdr: string,
    networkPassphrase: string
  ): Transaction | FeeBumpTransaction {
    return TransactionBuilder.fromXDR(transactionXdr, networkPassphrase);
  }

  /**
   * Serializes an unsigned transaction to a Base64 JSON string for offline signing.
   * This is critical for air-gapped signing workflows or hardware security module (HSM) integrations.
   * @param tx - The transaction to serialize (Transaction or FeeBumpTransaction)
   * @returns Base64-encoded JSON string containing transaction XDR, network passphrase, and timeout limits
   */
  serializeTransaction(tx: Transaction | FeeBumpTransaction): string {
    const serializedData = {
      xdr: tx.toXDR(),
      networkPassphrase: this.networkPassphrase,
      timeout: tx.timeBounds?.maxTime || null,
      fee: tx.fee.toString(),
      sourceAccount: tx.sourceAccount().accountId(),
      sequence: tx.sequence,
      memo: tx.memo ? tx.memo.value : null,
      operations: tx.operations.map((op: any) => ({
        type: op.type,
        source: op.source ? op.source : null,
        // Basic operation serialization - can be extended based on needs
      }))
    };
    
    if (typeof Buffer === 'undefined') {
      throw new Error('Buffer is not defined. Please polyfill Buffer for React Native/mobile environments.');
    }
    return Buffer.from(JSON.stringify(serializedData)).toString('base64');
  }


  /**
   * Deserializes a transaction from a Base64 JSON string.
   * Reconstructs the exact Transaction or FeeBumpTransaction object.
   * @param jsonString - The Base64-encoded JSON string from serializeTransaction
   * @returns The reconstructed Transaction or FeeBumpTransaction
   */
  deserializeTransaction(jsonString: string): Transaction | FeeBumpTransaction {
    if (typeof Buffer === 'undefined') {
      throw new Error('Buffer is not defined. Please polyfill Buffer for React Native/mobile environments.');
    }
    try {
      const decodedJson = Buffer.from(jsonString, 'base64').toString('utf8');

      const serializedData = JSON.parse(decodedJson);

      // Validate required fields
      if (!serializedData.xdr || !serializedData.networkPassphrase) {
        throw new Error('Invalid serialized transaction: missing required fields');
      }

      // Parse the transaction from XDR
      const tx = TransactionBuilder.fromXDR(serializedData.xdr, serializedData.networkPassphrase);

      return tx;
    } catch (error) {
      throw new Error(`Failed to deserialize transaction: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
  }

  /**
   * Verifies that a deserialized transaction matches the hash of the original.
   * @param originalTx - The original transaction
   * @param deserializedTx - The deserialized transaction
   * @returns True if the hashes match
   */
  static verifyTransactionHash(
    originalTx: Transaction | FeeBumpTransaction,
    deserializedTx: Transaction | FeeBumpTransaction
  ): boolean {
    const originalHash = originalTx.hash().toString('hex');
    const deserializedHash = deserializedTx.hash().toString('hex');
    return originalHash === deserializedHash;
  }

  /**
   * Gets the default network passphrase for a given network.
   * @param network - The network ("testnet" or "mainnet")
   * @returns The corresponding network passphrase
   */
  static getDefaultNetworkPassphrase(network: AxionveraNetwork): string {
    return getNetworkPassphrase(network);
  }

  /**
   * Get concurrency control statistics
   */
  getConcurrencyStats() {
    if (!this.concurrencyEnabled) {
      return {
        enabled: false,
        message: 'Concurrency control is not enabled'
      };
    }

    // Try to get stats from the wrapped client if it has the method
    if ('getStats' in this.rpc && typeof this.rpc.getStats === 'function') {
      return {
        enabled: true,
        ...this.rpc.getStats()
      };
    }

    return {
      enabled: true,
      maxConcurrentRequests: this.concurrencyConfig.maxConcurrentRequests,
      queueTimeout: this.concurrencyConfig.queueTimeout,
      message: 'Stats not available from wrapped client'
    };
  }

  /**
   * Get detailed queue status for monitoring
   */
  getQueueStatus() {
    if (!this.concurrencyEnabled) {
      return {
        enabled: false,
        message: 'Concurrency control is not enabled'
      };
    }

    // Try to get detailed status from the wrapped client if it has the method
    if ('getQueueStatus' in this.rpc && typeof this.rpc.getQueueStatus === 'function') {
      return {
        enabled: true,
        ...this.rpc.getQueueStatus()
      };
    }

    // Fallback to basic stats
    return this.getConcurrencyStats();
  }

  /**
   * Subscribe to real-time events via WebSocket.
   * @param filter - Event filter criteria
   * @param callback - Callback function for received events
   * @returns Subscription ID that can be used to unsubscribe
   */
  async subscribeToEvents(
    filter: EventFilter,
    callback: (event: SorobanEvent) => void
  ): Promise<string> {
    if (!this.webSocketManager) {
      throw new NetworkError('WebSocket manager not initialized. Please provide webSocketConfig in constructor.');
    }

    // Connect WebSocket if not already connected
    if (!this.webSocketManager.isConnected()) {
      await this.webSocketManager.connect();
    }

    return this.webSocketManager.subscribe(filter, callback);
  }

  /**
   * Unsubscribe from real-time events.
   * @param subscriptionId - The subscription ID returned by subscribeToEvents
   */
  unsubscribeFromEvents(subscriptionId: string): void {
    if (this.webSocketManager) {
      this.webSocketManager.unsubscribe(subscriptionId);
    }
  }

  /**
   * Get WebSocket connection status and statistics.
   */
  getWebSocketStatus() {
    if (!this.webSocketManager) {
      return {
        enabled: false,
        connected: false,
        subscriptions: 0,
        message: 'WebSocket manager not initialized'
      };
    }

    return {
      enabled: true,
      connected: this.webSocketManager.isConnected(),
      subscriptions: this.webSocketManager.getSubscriptionCount(),
    };
  }

  /**
   * Disconnect WebSocket and cleanup resources.
   */
  disconnectWebSocket(): void {
    if (this.webSocketManager) {
      this.webSocketManager.disconnect();
    }
  }

  /**
   * Get CloudWatch logging statistics.
   */
  getCloudWatchStats() {
    return this.logger.getCloudWatchStats();
  }

  /**
   * Alias for cleanup(). Removes all active subscriptions and listeners.
   * Useful in React useEffect cleanup blocks.
   * 
   * @example
   * ```typescript
   * useEffect(() => {
   *   return () => client.removeAllListeners();
   * }, [client]);
   * ```
   */
  public removeAllListeners(): void {
    this.cleanup();
  }

  /**
   * Cleanup all async resources including WebSocket and CloudWatch.
   */
  async cleanup(): Promise<void> {
    this.disconnectWebSocket();
    await this.logger.destroy();
  }

  private async executeWithErrorHandling<T>(fn: () => Promise<T>, fallbackMessage: string): Promise<T> {
    try {
      return await fn();
    } catch (error: unknown) {
      this.logger.error(fallbackMessage, error);
      throw toAxionveraError(error, fallbackMessage);
    }
  }

  private applyFeeBuffer(tx: Transaction): Transaction {
    const sorobanData = tx.toEnvelope().v1().tx().ext().value();
    if (!sorobanData) {
      return tx;
    }

    const resources = sorobanData.resources();
    const simulatedResourceFee = sorobanData.resourceFee().toBigInt();
    const simulatedTotalFee = BigInt(tx.fee);
    const simulatedBaseFee = simulatedTotalFee > simulatedResourceFee
      ? simulatedTotalFee - simulatedResourceFee
      : BigInt(0);

    const bufferedResourceFee = multiplyAndCeil(simulatedResourceFee, this.feeBufferMultiplier);
    const bufferedBaseFee = multiplyAndCeil(simulatedBaseFee, this.feeBufferMultiplier);
    const bufferedTotalFee = bufferedBaseFee + bufferedResourceFee;

    if (this.maxFeeLimit !== undefined) {
      if (this.maxFeeLimit < simulatedTotalFee) {
        throw new ValidationError(
          `maxFeeLimit (${this.maxFeeLimit.toString()}) is below the simulated minimum fee (${simulatedTotalFee.toString()})`
        );
      }

      if (bufferedTotalFee > this.maxFeeLimit) {
        throw new ValidationError(
          `Buffered fee (${bufferedTotalFee.toString()}) exceeds maxFeeLimit (${this.maxFeeLimit.toString()})`
        );
      }
    }

    const bufferedSorobanData = new SorobanDataBuilder(sorobanData)
      .setResources(
        multiplyAndCeil(resources.instructions(), this.feeBufferMultiplier),
        multiplyAndCeil(resources.diskReadBytes(), this.feeBufferMultiplier),
        multiplyAndCeil(resources.writeBytes(), this.feeBufferMultiplier)
      )
      .setResourceFee(bufferedResourceFee.toString())
      .build();

    return TransactionBuilder.cloneFrom(tx, {
      fee: bufferedBaseFee.toString(),
      networkPassphrase: tx.networkPassphrase,
      sorobanData: bufferedSorobanData
    }).build();
  }
}

/**
 * Extracts cursor parameter from a URL.
 * @param url - The URL to extract cursor from
 * @returns The cursor value or undefined
 */
function extractCursor(url: string): string | undefined {
  try {
    const urlObj = new URL(url);
    return urlObj.searchParams.get('cursor') ?? undefined;
  } catch {
    return undefined;
  }
}

function multiplyAndCeil(value: number | bigint | string, multiplier: number): bigint {
  const scaledValue = typeof value === "bigint" ? value : BigInt(String(value));
  if (scaledValue < BigInt(0)) {
    throw new ValidationError("Cannot buffer a non-finite or negative resource value");
  }

  const { numerator, denominator } = toFraction(multiplier);
  return (scaledValue * numerator + (denominator - BigInt(1))) / denominator;
}

function toFraction(multiplier: number): { numerator: bigint; denominator: bigint } {
  if (!Number.isFinite(multiplier) || multiplier < 0) {
    throw new ValidationError("feeBufferMultiplier must be a finite number greater than or equal to 0");
  }

  const decimalString = multiplier.toString().includes("e")
    ? multiplier.toFixed(12).replace(/0+$/, "").replace(/\.$/, "")
    : multiplier.toString();
  const [wholePart, fractionalPart = ""] = decimalString.split(".");

  if (!/^\d+$/.test(wholePart) || !/^\d*$/.test(fractionalPart)) {
    throw new ValidationError("feeBufferMultiplier must be a valid decimal number");
  }

  const denominator = BigInt(10) ** BigInt(fractionalPart.length);
  const numerator = BigInt(`${wholePart}${fractionalPart}`);

  return {
    numerator,
    denominator: denominator === BigInt(0) ? BigInt(1) : denominator
  };
}

function validatePollingInterval(value: number, fieldName: string, allowZero: boolean): void {
  const valid = Number.isFinite(value) && (allowZero ? value >= 0 : value > 0);
  if (!valid) {
    throw new ValidationError(`${fieldName} must be a finite ${allowZero ? "non-negative" : "positive"} number`);
  }
}

function parseTransactionPollResult(response: unknown): TransactionPollResult {
  const record = isRecord(response) ? response : {};
  const status = typeof record.status === "string" ? record.status : "UNKNOWN";

  return {
    ...record,
    status,
    ledger: normalizeLedger(record.ledger)
  };
}

function normalizeLedger(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }

  if (typeof value === "string" && value.trim() !== "") {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) {
      return parsed;
    }
  }

  return null;
}

function isRecord(value: unknown): value is TransactionResponseRecord {
  return typeof value === "object" && value !== null;
}
