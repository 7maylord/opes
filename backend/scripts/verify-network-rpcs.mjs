import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { supportedNetworks } = require('../dist/liquidity-policy.js');
const required = new Set(
  (process.env.OPES_REQUIRED_RPC_ENVIRONMENTS ?? 'arc-testnet,base-sepolia')
    .split(',')
    .map((value) => value.trim())
    .filter(Boolean),
);
const failures = [];

for (const network of supportedNetworks()) {
  const key = `OPES_RPC_${network.environment.toUpperCase().replaceAll('-', '_')}`;
  const url = process.env[key]?.trim();
  if (!url) {
    if (required.has(network.environment)) failures.push(`${network.environment}: ${key} is missing`);
    continue;
  }

  try {
    const chainId = Number(BigInt(await rpc(url, 'eth_chainId')));
    if (chainId !== network.chainId) throw new Error(`expected chain ${network.chainId}, received ${chainId}`);
    const addresses = new Set([
      network.usdc,
      ...Object.values(network.cctpContracts ?? {}),
      ...Object.values(network.gatewayContracts ?? {}),
    ]);
    for (const address of addresses) {
      const code = await rpc(url, 'eth_getCode', [address, 'latest']);
      if (code === '0x') throw new Error(`no code at ${address}`);
    }
    const decimals = Number(BigInt(await rpc(url, 'eth_call', [{ to: network.usdc, data: '0x313ce567' }, 'latest'])));
    if (decimals !== 6) throw new Error(`USDC decimals are ${decimals}, expected 6`);
    process.stdout.write(`${network.environment}: chain ${chainId}, USDC and provider code verified\n`);
  } catch (error) {
    failures.push(`${network.environment}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

if (failures.length) {
  process.stderr.write(`${failures.join('\n')}\n`);
  process.exitCode = 1;
}

async function rpc(url, method, params = []) {
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
    signal: AbortSignal.timeout(15_000),
  });
  if (!response.ok) throw new Error(`${method} returned HTTP ${response.status}`);
  const body = await response.json();
  if (body.error) throw new Error(`${method}: ${body.error.message ?? 'RPC error'}`);
  if (body.result === undefined) throw new Error(`${method}: missing result`);
  return body.result;
}
