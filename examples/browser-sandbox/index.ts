import { StellarClient } from 'axionvera-sdk';
import { MockWalletConnector } from 'axionvera-sdk';

// UI Elements
const connectBtn = document.getElementById('connectBtn') as HTMLButtonElement;
const sendBtn = document.getElementById('sendBtn') as HTMLButtonElement;
const logsDiv = document.getElementById('logs') as HTMLDivElement;
const statusDiv = document.getElementById('status') as HTMLDivElement;

// Logger utility
function log(message: string, type: 'info' | 'success' | 'error' = 'info') {
  const entry = document.createElement('div');
  entry.className = `log-entry log-${type}`;
  const timestamp = new Date().toLocaleTimeString();
  entry.textContent = `[${timestamp}] ${message}`;
  logsDiv.appendChild(entry);
  logsDiv.scrollTop = logsDiv.scrollHeight;
}

// Initialize SDK
let client: StellarClient | null = null;
let wallet: MockWalletConnector | null = null;

async function initializeSDK() {
  try {
    log('Initializing Axionvera SDK...', 'info');
    
    // Create mock wallet connector
    wallet = new MockWalletConnector();
    const publicKey = await wallet.getPublicKey();
    log(`Mock wallet created with public key: ${publicKey}`, 'success');
    
    // Initialize StellarClient with testnet
    client = new StellarClient({
      network: 'testnet',
      wallet: wallet
    });
    
    log('Success: SDK Initialized in Browser', 'success');
    log('Ready to connect wallet and send transactions', 'info');
    
    statusDiv.className = 'status disconnected';
    statusDiv.textContent = 'Wallet: Disconnected';
  } catch (error) {
    log(`Failed to initialize SDK: ${error}`, 'error');
  }
}

// Connect wallet
async function connectWallet() {
  if (!client || !wallet) {
    log('SDK not initialized', 'error');
    return;
  }

  try {
    log('Connecting wallet...', 'info');
    const publicKey = await wallet.getPublicKey();
    log(`Connected to wallet: ${publicKey}`, 'success');
    
    connectBtn.disabled = true;
    connectBtn.textContent = 'Connected';
    sendBtn.disabled = false;
    
    statusDiv.className = 'status connected';
    statusDiv.textContent = `Wallet: ${publicKey.slice(0, 8)}...${publicKey.slice(-8)}`;
  } catch (error) {
    log(`Failed to connect wallet: ${error}`, 'error');
  }
}

// Send transaction
async function sendTransaction() {
  if (!client || !wallet) {
    log('SDK not initialized', 'error');
    return;
  }

  try {
    log('Building transaction...', 'info');
    
    // Note: This is a mock transaction that will fail during simulation
    // since we're using a mock wallet. The purpose is to demonstrate the SDK flow.
    const publicKey = await wallet.getPublicKey();
    log(`Transaction would be built for: ${publicKey}`, 'info');
    log('Note: Using MockWalletConnector - transaction will not be signed or submitted', 'info');
    log('This sandbox demonstrates the SDK initialization and UI flow', 'success');
  } catch (error) {
    log(`Failed to send transaction: ${error}`, 'error');
  }
}

// Event listeners
connectBtn.addEventListener('click', connectWallet);
sendBtn.addEventListener('click', sendTransaction);

// Initialize on load
initializeSDK();
