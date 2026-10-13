#!/usr/bin/env bash
set -euo pipefail

matches="$({
  git grep -nE 'PRIVATE_KEY=.*0x[0-9a-fA-F]{64}' || true
  git grep -nE 'TEST_API_KEY:[A-Za-z0-9_-]{8,}:[A-Za-z0-9_-]{8,}|-----BEGIN [A-Z ]*PRIVATE KEY-----' || true
  git grep -nE '(sk-[A-Za-z0-9_-]{20,}|AKIA[0-9A-Z]{16}|gh[pousr]_[A-Za-z0-9]{30,}|xox[baprs]-[A-Za-z0-9-]{20,})' || true
} | sort -u)"

if [[ -n "$matches" ]]; then
  echo "Potential committed secret material found:"
  echo "$matches"
  exit 1
fi

echo "No committed secret material matched the release patterns."
