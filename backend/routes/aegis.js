const express = require("express");
const router = express.Router();
const { checkPolicy, recordSpend } = require("../services/policyService");
const { settlePayment, facilitatorAccount } = require("../services/facilitatorService");
const { keccak256, toHex } = require("thirdweb/utils");

// Helper to convert string to bytes32 for on-chain storage
// Note: In a real app, you might hash the txHash again or just pass it if it fits.
// recordSpend expects bytes32. Payment tx hash is 32 bytes (64 hex chars).
function ensureBytes32(hash) {
    if (!hash.startsWith("0x")) hash = "0x" + hash;
    return hash;
}

router.post("/execute-task", async (req, res) => {
  try {
    // 1. Extract Identity & Intent
    // "Agent hits /aegis/<serviceId>... Extract: x-payment, user, agentId, serviceId"
    // In this generic handler, we look for these in headers or body.

    // Identity headers (simulating what an agent would send)
    const userAddress = req.headers["x-user-address"] || req.body.userAddress || process.env.ADMIN_WALLET_ADDRESS; // Fallback to admin as user for demo
    const agentAddress = req.headers["x-agent-address"] || req.body.agentAddress;
    const serviceId = req.headers["x-service-id"] || req.body.serviceId || "default-service";

    // Payment Intent
    // For x402, the agent might send a "proposed" amount if they know the price,
    // or the server calculates it.
    // The prompt says: "Pre-compute proposedSpend (e.g., from price in requirements)."
    // Let's assume the body contains `amount` or we derive it.
    const requestedAmount = req.body.amount || "0.0001"; // Default low amount for demo
    const destinationAddress = req.body.to || process.env.ADMIN_WALLET_ADDRESS; // Where money should go (the service provider)

    if (!agentAddress) {
      return res.status(400).json({ error: "Missing Agent Identity (x-agent-address)" });
    }

    console.log(`\n🛡️  Aegis Intercept: Agent ${agentAddress} -> Service ${serviceId} ($${requestedAmount})`);

    // 2. Policy Evaluation (Read-Only)
    // "Call getPolicy... If not allowed: return policy error and do not call settlePayment()."

    // Convert amount to wei (bigint) for policy check if needed, but checkGuard takes atomic units.
    // Assuming AegisGuardV2 expects 18 decimals for ETH.
    const amountWei = BigInt(Math.floor(Number(requestedAmount) * 1e18));

    const policyDecision = await checkPolicy(userAddress, agentAddress, amountWei);

    if (!policyDecision.allowed) {
      console.log(`❌ Policy Denied: ${policyDecision.reason}`);
      // 402 Payment Required is standard for x402, but 403 Forbidden fits "Policy Violation".
      // Prompt says: "If policy is inactive... respond with 402/403".
      return res.status(403).json({
        error: "Policy Violation",
        details: policyDecision.reason
      });
    }

    console.log(`✅ Policy Approved. Proceeding to Settlement...`);

    // 3. Settlement (Facilitator)
    // "If allowed, call settlePayment()... If it fails, return payment failure."
    let txHash;
    try {
      txHash = await settlePayment({
        to: destinationAddress,
        amount: requestedAmount
      });
      console.log(`💰 Settlement Complete: ${txHash}`);
    } catch (paymentError) {
      console.error(`❌ Settlement Failed: ${paymentError.message}`);
      return res.status(502).json({
        error: "Payment Settlement Failed",
        details: paymentError.message
      });
    }

    // 4. Accounting (Async/Optional)
    // "If settlement succeeded... Call recordSpend... as a separate tx."
    // We don't await this to block the response (or we do, depending on strictness).
    // Prompt says: "These accounting errors should not break the API response"
    if (facilitatorAccount) {
        recordSpend(
            facilitatorAccount,
            userAddress,
            agentAddress,
            amountWei,
            ensureBytes32(txHash)
        ).then(recordTx => {
            if (recordTx) console.log(`📝 Spend Recorded On-Chain: ${recordTx}`);
        });
    }

    // 5. Forward Result
    // "Return the protected resource / API response to the agent."
    res.json({
      success: true,
      data: {
        message: "Task Executed Successfully",
        serviceId: serviceId,
        timestamp: Date.now()
      },
      payment: {
        txHash: txHash,
        amount: requestedAmount,
        currency: "ETH" // Native
      }
    });

  } catch (error) {
    console.error("🔥 Aegis Internal Error:", error);
    res.status(500).json({ error: "Internal Server Error" });
  }
});

module.exports = router;
