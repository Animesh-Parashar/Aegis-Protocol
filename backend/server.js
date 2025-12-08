require("dotenv").config();
const express = require("express");
const cors = require("cors");
const { ThirdwebSDK } = require("@thirdweb-dev/sdk");
const { ethers } = require("ethers");

const app = express();
app.use(cors());
app.use(express.json());

const PORT = process.env.PORT ? Number(process.env.PORT) : 3001;
const CHAIN = process.env.CHAIN || "avalanche-fuji";
const CONTRACT_ADDRESS = process.env.CONTRACT_ADDRESS;
const ADMIN_WALLET = process.env.ADMIN_WALLET_ADDRESS;

const RPC_URL = process.env.RPC_URL || "https://api.avax-test.network/ext/bc/C/rpc";
const AGENT_PRIVATE_KEY = process.env.AGENT_PRIVATE_KEY;
const THIRDWEB_SECRET_KEY = process.env.THIRDWEB_SECRET_KEY;

const EXPLORER_BASE_URL = process.env.EXPLORER_BASE_URL || "https://testnet.snowtrace.io/tx/";

// --- ENV GUARDS ---
if (!AGENT_PRIVATE_KEY) {
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
if (!THIRDWEB_SECRET_KEY) {
  console.error("❌ THIRDWEB_SECRET_KEY missing in .env — server cannot start.");
  process.exit(1);
}

// --- THIRDWEB / ETHERS SETUP ---
const sdk = ThirdwebSDK.fromPrivateKey(AGENT_PRIVATE_KEY, CHAIN, {
  secretKey: THIRDWEB_SECRET_KEY,
});

const provider = new ethers.providers.JsonRpcProvider(RPC_URL);
const settlementWallet = new ethers.Wallet(AGENT_PRIVATE_KEY, provider);

const AEGIS_ABI = [
  "function getPolicy(address _user, address _agent) view returns (uint256 dailyLimit, uint256 currentSpend, uint256 lastReset, bool isActive, bool exists)",
];

const policyContract = new ethers.Contract(CONTRACT_ADDRESS, AEGIS_ABI, provider);

// --- LOCAL STATE (UI helpers only) ---
let LOCAL_STATE = {
  // NOTE: This is local, not canonical. On-chain is source of truth.
  currentSpend: 0.0,
  templates: [
    { id: 1, name: "Conservative", value: 0.01 },
    { id: 2, name: "Standard", value: 0.1 },
    { id: 3, name: "Whale Mode", value: 5.0 },
  ],
  agents: [],
};

// --- BOOTSTRAP ---
(async () => {
  try {
    const address = await sdk.wallet.getAddress();
    console.log(`\n🤖 Aegis Firewall Online.`);
    console.log(`🔑 Server Agent Address: ${address}`);
    console.log(`🌉 Chain: ${CHAIN}`);
    console.log(`📜 Policy Contract: ${CONTRACT_ADDRESS}`);
    console.log(`🔭 Read RPC: ${RPC_URL}`);

    LOCAL_STATE.agents.push({
      id: "default-server-agent",
      name: "Prime Server Agent",
      address,
    });
  } catch (e) {
    console.error(
      "❌ Startup Error: Check .env for Private Key / network connectivity",
      e
    );
    process.exit(1);
  }
})();

// --- HELPERS ---

/**
 * Load policy for a given user/agent pair from chain.
 */
async function loadPolicy(userAddress, agentAddress) {
  const policy = await policyContract.getPolicy(userAddress, agentAddress);

  const dailyLimitWei = policy[0];
  const currentSpendWei = policy[1];
  const lastReset = policy[2];
  const isActive = policy[3];
  const exists = policy[4];

  // AVAX uses 18 decimals like ETH, so formatEther is fine.
  const dailyLimitEth = Number(ethers.utils.formatEther(dailyLimitWei));
  const currentSpendEth = Number(ethers.utils.formatEther(currentSpendWei));

  return {
    raw: policy,
    exists,
    isActive,
    dailyLimitEth,
    currentSpendEth,
    lastReset: Number(lastReset.toString()),
    remainingEth: Math.max(dailyLimitEth - currentSpendEth, 0),
  };
}

/**
 * Evaluate a spend request against a policy + local tracking.
 */
function evaluatePolicy({ policy, requestedEth, localCurrentSpend }) {
  if (!policy.exists) {
    return {
      approved: false,
      code: "NO_POLICY",
      reason: "No on-chain policy set for this agent.",
    };
  }

  if (!policy.isActive) {
    return {
      approved: false,
      code: "KILL_SWITCH",
      reason: "Kill switch is active for this agent.",
    };
  }

  const effectiveCurrent = policy.currentSpendEth + localCurrentSpend;
  const projected = effectiveCurrent + requestedEth;

  if (projected > policy.dailyLimitEth) {
    return {
      approved: false,
      code: "LIMIT_EXCEEDED",
      reason: `Requested ${requestedEth} AVAX exceeds daily limit of ${policy.dailyLimitEth} AVAX.`,
    };
  }

  return {
    approved: true,
    code: "APPROVED",
    reason: "Within daily limit and policy is active.",
  };
}

// --- ROUTES ---

app.get('/health', (req, res) => {
  res.status(200).json({ status: 'ok' });
});


// Basic status/config for dashboard
app.get("/api/config", async (req, res) => {
  try {
    const balance = await sdk.wallet.balance();
    const serverAddress = await sdk.wallet.getAddress();

    res.json({
      status: "ACTIVE",
      currentSpend: LOCAL_STATE.currentSpend,
      agentBalance: balance?.displayValue ?? "0",
      agentAddress: serverAddress,
      agents: LOCAL_STATE.agents,
      templates: LOCAL_STATE.templates,
    });
  } catch (e) {
    console.error("GET /api/config error:", e);
    res.status(500).json({ error: e.message || "Server error" });
  }
});

// Agent management (UI sugar)
app.get("/api/agents", (req, res) => res.json(LOCAL_STATE.agents));

app.post("/api/agents/add", (req, res) => {
  const { name, address } = req.body;
  if (!name || !address) {
    return res.status(400).json({ error: "Missing name or address" });
  }

  const agent = { id: Date.now(), name, address };
  LOCAL_STATE.agents.push(agent);
  console.log(`✅ Agent Onboarded: ${name} (${address})`);

  res.json({ success: true, agents: LOCAL_STATE.agents });
});

app.post("/api/agents/remove", (req, res) => {
  const { id } = req.body;
  LOCAL_STATE.agents = LOCAL_STATE.agents.filter((a) => a.id !== id);
  res.json({ success: true, agents: LOCAL_STATE.agents });
});

// Templates (UI)
app.get("/api/templates", (req, res) => res.json(LOCAL_STATE.templates));

app.post("/api/templates/add", (req, res) => {
  const { name, value } = req.body;
  if (!name || value === undefined) {
    return res.status(400).json({ error: "Missing name or value" });
  }

  LOCAL_STATE.templates.push({ id: Date.now(), name, value: Number(value) });
  res.json({ success: true, templates: LOCAL_STATE.templates });
});

// MAIN x402-LIKE ENTRYPOINT
app.post("/api/rpc/execute", async (req, res) => {
  const { to, amount, agentAddress, userAddress } = req.body;

  if (!to) return res.status(400).json({ error: "Missing 'to' address" });
  if (!amount) return res.status(400).json({ error: "Missing 'amount' (wei string)" });

  let amountWei;
  try {
    amountWei = ethers.BigNumber.from(amount);
  } catch (e) {
    return res.status(400).json({ error: "Invalid amount: must be a valid wei string" });
  }

  if (amountWei.lte(ethers.constants.Zero)) {
    return res.status(400).json({ error: "Invalid amount: must be > 0" });
  }

  const requestedEth = Number(ethers.utils.formatEther(amountWei)); // AVAX amount

  try {
    // Determine which address to consider as the agent
    const effectiveAgentAddress =
      agentAddress || (await sdk.wallet.getAddress());

    const effectiveUserAddress = userAddress || ADMIN_WALLET;

    console.log(
      `\n🛡️  AEGIS CHECK: Agent ${effectiveAgentAddress.slice(
        0,
        6
      )}... wants to send ${requestedEth} AVAX to ${to} on behalf of ${effectiveUserAddress}`
    );

    // 1) Load on-chain policy
    const policy = await loadPolicy(effectiveUserAddress, effectiveAgentAddress);

    // 2) Evaluate against policy + local tracking
    const decision = evaluatePolicy({
      policy,
      requestedEth,
      localCurrentSpend: LOCAL_STATE.currentSpend,
    });

    let txHash = null;
    let explorerUrl = null;

    if (decision.approved) {
      console.log("✅ APPROVED by Aegis Firewall. Sending on-chain tx on Avalanche...");

      // 3) Perform on-chain settlement (directly via agent wallet)
      const tx = await settlementWallet.sendTransaction({
        to,
        value: amountWei,
      });

      console.log(`⛓️  On-chain tx sent: ${tx.hash}`);

      // Update local tracking (UX only)
      LOCAL_STATE.currentSpend += requestedEth;

      txHash = tx.hash;
      explorerUrl = `${EXPLORER_BASE_URL}${tx.hash}`;
    } else {
      console.log(`❌ BLOCKED by Aegis Firewall: ${decision.reason}`);
    }

    // 4) Return structured decision + settlement info
    return res.json({
      success: true,
      approved: decision.approved,
      code: decision.code,
      reason: decision.reason,
      request: {
        to,
        amountWei: amountWei.toString(),
        amountEth: requestedEth, // AVAX value (naming kept for backward compat)
        agentAddress: effectiveAgentAddress,
        userAddress: effectiveUserAddress,
      },
      policy: {
        exists: policy.exists,
        isActive: policy.isActive,
        dailyLimitEth: policy.dailyLimitEth, // AVAX
        currentSpendEth: policy.currentSpendEth, // AVAX
        remainingEth: policy.remainingEth, // AVAX
        lastReset: policy.lastReset,
      },
      localTracking: {
        localCurrentSpend: LOCAL_STATE.currentSpend,
      },
      settlement: {
        performedBy: decision.approved ? "AGENT_WALLET_DIRECT" : "NONE",
        txHash,
        explorerUrl,
        note: decision.approved
          ? "On-chain transaction sent by Aegis simulation wallet on Avalanche."
          : "No settlement performed due to policy block.",
      },
    });
  } catch (error) {
    console.error("⚠️  Error in /api/rpc/execute:", error);
    return res.status(500).json({
      error:
        (error && (error.reason || error.message)) ||
        "Policy check or settlement failed (network / contract issue)",
    });
  }
});

// Optional: direct policy inspection for UI
app.get("/api/policy", async (req, res) => {
  try {
    const serverAddress = await sdk.wallet.getAddress();
    const userAddress = req.query.user || ADMIN_WALLET;
    const agentAddress = req.query.agent || serverAddress;

    const policy = await loadPolicy(userAddress, agentAddress);
    res.json({ userAddress, agentAddress, policy });
  } catch (e) {
    console.error("GET /api/policy error:", e);
    res.status(500).json({ error: e.message || "Failed to load policy" });
  }
});

// --- START SERVER ---
app.listen(PORT, () =>
  console.log(`🔥 Aegis Firewall Node Running on Port ${PORT} (Avalanche Mode)`)
);
