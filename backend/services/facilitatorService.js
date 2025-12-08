const {
  prepareTransaction,
  sendTransaction,
  waitForReceipt,
  toWei
} = require("thirdweb");
const { privateKeyToAccount } = require("thirdweb/wallets");
const { client, chain } = require("./policyService"); // Re-use client/chain config

require("dotenv").config();

// Initialize Facilitator Account (Server Wallet)
let facilitatorAccount = null;
if (process.env.AGENT_PRIVATE_KEY) {
  try {
    facilitatorAccount = privateKeyToAccount({
      client,
      privateKey: process.env.AGENT_PRIVATE_KEY,
    });
  } catch (e) {
    console.error("❌ Failed to load Facilitator Account:", e);
  }
} else {
    console.warn("⚠️  No AGENT_PRIVATE_KEY found. Facilitator mode: READ-ONLY / MOCK.");
}

/**
 * Settles a payment by sending funds from the Facilitator wallet.
 * @param {object} params
 * @param {string} params.to - Recipient address
 * @param {string} params.amount - Amount in ETH/Tokens (human readable string)
 * @param {string} [params.tokenAddress] - Optional: ERC20 token address (not implemented in this simple version, assumes Native Token)
 * @returns {Promise<string>} - The transaction hash of the payment
 */
async function settlePayment({ to, amount }) {
  if (!facilitatorAccount) {
    console.warn(`⚠️  Facilitator Mock: Pretending to send ${amount} to ${to}`);
    return "0xmock_payment_tx_hash_" + Date.now();
  }

  try {
    // 1. Prepare the transaction (Native Token Transfer)
    // In Thirdweb v5, we use prepareTransaction with `value`.
    const transaction = prepareTransaction({
      to: to,
      value: toWei(amount.toString()),
      chain: chain,
      client: client,
    });

    // 2. Send the transaction
    const { transactionHash } = await sendTransaction({
      transaction,
      account: facilitatorAccount,
    });

    // 3. Wait for confirmation (optional, but good for "Settlement")
    // The user flow implies we wait for it to be "settled".
    await waitForReceipt({
      client,
      chain,
      transactionHash,
    });

    return transactionHash;
  } catch (error) {
    console.error("❌ Settlement Failed:", error);
    throw new Error("Payment Settlement Failed: " + (error.message || "Unknown error"));
  }
}

module.exports = {
  settlePayment,
  facilitatorAccount
};
