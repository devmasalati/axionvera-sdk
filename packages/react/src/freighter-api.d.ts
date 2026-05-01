declare module '@stellar/freighter-api' {
  export type FreighterErrorLike =
    | string
    | {
        message?: string;
      };

  export function isConnected(): Promise<{
    isConnected: boolean;
    error?: FreighterErrorLike;
  }>;

  export function isAllowed(): Promise<{
    isAllowed: boolean;
    error?: FreighterErrorLike;
  }>;

  export function setAllowed(): Promise<{
    isAllowed: boolean;
    error?: FreighterErrorLike;
  }>;

  export function requestAccess(): Promise<{
    address: string;
    error?: FreighterErrorLike;
  }>;

  export function getAddress(): Promise<{
    address: string;
    error?: FreighterErrorLike;
  }>;

  export function getPublicKey(): Promise<string>;

  export function signTransaction(
    transactionXdr: string,
    opts?: {
      network?: string;
      networkPassphrase?: string;
      address?: string;
    }
  ): Promise<
    | string
    | {
        signedTxXdr?: string;
        signedTransaction?: string;
        signerAddress?: string;
        error?: FreighterErrorLike;
      }
  >;

  export class WatchWalletChanges {
    constructor(timeout?: number);
    watch(
      callback: (result: {
        address: string;
        network: string;
        networkPassphrase: string;
      }) => void
    ): void;
    stop(): void;
  }
}
