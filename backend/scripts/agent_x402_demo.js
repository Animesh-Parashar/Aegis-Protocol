// scripts/agent_x402_demo.js
const colors = require("colors");

// Aegis Firewall endpoint (policy + on-chain settlement for simulation)
const FIREWALL_URL = "http://localhost:3001/api/rpc/execute";

// You will replace this with your actual agent address
const AGENT_IDENTITY = "0x561009A39f2BC5a975251685Ae8C7F98Fac063C7";

// --- MOCK x402 SERVICE ---
async function callPremiumAPI(endpoint) {
  console.log(`\n🤖 AGENT: Requesting resource from ${endpoint}...`.cyan);
  await new Promise((r) => setTimeout(r, 800));

  // SIMULATE 402 RESPONSE
  if (endpoint.includes("premium")) {
    console.log(`⚠️  API RESPONSE: 402 Payment Required`.yellow);
    return {
      status: 402,
      paymentDetails: {
        to: "0xcf942c47bc33dB4Fabc1696666058b784F9fa9ef", // Weather Service
        amount: "100000000000000", // 0.0001 ETH in wei
        chainId: 84532,
        token: "0x0000000000000000000000000000000000000000", // Native ETH
      },
    };
  }

  if (endpoint.includes("scam")) {
    console.log(`⚠️  API RESPONSE: 402 Payment Required`.yellow);
    return {
      status: 402,
      paymentDetails: {
        to: "0xScamAddress999999999999999999999999",
        amount: "5000000000000000000", // 5.0 ETH in wei
        chainId: 84532,
        token: "0x0000000000000000000000000000000000000000",
      },
    };
  }

  return { status: 200, data: "Here is your free data." };
}

// --- THE AGENT BRAIN ---
async function runAgent() {
  console.log("==========================================".white);
  console.log("   AI AGENT STARTED: x402 MODE".white);
  console.log("==========================================".white);

  // SCENARIO 1: LEGIT TRANSACTION
  console.log("\n--- TASK 1: Buy Weather Data ---".white);

  const response = await callPremiumAPI(
    "https://api.weather.com/premium/forecast"
  );

  if (response.status === 402) {
    console.log(
      `🔒 AGENT: Paywall detected. Sending invoice to Aegis Firewall...`.blue
    );

    try {
      const invoice = response.paymentDetails;

      const aegisResponse = await fetch(FIREWALL_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          agentAddress: AGENT_IDENTITY,
          to: invoice.to,
          amount: invoice.amount, // wei string
          chainId: invoice.chainId,
          token: invoice.token,
        }),
      });

      const data = await aegisResponse.json();

      if (!aegisResponse.ok) {
        throw new Error(data.error || "Firewall HTTP error");
      }

      if (!data.approved) {
        throw new Error(data.reason || "Payment not approved by Aegis");
      }

      console.log(`✅ AEGIS: Payment Authorized & Settled On-Chain!`.green);

      if (data.settlement && data.settlement.txHash) {
        console.log(`🚀 Tx Hash: ${data.settlement.txHash}`.gray);
        if (data.settlement.explorerUrl) {
          console.log(
            `🔗 Explorer: ${data.settlement.explorerUrl}`.gray
          );
        }
      }

      console.log(`🔓 AGENT: Accessing Data... SUCCESS.`.cyan);
    } catch (error) {
      console.log(`🛑 AEGIS BLOCKED: ${error.message}`.red);
    }
  }

  await new Promise((r) => setTimeout(r, 2000));

  // SCENARIO 2: SCAM
  console.log("\n--- TASK 2: Download 'Free' RAM (Scam Link) ---".white);

  const badResponse = await callPremiumAPI(
    "https://scam-site.com/download-ram"
  );

  if (badResponse.status === 402) {
    console.log(
      `🔒 AGENT: Paywall detected. Sending invoice to Aegis Firewall...`.blue
    );

    try {
      const invoice = badResponse.paymentDetails;

      const aegisResponse = await fetch(FIREWALL_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          agentAddress: AGENT_IDENTITY,
          to: invoice.to,
          amount: invoice.amount, // wei string
          chainId: invoice.chainId,
          token: invoice.token,
        }),
      });

      const data = await aegisResponse.json();

      if (!aegisResponse.ok) {
        throw new Error(data.error || "Firewall HTTP error");
      }

      if (!data.approved) {
        throw new Error(data.reason || "Payment not approved by Aegis");
      }

      // If somehow approved (shouldn't be if your policy is sane)
      console.log(`✅ AEGIS: Payment Authorized`.green);

      if (data.settlement && data.settlement.txHash) {
        console.log(`🚀 Tx Hash: ${data.settlement.txHash}`.gray);
        if (data.settlement.explorerUrl) {
          console.log(
            `🔗 Explorer: ${data.settlement.explorerUrl}`.gray
          );
        }
      }
    } catch (error) {
      console.log(`🛡️  AEGIS INTERVENTION:`.red);
      console.log(`❌ BLOCK REASON: ${error.message}`.red.bold);
      console.log(`👮 AGENT: Action aborted. Funds safe.`.white);
    }
  }
}

// Node 18+ has built-in fetch
runAgent();
