# `@axionvera/react`

React bindings for Axionvera's Stellar SDK.

## Installation

```bash
npm install @axionvera/react @axionvera/core react
```

If you want the built-in Freighter wallet support, also install:

```bash
npm install @stellar/freighter-api
```

## Usage

Wrap your app with `AxionveraProvider`, then use the hooks anywhere below it.

```tsx
import { AxionveraProvider } from '@axionvera/react';

export function AppRoot() {
  return (
    <AxionveraProvider
      clientOptions={{ network: 'testnet' }}
      vaultContractId="C...YOUR_VAULT_ID"
    >
      <App />
    </AxionveraProvider>
  );
}
```

```tsx
import {
  useStellarClient,
  useVaultContract,
  useWallet
} from '@axionvera/react';

export function Dashboard() {
  const client = useStellarClient();
  const vault = useVaultContract();
  const wallet = useWallet();

  const connect = async () => {
    await wallet.connect();
    const health = await client.getHealth();
    const balance = await vault.getBalance();

    console.log({ health, balance });
  };

  return (
    <button onClick={() => void connect()}>
      {wallet.isConnected ? wallet.publicKey : 'Connect Freighter'}
    </button>
  );
}
---

## 💻 Usage Examples

We provide detailed, runnable examples in the [`examples/`](./examples/) directory to help you understand specific workflows:

- 💰 **Deposit**: [depositExample.ts](./examples/depositExample.ts)
- 🏦 **Withdraw**: [withdrawExample.ts](./examples/withdrawExample.ts)
- ⚖️ **Check Balance**: [balanceExample.ts](./examples/balanceExample.ts)
- 🔄 **HTTP Retry Logic**: [retryExample.ts](./examples/retryExample.ts)

---

## 📚 API Reference

For deep architectural details, see the [SDK Overview](./docs/sdk-overview.md) and [Usage Guide](./docs/usage-guide.md). Below is a summary of the core API classes:

### `StellarClient`
The core client wrapping the Soroban RPC connection.
- `getHealth()`: Check the health of the RPC node.
- `simulateTransaction(tx)`: Simulates a transaction to calculate fees and resource footprints.
- `prepareTransaction(tx)`: Attaches the simulation footprints and minimum fees to the transaction.
- `sendTransaction(tx)`: Submits a signed transaction to the network.
- `pollTransaction(hash, params)`: Polls the network until a transaction reaches a final state (`SUCCESS` or `FAILED`).
- `logLevel`: Property in `StellarClientOptions` to control SDK output visibility.

### `VaultContract`
A high-level abstraction for the Axionvera Vault smart contract.
- `deposit({ amount, from })`: Deposits tokens into the vault.
- `withdraw({ amount, from })`: Withdraws tokens from the vault.
- `getBalance({ account })`: Retrieves the vault balance for a specific account.
- `getVaultShares({ account })`: Queries the user's balance of the Vault's share token (read-only).
- `getExchangeRate()`: Queries the current conversion rate between 1 Share and the underlying asset (read-only).
- `claimRewards({ from })`: Claims pending rewards for the caller.

### `FaucetClient`
Automated funding for Testnet and Futurenet.
- `fundAccount(publicKey)`: Hits the correct Friendbot endpoint based on the client's network. Throws `FaucetRateLimitError` if throttled.

### `SEP-0007 Utilities`
Standardized URI generation for mobile wallet integration.
- `generateTransactionURI(xdr, callbackUrl)`: Generates a `web+stellar:tx` URI.
- `generatePayURI(destination, amount, assetCode, assetIssuer)`: Generates a `web+stellar:pay` URI.

### `WalletConnector` (Interface)
Implement this interface to integrate browser extension wallets (like Freighter) or use the provided `LocalKeypairWalletConnector` for backend/scripting services.
- `getPublicKey()`: Returns the public key of the connected wallet.
- `signTransaction(xdr, passphrase)`: Signs a prepared transaction XDR string and returns the signed XDR.

---

## 🛠 Troubleshooting

If you encounter issues while using the SDK, check the following common problems:

- **Error: `Simulation failed`**
  This usually means the contract call reverted during simulation. Ensure your account has sufficient XLM for fees, the contract ID is correct, you are passing the correct arguments, and the contract logic allows the operation.
- **Error: `Timed out waiting for transaction`**
  The transaction was submitted but not confirmed within the polling window. You may need to increase the `timeoutMs` parameter in `pollTransaction` or check if the network is heavily congested.
- **Rate Limiting (HTTP 429)**
  The SDK automatically retries on `429 Too Many Requests` using exponential backoff. If you consistently hit rate limits, consider configuring a private RPC provider URL instead of using the default public endpoints during `StellarClient` initialization.

---

## 🤝 Contributing

We welcome and appreciate contributions from the community! Whether it's reporting a bug, suggesting a feature, or submitting a pull request, your input helps make this project better.

Please read our [Contributing Guidelines](./CONTRIBUTING.md) for details on our code of conduct and the process for submitting pull requests.

### Development Setup
To set up the project locally for development:
```bash
git clone https://github.com/axionvera/axionvera-sdk.git
cd axionvera-sdk
npm install
npm run build
npm test
```

## API

- `AxionveraProvider`: Creates a shared `StellarClient`, exposes wallet state, and optionally configures a default vault contract ID.
- `useStellarClient()`: Returns the provider's shared `StellarClient`.
- `useVaultContract(contractId?)`: Returns a `VaultContract` bound to the provider client and wallet connector.
- `useWallet()`: Returns Freighter-aware wallet state plus `connect()` and `refresh()` helpers.

## Freighter behavior

`useWallet()` automatically:

- detects whether Freighter is available
- restores an allowed account when possible
- watches for account changes via Freighter's wallet watcher
- refreshes wallet state when the window regains focus
