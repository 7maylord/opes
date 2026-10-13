import { expect, test, type Page, type Route } from "@playwright/test";

const orgId = "11111111-1111-1111-1111-111111111111";
const secondOrgId = "22222222-2222-2222-2222-222222222222";
const user = { id: "user-1", email: "owner@example.com", displayName: "Owner User" };
const organizations = [
  { id: orgId, slug: "alpha-co", displayName: "Alpha Co", lifecycleStatus: "SETUP_REQUIRED", membershipId: "member-owner", role: "OWNER", agentId: "agent-1", agentLifecycleStatus: "SETUP_REQUIRED" },
  { id: secondOrgId, slug: "beta-co", displayName: "Beta Co", lifecycleStatus: "PROVISIONING", membershipId: "member-admin", role: "ADMIN", agentId: "agent-2", agentLifecycleStatus: "PROVISIONING" },
];
const members = [{ id: "member-owner", userId: "user-1", email: "owner@example.com", displayName: "Owner User", role: "OWNER", status: "ACTIVE", createdAt: "2026-10-04T00:00:00.000Z" }];

type MockState = { onboarded: boolean; expiredSession: boolean };

async function installApiMock(page: Page, options: Partial<MockState> = {}) {
  const state: MockState = { onboarded: false, expiredSession: false, ...options };
  await page.route("http://mock.api/**", async (route) => respond(route, state));
}

async function openSignedIn(page: Page) {
  await installApiMock(page);
  await page.goto("/");
  await page.evaluate(() => localStorage.setItem("opes:session-token", "mock-session-token"));
  await page.reload();
  await expect(page.getByRole("heading", { name: "Alpha Co" })).toBeVisible();
}

test("journey 1: owner creates organization and sees setup checklist", async ({ page }) => {
  await installApiMock(page);
  await page.goto("/");
  await page.evaluate(() => localStorage.setItem("opes:session-token", "new-user-token"));
  await page.reload();
  await page.getByLabel("Organization name").fill("Alpha Co");
  await page.getByRole("button", { name: "Create and queue setup" }).click();
  await expect(page.getByText("Organization created. Arc setup is queued.")).toBeVisible();
  await expect(page.getByText("Factory verified")).toBeVisible();
  await expect(page.getByRole("button", { name: "Queue Arc contract setup" })).toBeVisible();
});

test("journey 2: invite and accept member", async ({ page }) => {
  await openSignedIn(page);
  await page.getByLabel("Email").fill("approver@example.com");
  await page.getByLabel("Display name").fill("Approver User");
  await page.getByRole("button", { name: "Invite" }).click();
  await expect(page.getByText("Invitation token:")).toBeVisible();
  await page.getByRole("button", { name: "Logout" }).click();
  await page.evaluate(() => localStorage.setItem("opes:session-token", "invitee-token"));
  await page.reload();
  await page.getByLabel("Invitation token").fill("invite-token-123");
  await page.getByRole("button", { name: "Accept invitation" }).click();
  await expect(page.getByText("Invitation accepted. Workspace loaded.")).toBeVisible();
});

test("journey 3: invoice decision reaches owner-signature approval", async ({ page }) => {
  await openSignedIn(page);
  await page.getByLabel("Vendor name").fill("Canteen Supplies");
  await page.getByRole("button", { name: "Create vendor" }).click();
  await page.getByLabel("Arc USDC payout address").fill("0x4000000000000000000000000000000000000004");
  await page.getByRole("button", { name: "Add address" }).click();
  await page.getByRole("button", { name: "Verify address" }).click();
  await page.getByLabel("Invoice number").fill("INV-100");
  await page.getByLabel("Invoice file").setInputFiles({
    name: "invoice.txt",
    mimeType: "text/plain",
    buffer: Buffer.from("Invoice INV-100 for 100 USDC"),
  });
  await page.getByRole("button", { name: "Upload and verify document" }).click();
  await page.getByRole("button", { name: "Extract invoice" }).click();
  await page.getByRole("button", { name: "Verify invoice" }).click({ force: true });
  await page.getByRole("button", { name: "Generate agent decision" }).click({ force: true });
  await expect(page.getByText("Decision dry run completed")).toBeVisible();
  await expect(page.getByRole("button", { name: "Approve", exact: true })).toBeEnabled();
});

