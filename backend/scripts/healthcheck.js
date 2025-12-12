/**
 * scripts/healthcheck.js (patched)
 *
 * - Scans pending queues (non-blocking SCAN).
 * - For each pending key, only performs LRANGE if the key is a Redis list (prevents WRONGTYPE).
 * - Shows a small preview for string keys (processed markers).
 *
 * Usage:
 *   node scripts/healthcheck.js
 *
 * Env required:
 *   REDIS_URL, RPC_URL, CONTRACT_ADDRESS
 */

require("dotenv").config();
const Redis = require("ioredis");
const { ethers } = require("ethers");
const { ThirdwebSDK } = require("@thirdweb-dev/sdk");

const REDIS_URL = process.env.REDIS_URL;
const RPC_URL = process.env.RPC_URL;
const CONTRACT_ADDRESS = process.env.CONTRACT_ADDRESS;
const ADMIN_WALLET = process.env.ADMIN_WALLET_ADDRESS;

if (!REDIS_URL || !RPC_URL || !CONTRACT_ADDRESS) {
  console.error("Missing required env: REDIS_URL, RPC_URL, CONTRACT_ADDRESS");
  process.exit(1);
}

const redis = new Redis(REDIS_URL, { connectTimeout: 10000, maxRetriesPerRequest: 5 });
const provider = new ethers.providers.JsonRpcProvider(RPC_URL);
const aegisGuard = new ethers.Contract(CONTRACT_ADDRESS, [
  "function getPolicy(address _user, address _agent) view returns (uint256,uint256,uint256,bool,bool)"
], provider);

// optional: use thirdweb SDK to get server agent address if available
let sdk;
try {
  sdk = ThirdwebSDK.fromPrivateKey(process.env.AGENT_PRIVATE_KEY || "", process.env.CHAIN || "avalanche-fuji", {
    secretKey: process.env.THIRDWEB_SECRET_KEY || ""
  });
} catch (_) {
  sdk = null;
}

// robust SCAN helper (works with any ioredis)
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

(async () => {
  try {
    console.log("Checking Valkey (Redis) connectivity...");
    const pong = await redis.ping();
    console.log("Redis PING:", pong);

    console.log("Scanning pending queues (up to 50 keys)...");
    const keys = await scanKeys(redis, "pending:*", 50);

    if (keys.length === 0) {
      console.log("No pending queues found. Falling back to admin/serverAgent policy check (if available).");

      // If ADMIN_WALLET present, try a fallback policy check with serverAgent
      if (ADMIN_WALLET) {
        let serverAgent = null;
        if (sdk) {
          try {
            serverAgent = await sdk.wallet.getAddress();
          } catch (_) {
            serverAgent = null;
          }
        }
        // fallback to ADMIN_WALLET as agent if serverAgent not available
        serverAgent = serverAgent || ADMIN_WALLET;
        console.log(`Fallback getPolicy check: user=${ADMIN_WALLET}, agent=${serverAgent}`);
        try {
          const res = await aegisGuard.getPolicy(ADMIN_WALLET, serverAgent);
          console.log("getPolicy OK. Raw:", {
            dailyLimit: res[0].toString(),
            currentSpend: res[1].toString(),
            lastReset: res[2].toString(),
            isActive: res[3],
            exists: res[4],
          });
        } catch (err) {
          console.warn("Fallback getPolicy call failed (this can be normal):", err && err.message ? err.message : err);
        }
      } else {
        console.log("No ADMIN_WALLET configured; skipping fallback contract check.");
      }
    } else {
      console.log(`Found ${keys.length} pending keys. Inspecting up to 10 sample keys...`);
      const sample = keys.slice(0, 10);
      for (const key of sample) {
        console.log("\n=> Pending Key:", key);

        // only call LRANGE on Redis lists to avoid WRONGTYPE
        const ktype = await redis.type(key);
        if (ktype !== "list") {
          console.log(`  Skipping key (not a list): ${key} (type=${ktype})`);
          if (ktype === "string") {
            try {
              const val = await redis.get(key);
              const preview = val && val.length > 200 ? val.slice(0, 200) + "..." : val;
              console.log("    string preview:", preview);
            } catch (_) { /* ignore preview errors */ }
          }
          continue;
        }

        const items = await redis.lrange(key, 0, -1);
        console.log("  Items in queue:", items.length);
        for (let j = 0; j < Math.min(items.length, 5); j++) {
          try {
            const parsed = JSON.parse(items[j]);
            console.log(`   [${j}] txHash: ${parsed.txHash}, amountWei: ${parsed.amountWei}, ts: ${new Date(parsed.timestamp).toISOString()}`);
          } catch (e) {
            console.log(`   [${j}] malformed:`, items[j]);
          }
        }

        // parse user & agent from key format: pending:{user:<user>:agent:<agent>}
        const match = key.match(/^pending:\{user:([^:}]+):agent:([^:}]+)\}$/i);
        if (!match) {
          console.log("  Could not parse user/agent from key. Skipping contract query.");
          continue;
        }
        const user = match[1];
        const agent = match[2];
        console.log("  Parsed user:", user);
        console.log("  Parsed agent:", agent);

        // call getPolicy for this user/agent
        try {
          const p = await aegisGuard.getPolicy(user, agent);
          console.log("  getPolicy raw:", {
            dailyLimit: p[0].toString(),
            currentSpend: p[1].toString(),
            lastReset: p[2].toString(),
            isActive: p[3],
            exists: p[4],
          });
          console.log(`  interpreted: dailyLimit=${Number(ethers.utils.formatEther(p[0]))} AVAX, currentSpend=${Number(ethers.utils.formatEther(p[1]))} AVAX, active=${p[3]}, exists=${p[4]}`);
        } catch (err) {
          console.error("  getPolicy call failed for this user/agent:", err && err.message ? err.message : err);
        }
      }
    }

    // Total pending items summary (only count lists)
    let pendingTotal = 0;
    const allKeys = await scanKeys(redis, "pending:*", 1000);
    for (const k of allKeys) {
      const t = await redis.type(k);
      if (t !== "list") continue;
      const len = await redis.llen(k);
      pendingTotal += len;
    }
    console.log("Total pending items:", pendingTotal);

    console.log("Healthcheck OK.");
    process.exit(0);
  } catch (err) {
    console.error("Healthcheck failed:", err && err.message ? err.message : err);
    process.exit(2);
  } finally {
    try { await redis.quit(); } catch (_) {}
  }
})();
