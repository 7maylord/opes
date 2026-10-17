import { expect, test, type Page, type Route } from "@playwright/test";

const orgId = "11111111-1111-1111-1111-111111111111";
const secondOrgId = "22222222-2222-2222-2222-222222222222";
const user = { id: "user-1", email: "owner@example.com", displayName: "Owner User", ownerWalletAddress: "0x5000000000000000000000000000000000000005" };
const organizations = [
  { id: orgId, slug: "alpha-co", displayName: "Alpha Co", lifecycleStatus: "SETUP_REQUIRED", membershipId: "member-owner", role: "OWNER", agentId: "agent-1", agentLifecycleStatus: "SETUP_REQUIRED" },
  { id: secondOrgId, slug: "beta-co", displayName: "Beta Co", lifecycleStatus: "PROVISIONING", membershipId: "member-admin", role: "ADMIN", agentId: "agent-2", agentLifecycleStatus: "PROVISIONING" },
];
const members = [{ id: "member-owner", userId: "user-1", email: "owner@example.com", displayName: "Owner User", role: "OWNER", status: "ACTIVE", createdAt: "2026-10-04T00:00:00.000Z" }];

type MockState = { onboarded: boolean; expiredSession: boolean };

async function installApiMock(page: Page, options: Partial<MockState> = {}) {
  const state: MockState = { onboarded: false, expiredSession: false, ...options };
  await page.route("http://mock.api/**", async (route) => respond(route, state));
  await page.route("http://mock.rpc/**", async (route) => {
    const method = (route.request().postDataJSON() as { method: string }).method;
    const result = method === "eth_chainId" ? "0x4cef52"
      : method === "eth_getTransactionCount" ? "0x0"
      : method === "eth_estimateGas" ? "0x10000"
      : method === "eth_gasPrice" ? "0x3b9aca00"
      : method === "eth_sendRawTransaction" ? `0x${"1".repeat(64)}`
      : method === "eth_getTransactionReceipt" ? { status: "0x1" }
      : method === "eth_call" ? "0x0"
      : null;
    await route.fulfill({ contentType: "application/json", body: JSON.stringify({ jsonrpc: "2.0", id: 1, result }) });
  });
}

async function openSignedIn(page: Page) {
  await installApiMock(page);
  await page.goto("/");
  await setSession(page, "mock-session-token");
  await expect(page.getByRole("heading", { name: "Alpha Co" })).toBeVisible();
}

async function setSession(page: Page, token: string) {
  await page.evaluate((nextToken) => {
    localStorage.setItem("opes:session-token", nextToken);
    localStorage.setItem("opes:e2e-wallet-created", "1");
    window.dispatchEvent(new Event("opes-storage"));
    window.dispatchEvent(new Event("opes-e2e-wallet"));
  }, token);
}

test("Privy email sign-in creates an embedded owner wallet before opening OPES", async ({ page }) => {
  await installApiMock(page);
  await page.goto("/?privy-auth=1");
  await expect(page.getByRole("heading", { name: "Alpha Co" })).toBeVisible();
  await expect.poll(() => page.evaluate(() => localStorage.getItem("opes:e2e-wallet-created"))).toBe("1");
  await expect.poll(() => page.evaluate(() => localStorage.getItem("opes:session-token"))).toBe("mock-session-token");
});

test("Privy session survives a rerender while the backend exchange is pending", async ({ page }) => {
  await installApiMock(page);
  let releaseExchange!: () => void;
  const gate = new Promise<void>((resolve) => { releaseExchange = resolve; });
  let exchanges = 0;
  await page.route("http://mock.api/auth/privy/session", async (route) => {
    exchanges += 1;
    await gate;
    await route.fallback();
  });
  await page.goto("/?privy-auth=1");
  await expect.poll(() => exchanges).toBe(1);
  await page.evaluate(() => {
    localStorage.setItem("opes:selected-organization-id", "11111111-1111-1111-1111-111111111111");
    window.dispatchEvent(new Event("opes-storage"));
  });
  await expect.poll(() => page.evaluate(() => new Promise((resolve) => {
    requestAnimationFrame(() => requestAnimationFrame(() => resolve(true)));
  }))).toBe(true);
  releaseExchange();
  await expect(page.getByRole("heading", { name: "Alpha Co" })).toBeVisible();
  expect(exchanges).toBe(1);
  expect(await page.evaluate(() => localStorage.getItem("opes:session-token"))).toBe("mock-session-token");
});

