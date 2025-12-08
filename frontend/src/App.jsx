import React, { useState, useEffect, useRef } from "react";
import {
  BrowserRouter as Router,
  Routes,
  Route,
  Link,
  useLocation,
} from "react-router-dom";
import { createThirdwebClient } from "thirdweb";
import { defineChain } from "thirdweb/chains";
import { ConnectButton, useActiveAccount } from "thirdweb/react";
import { createWallet } from "thirdweb/wallets";
import axios from "axios";
import { ethers } from "ethers"; // ✅ needed for parseEther helper
import {
  Shield,
  LayoutDashboard,
  Settings,
  Users,
  Play,
  Square,
} from "lucide-react";
import Dashboard from "./pages/Dashboard";
import Policies from "./pages/Policies";
import Agents from "./pages/Agents";

const CLIENT_ID = import.meta.env.VITE_CLIENT_ID;
const BASE_API_URL =import.meta.env.VITE_API_BASE_URL || "http://localhost:3001";

// Default to Avalanche Fuji (43113). Override via VITE_CHAIN_ID if needed.
const CHAIN_ID = parseInt(import.meta.env.VITE_CHAIN_ID || "43113", 10);

// Put your Avalanche contract here or via env
const CONTRACT_ADDRESS =
  import.meta.env.VITE_CONTRACT_ADDRESS ||
  "0x02A9E1D01773AfB8754D5cb5dd850ae1158f5117";

const client = createThirdwebClient({ clientId: CLIENT_ID });
const chain = defineChain(CHAIN_ID);
const wallets = [createWallet("io.metamask")];

const API_URL = `${BASE_API_URL}/api`;

// ✅ Helper: AVAX decimal string -> wei string (works for ethers v5 or v6)
const toWeiString = (value) => {
  const v = value.toString();
  try {
    // ethers v5 style
    if (ethers?.utils?.parseEther) {
      return ethers.utils.parseEther(v).toString();
    }
    // ethers v6 style
    if (ethers?.parseEther) {
      return ethers.parseEther(v).toString();
    }
  } catch (e) {
    console.error("toWeiString parse error:", e);
  }
  throw new Error("No compatible parseEther found in ethers or invalid value");
};

// Sidebar Component
const SidebarLink = ({ to, icon: Icon, label }) => {
  const location = useLocation();
  const isActive = location.pathname === to;
  return (
    <Link
      to={to}
      className={`flex items-center gap-3 px-4 py-3 rounded-lg mb-2 transition-all ${
        isActive
          ? "bg-emerald-900/50 text-emerald-400 border border-emerald-500/30"
          : "text-gray-400 hover:bg-gray-900"
      }`}
    >
      <Icon size={20} />
      <span className="font-bold">{label}</span>
    </Link>
  );
};

