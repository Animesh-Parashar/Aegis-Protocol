/**
 * Env required:
 *   REDIS_URL, RPC_URL, CONTRACT_ADDRESS, FACILITATOR_PRIVATE_KEY

 * Usage:
 *   export FACILITATOR_PRIVATE_KEY=0x...
 *   node scripts/anchorOnce.js
 */

require("dotenv").config();
const Redis = require("ioredis");
const { ethers } = require("ethers");

const REDIS_URL = process.env.REDIS_URL;
const RPC_URL = process.env.RPC_URL;
const CONTRACT_ADDRESS = process.env.CONTRACT_ADDRESS;
const FACILITATOR_PRIVATE_KEY = process.env.FACILITATOR_PRIVATE_KEY;

const ANCHOR_BATCH_SIZE = process.env.ANCHOR_BATCH_SIZE ? Number(process.env.ANCHOR_BATCH_SIZE) : 20;

if (!REDIS_URL || !RPC_URL || !CONTRACT_ADDRESS || !FACILITATOR_PRIVATE_KEY) {
  console.error("Missing env. Ensure REDIS_URL, RPC_URL, CONTRACT_ADDRESS, FACILITATOR_PRIVATE_KEY are set.");
  process.exit(1);
}

const redis = new Redis(REDIS_URL, { connectTimeout: 10000, maxRetriesPerRequest: 5 });
const provider = new ethers.providers.JsonRpcProvider(RPC_URL);
const facilitatorWallet = new ethers.Wallet(FACILITATOR_PRIVATE_KEY, provider);

const AEGIS_GUARD_ABI = [
  "function recordSpend(address _user, address _agent, uint256 _amount, bytes32 _txHash) external",
  "event SpendRecorded(address indexed user, address indexed agent, uint256 amount, bytes32 indexed txHash)"
];
const aegisGuardFacilitator = new ethers.Contract(CONTRACT_ADDRESS, AEGIS_GUARD_ABI, facilitatorWallet);

function pendingKey(user, agent) {
  return `pending:{user:${user.toLowerCase()}:agent:${agent.toLowerCase()}}`;
}

async function scanKeys(pattern = "pending:*", limit = 1000) {
  const keys = [];
  let cursor = "0";
  do {
    const res = await redis.scan(cursor, "MATCH", pattern, "COUNT", 200);
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

(async () => {
  try {
    await redis.ping();
    console.log("Connected to Valkey.");

    const keys = await scanKeys("pending:*", 100);
    if (!keys.length) {
      console.log("No pending keys found. Nothing to anchor.");
      process.exit(0);
    }

    // Process first key only (keeps demo short)
    const key = keys[0];
    console.log("Anchoring pending key:", key);

    // parse user/agent
    const m = key.match(/^pending:\{user:([^:}]+):agent:([^:}]+)\}$/i);
    if (!m) {
      console.error("Unexpected pending key format:", key);
      process.exit(2);
    }
    const user = m[1];
    const agent = m[2];

    for (let i = 0; i < ANCHOR_BATCH_SIZE; i++) {
      const raw = await redis.rpop(key);
      if (!raw) {
        console.log("No more items in this queue.");
        break;
      }
      let item;
      try { item = JSON.parse(raw); } catch (e) {
        console.warn("Malformed item moved to failed queue:", raw);
        await redis.lpush(`failed:${key}`, raw);
        continue;
      }

      const { txHash, amountWei } = item;
      if (!txHash || !ethers.utils.isHexString(txHash, 32)) {
        console.warn("Bad txHash, moving to failed queue:", txHash);
        await redis.lpush(`failed:${key}`, raw);
        continue;
      }

      const procKey = `${key}:processed:${txHash}`;
      const already = await redis.get(procKey);
      if (already) {
        console.log("Already processed:", txHash);
        continue;
      }

      console.log(`Submitting recordSpend(user=${user}, agent=${agent}, amount=${amountWei}, txHash=${txHash})`);
      try {
        const tx = await aegisGuardFacilitator.recordSpend(user, agent, ethers.BigNumber.from(amountWei), txHash);
        console.log("recordSpend tx sent:", tx.hash);
        await tx.wait(1);
        console.log("recordSpend confirmed:", tx.hash);
        await redis.set(procKey, String(Date.now()), "EX", 60 * 60 * 24 * 7);
        // For demo, stop after one successful anchor to save time and gas
        break;
      } catch (err) {
        console.error("recordSpend failed (moved to failed queue):", err && err.message ? err.message : err);
        await redis.lpush(`failed:${key}`, raw);
        break;
      }
    }

    console.log("Anchor run complete.");
    process.exit(0);
  } catch (err) {
    console.error("AnchorOnce failed:", err && err.message ? err.message : err);
    process.exit(3);
  } finally {
    try { await redis.quit(); } catch (_) {}
  }
})();
