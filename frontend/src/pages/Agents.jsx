import React, { useState, useEffect } from 'react';
import axios from 'axios';
import { ethers } from "ethers"; 
import { getContract, prepareContractCall } from "thirdweb";
import { useSendTransaction, useActiveAccount } from "thirdweb/react";
import { defineChain } from "thirdweb/chains";
import { createThirdwebClient } from "thirdweb";
import { toUnits } from "thirdweb/utils";
import { User, Zap, Activity, RefreshCw, PlusCircle, Trash2 } from 'lucide-react';
import aegisAbi from '../utils/abi/aegisAbi.json';


const AEGIS_ABI = aegisAbi;
const CLIENT_ID = import.meta.env.VITE_CLIENT_ID ;
const client = createThirdwebClient({ clientId: CLIENT_ID });
const chain = defineChain(84532);

export default function Agents({ contractAddress }) {
  const account = useActiveAccount();
  const { mutate: sendTx, isPending } = useSendTransaction();
  
  const [agents, setAgents] = useState([]);
  const [templates, setTemplates] = useState([]);
  
  // New Agent Form State
  const [newAgentName, setNewAgentName] = useState("");
  const [newAgentAddress, setNewAgentAddress] = useState("");

  const [selectedPolicy, setSelectedPolicy] = useState({}); 
  const [onChainPolicies, setOnChainPolicies] = useState({});
  const [isLoadingChain, setIsLoadingChain] = useState(false);

  // 1. Load Local Data
  const loadData = async () => {
    try {
      const [agentRes, tempRes] = await Promise.all([
        axios.get('http://localhost:3001/api/agents'), // Use dedicated endpoint
        axios.get('http://localhost:3001/api/templates')
      ]);
      setAgents(agentRes.data || []);
      setTemplates(tempRes.data || []);
    } catch (e) {
      console.error("Backend offline", e);
    }
  };

  useEffect(() => { loadData(); }, []);

  // 2. Add New Agent Function
  const handleAddAgent = async () => {
    if (!newAgentName || !newAgentAddress) return alert("Please fill in fields");
    try {
        await axios.post('http://localhost:3001/api/agents/add', {
            name: newAgentName,
            address: newAgentAddress
        });
        setNewAgentName("");
        setNewAgentAddress("");
        loadData(); // Refresh list
    } catch (e) {
        alert("Failed to add agent");
    }
  };

  // 3. Remove Agent (UI Only)
  const handleRemoveAgent = async (id) => {
      try {
          await axios.post('http://localhost:3001/api/agents/remove', { id });
          loadData();
      } catch (e) { console.error(e); }
  };

  // 4. Load On-Chain Data
  const fetchOnChainData = async () => {
    if (!account || !contractAddress || agents.length === 0) return;

    setIsLoadingChain(true);
    try {
      const provider = new ethers.JsonRpcProvider("https://sepolia.base.org");
      const contract = new ethers.Contract(contractAddress, AEGIS_ABI, provider);

      const policyMap = {};

      for (const agent of agents) {
        try {
          const data = await contract.getPolicy(account.address, agent.address);
          if (data[4]) { // exists
            policyMap[agent.id] = ethers.formatEther(data[0]) + " ETH";
          } else {
            policyMap[agent.id] = "No Policy";
          }
        } catch (err) {
          policyMap[agent.id] = "-";
        }
      }
      setOnChainPolicies(policyMap);
    } catch (e) {
      console.error(e);
    } finally {
      setIsLoadingChain(false);
    }
  };

  useEffect(() => { fetchOnChainData(); }, [agents, account, contractAddress]);

  // 5. Write to Chain
  const applyPolicyOnChain = (agentAddress, limitEth) => {
    if (!limitEth) return alert("Select a policy first");
    if (!contractAddress) return alert("Contract address missing");

    const limitWei = toUnits(limitEth.toString(), 18);
    const contract = getContract({ client, chain, address: contractAddress, abi: AEGIS_ABI });
    const transaction = prepareContractCall({
      contract,
      method: "setPolicy",
      params: [agentAddress, limitWei], 
    });

    sendTx(transaction, {
      onSuccess: () => {
        alert("Transaction Sent! Waiting for block confirmation...");
        setTimeout(fetchOnChainData, 4000); 
      },
      onError: (err) => alert("Failed: " + err.message)
    });
  };

  return (
    <div className="animate-fade-in space-y-8">
      
      {/* HEADER */}
      <div className="flex justify-between items-center border-b border-gray-800 pb-4">
        <div>
            <h1 className="text-2xl font-bold text-white flex items-center gap-2"><User /> Agent Swarm</h1>
            <p className="text-gray-500 text-sm mt-1">Onboard AI agents and assign their on-chain spending limits.</p>
        </div>
        <button 
          onClick={fetchOnChainData} 
          className="text-xs flex items-center gap-1 text-gray-400 hover:text-white border border-gray-700 px-3 py-1 rounded-full"
        >
          <RefreshCw size={12} className={isLoadingChain ? "animate-spin" : ""} /> Refresh Status
        </button>
      </div>

      {/* ADD AGENT CARD */}
      <div className="bg-gray-900 p-6 rounded-xl border border-gray-800 flex flex-col md:flex-row gap-4 items-end">
        <div className="flex-1 w-full">
            <label className="text-xs text-gray-500 mb-1 ml-1 block">New Agent Name</label>
            <input 
                value={newAgentName}
                onChange={(e) => setNewAgentName(e.target.value)}
                placeholder="e.g. Arbitrage Bot V2" 
                className="w-full bg-black border border-gray-700 text-white p-3 rounded focus:border-emerald-500 outline-none"
            />
        </div>
        <div className="flex-[2] w-full">
            <label className="text-xs text-gray-500 mb-1 ml-1 block">Wallet Address</label>
            <input 
                value={newAgentAddress}
                onChange={(e) => setNewAgentAddress(e.target.value)}
                placeholder="0x..." 
                className="w-full bg-black border border-gray-700 text-white p-3 rounded font-mono focus:border-emerald-500 outline-none"
            />
        </div>
        <button 
            onClick={handleAddAgent}
            className="bg-blue-600 hover:bg-blue-500 text-white font-bold py-3 px-6 rounded flex items-center gap-2 h-[50px] whitespace-nowrap"
        >
            <PlusCircle size={18}/> Onboard Agent
        </button>
      </div>
      
      {/* AGENT TABLE */}
      <div className="bg-gray-900/50 border border-gray-800 rounded-xl overflow-hidden shadow-2xl">
        <table className="w-full text-left">
          <thead className="bg-gray-900 text-gray-400 text-sm uppercase">
            <tr>
              <th className="p-4">Agent Identity</th>
              <th className="p-4 text-emerald-400">On-Chain Limit</th>
              <th className="p-4">Assign Policy</th>
              <th className="p-4">Actions</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-800">
            {agents.map(agent => (
              <tr key={agent.id} className="hover:bg-gray-900/30 transition-colors group">
                
                {/* Identity */}
                <td className="p-4">
                  <div className="font-bold text-white flex items-center gap-2">
                    <div className="w-2 h-2 rounded-full bg-emerald-500 animate-pulse"></div>
                    {agent.name}
                  </div>
                  <div className="font-mono text-gray-500 text-xs mt-1">{agent.address}</div>
                </td>

                {/* READ Status */}
                <td className="p-4 font-mono font-bold text-emerald-300">
                  {isLoadingChain ? (
                    <span className="text-gray-600 text-xs animate-pulse">Scanning...</span>
                  ) : (
                    onChainPolicies[agent.id] || <span className="text-gray-600 text-xs">Unregistered</span>
                  )}
                </td>
                
                {/* SELECTOR */}
                <td className="p-4">
                  <select 
                    className="bg-black border border-gray-700 text-white p-2 rounded w-full text-sm focus:border-emerald-500 outline-none"
                    onChange={(e) => setSelectedPolicy({ ...selectedPolicy, [agent.id]: e.target.value })}
                    value={selectedPolicy[agent.id] || ""}
                  >
                    <option value="">-- Choose Template --</option>
                    {templates.map(t => (
                      <option key={t.id} value={t.value}>{t.name} ({t.value} ETH)</option>
                    ))}
                  </select>
                </td>

                {/* ACTIONS */}
                <td className="p-4 flex items-center gap-2">
                  <button 
                    onClick={() => applyPolicyOnChain(agent.address, selectedPolicy[agent.id])}
                    disabled={isPending}
                    className="bg-emerald-600 hover:bg-emerald-500 disabled:opacity-50 disabled:cursor-not-allowed text-white px-3 py-2 rounded text-sm font-bold flex items-center gap-2 shadow-lg hover:shadow-emerald-900/50 transition-all"
                  >
                    {isPending ? <Activity className="animate-spin" size={14}/> : <Zap size={14}/>}
                    Sync
                  </button>
                  <button 
                    onClick={() => handleRemoveAgent(agent.id)}
                    className="bg-red-900/20 hover:bg-red-900/50 text-red-500 p-2 rounded transition-all opacity-0 group-hover:opacity-100"
                    title="Remove from List (Does not revoke on-chain)"
                  >
                    <Trash2 size={16}/>
                  </button>
                </td>
              </tr>
            ))}
            {agents.length === 0 && (
              <tr>
                <td colSpan="5" className="p-10 text-center text-gray-500">
                  <div className="flex flex-col items-center gap-2">
                    <User size={32} className="opacity-20"/>
                    <span>No agents onboarded yet. Add one above.</span>
                  </div>
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}