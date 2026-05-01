import {
  Account,
  FeeBumpTransaction,
  Keypair,
  Networks,
  Operation,
  rpc,
  SorobanDataBuilder,
  Transaction,
  TransactionBuilder
} from "@stellar/stellar-sdk";

import { AxionveraNetwork, resolveNetworkConfig } from "../utils/networkConfig";
import { ConcurrencyConfig, DEFAULT_CONCURRENCY_CONFIG, createConcurrencyControlledClient } from "../utils/concurrencyQueue";
import { RetryConfig, createHttpClientWithRetry, retry } from "../utils/httpInterceptor";
import { normalizeRpcError, normalizeTransactionError, TimeoutError, InsecureNetworkError, AxionveraError, AxionveraRPCError, SimulationFailedError, InvalidXDRError } from "../errors/axionveraError";
import { assertValidXDR } from '../utils/xdrValidator';
import { normalizeRpcError, normalizeTransactionError, TransactionTimeoutError, InsecureNetworkError, AxionveraError, AxionveraRPCError, SimulationFailedError, ValidationError, toAxionveraError } from "../errors/axionveraError";
import { WebSocketManager } from "./websocket/websocketManager";
import { WebSocketConfig } from "./websocket/types";
import { Logger } from "../utils/logger";
import { WalletConnector } from "../wallet/walletConnector";

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
  webSocketConfig?: WebSocketConfig;
  logger?: Logger;
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

/** Walk a value, replacing Date instances with `{ __date: ISO }` markers. */
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
      out[key] = freezeDates((value as { [key: string]: SerializableValue })[key] as SerializableValue);
    }
    return out;
  }
  return value;
}

/** Walk a value, restoring `{ __date: ISO }` markers into Date instances. */
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
export class StellarClient {
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
  readonly concurrencyConfig: ConcurrencyConfig;
  /** Whether concurrency control is enabled. */
  readonly concurrencyEnabled: boolean;
  /** WebSocket manager for real-time event subscriptions. */
  readonly webSocketManager?: WebSocketManager;
  /** Logger instance for debugging and monitoring. */
  readonly logger: Logger;
  /** In-memory registry of currently polling transactions. */
  private readonly pendingTransactions = new Map<string, TrackedTransaction>();
/** Timeout for account fetching in milliseconds. */
  readonly accountFetchTimeoutMs: number;
  /** TTL for cached account sequence in milliseconds. */
  readonly cacheTtlMs: number;

  /** Private cache for account sequences with timestamps. */
  private accountSequenceCache: Map<string, { sequence: bigint; timestamp: number }>;
/** Cache time-to-live in milliseconds for account data. */
  private readonly CACHE_TTL = 5000;
  /** Account cache for offline support. */
  private accountCache: Map<string, { account: Account; timestamp: number }>;
  /** Optional wallet connector for transaction signing. */
  private wallet?: WalletConnector;
  /** Multiplier applied to simulated Soroban resources and fees. */
  readonly feeBufferMultiplier: number;
  /** Optional hard ceiling for the total prepared fee. */
  readonly maxFeeLimit?: bigint;

