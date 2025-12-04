import React, { useState, useEffect } from 'react';
import axios from 'axios';
import { Plus, Save, Trash2, ShieldCheck } from 'lucide-react';

export default function Policies() {
  const [templates, setTemplates] = useState([]);
  const [newName, setNewName] = useState("");
  const [newLimit, setNewLimit] = useState("");

  // Fetch Templates from Backend (Mock DB)
  const fetchTemplates = async () => {
    const res = await axios.get('http://localhost:3001/api/templates');
    setTemplates(res.data);
  };

  useEffect(() => { fetchTemplates(); }, []);

  const createTemplate = async () => {
    if (!newName || !newLimit) return;
    await axios.post('http://localhost:3001/api/templates/add', { name: newName, value: newLimit });
    setNewName(""); setNewLimit("");
    fetchTemplates();
  };

  return (
    <div className="animate-fade-in space-y-8">
      <div className="flex justify-between items-center">
        <h1 className="text-2xl font-bold text-emerald-400 flex items-center gap-2">
          <ShieldCheck /> Policy Templates
        </h1>
      </div>

      {/* CREATE NEW POLICY */}
      <div className="bg-gray-900 p-6 rounded-xl border border-gray-800">
        <h3 className="text-white font-bold mb-4">Create New Standard</h3>
        <div className="flex gap-4 items-end">
          <div className="flex-1">
            <label className="text-xs text-gray-500 mb-1 block">Policy Name</label>
            <input 
              placeholder="e.g. High Risk Trader" 
              value={newName} 
              onChange={e => setNewName(e.target.value)} 
              className="w-full bg-black border border-gray-700 p-3 rounded text-white"
            />
          </div>
          <div className="w-48">
            <label className="text-xs text-gray-500 mb-1 block">Daily Limit (ETH)</label>
            <input 
              type="number" 
              placeholder="0.5" 
              value={newLimit} 
              onChange={e => setNewLimit(e.target.value)} 
              className="w-full bg-black border border-gray-700 p-3 rounded text-white"
            />
          </div>
          <button onClick={createTemplate} className="bg-blue-600 hover:bg-blue-500 p-3 rounded text-white font-bold h-[50px] px-6 flex items-center gap-2">
            <Plus size={18} /> Add
          </button>
        </div>
      </div>

      {/* TEMPLATE LIST */}
      <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
        {templates.map(t => (
          <div key={t.id} className="bg-black border border-gray-800 p-6 rounded-xl hover:border-emerald-500/50 transition-colors relative group">
            <h3 className="font-bold text-lg text-white">{t.name}</h3>
            <div className="text-3xl font-mono text-emerald-400 my-3">{t.value} <span className="text-sm text-gray-500">ETH/day</span></div>
            <div className="text-xs text-gray-500">ID: {t.id}</div>
          </div>
        ))}
      </div>
    </div>
  );
}