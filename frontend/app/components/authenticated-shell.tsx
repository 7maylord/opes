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
import { buildSetupChecklist, canExecute } from "@/lib/setup-checklist";
import { clearTenantCache, sessionStorageKeys } from "@/lib/session-cache";

const networkOptions = [
  "Arc testnet",
  "Base Sepolia",
  "Arbitrum Sepolia",
  "Celo Sepolia",
  "Ethereum Sepolia",
  "Monad testnet",
];

const executionOptions = ["Simulation", "Live testnet", "Mainnet disabled"];
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
  const [networkLabel, setNetworkLabel] = useStoredValue(
    sessionStorageKeys.networkLabel,
    networkOptions[0],
  );
  const [executionLabel, setExecutionLabel] = useStoredValue(
    sessionStorageKeys.executionLabel,
    executionOptions[0],
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
  const [workspaceView, setWorkspaceView] = useState<"overview" | "setup" | "invoices" | "agreements" | "treasury" | "team" | "inbox" | "integrations">("overview");
  const [actionPending, setActionPending] = useState(false);
  const privyExchangePending = useRef<Promise<AuthSessionResult> | null>(null);
  const isLoading = token !== "" && user === null;

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

  const selectedOrganization = useMemo(
    () => organizations.find((org) => org.id === selectedOrganizationId),
    [organizations, selectedOrganizationId],
  );
  const setupChecks = useMemo(
    () => buildSetupChecklist(agent, members),
    [agent, members],
  );
  const setupComplete = canExecute(setupChecks);
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
            <CommandHeader
              networkLabel={networkLabel}
              executionLabel={executionLabel}
              setNetworkLabel={setNetworkLabel}
              setExecutionLabel={setExecutionLabel}
            />
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
                <button
                  onClick={logout}
                  className="rounded-full border border-white/15 px-3 py-1 text-sm text-slate-200 hover:bg-white/10"
                >
                  Logout
                </button>
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
                {([ ["overview", "Overview"], ["setup", "Getting started"], ["invoices", "Invoices & vendors"], ["agreements", "Agreements"], ["treasury", "Treasury & controls"], ["inbox", "Email inbox"], ["integrations", "Integrations"], ["team", "Team"] ] as const).map(([value, label]) => (
                  <button key={value} type="button" aria-current={workspaceView === value ? "page" : undefined} disabled={!selectedOrganizationId} onClick={() => setWorkspaceView(value)} className={workspaceView === value ? "shrink-0 rounded-xl bg-[#dce8c6] px-4 py-3 text-left text-sm font-semibold text-slate-950" : "shrink-0 rounded-xl px-4 py-3 text-left text-sm text-slate-300 hover:bg-white/10 disabled:opacity-40"}>{label}</button>
                ))}
              </nav>
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
                <StatusBadge label={selectedOrganization?.lifecycleStatus} />
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

              <div className="grid gap-4 md:grid-cols-4">
                <InfoCard label="Role" value={selectedOrganization?.role} />
                <InfoCard label="Agent" value={agent?.lifecycleStatus ?? selectedOrganization?.agentLifecycleStatus} />
                <InfoCard label="Network" value={networkLabel} />
                <InfoCard label="Execution" value={setupComplete ? executionLabel : "Locked"} />
              </div>

              {selectedOrganizationId ? <div className="flex flex-wrap items-center justify-between gap-4 rounded-2xl bg-[#edf1e5] p-6"><div><h3 className="text-xl font-semibold">{setupComplete ? "Your contracts are ready" : "Finish setting up your workspace"}</h3><p className="mt-2 text-sm text-slate-600">{setupComplete ? "Review funding and spending rules before your first payment." : "Follow wallet creation, fund your treasury and configure your payment rules."}</p></div><button className="btn" onClick={() => setWorkspaceView(setupComplete ? "invoices" : "setup")}>{setupComplete ? "Open invoices" : "Continue setup"}</button></div> : null}

              {selectedOrganizationId !== "" ? (
                <WorkspaceHistory
                  key={selectedOrganizationId}
                  token={token}
                  organizationId={selectedOrganizationId}
                />
              ) : null}

              </> : null}
              {workspaceView === "setup" && selectedOrganizationId ? <WorkspaceSetup agent={agent} user={user} checks={setupChecks} canManage={canManageMembers} pending={actionPending} onRetry={requestProvisioning} onTreasury={() => setWorkspaceView("treasury")} onInbox={() => setWorkspaceView("inbox")} onIntegrations={() => setWorkspaceView("integrations")} /> : null}
              {workspaceView === "invoices" && selectedOrganizationId ? <VendorInvoiceWorkflows key={selectedOrganizationId} token={token} organizationId={selectedOrganizationId} /> : null}
              {workspaceView === "agreements" && selectedOrganizationId ? <LifecycleWorkflows key={selectedOrganizationId} token={token} organizationId={selectedOrganizationId} /> : null}
              {workspaceView === "treasury" && selectedOrganizationId ? <><TreasuryAuditViews key={selectedOrganizationId} token={token} organizationId={selectedOrganizationId} /><Panel title="Owner controls">{setupComplete && selectedOrganization?.role === "OWNER" ? <OwnerTreasuryControls key={selectedOrganizationId} token={token} organizationId={selectedOrganizationId} /> : <p className="text-sm text-slate-600">Owner controls unlock after contract setup completes.</p>}</Panel></> : null}
              {workspaceView === "team" ? <>
              <Panel title="Members and invitations">
                {organizations.length > 0 ? (
                  <form onSubmit={submitInvitation} className="mb-6 flex flex-col gap-3 border-b border-slate-200 pb-6 sm:flex-row">
                    <div className="flex-1"><TextInput label="Invitation token" value={invitationToken} onChange={setInvitationToken} required /></div>
                    <button disabled={actionPending} className="min-h-11 self-end rounded-2xl bg-slate-950 px-5 font-semibold text-white disabled:opacity-50">Accept invitation</button>
                  </form>
                ) : null}
                {canManageMembers ? (
                  <form onSubmit={submitInvite} className="grid gap-3 md:grid-cols-[1fr_1fr_180px_auto]">
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
                    <button
                      disabled={actionPending}
                      className="min-h-11 self-end rounded-2xl bg-slate-950 px-5 font-semibold text-white hover:bg-slate-800 disabled:opacity-50"
                    >
                      Invite
                    </button>
                  </form>
                ) : (
                  <p className="text-sm text-slate-600">
                    Only owners and admins can invite members. The backend enforces
                    this for every request.
                  </p>
                )}

                {latestInvitationToken !== "" ? (
                  <p className="mt-4 rounded-2xl border border-cyan-200 bg-cyan-50 p-4 text-sm text-cyan-900">
                    Invitation token: <span className="break-all font-mono">{latestInvitationToken}</span>
                  </p>
                ) : null}

                <div className="mt-5 overflow-hidden rounded-2xl border border-slate-200">
                  {members.map((member) => (
                    <div
                      key={member.id}
                      className="grid gap-2 border-b border-slate-200 p-4 text-sm last:border-b-0 md:grid-cols-[1fr_160px_120px]"
                    >
                      <div>
                        <p className="font-semibold">{member.displayName}</p>
                        <p className="text-slate-600">{member.email}</p>
                      </div>
                      <p>{member.role}</p>
                      <p>{member.status}</p>
                    </div>
                  ))}
                </div>
              </Panel>
              </> : null}

              {workspaceView === "inbox" && selectedOrganizationId !== "" ? <EmailInboxScreen key={selectedOrganizationId} token={token} organizationId={selectedOrganizationId} canManage={canManageMembers} /> : null}
              {workspaceView === "integrations" && selectedOrganizationId !== "" ? <AccountingIntegrations key={selectedOrganizationId} token={token} organizationId={selectedOrganizationId} canManage={canManageMembers} /> : null}
            </section>
          </div>
          </>
        )}
      </section>
    </main>
  );
}


function CommandHeader({
  networkLabel,
  executionLabel,
  setNetworkLabel,
  setExecutionLabel,
}: {
  networkLabel: string;
  executionLabel: string;
  setNetworkLabel: (value: string) => void;
  setExecutionLabel: (value: string) => void;
}) {
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
      <div className="grid gap-3 text-sm sm:grid-cols-2">
        <LabelSelect
          light
          label="Network"
          value={networkLabel}
          options={networkOptions}
          onChange={setNetworkLabel}
        />
        <LabelSelect
          light
          label="Mode"
          value={executionLabel}
          options={executionOptions}
          onChange={setExecutionLabel}
        />
      </div>
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

function InfoCard({ label, value }: { label: string; value?: string }) {
  return (
    <div className="rounded-2xl border border-slate-200 p-4">
      <p className="text-xs uppercase tracking-[0.18em] text-slate-500">{label}</p>
      <p className="mt-2 font-semibold text-slate-950">{value ?? "—"}</p>
    </div>
  );
}

function StatusBadge({ label }: { label?: string }) {
  return (
    <span className="w-fit rounded-full bg-cyan-100 px-4 py-2 text-sm font-semibold text-cyan-900">
      {label ?? "Unavailable"}
    </span>
  );
}
