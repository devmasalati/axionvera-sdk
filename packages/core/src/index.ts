// Client
export { StellarClient, HYDRATION_STATE_VERSION } from './client/stellarClient';
export { AxionveraClient } from './client/axionveraClient';
export { FaucetClient } from './client/faucetClient';
export type {
  StellarClientOptions,
  PendingTransaction,
  TrackedTransaction,
  SerializedPendingTransaction,
  ExportedState,
  TrackTransactionOptions,
  SimulationContext,
  SerializableValue,
} from './client/stellarClient';
export type { AxionveraClientConfig } from './client/axionveraClient';

// Contracts
export { BaseContract } from './contracts/BaseContract';
export type { BaseContractConfig, InvokeMethodOptions } from './contracts/BaseContract';
export type { BaseContractConfig } from './contracts/BaseContract';
export { VaultContract } from './contracts/VaultContract';
// Strict argument interfaces for Soroban vault methods (issue #95).
// These enforce compile-time typo detection (e.g. { amout } instead of { amount }).
export type {
  DepositArgs,
  WithdrawArgs,
  ClaimArgs,
  ClaimRewardsParams,
} from './contracts/VaultContract';
export { ContractEventEmitter } from './contracts/ContractEventEmitter';
export { Vault } from './contracts/Vault';
export { VaultABI } from './contracts/abis/VaultABI';
// Soroban-native VaultContract config and param shapes.
export type {
  VaultConfig,
  VaultInfo,
  DepositParams,
  WithdrawParams,
} from './contracts/VaultContract';
export type { ContractEvent, EventCallback } from './contracts/ContractEventEmitter';

// Wallet
export { LocalKeypairWalletConnector } from './wallet/localKeypairWalletConnector';
export { BrowserWalletConnector } from './wallet/browserWalletConnector';
export { LedgerWalletConnector } from './wallet/ledgerWalletConnector';
export { MockWalletConnector } from './wallet/mockWalletConnector';
export type { WalletConnector } from './wallet/walletConnector';

// Utils
export { ConcurrencyQueue, createConcurrencyControlledClient } from './utils/concurrencyQueue';
export { retry, createHttpClientWithRetry } from './utils/httpInterceptor';
export { buildContractCallOperation, buildContractCallTransaction, buildContractAuthPayload, bumpTransactionFee, toScVal } from './utils/transactionBuilder';
export type { BumpTransactionFeeOptions } from './utils/transactionBuilder';
export { getDefaultRpcUrl, getNetworkPassphrase, resolveNetworkConfig } from './utils/networkConfig';
export { generateTransactionURI, generatePayURI } from './utils/sep7';
export { decodeXdrBase64, clearXdrCache, getXdrCacheSize } from './utils/xdrCache';
export { parseEvents, decodeSorobanSymbol } from './utils/soroban';
export type { ParsedEvent, ParseEventsOptions, DecodedTopic } from './utils/soroban';
export {
  addAuthEntry,
  buildSorobanAddressAuthEntry,
  buildSorobanSourceAccountAuthEntry,
} from './utils/sorobanAuth';
export type { SorobanAuthEntry, BuildAddressAuthEntryParams, BuildSourceAuthEntryParams } from './utils/sorobanAuth';

// Errors
export {
  AxionveraError,
  NetworkError,
  AuthenticationError,
  RateLimitError,
  ValidationError,
  StellarRpcNetworkError,
  StellarRpcResponseError,
  StellarRpcTimeoutError,
  InsecureNetworkError,
  TransactionTimeoutError,
  WalletNotInstalledError,
  FaucetRateLimitError,
  InvalidSignatureError,
  RPCValidationMismatchError,
  DeviceLockedError,
  UserRejectedError,
  ContractRevertError,
  TransactionTimeoutError,
  toAxionveraError
} from './errors/axionveraError';
export type { RPCValidationMismatchErrorOptions } from './errors/axionveraError';

// RPC schema types
export type { ValidatedGetHealthResponse, ValidatedGetTransactionResponse } from './utils/rpcSchemas';

// Transaction Signing
export { TransactionSigner, EnhancedTransactionBuilder, TransactionSimulator } from './transaction';
export type {
  TransactionSignerConfig,
  ContractCallParams,
  TransactionBuildParams,
  TransactionResult,
  SimulationResult,
  FeeBumpParams,
  MultiStepTransactionParams,
  BatchTransactionParams,
  BatchTransactionResult,
  DetailedSimulationResult,
  ResourceOptimizationOptions
} from './transaction';

// Testing & MSW
export * from './test/msw/setup';
export * from './test/msw/handlers';
export { server } from './test/msw/server';

// Codegen utilities (for programmatic use)
export { parseWasm } from './codegen/wasmParser';
export { generateContractClass } from './codegen/generator';
export type { ContractSpec, SpecFunction, SpecParam, SpecStruct, SpecEnum } from './codegen/wasmParser';
