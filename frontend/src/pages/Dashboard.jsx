import React, { useEffect, useState } from 'react';
import { Activity, Terminal, Wallet, Users, Zap, Power, AlertTriangle, RefreshCw, Shield } from "lucide-react";
import { ethers } from "ethers";
import { getContract, prepareContractCall } from "thirdweb";
import { useSendTransaction, useActiveAccount } from "thirdweb/react";
import { defineChain } from "thirdweb/chains";
import { createThirdwebClient } from "thirdweb";
import { meta } from 'eslint-plugin-react-hooks';

// INLINE ABI to prevent file resolution errors
const AEGIS_ABI = [
  {
    "inputs": [{ "internalType": "address", "name": "_agent", "type": "address" }],
    "name": "killSwitch",
    "outputs": [],
    "stateMutability": "nonpayable",
    "type": "function"
  },
  {
    "inputs": [
      { "internalType": "address", "name": "_user", "type": "address" },
      { "internalType": "address", "name": "_agent", "type": "address" }
    ],
    "name": "getPolicy",
    "outputs": [
      { "internalType": "uint256", "name": "dailyLimit", "type": "uint256" },
      { "internalType": "uint256", "name": "currentSpend", "type": "uint256" },
      { "internalType": "uint256", "name": "lastReset", "type": "uint256" },
      { "internalType": "bool", "name": "isActive", "type": "bool" },
      { "internalType": "bool", "name": "exists", "type": "bool" }
    ],
    "stateMutability": "view",
    "type": "function"
  }
];

// Replaced import.meta.env with string to prevent build target errors
const CLIENT_ID = meta.env.VITE_CLIENT_ID; 
const client = createThirdwebClient({ clientId: CLIENT_ID });
const chain = defineChain(84532);

