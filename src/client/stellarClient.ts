import {
  Account,
  FeeBumpTransaction,
  Keypair,
  Networks,
  Operation,
  rpc,
  Transaction,
  TransactionBuilder
} from "@stellar/stellar-sdk";

import { AxionveraNetwork, resolveNetworkConfig } from "../utils/networkConfig";
import { ConcurrencyConfig, DEFAULT_CONCURRENCY_CONFIG, createConcurrencyControlledClient } from "../utils/concurrencyQueue";
import { RetryConfig, createHttpClientWithRetry, retry } from "../utils/httpInterceptor";
import { normalizeRpcError, normalizeTransactionError, TimeoutError, InsecureNetworkError, AxionveraError, AxionveraRPCError, SimulationFailedError } from "../errors/axionveraError";
import { WebSocketManager } from "./websocket/websocketManager";
import { WebSocketConfig } from "./websocket/types";
import { Logger } from "../utils/logger";

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
  /** Timeout for account fetching in milliseconds. */
  readonly accountFetchTimeoutMs: number;
  /** TTL for cached account sequence in milliseconds. */
  readonly cacheTtlMs: number;

  /** Private cache for account sequences with timestamps. */
  private accountSequenceCache: Map<string, { sequence: bigint; timestamp: number }>;

  /**
   * Creates a new StellarClient instance.
   * @param options - Configuration options
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
   * Retrieves an account's information from the network.
   * Automatically retries on failure.
   * @param publicKey - The account's public key
   * @returns The account information
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
   * Prepares a transaction by fetching the current ledger sequence
   * and setting the correct min sequence age.
   * @param tx - The transaction to prepare
   * @returns The prepared transaction
   */
  async prepareTransaction(tx: Transaction | FeeBumpTransaction): Promise<Transaction> {
    return this.rpc.prepareTransaction(tx);
  }

  /**
   * Submits a signed transaction to the network.
   * @param tx - The signed transaction to submit
   * @returns The submission result containing hash and status
   */
  async sendTransaction(tx: Transaction | FeeBumpTransaction): Promise<TransactionSendResult> {
    let finalTx: Transaction | FeeBumpTransaction = tx;

    try {
      // If a wallet is available, sign the transaction before submission
      if ((this as any).wallet) {
        const wallet = (this as any).wallet;

        // Convert transaction to XDR for wallet signing
        const txXdr = tx.toXDR();

        // Sign via wallet connector
        const signedXdr = await wallet.signTransaction(
          txXdr,
          this.networkPassphrase
        );

        // Reconstruct signed transaction from XDR
        finalTx = TransactionBuilder.fromXDR(
          signedXdr,
          this.networkPassphrase
        );
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
   * Retrieves the status of a submitted transaction.
   * Automatically retries on failure.
   * @param hash - The transaction hash
   * @returns The transaction status response
   */
  async getTransaction(hash: string): Promise<unknown> {
    return retry(() => this.rpc.getTransaction(hash), this.retryConfig);
  }

  /**
   * Polls for a transaction to be confirmed or rejected.
   * @param hash - The transaction hash to wait for
   * @param params - Polling parameters
   * @param params.timeoutMs - Maximum time to wait in milliseconds (default: 30000)
   * @param params.intervalMs - Time between polls in milliseconds (default: 1000)
   * @returns The transaction result when it reaches a final state
   * @throws TimeoutError if the transaction times out
   */
  async pollTransaction(
    hash: string,
    params?: { timeoutMs?: number; intervalMs?: number }
  ): Promise<unknown> {
    const timeoutMs = params?.timeoutMs ?? 30_000;
    const intervalMs = params?.intervalMs ?? 1_000;
    const deadline = Date.now() + timeoutMs;

    while (Date.now() < deadline) {
      const res = await this.getTransaction(hash);
      const status = (res as any)?.status;
      if (status && status !== "NOT_FOUND") {
        return res;
      }
      await new Promise((r) => setTimeout(r, intervalMs));
    }

    throw new TimeoutError(`Timed out waiting for transaction ${hash} after ${timeoutMs}ms`);
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
   * Gets the default network passphrase for a given network.
   * @param network - The network ("testnet" or "mainnet")
   * @returns The corresponding network passphrase
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
}
