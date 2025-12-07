import React, { useEffect, useState } from 'react';
import {
  Activity,
  Terminal,
  Wallet,
  Users,
  Zap,
  Power,
  AlertTriangle,
  RefreshCw,
  Unlock,
  Shield
} from "lucide-react";
import { ethers } from "ethers";
import { getContract, prepareContractCall } from "thirdweb";
import { useSendTransaction, useActiveAccount } from "thirdweb/react";
import { defineChain } from "thirdweb/chains";
import { createThirdwebClient } from "thirdweb";
import aegisAbi from "../utils/abi/aegisAbi.json";

// ---- ENV CONFIG (chain-agnostic) ----
const CLIENT_ID = import.meta.env.VITE_CLIENT_ID;
const RPC_URL = import.meta.env.VITE_RPC_URL;
const CHAIN_ID = Number(import.meta.env.VITE_CHAIN_ID || "84532");

if (!CLIENT_ID) console.warn("VITE_CLIENT_ID is not set");
if (!RPC_URL) console.warn("VITE_RPC_URL is not set");
if (!CHAIN_ID) console.warn("VITE_CHAIN_ID is not set");

// thirdweb client & chain
const client = createThirdwebClient({ clientId: CLIENT_ID });

const chain = defineChain({
  id: CHAIN_ID,
  rpc: RPC_URL ? [RPC_URL] : [],
  name: import.meta.env.VITE_CHAIN_NAME || "Configured Chain",
  nativeCurrency: {
    name: import.meta.env.VITE_NATIVE_CURRENCY_NAME || "Ether",
    symbol: import.meta.env.VITE_NATIVE_CURRENCY_SYMBOL || "ETH",
    decimals: 18,
  },
});

// AegisGuardV2 ABI
const AEGIS_ABI = aegisAbi;

