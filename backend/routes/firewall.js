// backend/routes/firewall.js
require("dotenv").config();
const express = require("express");
const router = express.Router();
const { ethers } = require("ethers");
// const { ThirdwebSDK } = require("@thirdweb-dev/sdk"); // enable when needed

/* -------------------- ENV -------------------- */

const CHAIN = process.env.CHAIN;
const RPC_URL = process.env.RPC_URL;
const CONTRACT_ADDRESS = process.env.CONTRACT_ADDRESS;

// These are optional here, because firewall can run in mock mode
const AGENT_PRIVATE_KEY = process.env.AGENT_PRIVATE_KEY;
// const THIRDWEB_SECRET_KEY = process.env.THIRDWEB_SECRET_KEY;

/* -------------------- OPTIONAL CHAIN SETUP -------------------- */

let provider = null;
// let sdk = null;

if (RPC_URL) {
  provider = new ethers.providers.JsonRpcProvider(RPC_URL);
}

/**
 * Uncomment when you want real execution
 *
 * if (CHAIN && AGENT_PRIVATE_KEY) {
 *   sdk = ThirdwebSDK.fromPrivateKey(
 *     AGENT_PRIVATE_KEY,
 *     CHAIN,
 *     THIRDWEB_SECRET_KEY ? { secretKey: THIRDWEB_SECRET_KEY } : {}
 *   );
 * }
 */

const FIREWALL_MODE = provider ? "CHAIN_AWARE" : "OFFLINE_MOCK";

/* -------------------- MOCK DATABASE (In-Memory) -------------------- */

let POLICY = {
  status: "ACTIVE",          // ACTIVE | PAUSED
  maxDailySpend: 100,        // USD limit (demo)
  currentSpend: 0,
  whitelistedAddresses: [
    "0xWeatherAPI",
    "0xGoogleCloud"
  ],
  logs: []
};

/* -------------------- HELPERS -------------------- */

const addLog = (type, message) => {
  const timestamp = new Date().toLocaleTimeString();
  const logEntry = { id: Date.now(), time: timestamp, type, message };
  POLICY.logs.unshift(logEntry);
  if (POLICY.logs.length > 50) POLICY.logs.pop();
};

/* -------------------- ROUTES -------------------- */

// GET: Firewall & Policy State
router.get("/status", (req, res) => {
  res.json({
    ...POLICY,
    firewallMode: FIREWALL_MODE,
    network: {
      chain: CHAIN || null,
      rpcUrl: RPC_URL || null,
      contractAddress: CONTRACT_ADDRESS || null
    }
  });
});

// POST: Update Policy
router.post("/policy/update", (req, res) => {
  const { maxDailySpend, status, newWhitelist } = req.body;

  if (maxDailySpend !== undefined) POLICY.maxDailySpend = Number(maxDailySpend);

  if (status !== undefined) {
    POLICY.status = status;
    addLog(
      status === "PAUSED" ? "ALERT" : "INFO",
      `System status set to: ${status}`
    );
  }

  if (newWhitelist) {
    POLICY.whitelistedAddresses.push(newWhitelist);
    addLog("INFO", `Whitelisted address added: ${newWhitelist}`);
  }

  res.json({ success: true, policy: POLICY });
});

// POST: Reset Policy
router.post("/policy/reset", (req, res) => {
  POLICY.currentSpend = 0;
  POLICY.logs = [];
  POLICY.status = "ACTIVE";
  addLog("INFO", "System Reset Initiated");
  res.json({ success: true });
});

/* -------------------- CORE FIREWALL -------------------- */

router.post("/rpc/agent-request", async (req, res) => {
  const { agentId, targetAddress, amount, data } = req.body;

  console.log(`🤖 Agent Request: Send $${amount} to ${targetAddress}`);

  // CHECK 1: KILL SWITCH
  if (POLICY.status === "PAUSED") {
    addLog("BLOCK", `BLOCKED: System Frozen. Agent ${agentId}`);
    return res.status(403).json({ error: "FIREWALL_PAUSED" });
  }

  // CHECK 2: WHITELIST
  if (!POLICY.whitelistedAddresses.includes(targetAddress)) {
    addLog("BLOCK", `BLOCKED: Unknown Recipient ${targetAddress}`);
    return res.status(403).json({ error: "UNKNOWN_RECIPIENT" });
  }

  // CHECK 3: DAILY LIMIT
  if (POLICY.currentSpend + amount > POLICY.maxDailySpend) {
    addLog(
      "BLOCK",
      `BLOCKED: Limit Exceeded. Tried $${amount}, Remaining: $${POLICY.maxDailySpend - POLICY.currentSpend}`
    );
    return res.status(403).json({ error: "LIMIT_EXCEEDED" });
  }

  /* ---------- APPROVED ---------- */

  POLICY.currentSpend += amount;
  addLog("SUCCESS", `APPROVED: Sent $${amount} to ${targetAddress}`);

  let txHash;

  if (FIREWALL_MODE === "CHAIN_AWARE") {
    // 🔒 Still mocked, but now chain-aware
    txHash =
      "0xMOCK_" +
      Math.random().toString(16).slice(2) +
      Date.now().toString(16);
  } else {
    // Fully offline demo mode
    txHash =
      "0xOFFLINE_" +
      Math.random().toString(16).slice(2) +
      Date.now().toString(16);
  }

  return res.json({
    status: "APPROVED",
    txHash,
    newSpendTotal: POLICY.currentSpend
  });
});

module.exports = router;
