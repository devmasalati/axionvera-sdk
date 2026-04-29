import {
  Account,
  FeeBumpTransaction,
  Keypair,
  Networks,
  rpc,
  SorobanDataBuilder,
  Transaction,
  TransactionBuilder
} from "@stellar/stellar-sdk";

import { AxionveraNetwork, resolveNetworkConfig } from "../utils/networkConfig";
import { ConcurrencyConfig, DEFAULT_CONCURRENCY_CONFIG, createConcurrencyControlledClient } from "../utils/concurrencyQueue";
import { RetryConfig, createHttpClientWithRetry, retry } from "../utils/httpInterceptor";
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
};

export type TransactionSendResult = {
  hash: string;
  status: string;
  raw: unknown;
};

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
    return TransactionBuilder.fromXDR(transactionXdr, networkPassphrase);
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
