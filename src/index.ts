// Errors
export {
    AxionveraError,
    NetworkError,
    AuthenticationError,
    RateLimitError,
    ValidationError,
    TransactionError,
    RpcError,
    ContractError,
    TimeoutError,
    TransactionTimeoutError,
    InsufficientFundsError,
    InvalidSignatureError,
    InvalidXDRError,
    SimulationError,
    WalletNotInstalledError,
    FaucetRateLimitError,
    InsecureNetworkError,
    NetworkMismatchError,
    AxionveraRPCError,
    SimulationFailedError,
    SlippageToleranceExceededError,
    WalletConnectionError,
    toAxionveraError,
    normalizeRpcError,
    normalizeTransactionError,
    normalizeContractError,
    normalizeSimulationError
} from './errors/axionveraError';

// Client
export { StellarClient, HYDRATION_STATE_VERSION } from './client/stellarClient';
export { FaucetClient } from './client/faucetClient';
export type { StellarClientOptions, GetContractEventsOptions, GetContractEventsResult, ContractEventResult } from './client/stellarClient';
export type { StellarClientOptions } from './client/stellarClient';
export type { LogLevel, CustomLogger } from './utils/logger';
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

// Contracts
// export { VaultContract } from './contracts/VaultContract';
export { Vault } from './contracts/vault';
export { VaultABI } from './contracts/abis/VaultABI';
export type { VaultConfig, DepositParams, WithdrawParams, VaultInfo } from './contracts/vault';

// Wallet
export { LocalKeypairWalletConnector } from './wallet/walletConnector';
export { LocalKeypairWalletConnector, MockWalletConnector } from './wallet/walletConnector';
export { BrowserWalletConnector } from './wallet/browserWalletConnector';
export { MockWalletConnector } from './wallet/mockWalletConnector';
export type { WalletConnector } from './wallet/walletConnector';

// Utils
export { ConcurrencyQueue, createConcurrencyControlledClient } from './utils/concurrencyQueue';
export { retry, createHttpClientWithRetry } from './utils/httpInterceptor';
export { buildContractCallOperation, buildContractCallTransaction, buildBaseTransaction, toScVal, ContractCallBuilder } from './utils/transactionBuilder';
export type { BuildBaseTransactionParams, BuildContractCallParams, ContractCallArg } from './utils/transactionBuilder';
export { buildContractCallOperation, buildContractCallTransaction, buildBaseTransaction, bumpTransactionFee, toScVal } from './utils/transactionBuilder';
export type { BuildBaseTransactionParams, BumpTransactionFeeOptions } from './utils/transactionBuilder';
export { getDefaultRpcUrl, getNetworkPassphrase, resolveNetworkConfig } from './utils/networkConfig';
export { generateTransactionURI, generatePayURI } from './utils/sep7';
export { getRequiredSigners } from './utils/getRequiredSigners';
export { verifyWebhookSignature } from './utils/webhooks';
export { parseEvents, decodeSorobanSymbol } from './utils/soroban';
export type { ParsedEvent, ParseEventsOptions, DecodedTopic } from './utils/soroban';
export { isValidXDR, assertValidXDR, MAX_XDR_STRING_LENGTH } from './utils/xdrValidator';

// Testing & MSW
// export * from './test/msw/setup';
// export * from './test/msw/handlers';
// export { server } from './test/msw/server';
export * from './test/msw/setup';
export * from './test/msw/handlers';
export { server } from './test/msw/server';
