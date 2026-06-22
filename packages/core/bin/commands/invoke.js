"use strict";

// axionvera-cli invoke — execute a contract method.
//
// With no --source the call is simulated read-only and the decoded return value
// is printed. With --source <secret> the call is assembled, signed, submitted,
// and polled to completion.

const {
  resolveNetwork,
  parseArgs,
  parseScVal,
  printJson,
  sdk,
  fail,
} = require("./shared");

const HELP = `
axionvera-cli invoke — execute a contract method

Usage:
  axionvera-cli invoke <contractId> <method> [--arg <value> ...] [options]

Arguments:
  <contractId>           Soroban contract id (C...)
  <method>               Contract method name to call

Options:
  --arg <value>          A method argument. Repeatable; order is preserved.
                         Use "type:value" to force a type, e.g.
                         address:G..., i128:1000, symbol:transfer, bool:true.
                         Without a prefix the type is inferred.
  --source <secret>      Sign and submit with this secret key (S...). Omit for a
                         read-only simulation.
  --as <publicKey>       Source account to simulate as (read-only); defaults to a
                         throwaway account when omitted.
  --fee <stroops>        Base fee in stroops (default: 100)
  --network, -n <name>   testnet | futurenet | mainnet (default: testnet)
  --rpc <url>            Override the Soroban RPC URL
  --yes, -y              Skip the mainnet write confirmation
  --json                 Print result as JSON
  --help, -h             Show this help message

Examples:
  # Read-only call
  axionvera-cli invoke CBIE...TOKEN balance --arg address:GD5J...KUZ2V

  # Signed write
  axionvera-cli invoke CBIE...TOKEN transfer \\
    --arg address:GFROM... --arg address:GTO... --arg i128:1000 \\
    --source SB... --network testnet
`;

async function run(argv) {
  if (argv.length === 0 || argv.includes("--help") || argv.includes("-h")) {
    console.log(HELP);
    return;
  }

  const { flags, positionals } = parseArgs(argv, {
    aliases: { "-n": "network", "-y": "yes" },
    booleans: ["yes", "json"],
    arrays: ["arg"],
  });

  const [contractId, method] = positionals;
  if (!contractId) fail("A <contractId> is required.");
  if (!sdk.StrKey.isValidContract(contractId)) {
    fail(`"${contractId}" is not a valid contract id (expected C...).`);
  }
  if (!method) fail("A <method> name is required.");

  const config = resolveNetwork(flags);
  const server = new sdk.rpc.Server(config.rpcUrl, {
    allowHttp: config.rpcUrl.startsWith("http://"),
  });

  let scArgs;
  try {
    scArgs = (flags.arg || []).map(parseScVal);
  } catch (err) {
    fail(`Could not parse arguments: ${err.message}`);
  }

  const contract = new sdk.Contract(contractId);
  const op = contract.call(method, ...scArgs);

  const writing = Boolean(flags.source);
  let keypair = null;
  let sourceAccount;

  if (writing) {
    try {
      keypair = sdk.Keypair.fromSecret(flags.source);
    } catch (_) {
      fail("Invalid --source secret key (expected S...).");
    }
    sourceAccount = await loadAccount(server, keypair.publicKey(), config.network);
  } else if (flags.as) {
    if (!sdk.StrKey.isValidEd25519PublicKey(flags.as)) {
      fail(`"${flags.as}" is not a valid account public key (expected G...).`);
    }
    sourceAccount = await loadAccount(server, flags.as, config.network);
  } else {
    sourceAccount = new sdk.Account(sdk.Keypair.random().publicKey(), "0");
  }

  const tx = new sdk.TransactionBuilder(sourceAccount, {
    fee: flags.fee || sdk.BASE_FEE,
    networkPassphrase: config.passphrase,
  })
    .addOperation(op)
    .setTimeout(30)
    .build();

  let sim;
  try {
    sim = await server.simulateTransaction(tx);
  } catch (err) {
    fail(`Simulation request failed: ${err.message}`);
  }
  if (sdk.rpc.Api.isSimulationError(sim)) {
    fail(`Simulation failed: ${sim.error}`);
  }

  const retval = sim.result && sim.result.retval;
  const decoded = retval ? sdk.scValToNative(retval) : null;

  if (!writing) {
    if (flags.json) {
      printJson({ contract: contractId, method, result: decoded, simulated: true });
    } else {
      console.log(`Simulated ${method} on ${contractId} (${config.network})`);
      console.log(`Result: ${formatResult(decoded)}`);
    }
    return;
  }

  if (config.network === "mainnet" && !flags.yes) {
    fail("Refusing to submit a mainnet transaction without --yes.");
  }

  const prepared = sdk.rpc.assembleTransaction(tx, sim).build();
  prepared.sign(keypair);

  let sent;
  try {
    sent = await server.sendTransaction(prepared);
  } catch (err) {
    fail(`Submission failed: ${err.message}`);
  }
  if (sent.status === "ERROR") {
    fail(`Submission rejected: ${JSON.stringify(sent.errorResult || sent)}`);
  }

  const final = await poll(server, sent.hash);

  if (flags.json) {
    printJson({
      contract: contractId,
      method,
      hash: sent.hash,
      status: final.status,
      result: final.returnValue ? sdk.scValToNative(final.returnValue) : decoded,
    });
    return;
  }

  console.log(`Submitted ${method} on ${contractId} (${config.network})`);
  console.log(`Hash:   ${sent.hash}`);
  console.log(`Status: ${final.status}`);
  const resultValue = final.returnValue ? sdk.scValToNative(final.returnValue) : decoded;
  console.log(`Result: ${formatResult(resultValue)}`);
}

async function loadAccount(server, publicKey, network) {
  try {
    return await server.getAccount(publicKey);
  } catch (err) {
    fail(`Could not load account ${publicKey} on ${network}: ${err.message}`);
  }
}

async function poll(server, hash, attempts = 30, intervalMs = 1000) {
  for (let i = 0; i < attempts; i++) {
    const res = await server.getTransaction(hash);
    if (res.status !== "NOT_FOUND") return res;
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  fail(`Timed out waiting for transaction ${hash}.`);
}

function formatResult(value) {
  if (value === null || value === undefined) return "(void)";
  if (typeof value === "bigint") return value.toString();
  if (typeof value === "object") return JSON.stringify(value, (_k, v) => (typeof v === "bigint" ? v.toString() : v));
  return String(value);
}

module.exports = { run, HELP };
