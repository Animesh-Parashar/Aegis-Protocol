// scripts/agent_x402_demo.js
const axios = require('axios');
const colors = require('colors');

// CONFIG
const FIREWALL_URL = "http://localhost:3001/api/rpc/execute";
const AGENT_IDENTITY = "0xa0Ee7A142d267C1f36714E4a8F75612F20a79720"; // Must match your server/dashboard setup

// --- MOCK x402 SERVICE ---
// This function simulates a paid API (like OpenAI or a Data Feed)
async function callPremiumAPI(endpoint) {
    console.log(`\n🤖 AGENT: Requesting resource from ${endpoint}...`.cyan);
    await new Promise(r => setTimeout(r, 800)); // Network delay

    // SIMULATE 402 RESPONSE
    // The API says: "You must pay to access this."
    if (endpoint.includes("premium")) {
        console.log(`⚠️  API RESPONSE: 402 Payment Required`.yellow);
        return {
            status: 402,
            paymentRequest: {
                to: "0xcf942c47bc33dB4Fabc1696666058b784F9fa9ef", // The Weather API Wallet
                amount: "0.0001", // Cost of the API call
                currency: "ETH",
                chainId: 84532
            }
        };
    }
    
    // SIMULATE SCAM (For the demo)
    if (endpoint.includes("scam")) {
        console.log(`⚠️  API RESPONSE: 402 Payment Required`.yellow);
        return {
            status: 402,
            paymentRequest: {
                to: "0xScamAddress999999999999999999999999", // Evil Wallet
                amount: "5.0", // Huge amount
                currency: "ETH",
                chainId: 84532
            }
        };
    }
}

// --- THE AGENT BRAIN ---
async function runAgent() {
    console.log("==========================================".white);
    console.log("   AI AGENT STARTED: IDLE MODE".white);
    console.log("==========================================".white);

    // SCENARIO 1: LEGIT TRANSACTION
    console.log("\n--- TASK 1: Buy Weather Data ---".white);
    
    // 1. Hit the API
    const response = await callPremiumAPI("https://api.weather.com/premium/forecast");

    // 2. Handle x402 (The Interception)
    if (response.status === 402) {
        console.log(`🔒 AGENT: Paywall detected. Asking Aegis Firewall for permission...`.blue);
        
        try {
            const req = response.paymentRequest;
            
            // 3. Call Aegis (Instead of signing directly)
            const aegisResponse = await axios.post(FIREWALL_URL, {
                agentAddress: AGENT_IDENTITY,
                to: req.to,
                amount: req.amount
            });

            if (aegisResponse.data.success) {
                console.log(`✅ AEGIS: Transaction Approved & Signed!`.green);
                console.log(`🚀 Tx Hash: ${aegisResponse.data.txHash}`.gray);
                console.log(`🔓 AGENT: Accessing Data... SUCCESS.`.cyan);
            }

        } catch (error) {
            console.log(`🛑 AEGIS BLOCKED: ${error.response?.data?.error || error.message}`.red);
        }
    }

    await new Promise(r => setTimeout(r, 4000)); // Pause for effect

    // SCENARIO 2: MALICIOUS/HALLUCINATED TRANSACTION
    console.log("\n--- TASK 2: Download 'Free' RAM (Scam Link) ---".white);
    
    const badResponse = await callPremiumAPI("https://scam-site.com/download-ram");

    if (badResponse.status === 402) {
        console.log(`🔒 AGENT: Paywall detected. Asking Aegis Firewall for permission...`.blue);
        
        try {
            const req = badResponse.paymentRequest;
            
            // Call Aegis
            await axios.post(FIREWALL_URL, {
                agentAddress: AGENT_IDENTITY,
                to: req.to,
                amount: req.amount
            });
            // Should not reach here
        } catch (error) {
            console.log(`🛡️  AEGIS INTERVENTION:`.red);
            console.log(`❌ BLOCK REASON: ${error.response?.data?.error}`.red.bold);
            console.log(`👮 AGENT: Action aborted. Funds safe.`.white);
        }
    }
}

runAgent();