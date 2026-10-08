"use client";

import {
  FormEvent,
  useCallback,
  useEffect,
  useMemo,
  useState,
  useSyncExternalStore,
} from "react";
import {
  ApiError,
  acceptInvitation,
  getAgent,
  getApiBaseUrl,
  getSession,
  inviteOrganizationMember,
  listOrganizationMembers,
  listOrganizations,
  onboardOrganization,
  requestArcTestnetProvisioning,
  revokeSession,
  type BusinessAgentDetail,
  type MembershipRole,
  type OrganizationMember,
  type SessionUser,
  type UserOrganization,
} from "@/lib/api";
import { LifecycleWorkflows } from "./lifecycle-workflows";
import { TreasuryAuditViews } from "./treasury-audit-views";
import { VendorInvoiceWorkflows } from "./vendor-invoice-workflows";
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

const landingMetrics = [
  ["3k", "atomic USDC moved in the latest Arc smoke"],
  ["0", "custody shortcuts in the browser"],
  ["6", "chain families mapped for treasury routes"],
] as const;

const landingPillars = [
  [
    "Source truth",
    "Invoices, vendors, milestones and approvals become stable obligations before a signer sees them.",
  ],
  [
    "Policy vault",
    "Tenant contracts enforce owners, operators, pausers, vendors, limits and replay-safe execution.",
  ],
  [
    "Settlement ledger",
    "Gateway, CCTP, swaps and same-chain payments reconcile into auditable postings instead of screenshots.",
  ],
] as const;

const routeSteps = [
  "Vendor evidence",
  "Human approval",
  "Vault execution",
  "Crosschain liquidity",
  "Ledger close",
] as const;

