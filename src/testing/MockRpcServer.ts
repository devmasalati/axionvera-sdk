import { Account, rpc } from "@stellar/stellar-sdk";

/** Minimal account info stored in the mock ledger. */
export interface MockAccountEntry {
  publicKey: string;
  sequence: string;
  /** Native XLM balance in stroops (optional, for metadata). */
  balanceStroops?: string;
}

/** What getHealth returns from the mock server. */
export interface MockHealthStatus {
  status: "healthy" | "unhealthy";
  latestLedger: number;
}

/** Configurable simulation result for a specific contract+method pair. */
export interface MockSimulationResult {
  /** The serialized result xdr (default: empty/success). */
  returnValueXdr?: string;
  /** Set to simulate a contract-level revert. */
  error?: string;
  minResourceFee?: string;
}

/** Transaction lifecycle state stored in the mock ledger. */
export interface MockTransactionEntry {
  hash: string;
  status: "PENDING" | "SUCCESS" | "FAILED" | "NOT_FOUND";
  /** Number of getTransaction polls before transitioning from PENDING to status. */
  pendingPollsRemaining: number;
  finalStatus: "SUCCESS" | "FAILED";
  ledger?: number;
  resultXdr?: string;
  error?: string;
}

export interface MockEventEntry {
  contractId: string;
  eventName: string;
  ledger: number;
  valueXdr?: string;
}

/** Network-level error to inject on the next call to a specific method. */
interface PendingError {
  method: string;
  error: Error;
}

/**
 * Deterministic, in-memory Soroban RPC server for testing.
 *
 * Drop this in wherever `rpc.Server` is expected — it implements the same
 * interface subset that `StellarClient` uses.
 */
export class MockRpcServer {
  private ledger = 1000;
  private protocolVersion = 20;
  private accounts = new Map<string, MockAccountEntry>();
  private transactions = new Map<string, MockTransactionEntry>();
  private simulationResults = new Map<string, MockSimulationResult>();
  private events: MockEventEntry[] = [];
  private pendingErrors: PendingError[] = [];
  private healthy = true;
  private pollCounts = new Map<string, number>();

  // ── Configuration helpers ──────────────────────────────────────────────────

  /** Seed an account in the mock ledger. */
  addAccount(entry: MockAccountEntry): this {
    this.accounts.set(entry.publicKey, { ...entry });
    return this;
  }

  /**
   * Register a pre-canned simulation result.
   * @param key A string key identifying the scenario (use any stable string, e.g. "deposit").
   */
  addSimulationResult(key: string, result: MockSimulationResult): this {
    this.simulationResults.set(key, { ...result });
    return this;
  }

  /**
   * Queue a transaction that will start as PENDING and then transition to
   * `finalStatus` after `pendingPolls` getTransaction polls.
   */
  addTransaction(entry: Omit<MockTransactionEntry, "pendingPollsRemaining"> & { pendingPolls?: number }): this {
    this.transactions.set(entry.hash, {
      ...entry,
      pendingPollsRemaining: entry.pendingPolls ?? 1,
      status: "PENDING",
    });
    return this;
  }

  addEvent(entry: MockEventEntry): this {
    this.events.push({ ...entry });
    return this;
  }

  /** Inject an error that will be thrown on the next call to `method`. */
  injectError(method: string, error: Error): this {
    this.pendingErrors.push({ method, error });
    return this;
  }

  setHealthy(healthy: boolean): this {
    this.healthy = healthy;
    return this;
  }

  setLedger(sequence: number): this {
    this.ledger = sequence;
    return this;
  }

  /** Reset all state back to clean defaults. */
  reset(): this {
    this.ledger = 1000;
    this.accounts.clear();
    this.transactions.clear();
    this.simulationResults.clear();
    this.events = [];
    this.pendingErrors = [];
    this.healthy = true;
    this.pollCounts.clear();
    return this;
  }

  // ── Snapshot / restore ─────────────────────────────────────────────────────

