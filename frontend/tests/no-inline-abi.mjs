import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";

const roots = ["app", "lib"];
const inlineAbiPatterns = [/const\s+\w*abi\w*\s*=\s*\[/i, /"type"\s*:\s*"function"/];

test("frontend app and lib do not contain inline ABI fragments", async () => {
  const offenders = [];
  for (const file of await sourceFiles(".")) {
    const text = await readFile(file, "utf8");
    if (inlineAbiPatterns.some((pattern) => pattern.test(text))) {
      offenders.push(file);
    }
  }

  assert.deepEqual(offenders, []);
});

async function sourceFiles(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      if (roots.includes(path) || roots.some((root) => path.startsWith(`${root}/`))) {
        files.push(...(await sourceFiles(path)));
      }
    } else if (/\.(ts|tsx)$/.test(entry.name) && roots.some((root) => path.startsWith(`${root}/`))) {
      files.push(path);
    }
  }
  return files;
}
