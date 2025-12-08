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
const CLIENT_ID = import.meta.env.VITE_CLIENT_ID;
const RPC_URL = import.meta.env.VITE_RPC_URL;
const CHAIN_ID = Number(import.meta.env.VITE_CHAIN_ID || "84532");
const API_BASE_URL = import.meta.env.VITE_API_BASE_URL || "http://localhost:3001";

if (!CLIENT_ID) console.warn("VITE_CLIENT_ID not set");
if (!RPC_URL) console.warn("VITE_RPC_URL not set");
if (!CHAIN_ID) console.warn("VITE_CHAIN_ID not set");

// thirdweb client + chain (env-driven)
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

// axios instance (env-driven backend)
const api = axios.create({
  baseURL: API_BASE_URL,
});

export default function Agents({ contractAddress }) {
  const account = useActiveAccount();
  const { mutate: sendTx, isPending } = useSendTransaction();
  
  const [agents, setAgents] = useState([]);
  const [templates, setTemplates] = useState([]);
  
  // New Agent Form State
  const [newAgentName, setNewAgentName] = useState("");
  const [newAgentAddress, setNewAgentAddress] = useState("");

  // Per-agent selected policy (ETH value as string)
  const [selectedPolicy, setSelectedPolicy] = useState({}); 

  // On-chain policy data per agent.id
  const [onChainPolicies, setOnChainPolicies] = useState({});
  const [isLoadingChain, setIsLoadingChain] = useState(false);

  // 1. Load Local Data (from env-based backend)
  const loadData = async () => {
    try {
      const [agentRes, tempRes] = await Promise.all([
        api.get('/api/agents'),
        api.get('/api/templates'),
      ]);
      setAgents(agentRes.data || []);
      setTemplates(tempRes.data || []);
    } catch (e) {
      console.error("Backend offline or API error", e);
    }
  };

  useEffect(() => { loadData(); }, []);

  // 2. Add New Agent Function
  const handleAddAgent = async () => {
    if (!newAgentName || !newAgentAddress) return alert("Please fill in fields");
    try {
      await api.post('/api/agents/add', {
        name: newAgentName,
        address: newAgentAddress,
      });
      setNewAgentName("");
      setNewAgentAddress("");
      loadData();
    } catch (e) {
      console.error(e);
      alert("Failed to add agent");
    }
  };

  // 3. Remove Agent (UI / backend list only)
  const handleRemoveAgent = async (id) => {
    try {
      await api.post('/api/agents/remove', { id });
      loadData();
    } catch (e) {
      console.error(e);
    }
  };

  // 4. Load On-Chain Data (full Policy struct; env-based RPC)
  const fetchOnChainData = async () => {
    if (!account || !contractAddress || agents.length === 0 || !RPC_URL) return;

    setIsLoadingChain(true);
    try {
      const provider = new ethers.JsonRpcProvider(RPC_URL);
      const contract = new ethers.Contract(contractAddress, AEGIS_ABI, provider);

      const policyMap = {};

      for (const agent of agents) {
        try {
          // getPolicy(address _user, address _agent)
          const data = await contract.getPolicy(account.address, agent.address);

          // tuple: [dailyLimit, currentSpend, lastReset, isActive, exists]
          const [dailyLimit, currentSpend, lastReset, isActive, exists] = data;

          if (exists) {
            policyMap[agent.id] = {
              exists: true,
              dailyLimitWei: dailyLimit,
              dailyLimitEth: ethers.formatEther(dailyLimit),
              currentSpendWei: currentSpend,
              currentSpendEth: ethers.formatEther(currentSpend),
              lastReset: Number(lastReset),
              isActive,
            };
          } else {
            policyMap[agent.id] = {
              exists: false,
            };
          }
        } catch (err) {
          console.error("getPolicy failed for agent", agent.address, err);
          policyMap[agent.id] = { exists: false, error: true };
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

  // 5. Write: setPolicy(_agent, _dailyLimit)
  const applyPolicyOnChain = (agentAddress, limitEthRaw) => {
    if (!account) return alert("Connect your wallet first.");
    if (!limitEthRaw) return alert("Select a policy first");
    if (!contractAddress) return alert("Contract address missing");

    try {
      const limitEth = limitEthRaw.toString().trim();
      const limitWei = toUnits(limitEth, 18);

      const contract = getContract({
        client,
        chain,
        address: contractAddress,
        abi: AEGIS_ABI,
      });

      const transaction = prepareContractCall({
        contract,
        method: "function setPolicy(address _agent, uint256 _dailyLimit)",
        params: [agentAddress, limitWei],
      });

      console.log("Sending setPolicy:", {
        user: account.address,
        agent: agentAddress,
        limitEth,
        limitWei: limitWei.toString(),
      });

      sendTx(transaction, {
        onSuccess: (txResult) => {
          console.log("Tx sent:", txResult);
          alert("Policy transaction sent. It will update after confirmation.");
          setTimeout(fetchOnChainData, 5000);
        },
        onError: (err) => {
          console.error("Tx failed:", err);
          alert("Failed: " + (err?.message || "Unknown error"));
        },
      });
    } catch (err) {
      console.error("Error preparing tx:", err);
      alert("Failed to prepare transaction: " + (err?.message || "Unknown error"));
    }
  };

  // 6. Kill Switch: sets isActive = false in Policy struct
  const triggerKillSwitch = (agentAddress) => {
    if (!account) return alert("Connect your wallet first.");
    if (!contractAddress) return alert("Contract address missing");

    try {
      const contract = getContract({
        client,
        chain,
        address: contractAddress,
        abi: AEGIS_ABI,
      });

      const transaction = prepareContractCall({
        contract,
        method: "function killSwitch(address _agent)",
        params: [agentAddress],
      });

      sendTx(transaction, {
        onSuccess: () => {
          alert("Kill Switch triggered. Agent access revoked.");
          setTimeout(fetchOnChainData, 5000);
        },
        onError: (err) => {
          console.error("KillSwitch failed:", err);
          alert("Failed: " + (err?.message || "Unknown error"));
        },
      });
    } catch (err) {
      console.error("Error preparing killSwitch tx:", err);
      alert("Failed to prepare transaction: " + (err?.message || "Unknown error"));
    }
  };

  return (
    <div className="animate-fade-in space-y-8">
      
      {/* HEADER */}
      <div className="flex justify-between items-center border-b border-gray-800 pb-4">
        <div>
          <h1 className="text-2xl font-bold text-white flex items-center gap-2">
            <User /> Agent Swarm
          </h1>
          <p className="text-gray-500 text-sm mt-1">
            Onboard AI agents and assign their on-chain spending limits.
          </p>
        </div>
        <button 
          onClick={fetchOnChainData} 
          className="text-xs flex items-center gap-1 text-gray-400 hover:text-white border border-gray-700 px-3 py-1 rounded-full"
        >
          <RefreshCw size={12} className={isLoadingChain ? "animate-spin" : ""} /> 
          Refresh Status
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
              <th className="p-4 text-emerald-400">On-Chain Policy</th>
              <th className="p-4">Assign Daily Limit</th>
              <th className="p-4">Actions</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-800">
            {agents.map(agent => {
              const pol = onChainPolicies[agent.id];

              return (
                <tr key={agent.id} className="hover:bg-gray-900/30 transition-colors group">
                  
                  {/* Identity */}
                  <td className="p-4">
                    <div className="font-bold text-white flex items-center gap-2">
                      <div
                        className={`w-2 h-2 rounded-full ${
                          pol?.exists && pol?.isActive ? "bg-emerald-500" : "bg-gray-600"
                        }`}
                      ></div>
                      {agent.name}
                    </div>
                    <div className="font-mono text-gray-500 text-xs mt-1">{agent.address}</div>
                  </td>

                  {/* READ Struct Status */}
                  <td className="p-4 text-xs text-gray-300">
                    {isLoadingChain ? (
                      <span className="text-gray-600 animate-pulse">Scanning...</span>
                    ) : !pol || !pol.exists ? (
                      <span className="text-gray-600">No Policy</span>
                    ) : (
                      <div className="space-y-1">
                        <div className="font-mono text-emerald-300 text-sm">
                          Limit: {pol.dailyLimitEth} ETH
                        </div>
                        <div className="font-mono text-xs text-gray-400">
                          Spent (24h): {pol.currentSpendEth} ETH
                        </div>
                        <div className="text-xs text-gray-500">
                          Status: {pol.isActive ? "Active" : "Revoked"}
                        </div>
                      </div>
                    )}
                  </td>
                  
                  {/* SELECTOR (Daily Limit input) */}
                  <td className="p-4">
                    <select 
                      className="bg-black border border-gray-700 text-white p-2 rounded w-full text-sm focus:border-emerald-500 outline-none"
                      onChange={(e) => setSelectedPolicy({
                        ...selectedPolicy, 
                        [agent.id]: e.target.value,
                      })}
                      value={selectedPolicy[agent.id] || ""}
                    >
                      <option value="">-- Choose Template (Limit in ETH) --</option>
                      {templates.map(t => (
                        <option key={t.id} value={t.value}>
                          {t.name} ({t.value} ETH)
                        </option>
                      ))}
                    </select>
                  </td>

                  {/* ACTIONS */}
                  <td className="p-4 flex items-center gap-2">
                    {/* Sync = setPolicy(_agent, _dailyLimit) */}
                    <button 
                      onClick={() => applyPolicyOnChain(agent.address, selectedPolicy[agent.id])}
                      disabled={isPending}
                      className="bg-emerald-600 hover:bg-emerald-500 disabled:opacity-50 disabled:cursor-not-allowed text-white px-3 py-2 rounded text-sm font-bold flex items-center gap-2 shadow-lg hover:shadow-emerald-900/50 transition-all"
                    >
                      {isPending ? <Activity className="animate-spin" size={14}/> : <Zap size={14}/>}
                      Sync
                    </button>

                    {/* Kill Switch = killSwitch(_agent) */}
                    <button
                      onClick={() => triggerKillSwitch(agent.address)}
                      className="bg-red-900/30 hover:bg-red-800/60 text-red-300 px-3 py-2 rounded text-xs font-semibold transition-all"
                    >
                      Kill Switch
                    </button>

                    {/* Remove from UI list only */}
                    <button 
                      onClick={() => handleRemoveAgent(agent.id)}
                      className="bg-red-900/20 hover:bg-red-900/50 text-red-500 p-2 rounded transition-all opacity-0 group-hover:opacity-100"
                      title="Remove from List (Does not revoke on-chain)"
                    >
                      <Trash2 size={16}/>
                    </button>
                  </td>
                </tr>
              );
            })}
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
