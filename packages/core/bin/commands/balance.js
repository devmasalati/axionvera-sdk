"use strict";

// axionvera-cli balance — query account balances.
//
// Without --contract it loads classic balances (XLM + trustlines) from Horizon.
// With --contract <tokenId> it queries a Soroban token contract's `balance`
// method for the account via a read-only simulation.

const {
  resolveNetwork,
  parseArgs,
  isStellarAddress,
  printJson,
  sdk,
  fail,
} = require("./shared");

const HELP = `
axionvera-cli balance — query account balances

Usage:
  axionvera-cli balance <account> [options]

Arguments:
  <account>              Stellar account public key (G...)

Options:
  --contract <id>        Query a Soroban token contract balance (C...) instead
                         of classic Horizon balances
  --network, -n <name>   testnet | futurenet | mainnet (default: testnet)
  --rpc <url>            Override the Soroban RPC URL
  --horizon <url>        Override the Horizon URL
  --json                 Print result as JSON
  --help, -h             Show this help message

Examples:
  axionvera-cli balance GD5J...KUZ2V
  axionvera-cli balance GD5J...KUZ2V --network mainnet
  axionvera-cli balance GD5J...KUZ2V --contract CBIE...TOKEN
`;

async function run(argv) {
  if (argv.length === 0 || argv.includes("--help") || argv.includes("-h")) {
    console.log(HELP);
    return;
  }

  const { flags, positionals } = parseArgs(argv, {
    aliases: { "-n": "network" },
    booleans: ["json"],
  });

  const account = positionals[0];
  if (!account) fail("An <account> public key is required.");
  if (!sdk.StrKey.isValidEd25519PublicKey(account)) {
    fail(`"${account}" is not a valid Stellar account public key (expected G...).`);
  }

  const config = resolveNetwork(flags);

  if (flags.contract) {
    await contractBalance(account, flags.contract, config, flags.json);
  } else {
    await classicBalance(account, config, flags.json);
  }
}

async function classicBalance(account, config, json) {
  const server = new sdk.Horizon.Server(config.horizonUrl, {
    allowHttp: config.horizonUrl.startsWith("http://"),
  });

  let loaded;
  try {
    loaded = await server.loadAccount(account);
  } catch (err) {
    if (err && err.response && err.response.status === 404) {
      fail(`Account not found on ${config.network}: ${account}`);
    }
    fail(`Failed to load account: ${err.message}`);
  }

  const balances = loaded.balances.map((b) => ({
    asset:
      b.asset_type === "native"
        ? "XLM"
        : `${b.asset_code}:${b.asset_issuer}`,
    balance: b.balance,
  }));

  if (json) {
    printJson({ account, network: config.network, balances });
    return;
  }

  console.log(`Account: ${account} (${config.network})`);
  for (const b of balances) {
    console.log(`  ${b.balance.padStart(20)}  ${b.asset}`);
  }
}

async function contractBalance(account, contractId, config, json) {
  if (!sdk.StrKey.isValidContract(contractId)) {
    fail(`"${contractId}" is not a valid contract id (expected C...).`);
  }

  const server = new sdk.rpc.Server(config.rpcUrl, {
    allowHttp: config.rpcUrl.startsWith("http://"),
  });

  const contract = new sdk.Contract(contractId);
  const op = contract.call("balance", new sdk.Address(account).toScVal());

  // Read-only: a throwaway source with sequence 0 is sufficient for simulation.
  const source = new sdk.Account(sdk.Keypair.random().publicKey(), "0");
  const tx = new sdk.TransactionBuilder(source, {
    fee: sdk.BASE_FEE,
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
    fail(`Contract balance query failed: ${sim.error}`);
  }

  const retval = sim.result && sim.result.retval;
  const balance = retval ? sdk.scValToNative(retval) : null;

  if (json) {
    printJson({ account, contract: contractId, network: config.network, balance });
    return;
  }

  console.log(`Account:  ${account}`);
  console.log(`Contract: ${contractId} (${config.network})`);
  console.log(`Balance:  ${balance === null ? "n/a" : balance.toString()}`);
}

module.exports = { run, HELP };