  snapshot(): MockRpcServerSnapshot {
    return {
      ledger: this.ledger,
      accounts: [...this.accounts.entries()],
      transactions: [...this.transactions.entries()],
      simulationResults: [...this.simulationResults.entries()],
      events: [...this.events],
      healthy: this.healthy,
    };
  }

  restore(snap: MockRpcServerSnapshot): this {
    this.ledger = snap.ledger;
    this.accounts = new Map(snap.accounts);
    this.transactions = new Map(snap.transactions);
    this.simulationResults = new Map(snap.simulationResults);
    this.events = [...snap.events];
    this.healthy = snap.healthy;
    this.pendingErrors = [];
    this.pollCounts.clear();
    return this;
  }

  // ── Private helpers ────────────────────────────────────────────────────────

  private checkError(method: string): void {
    const idx = this.pendingErrors.findIndex((e) => e.method === method);
    if (idx !== -1) {
      const [{ error }] = this.pendingErrors.splice(idx, 1);
      throw error;
    }
  }

  // ── rpc.Server interface ───────────────────────────────────────────────────

  async getHealth(): Promise<{ status: string; latestLedger?: number }> {
    this.checkError("getHealth");
    if (!this.healthy) throw new Error("RPC server is unhealthy");
    return { status: "healthy", latestLedger: this.ledger };
  }

  async getLatestLedger(): Promise<rpc.Api.GetLatestLedgerResponse> {
    this.checkError("getLatestLedger");
    return {
      id: String(this.ledger),
      protocolVersion: this.protocolVersion,
      sequence: this.ledger,
    };
  }

  async getAccount(publicKey: string): Promise<Account> {
    this.checkError("getAccount");
    const entry = this.accounts.get(publicKey);
    if (!entry) {
      throw Object.assign(new Error(`Account not found: ${publicKey}`), {
        code: 404,
        response: { data: { extras: { result_codes: { account: "not_found" } } } },
      });
    }
    return new Account(entry.publicKey, entry.sequence);
  }

  async simulateTransaction(
    _tx: unknown,
    _resourceConfig?: unknown
  ): Promise<rpc.Api.SimulateTransactionResponse> {
    this.checkError("simulateTransaction");

    // Use the first registered simulation result, or a generic success.
    const [firstResult] = this.simulationResults.values();
    const cfg: MockSimulationResult = firstResult ?? {};

    if (cfg.error) {
      return {
        error: cfg.error,
        events: [],
        latestLedger: this.ledger,
      } as unknown as rpc.Api.SimulateTransactionResponse;
    }

    return {
      minResourceFee: cfg.minResourceFee ?? "100",
      transactionData: new (require("@stellar/stellar-sdk").SorobanDataBuilder)().build().toXDR("base64"),
      events: [],
      results: [{ auth: [], xdr: cfg.returnValueXdr ?? "" }],
      latestLedger: this.ledger,
    } as unknown as rpc.Api.SimulateTransactionResponse;
  }

  async prepareTransaction(tx: unknown): Promise<unknown> {
    this.checkError("prepareTransaction");
    // Just echo the transaction back (tests control assembly separately).
    return tx;
  }

  async sendTransaction(
    _tx: unknown
  ): Promise<rpc.Api.SendTransactionResponse> {
    this.checkError("sendTransaction");

    // Auto-create a deterministic pending entry for the sent tx.
    const hash = `mock-hash-${this.ledger}-${this.transactions.size}`;
    if (!this.transactions.has(hash)) {
      this.transactions.set(hash, {
        hash,
        status: "PENDING",
        pendingPollsRemaining: 1,
        finalStatus: "SUCCESS",
        ledger: this.ledger + 1,
      });
    }

    return {
      hash,
      status: "PENDING",
      latestLedger: this.ledger,
      latestLedgerCloseTime: String(Math.floor(Date.now() / 1000)),
    } as rpc.Api.SendTransactionResponse;
  }

