import React, { useEffect, useState } from 'react';
import { Activity, Terminal, Wallet, Users, Zap, Power, AlertTriangle, RefreshCw, Unlock, Shield } from "lucide-react";
import { ethers } from "ethers";
import { getContract, prepareContractCall } from "thirdweb";
import { useSendTransaction, useActiveAccount } from "thirdweb/react";
import { defineChain } from "thirdweb/chains";
import { createThirdwebClient } from "thirdweb";
import aegisAbi from "../utils/abi/aegisAbi.json"

const CLIENT_ID = import.meta.env.VITE_CLIENT_ID; 
const client = createThirdwebClient({ clientId: CLIENT_ID });
const chain = defineChain(84532);

// INLINED ABI to fix file resolution error
const AEGIS_ABI = aegisAbi;

export default function Dashboard({ data, logs, contractAddress }) {
  const account = useActiveAccount();
  const { mutate: sendTx, isPending } = useSendTransaction();
  
  // State for Agent Metadata
  const [agentStatuses, setAgentStatuses] = useState({});
  const [agentBalances, setAgentBalances] = useState({});
  const [agentLimits, setAgentLimits] = useState({}); // Store limits to restore them on Unfreeze
  const [isLoading, setIsLoading] = useState(false);

  // 1. Fetch Chain Data
  const refreshAgentData = async () => {
    if (!data?.agents || !contractAddress || !account) return;
    setIsLoading(true);

    try {
      const provider = new ethers.JsonRpcProvider("https://sepolia.base.org");
      const contract = new ethers.Contract(contractAddress, AEGIS_ABI, provider);

      const newStatuses = {};
      const newBalances = {};
      const newLimits = {};

      for (const agent of data.agents) {
        try {
          // getPolicy returns: [dailyLimit, currentSpend, lastReset, isActive, exists]
          const policy = await contract.getPolicy(account.address, agent.address);
          
          newStatuses[agent.id] = policy[4] ? (policy[3] ? "ACTIVE" : "PAUSED") : "UNREGISTERED";
          newLimits[agent.id] = policy[0]; // Store the raw Wei limit
        } catch (e) {
          newStatuses[agent.id] = "UNKNOWN";
        }

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
    } catch (e) {
      console.error("Sync Error", e);
    } finally {
      setIsLoading(false);
    }
  };

  useEffect(() => { refreshAgentData(); }, [data, contractAddress, account]);

  // 2. Kill Switch (Sets isActive = false)
  const handleKillSwitch = (agentAddress) => {
    if (!contractAddress) return alert("Contract missing");
    const contract = getContract({ client, chain, address: contractAddress, abi: AEGIS_ABI });
    const transaction = prepareContractCall({
      contract,
      method: "killSwitch",
      params: [agentAddress], 
    });
    sendTx(transaction, {
      onSuccess: () => { alert("Kill Switch Active"); setTimeout(refreshAgentData, 3000); },
      onError: (e) => alert("Failed: " + e.message)
    });
  };

  // 3. Unfreeze (Calls setPolicy with existing limit to set isActive = true)
  const handleUnfreeze = (agentId, agentAddress) => {
    if (!contractAddress) return alert("Contract missing");
    
    const storedLimit = agentLimits[agentId];
    if (!storedLimit) return alert("Cannot find original limit. Go to Agents tab to reset.");

    const contract = getContract({ client, chain, address: contractAddress, abi: AEGIS_ABI });
    const transaction = prepareContractCall({
      contract,
      method: "setPolicy",
      params: [agentAddress, storedLimit], // Re-apply the same limit
    });

    sendTx(transaction, {
      onSuccess: () => { 
          alert("Agent Reactivated! 🟢"); 
          setTimeout(refreshAgentData, 4000); 
      },
      onError: (e) => alert("Failed: " + e.message)
    });
  };

  if (!data) return <div className="p-10 text-gray-500">Loading Aegis...</div>;

  const demoLimit = 5.0; 
  const totalUsagePercent = Math.min((data.currentSpend / demoLimit) * 100, 100);

  return (
    <div className="space-y-8 animate-fade-in pb-10">
      
      {/* HEADER */}
      <div className="flex justify-between items-center border-b border-gray-800 pb-6">
        <h1 className="text-3xl font-bold text-white flex items-center gap-3"><Shield className="text-emerald-500" /> AEGIS COMMAND CENTER</h1>
        <button onClick={refreshAgentData} className="flex items-center gap-2 bg-gray-900 border border-gray-700 text-gray-300 px-4 py-2 rounded-lg hover:border-emerald-500 transition-all">
            <RefreshCw size={16} className={isLoading ? "animate-spin" : ""} /> Sync Network
        </button>
      </div>

      {/* METRICS ROW */}
      <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
        <div className="bg-gray-900/50 p-6 rounded-xl border border-gray-800 shadow-xl">
            <h3 className="text-gray-400 text-sm font-bold tracking-wider mb-2">SWARM SPEND</h3>
            <div className="text-3xl font-mono text-white font-bold">{data.currentSpend?.toFixed(4)} <span className="text-sm text-gray-600">ETH</span></div>
            <div className="w-full bg-gray-800 h-2 mt-4 rounded-full overflow-hidden">
                <div className={`h-full ${totalUsagePercent > 80 ? 'bg-red-500' : 'bg-blue-500'}`} style={{width: `${totalUsagePercent}%`}}></div>
            </div>
        </div>
        <div className="bg-gray-900/50 p-6 rounded-xl border border-gray-800 shadow-xl">
             <h3 className="text-gray-400 text-sm font-bold tracking-wider mb-2">ACTIVE NODES</h3>
             <div className="text-3xl font-mono text-white font-bold">{data.agents?.length || 0}</div>
        </div>
        <div className="bg-gray-900/50 p-6 rounded-xl border border-gray-800 shadow-xl">
             <h3 className="text-gray-400 text-sm font-bold tracking-wider mb-2">STATUS</h3>
             <div className="text-3xl font-mono text-white font-bold text-emerald-500">OPERATIONAL</div>
        </div>
      </div>

      {/* AGENT CARDS */}
      <div>
        <h2 className="text-xl font-bold text-white mb-4 flex items-center gap-2"><Users className="text-blue-400"/> Agent Fleet</h2>
        
        <div className="grid grid-cols-1 xl:grid-cols-2 gap-6">
            {data.agents?.map(agent => {
                const agentLogs = logs.filter(l => l.includes(agent.name));
                const status = agentStatuses[agent.id] || "SYNCING";
                
                return (
                    <div key={agent.id} className={`border rounded-xl bg-black transition-all duration-300 ${status === 'PAUSED' ? 'border-red-900 shadow-[0_0_15px_rgba(220,38,38,0.2)]' : 'border-gray-800'}`}>
                        {/* Header */}
                        <div className={`p-5 border-b flex justify-between ${status === 'PAUSED' ? 'bg-red-950/20 border-red-900' : 'bg-gray-900/30 border-gray-800'}`}>
                            <div>
                                <h3 className="font-bold text-white">{agent.name}</h3>
                                <div className="text-xs font-mono text-gray-400">{agent.address}</div>
                            </div>
                            <div className={`px-2 py-1 rounded text-xs font-bold h-fit ${status === 'ACTIVE' ? 'bg-emerald-900/20 text-emerald-400' : status === 'PAUSED' ? 'bg-red-900/20 text-red-500' : 'bg-gray-800 text-gray-500'}`}>
                                {status}
                            </div>
                        </div>

                        {/* Body */}
                        <div className="p-5 grid grid-cols-2 gap-4">
                            
                            {/* Controls */}
                            <div>
                                <div className="mb-4">
                                    <span className="text-xs text-gray-500 font-bold block mb-1">BALANCE</span>
                                    <span className="font-mono text-white">{parseFloat(agentBalances[agent.id] || 0).toFixed(4)} ETH</span>
                                </div>

                                {status === 'ACTIVE' ? (
                                    <button 
                                        onClick={() => handleKillSwitch(agent.address)} 
                                        disabled={isPending} 
                                        className="w-full bg-red-600 hover:bg-red-700 text-white py-2 rounded font-bold flex items-center justify-center gap-2 shadow-lg hover:shadow-red-500/20 transition-all active:scale-95"
                                    >
                                        <Power size={14} /> KILL SWITCH
                                    </button>
                                ) : status === 'PAUSED' ? (
                                    <button 
                                        onClick={() => handleUnfreeze(agent.id, agent.address)}
                                        disabled={isPending}
                                        className="w-full bg-emerald-600 hover:bg-emerald-500 text-white py-2 rounded font-bold flex items-center justify-center gap-2 shadow-lg hover:shadow-emerald-500/20 transition-all active:scale-95 animate-pulse"
                                    >
                                        <Unlock size={14} /> UNFREEZE
                                    </button>
                                ) : (
                                    <div className="text-center text-gray-500 text-sm border border-dashed border-gray-700 p-2 rounded">
                                        No On-Chain Policy
                                    </div>
                                )}
                            </div>

                            {/* Feed */}
                            <div className="bg-black border border-gray-800 rounded p-2 h-[120px] overflow-auto custom-scrollbar">
                                {agentLogs.length === 0 ? <div className="text-xs text-gray-700 text-center mt-8">No Activity</div> : 
                                    agentLogs.slice(0,4).map((l,i) => (
                                        <div key={i} className={`text-[10px] pl-1 mb-1 border-l-2 ${l.includes("BLOCKED") ? "text-red-400 border-red-500" : "text-emerald-400 border-emerald-500"}`}>
                                            {l.split("Attempting")[0]}... {l.includes("BLOCKED") ? "BLOCKED" : "SENT"}
                                        </div>
                                    ))
                                }
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