export default function Dashboard({ data, logs, contractAddress }) {
  const account = useActiveAccount();
  const { mutate: sendTx, isPending } = useSendTransaction();
  
  // State for Agent Metadata
  const [agentStatuses, setAgentStatuses] = useState({});
  const [agentBalances, setAgentBalances] = useState({});
  const [agentLimits, setAgentLimits] = useState({}); // store dailyLimit (wei) for unfreeze
  const [isLoading, setIsLoading] = useState(false);

  // OPTIONAL: time until reset from AegisGuardV2.timeUntilReset
  const [resetTimers, setResetTimers] = useState({});

  // 1. Fetch On-Chain Policy + Balances
  const refreshAgentData = async () => {
    if (!data?.agents || !contractAddress || !account || !RPC_URL) return;
    setIsLoading(true);

    try {
      const provider = new ethers.JsonRpcProvider(RPC_URL);
      const contract = new ethers.Contract(contractAddress, AEGIS_ABI, provider);

      const newStatuses = {};
      const newBalances = {};
      const newLimits = {};
      const newTimers = {};

      for (const agent of data.agents) {
        // --- Policy from AegisGuardV2.getPolicy(user, agent) ---
        try {
          /**
           * getPolicy(address _user, address _agent) returns:
           * (uint256 dailyLimit, uint256 currentSpend, uint256 lastReset, bool isActive, bool exists)
           */
          const policy = await contract.getPolicy(account.address, agent.address);
          const [dailyLimit, currentSpend, lastReset, isActive, exists] = policy;

          if (exists) {
            newStatuses[agent.id] = isActive ? "ACTIVE" : "PAUSED"; // PAUSED = Kill Switch triggered
            newLimits[agent.id] = dailyLimit; // raw wei limit, used to reactivate via setPolicy
          } else {
            newStatuses[agent.id] = "UNREGISTERED";
          }
        } catch (e) {
          console.error("getPolicy failed for", agent.address, e);
          newStatuses[agent.id] = "UNKNOWN";
        }

        // --- timeUntilReset() (optional UI extra) ---
        try {
          const seconds = await contract.timeUntilReset(account.address, agent.address);
          newTimers[agent.id] = Number(seconds);
        } catch (e) {
          newTimers[agent.id] = 0;
        }

        // --- Agent wallet balance ---
        try {
          const bal = await provider.getBalance(agent.address);
          newBalances[agent.id] = ethers.formatEther(bal);
        } catch (e) {
          newBalances[agent.id] = "0.0";
        }
      }

      setAgentStatuses(newStatuses);
      setAgentBalances(newBalances);
      setAgentLimits(newLimits);
      setResetTimers(newTimers);
    } catch (e) {
      console.error("Sync Error", e);
    } finally {
      setIsLoading(false);
    }
  };

  useEffect(() => { refreshAgentData(); }, [data, contractAddress, account]);

  // 2. Kill Switch → AegisGuardV2.killSwitch(_agent)
  const handleKillSwitch = (agentAddress) => {
    if (!contractAddress) return alert("Contract address missing");
    if (!account) return alert("Connect your wallet first");

    try {
      const contract = getContract({
        client,
        chain,
        address: contractAddress,
        abi: AEGIS_ABI,
      });

      const transaction = prepareContractCall({
        contract,
        // match the Solidity: function killSwitch(address _agent)
        method: "function killSwitch(address _agent)",
        params: [agentAddress],
      });

      sendTx(transaction, {
        onSuccess: () => {
          alert("Kill Switch Activated: Agent access revoked.");
          setTimeout(refreshAgentData, 4000);
        },
        onError: (e) => {
          console.error("Kill switch failed:", e);
          alert("Failed: " + (e?.message || "Unknown error"));
        },
      });
    } catch (err) {
      console.error("Error preparing killSwitch tx:", err);
      alert("Failed to prepare transaction: " + (err?.message || "Unknown error"));
    }
  };

  // 3. Unfreeze → AegisGuardV2.setPolicy(_agent, _dailyLimit)
  //    Reuses the last known dailyLimit (wei) from on-chain policy.
  const handleUnfreeze = (agentId, agentAddress) => {
    if (!contractAddress) return alert("Contract address missing");
    if (!account) return alert("Connect your wallet first");

    const storedLimit = agentLimits[agentId];
    if (!storedLimit) {
      return alert("Cannot find original limit. Go to Agents tab or re-set a policy.");
    }

    try {
      const contract = getContract({
        client,
        chain,
        address: contractAddress,
        abi: AEGIS_ABI,
      });

      const transaction = prepareContractCall({
        contract,
        // Solidity: function setPolicy(address _agent, uint256 _dailyLimit)
        method: "function setPolicy(address _agent, uint256 _dailyLimit)",
        params: [agentAddress, storedLimit],
      });

      sendTx(transaction, {
        onSuccess: () => {
          alert("Agent Reactivated with existing daily limit ✅");
          setTimeout(refreshAgentData, 4000);
        },
        onError: (e) => {
          console.error("Unfreeze failed:", e);
          alert("Failed: " + (e?.message || "Unknown error"));
        },
      });
    } catch (err) {
      console.error("Error preparing setPolicy tx:", err);
      alert("Failed to prepare transaction: " + (err?.message || "Unknown error"));
    }
  };

  if (!data) return <div className="p-10 text-gray-500">Loading Aegis...</div>;

  const demoLimit = 5.0; 
  const totalUsagePercent = Math.min((data.currentSpend / demoLimit) * 100, 100);

  return (
    <div className="space-y-8 animate-fade-in pb-10">
      
      {/* HEADER */}
      <div className="flex justify-between items-center border-b border-gray-800 pb-6">
        <h1 className="text-3xl font-bold text-white flex items-center gap-3">
          <Shield className="text-emerald-500" /> AEGIS COMMAND CENTER
        </h1>
        <button
          onClick={refreshAgentData}
          className="flex items-center gap-2 bg-gray-900 border border-gray-700 text-gray-300 px-4 py-2 rounded-lg hover:border-emerald-500 transition-all"
        >
          <RefreshCw size={16} className={isLoading ? "animate-spin" : ""} /> Sync Network
        </button>
      </div>

      {/* METRICS ROW */}
      <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
        <div className="bg-gray-900/50 p-6 rounded-xl border border-gray-800 shadow-xl">
          <h3 className="text-gray-400 text-sm font-bold tracking-wider mb-2">SWARM SPEND</h3>
          <div className="text-3xl font-mono text-white font-bold">
            {data.currentSpend?.toFixed(4)} <span className="text-sm text-gray-600">ETH</span>
          </div>
          <div className="w-full bg-gray-800 h-2 mt-4 rounded-full overflow-hidden">
            <div
              className={`h-full ${totalUsagePercent > 80 ? "bg-red-500" : "bg-blue-500"}`}
              style={{ width: `${totalUsagePercent}%` }}
            />
          </div>
        </div>
        <div className="bg-gray-900/50 p-6 rounded-xl border border-gray-800 shadow-xl">
          <h3 className="text-gray-400 text-sm font-bold tracking-wider mb-2">ACTIVE NODES</h3>
          <div className="text-3xl font-mono text-white font-bold">{data.agents?.length || 0}</div>
        </div>
        <div className="bg-gray-900/50 p-6 rounded-xl border border-gray-800 shadow-xl">
          <h3 className="text-gray-400 text-sm font-bold tracking-wider mb-2">STATUS</h3>
          <div className="text-3xl font-mono font-bold text-emerald-500">OPERATIONAL</div>
        </div>
      </div>

      {/* AGENT CARDS */}
      <div>
        <h2 className="text-xl font-bold text-white mb-4 flex items-center gap-2">
          <Users className="text-blue-400" /> Agent Fleet
        </h2>

        <div className="flex flex-col gap-6">
          {data.agents?.map((agent) => {
            const agentLogs = logs.filter((l) => l.includes(agent.name));
            const status = agentStatuses[agent.id] || "SYNCING";
            const secondsToReset = resetTimers[agent.id] ?? 0;

            const resetLabel =
              secondsToReset === 0
                ? "Reset Ready"
                : `${Math.floor(secondsToReset / 3600)}h ${Math.floor(
                    (secondsToReset % 3600) / 60
                  )}m`;

            return (
              <div
                key={agent.id}
                className={`border rounded-xl bg-black transition-all duration-300 ${
                  status === "PAUSED"
                    ? "border-red-900 shadow-[0_0_15px_rgba(220,38,38,0.2)]"
                    : "border-gray-800"
                }`}
              >
                {/* Header */}
                <div
                  className={`p-5 border-b flex justify-between ${
                    status === "PAUSED"
                      ? "bg-red-950/20 border-red-900"
                      : "bg-gray-900/30 border-gray-800"
                  }`}
                >
                  <div>
                    <h3 className="font-bold text-white">{agent.name}</h3>
                    <div className="text-xs font-mono text-gray-400">{agent.address}</div>
                    <div className="text-[11px] text-gray-500 mt-1">
                      Window reset: {resetLabel}
                    </div>
                  </div>
                  <div
                    className={`px-2 py-1 rounded text-xs font-bold h-fit ${
                      status === "ACTIVE"
                        ? "bg-emerald-900/20 text-emerald-400"
                        : status === "PAUSED"
                        ? "bg-red-900/20 text-red-500"
                        : status === "UNREGISTERED"
                        ? "bg-gray-900/60 text-gray-400"
                        : "bg-gray-800 text-gray-500"
                    }`}
                  >
                    {status}
                  </div>
                </div>

                {/* Body */}
                <div className="p-5 grid grid-cols-1 gap-4">
                  {/* Controls */}
                  <div>
                    <div className="mb-4">
                      <span className="text-xs text-gray-500 font-bold block mb-1">
                        BALANCE
                      </span>
                      <span className="font-mono text-white">
                        {parseFloat(agentBalances[agent.id] || 0).toFixed(4)} ETH
                      </span>
                    </div>

                    {status === "ACTIVE" ? (
                      <button
                        onClick={() => handleKillSwitch(agent.address)}
                        disabled={isPending}
                        className="w-full bg-red-600 hover:bg-red-700 text-white py-2 rounded font-bold flex items-center justify-center gap-2 shadow-lg hover:shadow-red-500/20 transition-all active:scale-95"
                      >
                        <Power size={14} /> KILL SWITCH
                      </button>
                    ) : status === "PAUSED" ? (
                      <button
                        onClick={() => handleUnfreeze(agent.id, agent.address)}
                        disabled={isPending}
                        className="w-full bg-emerald-600 hover:bg-emerald-500 text-white py-2 rounded font-bold flex items-center justify-center gap-2 shadow-lg hover:shadow-emerald-500/20 transition-all active:scale-95 animate-pulse"
                      >
                        <Unlock size={14} /> UNFREEZE
                      </button>
                    ) : status === "UNREGISTERED" ? (
                      <div className="text-center text-gray-500 text-sm border border-dashed border-gray-700 p-2 rounded">
                        No On-Chain Policy (set from Agents tab)
                      </div>
                    ) : (
                      <div className="text-center text-gray-500 text-sm border border-dashed border-gray-700 p-2 rounded">
                        Syncing…
                      </div>
                    )}
                  </div>

                  {/* Feed */}
                  <div className="bg-black border border-gray-800 rounded p-3 h-[220px] overflow-auto custom-scrollbar">
                    <div className="text-xs text-gray-400 font-bold mb-2">
                      Transaction Feed
                    </div>
                    {agentLogs.length === 0 ? (
                      <div className="text-xs text-gray-700 text-center mt-8">
                        No Activity
                      </div>
                    ) : (
                      agentLogs.slice(0, 8).map((l, i) => (
                        <div
                          key={i}
                          className={`text-[11px] pl-1 mb-2 border-l-2 ${
                            l.includes("BLOCKED")
                              ? "text-red-400 border-red-500"
                              : "text-emerald-400 border-emerald-500"
                          }`}
                        >
                          {l.split("Attempting")[0]}{" "}
                          {l.includes("BLOCKED") ? " — BLOCKED" : " — SENT"}
                        </div>
                      ))
                    )}
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}
