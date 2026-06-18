"use strict";

// axionvera-cli network — show the resolved network configuration and, unless
// --no-ping is given, check RPC reachability.

const { resolveNetwork, parseArgs, printJson, sdk, fail } = require("./shared");

const HELP = `
axionvera-cli network — show the resolved network configuration

Usage:
  axionvera-cli network [options]

Options:
  --network, -n <name>   testnet | futurenet | mainnet (default: testnet)
  --rpc <url>            Override the Soroban RPC URL
  --horizon <url>        Override the Horizon URL
  --json                 Print configuration as JSON
  --no-ping              Skip the RPC health/ledger check
  --help, -h             Show this help message

Examples:
  axionvera-cli network
  axionvera-cli network --network mainnet --no-ping
`;

async function run(argv) {
  if (argv.includes("--help") || argv.includes("-h")) {
    console.log(HELP);
    return;
  }

  const { flags } = parseArgs(argv, {
    aliases: { "-n": "network" },
    booleans: ["json", "no-ping", "ping"],
  });

  const config = resolveNetwork(flags);
  const ping = flags["no-ping"] ? false : true;

  let health = null;
  let latestLedger = null;
  if (ping) {
    try {
      const server = new sdk.rpc.Server(config.rpcUrl, {
        allowHttp: config.rpcUrl.startsWith("http://"),
      });
      const healthRes = await server.getHealth();
      health = healthRes.status || "unknown";
      const ledger = await server.getLatestLedger();
      latestLedger = ledger.sequence;
    } catch (err) {
      health = `unreachable (${err.message})`;
    }
  }

  if (flags.json) {
    printJson({ ...config, rpcHealth: health, latestLedger });
    return;
  }

  console.log(`Network:           ${config.network}`);
  console.log(`Passphrase:        ${config.passphrase}`);
  console.log(`Soroban RPC URL:   ${config.rpcUrl}`);
  console.log(`Horizon URL:       ${config.horizonUrl}`);
  console.log(`Friendbot URL:     ${config.friendbotUrl || "(none — funded accounts only)"}`);
  if (ping) {
    console.log(`RPC health:        ${health}`);
    console.log(`Latest ledger:     ${latestLedger ?? "n/a"}`);
  }
}

module.exports = { run, HELP };
