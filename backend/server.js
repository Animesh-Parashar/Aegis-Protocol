require("dotenv").config();
const express = require("express");
const cors = require("cors");
const { ThirdwebSDK } = require("@thirdweb-dev/sdk");
const { ethers } = require("ethers");
const Redis = require("ioredis");

const app = express();
app.use(cors());
app.use(express.json());

// ---- Config & Env guards ----
const PORT = process.env.PORT ? Number(process.env.PORT) : 3001;
const CHAIN = process.env.CHAIN || "avalanche-fuji";
const CONTRACT_ADDRESS = process.env.CONTRACT_ADDRESS;
const ADMIN_WALLET = process.env.ADMIN_WALLET_ADDRESS;

const RPC_URL = process.env.RPC_URL || "https://api.avax-test.network/ext/bc/C/rpc";
const AGENT_PRIVATE_KEY = process.env.AGENT_PRIVATE_KEY;
const THIRDWEB_SECRET_KEY = process.env.THIRDWEB_SECRET_KEY;
const REDIS_URL = process.env.REDIS_URL || "redis://127.0.0.1:6379";
const FACILITATOR_PRIVATE_KEY = process.env.FACILITATOR_PRIVATE_KEY || process.env.ANCHOR_ADMIN_PRIVATE_KEY;
const ANCHOR_SECRET = process.env.ANCHOR_SECRET || null;

const RUN_ANCHOR_WORKER = (process.env.RUN_ANCHOR_WORKER || "false").toLowerCase() === "true";
const ANCHOR_EPOCH_SECONDS = process.env.ANCHOR_EPOCH_SECONDS ? Number(process.env.ANCHOR_EPOCH_SECONDS) : 15 * 60;
const ANCHOR_BATCH_SIZE = process.env.ANCHOR_BATCH_SIZE ? Number(process.env.ANCHOR_BATCH_SIZE) : 20;
const EXPLORER_BASE_URL = process.env.EXPLORER_BASE_URL || "https://testnet.snowtrace.io/tx/";

// Minimum required env validation
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

// ---- SDK / provider / wallets ----
const sdk = ThirdwebSDK.fromPrivateKey(AGENT_PRIVATE_KEY, CHAIN, {
  secretKey: THIRDWEB_SECRET_KEY,
});
const provider = new ethers.providers.JsonRpcProvider(RPC_URL);
const settlementWallet = new ethers.Wallet(AGENT_PRIVATE_KEY, provider);

// AegisGuard ABI
const AEGIS_GUARD_ABI = [
  "function getPolicy(address _user, address _agent) view returns (uint256,uint256,uint256,bool,bool)",
  "function recordSpend(address _user, address _agent, uint256 _amount, bytes32 _txHash) external",
  "event SpendRecorded(address indexed user, address indexed agent, uint256 amount, bytes32 indexed txHash)",
];

const aegisGuard = new ethers.Contract(CONTRACT_ADDRESS, AEGIS_GUARD_ABI, provider);

// ---- Redis ----
const redis = new Redis(REDIS_URL, { connectTimeout: 10000, maxRetriesPerRequest: 5 });

// ---- Facilitator contract (only if key provided) ----
let facilitatorWallet = null;
let aegisGuardFacilitator = null;
if (FACILITATOR_PRIVATE_KEY) {
  facilitatorWallet = new ethers.Wallet(FACILITATOR_PRIVATE_KEY, provider);
  aegisGuardFacilitator = new ethers.Contract(CONTRACT_ADDRESS, AEGIS_GUARD_ABI, facilitatorWallet);
} else {
  console.warn("⚠️ FACILITATOR_PRIVATE_KEY not provided — anchor functionality disabled in this process.");
}

// ---- Local state for UI ----
let LOCAL_STATE = {
  currentSpend: 0.0,
  templates: [
    { id: 1, name: "Conservative", value: 0.01 },
    { id: 2, name: "Standard", value: 0.1 },
    { id: 3, name: "Whale Mode", value: 5.0 },
  ],
  agents: [],
};