export default function App() {
  const account = useActiveAccount();
  const [data, setData] = useState(null);
  const [logs, setLogs] = useState([]);

  // SIMULATION STATE
  const [isSimulating, setIsSimulating] = useState(false);

  // Refs to avoid stale closures inside the async loop
  const isSimulatingRef = useRef(isSimulating);
  const latestDataRef = useRef(data);
  const simulatorAbortRef = useRef({ aborted: false }); // simple cancel flag

  // Utility: add to logs (keeps newest on top)
  const addLog = (msg) =>
    setLogs((prev) => [`[${new Date().toLocaleTimeString()}] ${msg}`, ...prev]);

  // 1. Fetch Backend State (Polls every 2 seconds)
  const fetchStatus = async () => {
    try {
      const res = await axios.get(`${API_URL}/config`);
      setData(res.data);
      latestDataRef.current = res.data;
    } catch (e) {
      console.error("Backend offline / fetchStatus failed:", e?.message || e);
      // keep existing data; don't clear it
    }
  };

  useEffect(() => {
    // initial fetch and start polling
    fetchStatus();
    const interval = setInterval(fetchStatus, 2000);
    return () => clearInterval(interval);
  }, []);

  // Keep refs in sync with state
  useEffect(() => {
    isSimulatingRef.current = isSimulating;
  }, [isSimulating]);

  useEffect(() => {
    latestDataRef.current = data;
  }, [data]);

  // Helper sleep
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

  // Robust simulator loop (async while) — avoids setInterval closure bugs
  useEffect(() => {
    // start/stop handled by isSimulatingRef and simulatorAbortRef
    let running = false;

    const runSimulator = async () => {
      if (running) return;
      running = true;
      simulatorAbortRef.current.aborted = false;
      addLog(
        `🚦 Simulator ${
          isSimulatingRef.current ? "started" : "requested start"
        }`
      );

      // If we don't have agents yet, do an immediate fetch and wait a bit
      if (
        !latestDataRef.current ||
        !latestDataRef.current.agents ||
        latestDataRef.current.agents.length === 0
      ) {
        addLog("🔎 Waiting for agents to appear...");
        await fetchStatus();
        await sleep(800); // short pause to allow backend to respond
      }

      while (isSimulatingRef.current && !simulatorAbortRef.current.aborted) {
        const latest = latestDataRef.current;

        if (!latest || !Array.isArray(latest.agents) || latest.agents.length === 0) {
          // Nothing to simulate yet — wait and try again
          addLog("⏳ No agents available yet — retrying...");
          await sleep(1500);
          await fetchStatus().catch(() => {});
          await sleep(1500);
          continue;
        }

        // Pick a random agent
        const randomIndex = Math.floor(Math.random() * latest.agents.length);
        const randomAgent = latest.agents[randomIndex];

        // 70% Legit, 30% Scam/Hack
        const isLegit = Math.random() > 0.3;

        // Generate AVAX amounts as decimal strings for logging + convert to wei for payload
        const legitAmountAvax = (Math.random() * 0.0001).toFixed(6); // tiny AVAX
        const scamAmountAvax = (Math.random() * 5).toFixed(4); // larger "hack" amount

        const displayAmount = isLegit ? legitAmountAvax : scamAmountAvax;

        // ✅ Convert AVAX -> wei string for backend
        let amountWei;
        try {
          amountWei = toWeiString(displayAmount);
        } catch (err) {
          console.error("Failed to convert amount to wei:", err);
          addLog(`⚠️ Amount conversion failed for ${displayAmount} AVAX`);
          // skip this iteration if conversion failed
          await sleep(1000);
          continue;
        }

        const payload = {
          agentAddress: randomAgent.address,
          to: isLegit
            ? "0xcf942c47bc33dB4Fabc1696666058b784F9fa9ef"
            : "0xScamAddress" + Math.floor(Math.random() * 999), // intentionally bad for attack cases
          amount: amountWei, // ✅ backend expects wei string
        };

        const attemptMsg = `${randomAgent.name}: Requesting ${displayAmount} AVAX -> ${payload.to}`;
        addLog(`${attemptMsg} — SENT`);
        console.debug("[sim] POST", `${API_URL}/rpc/execute`, payload);

        try {
          const res = await axios.post(`${API_URL}/rpc/execute`, payload, {
            timeout: 10000,
          });

          const { approved, code, reason, settlement } = res.data || {};
          const txHash =
            settlement?.txHash ??
            res.data?.txHash ??
            res.data?.hash ??
            null;
          const explorerUrl = settlement?.explorerUrl || null;

          if (!approved) {
            // 🔴 Policy-blocked but HTTP 200
            const msg = `🛑 BLOCKED (Policy): ${randomAgent.name} -> ${
              code || "BLOCKED"
            } | ${reason || "Unknown reason"}`;
            addLog(msg);
            console.info("[sim] policy block", res.data);
          } else {
            // ✅ Actually approved on-chain
            let baseMsg = `✅ SUCCESS: ${randomAgent.name} Approved. ${
              txHash ? `Hash: ${String(txHash).slice(0, 10)}...` : "(no-hash)"
            } — SENT`;

            // Append explorer link if available
            if (explorerUrl) {
              baseMsg += ` | Explorer: ${explorerUrl}`;
            }

            addLog(baseMsg);

            if (explorerUrl) {
              console.info("[sim] explorer URL:", explorerUrl);
            }
            console.info("[sim] success", res.data);
          }

          // Immediately refresh backend state after a tx so simulator sees updated spend/limits
          await fetchStatus().catch(() => {});
        } catch (err) {
          const errorMsg =
            err.response?.data?.error || err.message || "Unknown Error";
          addLog(
            `🛑 BLOCKED (Network/Error): ${randomAgent.name} -> ${errorMsg}`
          );
          console.warn("[sim] blocked/error", errorMsg, err);
          await fetchStatus().catch(() => {});
        }

        // Respect the configured cadence
        for (let waited = 0; waited < 3500; waited += 500) {
          if (!isSimulatingRef.current || simulatorAbortRef.current.aborted) break;
          await sleep(500);
        }
      } // end while

      addLog(`🛑 Simulator stopped`);
      running = false;
    }; // runSimulator

    if (isSimulating) {
      runSimulator().catch((err) => {
        console.error("Simulator encountered an error:", err);
        addLog("⚠️ Simulator error — check console");
      });
    } else {
      simulatorAbortRef.current.aborted = true;
    }

    return () => {
      simulatorAbortRef.current.aborted = true;
      isSimulatingRef.current = false;
    };
  }, [isSimulating]); // only depends on the flag; uses refs for latest data

  // UI
  return (
    <Router>
      <div className="flex min-h-screen bg-black text-white font-mono">
        {/* SIDEBAR */}
        <div className="w-64 border-r border-gray-800 p-6 flex flex-col z-10 bg-black fixed h-full">
          <div className="flex items-center gap-2 mb-10 text-emerald-500">
            <Shield size={28} />
            <h1 className="text-xl font-bold tracking-wider">AEGIS Protocol</h1>
          </div>

          <nav className="flex-1 space-y-2">
            <SidebarLink to="/" icon={LayoutDashboard} label="Overview" />
            <SidebarLink to="/policies" icon={Settings} label="Policies" />
            <SidebarLink to="/agents" icon={Users} label="Whitelist" />
          </nav>

          <div className="mt-auto space-y-6">
            {/* SIMULATION TOGGLE */}
            <div className="p-4 rounded-xl bg-gray-900 border border-gray-800">
              <div className="flex justify-between items-center mb-2">
                <h3 className="text-xs text-gray-500 font-bold uppercase">
                  Traffic Sim
                </h3>
                {isSimulating && (
                  <span className="h-2 w-2 rounded-full bg-orange-500 animate-pulse" />
                )}
              </div>

              <button
                onClick={() => {
                  setIsSimulating((prev) => {
                    const next = !prev;
                    isSimulatingRef.current = next;
                    if (!next) simulatorAbortRef.current.aborted = true;
                    return next;
                  });

                  // do an immediate fetch when starting so simulator has data
                  if (!isSimulatingRef.current) {
                    fetchStatus().catch(() => {});
                  }
                }}
                className={`w-full py-2 rounded font-bold flex items-center justify-center gap-2 transition-all text-sm ${
                  isSimulating
                    ? "bg-orange-500/20 text-orange-500 border border-orange-500 shadow-[0_0_10px_rgba(249,115,22,0.3)]"
                    : "bg-gray-800 text-gray-400 hover:bg-gray-700"
                }`}
              >
                {isSimulating ? (
                  <>
                    <Square size={12} /> STOP
                  </>
                ) : (
                  <>
                    <Play size={12} /> START
                  </>
                )}
              </button>
              {isSimulating && (
                <div className="text-[10px] text-gray-500 mt-2 text-center">
                  Randomizing Traffic...
                </div>
              )}
            </div>

            <ConnectButton
              client={client}
              chain={chain}
              wallets={wallets}
              theme="dark"
              connectModal={{ size: "compact" }}
            />
          </div>
        </div>

        {/* MAIN CONTENT AREA */}
        <div className="flex-1 ml-64 p-8 bg-black min-h-screen">
          {!account ? (
            <div className="h-[80vh] flex flex-col items-center justify-center text-gray-500 gap-6">
              <Shield size={80} className="opacity-10 animate-pulse" />
              <div className="text-center">
                <h2 className="text-2xl font-bold text-gray-400 mb-2">
                  Security Clearance Required
                </h2>
                <p>Connect Admin Wallet to Access Mainframe</p>
              </div>
            </div>
          ) : (
            <Routes>
              <Route
                path="/"
                element={
                  <Dashboard
                    contractAddress={CONTRACT_ADDRESS}
                    data={data}
                    logs={logs}
                  />
                }
              />
              <Route
                path="/policies"
                element={<Policies contractAddress={CONTRACT_ADDRESS} />}
              />
              <Route
                path="/agents"
                element={<Agents contractAddress={CONTRACT_ADDRESS} />}
              />
            </Routes>
          )}
        </div>
      </div>
    </Router>
  );
}
