require('dotenv').config();
const express = require('express');
const cors = require('cors');
const { ThirdwebSDK } = require("@thirdweb-dev/sdk");
const { ethers } = require("ethers");

const app = express();
app.use(cors());
app.use(express.json());

// --- CONFIGURATION ---
const PORT = 3001;
const CHAIN = "base-sepolia-testnet";
const CONTRACT_ADDRESS = process.env.CONTRACT_ADDRESS;
const ADMIN_WALLET = process.env.ADMIN_WALLET_ADDRESS; // The "User" who owns the policies
console.log("Admin Wallet:", ADMIN_WALLET);
console.log("Contract Address:", CONTRACT_ADDRESS);

// Initialize Agent's Wallet (The Server is the Agent)
const sdk = ThirdwebSDK.fromPrivateKey(
    process.env.AGENT_PRIVATE_KEY, 
    CHAIN, 
    { secretKey: process.env.THIRDWEB_SECRET_KEY }
);

// --- MOCK DATABASE (UI Helper Data) ---
// We store "Templates" and "Agent Metadata" here for the UI.
// The ACTUAL limits are stored on the Blockchain.

let LOCAL_STATE = {
    currentSpend: 0.0, // We track spend locally for speed (reset daily in real app)
    templates: [
        { id: 1, name: "Conservative", value: 0.01 },
        { id: 2, name: "Standard", value: 0.1 },
        { id: 3, name: "Degen Mode", value: 5.0 }
    ],
    // Metadata for the UI list
    agents: [
        { id: 1, name: "Weather API Bot", address: "0xYourAgentAddressWillGoHere" } 
    ]
};

// Update agent address on startup
(async () => {
    const address = await sdk.wallet.getAddress();
    LOCAL_STATE.agents[0].address = address;
    console.log(`🤖 Agent Wallet Loaded: ${address}`);
    console.log(`📜 Smart Contract Linked: ${CONTRACT_ADDRESS}`);
})();

// --- SMART CONTRACT INTERFACE ---
// Minimal ABI to read the 'getPolicy' function
const ABI = [
    "function getPolicy(address _user, address _agent) view returns (uint256 dailyLimit, uint256 currentSpend, uint256 lastReset, bool isActive, bool exists)"
];

// --- ROUTES ---

// 1. GET FULL CONFIG (For Dashboard)
app.get('/api/config', async (req, res) => {
    try {
        const balance = await sdk.wallet.balance();
        const agentAddress = await sdk.wallet.getAddress();
        
        // Return local state + live chain balance
        res.json({ 
            status: "ACTIVE", // Global system status
            currentSpend: LOCAL_STATE.currentSpend,
            agentBalance: balance.displayValue, 
            agentAddress: agentAddress,
            agents: LOCAL_STATE.agents 
        });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// 2. TEMPLATES (For Policies Page)
app.get('/api/templates', (req, res) => res.json(LOCAL_STATE.templates));

app.post('/api/templates/add', (req, res) => {
    const { name, value } = req.body;
    LOCAL_STATE.templates.push({ id: Date.now(), name, value: Number(value) });
    res.json({ success: true });
});

// 3. AGENT METADATA (For Agents Page)
app.get('/api/agents', (req, res) => res.json(LOCAL_STATE.agents));

app.post('/api/agents/add', (req, res) => {
    const { name, address } = req.body;
    LOCAL_STATE.agents.push({ id: Date.now(), name, address });
    res.json({ success: true });
});

app.post('/api/agents/remove', (req, res) => {
    const { id } = req.body;
    LOCAL_STATE.agents = LOCAL_STATE.agents.filter(a => a.id !== id);
    res.json({ success: true });
});

// --- THE CORE: FIREWALL EXECUTION ---
// This is where the Hybrid Logic happens
app.post('/api/rpc/execute', async (req, res) => {
    const { to, amount } = req.body;
    const amountNum = Number(amount);

    console.log(`\n🛡️  FIREWALL INTERCEPT: Request to send ${amount} ETH to ${to}`);

    try {
        const agentAddress = await sdk.wallet.getAddress();
        
        // 1. READ SMART CONTRACT (The Source of Truth)
        // We use standard Ethers provider to read the contract state freely
        const provider = sdk.getProvider();
        const contract = new ethers.Contract(CONTRACT_ADDRESS, ABI, provider);

        console.log("🔍 Verifying Policy on Blockchain...");
        const policy = await contract.getPolicy(ADMIN_WALLET, agentAddress);

        // 2. CHECK: DOES POLICY EXIST?
        if (!policy.exists) {
            console.log("❌ BLOCKED: No Policy found on-chain for this agent.");
            return res.status(403).json({ error: "BLOCKED: No On-Chain Policy Found. Assign one in 'Agents' tab." });
        }

        // 3. CHECK: KILL SWITCH (isActive)
        if (policy.isActive === false) {
            console.log("❌ BLOCKED: Kill Switch is ACTIVE on Smart Contract.");
            return res.status(403).json({ error: "BLOCKED: Smart Contract Kill Switch is ACTIVE" });
        }

        // 4. CHECK: LIMITS
        // Convert Chain BigNumber to human readable string (ETH)
        const dailyLimitEth = Number(ethers.utils.formatEther(policy.dailyLimit));
        
        console.log(`📊 On-Chain Limit: ${dailyLimitEth} ETH | Local Spend: ${LOCAL_STATE.currentSpend} ETH`);

        if (LOCAL_STATE.currentSpend + amountNum > dailyLimitEth) {
            console.log("❌ BLOCKED: Daily Limit Exceeded.");
            return res.status(403).json({ error: `BLOCKED: Exceeds On-Chain Limit of ${dailyLimitEth} ETH` });
        }

        // --- IF WE GET HERE, THE TRANSACTION IS APPROVED ---
        
        console.log("✅ APPROVED. Signing Transaction...");

        // 5. EXECUTE TRANSACTION
        const tx = await sdk.wallet.transfer(to, amount);
        
        // 6. UPDATE LOCAL TRACKER
        LOCAL_STATE.currentSpend += amountNum;

        console.log(`🚀 SENT! Hash: ${tx.receipt.transactionHash}`);

        res.json({ 
            success: true, 
            txHash: tx.receipt.transactionHash,
            newSpend: LOCAL_STATE.currentSpend
        });

    } catch (error) {
        console.error("⚠️  Error:", error.reason || error.message);
        res.status(500).json({ error: error.reason || "Transaction Failed" });
    }
});

app.listen(PORT, () => console.log(`🔥 Aegis Hybrid Node Running on Port ${PORT}`));