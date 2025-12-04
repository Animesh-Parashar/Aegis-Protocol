// server.js (CommonJS, ethers v5 compatible)
require('dotenv').config();
const express = require('express');
const cors = require('cors');
const { ThirdwebSDK } = require("@thirdweb-dev/sdk");
const { ethers } = require("ethers");

const app = express();
app.use(cors());
app.use(express.json());

// --- CONFIGURATION ---
const PORT = process.env.PORT ? Number(process.env.PORT) : 3001;
const CHAIN = process.env.CHAIN || "base-sepolia-testnet";
const CONTRACT_ADDRESS = process.env.CONTRACT_ADDRESS;
const ADMIN_WALLET = process.env.ADMIN_WALLET_ADDRESS;
const RPC_URL = process.env.RPC_URL || "https://sepolia.base.org";

// Sanity checks
if (!process.env.AGENT_PRIVATE_KEY) {
  console.error("❌ AGENT_PRIVATE_KEY missing in .env — server cannot start.");
  process.exit(1);
}
if (!CONTRACT_ADDRESS) {
  console.error("❌ CONTRACT_ADDRESS missing in .env — server cannot start.");
  process.exit(1);
}
if (!ADMIN_WALLET) {
  console.error("❌ ADMIN_WALLET_ADDRESS missing in .env — server cannot start.");
  process.exit(1);
}

// Initialize Server Wallet (The "Vault")
const sdk = ThirdwebSDK.fromPrivateKey(
    process.env.AGENT_PRIVATE_KEY,
    CHAIN,
    { secretKey: process.env.THIRDWEB_SECRET_KEY }
);

// Provider for on-chain reads (ethers v5 style)
const provider = new ethers.providers.JsonRpcProvider(RPC_URL);

// --- DYNAMIC STATE ---
// We initialize agents as an empty array to prevent undefined errors.
let LOCAL_STATE = {
    currentSpend: 0.0, // stored in ETH (float). Consider switching to wei/BigInt for production.
    templates: [
        { id: 1, name: "Conservative", value: 0.01 },
        { id: 2, name: "Standard", value: 0.1 },
        { id: 3, name: "Whale Mode", value: 5.0 }
    ],
    agents: []
};

// --- STARTUP SCRIPT ---
// Automatically detect the server's wallet and add it as the first Agent.
(async () => {
    try {
        const address = await sdk.wallet.getAddress();
        console.log(`\n🤖 System Online.`);
        console.log(`🔑 Server Agent Address: ${address}`);
        console.log(`📜 Policy Contract: ${CONTRACT_ADDRESS}`);
        console.log(`🔭 Read RPC: ${RPC_URL}`);
        
        // Add default agent so the simulator has something to run immediately
        LOCAL_STATE.agents.push({ 
            id: "default-server-agent", 
            name: "Prime Server Agent", 
            address: address 
        });
        
    } catch (e) {
        console.error("❌ Startup Error: Check .env for Private Key / network connectivity", e);
        process.exit(1);
    }
})();

// --- ABI (To Read Policies) ---
const ABI = [
    "function getPolicy(address _user, address _agent) view returns (uint256 dailyLimit, uint256 currentSpend, uint256 lastReset, bool isActive, bool exists)"
];

// --- ROUTES ---

// 1. Get Config (Polls from Frontend)
app.get('/api/config', async (req, res) => {
    try {
        const balance = await sdk.wallet.balance();
        const serverAddress = await sdk.wallet.getAddress();
        
        res.json({ 
            status: "ACTIVE", 
            currentSpend: LOCAL_STATE.currentSpend,
            agentBalance: balance?.displayValue ?? "0", 
            agentAddress: serverAddress, 
            agents: LOCAL_STATE.agents,
            templates: LOCAL_STATE.templates
        });
    } catch (e) {
        console.error("GET /api/config error:", e);
        res.status(500).json({ error: e.message || "Server error" });
    }
});

// 2. Agent Management
app.get('/api/agents', (req, res) => res.json(LOCAL_STATE.agents));

app.post('/api/agents/add', (req, res) => {
    const { name, address } = req.body;
    if (!name || !address) return res.status(400).json({ error: "Missing name or address" });
    LOCAL_STATE.agents.push({ id: Date.now(), name, address });
    console.log(`✅ Agent Onboarded: ${name}`);
    res.json({ success: true, agents: LOCAL_STATE.agents });
});

