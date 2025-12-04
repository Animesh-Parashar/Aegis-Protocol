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
const ADMIN_WALLET = process.env.ADMIN_WALLET_ADDRESS; 

// Initialize Server Wallet (The "Vault")
const sdk = ThirdwebSDK.fromPrivateKey(
    process.env.AGENT_PRIVATE_KEY, 
    CHAIN, 
    { secretKey: process.env.THIRDWEB_SECRET_KEY }
);

// --- DYNAMIC STATE ---
// We initialize agents as an empty array to prevent undefined errors.
let LOCAL_STATE = {
    currentSpend: 0.0,
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
        
        // Add default agent so the simulator has something to run immediately
        LOCAL_STATE.agents.push({ 
            id: "default-server-agent", 
            name: "Prime Server Agent", 
            address: address 
        });
        
    } catch (e) {
        console.error("❌ Startup Error: Check .env for Private Key", e);
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
            agentBalance: balance.displayValue, 
            agentAddress: serverAddress, 
            agents: LOCAL_STATE.agents 
        });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// 2. Agent Management
app.get('/api/agents', (req, res) => res.json(LOCAL_STATE.agents));

app.post('/api/agents/add', (req, res) => {
    const { name, address } = req.body;
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
    LOCAL_STATE.templates.push({ id: Date.now(), name, value: Number(value) });
    res.json({ success: true });
});

// 3. THE FIREWALL EXECUTION (The Core Logic)
app.post('/api/rpc/execute', async (req, res) => {
    // We expect 'agentAddress' so we know WHO needs to be checked
    const { to, amount, agentAddress } = req.body; 
    const amountNum = Number(amount);

    console.log(`\n🛡️  INTERCEPT: Agent ${agentAddress?.slice(0,6)}... wants to send ${amount} ETH`);

    try {
        const provider = sdk.getProvider();
        const contract = new ethers.Contract(CONTRACT_ADDRESS, ABI, provider);

        // FALLBACK: If no agentAddress sent, use the server's address
        const checkAddress = agentAddress || (await sdk.wallet.getAddress());

        // A. CHECK ON-CHAIN POLICY
        const policy = await contract.getPolicy(ADMIN_WALLET, checkAddress);

        if (!policy.exists) {
            console.log("❌ BLOCKED: No On-Chain Policy found.");
            return res.status(403).json({ error: "BLOCKED: No Policy Set on Blockchain" });
        }

        if (policy.isActive === false) {
            console.log("❌ BLOCKED: Kill Switch Active.");
            return res.status(403).json({ error: "BLOCKED: Kill Switch Active" });
        }

        // Handle Ethers v5 vs v6 compatibility
        const formatEth = ethers.formatEther || ethers.utils?.formatEther;
        const dailyLimitEth = Number(formatEth(policy.dailyLimit));
        
        // B. CHECK LIMITS
        if (LOCAL_STATE.currentSpend + amountNum > dailyLimitEth) {
            console.log(`❌ BLOCKED: Limit Exceeded (${dailyLimitEth} ETH)`);
            return res.status(403).json({ error: `BLOCKED: Exceeds On-Chain Limit of ${dailyLimitEth} ETH` });
        }

        // C. EXECUTE (Server signs the tx)
        console.log("✅ APPROVED. Signing Transaction...");
        const tx = await sdk.wallet.transfer(to, amount);
        
        LOCAL_STATE.currentSpend += amountNum;

        res.json({ 
            success: true, 
            txHash: tx.receipt.transactionHash,
            newSpend: LOCAL_STATE.currentSpend
        });

    } catch (error) {
        console.error("⚠️  Error:", error.reason || error.message);
        res.status(500).json({ error: error.reason || "Transaction Failed (Check Balance or Network)" });
    }
});

app.listen(PORT, () => console.log(`🔥 Aegis Hybrid Node Running on Port ${PORT}`));