test("journey 4: recurring subscription requires an owner-signed mandate", async ({ page }) => {
  await openSignedIn(page);
  const subscription = page.getByRole("heading", { name: "Subscription", exact: true }).locator("..");
  await subscription.getByRole("combobox").nth(0).selectOption("vendor-1");
  await subscription.getByRole("combobox").nth(1).selectOption("address-1");
  await page.getByRole("button", { name: "Create subscription" }).click();
  await expect(page.getByText("Subscription status:")).toBeVisible();
  await expect(page.getByRole("button", { name: "Sign and activate mandate" })).toBeEnabled();
});

test("journey 5: escrow requires owner-signed setup before funding", async ({ page }) => {
  await openSignedIn(page);
  const escrow = page.getByRole("heading", { name: "Escrow agreement", exact: true }).locator("..");
  await escrow.getByRole("combobox").nth(0).selectOption("vendor-1");
  await escrow.getByRole("combobox").nth(1).selectOption("address-1");
  await escrow.getByRole("combobox").nth(2).selectOption("doc-1");
  await page.getByRole("button", { name: "Create escrow" }).click();
  await expect(page.getByText("Escrow agreement created")).toBeVisible();
  await expect(page.getByRole("button", { name: "Sign escrow setup" })).toBeEnabled();
});

test("journey 6: treasury separates planned from settled", async ({ page }) => {
  await openSignedIn(page);
  await page.getByRole("button", { name: "Refresh" }).click();
  await expect(page.getByText("Planned liquidity", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Plan route" }).click();
  await expect(page.getByText("PLANNED", { exact: true })).toBeVisible();
  const projection = page.getByRole("heading", { name: "Ledger projection" }).locator("..");
  await projection.getByRole("combobox").nth(0).selectOption("invoice-version-1");
  await page.getByRole("button", { name: "Accrue invoice" }).click();
  await expect(page.getByText("Invoice accrual projected")).toBeVisible();
  await projection.getByRole("combobox").nth(1).selectOption("execution-1");
  await page.getByRole("button", { name: "Settle payment" }).click();
  await expect(page.getByText("Payment settlement projected")).toBeVisible();
});

test("journey 7: persisted invoice opens with its audit timeline", async ({ page }) => {
  await openSignedIn(page);
  await expect(page.getByRole("heading", { name: "History and evidence" })).toBeVisible();
  await page.getByRole("button", { name: "View detail" }).first().click();
  await expect(page.getByRole("complementary").getByRole("heading", { name: "Invoice INV-100" })).toBeVisible();
  await expect(page.getByText("invoice verified")).toBeVisible();
});

test("journey 8: keyboard tenant switching and responsive shell", async ({ page }) => {
  await openSignedIn(page);
  await page.keyboard.press("Tab");
  await page.keyboard.press("Tab");
  await page.keyboard.press("Tab");
  await page.getByLabel("Organization").selectOption(secondOrgId);
  await expect(page.getByRole("heading", { name: "Beta Co" })).toBeVisible();
  await expect(page.getByText("No invoices match this view.")).toBeVisible();
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(page.getByText("OPES command center")).toBeVisible();
});

test("workspace history exposes an error and recovers on retry", async ({ page }) => {
  await installApiMock(page);
  let failing = true;
  await page.route("http://mock.api/**", async (route) => {
    const url = new URL(route.request().url());
    if (failing && url.pathname.includes("/workspace/invoice") && url.searchParams.get("limit") === "12") {
      await route.fulfill({ status: 503, contentType: "application/json", body: JSON.stringify({ message: "Workspace history is temporarily unavailable" }) });
      return;
    }
    await route.fallback();
  });
  await page.goto("/");
  await page.evaluate(() => localStorage.setItem("opes:session-token", "mock-session-token"));
  await page.reload();
  await expect(page.getByText("Workspace history is temporarily unavailable")).toBeVisible();
  failing = false;
  await page.getByRole("button", { name: "Retry" }).click();
  await expect(page.getByRole("heading", { name: "Invoice INV-100", exact: true })).toBeVisible();
});

test("expired sessions clear the authenticated workspace", async ({ page }) => {
  await installApiMock(page, { expiredSession: true });
  await page.goto("/");
  await page.evaluate(() => localStorage.setItem("opes:session-token", "expired-token"));
  await page.reload();
  await expect(page.getByRole("button", { name: /Sign in with email/i })).toBeVisible();
});

test("basic accessibility landmarks and labels are present", async ({ page }) => {
  await openSignedIn(page);
  await expect(page.locator("main")).toBeVisible();
  await expect(page.getByLabel("Organization")).toBeVisible();
  await expect(page.getByLabel("Network")).toBeVisible();
  await expect(page.getByLabel("Mode")).toBeVisible();
});

async function respond(route: Route, state: MockState) {
  const request = route.request();
  const url = new URL(request.url());
  const path = url.pathname.slice(1);
  let body: Record<string, unknown> = {};
  if (request.method() !== "GET") {
    try {
      body = request.postDataJSON() as Record<string, unknown>;
    } catch {}
  }
  if (path === "onboarding") state.onboarded = true;
  if (request.method() === "GET" && path === "session" && state.expiredSession) {
    await route.fulfill({ status: 401, contentType: "application/json", body: JSON.stringify({ message: "Session is invalid or expired" }) });
    return;
  }
  await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(responseFor(request.method(), path, body, request.headers().authorization, state)) });
}