app.post('/api/agents/remove', (req, res) => {
    const { id } = req.body;
    LOCAL_STATE.agents = LOCAL_STATE.agents.filter(a => a.id !== id);
    res.json({ success: true, agents: LOCAL_STATE.agents });
});

app.get('/api/templates', (req, res) => res.json(LOCAL_STATE.templates));

app.post('/api/templates/add', (req, res) => {
    const { name, value } = req.body;
    if (!name || value === undefined) return res.status(400).json({ error: "Missing name or value" });
    LOCAL_STATE.templates.push({ id: Date.now(), name, value: Number(value) });
    res.json({ success: true });
});

// 3. THE FIREWALL EXECUTION (The Core Logic)
app.post('/api/rpc/execute', async (req, res) => {
    // We expect 'agentAddress' so we know WHO needs to be checked
    const { to, amount, agentAddress } = req.body; 
    if (!to) return res.status(400).json({ error: "Missing 'to' address" });
    if (!amount) return res.status(400).json({ error: "Missing 'amount'" });

    const amountNum = Number(amount);
    if (isNaN(amountNum) || amountNum <= 0) return res.status(400).json({ error: "Invalid amount" });

    console.log(`\n🛡️  INTERCEPT: Agent ${agentAddress ? agentAddress.slice(0,6) + "..." : "(server)"} wants to send ${amount} ETH to ${to}`);

    try {
        // Use an ethers Contract with our provider (v5)
        const contract = new ethers.Contract(CONTRACT_ADDRESS, ABI, provider);

        // FALLBACK: If no agentAddress sent, use the server's address
        const checkAddress = agentAddress || (await sdk.wallet.getAddress());

        // A. CHECK ON-CHAIN POLICY
        const policy = await contract.getPolicy(ADMIN_WALLET, checkAddress);

        // policy might be array-like [dailyLimit, currentSpend, lastReset, isActive, exists]
        const exists = (policy && (policy[4] !== undefined ? policy[4] : policy.exists)) || false;
        const isActive = (policy && (policy[3] !== undefined ? policy[3] : policy.isActive)) || false;

        if (!exists) {
            console.log("❌ BLOCKED: No On-Chain Policy found.");
            return res.status(403).json({ error: "BLOCKED: No Policy Set on Blockchain" });
        }

        if (!isActive) {
            console.log("❌ BLOCKED: Kill Switch Active.");
            return res.status(403).json({ error: "BLOCKED: Kill Switch Active" });
        }

        // Convert dailyLimit (BigNumber) to ETH number safely using ethers v5 utils
        let dailyLimitEth;
        try {
            dailyLimitEth = Number(ethers.utils.formatEther(policy[0]));
        } catch (e) {
            console.warn("Warning: could not parse dailyLimit from policy, defaulting to 0", e);
            dailyLimitEth = 0;
        }
        
        // B. CHECK LIMITS
        if (LOCAL_STATE.currentSpend + amountNum > dailyLimitEth) {
            console.log(`❌ BLOCKED: Limit Exceeded (${dailyLimitEth} ETH)`);
            return res.status(403).json({ error: `BLOCKED: Exceeds On-Chain Limit of ${dailyLimitEth} ETH` });
        }

        // C. EXECUTE (Server signs the tx)
        console.log("✅ APPROVED. Signing Transaction...");
        // thirdweb's wallet.transfer often accepts (to, amount) where amount is string/number
        const tx = await sdk.wallet.transfer(to, String(amount));

        // Update local spend (in ETH)
        LOCAL_STATE.currentSpend += amountNum;

        res.json({ 
            success: true, 
            txHash: tx?.receipt?.transactionHash ?? tx?.hash ?? null,
            newSpend: LOCAL_STATE.currentSpend
        });

    } catch (error) {
        console.error("⚠️  Error in /api/rpc/execute:", error && (error.reason || error.message) ? (error.reason || error.message) : error);
        res.status(500).json({ error: (error && (error.reason || error.message)) || "Transaction Failed (Check Balance or Network)" });
    }
});

app.listen(PORT, () => console.log(`🔥 Aegis Hybrid Node Running on Port ${PORT}`));
