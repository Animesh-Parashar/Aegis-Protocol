import { ethers } from "ethers";

const provider = new ethers.providers.JsonRpcProvider({
  url: "https://aegis-protocol-backend.onrender.com/rpc",
  headers: {
    "x-aegis-user": "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266",
    "x-aegis-agent": "0x561009A39f2BC5a975251685Ae8C7F98Fac063C7",
  },
});

const signer = new ethers.Wallet(PRIVATE_KEY, provider);

await signer.sendTransaction({
  to: "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266",
  value: ethers.utils.parseEther("0.01"),
});
