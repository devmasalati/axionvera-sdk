import { Keypair, TransactionBuilder } from '@stellar/stellar-sdk';
import { WalletConnector } from './walletConnector';

/**
 * Mock wallet connector for automated tests (Playwright/Cypress/Jest).
 *
 * This connector signs transactions locally using a provided Keypair/secret,
 * without any UI prompts.
 */
export class MockWalletConnector implements WalletConnector {
  private readonly keypair: Keypair;

  /**
   * Creates a new MockWalletConnector.
   * @param keypairOrSecret - A Keypair instance or secret key (starts with 'S')
   */
  constructor(keypairOrSecret: Keypair | string) {
    this.keypair =
      typeof keypairOrSecret === 'string'
        ? Keypair.fromSecret(keypairOrSecret)
        : keypairOrSecret;
  }

  /** @inheritdoc */
  getPublicKey(): Promise<string> {
    return Promise.resolve(this.keypair.publicKey());
  }

  /** @inheritdoc */
  signTransaction(transactionXdr: string, networkPassphrase: string): Promise<string> {
    const tx = TransactionBuilder.fromXDR(transactionXdr, networkPassphrase);
    tx.sign(this.keypair);
    return Promise.resolve(tx.toXDR());
  }
}

