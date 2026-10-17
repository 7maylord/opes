"use client";

import { useSignTransaction, useWallets } from "@privy-io/react-auth";

const rpcUrl =
  process.env.NEXT_PUBLIC_OPES_ARC_TESTNET_RPC_URL ||
  "https://rpc.testnet.arc.io";
const minimumMaxFee = BigInt(30_000_000_000);
const priorityFee = BigInt(5_000_000_000);

export function useArcTransaction() {
  const { signTransaction } = useSignTransaction();
  const { wallets } = useWallets();

  return async (transaction: {
    to: string;
    data: string;
    chainId: number;
    value?: number;
  }) => {
    const wallet = wallets.find(
      (candidate) =>
        candidate.type === "ethereum" &&
        (candidate.walletClientType === "privy" ||
          candidate.walletClientType === "privy-v2"),
    );
    if (!wallet) throw new Error("Privy embedded wallet is unavailable");

    const [chainId, nonce, estimatedGas, gasPrice] = await Promise.all([
      rpc<string>("eth_chainId"),
      rpc<string>("eth_getTransactionCount", [wallet.address, "pending"]),
      rpc<string>("eth_estimateGas", [
        {
          from: wallet.address,
          to: transaction.to,
          data: transaction.data,
          value: "0x0",
        },
      ]),
      rpc<string>("eth_gasPrice"),
    ]);
    if (Number(BigInt(chainId)) !== transaction.chainId)
      throw new Error("The configured Arc RPC is on the wrong network");

    const suggestedMaxFee = BigInt(gasPrice) * BigInt(2);
    const { signature } = await signTransaction(
      {
        from: wallet.address,
        to: transaction.to,
        data: transaction.data,
        chainId: transaction.chainId,
        value: transaction.value ?? 0,
        nonce: BigInt(nonce),
        gasLimit: (BigInt(estimatedGas) * BigInt(12)) / BigInt(10),
        maxFeePerGas:
          suggestedMaxFee > minimumMaxFee ? suggestedMaxFee : minimumMaxFee,
        maxPriorityFeePerGas: priorityFee,
        type: 2,
      },
      { address: wallet.address },
    );
    const hash = await rpc<string>("eth_sendRawTransaction", [signature]);
    await waitForReceipt(hash);
    return { hash };
  };
}

export async function readArcPaused(address: string) {
  const result = await rpc<string>("eth_call", [
    { to: address, data: "0x5c975abb" },
    "latest",
  ]);
  return BigInt(result) !== BigInt(0);
}

async function rpc<T>(method: string, params: unknown[] = []): Promise<T> {
  const response = await fetch(rpcUrl, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
    signal: AbortSignal.timeout(15_000),
  });
  const body = (await response.json().catch(() => {
    throw new Error(`Arc RPC ${method} returned HTTP ${response.status}`);
  })) as { result?: T; error?: { message?: string } };
  if (body.error) throw new Error(body.error.message || `Arc RPC ${method} failed`);
  if (!response.ok || body.result === undefined)
    throw new Error(`Arc RPC ${method} returned HTTP ${response.status}`);
  return body.result;
}

async function waitForReceipt(hash: string) {
  for (let attempt = 0; attempt < 60; attempt += 1) {
    const receipt = await rpc<{ status: string } | null>(
      "eth_getTransactionReceipt",
      [hash],
    );
    if (receipt) {
      if (receipt.status !== "0x1") throw new Error("Arc transaction reverted");
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 1_000));
  }
  throw new Error("Arc transaction confirmation timed out");
}
