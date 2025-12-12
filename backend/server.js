/**
 * server.js
 * Aegis Firewall Node (updated)
 *
 * - Keeps original simulator endpoints intact.
 * - Adds JSON-RPC /rpc firewall endpoint (drop-in).
 * - Adds Redis-backed off-chain reservation for daily spend.
 * - Pushes successful settlements to a pending queue.
 * - Anchors pending items by calling AegisGuardV2.recordSpend(...) via a facilitator key.
 *
 * Requirements:
 *  - Node 18+ (global fetch)
 *  - npm install ioredis node-cron
 *
 * Replace your existing server.js with this (or merge changes).
 */

require("dotenv").config();
const express = require("express");
const cors = require("cors");
const { ThirdwebSDK } = require("@thirdweb-dev/sdk");
const { ethers } = require("ethers");
const Redis = require("ioredis");

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
const REDIS_URL = process.env.REDIS_URL || "redis://127.0.0.1:6379";
const FACILITATOR_PRIVATE_KEY = process.env.FACILITATOR_PRIVATE_KEY || process.env.ANCHOR_ADMIN_PRIVATE_KEY;

// Anchor / batching params
const ANCHOR_EPOCH_SECONDS = process.env.ANCHOR_EPOCH_SECONDS
  ? Number(process.env.ANCHOR_EPOCH_SECONDS)
  : 15 * 60; // 15 minutes
const ANCHOR_BATCH_SIZE = process.env.ANCHOR_BATCH_SIZE ? Number(process.env.ANCHOR_BATCH_SIZE) : 20;
const ANCHOR_MIN_DELTA_WEI = process.env.ANCHOR_MIN_DELTA_WEI
  ? ethers.BigNumber.from(process.env.ANCHOR_MIN_DELTA_WEI)
  : ethers.utils.parseEther("0.0"); // default 0 => process everything

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
if (!FACILITATOR_PRIVATE_KEY) {
  console.error("❌ FACILITATOR_PRIVATE_KEY missing in .env — server cannot start.");
  process.exit(1);
}

// --- THIRDWEB / ETHERS SETUP ---
const sdk = ThirdwebSDK.fromPrivateKey(AGENT_PRIVATE_KEY, CHAIN, {
  secretKey: THIRDWEB_SECRET_KEY,
});

const provider = new ethers.providers.JsonRpcProvider(RPC_URL);
const settlementWallet = new ethers.Wallet(AGENT_PRIVATE_KEY, provider);

// AegisGuardV2 ABI minimal for recordSpend/getPolicy
const AEGIS_GUARD_ABI = [
  "function getPolicy(address _user, address _agent) view returns (uint256,uint256,uint256,bool,bool)",
  "function recordSpend(address _user, address _agent, uint256 _amount, bytes32 _txHash) external",
  "event SpendRecorded(address indexed user, address indexed agent, uint256 amount, bytes32 indexed txHash)"
];

const aegisGuard = new ethers.Contract(CONTRACT_ADDRESS, AEGIS_GUARD_ABI, provider);

// --- REDIS SETUP ---
const redis = new Redis(REDIS_URL,{
  connectTimeout: 10000,
  maxRetriesPerRequest: 5,
});

// Facilitator contract instance (writes via facilitator key)
const facilitatorWallet = new ethers.Wallet(FACILITATOR_PRIVATE_KEY, provider);
const aegisGuardFacilitator = new ethers.Contract(CONTRACT_ADDRESS, AEGIS_GUARD_ABI, facilitatorWallet);

// --- LOCAL STATE (UI helpers only) ---
let LOCAL_STATE = {
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
    console.log(`\nAegis Firewall Online.`);
    console.log(`Server Agent Address: ${address}`);
    console.log(`Chain: ${CHAIN}`);
    console.log(`Policy Contract: ${CONTRACT_ADDRESS}`);
    console.log(`Read RPC: ${RPC_URL}`);

    LOCAL_STATE.agents.push({
      id: "default-server-agent",
      name: "Prime Server Agent",
      address,
    });
  } catch (e) {
    console.error("❌ Startup Error: Check .env for Private Key / network connectivity", e);
    process.exit(1);
  }
})();

