#!/usr/bin/env node
// axionvera-cli — command-line utility for interacting with Axionvera
// contracts and Stellar/Soroban networks.
//
// Commands:
//   network   Show the resolved network configuration and RPC health
//   balance   Query classic or Soroban token balances for an account
//   invoke    Simulate or submit a contract method call
//   codegen   Generate a TypeScript contract client from a WASM spec
//
// Run `axionvera-cli <command> --help` for command-specific options.

"use strict";

const pkg = require("../package.json");

const COMMANDS = {
  network: () => require("./commands/network"),
  balance: () => require("./commands/balance"),
  invoke: () => require("./commands/invoke"),
  codegen: () => require("./commands/codegen"),
};

function printHelp() {
  console.log(`
axionvera-cli — interact with Axionvera contracts and Stellar/Soroban networks

Usage:
  axionvera-cli <command> [options]

Commands:
  network   Show the resolved network configuration and RPC health
  balance   Query classic or Soroban token balances for an account
  invoke    Simulate or submit a contract method call
  codegen   Generate a TypeScript contract client from a WASM spec

Global:
  --help, -h       Show this help message
  --version, -v    Show the CLI version

Network selection (supported by network/balance/invoke):
  --network, -n <name>   testnet | futurenet | mainnet (default: testnet)
  --rpc <url>            Override the Soroban RPC URL
  --horizon <url>        Override the Horizon URL

Environment variables:
  AXIONVERA_NETWORK, AXIONVERA_RPC_URL, AXIONVERA_HORIZON_URL,
  AXIONVERA_NETWORK_PASSPHRASE

Run "axionvera-cli <command> --help" for command-specific options.
`);
}

async function main() {
  const argv = process.argv.slice(2);

  if (argv.length === 0 || argv[0] === "--help" || argv[0] === "-h") {
    printHelp();
    process.exit(0);
  }

  if (argv[0] === "--version" || argv[0] === "-v") {
    console.log(pkg.version);
    process.exit(0);
  }

  const command = argv[0];
  const loader = COMMANDS[command];

  if (!loader) {
    console.error(`Unknown command: ${command}. Run with --help for usage.`);
    process.exit(1);
  }

  try {
    await loader().run(argv.slice(1));
  } catch (err) {
    console.error(`Error: ${err && err.message ? err.message : err}`);
    process.exit(1);
  }
}

main();
