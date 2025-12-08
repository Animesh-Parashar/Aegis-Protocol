require('dotenv').config();
const express = require('express');
const cors = require('cors');
const aegisRouter = require('./routes/aegis');

const app = express();
app.use(cors());
app.use(express.json());

const PORT = process.env.PORT ? Number(process.env.PORT) : 3001;

// --- Config Checks ---
if (!process.env.THIRDWEB_SECRET_KEY) {
  console.warn("⚠️  THIRDWEB_SECRET_KEY missing. External blockchain calls may fail or be rate limited.");
}
if (!process.env.AGENT_PRIVATE_KEY) {
  console.warn("⚠️  AGENT_PRIVATE_KEY missing. Facilitator will run in READ-ONLY / MOCK mode.");
}
if (!process.env.CONTRACT_ADDRESS) {
  console.warn("⚠️  CONTRACT_ADDRESS missing. Policy checks will be Mocked.");
}

// --- Routes ---
// The main Aegis entrypoint
app.use('/api', aegisRouter);

// Health check
app.get('/health', (req, res) => res.json({ status: "OK", timestamp: Date.now() }));

// --- Start Server ---
app.listen(PORT, () => {
  console.log(`\n🚀 Aegis Firewall Online on Port ${PORT}`);
  console.log(`   Mode: ${process.env.AGENT_PRIVATE_KEY ? "FACILITATOR (Active)" : "OBSERVER (Mock)"}`);
});
