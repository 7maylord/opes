import assert from "node:assert/strict";
import { test } from "node:test";
import { buildSetupChecklist, canExecute } from "../.next-test/setup-checklist.js";

const owner = {
  id: "member-1",
  userId: "user-1",
  email: "owner@example.com",
  displayName: "Owner",
  role: "OWNER",
  status: "ACTIVE",
  createdAt: "2026-10-04T00:00:00.000Z",
};

function agent(bindings) {
  return {
    id: "agent-1",
    lifecycleStatus: "SETUP_REQUIRED",
    arcTestnetFactory: {
      environment: "arc-testnet",
      chainId: 5042002,
      factoryAddress: "0xfactory",
      vaultDeployerAddress: "0xdeployer",
      verification: "fully_verified",
      explorerUrl: "https://explorer.testnet.arc.io/address/0xfactory",
      checkedAt: "2026-10-04T00:00:00.000Z",
    },
    resourceBindings: bindings,
  };
}

function binding(resourceType, status = "ACTIVE") {
  return {
    id: resourceType,
    environment: "arc-testnet",
    chainId: 5042002,
    provider: "arc",
    resourceType,
    resourceId: "org-1",
    address: status === "ACTIVE" ? "0x1111111111111111111111111111111111111111" : null,
    status,
    metadata: {},
  };
}

test("requires every active setup binding before execution", () => {
  const checks = buildSetupChecklist(
    agent([
      binding("operator_wallet"),
      binding("business_policy_vault_contract"),
      binding("milestone_escrow_contract", "PENDING"),
    ]),
    [owner],
  );

  assert.equal(canExecute(checks), false);
  assert.equal(
    checks.find((check) => check.label === "Escrow active")?.complete,
    false,
  );
});

test("allows execution only when setup is complete", () => {
  const checks = buildSetupChecklist(
    agent([
      binding("operator_wallet"),
      binding("business_policy_vault_contract"),
      binding("milestone_escrow_contract"),
    ]),
    [owner],
  );

  assert.equal(canExecute(checks), true);
});
