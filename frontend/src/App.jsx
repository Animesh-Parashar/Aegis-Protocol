import React, { useState, useEffect, useRef } from "react";
import { BrowserRouter as Router, Routes, Route, Link, useLocation } from "react-router-dom";
import { createThirdwebClient } from "thirdweb";
import { defineChain } from "thirdweb/chains";
import { ConnectButton, useActiveAccount } from "thirdweb/react";
import { createWallet } from "thirdweb/wallets";
import axios from "axios";
import { Shield, LayoutDashboard, Settings, Users, Play, Square } from "lucide-react";

// PAGES
import Dashboard from "./pages/Dashboard";
import Policies from "./pages/Policies";
import Agents from "./pages/Agents";

// --- CONFIGURATION ---
// 1. Get this from Thirdweb Dashboard
const CLIENT_ID = import.meta.env.VITE_CLIENT_ID || "YOUR_CLIENT_ID_HERE"; 

// 2. Your Deployed Contract Address (From your deployment)
const CONTRACT_ADDRESS = import.meta.env.VITE_CONTRACT_ADDRESS || "0xYourDeployedContractAddress"; 

const client = createThirdwebClient({ clientId: CLIENT_ID });
const chain = defineChain(84532); // Base Sepolia
const wallets = [ createWallet("io.metamask") ];
const API_URL = "http://localhost:3001/api";

