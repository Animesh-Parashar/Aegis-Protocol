// backend/routes/firewall.js
const express = require('express');
const router = express.Router();
// const { ThirdwebSDK } = require("@thirdweb-dev/sdk"); // Uncomment for real chain interaction

// --- 1. MOCK DATABASE (In-Memory for Hackathon Speed) ---
let POLICY = {
    status: "ACTIVE",          // ACTIVE or PAUSED (Kill Switch)
    maxDailySpend: 100,        // USD limit
    currentSpend: 0,           // Tracked spend
    whitelistedAddresses: [
        "0xWeatherAPI", 
        "0xGoogleCloud"
    ],
    logs: []                   // For the "Live Feed" on frontend
};

// --- HELPER: Add Log ---
const addLog = (type, message) => {
    const timestamp = new Date().toLocaleTimeString();
    const logEntry = { id: Date.now(), time: timestamp, type, message };
    POLICY.logs.unshift(logEntry); // Add to top
    // Keep log size manageable
    if (POLICY.logs.length > 50) POLICY.logs.pop(); 
};

// --- ROUTES ---

// GET: Fetch current Policy State (For Dashboard)
router.get('/status', (req, res) => {
    res.json(POLICY);
});

// POST: Update Policy (Frontend Controls)
router.post('/policy/update', (req, res) => {
    const { maxDailySpend, status, newWhitelist } = req.body;
    
    if (maxDailySpend !== undefined) POLICY.maxDailySpend = maxDailySpend;
    if (status !== undefined) {
        POLICY.status = status;
        addLog(status === "PAUSED" ? "ALERT" : "INFO", `System status set to: ${status}`);
    }
    if (newWhitelist) POLICY.whitelistedAddresses.push(newWhitelist);

    res.json({ success: true, policy: POLICY });
});

// POST: Clear Logs or Reset Spend (Optional utils)
router.post('/policy/reset', (req, res) => {
    POLICY.currentSpend = 0;
    POLICY.logs = [];
    POLICY.status = "ACTIVE";
    addLog("INFO", "System Reset Initiated");
    res.json({ success: true });
});

// --- THE CORE FIREWALL LOGIC ---
// This is where the Agent sends its transaction request
router.post('/rpc/agent-request', async (req, res) => {
    const { agentId, targetAddress, amount, data } = req.body;

    console.log(`🤖 Agent Request: Send $${amount} to ${targetAddress}`);

    // CHECK 1: KILL SWITCH 🛑
    if (POLICY.status === "PAUSED") {
        addLog("BLOCK", `BLOCKED: System is Frozen. Agent ${agentId} denied.`);
        return res.status(403).json({ error: "FIREWALL_PAUSED" });
    }

    // CHECK 2: WHITELIST 📋
    // (Simple string check for hackathon, real world uses checksum addresses)
    if (!POLICY.whitelistedAddresses.includes(targetAddress)) {
        addLog("BLOCK", `BLOCKED: Unknown Recipient ${targetAddress}`);
        return res.status(403).json({ error: "UNKNOWN_RECIPIENT" });
    }

    // CHECK 3: SPENDING LIMIT 💸
    if (POLICY.currentSpend + amount > POLICY.maxDailySpend) {
        addLog("BLOCK", `BLOCKED: Limit Exceeded. Tried $${amount}, Remaining: $${POLICY.maxDailySpend - POLICY.currentSpend}`);
        return res.status(403).json({ error: "LIMIT_EXCEEDED" });
    }

    // --- IF ALL CHECKS PASS ---
    
    // 1. Update State
    POLICY.currentSpend += amount;
    addLog("SUCCESS", `APPROVED: Sent $${amount} to ${targetAddress}`);

    // 2. Execute on Blockchain (Mocked for Demo Reliability)
    // In production, this is where you use SDK.wallet.sendRawTransaction(data)
    const mockTxHash = "0x" + Math.random().toString(16).slice(2) + "..." + Math.random().toString(16).slice(2);

    // Return success to Agent
    return res.json({ 
        status: "APPROVED", 
        txHash: mockTxHash, 
        newSpendTotal: POLICY.currentSpend 
    });
});

module.exports = router;