function responseFor(method: string, path: string, body: Record<string, unknown>, authorization: string | undefined, state: MockState) {
  if (method === "DELETE" && path === "session") return { revoked: true };
  if (method === "GET" && path === "session") return user;
  if (method === "GET" && path === "organizations") return authorization === "Bearer mock-session-token" || state.onboarded ? organizations : [];
  if (method === "GET" && path.endsWith("/agent")) return { id: "agent-1", lifecycleStatus: "SETUP_REQUIRED", arcTestnetFactory: { environment: "arc-testnet", chainId: 5042002, factoryAddress: "0x6b3aa0d68Fba3Ff8add42071ba82E714b5a6a488", vaultDeployerAddress: "0x0E44C2D694592F50B4f42ACFB9E1E106b15474D8", verification: "fully_verified", explorerUrl: "https://explorer.testnet.arc.io/address/0x6b3aa0d68Fba3Ff8add42071ba82E714b5a6a488", checkedAt: "2026-10-04T00:00:00.000Z" }, resourceBindings: path.startsWith(`organizations/${orgId}`) ? activeBindings() : [] };
  if (method === "GET" && path.endsWith("/members")) return members;
  if (method === "GET" && path.endsWith("/treasury/position")) return { assetSymbol: "USDC", committedPayablesAtomic: "2500000", approvedUnsettledPaymentAtomic: "1000000", plannedLiquidityAtomic: "500000", supportedNetworks: [{ environment: "arc-testnet", chainId: 5042002, family: "arc", tier: "testnet", cctpContracts: {}, gatewayContracts: {}, gateway: true, cctpExecutable: true, gatewayExecutable: true }, { environment: "base-sepolia", chainId: 84532, family: "base", tier: "testnet", cctpContracts: {}, gatewayContracts: {}, gateway: true, cctpExecutable: true, gatewayExecutable: true }, { environment: "arbitrum-sepolia", chainId: 421614, family: "arbitrum", tier: "testnet", cctpContracts: {}, gatewayContracts: null, gateway: false, cctpExecutable: false, gatewayExecutable: false }] };
  if (method === "GET" && path.includes("/workspace/")) return workspaceResponse(path);
  if (path === "onboarding") return { user, organization: organizations[0], membership: { id: "member-owner", role: "OWNER" }, agent: { id: "agent-1", lifecycleStatus: "PROVISIONING" } };
  if (path.startsWith("organization-invitations/")) return { user, organization: organizations[0], membership: members[0] };
  if (path.endsWith("/members")) return { id: "member-invited", userId: "user-2", email: body.email, displayName: body.displayName, role: body.role, status: "INVITED", createdAt: "2026-10-04T00:00:00.000Z", invitationToken: "invite-token-123" };
  if (path.endsWith("/agent/provisioning/arc-testnet")) return binding("factory-1", "arc", "factory_provisioning", null, "PENDING");
  if (path.endsWith("/vendors")) return { id: "vendor-1", displayName: body.displayName, status: "PENDING_REVIEW", version: 1, metadata: {} };
  if (path.includes("/vendors/") && path.endsWith("/addresses")) return { id: "address-1", vendorId: "vendor-1", environment: body.environment, chainId: body.chainId, assetSymbol: body.assetSymbol, assetAddress: body.assetAddress, payoutAddress: body.payoutAddress, status: "PENDING_REVIEW", version: 1, replacesAddressId: null };
  if (path.includes("/vendor-addresses/")) return { id: "address-1", vendorId: "vendor-1", environment: "arc-testnet", chainId: 5042002, assetSymbol: "USDC", assetAddress: "0x3600000000000000000000000000000000000000", payoutAddress: "0x4000000000000000000000000000000000000004", status: "VERIFIED_ACTIVE", version: 1, replacesAddressId: null };
  if (path.endsWith("/evidence-documents/uploads")) return { document: { id: "doc-1", ...body, status: "STAGING", storageKey: "staging/doc-1", metadata: {} }, uploadUrl: "http://mock.api/upload/doc-1", uploadHeaders: { "content-type": "text/plain" } };
  if (path.endsWith("/evidence-documents/doc-1/finalize")) return { id: "doc-1", documentType: "INVOICE", filename: "invoice.txt", contentType: "text/plain", sizeBytes: 30, sha256Hex: "a".repeat(64), storageKey: "documents/doc-1", status: "VERIFIED", metadata: {} };
  if (path.endsWith("/evidence-documents/doc-1/extract")) return { id: "extract-1", documentId: "doc-1", schemaName: "invoice", schemaVersion: "1", modelProvider: "deepseek", modelName: "deepseek-flash", sourceSha256Hex: "a".repeat(64), output: { invoiceNumber: "INV-100", amount: "100", payoutAddress: "0x4000000000000000000000000000000000000004" }, status: "ACCEPTED" };
  if (path.endsWith("/invoices/verify")) return { id: "obligation-1", versionId: "invoice-version-1", version: 1, ...body, extractionId: body.extractionId ?? null, amountAtomic: "100000000", amountDecimals: 6, obligationKey: "obligation-key", contentHash: "content-hash", status: "ACCEPTED" };
  if (path.endsWith("/decisions/invoice-payment/agent")) {
    const route = body.route as {
      liquidityRoute: string;
      environment: string;
      chainId: number;
      assetSymbol: string;
    };
    return { id: "decision-1", sourceType: "PAYABLE_OBLIGATION", sourceId: "obligation-1", sourceVersionId: body.invoiceVersionId, decisionVersion: 1, paymentMode: "DIRECT", modelAction: "PAY", derivedAction: "PAY", liquidityRoute: route.liquidityRoute, routeEnvironment: route.environment, routeChainId: route.chainId, routeAssetSymbol: route.assetSymbol, amountAtomic: "100000000", destinationAddress: "0x4000000000000000000000000000000000000004", evidenceBundleHash: "hash", policySnapshotHash: "policy", contextHash: "context", decisionHash: "decisionhash", checks: [{ code: "route", status: "PASS", message: "route supported" }], expiresAt: body.expiresAt };
  }
  if (path.endsWith("/decisions/decision-1/authorize")) return { id: "approval-1", decisionId: "decision-1", decisionVersion: 1, sourceVersionId: "invoice-version-1", amountAtomic: "100000000", destinationAddress: "0x4000000000000000000000000000000000000004", contextHash: "context", policySnapshotHash: "policy", status: "ACTIVE", expiresAt: "2026-10-04T01:00:00.000Z" };
  if (path.endsWith("/decisions/decision-1/execute")) return { id: "execution-1", decisionId: "decision-1", approvalId: "approval-1", sourceVersionId: "invoice-version-1", decisionHash: "decisionhash", idempotencyKey: "key", contextHash: "context", amountAtomic: "100000000", destinationAddress: "0x4000000000000000000000000000000000000004", routeEnvironment: "arc-testnet", routeChainId: 5042002, routeAssetSymbol: "USDC", vaultAddress: "0x2000000000000000000000000000000000000002", status: "PENDING", failureReason: null, transactionHash: null };
  if (path.endsWith("/subscriptions")) return { id: "subscription-1", versionId: "subscription-version-1", version: 1, status: "SETUP_REQUIRED", cadence: body.cadence, anchorDate: body.anchorDate, timezone: body.timezone, amountAtomic: "100000000", ownerActions: [chainAction("mandate-action", "CREATE_RECURRING_MANDATE")] };
  if (path.endsWith("/subscriptions/subscription-1/cycles")) return { id: "cycle-1", subscriptionId: "subscription-1", subscriptionVersionId: "subscription-version-1", servicePeriodStart: body.servicePeriodStart, servicePeriodEnd: "2026-11-04", dueAt: "2026-11-04T00:00:00.000Z", amountAtomic: "100000000", status: "DUE" };
  if (path.endsWith("/subscriptions/subscription-1/cancel")) return { id: "subscription-1", status: "CANCELLED" };
  if (path.endsWith("/escrow-agreements")) return { id: "agreement-1", status: "SETUP_REQUIRED", totalAmountAtomic: "100000000", ownerActions: [chainAction("escrow-action", "CREATE_ESCROW_AGREEMENT")], milestones: [{ id: "milestone-1", agreementId: "agreement-1", milestoneIndex: 0, title: "Kickoff", amountAtomic: "50000000", status: "PENDING", evidenceDocumentId: null }] };
  if (path.endsWith("/escrow-milestones/milestone-1/submissions")) return { id: "milestone-1", agreementId: "agreement-1", milestoneIndex: 0, title: "Kickoff", amountAtomic: "50000000", status: "SUBMITTED", evidenceDocumentId: body.evidenceDocumentId };
  if (path.endsWith("/escrow-milestones/milestone-1/accept")) return { id: "milestone-1", agreementId: "agreement-1", milestoneIndex: 0, title: "Kickoff", amountAtomic: "50000000", status: "ACCEPTED", evidenceDocumentId: "doc-1" };
  if (path.endsWith("/escrow-milestones/milestone-1/dispute")) return { id: "milestone-1", agreementId: "agreement-1", milestoneIndex: 0, title: "Kickoff", amountAtomic: "50000000", status: "DISPUTED", evidenceDocumentId: "doc-1" };
  if (path.endsWith("/liquidity-actions")) return { id: "liquidity-1", actionType: body.actionType, idempotencyKey: body.idempotencyKey, provider: "circle-gateway", simulated: true, status: "PLANNED", source: body.source, destination: body.destination, amountAtomic: body.amountAtomic, feeAtomic: "0", quoteExpiresAt: body.quoteExpiresAt, providerReference: null, providerPayload: { mode: "unified-balance-transfer" }, failureReason: null };
  if (path.endsWith("/ledger/invoice-versions/invoice-version-1/accrue")) return ledger("INVOICE_ACCEPTED", "invoice-version-1");
  if (path.endsWith("/ledger/payment-executions/execution-1/settle")) return ledger("PAYMENT_SETTLED", "execution-1");
  return { message: `Unhandled ${method} ${path}` };
}