// Sidebar Component
const SidebarLink = ({ to, icon: Icon, label }) => {
    const location = useLocation();
    const isActive = location.pathname === to;
    return (
        <Link to={to} className={`flex items-center gap-3 px-4 py-3 rounded-lg mb-2 transition-all ${isActive ? 'bg-emerald-900/50 text-emerald-400 border border-emerald-500/30' : 'text-gray-400 hover:bg-gray-900'}`}>
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
  const addLog = (msg) => setLogs(prev => [`[${new Date().toLocaleTimeString()}] ${msg}`, ...prev]);

  // 1. Fetch Backend State (Polls every 2 seconds)
  const fetchStatus = async () => {
    try {
      const res = await axios.get(`${API_URL}/config`);
      setData(res.data);
      latestDataRef.current = res.data;
      // console.debug('fetched backend status', res.data);
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
  useEffect(() => { isSimulatingRef.current = isSimulating; }, [isSimulating]);
  useEffect(() => { latestDataRef.current = data; }, [data]);

  // Helper sleep
  const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

  // Robust simulator loop (async while) — avoids setInterval closure bugs
  useEffect(() => {
    // start/stop handled by isSimulatingRef and simulatorAbortRef
    let running = false;

    const runSimulator = async () => {
      if (running) return;
      running = true;
      simulatorAbortRef.current.aborted = false;
      addLog(`🚦 Simulator ${isSimulatingRef.current ? "started" : "requested start"}`);

      // If we don't have agents yet, do an immediate fetch and wait a bit
      if (!latestDataRef.current || !latestDataRef.current.agents || latestDataRef.current.agents.length === 0) {
        addLog("🔎 Waiting for agents to appear...");
        await fetchStatus();
        await sleep(800); // short pause to allow backend to respond
      }

      while (isSimulatingRef.current && !simulatorAbortRef.current.aborted) {
        const latest = latestDataRef.current;

        if (!latest || !Array.isArray(latest.agents) || latest.agents.length === 0) {
          // Nothing to simulate yet — wait and try again
          // log once every few iterations to avoid spam
          addLog("⏳ No agents available yet — retrying...");
          await sleep(1500);
          // try fetchStatus to refresh
          await fetchStatus().catch(()=>{});
          await sleep(1500);
          continue;
        }

        // Pick a random agent
        const randomIndex = Math.floor(Math.random() * latest.agents.length);
        const randomAgent = latest.agents[randomIndex];

        // 70% Legit, 30% Scam/Hack
        const isLegit = Math.random() > 0.3;

        const payload = {
          agentAddress: randomAgent.address,
          to: isLegit ? "0xa0Ee7A142d267C1f36714E4a8F75612F20a79720" : ("0xScamAddress" + Math.floor(Math.random()*999)),
          amount: isLegit ? (Math.random() * 0.0001).toFixed(6) : (Math.random() * 5).toFixed(2)
        };

        // Add UI log and console trace so you can see attempts in browser console & backend console
        const attemptMsg = `${randomAgent.name}: Requesting ${payload.amount} ETH -> ${payload.to}`;
        addLog(attemptMsg);
        console.debug("[sim] POST", `${API_URL}/rpc/execute`, payload);

        try {
          const res = await axios.post(`${API_URL}/rpc/execute`, payload, { timeout: 10000 });
          const txHash = res.data?.txHash ?? res.data?.hash ?? null;
          addLog(`✅ SUCCESS: ${randomAgent.name} Approved. ${txHash ? `Hash: ${String(txHash).slice(0,10)}...` : "(no-hash)"}`);
          console.info("[sim] success", res.data);
          // Immediately refresh backend state after a successful tx so simulator sees updated spend/limits
          await fetchStatus().catch(()=>{});
        } catch (err) {
          const errorMsg = err.response?.data?.error || err.message || "Unknown Error";
          addLog(`🛑 BLOCKED: ${randomAgent.name} -> ${errorMsg}`);
          console.warn("[sim] blocked/error", errorMsg, err);
          // Try refreshing backend state when blocked (policy might have changed)
          await fetchStatus().catch(()=>{});
        }

        // Respect the configured cadence
        // If aborted while sleeping, break early
        for (let waited = 0; waited < 3500; waited += 500) {
          if (!isSimulatingRef.current || simulatorAbortRef.current.aborted) break;
          await sleep(500);
        }
      } // end while

      addLog(`🛑 Simulator stopped`);
      running = false;
    }; // runSimulator

    if (isSimulating) {
      runSimulator().catch(err => {
        console.error("Simulator encountered an error:", err);
        addLog("⚠️ Simulator error — check console");
      });
    } else {
      // If simulation was turned off, signal abort
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
                        <h3 className="text-xs text-gray-500 font-bold uppercase">Traffic Sim</h3>
                        {isSimulating && <span className="h-2 w-2 rounded-full bg-orange-500 animate-pulse"/>}
                    </div>
                    
                    <button 
                        onClick={() => {
                          // Toggle state and keep ref in sync
                          setIsSimulating(prev => {
                            const next = !prev;
                            isSimulatingRef.current = next;
                            if (!next) simulatorAbortRef.current.aborted = true;
                            return next;
                          });
                          // do an immediate fetch when starting so simulator has data
                          if (!isSimulatingRef.current) {
                            fetchStatus().catch(()=>{});
                          }
                        }}
                        className={`w-full py-2 rounded font-bold flex items-center justify-center gap-2 transition-all text-sm ${isSimulating ? 'bg-orange-500/20 text-orange-500 border border-orange-500 shadow-[0_0_10px_rgba(249,115,22,0.3)]' : 'bg-gray-800 text-gray-400 hover:bg-gray-700'}`}
                    >
                        {isSimulating ? <><Square size={12}/> STOP</> : <><Play size={12}/> START</>}
                    </button>
                    {isSimulating && <div className="text-[10px] text-gray-500 mt-2 text-center">Randomizing Traffic...</div>}
                </div>

                <ConnectButton client={client} chain={chain} wallets={wallets} theme="dark" connectModal={{ size: "compact" }} />
            </div>
        </div>

        {/* MAIN CONTENT AREA */}
        <div className="flex-1 ml-64 p-8 bg-black min-h-screen">
            {!account ? (
                 <div className="h-[80vh] flex flex-col items-center justify-center text-gray-500 gap-6">
                    <Shield size={80} className="opacity-10 animate-pulse"/>
                    <div className="text-center">
                        <h2 className="text-2xl font-bold text-gray-400 mb-2">Security Clearance Required</h2>
                        <p>Connect Admin Wallet to Access Mainframe</p>
                    </div>
                 </div>
            ) : (
                <Routes>
                    <Route path="/" element={<Dashboard contractAddress={CONTRACT_ADDRESS} data={data} logs={logs} />} />
                    <Route path="/policies" element={<Policies contractAddress={CONTRACT_ADDRESS} />} />
                    <Route path="/agents" element={<Agents contractAddress={CONTRACT_ADDRESS} />} />
                </Routes>
            )}
        </div>

      </div>
    </Router>
  );
}
