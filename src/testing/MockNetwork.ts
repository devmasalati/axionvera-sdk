import { Networks } from "@stellar/stellar-sdk";
import { StellarClient, StellarClientOptions } from "../client/stellarClient";
import { MockRpcServer, MockRpcServerSnapshot } from "./MockRpcServer";
import { ScenarioBuilder } from "./ScenarioBuilder";

export interface MockNetworkOptions {
  /** Defaults to "testnet". */
  network?: StellarClientOptions["network"];
  /** Passed directly to StellarClient (minus rpcClient/rpcUrl). */
  clientOptions?: Omit<StellarClientOptions, "rpcClient" | "rpcUrl" | "network">;
}

/**
 * Top-level entry point for deterministic SDK testing without live RPCs.
 *
 * Creates a `StellarClient` whose underlying RPC server is replaced with an
 * in-process `MockRpcServer`, enabling fully offline, deterministic tests.
 *
 * @example
 * ```typescript
 * import { MockNetwork } from "axionvera-sdk/testing";
 *
 * const { client, scenario, server } = MockNetwork.create();
 *
 * // Configure a scenario
 * const { keypair } = scenario.withRandomAccount().keypair;
 * scenario.withSimulationSuccess();
 *
 * // Use the client just like in production
 * const account = await client.getAccount(keypair.publicKey());
 * const health = await client.getHealth();
 * ```
 */
export class MockNetwork {
  /** The wired-in StellarClient (ready to use). */
  readonly client: StellarClient;
  /** The underlying mock server for advanced state inspection. */
  readonly server: MockRpcServer;
  /** Fluent scenario builder backed by this instance's server. */
  readonly scenario: ScenarioBuilder;

  private constructor(client: StellarClient, server: MockRpcServer) {
    this.client = client;
    this.server = server;
    this.scenario = new ScenarioBuilder(server);
  }

  /**
   * Create a fully wired MockNetwork.
   *
   * The returned `client` is a real `StellarClient` instance with its `rpc`
   * property replaced by the `MockRpcServer` — every method that delegates to
   * `this.rpc` (getHealth, getAccount, simulateTransaction, sendTransaction,
   * getTransaction, getLatestLedger, getEvents …) will hit the mock.
   */
  static create(options: MockNetworkOptions = {}): MockNetwork {
    const network = options.network ?? "testnet";
    const networkPassphrase =
      network === "testnet"
        ? Networks.TESTNET
        : network === "mainnet"
          ? Networks.PUBLIC
          : Networks.FUTURENET;

    const server = new MockRpcServer();

    // Pass a dummy rpcUrl so the URL validation inside StellarClient passes.
    // The rpcClient override replaces the actual transport.
    const client = new StellarClient({
      ...options.clientOptions,
      network,
      rpcUrl: "https://mock.local",
      networkPassphrase,
      rpcClient: server as unknown as import("@stellar/stellar-sdk").rpc.Server,
      // Disable retries by default in tests for faster feedback.
      retryConfig: options.clientOptions?.retryConfig ?? { maxRetries: 0 },
    });

    return new MockNetwork(client, server);
  }

  // ── Convenience lifecycle helpers ──────────────────────────────────────────

  /** Reset all server state. Equivalent to `server.reset()`. */
  reset(): this {
    this.server.reset();
    return this;
  }

  /** Take a snapshot of the current server state. */
  snapshot(): MockRpcServerSnapshot {
    return this.server.snapshot();
  }

  /** Restore server state from a previously taken snapshot. */
  restore(snap: MockRpcServerSnapshot): this {
    this.server.restore(snap);
    return this;
  }
}