test("journey 1: owner creates organization and sees setup checklist", async ({ page }, testInfo) => {
  await installApiMock(page);
  await page.goto("/");
  await setSession(page, "new-user-token");
  await page.getByLabel("Organization name").fill("Alpha Co");
  await page.getByRole("button", { name: "Create workspace" }).click();
  await expect(page.getByText("Organization created. Wallet and contract setup has started.")).toBeVisible();
  await expect(page.getByText("Factory verified")).toBeVisible();
  await expect(page.getByRole("link", { name: "Open Circle USDC faucet" })).toHaveAttribute("href", "https://faucet.circle.com/");
  await expect(page.getByRole("button", { name: "Retry contract deployment" })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Copy owner wallet", exact: true })).toBeVisible();
  await expect(page.getByLabel("Vendor name")).toHaveCount(0);
  await page.screenshot({ path: testInfo.outputPath("workspace-setup.png"), fullPage: true });
});

test("journey 2: invite and accept member", async ({ page }) => {
  await openSignedIn(page);
  await page.getByRole("button", { name: "Team", exact: true }).click();
  await page.getByLabel("Email").fill("approver@example.com");
  await page.getByLabel("Display name").fill("Approver User");
  await page.getByRole("button", { name: "Invite" }).click();
  await expect(page.getByText("Invitation token:")).toBeVisible();
  await page.getByRole("button", { name: "Logout" }).click();
  await expect(page.getByRole("button", { name: "Enter workspace", exact: true })).toBeVisible();
  await setSession(page, "invitee-token");
  await page.getByLabel("Invitation token").fill("invite-token-123");
  await page.getByRole("button", { name: "Accept invitation" }).click();
  await expect(page.getByText("Invitation accepted. Workspace loaded.")).toBeVisible();
});

test("journey 3: invoice decision reaches owner-signature approval", async ({ page }) => {
  await openSignedIn(page);
  await page.getByRole("button", { name: "Invoices & vendors", exact: true }).click();
  await page.getByLabel("Vendor name").fill("Canteen Supplies");
  await page.getByRole("button", { name: "Create vendor" }).click();
  await page.getByLabel("Arc USDC payout address").fill("0x4000000000000000000000000000000000000004");
  await page.getByRole("button", { name: "Add address" }).click();
  await page.getByRole("button", { name: "Verify address" }).click();
  await page.getByRole("button", { name: "Authorize vendor" }).click();
  await page.getByLabel("Invoice number").fill("INV-100");
  await page.getByLabel("Invoice file").setInputFiles({
    name: "invoice.txt",
    mimeType: "text/plain",
    buffer: Buffer.from("Invoice INV-100 for 100 USDC"),
  });
  await page.getByRole("button", { name: "Upload and verify document" }).click();
  await page.getByRole("button", { name: "Extract invoice" }).click();
  await page.getByRole("button", { name: "Verify invoice" }).click();
  await page.getByRole("button", { name: "Generate agent decision" }).click();
  await expect(page.getByText("Decision dry run completed")).toBeVisible();
  await expect(page.getByRole("button", { name: "Approve", exact: true })).toBeEnabled();
});

test("journey 4: recurring subscription requires an owner-signed mandate", async ({ page }) => {
  await openSignedIn(page);
  await page.getByRole("button", { name: "Agreements", exact: true }).click();
  const subscription = page.getByRole("heading", { name: "Subscription", exact: true }).locator("xpath=ancestor::form");
  await subscription.getByRole("combobox").nth(0).selectOption("vendor-1");
  await subscription.getByRole("combobox").nth(1).selectOption("address-1");
  await page.getByRole("button", { name: "Create recurring agreement" }).click();
  await expect(page.getByText("Recurring agreement created")).toBeVisible();
  await expect(page.getByRole("button", { name: "Sign and activate mandate" })).toBeEnabled();
});

test("journey 5: escrow requires owner-signed setup before funding", async ({ page }) => {
  await openSignedIn(page);
  await page.getByRole("button", { name: "Agreements", exact: true }).click();
  await page.getByRole("tab", { name: "Milestone escrow" }).click();
  const escrow = page.getByRole("heading", { name: "Escrow agreement", exact: true }).locator("xpath=ancestor::form");
  await escrow.getByRole("combobox").nth(0).selectOption("vendor-1");
  await escrow.getByRole("combobox").nth(1).selectOption("address-1");
  await escrow.getByRole("combobox").nth(2).selectOption("doc-1");
  await page.getByRole("button", { name: "Create milestone agreement" }).click();
  await expect(page.getByText("Milestone agreement created")).toBeVisible();
  await expect(page.getByRole("button", { name: "Sign escrow setup" })).toBeEnabled();
});

test("journey 6: treasury separates planned from settled", async ({ page }) => {
  await openSignedIn(page);
  await page.getByRole("button", { name: "Treasury & controls", exact: true }).click();
  await page.getByRole("button", { name: "Refresh" }).click();
  await expect(page.getByText("Available to spend", { exact: true })).toBeVisible();
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
  const blockers = page.getByRole("heading", { name: "Payment blockers and exceptions" }).locator("..");
  await expect(blockers).toContainText("payout address changed");
  await expect(page.getByRole("heading", { name: "Evidence and authorization lineage" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Export lineage" })).toBeVisible();
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

test("workspace email inbox shows deliveries and accepted attachments", async ({ page }) => {
  await openSignedIn(page);
  await page.getByRole("button", { name: "Email inbox" }).click();
  await expect(page.getByRole("heading", { name: "Invoice email inbox" })).toBeVisible();
  await expect(page.locator('input[value="invoices@mail.maylord.xyz"]')).toBeVisible();
  await expect(page.getByRole("heading", { name: "Invoice INV-200" })).toBeVisible();
  await expect(page.getByText("invoice-200.pdf")).toBeVisible();
});

test("owner configures ERPNext and inspects tenant-scoped imports", async ({ page }) => {
  await openSignedIn(page);
  await page.getByRole("button", { name: "Integrations" }).click();
  await page.getByLabel("Connection label").fill("Finance sandbox");
  await page.getByLabel("Base URL").fill("https://erp.example.com");
  await page.getByLabel("API key").fill("key-id");
  await page.getByLabel("API secret").fill("secret-value");
  await page.getByRole("button", { name: "Save and start first sync" }).click();
  await expect(page.getByText("Integration saved and first sync queued")).toBeVisible();
  await expect(page.getByRole("heading", { name: "Finance sandbox" })).toBeVisible();
  await page.getByRole("button", { name: "Imported records" }).click();
  await expect(page.getByText(/4 current records/)).toBeVisible();
  expect(await page.evaluate(() => JSON.stringify(localStorage))).not.toContain("secret-value");
});

test("workspace notifications surface approvals and open the affected workflow", async ({ page }) => {
  await openSignedIn(page);
  await expect(page.getByLabel("2 unread notifications")).toBeVisible();
  await page.getByRole("navigation", { name: "Workspace views" }).getByRole("button", { name: /Notifications/ }).click();
  await expect(page.getByRole("heading", { name: "Invoice INV-200 received" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Invoice payment needs approval" })).toBeVisible();
  await page.getByRole("article").filter({ hasText: "Invoice payment needs approval" }).getByRole("button", { name: "Open" }).click();
  await expect(page.getByRole("heading", { name: "From invoice to authorized payment" })).toBeVisible();
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
  await setSession(page, "mock-session-token");
  await expect(page.getByText("Workspace history is temporarily unavailable")).toBeVisible();
  failing = false;
  await page.getByRole("button", { name: "Retry" }).click();
  await expect(page.getByRole("heading", { name: "Invoice INV-100", exact: true })).toBeVisible();
});

test("expired sessions clear the authenticated workspace", async ({ page }) => {
  await installApiMock(page, { expiredSession: true });
  await page.goto("/");
  await setSession(page, "expired-token");
  await expect(page.getByRole("button", { name: "Enter workspace" })).toBeVisible();
});

test("basic accessibility landmarks and labels are present", async ({ page }) => {
  await openSignedIn(page);
  await expect(page.locator("main")).toBeVisible();
  await expect(page.getByLabel("Organization")).toBeVisible();
  await expect(page.getByText("Arc Testnet", { exact: true }).first()).toBeVisible();
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
  if (method === "POST" && path === "auth/privy/session") return { user, sessionToken: "mock-session-token" };
  if (method === "DELETE" && path === "session") return { revoked: true };
  if (method === "GET" && path === "session") return user;
  if (method === "GET" && path === "organizations") return authorization === "Bearer mock-session-token" || state.onboarded ? organizations : [];
  if (method === "GET" && path.endsWith("/email-inbox")) return { id: "inbox-1", address: "invoices@mail.maylord.xyz", status: "ACTIVE" };
  if (method === "PUT" && path.endsWith("/email-inbox")) return { id: "inbox-1", address: body.address, status: "ACTIVE" };
  if (method === "GET" && path.endsWith("/email-inbox/events")) return [{ id: "email-event-1", providerEmailId: "resend-email-1", senderAddress: "vendor@example.com", subject: "Invoice INV-200", status: "PROCESSED", quarantineReason: null, failureReason: null, documentCount: 1, receivedAt: "2026-10-15T12:00:00.000Z", processedAt: "2026-10-15T12:00:01.000Z", documents: [{ id: "email-doc-1", filename: "invoice-200.pdf", status: "VERIFIED" }] }];
  if (method === "GET" && path.endsWith("/notifications/unread-count")) return { unread: 2 };
  if (method === "GET" && path.endsWith("/notifications")) return [
    { id: "notification-approval", type: "PAYMENT_APPROVAL_REQUIRED", priority: "ACTION", title: "Invoice payment needs approval", body: "INV-200 is above the autonomous payment limit.", subjectType: "payment_decision", subjectId: "decision-1", actionView: "invoices", metadata: {}, readAt: null, createdAt: "2026-10-16T09:00:00.000Z" },
    { id: "notification-invoice", type: "INVOICE_RECEIVED", priority: "INFO", title: "Invoice INV-200 received", body: "The invoice is ready for review.", subjectType: "payable_obligation", subjectId: "obligation-1", actionView: "invoices", metadata: {}, readAt: null, createdAt: "2026-10-16T08:00:00.000Z" },
  ];
  if (method === "POST" && path.includes("/notifications/")) return { read: true };
  if (method === "GET" && path.endsWith("/accounting-connectors")) return [];
  if (method === "POST" && path.endsWith("/accounting-connectors")) return { id: "connector-1", provider: body.provider, label: body.label, baseUrl: body.baseUrl, databaseName: null, status: "ACTIVE", syncCursor: null, lastSyncedAt: null, lastError: null };
  if (method === "POST" && path.endsWith("/accounting-connectors/connector-1/sync")) return { queued: true };
  if (method === "GET" && path.endsWith("/accounting-connectors/connector-1/records")) return ["VENDOR", "PURCHASE_ORDER", "PURCHASE_RECEIPT", "VENDOR_BILL"].map((recordType, index) => ({ id: `record-${index}`, connectorId: "connector-1", recordType, externalId: `external-${index}`, providerUpdatedAt: null, normalizedData: {}, fetchedAt: "2026-10-15T12:00:00.000Z" }));
  if (method === "GET" && path.endsWith("/agent")) return { id: "agent-1", lifecycleStatus: "SETUP_REQUIRED", arcTestnetFactory: { environment: "arc-testnet", chainId: 5042002, factoryAddress: "0x6b3aa0d68Fba3Ff8add42071ba82E714b5a6a488", vaultDeployerAddress: "0x0E44C2D694592F50B4f42ACFB9E1E106b15474D8", verification: "fully_verified", explorerUrl: "https://explorer.testnet.arc.io/address/0x6b3aa0d68Fba3Ff8add42071ba82E714b5a6a488", checkedAt: "2026-10-04T00:00:00.000Z" }, resourceBindings: path.startsWith(`organizations/${orgId}`) ? activeBindings() : [] };
  if (method === "GET" && path.endsWith("/members")) return members;
  if ((method === "GET" && path.endsWith("/treasury/position")) || (method === "PUT" && path.endsWith("/treasury/settings"))) return { assetSymbol: "USDC", configured: true, snapshotStatus: "FRESH", snapshotObservedAt: "2026-10-14T00:00:00.000Z", authorizationReady: true, verifiedBalanceAtomic: "10000000", restrictedBalanceAtomic: "1000000", operatingBalanceAtomic: "9000000", reservedAtomic: "500000", committedPayablesAtomic: "2500000", approvedUnsettledPaymentAtomic: "1000000", plannedIncomingAtomic: "500000", inTransitAtomic: "250000", operatingBufferAtomic: "1000000", monthlyBudgetAtomic: "10000000", monthlyBudgetRemainingAtomic: "7500000", forecast30DaysAtomic: "2500000", forecast90DaysAtomic: "4000000", availableLiquidityAtomic: "6500000", supportedNetworks: [{ environment: "arc-testnet", chainId: 5042002, family: "arc", tier: "testnet", cctpContracts: {}, gatewayContracts: {}, gateway: true, cctpExecutable: true, gatewayExecutable: true }, { environment: "base-sepolia", chainId: 84532, family: "base", tier: "testnet", cctpContracts: {}, gatewayContracts: {}, gateway: true, cctpExecutable: true, gatewayExecutable: true }, { environment: "arbitrum-sepolia", chainId: 421614, family: "arbitrum", tier: "testnet", cctpContracts: {}, gatewayContracts: null, gateway: false, cctpExecutable: false, gatewayExecutable: false }] };
  if (method === "GET" && path.includes("/workspace/")) return workspaceResponse(path);
  if (path === "onboarding") return { user, organization: organizations[0], membership: { id: "member-owner", role: "OWNER" }, agent: { id: "agent-1", lifecycleStatus: "PROVISIONING" } };
  if (path.startsWith("organization-invitations/")) return { user, organization: organizations[0], membership: members[0] };
  if (path.endsWith("/members")) return { id: "member-invited", userId: "user-2", email: body.email, displayName: body.displayName, role: body.role, status: "INVITED", createdAt: "2026-10-04T00:00:00.000Z", invitationToken: "invite-token-123" };
  if (path.endsWith("/agent/provisioning/arc-testnet")) return binding("factory-1", "arc", "factory_provisioning", null, "PENDING");
  if (path.endsWith("/vendors")) return { id: "vendor-1", displayName: body.displayName, status: "PENDING_REVIEW", version: 1, metadata: {} };
  if (path.includes("/vendors/") && path.endsWith("/addresses")) return { id: "address-1", vendorId: "vendor-1", environment: body.environment, chainId: body.chainId, assetSymbol: body.assetSymbol, assetAddress: body.assetAddress, payoutAddress: body.payoutAddress, status: "PENDING_REVIEW", version: 1, replacesAddressId: null };
  if (path.includes("/vendor-addresses/")) return { id: "address-1", vendorId: "vendor-1", environment: "arc-testnet", chainId: 5042002, assetSymbol: "USDC", assetAddress: "0x3600000000000000000000000000000000000000", payoutAddress: "0x4000000000000000000000000000000000000004", status: "VERIFIED_ACTIVE", version: 1, replacesAddressId: null };
  if (path.endsWith("/treasury-actions")) return chainAction("vendor-action", String(body.action));
  if (path.includes("/lifecycle-actions/") && path.endsWith("/confirm")) return { ...chainAction("vendor-action", "SET_VENDOR"), status: "CONFIRMED", transactionHash: body.transactionHash };
  if (path.endsWith("/evidence-documents/uploads")) return { document: { id: "doc-1", ...body, status: "STAGING", storageKey: "staging/doc-1", metadata: {} }, uploadUrl: "http://mock.api/upload/doc-1", uploadHeaders: { "content-type": "text/plain" } };
  if (path.endsWith("/evidence-documents/doc-1/finalize")) return { id: "doc-1", documentType: "INVOICE", filename: "invoice.txt", contentType: "text/plain", sizeBytes: 30, sha256Hex: "a".repeat(64), storageKey: "documents/doc-1", status: "VERIFIED", metadata: {} };
  if (path.endsWith("/evidence-documents/doc-1/extract")) return { id: "extract-1", documentId: "doc-1", schemaName: "invoice", schemaVersion: "2", modelProvider: "deepseek", modelName: "deepseek-flash", sourceSha256Hex: "a".repeat(64), output: { invoiceNumber: "INV-100", amount: "100", payoutAddress: "0x4000000000000000000000000000000000000004" }, status: "ACCEPTED", claimVersionId: "claim-1", reviewStatus: "CONFIRMED" };
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
    subscription: [], escrow: [], ledger: [], audit: [], connector: [],
  };
  const items = path.includes(secondOrgId) ? [] : records[kind ?? ""] ?? [];
  const isDetail = parts.at(-3) === "workspace";
  return isDetail ? {
    record: items.find((item) => item.id === parts.at(-1)),
    history: [{ id: "audit-1", eventType: "invoice.verified", status: "RECORDED", transactionHash: null, createdAt: "2026-10-04T00:00:00.000Z", details: {} }],
    lineage: [
      { id: "doc-1", type: "evidence", label: "invoice.txt", status: "VERIFIED", transactionHash: null, createdAt: "2026-10-04T00:00:00.000Z", details: { sha256Hex: "abc" } },
      { id: "decision-1", type: "policy_decision", label: "Policy decision", status: "BLOCK", transactionHash: null, createdAt: "2026-10-04T00:01:00.000Z", details: { checks: [{ message: "payout address changed" }] } },
    ],
    blockers: [{ code: "POLICY_DECISION:BLOCK", message: "Policy decision: payout address changed", sourceId: "decision-1" }],
  } : { items, nextCursor: null };
}

function workspaceRecord(id: string, kind: string, title: string, subtitle: string, status: string, amountAtomic: string | null, assetSymbol: string | null, details: Record<string, unknown>) {
  return { id, kind, title, subtitle, status, amountAtomic, assetSymbol, chainId: null, transactionHash: null, createdAt: "2026-10-04T00:00:00.000Z", updatedAt: "2026-10-04T00:00:00.000Z", details };
}
