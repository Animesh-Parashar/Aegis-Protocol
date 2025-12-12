require("dotenv").config();
const Redis = require("ioredis");
const { ethers } = require("ethers");

const REDIS_URL = process.env.REDIS_URL;
const RPC_URL = process.env.RPC_URL;
const CONTRACT_ADDRESS = process.env.CONTRACT_ADDRESS;
const FACILITATOR_PRIVATE_KEY = process.env.FACILITATOR_PRIVATE_KEY;

const ANCHOR_BATCH_SIZE = process.env.ANCHOR_BATCH_SIZE ? Number(process.env.ANCHOR_BATCH_SIZE) : 20;
const ANCHOR_EPOCH_SECONDS = process.env.ANCHOR_EPOCH_SECONDS ? Number(process.env.ANCHOR_EPOCH_SECONDS) : 15 * 60;

if (!REDIS_URL || !RPC_URL || !CONTRACT_ADDRESS || !FACILITATOR_PRIVATE_KEY) {
  console.error("Missing required env. Ensure REDIS_URL, RPC_URL, CONTRACT_ADDRESS, FACILITATOR_PRIVATE_KEY are set.");
  process.exit(1);
}

// Redis client (Valkey / Render Key Value compatible)
const redis = new Redis(REDIS_URL, {
  connectTimeout: 10000,
  maxRetriesPerRequest: 5,
});

const provider = new ethers.providers.JsonRpcProvider(RPC_URL);
const facilitatorWallet = new ethers.Wallet(FACILITATOR_PRIVATE_KEY, provider);

const AEGIS_GUARD_ABI = [
  "function recordSpend(address _user, address _agent, uint256 _amount, bytes32 _txHash) external",
  "event SpendRecorded(address indexed user, address indexed agent, uint256 amount, bytes32 indexed txHash)"
];

const aegisGuardFacilitator = new ethers.Contract(CONTRACT_ADDRESS, AEGIS_GUARD_ABI, facilitatorWallet);

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

function pendingKey(user, agent) {
  return `pending:{user:${user.toLowerCase()}:agent:${agent.toLowerCase()}}`;
}
function processedFlagKey(pendingKeyStr, txHash) {
  return `${pendingKeyStr}:processed:${txHash}`;
}
function failedKey(pendingKeyStr) {
  return `failed:${pendingKeyStr}`;
}

// safe async sleep
function sleep(ms) {
  return new Promise((res) => setTimeout(res, ms));
}

async function iteratePendingKeys(pattern = "pending:*") {
  const keys = await scanKeys(redis, "pending:*", 1000);
  return keys;
}

let shuttingDown = false;

async function processPendingKey(key) {
  const parts = key.split(":");
  
  const match = key.match(/^pending:\{user:([^:}]+):agent:([^:}]+)\}$/i);
  if (!match) {
    console.warn("Unexpected pending key format, skipping:", key);
    return;
  }
  const user = match[1];
  const agent = match[2];

  for (let i = 0; i < ANCHOR_BATCH_SIZE; i++) {
    if (shuttingDown) return;

    const raw = await redis.rpop(key);
    if (!raw) break;

    let item;
    try {
      item = JSON.parse(raw);
    } catch (e) {
      console.warn("Malformed pending item; moving to failed queue:", raw);
      await redis.lpush(failedKey(key), raw);
      continue;
    }

    const { txHash, amountWei } = item;

    if (!txHash) {
      console.warn("Pending item missing txHash; moving to failed queue:", item);
      await redis.lpush(failedKey(key), raw);
      continue;
    }

    if (!ethers.utils.isHexString(txHash, 32)) {
      console.warn("Invalid txHash for recordSpend; moving to failed queue:", txHash);
      await redis.lpush(failedKey(key), raw);
      continue;
    }

    const procKey = processedFlagKey(key, txHash);
    const alreadyProcessed = await redis.get(procKey);
    if (alreadyProcessed) {
      continue;
    }

    try {
      console.log(`Anchoring spend: user=${user} agent=${agent} amount=${amountWei} txHash=${txHash}`);
      const tx = await aegisGuardFacilitator.recordSpend(user, agent, ethers.BigNumber.from(amountWei), txHash, {
      });
      console.log("recordSpend tx sent:", tx.hash);
      const receipt = await tx.wait(1);
      console.log("recordSpend confirmed:", receipt.transactionHash);
      await redis.set(procKey, String(Date.now()), "EX", 60 * 60 * 24 * 7);
    } catch (err) {
      console.error("recordSpend failed for item. Moving to failed queue. Error:", err && err.message ? err.message : err);
      await redis.lpush(failedKey(key), raw);
      break;
    }
  } // end batch loop
}

async function runRecordSpendJobOnce() {
  try {
    const keys = await iteratePendingKeys("pending:*");
    if (!keys.length) {
      // nothing to do
      return;
    }
    for (const key of keys) {
      if (shuttingDown) return;
      await processPendingKey(key);
      // small pause to avoid bursting
      await sleep(50);
    }
  } catch (err) {
    console.error("runRecordSpendJobOnce failed:", err && err.message ? err.message : err);
  }
}

async function mainLoop() {
  console.log("Anchor worker started. Epoch seconds:", ANCHOR_EPOCH_SECONDS, "Batch size:", ANCHOR_BATCH_SIZE);
  while (!shuttingDown) {
    const start = Date.now();
    await runRecordSpendJobOnce();
    const elapsed = Date.now() - start;
    // sleep remaining epoch time
    const waitFor = Math.max(1000, ANCHOR_EPOCH_SECONDS * 1000 - elapsed);
    await sleep(waitFor);
  }
}

// graceful shutdown
process.on("SIGINT", async () => {
  console.log("SIGINT received. Shutting down anchor worker...");
  shuttingDown = true;
});
process.on("SIGTERM", async () => {
  console.log("SIGTERM received. Shutting down anchor worker...");
  shuttingDown = true;
});

// start
(async () => {
  try {
    // ping redis & provider sanity
    await redis.ping();
    await provider.getBlockNumber(); // ensures RPC reachable
    console.log("Connected to Valkey and RPC provider. Starting anchor worker.");
    await mainLoop();
  } catch (err) {
    console.error("Anchor worker startup error:", err && err.message ? err.message : err);
    process.exit(1);
  } finally {
    try { await redis.quit(); } catch (_) {}
  }
})();