// --- HELPERS ---

/**
 * Load policy for a given user/agent pair from chain.
 */
async function loadPolicy(userAddress, agentAddress) {
  const policy = await aegisGuard.getPolicy(userAddress, agentAddress);

  const dailyLimitWei = policy[0];
  const currentSpendWei = policy[1];
  const lastReset = policy[2];
  const isActive = policy[3];
  const exists = policy[4];

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
 * (This function still used for simple decisioning fallback)
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

// --- REDIS KEYS & RESERVATION HELPERS ---

function getDayKeyTs(ts = Date.now()) {
  const d = new Date(ts);
  const yyyy = d.getUTCFullYear();
  const mm = String(d.getUTCMonth() + 1).padStart(2, "0");
  const dd = String(d.getUTCDate()).padStart(2, "0");
  return `${yyyy}-${mm}-${dd}`;
}

function spendKey(user, agent, dayKey) {
  return `spend:{user:${user.toLowerCase()}:agent:${agent.toLowerCase()}}:${dayKey}`;
}

function pendingKey(user, agent) {
  return `pending:{user:${user.toLowerCase()}:agent:${agent.toLowerCase()}}`;
}

/**
 * Atomic reserve via WATCH/MULTI CAS loop.
 * amountWeiBN: ethers.BigNumber
 * limitWeiBN: ethers.BigNumber (on-chain daily limit)
 * Returns string with new total wei.
 */
async function reserveSpend(user, agent, amountWeiBN, limitWeiBN) {
  const dayKey = getDayKeyTs();
  const key = spendKey(user, agent, dayKey);
  const amountStr = amountWeiBN.toString();
  const maxRetries = 6;

  for (let attempt = 0; attempt < maxRetries; attempt++) {
    await redis.watch(key);
    let currentStr = await redis.get(key);
    if (!currentStr) currentStr = "0";
    const currentBI = BigInt(currentStr);
    const amountBI = BigInt(amountStr);
    const newBI = currentBI + amountBI;

    if (limitWeiBN && newBI > BigInt(limitWeiBN.toString())) {
      await redis.unwatch();
      throw new Error("LIMIT_EXCEEDED_OFFCHAIN_RESERVE");
    }

    const tx = redis.multi();
    tx.set(key, newBI.toString());
    tx.expire(key, 60 * 60 * 24 * 3);
    const execRes = await tx.exec();
    if (execRes === null) continue; // watched key changed; retry
    return newBI.toString();
  }
  throw new Error("RESERVE_FAILED_RETRIES");
}

/**
 * Rollback a reserved amount. Safe to call if key missing.
 */
async function rollbackSpend(user, agent, amountWeiBN) {
  const dayKey = getDayKeyTs();
  const key = spendKey(user, agent, dayKey);
  const amountBI = BigInt(amountWeiBN.toString());
  const maxRetries = 6;
  for (let attempt = 0; attempt < maxRetries; attempt++) {
    await redis.watch(key);
    let currentStr = await redis.get(key);
    if (!currentStr) currentStr = "0";
    const currentBI = BigInt(currentStr);
    const newBI = currentBI - amountBI;
    const newVal = newBI < 0n ? 0n : newBI;
    const tx = redis.multi();
    tx.set(key, newVal.toString());
    tx.expire(key, 60 * 60 * 24 * 3);
    const execRes = await tx.exec();
    if (execRes === null) continue;
    return newVal.toString();
  }
  throw new Error("ROLLBACK_FAILED");
}

async function readCurrentSpend(user, agent) {
  const key = spendKey(user, agent, getDayKeyTs());
  const v = await redis.get(key);
  return v || "0";
}

async function iterateKeys(pattern = "pending:*", limit = 1000) {
  return await scanKeys(redis, pattern, limit);
}

// --- JSON-RPC forwarding helper ---
async function forwardJsonRpc(requestBody) {
  const upstreamRes = await fetch(RPC_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify(requestBody),
  });

  const text = await upstreamRes.text();
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

function buildAegisRpcError({ id, jsonrpc, code, message, data }) {
  return {
    jsonrpc: jsonrpc || "2.0",
    id: id ?? null,
    error: {
      code,
      message,
      data,
    },
  };
}

// --- ROUTES (unchanged simulator routes kept as-is) ---

app.get("/health", (req, res) => {
  res.status(200).json({ status: "ok" });
});

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

// Agent management
app.get("/api/agents", (req, res) => res.json(LOCAL_STATE.agents));

app.post("/api/agents/add", (req, res) => {
  const { name, address } = req.body;
  if (!name || !address) {
    return res.status(400).json({ error: "Missing name or address" });
  }

  const agent = { id: Date.now(), name, address };
  LOCAL_STATE.agents.push(agent);
  console.log(`Agent Onboarded: ${name} (${address})`);

  res.json({ success: true, agents: LOCAL_STATE.agents });
});

app.post("/api/agents/remove", (req, res) => {
  const { id } = req.body;
  LOCAL_STATE.agents = LOCAL_STATE.agents.filter((a) => a.id !== id);
  res.json({ success: true, agents: LOCAL_STATE.agents });
});

// Templates
app.get("/api/templates", (req, res) => res.json(LOCAL_STATE.templates));

app.post("/api/templates/add", (req, res) => {
  const { name, value } = req.body;
  if (!name || value === undefined) {
    return res.status(400).json({ error: "Missing name or value" });
  }

  LOCAL_STATE.templates.push({ id: Date.now(), name, value: Number(value) });
  res.json({ success: true, templates: LOCAL_STATE.templates });
});

// MAIN RPC FIREWALL ENDPOINT (protocol mode)
app.post("/rpc", async (req, res) => {
  const body = req.body;

  const handleSingle = async (rpcReq) => {
    const { method, params, id, jsonrpc } = rpcReq || {};

    if (!method) {
      return buildAegisRpcError({
        id,
        jsonrpc,
        code: -32600,
        message: "Aegis: Invalid JSON-RPC request",
        data: { original: rpcReq },
      });
    }

    if (method !== "eth_sendTransaction" && method !== "eth_sendRawTransaction") {
      return forwardJsonRpc(rpcReq);
    }

    let from, to;
    let valueBN;
    try {
      if (method === "eth_sendTransaction") {
        const tx = (params && params[0]) || {};
        from = tx.from;
        to = tx.to;
        const valueHex = tx.value || "0x0";
        valueBN = ethers.BigNumber.from(valueHex);
      } else if (method === "eth_sendRawTransaction") {
        const raw = params && params[0];
        if (!raw) {
          throw new Error("Missing raw transaction data");
        }
        const parsed = ethers.utils.parseTransaction(raw);
        from = parsed.from;
        to = parsed.to;
        valueBN = parsed.value;
      }
    } catch (err) {
      console.error("Aegis /rpc parse error:", err);
      return buildAegisRpcError({
        id,
        jsonrpc,
        code: -32602,
        message: "Aegis: Failed to parse transaction",
        data: { reason: err.message || String(err) },
      });
    }

    if (!valueBN || valueBN.lte(ethers.constants.Zero)) {
      return forwardJsonRpc(rpcReq);
    }

    const requestedEth = Number(ethers.utils.formatEther(valueBN));
    const headerUser = req.headers["x-aegis-user"];
    const headerAgent = req.headers["x-aegis-agent"];
    const serverAgentAddress = await sdk.wallet.getAddress();

    const effectiveUserAddress = (headerUser || from || ADMIN_WALLET).toLowerCase();
    const effectiveAgentAddress = (headerAgent || from || serverAgentAddress).toLowerCase();

    console.log(
      `AEGIS RPC CHECK: method=${method}, agent=${effectiveAgentAddress.slice(0, 6)}..., user=${effectiveUserAddress.slice(0, 6)}..., to=${to || "0x0"}, value=${requestedEth} AVAX`
    );

    try {
      // 1) load policy
      const policy = await loadPolicy(effectiveUserAddress, effectiveAgentAddress);

      if (!policy.exists) {
        return buildAegisRpcError({
          id,
          jsonrpc,
          code: -32001,
          message: "Aegis: NO_POLICY",
          data: { reason: "No on-chain policy set for this agent." },
        });
      }
      if (!policy.isActive) {
        return buildAegisRpcError({
          id,
          jsonrpc,
          code: -32001,
          message: "Aegis: KILL_SWITCH",
          data: { reason: "Kill switch is active for this agent." },
        });
      }

      // Prefer raw on-chain dailyLimit if available
      const dailyLimitWeiBN = (policy.raw && policy.raw[0]) ? policy.raw[0] : ethers.utils.parseEther(String(policy.dailyLimitEth));

      // 2) Reserve off-chain before forwarding
      try {
        await reserveSpend(effectiveUserAddress, effectiveAgentAddress, valueBN, dailyLimitWeiBN);
      } catch (reserveErr) {
        if (reserveErr.message === "LIMIT_EXCEEDED_OFFCHAIN_RESERVE") {
          return buildAegisRpcError({
            id,
            jsonrpc,
            code: -32001,
            message: "Aegis: LIMIT_EXCEEDED",
            data: { reason: `Requested ${requestedEth} AVAX exceeds daily limit.` },
          });
        }
        return buildAegisRpcError({
          id,
          jsonrpc,
          code: -32002,
          message: "Aegis: RESERVE_FAILED",
          data: { reason: reserveErr.message || String(reserveErr) },
        });
      }

      console.log("AEGIS APPROVED (reserved): forwarding to upstream RPC...");

      // 3) Forward
      let upstreamResponse;
      try {
        upstreamResponse = await forwardJsonRpc(rpcReq);
      } catch (forwardErr) {
        // rollback on forward failure
        try {
          await rollbackSpend(effectiveUserAddress, effectiveAgentAddress, valueBN);
        } catch (rbErr) {
          console.error("Rollback failed after forward error:", rbErr);
        }
        return buildAegisRpcError({
          id,
          jsonrpc,
          code: -32003,
          message: "Aegis: FORWARD_FAILED",
          data: { reason: forwardErr.message || String(forwardErr) },
        });
      }

      // If upstream returned an error: rollback reservation and return upstream error
      if (upstreamResponse && upstreamResponse.error) {
        try {
          await rollbackSpend(effectiveUserAddress, effectiveAgentAddress, valueBN);
        } catch (rbErr) {
          console.error("Rollback failed after upstream error:", rbErr);
        }
        return upstreamResponse;
      }

      // At this point upstream likely returned { jsonrpc, id, result: "<txHash>" }
      // Extract txHash robustly
      let txHash = null;
      if (upstreamResponse && upstreamResponse.result) txHash = upstreamResponse.result;
      // in some upstreams result may be an object with hash
      if (!txHash && upstreamResponse && upstreamResponse.hash) txHash = upstreamResponse.hash;
      // txHash should be a 0x-prefixed 32-byte hex string
      if (!txHash || !ethers.utils.isHexString(txHash)) {
        // best-effort: try to find a hex string in the response
        const maybe = JSON.stringify(upstreamResponse).match(/0x[a-fA-F0-9]{64}/);
        if (maybe) txHash = maybe[0];
      }

      // push to pending queue for anchoring (if txHash exists)
      const pending = {
        txHash: txHash || null,
        amountWei: valueBN.toString(),
        timestamp: Date.now()
      };
      await redis.lpush(pendingKey(effectiveUserAddress, effectiveAgentAddress), JSON.stringify(pending));

      // Update local UX state roughly
      try {
        const readVal = await readCurrentSpend(effectiveUserAddress, effectiveAgentAddress);
        LOCAL_STATE.currentSpend = Number(ethers.utils.formatEther(readVal));
      } catch (_) {}

      // Return upstream response unchanged
      return upstreamResponse;

    } catch (err) {
      console.error("AEGIS /rpc internal error:", err);
      return buildAegisRpcError({
        id,
        jsonrpc,
        code: -32002,
        message: "Aegis: Internal policy check error",
        data: { reason: err.message || String(err) },
      });
    }
  }; // end handleSingle

  try {
    if (Array.isArray(body)) {
      const results = await Promise.all(body.map((reqItem) => handleSingle(reqItem)));
      return res.json(results);
    } else {
      const result = await handleSingle(body);
      return res.json(result);
    }
  } catch (err) {
    console.error("/rpc top-level error:", err);
    const id = body && body.id;
    return res.status(500).json(
      buildAegisRpcError({
        id,
        jsonrpc: (body && body.jsonrpc) || "2.0",
        code: -32099,
        message: "Aegis: Fatal /rpc error",
        data: { reason: err.message || String(err) },
      })
    );
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

// --- ANCHOR (recordSpend) JOB ---
// Drains pending:<user>:<agent> lists and calls AegisGuardV2.recordSpend via facilitator key.
async function runRecordSpendJob() {
  try {
    // Use SCAN for production scale; KEYS acceptable for small-scale testing.
    const keys = await iteratePendingKeys("pending:*");;
    for (const key of keys) {
      const [, user, agent] = key.split(":"); // pending:user:agent
      for (let i = 0; i < ANCHOR_BATCH_SIZE; i++) {
        const raw = await redis.rpop(key);
        if (!raw) break;
        let item;
        try {
          item = JSON.parse(raw);
        } catch (e) {
          console.warn("Malformed pending item:", raw);
          continue;
        }

        const { txHash, amountWei } = item;
        if (!txHash) {
          console.warn("Pending missing txHash, moving to failed queue:", item);
          await redis.lpush(`failed:${key}`, raw);
          continue;
        }

        // check processed flag
        const procKey = `${key}:processed:${txHash}`;
        const already = await redis.get(procKey);
        if (already) continue;

        // Convert txHash into bytes32 format expected by contract; assume txHash is 0x-prefixed 32 bytes
        if (!ethers.utils.isHexString(txHash, 32)) {
          console.warn("Invalid txHash length for recordSpend; moving to failed queue:", txHash);
          await redis.lpush(`failed:${key}`, raw);
          continue;
        }

        try {
          const tx = await aegisGuardFacilitator.recordSpend(user, agent, ethers.BigNumber.from(amountWei), txHash);
          console.log("recordSpend tx sent:", tx.hash);
          await tx.wait(1);
          console.log("recordSpend confirmed:", tx.hash);
          await redis.set(procKey, String(Date.now()), "EX", 60 * 60 * 24 * 7);
        } catch (err) {
          console.error("recordSpend failed, pushing to failed:", err);
          // push to failed queue for operator retry & alert
          await redis.lpush(`failed:${key}`, raw);
          // stop draining this key to avoid hotloop when contract revert happens (e.g., limit exceeded)
          break;
        }
      } // end batch
    } // end keys loop
  } catch (err) {
    console.error("runRecordSpendJob failed:", err);
  }
}

// schedule the recordSpend job
setInterval(runRecordSpendJob, ANCHOR_EPOCH_SECONDS * 1000);

// --- START SERVER ---
app.listen(PORT, () => console.log(`Aegis Firewall Node Running on Port ${PORT} (Avalanche Mode)`));
