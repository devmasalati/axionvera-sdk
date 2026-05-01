declare module '@axionvera/core' {
  export type StellarClientOptions = {
    network?: string;
    rpcUrl?: string;
    networkPassphrase?: string;
    allowHttp?: boolean;
    [key: string]: unknown;
  };

  export interface WalletConnector {
    getPublicKey(): Promise<string>;
    signTransaction(transactionXdr: string, networkPassphrase: string): Promise<string>;
  }

  export class StellarClient {
    constructor(options?: StellarClientOptions);
  }

  export class VaultContract {
    constructor(config: {
      client: StellarClient;
      contractId: string;
      wallet: WalletConnector;
    });
  }

  export class WalletNotInstalledError extends Error {}
}