  /**
   * Creates a new StellarClient instance for interacting with Soroban RPC.
   * @param options - Configuration options for the client
   * @example
   * ```typescript
   * import { StellarClient } from "axionvera-sdk";
   *
   * // Connect to testnet with default settings
   * const client = new StellarClient({ network: "testnet" });
   *
   * // Connect to a custom RPC endpoint
   * const customClient = new StellarClient({
   *   rpcUrl: "https://your-custom-rpc.com",
   *   networkPassphrase: "Public Global Stellar Network ; September 2015"
   * });
   *
   * // Enable concurrency control for high-volume apps
   * const highVolumeClient = new StellarClient({
   *   network: "mainnet",
   *   concurrencyConfig: {
   *     maxConcurrentRequests: 10,
   *     queueTimeout: 5000
   *   }
   * });
   * ```
   */
   constructor(options?: StellarClientOptions) {
     const config = resolveNetworkConfig(options);
     this.network = config.network;
     this.rpcUrl = config.rpcUrl;
     this.networkPassphrase = config.networkPassphrase;

     // Validate RPC URL has a protocol
     if (!this.rpcUrl.startsWith('http://') && !this.rpcUrl.startsWith('https://')) {
       throw new AxionveraError('RPC URL must include a protocol (http:// or https://)');
     }

     // Security guard: prevent insecure HTTP in production unless explicitly allowed
     const isProduction = process.env.NODE_ENV === 'production';
     const isHttp = this.rpcUrl.startsWith('http://');
     const isLocalhost = isLocalhostUrl(this.rpcUrl);
     const allowHttp = options?.allowHttp ?? false;

     if (isProduction && isHttp && !isLocalhost && !allowHttp) {
       throw new InsecureNetworkError(
         'Insecure RPC connection in production: HTTP endpoint detected. ' +
         'Use HTTPS for production or set allowHttp: true to override. ' +
         'Note: localhost endpoints are always permitted.'
       );
     }

     this.concurrencyConfig = {
      ...DEFAULT_CONCURRENCY_CONFIG,
      ...options?.concurrencyConfig
    };
    this.concurrencyEnabled = !!options?.concurrencyConfig;
    this.retryConfig = options?.retryConfig ?? {};
    this.httpClient = createHttpClientWithRetry(this.retryConfig);
    this.logger = options?.logger ?? new Logger();
this.accountFetchTimeoutMs = options?.accountFetchTimeoutMs ?? 2000;
    this.cacheTtlMs = options?.cacheTtlMs ?? 5000;
    this.accountSequenceCache = new Map();
this.accountCache = new Map();
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
   * Checks the health of the RPC server with automatic retry on failure.
   * @returns The health check response containing status information
   * @example
   * ```typescript
   * import { StellarClient } from "axionvera-sdk";
   *
   * const client = new StellarClient({ network: "testnet" });
   * const health = await client.getHealth();
   * console.log("RPC Status:", health.status);
   * ```
   */
  async getHealth(): Promise<rpc.Api.GetHealthResponse> {
    try {
      return await retry(() => this.rpc.getHealth(), this.retryConfig);
    } catch (error) {
      throw new AxionveraRPCError(
        error instanceof Error ? error.message : 'RPC operation failed: getHealth',
        'getHealth',
        { originalError: error }
      );
    }
  }

  /**
   * Retrieves network information including the network passphrase and friendbot URL.
   * @returns The network information response
   * @example
   * ```typescript
   * import { StellarClient } from "axionvera-sdk";
   *
   * const client = new StellarClient({ network: "testnet" });
   * const network = await client.getNetwork();
   * console.log("Network passphrase:", network.networkPassphrase);
   * console.log("Friendbot URL:", network.friendbotUrl);
   * ```
   */
  async getNetwork(): Promise<rpc.Api.GetNetworkResponse> {
    try {
      return await retry(() => this.rpc.getNetwork(), this.retryConfig);
    } catch (error) {
      throw new AxionveraRPCError(
        error instanceof Error ? error.message : 'RPC operation failed: getNetwork',
        'getNetwork',
        { originalError: error }
      );
    }
  }

  /**
   * Retrieves information about the latest ledger on the network.
   * @returns The latest ledger response containing sequence, timestamp, and protocol version
   * @example
   * ```typescript
   * import { StellarClient } from "axionvera-sdk";
   *
   * const client = new StellarClient({ network: "testnet" });
   * const ledger = await client.getLatestLedger();
   * console.log("Latest sequence:", ledger.sequence);
   * console.log("Timestamp:", new Date(ledger.closedAt * 1000).toISOString());
   * ```
   */
  async getLatestLedger(): Promise<rpc.Api.GetLatestLedgerResponse> {
    try {
      return await retry(() => this.rpc.getLatestLedger(), this.retryConfig);
    } catch (error) {
      throw new AxionveraRPCError(
        error instanceof Error ? error.message : 'RPC operation failed: getLatestLedger',
        'getLatestLedger',
        { originalError: error }
      );
    }
  }

  /**
   * Retrieves an account's information from the network with automatic retry on failure.
   * @param publicKey - The account's public key (G-prefixed string)
   * @returns The account information including sequence number and balances
   * @example
   * ```typescript
   * import { StellarClient } from "axionvera-sdk";
   *
   * const client = new StellarClient({ network: "testnet" });
   * const account = await client.getAccount("GD5JPQ7VKFOVRWPOEX74JYXHHFNTFZ2JE5WZ4K2MWTROVHMWHD7KUZ2V");
   * console.log("Sequence:", account.sequenceNumber().toString());
   * console.log("Balance:", account.balance());
   * ```
   */
  async getAccount(publicKey: string): Promise<Account> {
    return retry(() => this.rpc.getAccount(publicKey), this.retryConfig);
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
      const sequence = account.sequenceNumber().toString();
      this.updateCache(publicKey, sequence);
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
   * Retrieves an account's information with offline cache fallback.
   * Tries to fetch from the network first, but falls back to cached data if the network is unavailable.
   * The cache is valid for 5 seconds and sequence numbers are incremented for sequential offline builds.
   * @param publicKey - The account's public key (G-prefixed string)
   * @returns The account information including sequence number and balances
   * @throws AxionveraError if both network fetch fails and no valid cache exists
   * @example
   * ```typescript
   * import { StellarClient } from "axionvera-sdk";
   *
   * const client = new StellarClient({ network: "testnet" });
   *
   * // First call fetches from network and caches the result
   * const account1 = await client.getAccountWithCache("GD5JPQ7VKFOVRWPOEX74JYXHHFNTFZ2JE5WZ4K2MWTROVHMWHD7KUZ2V");
   * console.log("Sequence:", account1.sequenceNumber().toString());
   *
   * // If network fails within 5 seconds, returns cached account with incremented sequence
   * const account2 = await client.getAccountWithCache("GD5JPQ7VKFOVRWPOEX74JYXHHFNTFZ2JE5WZ4K2MWTROVHMWHD7KUZ2V");
   * console.log("Cached sequence:", account2.sequenceNumber().toString());
   * ```
   */
  async getAccountWithCache(publicKey: string): Promise<Account> {
    try {
      // Try to fetch from network
      const account = await this.getAccount(publicKey);
      // Update cache on success
      this.accountCache.set(publicKey, {
        account,
        timestamp: Date.now()
      });
      return account;
    } catch (error) {
      // Network failed, check cache
      const cached = this.accountCache.get(publicKey);
      if (cached && (Date.now() - cached.timestamp < this.CACHE_TTL)) {
        this.logger.debug(`Using cached account for ${publicKey}`);
        // Increment sequence for sequential offline builds
        const currentSequence = cached.account.sequenceNumber();
        const newSequence = currentSequence + 1n;
        // Create new account with incremented sequence
        const cachedAccount = new Account(publicKey, newSequence.toString());
        // Update cache with incremented sequence
        this.accountCache.set(publicKey, {
          account: cachedAccount,
          timestamp: cached.timestamp
        });
        return cachedAccount;
      }
      // No valid cache, throw error
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
   * Clears the account cache, removing all cached account data.
   * Useful for testing or when you need to force fresh data from the network.
   * @example
   * ```typescript
   * import { StellarClient } from "axionvera-sdk";
   *
   * const client = new StellarClient({ network: "testnet" });
   *
   * // Clear cache to force fresh network fetch
   * client.clearAccountCache();
   * console.log("Account cache cleared");
   * ```
   */
  clearAccountCache(): void {
    this.accountCache.clear();
    this.logger.debug("Account cache cleared");
  }

  /**
   * Simulates a transaction without submitting it to test validity and estimate costs.
   * @param tx - The transaction to simulate (Transaction or FeeBumpTransaction)
   * @returns The simulation result with resource costs and any diagnostic events
   * @throws SimulationFailedError if the transaction would fail during execution
   * @example
   * ```typescript
   * import { StellarClient, TransactionBuilder } from "axionvera-sdk";
   * import { Keypair } from "@stellar/stellar-sdk";
   *
   * const client = new StellarClient({ network: "testnet" });
   * const keypair = Keypair.random();
   * const account = await client.getAccount(keypair.publicKey());
   *
   * const tx = new TransactionBuilder(account, {
   *   fee: "100",
   *   networkPassphrase: client.networkPassphrase
   * })
   *   .setTimeout(30)
   *   .build();
   *
   * const simulation = await client.simulateTransaction(tx);
   * console.log("CPU instructions:", simulation.results[0].cpuInstructions);
   * console.log("Memory bytes:", simulation.results[0].memoryBytes);
   * ```
   */
  async simulateTransaction(
    tx: Transaction | FeeBumpTransaction
  ): Promise<rpc.Api.SimulateTransactionResponse> {
    try {
      const result = await this.rpc.simulateTransaction(tx);
      if (rpc.Api.isSimulationError(result)) {
        throw new SimulationFailedError(result.error, { simulationResult: result });
      }
      return result;
    } catch (error) {
      if (error instanceof SimulationFailedError) throw error;
      throw new SimulationFailedError(
        error instanceof Error ? error.message : 'Transaction simulation failed',
        { originalError: error }
      );
    }
  }

  /**
   * Prepares a transaction by fetching the current ledger sequence and setting the correct min sequence age.
   * @param tx - The transaction to prepare (Transaction or FeeBumpTransaction)
   * @returns The prepared transaction with updated sequence and fee information
   * @example
   * ```typescript
   * import { StellarClient, TransactionBuilder } from "axionvera-sdk";
   * import { Keypair } from "@stellar/stellar-sdk";
   *
   * const client = new StellarClient({ network: "testnet" });
   * const keypair = Keypair.random();
   * const account = await client.getAccount(keypair.publicKey());
   *
   * const tx = new TransactionBuilder(account, {
   *   fee: "100",
   *   networkPassphrase: client.networkPassphrase
   * })
   *   .setTimeout(30)
   *   .build();
   *
   * const preparedTx = await client.prepareTransaction(tx);
   * console.log("Prepared sequence:", preparedTx.sequence);
   * ```
   */
  async prepareTransaction(tx: Transaction | FeeBumpTransaction): Promise<Transaction> {
    if (tx instanceof FeeBumpTransaction) {
      try {
        return await this.rpc.prepareTransaction(tx);
      } catch (error) {
        throw toAxionveraError(error, "Failed to prepare transaction");
      }
    }

    try {
      const simulation = await this.simulateTransaction(tx);
      const assembledTx = rpc.assembleTransaction(tx, simulation).build();
      return this.applyFeeBuffer(assembledTx);
    } catch (error) {
      if (error instanceof AxionveraError) {
        throw error;
      }

      throw toAxionveraError(error, "Failed to prepare transaction");
    }
  }

  /**
   * Submits a signed transaction to the network, optionally signing with a wallet connector if configured.
   * @param tx - The signed transaction to submit (Transaction or FeeBumpTransaction)
   * @returns The submission result containing the transaction hash and status
   * @example
   * ```typescript
   * import { StellarClient, TransactionBuilder } from "axionvera-sdk";
   * import { Keypair } from "@stellar/stellar-sdk";
   *
   * const client = new StellarClient({ network: "testnet" });
   * const keypair = Keypair.random();
   * const account = await client.getAccount(keypair.publicKey());
   *
   * const tx = new TransactionBuilder(account, {
   *   fee: "100",
   *   networkPassphrase: client.networkPassphrase
   * })
   *   .setTimeout(30)
   *   .build();
   *
   * tx.sign(keypair);
   * const result = await client.sendTransaction(tx);
   * console.log("Transaction hash:", result.hash);
   * console.log("Status:", result.status);
   * ```
   */
  async sendTransaction(tx: Transaction | FeeBumpTransaction): Promise<TransactionSendResult> {
    let finalTx: Transaction | FeeBumpTransaction = tx;

    try {
      // If a wallet is available, sign the transaction before submission
      if (this.wallet) {
        // Convert transaction to XDR for wallet signing
        const txXdr = tx.toXDR();

        // Sign via wallet connector
        const signedXdr = await this.wallet.signTransaction(
          txXdr,
          this.networkPassphrase
        );

        // Sanitize the wallet-returned XDR before parsing to prevent
        // injection / buffer panic from a malicious wallet response.
        assertValidXDR(signedXdr, 'sendTransaction (wallet signedXdr)');

        // Reconstruct signed transaction from XDR
        try {
          finalTx = TransactionBuilder.fromXDR(
            signedXdr,
            this.networkPassphrase
          );
        } catch (err) {
          throw new InvalidXDRError(
            `sendTransaction: wallet returned an XDR string that could not be parsed: ${
              err instanceof Error ? err.message : String(err)
            }`,
            signedXdr,
            { originalError: err },
          );
        }
      }

      // Submit either original or signed transaction
      const result = await this.rpc.sendTransaction(finalTx);
      const hash = (result as any).hash ?? (result as any).id ?? "";
      const status = (result as any).status ?? (result as any).statusText ?? "unknown";
      return { hash, status, raw: result };
    } catch (error) {
      throw normalizeTransactionError(error);
    }
  }


  /**
   * Retrieves the status of a submitted transaction with automatic retry on failure.
   * @param hash - The transaction hash to query
   * @returns The transaction status response containing current state and details
   * @example
   * ```typescript
   * import { StellarClient } from "axionvera-sdk";
   *
   * const client = new StellarClient({ network: "testnet" });
   * const txStatus = await client.getTransaction("abc123...");
   * console.log("Status:", txStatus.status);
   * ```
   */
  async getTransaction(hash: string): Promise<unknown> {
    return retry(() => this.rpc.getTransaction(hash), this.retryConfig);
  }

  /**
   * Polls for a transaction to be confirmed or rejected.
   *
   * The transaction is also registered in the in-memory pending-transaction
   * registry so that {@link exportState} can capture it for later
   * {@link importState} hydration (e.g. after a page refresh).
   *
   * Polls for a transaction to be confirmed or rejected, waiting until it reaches a final state.
   * @param hash - The transaction hash to wait for
   * @param params - Optional polling parameters
   * @param params.timeoutMs - Maximum time to wait in milliseconds (default: 30000)
   * @param params.intervalMs - Time between polls in milliseconds (default: 1000)
/** Cache time-to-live in milliseconds for account data. */
  private readonly CACHE_TTL = 5000;
  /** Account cache for offline support. */
  private accountCache: Map<string, { account: Account; timestamp: number }>;
  /** Optional wallet connector for transaction signing. */
  private wallet?: WalletConnector;
  /** Multiplier applied to simulated Soroban resources and fees. */
  readonly feeBufferMultiplier: number;
  /** Optional hard ceiling for the total prepared fee. */
  readonly maxFeeLimit?: bigint;
   */
  async pollTransaction(
    hash: string,
    params?: { timeoutMs?: number; intervalMs?: number }
  ): Promise<unknown> {
    const tracked = this.trackTransaction({
      hash,
      timeoutMs: params?.timeoutMs,
      intervalMs: params?.intervalMs,
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
   *
   * @param options - Tracking options including hash, optional simulation
   * context, polling cadence, and timeout/deadline.
   */
  trackTransaction(options: TrackTransactionOptions): TrackedTransaction {
    const existing = this.pendingTransactions.get(options.hash);
    if (existing) return existing;

    const intervalMs = options.intervalMs ?? 1_000;
    const submittedAt = new Date();
    const deadline =
      options.deadline ??
      new Date(submittedAt.getTime() + (options.timeoutMs ?? 30_000));

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

    tracked.promise = (async (): Promise<unknown> => {
      try {
        while (!cancelled && Date.now() < deadline.getTime()) {
          const res = await this.getTransaction(options.hash);
          const status = (res as { status?: string } | null | undefined)?.status;
          if (status && status !== "NOT_FOUND") {
            return res;
          }
          await new Promise<void>((r) => setTimeout(r, intervalMs));
        }
        if (cancelled) {
          throw new AxionveraError(
            `Transaction tracking cancelled for ${options.hash}`
          );
        }
        throw new TimeoutError(
          `Timed out waiting for transaction ${options.hash} after ${String(
            deadline.getTime() - submittedAt.getTime()
          )}ms`
        );
      } finally {
        this.pendingTransactions.delete(options.hash);
      }
    })();

    // Avoid unhandled-rejection warnings if the caller ignores the promise.
    tracked.promise.catch(() => undefined);

    return tracked;
  }

  /**
   * Returns the list of currently polling transactions (a live view).
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
  ): Promise<TransactionPollResult> {
    const timeoutMs = params?.timeoutMs ?? 30_000;
    const intervalMs = params?.intervalMs ?? 1_000;

    validatePollingInterval(timeoutMs, "timeoutMs", true);
    validatePollingInterval(intervalMs, "intervalMs", false);

    return new Promise<TransactionPollResult>((resolve, reject) => {
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
   *
   * @returns The list of restored {@link TrackedTransaction}s.
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
   * @returns Promise that resolves with the transaction result when confirmed, or rejects on timeout/failure
   * @throws TimeoutError if the transaction doesn't reach a final state within timeoutMs
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
   * // In a typical usage flow
   * const signed = await client.sendTransaction(tx);
   * try {
   *   const confirmed = await client.waitForTransaction(signed.hash);
   *   console.log('Success:', confirmed);
   * } catch (error) {
   *   if (error instanceof TimeoutError) {
   *     console.log('Transaction took too long to confirm');
   *   } else {
   *     console.log('Transaction failed:', error);
   *   }
   * }
   * ```
   */
  async waitForTransaction(
    hash: string,
    params?: { timeoutMs?: number; intervalMs?: number }
  ): Promise<unknown> {
    return this.pollTransaction(hash, params);
  }

  /**
   * Signs a transaction using a local Keypair.
   * This is a convenience method for local signing without a wallet connector.
   * Signs a transaction using a local Keypair for server-side or automated signing.
   * @param tx - The transaction to sign
   * @param keypair - The Keypair to sign with
   * @returns The signed transaction
   * @example
   * ```typescript
   * import { StellarClient, TransactionBuilder } from "axionvera-sdk";
   * import { Keypair } from "@stellar/stellar-sdk";
   *
   * const client = new StellarClient({ network: "testnet" });
   * const keypair = Keypair.fromSecret("S...");
   * const account = await client.getAccount(keypair.publicKey());
   *
   * const tx = new TransactionBuilder(account, {
   *   fee: "100",
   *   networkPassphrase: client.networkPassphrase
   * })
   *   .setTimeout(30)
   *   .build();
   *
   * const signedTx = await client.signWithKeypair(tx, keypair);
   * ```
   */
  async signWithKeypair(tx: Transaction, keypair: Keypair): Promise<Transaction> {
    tx.sign(keypair);
    return tx;
  }

  /**
   * Parses a base64-encoded transaction XDR string.
   *
   * Validates the string against the base64 alphabet and the maximum permitted
   * length before handing it to the stellar-sdk parser, preventing
   * injection / Buffer allocation panics from untrusted inputs.
   *
   * @param transactionXdr - The base64-encoded transaction (consumer-supplied)
   * @param networkPassphrase - The network passphrase
   * @returns The parsed Transaction or FeeBumpTransaction
   * @throws {InvalidXDRError} If the XDR string is invalid or oversized
   * Parses a base64-encoded transaction XDR string into a Transaction or FeeBumpTransaction object.
   * @param transactionXdr - The base64-encoded transaction XDR string
   * @param networkPassphrase - The network passphrase for the transaction
   * @returns The parsed Transaction or FeeBumpTransaction
   * @example
   * ```typescript
   * import { StellarClient } from "axionvera-sdk";
   *
   * const xdr = "AAAA..."; // Base64-encoded transaction XDR
   * const tx = StellarClient.parseTransactionXdr(
   *   xdr,
   *   "Test SDF Network ; September 2015"
   * );
   *
   * console.log("Source account:", tx.source);
   * ```
   */
  static parseTransactionXdr(
    transactionXdr: string,
    networkPassphrase: string
  ): Transaction | FeeBumpTransaction {
    // Sanitize before stellar-sdk Buffer allocation.
    assertValidXDR(transactionXdr, 'parseTransactionXdr');
    try {
      return TransactionBuilder.fromXDR(transactionXdr, networkPassphrase);
    } catch (err) {
      throw new InvalidXDRError(
        `parseTransactionXdr: failed to parse XDR: ${
          err instanceof Error ? err.message : String(err)
        }`,
        transactionXdr,
        { originalError: err },
      );
    }
  }

  /**
   * Gets the default network passphrase for a given Stellar network.
   * @param network - The network identifier ("testnet" or "mainnet")
   * @returns The corresponding network passphrase string
   * @example
   * ```typescript
   * import { StellarClient } from "axionvera-sdk";
   *
   * const testnetPassphrase = StellarClient.getDefaultNetworkPassphrase("testnet");
   * console.log(testnetPassphrase); // "Test SDF Network ; September 2015"
   *
   * const mainnetPassphrase = StellarClient.getDefaultNetworkPassphrase("mainnet");
   * console.log(mainnetPassphrase); // "Public Global Stellar Network ; September 2015"
   * ```
   */
  static getDefaultNetworkPassphrase(network: AxionveraNetwork): string {
    switch (network) {
      case "testnet":
        return Networks.TESTNET;
      case "mainnet":
        return Networks.PUBLIC;
      default:
        throw new AxionveraError(`Unknown network: ${network}`);
    }
  }

  /**
   * Gets concurrency control statistics if enabled, showing request queue metrics.
   * @returns Concurrency statistics including enabled status, max concurrent requests, and queue timeout
   * @example
   * ```typescript
   * import { StellarClient } from "axionvera-sdk";
   *
   * const client = new StellarClient({
   *   network: "mainnet",
   *   concurrencyConfig: {
   *     maxConcurrentRequests: 10,
   *     queueTimeout: 5000
   *   }
   * });
   *
   * const stats = client.getConcurrencyStats();
   * console.log("Concurrency enabled:", stats.enabled);
   * console.log("Max concurrent requests:", stats.maxConcurrentRequests);
   * ```
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
