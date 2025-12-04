import React, { useState, useEffect } from "react";
import { BrowserRouter as Router, Routes, Route, Link, useLocation } from "react-router-dom";
import { createThirdwebClient } from "thirdweb";
import { defineChain } from "thirdweb/chains";
import { ConnectButton, useActiveAccount } from "thirdweb/react";
import { createWallet } from "thirdweb/wallets";
import axios from "axios";
import { Shield, LayoutDashboard, Settings, Users, LogOut } from "lucide-react";

// PAGES
import Dashboard from "./pages/Dashboard";
import Policies from "./pages/Policies";
import Agents from "./pages/Agents";

const CLIENT_ID = import.meta.env.VITE_CLIENT_ID ; 
console.log("HEllo",CLIENT_ID)// Paste yours
const client = createThirdwebClient({ clientId: CLIENT_ID });
const chain = defineChain(84532);
const wallets = [ createWallet("io.metamask") ];
const API_URL = "http://localhost:3001/api";
const CONTRACT_ADDRESS = import.meta.env.VITE_CONTRACT_ADDRESS ;

// SIDEBAR COMPONENT
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
  
  const ADMIN_ADDRESS = import.meta.env.VITE_ADMIN_ADDRESS; 

  const fetchStatus = async () => {
    try {
      const res = await axios.get(`${API_URL}/config`);
      setData(res.data);
    } catch (e) { console.error("Backend offline"); }
  };

  useEffect(() => {
    fetchStatus();
    const interval = setInterval(fetchStatus, 2000);
    return () => clearInterval(interval);
  }, []);

  const addLog = (msg) => setLogs(prev => [`[${new Date().toLocaleTimeString()}] ${msg}`, ...prev]);

  const toggleKillSwitch = async () => {
    const newStatus = data.status === "ACTIVE" ? "PAUSED" : "ACTIVE";
    await axios.post(`${API_URL}/policies/update`, { status: newStatus });
    fetchStatus();
  };

  return (
    <Router>
      <div className="flex min-h-screen bg-black text-white font-mono">
        
        {/* SIDEBAR */}
        <div className="w-64 border-r border-gray-800 p-6 flex flex-col">
            <div className="flex items-center gap-2 mb-10 text-emerald-500">
                <Shield size={28} />
                <h1 className="text-xl font-bold tracking-wider">AEGIS Protocol</h1>
            </div>
            
            <nav className="flex-1">
                <SidebarLink to="/" icon={LayoutDashboard} label="Overview" />
                <SidebarLink to="/policies" icon={Settings} label="Policies" />
                <SidebarLink to="/agents" icon={Users} label="Whitelist" />
            </nav>

            <div className="mt-auto">
                <ConnectButton client={client} chain={chain} wallets={wallets} theme="dark" connectModal={{ size: "compact" }} />
            </div>
        </div>

        {/* MAIN CONTENT AREA */}
        <div className="flex-1 p-8 bg-black">
            {!account ? (
                <div className="h-full flex items-center justify-center text-gray-500">Connect Admin Wallet</div>
            ) : account.address !== ADMIN_ADDRESS ? (
                <div className="h-full flex items-center justify-center text-red-500 font-bold">ACCESS DENIED</div>
            ) : (
                <Routes>
                    <Route path="/" element={<Dashboard contractAddress={CONTRACT_ADDRESS} data={data} logs={logs} toggleKillSwitch={toggleKillSwitch} />} />
                    <Route path="/policies" element={<Policies contractAddress={CONTRACT_ADDRESS} data={data} refreshData={fetchStatus} />} />
                    <Route path="/agents" element={<Agents contractAddress={CONTRACT_ADDRESS} data={data} refreshData={fetchStatus} />} />
                </Routes>
            )}
        </div>

      </div>
    </Router>
  );
}