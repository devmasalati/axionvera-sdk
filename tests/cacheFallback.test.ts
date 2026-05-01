import { Account, Keypair, TransactionBuilder, Networks, rpc } from "@stellar/stellar-sdk";
import { StellarClient } from "../src/client/stellarClient";

// Mock the RPC Server at the module level
jest.mock("@stellar/stellar-sdk", () => {
  const originalModule = jest.requireActual("@stellar/stellar-sdk");
  return {
    ...originalModule,
    rpc: {
      ...originalModule.rpc,
      Server: jest.fn().mockImplementation(() => ({
        getAccount: jest.fn().mockImplementation((publicKey: string) => {
          // Return a mock that mimics Account interface
          return Promise.resolve({
            accountId: () => publicKey,
            sequenceNumber: () => BigInt("1234567890"),
            balance: () => "1000000000"
          });
        }),
        getHealth: jest.fn().mockResolvedValue({ status: "healthy" }),
        getNetwork: jest.fn().mockResolvedValue({ networkPassphrase: "Test SDF Network ; September 2015" }),
        simulateTransaction: jest.fn().mockResolvedValue({
          results: [{ cpuInstructions: 100000, memoryBytes: 1000 }],
          minResourceFee: 100000,
          error: undefined
        })
      }))
    }
  };
});