export function AuthenticatedShell() {
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
  const [tokenDraft, setTokenDraft] = useState("");
  const [onboarding, setOnboarding] = useState({
    email: "",
    displayName: "",
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
  const [error, setError] = useState("");
  const [actionMessage, setActionMessage] = useState("");
  const [actionPending, setActionPending] = useState(false);
  const isLoading = token !== "" && user === null && error === "";

  const clearBrowserSession = useCallback(() => {
    clearTenantCache(localStorage);
    setStoredToken("");
    setSelectedOrganizationId("");
    setUser(null);
    setOrganizations([]);
    setAgent(null);
    setMembers([]);
    setError("");
    setActionMessage("");
  }, [setSelectedOrganizationId, setStoredToken]);

  useEffect(() => {
    if (token === "") return;

    let cancelled = false;

    Promise.all([getSession(token), listOrganizations(token)])
      .then(([nextUser, nextOrganizations]) => {
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
        if (cancelled) return;
        const message =
          reason instanceof Error ? reason.message : "Unable to load session";
        setError(message);
        if (reason instanceof ApiError && reason.status === 401) {
          clearBrowserSession();
        }
      });

    return () => {
      cancelled = true;
    };
  }, [
    clearBrowserSession,
    selectedOrganizationId,
    setSelectedOrganizationId,
    token,
  ]);

  useEffect(() => {
    if (token === "" || selectedOrganizationId === "") return;

    let cancelled = false;

    Promise.all([
      getAgent(token, selectedOrganizationId),
      listOrganizationMembers(token, selectedOrganizationId),
    ])
      .then(([nextAgent, nextMembers]) => {
        if (cancelled) return;
        setAgent(nextAgent);
        setMembers(nextMembers);
      })
      .catch((reason: unknown) => {
        if (cancelled) return;
        setError(reason instanceof Error ? reason.message : "Unable to load setup");
      });

    return () => {
      cancelled = true;
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

  function saveToken(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const nextToken = tokenDraft.trim();
    if (nextToken === "") {
      setError("Paste a backend session token first.");
      return;
    }
    setError("");
    setStoredToken(nextToken);
    setTokenDraft("");
  }

  async function submitOnboarding(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    await runAction(async () => {
      const result = await onboardOrganization({
        email: onboarding.email,
        displayName: onboarding.displayName,
        organizationName: onboarding.organizationName,
        organizationSlug: onboarding.organizationSlug || undefined,
      });
      setStoredToken(result.sessionToken);
      setSelectedOrganizationId(result.organization.id);
      setActionMessage("Organization created. Arc setup is queued.");
    });
  }

  async function submitInvitation(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    await runAction(async () => {
      const result = await acceptInvitation(invitationToken.trim());
      setStoredToken(result.sessionToken);
      setSelectedOrganizationId(result.organization.id);
      setInvitationToken("");
      setActionMessage("Invitation accepted. Workspace loaded.");
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
      setActionMessage(`Invitation created for ${invited.email}.`);
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
      setActionMessage("Arc factory provisioning is queued.");
    });
  }

  async function logout() {
    if (token !== "") {
      await revokeSession(token).catch(() => undefined);
    }
    clearBrowserSession();
  }

  async function runAction(work: () => Promise<void>) {
    setActionPending(true);
    setError("");
    setActionMessage("");
    try {
      await work();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Action failed");
    } finally {
      setActionPending(false);
    }
  }

  return (
    <main className="min-h-screen overflow-hidden bg-slate-950 text-slate-100">
      <div className="pointer-events-none fixed inset-0 -z-10 bg-[radial-gradient(circle_at_15%_20%,rgba(34,211,238,0.24),transparent_32%),radial-gradient(circle_at_86%_6%,rgba(20,184,166,0.20),transparent_30%),linear-gradient(135deg,#020617_0%,#0f172a_48%,#111827_100%)]" />
      <section className="mx-auto flex w-full max-w-7xl flex-col gap-8 px-5 py-6 sm:px-6 lg:px-8">
        {token === "" ? (
          <>
            <LandingHeader
              networkLabel={networkLabel}
              executionLabel={executionLabel}
              setNetworkLabel={setNetworkLabel}
              setExecutionLabel={setExecutionLabel}
            />
            <LandingHero />
            <div id="access" className="grid gap-6 lg:grid-cols-3">
            <AuthCard title="Create organization" className="lg:col-span-2">
              <form onSubmit={submitOnboarding} className="grid gap-4 md:grid-cols-2">
                <TextInput
                  label="Work email"
                  type="email"
                  value={onboarding.email}
                  onChange={(email) => setOnboarding((current) => ({ ...current, email }))}
                  required
                />
                <TextInput
                  label="Your name"
                  value={onboarding.displayName}
                  onChange={(displayName) =>
                    setOnboarding((current) => ({ ...current, displayName }))
                  }
                  required
                />
                <TextInput
                  label="Organization name"
                  value={onboarding.organizationName}
                  onChange={(organizationName) =>
                    setOnboarding((current) => ({ ...current, organizationName }))
                  }
                  required
                />
                <TextInput
                  label="Slug optional"
                  value={onboarding.organizationSlug}
                  onChange={(organizationSlug) =>
                    setOnboarding((current) => ({ ...current, organizationSlug }))
                  }
                />
                <button
                  disabled={actionPending}
                  className="min-h-12 rounded-2xl bg-slate-950 px-6 font-semibold text-white hover:bg-slate-800 disabled:opacity-50 md:col-span-2"
                >
                  Create and queue setup
                </button>
              </form>
            </AuthCard>

            <AuthCard title="Accept invite">
              <form onSubmit={submitInvitation} className="space-y-4">
                <TextInput
                  label="Invitation token"
                  value={invitationToken}
                  onChange={setInvitationToken}
                  required
                />
                <button
                  disabled={actionPending}
                  className="min-h-12 w-full rounded-2xl bg-slate-950 px-6 font-semibold text-white hover:bg-slate-800 disabled:opacity-50"
                >
                  Accept invitation
                </button>
              </form>
            </AuthCard>

            <AuthCard title="Use existing session" className="lg:col-span-3">
              <form onSubmit={saveToken} className="flex flex-col gap-3 md:flex-row">
                <input
                  aria-label="Backend session token"
                  value={tokenDraft}
                  onChange={(event) => setTokenDraft(event.target.value)}
                  className="min-h-12 flex-1 rounded-2xl border border-slate-300 px-4 outline-none ring-cyan-500 focus:ring-2"
                  placeholder="Backend session token"
                  type="password"
                />
                <button className="min-h-12 rounded-2xl bg-slate-950 px-6 font-semibold text-white hover:bg-slate-800">
                  Load workspace
                </button>
              </form>
              <p className="mt-4 text-xs text-slate-500">API: {getApiBaseUrl()}</p>
            </AuthCard>
            <Messages error={error} actionMessage={actionMessage} />
          </div>
          </>
        ) : (
          <>
            <CommandHeader
              networkLabel={networkLabel}
              executionLabel={executionLabel}
              setNetworkLabel={setNetworkLabel}
              setExecutionLabel={setExecutionLabel}
            />
            <div className="grid gap-6 lg:grid-cols-[320px_1fr]">
            <aside className="rounded-3xl border border-white/10 bg-white/[0.04] p-5">
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
                Switching organizations clears tenant-scoped browser cache before
                loading the next workspace.
              </p>
            </aside>

            <section className="space-y-6 rounded-3xl border border-white/10 bg-white p-6 text-slate-950 shadow-xl md:p-8">
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

              <Messages error={error} actionMessage={actionMessage} />
              {isLoading ? <p className="text-slate-600">Loading...</p> : null}

              <div className="grid gap-4 md:grid-cols-4">
                <InfoCard label="Role" value={selectedOrganization?.role} />
                <InfoCard label="Agent" value={agent?.lifecycleStatus ?? selectedOrganization?.agentLifecycleStatus} />
                <InfoCard label="Network" value={networkLabel} />
                <InfoCard label="Execution" value={setupComplete ? executionLabel : "Locked"} />
              </div>

              <div className="grid gap-6 xl:grid-cols-2">
                <Panel title="Setup checklist">
                  <ul className="space-y-3">
                    {setupChecks.map((check) => (
                      <li key={check.label} className="rounded-2xl border border-slate-200 p-4">
                        <div className="flex items-center justify-between gap-3">
                          <span className="font-semibold">{check.label}</span>
                          <span
                            className={
                              check.complete
                                ? "rounded-full bg-emerald-100 px-3 py-1 text-xs font-semibold text-emerald-800"
                                : "rounded-full bg-amber-100 px-3 py-1 text-xs font-semibold text-amber-800"
                            }
                          >
                            {check.complete ? "Ready" : "Pending"}
                          </span>
                        </div>
                        <p className="mt-2 break-all text-sm text-slate-600">{check.detail}</p>
                      </li>
                    ))}
                  </ul>
                  <button
                    type="button"
                    onClick={requestProvisioning}
                    disabled={actionPending || selectedOrganizationId === ""}
                    className="mt-4 min-h-11 rounded-2xl bg-slate-950 px-5 font-semibold text-white hover:bg-slate-800 disabled:opacity-50"
                  >
                    Queue Arc contract setup
                  </button>
                </Panel>

                <Panel title="Lifecycle controls">
                  <p className="text-sm leading-6 text-slate-600">
                    Execution stays locked until the backend reports active wallet,
                    vault and escrow bindings. Pause and recovery require a backend
                    owner-authorized endpoint so privileged contract calls never run
                    from this browser shell.
                  </p>
                  <div className="mt-4 grid gap-3 sm:grid-cols-3">
                    <button disabled className="min-h-11 rounded-2xl bg-slate-200 px-4 font-semibold text-slate-500">
                      {setupComplete ? "Execution ready" : "Execution locked"}
                    </button>
                    <button disabled className="min-h-11 rounded-2xl bg-slate-200 px-4 font-semibold text-slate-500">
                      Pause locked
                    </button>
                    <button disabled className="min-h-11 rounded-2xl bg-slate-200 px-4 font-semibold text-slate-500">
                      Recovery locked
                    </button>
                  </div>
                </Panel>
              </div>

              {selectedOrganizationId !== "" ? (
                <VendorInvoiceWorkflows
                  token={token}
                  organizationId={selectedOrganizationId}
                />
              ) : null}

              {selectedOrganizationId !== "" ? (
                <LifecycleWorkflows
                  token={token}
                  organizationId={selectedOrganizationId}
                />
              ) : null}

              {selectedOrganizationId !== "" ? (
                <TreasuryAuditViews
                  token={token}
                  organizationId={selectedOrganizationId}
                />
              ) : null}

              <Panel title="Members and invitations">
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
            </section>
          </div>
          </>
        )}
      </section>
    </main>
  );
}


function LandingHeader({
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
    <header className="flex flex-col gap-5 rounded-[2rem] border border-white/10 bg-white/[0.06] p-4 shadow-2xl shadow-black/30 backdrop-blur md:flex-row md:items-center md:justify-between">
      <a href="#access" className="flex items-center gap-3" aria-label="OPES access forms">
        <span className="grid size-11 place-items-center rounded-2xl bg-cyan-300 text-lg font-black text-slate-950 shadow-lg shadow-cyan-950/40">
          O
        </span>
        <span>
          <span className="block text-sm font-semibold uppercase tracking-[0.32em] text-cyan-200">
            OPES
          </span>
          <span className="block text-sm text-slate-400">Agentic finance, reconciled</span>
        </span>
      </a>
      <div className="grid gap-3 text-sm sm:grid-cols-2">
        <LabelSelect
          label="Network"
          value={networkLabel}
          options={networkOptions}
          onChange={setNetworkLabel}
        />
        <LabelSelect
          label="Mode"
          value={executionLabel}
          options={executionOptions}
          onChange={setExecutionLabel}
        />
      </div>
    </header>
  );
}

function LandingHero() {
  return (
    <section className="grid gap-8 rounded-[2.5rem] border border-white/10 bg-white/[0.05] p-5 shadow-2xl shadow-black/30 backdrop-blur md:p-8 lg:grid-cols-[1.05fr_0.95fr] lg:p-10">
      <div className="flex flex-col justify-between gap-10">
        <div>
          <p className="w-fit rounded-full border border-cyan-300/30 bg-cyan-300/10 px-4 py-2 text-xs font-semibold uppercase tracking-[0.28em] text-cyan-200">
            Autonomous treasury for real businesses
          </p>
          <h1 className="mt-7 max-w-4xl text-5xl font-semibold leading-[0.95] tracking-[-0.06em] text-white md:text-7xl">
            Let agents pay, but make every dollar answer.
          </h1>
          <p className="mt-6 max-w-2xl text-lg leading-8 text-slate-300">
            OPES turns invoices, subscriptions, escrow milestones and crosschain liquidity into controlled execution: tenant vaults, human approvals, restricted signers and ledger-grade reconciliation.
          </p>
        </div>

        <div className="flex flex-col gap-3 sm:flex-row">
          <a
            href="#access"
            className="inline-flex min-h-12 items-center justify-center rounded-2xl bg-cyan-300 px-6 font-semibold text-slate-950 shadow-lg shadow-cyan-950/30 transition hover:bg-cyan-200"
          >
            Launch OPES
          </a>
          <a
            href="#how-it-works"
            className="inline-flex min-h-12 items-center justify-center rounded-2xl border border-white/15 px-6 font-semibold text-white transition hover:bg-white/10"
          >
            See the flow
          </a>
        </div>

        <dl className="grid gap-3 sm:grid-cols-3">
          {landingMetrics.map(([value, label]) => (
            <div key={value} className="rounded-3xl border border-white/10 bg-slate-950/40 p-4">
              <dt className="text-3xl font-semibold text-white">{value}</dt>
              <dd className="mt-2 text-sm leading-5 text-slate-400">{label}</dd>
            </div>
          ))}
        </dl>
      </div>

      <div className="relative min-h-[520px] overflow-hidden rounded-[2rem] border border-cyan-200/20 bg-slate-950 p-5 shadow-inner shadow-cyan-950/40">
        <div className="absolute inset-0 bg-[radial-gradient(circle_at_50%_20%,rgba(34,211,238,0.30),transparent_34%),radial-gradient(circle_at_50%_90%,rgba(16,185,129,0.22),transparent_32%)]" />
        <div className="relative flex h-full flex-col justify-between gap-6">
          <div className="rounded-3xl border border-white/10 bg-white/[0.06] p-5 backdrop-blur">
            <div className="flex items-center justify-between gap-4">
              <div>
                <p className="text-xs uppercase tracking-[0.26em] text-cyan-200">OPES route</p>
                <h2 className="mt-2 text-2xl font-semibold text-white">Arc USDC → Base USDT</h2>
              </div>
              <span className="rounded-full bg-emerald-300/15 px-3 py-1 text-xs font-semibold text-emerald-200">
                policy checked
              </span>
            </div>
            <div id="how-it-works" className="mt-6 space-y-3">
              {routeSteps.map((step, index) => (
                <div key={step} className="flex items-center gap-3 rounded-2xl bg-slate-900/80 p-3">
                  <span className="grid size-8 shrink-0 place-items-center rounded-xl bg-cyan-300 text-sm font-bold text-slate-950">
                    {index + 1}
                  </span>
                  <span className="font-medium text-slate-100">{step}</span>
                  <span className="ml-auto h-2 w-14 rounded-full bg-gradient-to-r from-cyan-300 to-emerald-300" />
                </div>
              ))}
            </div>
          </div>

          <div className="grid gap-3">
            {landingPillars.map(([title, body]) => (
              <article key={title} className="rounded-3xl border border-white/10 bg-white/[0.06] p-4 backdrop-blur">
                <h3 className="font-semibold text-white">{title}</h3>
                <p className="mt-2 text-sm leading-6 text-slate-400">{body}</p>
              </article>
            ))}
          </div>
        </div>
      </div>
    </section>
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
    <header className="flex flex-col gap-5 rounded-3xl border border-white/10 bg-white/[0.04] p-6 shadow-2xl shadow-black/30 md:flex-row md:items-center md:justify-between">
      <div>
        <p className="text-sm font-medium uppercase tracking-[0.28em] text-cyan-300">
          OPES command center
        </p>
        <h1 className="mt-3 text-3xl font-semibold tracking-tight md:text-5xl">
          Agent-led treasury operations
        </h1>
        <p className="mt-3 max-w-2xl text-sm leading-6 text-slate-300 md:text-base">
          Authenticated shell for tenant-scoped workflows. The browser holds only
          the user session token and selected organization context.
        </p>
      </div>
      <div className="grid gap-3 text-sm sm:grid-cols-2">
        <LabelSelect
          label="Network"
          value={networkLabel}
          options={networkOptions}
          onChange={setNetworkLabel}
        />
        <LabelSelect
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

function AuthCard({
  title,
  className = "",
  children,
}: {
  title: string;
  className?: string;
  children: React.ReactNode;
}) {
  return (
    <section className={`rounded-3xl border border-white/10 bg-white p-6 text-slate-950 shadow-xl ${className}`}>
      <h2 className="text-2xl font-semibold">{title}</h2>
      <div className="mt-5">{children}</div>
    </section>
  );
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

function Messages({ error, actionMessage }: { error: string; actionMessage: string }) {
  return (
    <>
      {error !== "" ? <ErrorMessage message={error} /> : null}
      {actionMessage !== "" ? (
        <p className="rounded-2xl border border-emerald-200 bg-emerald-50 px-4 py-3 text-sm text-emerald-800">
          {actionMessage}
        </p>
      ) : null}
    </>
  );
}

function ErrorMessage({ message }: { message: string }) {
  return (
    <p className="rounded-2xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
      {message}
    </p>
  );
}