function chainAction(id:string, actionType:string) { return { id, actionType, actor:'OWNER', to:'0x2000000000000000000000000000000000000002', data:'0x1234', chainId:5042002, status:'PREPARED' }; }

function activeBindings() {
  return [
    binding("wallet-1", "circle", "operator_wallet", "0x1000000000000000000000000000000000000001"),
    binding("vault-1", "arc", "business_policy_vault_contract", "0x2000000000000000000000000000000000000002"),
    binding("escrow-1", "arc", "milestone_escrow_contract", "0x3000000000000000000000000000000000000003"),
  ];
}

function binding(id: string, provider: string, resourceType: string, address: string | null, status = "ACTIVE") {
  return { id, environment: "arc-testnet", chainId: 5042002, provider, resourceType, resourceId: orgId, address, status, metadata: {} };
}

function ledger(type: string, id: string) {
  return [
    { id: `${id}-1`, ledgerEventType: type, ledgerEventId: id, lineNumber: 1, account: "EXPENSE:PAYABLES", direction: "DEBIT", assetSymbol: "USDC", amountAtomic: "100000000", sourceType: "TEST", sourceId: id, sourceVersionId: null, counterpartyId: "vendor-1", transactionHash: type === "PAYMENT_SETTLED" ? "0xtx" : null },
    { id: `${id}-2`, ledgerEventType: type, ledgerEventId: id, lineNumber: 2, account: "LIABILITY:ACCOUNTS_PAYABLE", direction: "CREDIT", assetSymbol: "USDC", amountAtomic: "100000000", sourceType: "TEST", sourceId: id, sourceVersionId: null, counterpartyId: "vendor-1", transactionHash: type === "PAYMENT_SETTLED" ? "0xtx" : null },
  ];
}

