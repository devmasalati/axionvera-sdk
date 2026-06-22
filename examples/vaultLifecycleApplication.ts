import { StellarClient, VaultContract } from "../src";

/**
 * Vault Lifecycle End-to-End Application Example
 * Demonstrates a standard workflow: checking balances, initiating a deposit,
 * tracking execution, and verifying updated contract status.
 */
async function runApplicationPipeline(): Promise<void> {
  console.log("🚀 Starting Axionvera Vault Lifecycle Application Client...\n");

  const contractId = process.env.AXIONVERA_VAULT_CONTRACT_ID;
  const account = process.env.STELLAR_PUBLIC_KEY;
  const secretKey = process.env.STELLAR_SECRET_KEY;

  if (!contractId || !account) {
    throw new Error(
      "❌ Configuration Missing: Please ensure AXIONVERA_VAULT_CONTRACT_ID and STELLAR_PUBLIC_KEY are specified in your environment."
    );
  }

  const network = (process.env.STELLAR_NETWORK as "testnet" | "mainnet" | undefined) ?? "testnet";
  const rpcUrl = process.env.STELLAR_RPC_URL;

  console.log(`🔌 Connecting client interfaces to Stellar [${network.toUpperCase()}]...`);
  const client = new StellarClient({ network, rpcUrl });
  const vault = new VaultContract({ client, contractId });
  console.log("✅ API Connections established.\n");

  console.log(`📊 Querying initial state metrics for account: ${account}`);
  const initialBalance = await vault.getBalance({ account });
  console.log(`   └─ Initial Staked Vault Balance: ${initialBalance.toString()} shares\n`);

  if (secretKey) {
    const depositAmount = 500n;
    console.log(`💳 Initiating automated asset deposit pipeline for: ${depositAmount.toString()} base units...`);

    try {
      const transactionReceipt = await vault.deposit({ 
        amount: depositAmount,
        signer: secretKey
      });

      console.log("✨ Core transaction broadcast successfully!");
      console.log(`   └─ Tx Hash: ${transactionReceipt.hash || "Confirmed on-chain"}`);

      console.log("\n🔄 Syncing ledger states to verify contract allocation changes...");
      const updatedBalance = await vault.getBalance({ account });
      console.log(`📊 Updated Staked Vault Balance: ${updatedBalance.toString()} shares`);
      
      const balanceDelta = updatedBalance - initialBalance;
      console.log(`📈 Net Delta: +${balanceDelta.toString()} shares securely recorded.\n`);

    } catch (txError) {
      console.error("⚠️ Transaction pipeline execution halted:", txError);
    }
  } else {
    console.log("ℹ️ Skipping deposit lifecycle simulation: Provide 'STELLAR_SECRET_KEY' to run live state-mutating actions.");
  }

  console.log("🏁 Vault Lifecycle Pipeline Execution finalized successfully.");
}

runApplicationPipeline().catch((error) => {
  console.error("🚨 Critical Client Pipeline Failure:", error);
  process.exit(1);
});
