"use strict";

// Shared helpers for the axionvera-cli subcommands: argument parsing, network
// resolution, ScVal coercion, and output formatting. Kept dependency-free apart
// from @stellar/stellar-sdk so the CLI runs without building the SDK source.

const sdk = require("@stellar/stellar-sdk");
const { Networks, StrKey, Address, nativeToScVal } = sdk;

// ─── Network configuration ──────────────────────────────────────────────────

const NETWORKS = {
  testnet: {
    passphrase: Networks.TESTNET,
    rpcUrl: "https://soroban-testnet.stellar.org",
    horizonUrl: "https://horizon-testnet.stellar.org",
    friendbotUrl: "https://friendbot.stellar.org",
  },
  futurenet: {
    passphrase: Networks.FUTURENET,
    rpcUrl: "https://rpc-futurenet.stellar.org",
    horizonUrl: "https://horizon-futurenet.stellar.org",
    friendbotUrl: "https://friendbot-futurenet.stellar.org",
  },
  mainnet: {
    passphrase: Networks.PUBLIC,
    rpcUrl: "https://mainnet.sorobanrpc.com",
    horizonUrl: "https://horizon.stellar.org",
    friendbotUrl: null,
  },
};

/**
 * Resolves the effective network configuration from flags and environment.
 * Precedence: explicit flag > environment variable > network default.
 * Recognised env vars: AXIONVERA_NETWORK, AXIONVERA_RPC_URL,
 * AXIONVERA_HORIZON_URL, AXIONVERA_NETWORK_PASSPHRASE.
 */
function resolveNetwork(opts = {}) {
  const name = (opts.network || process.env.AXIONVERA_NETWORK || "testnet").toLowerCase();
  const base = NETWORKS[name];
  if (!base) {
    fail(`Unknown network "${name}". Supported: ${Object.keys(NETWORKS).join(", ")}.`);
  }
  return {
    network: name,
    passphrase: opts.passphrase || process.env.AXIONVERA_NETWORK_PASSPHRASE || base.passphrase,
    rpcUrl: opts.rpc || process.env.AXIONVERA_RPC_URL || base.rpcUrl,
    horizonUrl: opts.horizon || process.env.AXIONVERA_HORIZON_URL || base.horizonUrl,
    friendbotUrl: base.friendbotUrl,
  };
}

// ─── Argument parsing ─────────────────────────────────────────────────────────

/**
 * Minimal flag parser. Supports "--flag value", "--flag=value", boolean flags,
 * short aliases (mapped by the caller), and repeated flags collected into arrays.
 * Anything not starting with "-" is collected as a positional.
 *
 * @param {string[]} argv     - Arguments after the subcommand name.
 * @param {object}   spec     - { aliases: {"-o":"out"}, booleans: ["yes"], arrays: ["arg"] }
 */
function parseArgs(argv, spec = {}) {
  const aliases = spec.aliases || {};
  const booleans = new Set(spec.booleans || []);
  const arrays = new Set(spec.arrays || []);
  const flags = {};
  const positionals = [];

  for (let i = 0; i < argv.length; i++) {
    let token = argv[i];
    if (token.startsWith("-")) {
      let value;
      const eq = token.indexOf("=");
      if (eq !== -1) {
        value = token.slice(eq + 1);
        token = token.slice(0, eq);
      }
      let key = aliases[token] || token.replace(/^--?/, "");
      if (booleans.has(key)) {
        flags[key] = true;
        continue;
      }
      if (value === undefined) {
        value = argv[++i];
        if (value === undefined) fail(`Missing value for option "${token}".`);
      }
      if (arrays.has(key)) {
        (flags[key] = flags[key] || []).push(value);
      } else {
        flags[key] = value;
      }
    } else {
      positionals.push(token);
    }
  }
  return { flags, positionals };
}

// ─── ScVal coercion ────────────────────────────────────────────────────────────

const TYPE_PREFIX = /^(address|account|contract|bool|u32|i32|u64|i64|u128|i128|u256|i256|symbol|string|bytes):([\s\S]*)$/;

/**
 * Converts a CLI argument string into an ScVal for a contract call.
 *
 * Accepts an explicit "type:value" prefix (e.g. "i128:1000", "address:G...",
 * "symbol:transfer", "bool:true"). Without a prefix the type is inferred:
 * Stellar addresses become Address values, plain integers become i128, "true"/
 * "false" become bool, and everything else becomes a string.
 */
function parseScVal(raw) {
  const match = TYPE_PREFIX.exec(raw);
  if (match) {
    return coerce(match[1], match[2]);
  }
  // Inference
  if (isStellarAddress(raw)) return new Address(raw).toScVal();
  if (/^-?\d+$/.test(raw)) return nativeToScVal(BigInt(raw), { type: "i128" });
  if (raw === "true" || raw === "false") return nativeToScVal(raw === "true");
  return nativeToScVal(raw, { type: "string" });
}

function coerce(type, value) {
  switch (type) {
    case "address":
    case "account":
    case "contract":
      return new Address(value).toScVal();
    case "bool":
      return nativeToScVal(value === "true");
    case "u32":
    case "i32":
      return nativeToScVal(Number(value), { type });
    case "u64":
    case "i64":
    case "u128":
    case "i128":
    case "u256":
    case "i256":
      return nativeToScVal(BigInt(value), { type });
    case "symbol":
      return nativeToScVal(value, { type: "symbol" });
    case "string":
      return nativeToScVal(value, { type: "string" });
    case "bytes":
      return nativeToScVal(Buffer.from(value, "hex"));
    default:
      fail(`Unsupported argument type "${type}".`);
  }
}

function isStellarAddress(value) {
  return StrKey.isValidEd25519PublicKey(value) || StrKey.isValidContract(value);
}

// ─── Output helpers ──────────────────────────────────────────────────────────

/** JSON.stringify replacer that renders BigInt as a string. */
function bigintReplacer(_key, value) {
  return typeof value === "bigint" ? value.toString() : value;
}

function printJson(value) {
  console.log(JSON.stringify(value, bigintReplacer, 2));
}

function fail(message) {
  console.error(`Error: ${message}`);
  process.exit(1);
}

module.exports = {
  NETWORKS,
  resolveNetwork,
  parseArgs,
  parseScVal,
  isStellarAddress,
  printJson,
  bigintReplacer,
  fail,
  sdk,
};
