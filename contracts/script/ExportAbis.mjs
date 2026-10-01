import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const args = process.argv.slice(2);
if (args.length > 1 || (args.length === 1 && args[0] !== '--check')) {
  throw new Error('Usage: node contracts/script/ExportAbis.mjs [--check]');
}
const check = args[0] === '--check';
const root = fileURLToPath(new URL('../../', import.meta.url));
const contracts = join(root, 'contracts');

// Compile before reading artifacts so a stale build cannot bless stale exports.
execFileSync('forge', ['build', '--root', contracts], { stdio: 'inherit' });

const names = ['BusinessPolicyVault', 'MilestoneEscrow', 'IERC20Metadata'];
const outputs = names.flatMap((name) => {
  const artifact = JSON.parse(readFileSync(join(contracts, 'out', `${name}.sol`, `${name}.json`), 'utf8'));
  if (!Array.isArray(artifact.abi) || artifact.abi.length === 0) {
    throw new Error(`Missing ABI in ${name} artifact`);
  }
  const content = `${JSON.stringify(artifact.abi, null, 2)}\n`;
  return ['frontend/abi', 'backend/src/abi'].map((directory) => ({
    path: join(root, directory, `${name}.json`),
    content,
  }));
});

for (const { path, content } of outputs) {
  if (check) {
    let actual;
    try {
      actual = readFileSync(path, 'utf8');
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
    if (actual !== content) {
      console.error(`Missing or stale ABI: ${path}`);
      process.exitCode = 1;
    }
  } else {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, content);
  }
}

if (process.exitCode) {
  console.error('Run node contracts/script/ExportAbis.mjs and commit the generated files.');
} else {
  console.log(`${check ? 'Checked' : 'Exported'} ${outputs.length} ABI files.`);
}