function workspaceResponse(path: string) {
  const parts = path.split("/");
  const kind = parts.at(-2) === "workspace" ? parts.at(-1) : parts.at(-2);
  const records: Record<string, Array<Record<string, unknown>>> = {
    vendor: [workspaceRecord("vendor-1", "vendor", "Canteen Supplies", "Vendor", "VERIFIED", null, null, { addresses: [{ id: "address-1", environment: "arc-testnet", assetSymbol: "USDC", payoutAddress: "0x4000000000000000000000000000000000000004", status: "VERIFIED_ACTIVE" }] })],
    evidence: [workspaceRecord("doc-1", "evidence", "invoice.txt", "INVOICE", "RECORDED", null, null, {})],
    invoice: [workspaceRecord("invoice-version-1", "invoice", "Invoice INV-100", "Canteen Supplies", "ACCEPTED", "100000000", "USDC", { invoiceNumber: "INV-100", vendorId: "vendor-1" })],
    decision: [],
    execution: [workspaceRecord("execution-1", "execution", "Payment execution", "arc-testnet", "CONFIRMED", "100000000", "USDC", {})],
    subscription: [], escrow: [], ledger: [], audit: [],
  };
  const items = path.includes(secondOrgId) ? [] : records[kind ?? ""] ?? [];
  const isDetail = parts.at(-3) === "workspace";
  return isDetail ? { record: items.find((item) => item.id === parts.at(-1)), history: [{ id: "audit-1", eventType: "invoice.verified", status: "RECORDED", transactionHash: null, createdAt: "2026-10-04T00:00:00.000Z", details: {} }] } : { items, nextCursor: null };
}

function workspaceRecord(id: string, kind: string, title: string, subtitle: string, status: string, amountAtomic: string | null, assetSymbol: string | null, details: Record<string, unknown>) {
  return { id, kind, title, subtitle, status, amountAtomic, assetSymbol, chainId: null, transactionHash: null, createdAt: "2026-10-04T00:00:00.000Z", updatedAt: "2026-10-04T00:00:00.000Z", details };
}