export default function Dashboard({ data, logs, contractAddress }) {
  const account = useActiveAccount();
  const { mutate: sendTx, isPending } = useSendTransaction();
  
  // Local state for enriched agent data (Balances + Status)
  const [agentStatuses, setAgentStatuses] = useState({});
  const [agentBalances, setAgentBalances] = useState({});
  const [isLoading, setIsLoading] = useState(false);

  // 1. Fetch Chain Data (Balance & Status) for ALL Agents
  const refreshAgentData = async () => {
    if (!data?.agents || !contractAddress || !account) return;
    setIsLoading(true);

    try {
      // Use public RPC to avoid wallet provider locking
      const provider = new ethers.JsonRpcProvider("https://sepolia.base.org");
      const contract = new ethers.Contract(contractAddress, AEGIS_ABI, provider);

      const newStatuses = {};
      const newBalances = {};

      for (const agent of data.agents) {
        // A. Get Policy Status (Is Active?)
        try {
          const policy = await contract.getPolicy(account.address, agent.address);
          // Check policy existence and active status
          // policy[3] is isActive, policy[4] is exists based on ABI order
          newStatuses[agent.id] = policy[4] ? (policy[3] ? "ACTIVE" : "PAUSED") : "UNREGISTERED";
        } catch (e) {
          newStatuses[agent.id] = "UNKNOWN";
        }

        // B. Get Wallet Balance
        try {
            const bal = await provider.getBalance(agent.address);
            newBalances[agent.id] = ethers.formatEther(bal);
        } catch (e) {
            newBalances[agent.id] = "0.0";
        }
      }
      setAgentStatuses(newStatuses);
      setAgentBalances(newBalances);
    } catch (e) {
      console.error("Dashboard Sync Error:", e);
    } finally {
      setIsLoading(false);
    }
  };

  // Sync on load and when data changes
  useEffect(() => {
    refreshAgentData();
  }, [data, contractAddress, account]);


  // 2. Kill Switch Handler (Writes to Chain)
  const handleKillSwitch = (agentAddress) => {
    if (!contractAddress) return alert("Contract Not Found");
    
    const contract = getContract({ client, chain, address: contractAddress, abi: AEGIS_ABI });
    const transaction = prepareContractCall({
      contract,
      method: "killSwitch",
      params: [agentAddress], 
    });

    sendTx(transaction, {
      onSuccess: () => {
        alert(`🚨 KILL SWITCH ACTIVATED for ${agentAddress}. Transaction sent.`);
        setTimeout(refreshAgentData, 4000); // Refresh after delay
      },
      onError: (e) => alert("Failed: " + e.message)
    });
  };

  if (!data) return <div className="p-10 text-gray-500 animate-pulse">Loading Aegis System...</div>;

  // Helpers
  const demoLimit = 5.0; 
  const totalUsagePercent = Math.min((data.currentSpend / demoLimit) * 100, 100);

  return (
    <div className="space-y-8 animate-fade-in pb-10">
      
      {/* --- HEADER --- */}
      <div className="flex flex-col md:flex-row justify-between items-start md:items-center gap-4 border-b border-gray-800 pb-6">
        <div>
            <h1 className="text-3xl font-bold text-white tracking-tight flex items-center gap-3">
                <Shield className="text-emerald-500" /> AEGIS COMMAND CENTER
            </h1>
            <p className="text-gray-500 mt-1">Multi-Agent Oversight & Kill Switch Protocol</p>
        </div>
        <button 
            onClick={refreshAgentData}
            className="flex items-center gap-2 bg-gray-900 border border-gray-700 hover:border-emerald-500 text-gray-300 px-4 py-2 rounded-lg transition-all"
        >
            <RefreshCw size={16} className={isLoading ? "animate-spin" : ""} />
            Sync Network
        </button>
      </div>

      {/* --- GLOBAL METRICS --- */}
      <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
        {/* Total Spend */}
        <div className="bg-gray-900/50 p-6 rounded-xl border border-gray-800 shadow-xl relative overflow-hidden group">
            <div className="absolute top-0 right-0 p-4 opacity-10 group-hover:opacity-20 transition-opacity">
                <Wallet size={64} />
            </div>
            <h3 className="text-gray-400 text-sm font-bold tracking-wider mb-2">SWARM LIQUIDITY</h3>
            <div className="text-3xl font-mono text-white font-bold">
                {data.currentSpend?.toFixed(4)} <span className="text-lg text-gray-500">ETH</span>
            </div>
            <div className="w-full bg-gray-800 h-2 mt-4 rounded-full overflow-hidden">
                <div className={`h-full ${totalUsagePercent > 80 ? 'bg-red-500' : 'bg-blue-500'}`} style={{width: `${totalUsagePercent}%`}}></div>
            </div>
            <p className="text-xs text-gray-500 mt-2">Aggregated 24h Spend</p>
        </div>

        {/* Active Agents Count */}
        <div className="bg-gray-900/50 p-6 rounded-xl border border-gray-800 shadow-xl">
             <h3 className="text-gray-400 text-sm font-bold tracking-wider mb-2">ACTIVE NODES</h3>
             <div className="text-3xl font-mono text-white font-bold flex items-center gap-3">
                {data.agents?.length || 0} <span className="text-sm bg-emerald-900/30 text-emerald-500 px-2 py-1 rounded border border-emerald-900/50">ONLINE</span>
             </div>
             <p className="text-xs text-gray-500 mt-2">Registered AI Agents</p>
        </div>

        {/* System Status */}
        <div className="bg-gray-900/50 p-6 rounded-xl border border-gray-800 shadow-xl">
             <h3 className="text-gray-400 text-sm font-bold tracking-wider mb-2">NETWORK STATUS</h3>
             <div className="text-3xl font-mono text-white font-bold flex items-center gap-2">
                <Activity className="text-emerald-500"/> OPERATIONAL
             </div>
             <p className="text-xs text-gray-500 mt-2">Base Sepolia Testnet</p>
        </div>
      </div>


      {/* --- INDIVIDUAL AGENT CARDS --- */}
      <div>
        <h2 className="text-xl font-bold text-white mb-4 flex items-center gap-2">
            <Users className="text-blue-400"/> Agent Fleet
        </h2>
        
        <div className="grid grid-cols-1 xl:grid-cols-2 gap-6">
            {data.agents?.map(agent => {
                // Filter logs for this specific agent
                const agentLogs = logs.filter(l => l.includes(agent.address) || l.includes(agent.name));
                const status = agentStatuses[agent.id] || "SYNCING";
                const balance = agentBalances[agent.id] || "0.0";
                
                return (
                    <div key={agent.id} className={`border rounded-xl overflow-hidden transition-all ${status === 'PAUSED' ? 'border-red-900/50 bg-red-950/10' : 'border-gray-800 bg-black'}`}>
                        {/* Agent Header */}
                        <div className="p-5 border-b border-gray-800 flex justify-between items-start bg-gray-900/30">
                            <div className="flex items-center gap-4">
                                <div className={`w-12 h-12 rounded-full flex items-center justify-center text-lg font-bold shadow-lg ${status === 'PAUSED' ? 'bg-red-900 text-red-200' : 'bg-gradient-to-br from-blue-600 to-purple-600 text-white'}`}>
                                    {agent.name.substring(0,2).toUpperCase()}
                                </div>
                                <div>
                                    <h3 className="font-bold text-white text-lg">{agent.name}</h3>
                                    <div className="flex items-center gap-2 text-xs font-mono text-gray-400 bg-black/50 px-2 py-1 rounded">
                                        {agent.address}
                                    </div>
                                </div>
                            </div>
                            <div className={`px-3 py-1 rounded-full text-xs font-bold border ${
                                status === 'ACTIVE' ? 'bg-emerald-900/20 text-emerald-400 border-emerald-900' : 
                                status === 'PAUSED' ? 'bg-red-900/20 text-red-500 border-red-900' : 
                                'bg-gray-800 text-gray-500 border-gray-700'
                            }`}>
                                {status}
                            </div>
                        </div>

                        {/* Agent Body */}
                        <div className="p-5 grid grid-cols-1 md:grid-cols-2 gap-6">
                            
                            {/* Left: Stats & Controls */}
                            <div className="space-y-6">
                                <div>
                                    <label className="text-xs text-gray-500 font-bold tracking-wider mb-1 block">WALLET BALANCE</label>
                                    <div className="text-2xl font-mono text-white">{parseFloat(balance).toFixed(4)} ETH</div>
                                </div>
                                
                                {status === 'ACTIVE' ? (
                                    <button 
                                        onClick={() => handleKillSwitch(agent.address)}
                                        disabled={isPending}
                                        className="w-full bg-red-600 hover:bg-red-700 text-white py-3 rounded-lg font-bold flex items-center justify-center gap-2 shadow-lg shadow-red-900/20 active:scale-95 transition-all"
                                    >
                                        <Power size={18} /> KILL SWITCH
                                    </button>
                                ) : status === 'PAUSED' ? (
                                    <div className="w-full bg-red-900/20 border border-red-900 text-red-500 py-3 rounded-lg font-bold flex items-center justify-center gap-2">
                                        <AlertTriangle size={18}/> AGENT FROZEN
                                    </div>
                                ) : (
                                    <div className="w-full bg-gray-800 text-gray-500 py-3 rounded-lg font-bold text-center text-sm">
                                        No Policy Found
                                    </div>
                                )}
                            </div>

                            {/* Right: Mini Logs Feed */}
                            <div className="bg-black border border-gray-800 rounded-lg p-3 flex flex-col h-[140px]">
                                <div className="flex items-center gap-2 mb-2 text-gray-500 text-xs font-bold border-b border-gray-800 pb-2">
                                    <Terminal size={12}/> RECENT ACTIVITY
                                </div>
                                <div className="flex-1 overflow-auto space-y-2 custom-scrollbar pr-1">
                                    {agentLogs.length === 0 ? (
                                        <div className="text-center text-gray-700 text-xs italic mt-4">No recent transactions</div>
                                    ) : (
                                        agentLogs.slice(0, 5).map((log, i) => (
                                            <div key={i} className="text-[10px] font-mono leading-tight text-gray-400 break-words border-l-2 border-gray-700 pl-2">
                                                {log}
                                            </div>
                                        ))
                                    )}
                                </div>
                            </div>

                        </div>
                    </div>
                );
            })}
        </div>
        
        {(!data.agents || data.agents.length === 0) && (
            <div className="text-center py-20 bg-gray-900/20 border border-gray-800 border-dashed rounded-xl">
                <Users size={48} className="mx-auto text-gray-700 mb-4"/>
                <h3 className="text-gray-400 font-bold">No Agents Onboarded</h3>
                <p className="text-gray-600 text-sm">Go to the "Whitelist" tab to add agents.</p>
            </div>
        )}
      </div>

    </div>
  );
}