"use client";

import {
  FormEvent,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import { useCreateWallet, usePrivy, useWallets } from "@privy-io/react-auth";
import { toast } from "sonner";
import {
  acceptInvitation,
  exchangePrivySession,
  getAgent,
  getApiBaseUrl,
  getUnreadNotificationCount,
  getSession,
  inviteOrganizationMember,
  listOrganizationMembers,
  listOrganizations,
  onboardOrganization,
  requestArcTestnetProvisioning,
  revokeSession,
  type AuthSessionResult,
  type BusinessAgentDetail,
  type MembershipRole,
  type OrganizationMember,
  type SessionUser,
  type UserOrganization,
  type NotificationView,
} from "@/lib/api";
import { LandingExperience } from "./landing-experience";
import { LifecycleWorkflows } from "./lifecycle-workflows";
import { TreasuryAuditViews } from "./treasury-audit-views";
import { VendorInvoiceWorkflows } from "./vendor-invoice-workflows";
import { OwnerTreasuryControls } from "./owner-treasury-controls";
import { WorkspaceSetup } from "./workspace-setup";
import { WorkspaceHistory } from "./workspace-history";
import { EmailInboxScreen } from "./email-inbox-screen";
import { AccountingIntegrations } from "./accounting-integrations";
import { NotificationCenter } from "./notification-center";
import { buildSetupChecklist, canExecute } from "@/lib/setup-checklist";
import { clearTenantCache, sessionStorageKeys } from "@/lib/session-cache";

const inviteRoles: MembershipRole[] = [
  "ADMIN",
  "APPROVER",
  "OPERATOR_VIEWER",
  "AUDITOR",
];
const storageEventName = "opes-storage";

export function AuthenticatedShell() {
  const {
    ready: privyReady,
    authenticated: privyAuthenticated,
    getAccessToken,
    login,
    logout: privyLogout,
  } = usePrivy();
  const { ready: walletsReady, wallets } = useWallets();
  const { createWallet } = useCreateWallet();
  const [token, setStoredToken] = useStoredValue(sessionStorageKeys.token, "");
  const [selectedOrganizationId, setSelectedOrganizationId] = useStoredValue(
    sessionStorageKeys.selectedOrganizationId,
    "",
  );
  const [onboarding, setOnboarding] = useState({
    organizationName: "",
    organizationSlug: "",
  });
  const [invitationToken, setInvitationToken] = useState("");
  const [inviteForm, setInviteForm] = useState({
    email: "",
    displayName: "",
    role: "APPROVER" as MembershipRole,
  });
  const [latestInvitationToken, setLatestInvitationToken] = useState("");
  const [user, setUser] = useState<SessionUser | null>(null);
  const [organizations, setOrganizations] = useState<UserOrganization[]>([]);
  const [agent, setAgent] = useState<BusinessAgentDetail | null>(null);
  const [members, setMembers] = useState<OrganizationMember[]>([]);
  const [workspaceView, setWorkspaceView] = useState<NotificationView>("overview");
  const [focusedInvoiceVersionId, setFocusedInvoiceVersionId] = useState<string | null>(null);
  const [notificationUnread, setNotificationUnread] = useState(0);
  const [actionPending, setActionPending] = useState(false);
  const privyExchangePending = useRef<Promise<AuthSessionResult> | null>(null);
  const isLoading = token !== "" && user === null;
  const clearFocusedInvoice = useCallback(() => setFocusedInvoiceVersionId(null), []);

  useEffect(() => {
    console.info("[OPES auth] state", {
      privyReady,
      walletsReady,
      privyAuthenticated,
      walletCount: wallets.length,
      hasOpesSession: token !== "",
    });
  }, [privyAuthenticated, privyReady, token, wallets.length, walletsReady]);

  const clearBrowserSession = useCallback(() => {
    privyExchangePending.current = null;
    clearTenantCache(localStorage);
    setStoredToken("");
    setSelectedOrganizationId("");
    setUser(null);
    setOrganizations([]);
    setAgent(null);
    setMembers([]);
    setNotificationUnread(0);
  }, [setSelectedOrganizationId, setStoredToken]);

  useEffect(() => {
    if (!privyAuthenticated) {
      privyExchangePending.current = null;
      return;
    }
    if (!privyReady || !walletsReady || token !== "") return;

    // Keep the request across SDK updates; only its effect subscriber is cancelled.
    if (!privyExchangePending.current) {
      privyExchangePending.current = (async () => {
        console.info("[OPES auth] starting Privy session exchange", {
          apiBaseUrl: getApiBaseUrl(),
          walletCount: wallets.length,
        });
        const hasEmbeddedEthereumWallet = wallets.some(
          (wallet) =>
            wallet.type === "ethereum" &&
            (wallet.walletClientType === "privy" || wallet.walletClientType === "privy-v2"),
        );
        console.info("[OPES auth] embedded Ethereum wallet check", { found: hasEmbeddedEthereumWallet });
        if (!hasEmbeddedEthereumWallet) {
          console.info("[OPES auth] creating embedded Ethereum wallet");
          await createWallet();
          console.info("[OPES auth] embedded Ethereum wallet created");
        }
        const accessToken = await getAccessToken();
        if (!accessToken) throw new Error("Privy session is unavailable");
        console.info("[OPES auth] Privy access token acquired; exchanging with OPES API");
        return exchangePrivySession(accessToken);
      })();
    }
    const exchange = privyExchangePending.current;
    let cancelled = false;
    void exchange.then((session) => {
      if (cancelled || privyExchangePending.current !== exchange) return;
      setStoredToken(session.sessionToken);
      console.info("[OPES auth] OPES session saved; loading workspace");
      toast.success("Workspace opened");
    }).catch(async (reason: unknown) => {
      if (cancelled || privyExchangePending.current !== exchange) return;
      console.error("[OPES auth] session exchange failed", reason);
      toast.error(reason instanceof Error ? reason.message : "Unable to sign in");
      await privyLogout().catch(() => undefined);
    });
    return () => { cancelled = true; };
  }, [createWallet, getAccessToken, privyAuthenticated, privyLogout, privyReady, setStoredToken, token, wallets, walletsReady]);

  useEffect(() => {
    if (token === "") return;

    let cancelled = false;

    Promise.all([getSession(token), listOrganizations(token)])
      .then(([nextUser, nextOrganizations]) => {
        console.info("[OPES auth] workspace session loaded", {
          userId: nextUser.id,
          organizationCount: nextOrganizations.length,
        });
        if (cancelled) return;
        setUser(nextUser);
        setOrganizations(nextOrganizations);
        if (
          !nextOrganizations.some((org) => org.id === selectedOrganizationId)
        ) {
          setSelectedOrganizationId(nextOrganizations[0]?.id ?? "");
        }
      })
      .catch((reason: unknown) => {
        console.error("[OPES auth] workspace session load failed", reason);
        if (cancelled) return;
        const message =
          reason instanceof Error ? reason.message : "Unable to load session";
        toast.error(message);
        clearBrowserSession();
        void privyLogout();
      });

    return () => {
      cancelled = true;
    };
  }, [
    clearBrowserSession,
    selectedOrganizationId,
    setSelectedOrganizationId,
    privyLogout, token,
  ]);

  useEffect(() => {
    if (token === "" || selectedOrganizationId === "") return;

    let cancelled = false;

    let timer: ReturnType<typeof setTimeout>;
    const refresh = () => Promise.all([
      getAgent(token, selectedOrganizationId),
      listOrganizationMembers(token, selectedOrganizationId),
    ])
      .then(([nextAgent, nextMembers]) => {
        if (cancelled) return;
        setAgent(nextAgent);
        setMembers(nextMembers);
        if (!canExecute(buildSetupChecklist(nextAgent, nextMembers))) {
          timer = setTimeout(() => { void refresh(); }, 10000);
        }
      })
      .catch((reason: unknown) => {
        if (cancelled) return;
        toast.error(reason instanceof Error ? reason.message : "Unable to load setup");
      });

    void refresh();
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [selectedOrganizationId, token]);

  useEffect(() => {
    if (!token || !selectedOrganizationId) return;
    let cancelled = false;
    const refresh = () => getUnreadNotificationCount(token, selectedOrganizationId)
      .then((result) => { if (!cancelled) setNotificationUnread(result.unread); })
      .catch(() => undefined);
    void refresh();
    const timer = setInterval(() => { void refresh(); }, 30_000);
    return () => { cancelled = true; clearInterval(timer); };
  }, [selectedOrganizationId, token]);

  const selectedOrganization = useMemo(
    () => organizations.find((org) => org.id === selectedOrganizationId),
    [organizations, selectedOrganizationId],
  );
  const setupChecks = useMemo(
    () => buildSetupChecklist(agent, members),
    [agent, members],
  );
  const setupComplete = canExecute(setupChecks);
  const arcBindings =
    agent?.resourceBindings.filter(
      (binding) => binding.environment === "arc-testnet",
    ) ?? [];
  const vaultAddress = arcBindings.find(
    (binding) => binding.resourceType === "business_policy_vault_contract",
  )?.address;
  const escrowAddress = arcBindings.find(
    (binding) => binding.resourceType === "milestone_escrow_contract",
  )?.address;
  const canManageMembers =
    selectedOrganization?.role === "OWNER" || selectedOrganization?.role === "ADMIN";

  async function submitOnboarding(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    await runAction(async () => {
      const result = await onboardOrganization(token, {
        organizationName: onboarding.organizationName,
        organizationSlug: onboarding.organizationSlug || undefined,
      });
      setOrganizations(await listOrganizations(token));
      setSelectedOrganizationId(result.organization.id);
      setWorkspaceView("setup");
      toast.success("Organization created. Wallet and contract setup has started.");
    });
  }

  async function submitInvitation(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    await runAction(async () => {
      const result = await acceptInvitation(token, invitationToken.trim());
      setOrganizations(await listOrganizations(token));
      setSelectedOrganizationId(result.organization.id);
      setInvitationToken("");
      toast.success("Invitation accepted. Workspace loaded.");
    });
  }

  function switchOrganization(nextOrganizationId: string) {
    if (selectedOrganizationId !== nextOrganizationId) {
      clearTenantCache(localStorage, selectedOrganizationId);
      setAgent(null);
      setMembers([]);
      setLatestInvitationToken("");
      setNotificationUnread(0);
    }
    setSelectedOrganizationId(nextOrganizationId);
    setWorkspaceView("overview");
  }

  async function submitInvite(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (selectedOrganizationId === "") return;
    await runAction(async () => {
      const invited = await inviteOrganizationMember(
        token,
        selectedOrganizationId,
        inviteForm,
      );
      setMembers((current) => [
        ...current.filter((member) => member.id !== invited.id),
        invited,
      ]);
      setLatestInvitationToken(invited.invitationToken);
      setInviteForm({ email: "", displayName: "", role: "APPROVER" });
      toast.success(`Invitation created for ${invited.email}.`);
    });
  }

  async function requestProvisioning() {
    if (selectedOrganizationId === "") return;
    await runAction(async () => {
      const binding = await requestArcTestnetProvisioning(
        token,
        selectedOrganizationId,
      );
      setAgent((current) =>
        current === null
          ? current
          : {
              ...current,
              resourceBindings: [
                ...current.resourceBindings.filter((item) => item.id !== binding.id),
                binding,
              ],
            },
      );
      toast.success("Arc factory provisioning is queued.");
    });
  }

  async function logout() {
    if (token !== "") {
      await revokeSession(token).catch(() => undefined);
    }
    try {
      await privyLogout();
    } finally {
      clearBrowserSession();
    }
  }

  async function runAction(work: () => Promise<void>) {
    setActionPending(true);
    try {
      await work();
    } catch (reason) {
      toast.error(reason instanceof Error ? reason.message : "Action failed");
    } finally {
      setActionPending(false);
    }
  }

  function openPrivyLogin() {
    console.info("[OPES auth] login requested", {
      privyReady,
      privyAuthenticated,
    });
    if (!privyReady) {
      console.warn("[OPES auth] login blocked because Privy is not ready");
      toast.error("Sign-in is still loading. Please try again.");
      return;
    }
    try {
      login();
      console.info("[OPES auth] Privy login modal requested");
    } catch (reason) {
      console.error("[OPES auth] Privy login invocation failed", reason);
      toast.error(reason instanceof Error ? reason.message : "Unable to open sign-in");
    }
  }

  return (
    <main className={token === "" ? "min-h-screen bg-[#f4f3ed] text-[#20251f]" : "min-h-screen bg-[#f4f3ed] text-slate-900"}>

      <section className={token === "" ? "" : "mx-auto flex w-full max-w-[1600px] flex-col gap-8 px-5 py-6 sm:px-6 lg:px-8"}>
        {token === "" ? (
          <LandingExperience
            onEnterWorkspace={openPrivyLogin}
            openingWorkspace={actionPending || privyAuthenticated}
          />
        ) : (
          <>
            <CommandHeader />
            <div className="grid gap-6 lg:grid-cols-[240px_minmax(0,1fr)]">
            <aside className="min-w-0 self-start rounded-2xl bg-[#20251f] p-5 text-white lg:sticky lg:top-6">
              <div className="flex items-start justify-between gap-4">
                <div>
                  <p className="text-xs uppercase tracking-[0.22em] text-slate-400">
                    Signed in
                  </p>
                  <p className="mt-2 font-semibold">{user?.displayName ?? "Loading..."}</p>
                  <p className="text-sm text-slate-400">{user?.email}</p>
                </div>
              </div>

              <label
                className="mt-8 block text-xs uppercase tracking-[0.22em] text-slate-400"
                htmlFor="organization"
              >
                Organization
              </label>
              <select
                id="organization"
                value={selectedOrganizationId}
                onChange={(event) => switchOrganization(event.target.value)}
                className="mt-2 min-h-12 w-full rounded-2xl border border-white/10 bg-slate-900 px-4 text-white outline-none ring-cyan-500 focus:ring-2"
              >
                {organizations.map((organization) => (
                  <option key={organization.id} value={organization.id}>
                    {organization.displayName}
                  </option>
                ))}
              </select>
              <p className="mt-4 text-sm leading-6 text-slate-400">
                One workspace. Every obligation accounted for.
              </p>
              <nav className="mt-6 flex gap-2 overflow-x-auto lg:grid" aria-label="Workspace views">
                {([ ["overview", "Overview", "Workspace status, setup progress, and next actions."], ["notifications", "Notifications", "Alerts for invoices, approvals, scheduled payments, and settlements."], ["setup", "Getting started", "Wallet, contract, funding, and integration setup."], ["invoices", "Invoices & vendors", "Verify vendors and turn invoice evidence into authorized payments."], ["agreements", "Agreements", "Manage recurring payments and milestone escrow agreements."], ["treasury", "Treasury & controls", "Review balances and forecasts, then set payment and emergency controls."], ["inbox", "Email inbox", "Review invoices and attachments received through your OPES address."], ["integrations", "Integrations", "Connect accounting systems and other evidence sources."], ["team", "Team", "Invite members and manage workspace access." ] ] as const).map(([value, label, summary]) => (
                  <button key={value} type="button" title={summary} aria-current={workspaceView === value ? "page" : undefined} disabled={!selectedOrganizationId} onClick={() => setWorkspaceView(value)} className={workspaceView === value ? "flex shrink-0 items-center justify-between gap-2 rounded-xl bg-[#dce8c6] px-4 py-3 text-left text-sm font-semibold text-slate-950" : "flex shrink-0 items-center justify-between gap-2 rounded-xl px-4 py-3 text-left text-sm text-slate-300 hover:bg-white/10 disabled:opacity-40"}><span>{label}</span>{value === "notifications" && notificationUnread > 0 ? <span className="rounded-full bg-cyan-400 px-2 py-0.5 text-xs font-bold text-slate-950">{notificationUnread > 99 ? "99+" : notificationUnread}</span> : null}</button>
                ))}
              </nav>
              <div className="mt-6 border-t border-white/15 pt-4">
                <button type="button" onClick={logout} className="w-full rounded-xl px-4 py-3 text-left text-sm text-slate-300 hover:bg-white/10">
                  Logout
                </button>
              </div>
            </aside>

            <section className="min-w-0 space-y-6 rounded-2xl border border-[#dedfd5] bg-white p-6 text-slate-950 md:p-8">
              <div className="flex flex-col gap-4 md:flex-row md:items-start md:justify-between">
                <div>
                  <p className="text-sm font-medium uppercase tracking-[0.22em] text-cyan-700">
                    Active workspace
                  </p>
                  <h2 className="mt-2 text-3xl font-semibold">
                    {selectedOrganization?.displayName ?? "No organization"}
                  </h2>
                </div>
                <div className="flex items-center gap-2"><button type="button" aria-label={`${notificationUnread} unread notifications`} onClick={() => setWorkspaceView("notifications")} className="relative flex size-11 items-center justify-center rounded-full border border-slate-200 text-slate-700 hover:bg-slate-50"><BellIcon />{notificationUnread > 0 ? <span className="absolute -right-1 -top-1 flex min-w-5 items-center justify-center rounded-full bg-cyan-600 px-1 text-[10px] font-bold text-white">{notificationUnread > 99 ? "99+" : notificationUnread}</span> : null}</button><StatusBadge label={selectedOrganization?.lifecycleStatus} /></div>
              </div>

              {isLoading ? <p className="text-slate-600">Loading...</p> : null}

              {workspaceView === "overview" || organizations.length === 0 ? <>
              {organizations.length === 0 && !isLoading ? (
                <div className="grid gap-6 lg:grid-cols-2">
                  <Panel title="Create organization">
                    <form onSubmit={submitOnboarding} className="space-y-4">
                      <TextInput label="Organization name" value={onboarding.organizationName} onChange={(organizationName) => setOnboarding((current) => ({ ...current, organizationName }))} required />
                      <TextInput label="Slug optional" value={onboarding.organizationSlug} onChange={(organizationSlug) => setOnboarding((current) => ({ ...current, organizationSlug }))} />
                      <button disabled={actionPending} className="min-h-12 w-full rounded-2xl bg-slate-950 px-6 font-semibold text-white disabled:opacity-50">Create workspace</button>
                    </form>
                  </Panel>
                  <Panel title="Accept invite">
                    <form onSubmit={submitInvitation} className="space-y-4">
                      <TextInput label="Invitation token" value={invitationToken} onChange={setInvitationToken} required />
                      <button disabled={actionPending} className="min-h-12 w-full rounded-2xl bg-slate-950 px-6 font-semibold text-white disabled:opacity-50">Accept invitation</button>
                    </form>
                  </Panel>
                </div>
              ) : null}

              {selectedOrganizationId ? <section className="overflow-hidden rounded-3xl bg-slate-950 text-white">
                <div className="grid gap-6 p-6 lg:grid-cols-[1fr_auto] lg:items-end lg:p-8"><div><p className="text-xs font-semibold uppercase tracking-[0.2em] text-cyan-300">Today’s focus</p><h3 className="mt-3 text-3xl font-semibold">{setupComplete ? "Your treasury is ready to act" : "Finish the controls behind every payment"}</h3><p className="mt-3 max-w-2xl text-sm leading-6 text-slate-300">{setupComplete ? "Review incoming obligations, evidence and available liquidity from one operating view." : "Complete the wallet, contract and policy steps before the agent can authorize execution."}</p></div><button className="btn bg-[#dce8c6] text-slate-950 hover:bg-white" onClick={() => setWorkspaceView(setupComplete ? "invoices" : "setup")}>{setupComplete ? "Review invoices" : "Continue setup"}</button></div>
                <div className="grid border-t border-white/10 sm:grid-cols-2 xl:grid-cols-4"><OverviewStat label="Your role" value={selectedOrganization?.role} /><OverviewStat label="Agent state" value={agent?.lifecycleStatus ?? selectedOrganization?.agentLifecycleStatus} /><OverviewStat label="Treasury network" value="Arc Testnet" /><OverviewStat label="Execution" value={setupComplete ? "Ready" : "Setup required"} /></div>
              </section> : null}

              {selectedOrganizationId ? <div className="grid gap-3 md:grid-cols-3"><QuickAction title="Capture an obligation" detail="Add a vendor and verify an invoice." onClick={() => setWorkspaceView("invoices")} /><QuickAction title="Inspect treasury" detail="See liquidity, budget and reserved funds." onClick={() => setWorkspaceView("treasury")} /><QuickAction title="Connect a source" detail="Receive email or accounting records." onClick={() => setWorkspaceView("inbox")} /></div> : null}

              {selectedOrganizationId !== "" ? (
                <WorkspaceHistory
                  key={selectedOrganizationId}
                  token={token}
                  organizationId={selectedOrganizationId}
                />
              ) : null}

              </> : null}
              {workspaceView === "setup" && selectedOrganizationId ? <WorkspaceSetup agent={agent} user={user} checks={setupChecks} canManage={canManageMembers} pending={actionPending} onRetry={requestProvisioning} onTreasury={() => setWorkspaceView("treasury")} onInbox={() => setWorkspaceView("inbox")} onIntegrations={() => setWorkspaceView("integrations")} /> : null}
              {workspaceView === "invoices" && selectedOrganizationId ? <VendorInvoiceWorkflows key={selectedOrganizationId} token={token} organizationId={selectedOrganizationId} initialInvoiceVersionId={focusedInvoiceVersionId} onInitialInvoiceHandled={clearFocusedInvoice} /> : null}
              {workspaceView === "agreements" && selectedOrganizationId ? <LifecycleWorkflows key={selectedOrganizationId} token={token} organizationId={selectedOrganizationId} /> : null}
              {workspaceView === "treasury" && selectedOrganizationId ? <><TreasuryAuditViews key={selectedOrganizationId} token={token} organizationId={selectedOrganizationId} /><Panel title="Owner controls">{setupComplete && selectedOrganization?.role === "OWNER" && vaultAddress && escrowAddress ? <OwnerTreasuryControls key={selectedOrganizationId} token={token} organizationId={selectedOrganizationId} vaultAddress={vaultAddress} escrowAddress={escrowAddress} /> : <p className="text-sm text-slate-600">Owner controls unlock after contract setup completes.</p>}</Panel></> : null}
              {workspaceView === "team" ? <section className="space-y-5" aria-labelledby="team-title">
                <div><p className="text-xs font-semibold uppercase tracking-[0.2em] text-cyan-700">Access and authority</p><h3 id="team-title" className="mt-2 text-3xl font-semibold">Team</h3><p className="mt-2 max-w-2xl text-sm leading-6 text-slate-600">Assign operational roles without sharing wallets or credentials. Every member action remains tied to this workspace.</p></div>
                <div className="grid gap-4 xl:grid-cols-2">
                {organizations.length > 0 ? (
                  <form onSubmit={submitInvitation} className="rounded-3xl border border-slate-200 bg-slate-50 p-5">
                    <h4 className="font-semibold">Join another workspace</h4><p className="mt-1 text-sm text-slate-500">Paste the one-time token shared by its owner.</p><div className="mt-4"><TextInput label="Invitation token" value={invitationToken} onChange={setInvitationToken} required /></div>
                    <button disabled={actionPending} className="btn mt-4">Accept invitation</button>
                  </form>
                ) : null}
                {canManageMembers ? (
                  <form onSubmit={submitInvite} className="grid gap-3 rounded-3xl bg-[#edf1e5] p-5 sm:grid-cols-2">
                    <div className="sm:col-span-2"><h4 className="font-semibold">Invite a teammate</h4><p className="mt-1 text-sm text-slate-600">Choose the narrowest role they need.</p></div>
                    <TextInput
                      label="Email"
                      type="email"
                      value={inviteForm.email}
                      onChange={(email) => setInviteForm((current) => ({ ...current, email }))}
                      required
                    />
                    <TextInput
                      label="Display name"
                      value={inviteForm.displayName}
                      onChange={(displayName) =>
                        setInviteForm((current) => ({ ...current, displayName }))
                      }
                    />
                    <LabelSelect
                      label="Role"
                      value={inviteForm.role}
                      options={inviteRoles}
                      onChange={(role) =>
                        setInviteForm((current) => ({
                          ...current,
                          role: role as MembershipRole,
                        }))
                      }
                      light
                    />
                    <button disabled={actionPending} className="btn self-end sm:col-span-2">
                      Invite
                    </button>
                  </form>
                ) : (
                  <p className="text-sm text-slate-600">
                    Only owners and admins can invite members. The backend enforces
                    this for every request.
                  </p>
                )}</div>

                {latestInvitationToken !== "" ? (
                  <p className="mt-4 rounded-2xl border border-cyan-200 bg-cyan-50 p-4 text-sm text-cyan-900">
                    Invitation token: <span className="break-all font-mono">{latestInvitationToken}</span>
                  </p>
                ) : null}

                <div><div className="flex items-end justify-between"><div><h4 className="text-lg font-semibold">Workspace members</h4><p className="mt-1 text-sm text-slate-500">{members.length} people with access</p></div></div><div className="mt-4 overflow-hidden rounded-2xl border border-slate-200">
                  {members.map((member) => (
                    <div
                      key={member.id}
                      className="grid gap-2 border-b border-slate-200 p-4 text-sm last:border-b-0 md:grid-cols-[1fr_160px_120px]"
                    >
                      <div>
                        <p className="font-semibold">{member.displayName}</p>
                        <p className="text-slate-600">{member.email}</p>
                      </div>
                      <p className="font-medium">{member.role.replaceAll("_", " ")}</p>
                      <StatusBadge label={member.status} />
                    </div>
                  ))}
                </div></div>
              </section> : null}

              {workspaceView === "inbox" && selectedOrganizationId !== "" ? <EmailInboxScreen key={selectedOrganizationId} token={token} organizationId={selectedOrganizationId} canManage={canManageMembers} /> : null}
              {workspaceView === "integrations" && selectedOrganizationId !== "" ? <AccountingIntegrations key={selectedOrganizationId} token={token} organizationId={selectedOrganizationId} canManage={canManageMembers} /> : null}
              {workspaceView === "notifications" && selectedOrganizationId !== "" ? <NotificationCenter key={selectedOrganizationId} token={token} organizationId={selectedOrganizationId} onNavigate={(view, invoiceVersionId) => { setFocusedInvoiceVersionId(invoiceVersionId ?? null); setWorkspaceView(view); }} onUnreadChange={setNotificationUnread} /> : null}
            </section>
          </div>
          </>
        )}
      </section>
    </main>
  );
}


function CommandHeader() {
  return (
    <header className="flex flex-col gap-5 border-b border-[#dedfd5] pb-6 md:flex-row md:items-center md:justify-between">
      <div>
        <p className="text-sm font-medium uppercase tracking-[0.28em] text-blue-700">
          OPES command center
        </p>
        <h1 className="mt-2 text-3xl font-semibold tracking-tight">
          Your treasury, in focus
        </h1>
        <p className="mt-2 max-w-2xl text-sm leading-6 text-slate-500">
          Know what is owed, what is available, and what happens next.
        </p>
      </div>
      <span className="inline-flex w-fit items-center gap-2 rounded-full border border-emerald-200 bg-emerald-50 px-4 py-2 text-sm font-medium text-emerald-800">
        <span aria-hidden="true" className="size-2 rounded-full bg-emerald-600" />
        Arc Testnet
      </span>
    </header>
  );
}

function useStoredValue(key: string, fallback: string) {
  const value = useSyncExternalStore(
    subscribeToStorage,
    () => localStorage.getItem(key) ?? fallback,
    () => fallback,
  );
  const setValue = useCallback(
    (nextValue: string) => {
      if (nextValue === "") {
        localStorage.removeItem(key);
      } else {
        localStorage.setItem(key, nextValue);
      }
      window.dispatchEvent(new Event(storageEventName));
    },
    [key],
  );

  return [value, setValue] as const;
}

function subscribeToStorage(onStoreChange: () => void) {
  window.addEventListener("storage", onStoreChange);
  window.addEventListener(storageEventName, onStoreChange);
  return () => {
    window.removeEventListener("storage", onStoreChange);
    window.removeEventListener(storageEventName, onStoreChange);
  };
}

function Panel({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="rounded-2xl border border-slate-200 bg-slate-50 p-5">
      <h3 className="font-semibold">{title}</h3>
      <div className="mt-4">{children}</div>
    </section>
  );
}

function TextInput({
  label,
  value,
  onChange,
  type = "text",
  required = false,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  type?: string;
  required?: boolean;
}) {
  return (
    <label className="block text-sm font-medium text-slate-700">
      {label}
      <input
        value={value}
        onChange={(event) => onChange(event.target.value)}
        required={required}
        type={type}
        className="mt-2 min-h-11 w-full rounded-2xl border border-slate-300 px-4 outline-none ring-cyan-500 focus:ring-2"
      />
    </label>
  );
}

function LabelSelect({
  label,
  value,
  options,
  onChange,
  light = false,
}: {
  label: string;
  value: string;
  options: string[];
  onChange: (value: string) => void;
  light?: boolean;
}) {
  return (
    <label className={light ? "block text-sm font-medium text-slate-700" : "block text-xs font-medium uppercase tracking-[0.18em] text-slate-400"}>
      {label}
      <select
        value={value}
        onChange={(event) => onChange(event.target.value)}
        className={
          light
            ? "mt-2 min-h-11 w-full rounded-2xl border border-slate-300 bg-white px-3 text-slate-950 outline-none ring-cyan-500 focus:ring-2"
            : "mt-2 min-h-11 w-full rounded-2xl border border-white/10 bg-slate-900 px-3 text-sm normal-case tracking-normal text-white outline-none ring-cyan-500 focus:ring-2"
        }
      >
        {options.map((option) => (
          <option key={option} value={option}>
            {option}
          </option>
        ))}
      </select>
    </label>
  );
}

function OverviewStat({ label, value }: { label: string; value?: string }) { return <div className="border-white/10 p-5 sm:border-r last:border-r-0"><p className="text-xs uppercase tracking-[0.18em] text-slate-400">{label}</p><p className="mt-2 font-semibold text-white">{value?.replaceAll("_", " ") ?? "—"}</p></div>; }
function QuickAction({ title, detail, onClick }: { title: string; detail: string; onClick: () => void }) { return <button type="button" onClick={onClick} className="group rounded-2xl border border-slate-200 p-5 text-left transition hover:border-cyan-400 hover:bg-cyan-50"><span className="font-semibold">{title} <span className="transition group-hover:translate-x-1">→</span></span><span className="mt-2 block text-sm leading-6 text-slate-500">{detail}</span></button>; }

function StatusBadge({ label }: { label?: string }) {
  return (
    <span className="w-fit rounded-full bg-cyan-100 px-4 py-2 text-sm font-semibold text-cyan-900">
      {label ?? "Unavailable"}
    </span>
  );
}

function BellIcon() { return <svg aria-hidden="true" viewBox="0 0 24 24" className="size-5 fill-none stroke-current" strokeWidth="1.8"><path d="M18 8a6 6 0 0 0-12 0c0 7-3 7-3 9h18c0-2-3-2-3-9" /><path d="M10 21h4" /></svg>; }
