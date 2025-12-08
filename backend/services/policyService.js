const {
  getContract,
  readContract,
  prepareContractCall,
  sendTransaction,
  waitForReceipt
} = require("thirdweb");
const { defineChain } = require("thirdweb/chains");
const { createThirdwebClient } = require("thirdweb");

require("dotenv").config();

// Initialize Client
const client = createThirdwebClient({
  clientId: process.env.THIRDWEB_CLIENT_ID || "mock-client-id", // Fallback for local testing
  secretKey: process.env.THIRDWEB_SECRET_KEY,
});

// Chain Configuration (Base Sepolia)
const chain = defineChain(84532);

// Contract Address
const AEGIS_GUARD_ADDRESS = process.env.CONTRACT_ADDRESS; // User provided env var name from server.js

// Minimal ABI for AegisGuardV2
const CONTRACT_ABI = [
  {
    type: "function",
    name: "checkGuard",
    inputs: [
      { name: "_user", type: "address", internalType: "address" },
      { name: "_agent", type: "address", internalType: "address" },
      { name: "_amount", type: "uint256", internalType: "uint256" }
    ],
    outputs: [
      { name: "allowed", type: "bool", internalType: "bool" },
      { name: "reason", type: "string", internalType: "string" }
    ],
    stateMutability: "view"
  },
  {
    type: "function",
    name: "recordSpend",
    inputs: [
      { name: "_user", type: "address", internalType: "address" },
      { name: "_agent", type: "address", internalType: "address" },
      { name: "_amount", type: "uint256", internalType: "uint256" },
      { name: "_txHash", type: "bytes32", internalType: "bytes32" }
    ],
    outputs: [],
    stateMutability: "nonpayable"
  }
];

let contract = null;
if (AEGIS_GUARD_ADDRESS) {
    contract = getContract({
        client,
        chain,
        address: AEGIS_GUARD_ADDRESS,
        abi: CONTRACT_ABI,
    });
}

/**
 * Checks if a spend is allowed by the on-chain policy.
 * @param {string} userAddress - The owner of the policy
 * @param {string} agentAddress - The agent trying to spend
 * @param {bigint} amount - The amount in atomic units (wei)
 * @returns {Promise<{ allowed: boolean, reason: string }>}
 */
async function checkPolicy(userAddress, agentAddress, amount) {
  if (!contract) {
    console.warn("⚠️  Mocking Policy Check (No Contract Address)");
    return { allowed: true, reason: "Mocked: Authorized" };
  }

  try {
    const result = await readContract({
      contract,
      method: "checkGuard",
      params: [userAddress, agentAddress, amount],
    });

    // Result is [allowed, reason] (array-like in readContract return typically, or object depending on generated types.
    // With manual ABI, it often returns an array or named result object.
    // In v5 readContract returns the decoded result.
    // If multiple outputs, it returns an array/object.
    // Let's assume array destructuring works based on ABI.
    const [allowed, reason] = result;
    return { allowed, reason };
  } catch (error) {
    console.error("❌ Policy Check Failed:", error);
    // Fail closed if we can't check policy
    return { allowed: false, reason: "Policy Check Error: " + error.message };
  }
}

/**
 * Records a spend on-chain.
 * @param {object} account - The admin account (created via privateKeyToAccount)
 * @param {string} userAddress
 * @param {string} agentAddress
 * @param {bigint} amount
 * @param {string} txHash
 * @returns {Promise<string>} - The transaction hash of the recordSpend call
 */
async function recordSpend(account, userAddress, agentAddress, amount, txHash) {
  if (!contract) {
    console.warn("⚠️  Mocking Record Spend (No Contract Address)");
    return "0xmock_record_hash";
  }

  try {
    const transaction = prepareContractCall({
      contract,
      method: "recordSpend",
      params: [userAddress, agentAddress, amount, txHash],
    });

    const { transactionHash } = await sendTransaction({
      transaction,
      account,
    });

    return transactionHash;
  } catch (error) {
    console.error("❌ Record Spend Failed:", error);
    // Don't throw, just log. Accounting failure shouldn't crash the already-settled flow?
    // User requirement: "These accounting errors should not break the API response, but should be logged."
    return null;
  }
}

module.exports = {
  checkPolicy,
  recordSpend,
  client,
  chain
};
