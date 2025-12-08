// scripts/verify_flow.js
const axios = require("axios");

const API_URL = "http://localhost:3001/api/execute-task";

// Mock Data
const MOCK_AGENT = {
  address: "0xAgentMockAddress123456789012345678901234",
  userAddress: "0xUserMockAddress123456789012345678901234",
  serviceId: "test-service-01"
};

async function runTest() {
  console.log("🧪 Starting Aegis Flow Verification...");

  // 1. Test Policy Rejection (High Amount)
  // We assume the mocked policy check will allow everything if no contract,
  // BUT if we want to test rejection logic, we might need to modify the mock or use a specific amount if logic existed.
  // In our mock: "if (!contract) return allowed: true".
  // So we expect SUCCESS in Mock mode.

  try {
    console.log("\n1️⃣  Testing Standard Request...");
    const response = await axios.post(API_URL, {
      agentAddress: MOCK_AGENT.address,
      userAddress: MOCK_AGENT.userAddress,
      serviceId: MOCK_AGENT.serviceId,
      amount: "0.001", // Small amount
      to: "0xRecipient123"
    });

    if (response.status === 200 && response.data.success) {
      console.log("✅ Request Approved & Settled!");
      console.log("   TxHash:", response.data.payment.txHash);
    } else {
      console.error("❌ Unexpected Response:", response.status, response.data);
    }
  } catch (e) {
    if (e.response) {
      console.error("❌ Request Failed:", e.response.status, e.response.data);
    } else {
      console.error("❌ Network/Server Error:", e.message);
    }
  }

  // 2. Test Missing Identity
  try {
    console.log("\n2️⃣  Testing Invalid Request (Missing Identity)...");
    await axios.post(API_URL, {
      amount: "0.001"
    });
    console.error("❌ Should have failed but succeeded.");
  } catch (e) {
    if (e.response && e.response.status === 400) {
      console.log("✅ Correctly Rejected (400 Bad Request)");
    } else {
      console.error("❌ Failed with unexpected error:", e.message);
    }
  }

  console.log("\n🏁 Verification Complete.");
}

// Wait for server to potentially start if running in parallel, but here we assume user runs server first.
// Or we can just run this script.
runTest();