// ---- Bootstrap ----
(async () => {
  try {
    const address = await sdk.wallet.getAddress();
    console.log(`\nAegis Firewall Online.`);
    console.log(`Server Agent Address: ${address}`);
    console.log(`Chain: ${CHAIN}`);
    console.log(`Policy Contract: ${CONTRACT_ADDRESS}`);
    console.log(`Read RPC: ${RPC_URL}`);

    LOCAL_STATE.agents.push({ id: "default-server-agent", name: "Prime Server Agent", address });
  } catch (e) {
    console.error("❌ Startup Error: Check .env for Private Key / network connectivity", e);
    process.exit(1);
  }
})();

// ---- Helpers ----
function getDayKeyTs(ts = Date.now()) {
  const d = new Date(ts);
  const yyyy = d.getUTCFullYear();
  const mm = String(d.getUTCMonth() + 1).padStart(2, "0");
  const dd = String(d.getUTCDate()).padStart(2, "0");
  return `${yyyy}-${mm}-${dd}`;
}
function spendKey(user, agent, dayKey = getDayKeyTs()) {
  return `spend:{user:${user.toLowerCase()}:agent:${agent.toLowerCase()}}:${dayKey}`;
}
function pendingKey(user, agent) {
  return `pending:{user:${user.toLowerCase()}:agent:${agent.toLowerCase()}}`;
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function scanKeys(redisClient, pattern = "pending:*", limit = 1000) {
  const keys = [];
  let cursor = "0";
  do {
    const res = await redisClient.scan(cursor, "MATCH", pattern, "COUNT", 200);
    cursor = res[0];
    const batch = res[1] || [];
    for (const k of batch) {
      keys.push(k);
      if (keys.length >= limit) break;
    }
    if (keys.length >= limit) break;
  } while (cursor !== "0");
  return keys;
}

// policy loader
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

function evaluatePolicy({ policy, requestedEth, localCurrentSpend = 0 }) {
  if (!policy.exists) return { approved: false, code: "NO_POLICY", reason: "No on-chain policy set for this agent." };
  if (!policy.isActive) return { approved: false, code: "KILL_SWITCH", reason: "Kill switch is active for this agent." };
  const effectiveCurrent = policy.currentSpendEth + localCurrentSpend;
  const projected = effectiveCurrent + requestedEth;
  if (projected > policy.dailyLimitEth) return { approved: false, code: "LIMIT_EXCEEDED", reason: `Requested ${requestedEth} > ${policy.dailyLimitEth}` };
  return { approved: true, code: "APPROVED", reason: "Within daily limit and policy is active." };
}

// Off-chain reservation helpers
async function reserveSpend(user, agent, amountWeiBN, limitWeiBN) {
  const key = spendKey(user, agent);
  const amountStr = amountWeiBN.toString();
  const maxRetries = 6;
  for (let i = 0; i < maxRetries; i++) {
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
    if (execRes === null) continue;
    return newBI.toString();
  }
  throw new Error("RESERVE_FAILED_RETRIES");
}
async function rollbackSpend(user, agent, amountWeiBN) {
  const key = spendKey(user, agent);
  const amountBI = BigInt(amountWeiBN.toString());
  const maxRetries = 6;
  for (let i = 0 ; i < maxRetries; i++) {
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

// Safe JSON-RPC forwarder (global fetch fallback to node-fetch)
async function forwardJsonRpc(requestBody) {
  let nodeFetch;
  if (typeof fetch !== "undefined") {
    nodeFetch = fetch;
  } else {
    const fetchPkg = await import("node-fetch");
    nodeFetch = fetchPkg.default;
  }
  const upstreamRes = await nodeFetch(RPC_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(requestBody),
  });
  const text = await upstreamRes.text();
  try { return JSON.parse(text); } catch { return text; }
}

function buildAegisRpcError({ id, jsonrpc, code, message, data }) {
  return { jsonrpc: jsonrpc || "2.0", id: id ?? null, error: { code, message, data } };
}

// ---- Routes ----
app.get("/health", (req, res) => res.status(200).json({ status: "ok" }));

app.get("/api/config", async (req, res) => {
  try {
    const balance = await sdk.wallet.balance();
    const serverAddress = await sdk.wallet.getAddress();
    res.json({ status: "ACTIVE", currentSpend: LOCAL_STATE.currentSpend, agentBalance: balance?.displayValue ?? "0", agentAddress: serverAddress, agents: LOCAL_STATE.agents, templates: LOCAL_STATE.templates });
  } catch (e) {
    console.error("GET /api/config error:", e);
    res.status(500).json({ error: e.message || "Server error" });
  }
});

// Agent/template endpoints (unchanged)
app.get("/api/agents", (req, res) => res.json(LOCAL_STATE.agents));
app.post("/api/agents/add", (req, res) => {
  const { name, address } = req.body;
  if (!name || !address) return res.status(400).json({ error: "Missing name or address" });
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
app.get("/api/templates", (req, res) => res.json(LOCAL_STATE.templates));
app.post("/api/templates/add", (req, res) => {
  const { name, value } = req.body;
  if (!name || value === undefined) return res.status(400).json({ error: "Missing name or value" });
  LOCAL_STATE.templates.push({ id: Date.now(), name, value: Number(value) });
  res.json({ success: true, templates: LOCAL_STATE.templates });
});

// ---- MAIN RPC endpoint ----
app.post("/rpc", async (req, res) => {
  const body = req.body;
  const handleSingle = async (rpcReq) => {
    const { method, params, id, jsonrpc } = rpcReq || {};
    if (!method) return buildAegisRpcError({ id, jsonrpc, code: -32600, message: "Aegis: Invalid JSON-RPC request", data: { original: rpcReq } });

    if (method !== "eth_sendTransaction" && method !== "eth_sendRawTransaction") {
      return forwardJsonRpc(rpcReq);
    }

    // Parse transaction
    let from = null, to = null, valueBN = ethers.constants.Zero;
    try {
      if (method === "eth_sendTransaction") {
        const tx = (params && params[0]) || {};
        from = tx.from;
        to = tx.to;
        valueBN = tx.value ? ethers.BigNumber.from(tx.value) : ethers.constants.Zero;
      } else {
        const raw = params && params[0];
        if (!raw) throw new Error("Missing raw tx");
        const parsed = ethers.utils.parseTransaction(raw);
        from = parsed.from;
        to = parsed.to;
        valueBN = parsed.value || ethers.constants.Zero;
      }
    } catch (err) {
      console.error("Aegis /rpc parse error:", err);
      return buildAegisRpcError({ id, jsonrpc, code: -32602, message: "Aegis: Failed to parse transaction", data: { reason: err.message || String(err) } });
    }

    if (!valueBN || valueBN.lte(ethers.constants.Zero)) return forwardJsonRpc(rpcReq);

    const requestedEth = Number(ethers.utils.formatEther(valueBN));
    const headerUser = req.headers["x-aegis-user"];
    const headerAgent = req.headers["x-aegis-agent"];
    const serverAgentAddress = await sdk.wallet.getAddress();

    const effectiveUserAddress = (headerUser || from || ADMIN_WALLET).toLowerCase();
    const effectiveAgentAddress = (headerAgent || from || serverAgentAddress).toLowerCase();

    console.log(`AEGIS RPC CHECK: method=${method}, agent=${effectiveAgentAddress.slice(0,6)}..., user=${effectiveUserAddress.slice(0,6)}..., to=${to || "0x0"}, value=${requestedEth} AVAX`);

    try {
      const policy = await loadPolicy(effectiveUserAddress, effectiveAgentAddress);
      if (!policy.exists) return buildAegisRpcError({ id, jsonrpc, code: -32001, message: "Aegis: NO_POLICY", data: { reason: "No on-chain policy set for this agent." } });
      if (!policy.isActive) return buildAegisRpcError({ id, jsonrpc, code: -32001, message: "Aegis: KILL_SWITCH", data: { reason: "Kill switch is active for this agent." } });

      const dailyLimitWeiBN = (policy.raw && policy.raw[0]) ? policy.raw[0] : ethers.utils.parseEther(String(policy.dailyLimitEth));

      try {
        await reserveSpend(effectiveUserAddress, effectiveAgentAddress, valueBN, dailyLimitWeiBN);
      } catch (reserveErr) {
        if (reserveErr.message === "LIMIT_EXCEEDED_OFFCHAIN_RESERVE") {
          return buildAegisRpcError({ id, jsonrpc, code: -32001, message: "Aegis: LIMIT_EXCEEDED", data: { reason: `Requested ${requestedEth} AVAX exceeds daily limit.` } });
        }
        return buildAegisRpcError({ id, jsonrpc, code: -32002, message: "Aegis: RESERVE_FAILED", data: { reason: reserveErr.message || String(reserveErr) } });
      }

      console.log("AEGIS APPROVED (reserved): forwarding to upstream RPC...");

      let upstreamResponse;
      try {
        upstreamResponse = await forwardJsonRpc(rpcReq);
      } catch (forwardErr) {
        try { await rollbackSpend(effectiveUserAddress, effectiveAgentAddress, valueBN); } catch (rb) { console.error("rollback failed after forward error:", rb); }
        return buildAegisRpcError({ id, jsonrpc, code: -32003, message: "Aegis: FORWARD_FAILED", data: { reason: forwardErr.message || String(forwardErr) } });
      }

      if (upstreamResponse && upstreamResponse.error) {
        try { await rollbackSpend(effectiveUserAddress, effectiveAgentAddress, valueBN); } catch (rb) { console.error("rollback failed after upstream error:", rb); }
        return upstreamResponse;
      }

      let txHash = null;
      if (upstreamResponse && upstreamResponse.result) txHash = upstreamResponse.result;
      if (!txHash && upstreamResponse && upstreamResponse.hash) txHash = upstreamResponse.hash;
      if (!txHash || !ethers.utils.isHexString(txHash)) {
        const maybe = JSON.stringify(upstreamResponse).match(/0x[a-fA-F0-9]{64}/);
        if (maybe) txHash = maybe[0];
      }

      const pending = { txHash: txHash || null, amountWei: valueBN.toString(), timestamp: Date.now() };
      await redis.lpush(pendingKey(effectiveUserAddress, effectiveAgentAddress), JSON.stringify(pending));

      try { const cur = await readCurrentSpend(effectiveUserAddress, effectiveAgentAddress); LOCAL_STATE.currentSpend = Number(ethers.utils.formatEther(cur)); } catch (_) {}

      return upstreamResponse;
    } catch (err) {
      console.error("AEGIS /rpc internal error:", err);
      return buildAegisRpcError({ id, jsonrpc, code: -32002, message: "Aegis: Internal policy check error", data: { reason: err.message || String(err) } });
    }
  };

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
    return res.status(500).json(buildAegisRpcError({ id, jsonrpc: (body && body.jsonrpc) || "2.0", code: -32099, message: "Aegis: Fatal /rpc error", data: { reason: err.message || String(err) } }));
  }
});

// ---- Policy inspection ----
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

// ---- Demo helper endpoints (safe) ----
app.get("/demo/run-healthcheck", async (req, res) => {
  try {
    const { exec } = require("child_process");
    exec("node scripts/healthcheck.js", (err, stdout, stderr) => {
      if (err) return res.status(500).send(`<pre>${stderr || err.message}</pre>`);
      res.send(`<pre>${stdout}</pre>`);
    });
  } catch (e) { res.status(500).send(e.toString()); }
});

app.get("/demo/send", async (req, res) => {
  try {
    const { exec } = require("child_process");
    exec("node scripts/sendViaAegis.js", (err, stdout, stderr) => {
      if (err) return res.status(500).send(`<pre>${stderr}</pre>`);
      res.send(`<pre>${stdout}</pre>`);
    });
  } catch (e) { res.status(500).send(e.toString()); }
});

// ---- Secure one-shot anchor endpoint (for Render demo constraints) ----
app.post("/internal/anchor/once", async (req, res) => {
  try {
    const token = req.headers["x-aegis-anchor-token"];
    if (!ANCHOR_SECRET) return res.status(403).json({ ok: false, error: "ANCHOR_SECRET not configured on server" });
    if (!token || token !== ANCHOR_SECRET) return res.status(401).json({ ok: false, error: "unauthorized" });

    // Acquire a short Redis lock to prevent concurrent runs
    const lockKey = "anchor:lock";
    const lockAcquired = await redis.set(lockKey, "1", "NX", "PX", 120 * 1000); // 2 minutes TTL
    if (!lockAcquired) return res.status(409).json({ ok: false, error: "anchor_in_progress" });

    // Ensure facilitator contract object exists (create temporarily if secret present but not initialized)
    if (!aegisGuardFacilitator && process.env.FACILITATOR_PRIVATE_KEY) {
      const localFac = new ethers.Wallet(process.env.FACILITATOR_PRIVATE_KEY, provider);
      aegisGuardFacilitator = new ethers.Contract(CONTRACT_ADDRESS, AEGIS_GUARD_ABI, localFac);
    }
    if (!aegisGuardFacilitator) {
      await redis.del(lockKey);
      return res.status(500).json({ ok: false, error: "facilitator_key_missing" });
    }

    // Run the single-iteration anchor
    const RUN_TIMEOUT_MS = 120000; // 2 minutes
    let timedOut = false;
    const timer = setTimeout(async () => { timedOut = true; try { await redis.del(lockKey); } catch (_) {} }, RUN_TIMEOUT_MS);

    let result;
    try {
      result = await runRecordSpendOnce();
    } finally {
      clearTimeout(timer);
      await redis.del(lockKey);
    }

    return res.json({ ok: true, processed: result.processed ?? 0, scanned: result.scanned ?? 0, txs: result.txs ?? result.txHashes ?? [] });
  } catch (err) {
    console.error("internal anchor endpoint error:", err && err.message ? err.message : err);
    try { await redis.del("anchor:lock"); } catch (_) {}
    return res.status(500).json({ ok: false, error: err && err.message ? err.message : String(err) });
  }
});

// ---- Convenience RPC execute (simulator) ----
app.post("/api/rpc/execute", async (req, res) => {
  const { to, amount, agentAddress, userAddress } = req.body;
  try {
    const amountWei = ethers.utils.parseEther(String(amount));
    const requestedEth = Number(ethers.utils.formatEther(amountWei));
    const effectiveAgentAddress = agentAddress || (await sdk.wallet.getAddress());
    const effectiveUserAddress = userAddress || effectiveAgentAddress;

    console.log(`RPC EXECUTE REQUEST: Agent ${effectiveAgentAddress.slice(0,6)}... wants to send ${requestedEth} AVAX to ${to} on behalf of ${effectiveUserAddress}`);

    const policy = await loadPolicy(effectiveUserAddress, effectiveAgentAddress);
    const decision = evaluatePolicy({ policy, requestedEth, localCurrentSpend: 0 });

    let txHash = null;
    if (decision.approved) {
      const tx = await settlementWallet.sendTransaction({ to, value: amountWei });
      console.log(`On-chain tx sent: ${tx.hash}`);
      LOCAL_STATE.currentSpend += requestedEth;
      txHash = tx.hash;
    } else {
      console.log(`BLOCKED by Aegis Firewall: ${decision.reason}`);
    }

    return res.json({ success: true, approved: decision.approved, reason: decision.reason, txHash, request: { to, amountWei: amountWei.toString(), amountEth: requestedEth, agentAddress: effectiveAgentAddress, userAddress: effectiveUserAddress } });
  } catch (err) {
    console.error("Error in /api/rpc/execute:", err);
    return res.status(500).json({ success: false, error: err.message });
  }
});

// ---- Anchor: single-iteration worker logic (exported) ----
async function runRecordSpendOnce() {
  try {
    const keys = await scanKeys(redis, "pending:*", 1000);
    if (!keys.length) return { processed: 0, scanned: 0 };

    let processed = 0;
    const txHashes = [];
    for (const key of keys) {
      const m = key.match(/^pending:\{user:([^:}]+):agent:([^:}]+)\}$/i);
      if (!m) {
        console.warn("Skipping unexpected pending key format:", key);
        continue;
      }
      const user = m[1], agent = m[2];

      for (let i = 0; i < ANCHOR_BATCH_SIZE; i++) {
        const raw = await redis.rpop(key);
        if (!raw) break;
        let item;
        try { item = JSON.parse(raw); } catch (e) { await redis.lpush(`failed:${key}`, raw); continue; }
        const { txHash, amountWei } = item;
        if (!txHash || !ethers.utils.isHexString(txHash, 32)) { await redis.lpush(`failed:${key}`, raw); continue; }

        const procKey = `${key}:processed:${txHash}`;
        const already = await redis.get(procKey);
        if (already) continue;

        if (!aegisGuardFacilitator) {
          await redis.lpush(key, raw);
          console.warn("Anchor skipped: FACILITATOR_PRIVATE_KEY not configured in this process.");
          return { processed, scanned: keys.length, txHashes };
        }

        try {
          const tx = await aegisGuardFacilitator.recordSpend(user, agent, ethers.BigNumber.from(amountWei), txHash);
          console.log("recordSpend tx sent:", tx.hash);
          await tx.wait(1);
          console.log("recordSpend confirmed:", tx.hash);
          await redis.set(procKey, String(Date.now()), "EX", 60 * 60 * 24 * 7);
          processed++;
          txHashes.push(tx.hash);
          // stop after first successful anchor to keep a demo quick — remove break to drain queue
          break;
        } catch (err) {
          console.error("recordSpend failed, pushing to failed:", err && err.message ? err.message : err);
          await redis.lpush(`failed:${key}`, raw);
          break;
        }
      }
      if (processed) break;
    }
    return { processed, scanned: keys.length, txHashes };
  } catch (err) {
    console.error("runRecordSpendOnce failed:", err && err.message ? err.message : err);
    throw err;
  }
}
module.exports = { runRecordSpendOnce };

// ---- Periodic anchor loop only if explicitly enabled on dedicated worker ----
if (RUN_ANCHOR_WORKER && FACILITATOR_PRIVATE_KEY) {
  console.log("Anchor worker enabled in this process. Epoch seconds:", ANCHOR_EPOCH_SECONDS, "Batch size:", ANCHOR_BATCH_SIZE);
  setInterval(async () => {
    try { await runRecordSpendOnce(); } catch (e) { console.error("Anchor interval error:", e && e.message ? e.message : e); }
  }, ANCHOR_EPOCH_SECONDS * 1000);
} else {
  console.log("Anchor worker disabled in this process. To enable: set RUN_ANCHOR_WORKER=true and provide FACILITATOR_PRIVATE_KEY (recommended: enable on dedicated worker only).");
}

// ---- Graceful shutdown ----
process.on("SIGINT", async () => { console.log("SIGINT: shutting down"); try { await redis.quit(); } catch (_) {} process.exit(0); });
process.on("SIGTERM", async () => { console.log("SIGTERM: shutting down"); try { await redis.quit(); } catch (_) {} process.exit(0); });

// ---- Start server ----
app.listen(PORT, () => console.log(`Aegis Firewall Node Running on Port ${PORT} (Avalanche Mode)`));