  async getTransaction(hash: string): Promise<rpc.Api.GetTransactionResponse> {
    this.checkError("getTransaction");

    const entry = this.transactions.get(hash);
    if (!entry) {
      return {
        status: rpc.Api.GetTransactionStatus.NOT_FOUND,
        latestLedger: this.ledger,
        latestLedgerCloseTime: String(Math.floor(Date.now() / 1000)),
        oldestLedger: this.ledger - 100,
        oldestLedgerCloseTime: String(Math.floor(Date.now() / 1000) - 600),
      } as rpc.Api.GetTransactionResponse;
    }

    // Transition PENDING → final after pendingPollsRemaining reaches 0.
    if (entry.status === "PENDING") {
      if (entry.pendingPollsRemaining > 0) {
        entry.pendingPollsRemaining--;
        return {
          status: rpc.Api.GetTransactionStatus.NOT_FOUND,
          latestLedger: this.ledger,
          latestLedgerCloseTime: String(Math.floor(Date.now() / 1000)),
          oldestLedger: this.ledger - 100,
          oldestLedgerCloseTime: String(Math.floor(Date.now() / 1000) - 600),
        } as rpc.Api.GetTransactionResponse;
      }
      entry.status = entry.finalStatus;
    }

    const baseResponse = {
      latestLedger: this.ledger,
      latestLedgerCloseTime: String(Math.floor(Date.now() / 1000)),
      oldestLedger: this.ledger - 100,
      oldestLedgerCloseTime: String(Math.floor(Date.now() / 1000) - 600),
      ledger: entry.ledger ?? this.ledger,
      createdAt: String(Math.floor(Date.now() / 1000)),
      applicationOrder: 1,
      feeBump: false,
    };

    if (entry.status === "SUCCESS") {
      return {
        ...baseResponse,
        status: rpc.Api.GetTransactionStatus.SUCCESS,
        envelopeXdr: "" as unknown as import("@stellar/stellar-sdk").xdr.TransactionEnvelope,
        resultXdr: "" as unknown as import("@stellar/stellar-sdk").xdr.TransactionResult,
        resultMetaXdr: "" as unknown as import("@stellar/stellar-sdk").xdr.TransactionMeta,
      } as rpc.Api.GetTransactionResponse;
    }

    return {
      ...baseResponse,
      status: rpc.Api.GetTransactionStatus.FAILED,
      envelopeXdr: "" as unknown as import("@stellar/stellar-sdk").xdr.TransactionEnvelope,
      resultXdr: "" as unknown as import("@stellar/stellar-sdk").xdr.TransactionResult,
      resultMetaXdr: "" as unknown as import("@stellar/stellar-sdk").xdr.TransactionMeta,
    } as rpc.Api.GetTransactionResponse;
  }

  async getEvents(request: rpc.Server.GetEventsRequest): Promise<rpc.Api.GetEventsResponse> {
    this.checkError("getEvents");

    const contractIds: string[] = (request as any).filters
      ?.flatMap((f: any) => f.contractIds ?? []) ?? [];

    const matching = this.events.filter(
      (e) => contractIds.length === 0 || contractIds.includes(e.contractId)
    );

    return {
      events: matching.map((e, i) => ({
        id: `${e.ledger}-${i}`,
        type: "contract",
        ledger: e.ledger,
        ledgerClosedAt: new Date().toISOString(),
        contractId: e.contractId,
        pagingToken: `${e.ledger}-${i}`,
        inSuccessfulContractCall: true,
        operationIndex: 0,
        transactionIndex: 0,
        txHash: `mock-event-tx-${i}`,
        topic: [],
        value: e.valueXdr ?? "",
      })),
      latestLedger: this.ledger,
    } as unknown as rpc.Api.GetEventsResponse;
  }
}

export interface MockRpcServerSnapshot {
  ledger: number;
  accounts: [string, MockAccountEntry][];
  transactions: [string, MockTransactionEntry][];
  simulationResults: [string, MockSimulationResult][];
  events: MockEventEntry[];
  healthy: boolean;
}
