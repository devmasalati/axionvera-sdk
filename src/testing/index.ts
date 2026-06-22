/**
 * Deterministic mock network infrastructure for SDK testing.
 *
 * Import from `axionvera-sdk/testing` (or `src/testing`) in your test files.
 * No live RPC connections are made — everything runs in-process.
 *
 * @example
 * ```typescript
 * import { MockNetwork } from "axionvera-sdk/testing";
 *
 * const { client, scenario } = MockNetwork.create();
 *
 * scenario
 *   .withAccount({ publicKey: "GABC...", sequence: "100" })
 *   .withSimulationSuccess();
 *
 * const health = await client.getHealth();
 * ```
 */

export { MockNetwork } from "./MockNetwork";
export type { MockNetworkOptions } from "./MockNetwork";

export { MockRpcServer } from "./MockRpcServer";
export type {
  MockAccountEntry,
  MockHealthStatus,
  MockSimulationResult,
  MockTransactionEntry,
  MockEventEntry,
  MockRpcServerSnapshot,
} from "./MockRpcServer";

export { ScenarioBuilder } from "./ScenarioBuilder";
