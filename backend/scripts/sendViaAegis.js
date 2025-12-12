import 'dotenv/config';
import { ethers } from "ethers";

const PRIVATE_KEY = process.env.AGENT_PRIVATE_KEY || "";
if (!PRIVATE_KEY) {
  throw new Error("PRIVATE_KEY is not defined in environment variables.");
}
const amountInEther = process.env.AMOUNT_IN_ETHER || "0.01";

const provider = new ethers.providers.JsonRpcProvider({
  url: "https://aegis-protocol-backend.onrender.com/rpc",
  headers: {
    "x-aegis-user": "0xcf942c47bc33dB4Fabc1696666058b784F9fa9ef",
    "x-aegis-agent": "0x561009A39f2BC5a975251685Ae8C7F98Fac063C7",
  },
});



// 3. Wallet using provider
const signer = new ethers.Wallet(PRIVATE_KEY, provider);

// 4. Send test transaction
const tx = await signer.sendTransaction({
  to: "0xcf942c47bc33dB4Fabc1696666058b784F9fa9ef",
  value: ethers.utils.parseEther(amountInEther),
});

console.log("Submitted TX:", tx.hash);

const receipt = await tx.wait();
console.log("Confirmed:", receipt.transactionHash);
console.log("Done.");