describe("Cache-First Transaction Building", () => {
  // Generate a valid test keypair
  const testKeypair = Keypair.random();
  const testPublicKey = testKeypair.publicKey();

  describe("getAccountWithCache", () => {
    let client: StellarClient;
    let mockGetAccount: any;

    beforeEach(() => {
      client = new StellarClient({ 
        network: "testnet",
        accountFetchTimeoutMs: 100, // Short timeout for testing
        cacheTtlMs: 5000
      });
      
      // Get the mock function from the RPC server
      mockGetAccount = (client.rpc as any).getAccount;
    });

    afterEach(() => {
      jest.restoreAllMocks();
    });

    it("should cache account sequence on successful fetch", async () => {
      const account = await client.getAccountWithCache(testPublicKey);
      expect(account.accountId()).toBe(testPublicKey);
      expect(account.sequenceNumber().toString()).toBe("1234567890");
      expect(mockGetAccount).toHaveBeenCalledWith(testPublicKey);
      
      // Verify cache was populated
      expect(client['accountSequenceCache'].has(testPublicKey)).toBe(true);
      const cached = client['accountSequenceCache'].get(testPublicKey);
      expect(cached?.sequence.toString()).toBe("1234567890");
    });

    it("should use cached sequence when network request fails", async () => {
      // First, populate the cache with a successful fetch
      await client.getAccountWithCache(testPublicKey);
      
      // Verify cache was populated
      expect(client['accountSequenceCache'].has(testPublicKey)).toBe(true);
      
      mockGetAccount.mockClear();

      // Now simulate network failure
      mockGetAccount.mockRejectedValueOnce(new Error("Network error"));

      // Should use cached sequence + 1
      const cachedAccount = await client.getAccountWithCache(testPublicKey);
      expect(cachedAccount.accountId()).toBe(testPublicKey);
      expect(cachedAccount.sequenceNumber().toString()).toBe("1234567891"); // Cached sequence + 1
      expect(mockGetAccount).toHaveBeenCalledWith(testPublicKey);
    });

    it("should use cached sequence when network request times out", async () => {
      // First, populate the cache
      await client.getAccountWithCache(testPublicKey);
      mockGetAccount.mockClear();

      // Simulate slow response that exceeds timeout
      mockGetAccount.mockImplementationOnce(() => 
        new Promise((_, reject) => 
          setTimeout(() => reject(new Error("Timeout")), 5000)
        )
      );

      // Should use cached sequence + 1 due to timeout
      const cachedAccount = await client.getAccountWithCache(testPublicKey);
      expect(cachedAccount.accountId()).toBe(testPublicKey);
      expect(cachedAccount.sequenceNumber().toString()).toBe("1234567891"); // Cached sequence + 1
    });

    it("should throw error when network fails and no cache exists", async () => {
      // Clear any existing cache
      client.clearCache();
      mockGetAccount.mockClear();

      // Simulate network failure
      mockGetAccount.mockRejectedValueOnce(new Error("Network error"));

      await expect(client.getAccountWithCache(testPublicKey)).rejects.toThrow(
        "Failed to fetch account and no valid cache available"
      );
    });

    it("should expire cache after TTL", async () => {
      // Wait for cache to expire (TTL is 5000ms, but we can't wait that long in tests)
      // Instead, create a new client with very short TTL
      const shortTtlClient = new StellarClient({ 
        network: "testnet",
        accountFetchTimeoutMs: 100,
        cacheTtlMs: 10 // 10ms TTL
      });

      const shortTtlSpy = jest.spyOn(shortTtlClient.rpc, 'getAccount').mockResolvedValue({
        accountId: () => testPublicKey,
        sequenceNumber: () => BigInt("1234567890"),
        balance: () => "1000000000"
      } as any);

      await shortTtlClient.getAccountWithCache(testPublicKey);
      
      // Wait for cache to expire
      await new Promise(resolve => setTimeout(resolve, 20));

      // Clear the mock to simulate network failure
      shortTtlSpy.mockRejectedValueOnce(new Error("Network error"));

      // Should throw error since cache expired
      await expect(shortTtlClient.getAccountWithCache(testPublicKey)).rejects.toThrow(
        "Failed to fetch account and no valid cache available"
      );
    });

    it("should clear cache for specific account", async () => {
      const publicKey2 = "GABCDJKLMNOPQRSTUVWXYZABCDEFGHIJKLMNOPQRSTUVWXYZABCDEFGHIJKLMN";
      
      // Populate cache for both accounts
      await client.getAccountWithCache(testPublicKey);
      await client.getAccountWithCache(publicKey2);
      mockGetAccount.mockClear();

      // Clear cache for first account only
      client.clearCache(testPublicKey);

      // Simulate network failure
      mockGetAccount.mockRejectedValueOnce(new Error("Network error"));

      // First account should fail (no cache)
      await expect(client.getAccountWithCache(testPublicKey)).rejects.toThrow();

      // Second account should still work (has cache)
      const cachedAccount = await client.getAccountWithCache(publicKey2);
      expect(cachedAccount.accountId()).toBe(publicKey2);
    });

    it("should clear all cache when no public key provided", async () => {
      const publicKey2 = "GABCDJKLMNOPQRSTUVWXYZABCDEFGHIJKLMNOPQRSTUVWXYZABCDEFGHIJKLMN";
      
      // Populate cache for both accounts
      await client.getAccountWithCache(testPublicKey);
      await client.getAccountWithCache(publicKey2);
      mockGetAccount.mockClear();

      // Clear all cache
      client.clearCache();

      // Simulate network failure
      mockGetAccount.mockRejectedValue(new Error("Network error"));

      // Both should fail (no cache)
      await expect(client.getAccountWithCache(testPublicKey)).rejects.toThrow();
      await expect(client.getAccountWithCache(publicKey2)).rejects.toThrow();
    });
  });

  describe("Transaction Building with Cache Fallback", () => {
    let client: StellarClient;
    let mockGetAccount: any;

    beforeEach(() => {
      client = new StellarClient({ 
        network: "testnet",
        accountFetchTimeoutMs: 100,
        cacheTtlMs: 5000
      });
      
      // Get the mock function from the RPC server
      mockGetAccount = (client.rpc as any).getAccount;
    });

    afterEach(() => {
      jest.restoreAllMocks();
    });

    it("should build transaction using cached sequence when network fails", async () => {
      // First, populate the cache
      await client.getAccountWithCache(testPublicKey);
      mockGetAccount.mockClear();

      // Simulate network failure
      mockGetAccount.mockRejectedValueOnce(new Error("Network error"));

      // Build transaction using cached account
      const account = await client.getAccountWithCache(testPublicKey);
      const tx = new TransactionBuilder(account, {
        fee: "100",
        networkPassphrase: client.networkPassphrase
      })
        .setTimeout(30)
        .build();

      expect(tx.source).toBe(testPublicKey);
      expect(account.sequenceNumber().toString()).toBe("1234567892"); // Cached sequence + 2 (first call incremented to 1234567891, second to 1234567892)
    });

    it("should be snappy - complete within timeout", async () => {
      // Populate cache
      await client.getAccountWithCache(testPublicKey);
      mockGetAccount.mockClear();

      // Simulate slow network
      mockGetAccount.mockImplementationOnce(() => 
        new Promise((_, reject) => 
          setTimeout(() => reject(new Error("Timeout")), 5000)
        )
      );

      const startTime = Date.now();
      const account = await client.getAccountWithCache(testPublicKey);
      const elapsed = Date.now() - startTime;

      // Should complete quickly using cache (well under the 5s network delay)
      expect(elapsed).toBeLessThan(200); // Should be much faster than 5s
      expect(account.sequenceNumber().toString()).toBe("1234567891");
    });

    it("should increment sequence multiple times when offline", async () => {
      // First, populate the cache with a successful fetch
      await client.getAccountWithCache(testPublicKey);
      mockGetAccount.mockClear();

      // Simulate network failure
      mockGetAccount.mockRejectedValue(new Error("Network error"));

      // First offline call should get cached sequence + 1
      const firstAccount = await client.getAccountWithCache(testPublicKey);
      expect(firstAccount.accountId()).toBe(testPublicKey);
      expect(firstAccount.sequenceNumber().toString()).toBe("1234567891"); // Cached (1234567890) + 1

      // Second offline call should get cached sequence + 2 (cache was updated)
      const secondAccount = await client.getAccountWithCache(testPublicKey);
      expect(secondAccount.accountId()).toBe(testPublicKey);
      expect(secondAccount.sequenceNumber().toString()).toBe("1234567892"); // Previous (1234567891) + 1

      // Third offline call should get cached sequence + 3
      const thirdAccount = await client.getAccountWithCache(testPublicKey);
      expect(thirdAccount.accountId()).toBe(testPublicKey);
      expect(thirdAccount.sequenceNumber().toString()).toBe("1234567893"); // Previous (1234567892) + 1

      // Verify sequences are strictly increasing
      const firstSeq = BigInt(firstAccount.sequenceNumber().toString());
      const secondSeq = BigInt(secondAccount.sequenceNumber().toString());
      const thirdSeq = BigInt(thirdAccount.sequenceNumber().toString());
      expect(secondSeq).toBeGreaterThan(firstSeq);
      expect(thirdSeq).toBeGreaterThan(secondSeq);
    });
  });
});
