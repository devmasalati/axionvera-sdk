import { Keypair } from "@stellar/stellar-sdk";
import {
  MockRpcServer,
  MockAccountEntry,
  MockSimulationResult,
  MockTransactionEntry,
  MockEventEntry,
} from "./MockRpcServer";

/**
 * Fluent builder for assembling deterministic test scenarios on a MockRpcServer.
 *
 * @example
 * ```typescript
 * import { MockNetwork } from "axionvera-sdk/testing";
 *
 * const { client, scenario } = MockNetwork.create();
 *
 * scenario
 *   .withAccount({ publicKey: keypair.publicKey(), sequence: "100" })
 *   .withSimulationSuccess({ minResourceFee: "200" })
 *   .withPendingTransaction({ hash: "abc123", finalStatus: "SUCCESS" });
 * ```
 */
export class ScenarioBuilder {
  constructor(private readonly server: MockRpcServer) {}

  // ── Account helpers ────────────────────────────────────────────────────────

  /** Add an account with an explicit sequence number. */
  withAccount(entry: MockAccountEntry): this {
    this.server.addAccount(entry);
    return this;
  }

  /**
   * Generate and register a random funded account.
   * Returns the generated keypair so callers can sign transactions.
   */
  withRandomAccount(
    sequence = "100",
    balanceStroops = "10000000000"
  ): { scenario: this; keypair: Keypair } {
    const keypair = Keypair.random();
    this.server.addAccount({ publicKey: keypair.publicKey(), sequence, balanceStroops });
    return { scenario: this, keypair };
  }

  // ── Simulation helpers ─────────────────────────────────────────────────────

  /** Set the default simulation to return success with optional config. */
  withSimulationSuccess(cfg: Omit<MockSimulationResult, "error"> = {}): this {
    this.server.addSimulationResult("__default__", cfg);
    return this;
  }

  /** Set the default simulation to return a contract error. */
  withSimulationError(error: string): this {
    this.server.addSimulationResult("__default__", { error });
    return this;
  }

  /** Register a named simulation result reachable via `MockRpcServer.addSimulationResult`. */
  withNamedSimulation(key: string, result: MockSimulationResult): this {
    this.server.addSimulationResult(key, result);
    return this;
  }

  // ── Transaction helpers ────────────────────────────────────────────────────

  /**
   * Pre-seed a transaction that starts PENDING and transitions to SUCCESS
   * after `pendingPolls` getTransaction calls.
   */
  withSuccessfulTransaction(
    hash: string,
    options: { pendingPolls?: number; ledger?: number } = {}
  ): this {
    this.server.addTransaction({
      hash,
      finalStatus: "SUCCESS",
      pendingPolls: options.pendingPolls ?? 1,
      ledger: options.ledger,
    });
    return this;
  }

  /**
   * Pre-seed a transaction that will eventually FAIL.
   */
  withFailedTransaction(
    hash: string,
    options: { pendingPolls?: number; error?: string } = {}
  ): this {
    this.server.addTransaction({
      hash,
      finalStatus: "FAILED",
      pendingPolls: options.pendingPolls ?? 1,
      error: options.error,
    });
    return this;
  }

  /** Add an arbitrary transaction entry with full control. */
  withTransaction(entry: Omit<MockTransactionEntry, "pendingPollsRemaining"> & { pendingPolls?: number }): this {
    this.server.addTransaction(entry);
    return this;
  }

  // ── Event helpers ──────────────────────────────────────────────────────────

  withEvent(entry: MockEventEntry): this {
    this.server.addEvent(entry);
    return this;
  }

  // ── Network-level helpers ──────────────────────────────────────────────────

  /** Simulate the server being unhealthy. */
  withUnhealthyNetwork(): this {
    this.server.setHealthy(false);
    return this;
  }

  /** Inject an error that will be thrown on the next call to `method`. */
  withNetworkError(method: string, error: Error = new Error(`Mock ${method} error`)): this {
    this.server.injectError(method, error);
    return this;
  }

  withLedger(sequence: number): this {
    this.server.setLedger(sequence);
    return this;
  }

  /** Reset all server state and return a fresh ScenarioBuilder. */
  reset(): this {
    this.server.reset();
    return this;
  }
}
