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
  getApiBaseUrl,
  getSession,
  listOrganizations,
  revokeSession,
  type SessionUser,
  type UserOrganization,
} from "@/lib/api";
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
const storageEventName = "opes-storage";

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
  const [user, setUser] = useState<SessionUser | null>(null);
  const [organizations, setOrganizations] = useState<UserOrganization[]>([]);
  const [error, setError] = useState("");
  const isLoading = token !== "" && user === null && error === "";

  const clearBrowserSession = useCallback(() => {
    clearTenantCache(localStorage);
    setStoredToken("");
    setSelectedOrganizationId("");
    setUser(null);
    setOrganizations([]);
    setError("");
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

  const selectedOrganization = useMemo(
    () => organizations.find((org) => org.id === selectedOrganizationId),
    [organizations, selectedOrganizationId],
  );

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

  function switchOrganization(nextOrganizationId: string) {
    if (selectedOrganizationId !== nextOrganizationId) {
      clearTenantCache(localStorage, selectedOrganizationId);
    }
    setSelectedOrganizationId(nextOrganizationId);
  }

  async function logout() {
    if (token !== "") {
      await revokeSession(token).catch(() => undefined);
    }
    clearBrowserSession();
  }

  return (
    <main className="min-h-screen bg-slate-950 text-slate-100">
      <section className="mx-auto flex w-full max-w-6xl flex-col gap-8 px-6 py-8">
        <header className="flex flex-col gap-5 rounded-3xl border border-white/10 bg-white/[0.04] p-6 shadow-2xl shadow-black/30 md:flex-row md:items-center md:justify-between">
          <div>
            <p className="text-sm font-medium uppercase tracking-[0.28em] text-cyan-300">
              OPES command center
            </p>
            <h1 className="mt-3 text-3xl font-semibold tracking-tight md:text-5xl">
              Agent-led treasury operations
            </h1>
            <p className="mt-3 max-w-2xl text-sm leading-6 text-slate-300 md:text-base">
              Authenticated shell for tenant-scoped workflows. The browser holds
              only the user session token and selected organization context.
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

        {token === "" ? (
          <form
            onSubmit={saveToken}
            className="rounded-3xl border border-white/10 bg-white p-6 text-slate-950 shadow-xl md:p-8"
          >
            <h2 className="text-2xl font-semibold">Start with a session</h2>
            <p className="mt-2 max-w-2xl text-sm leading-6 text-slate-600">
              Paste a session token returned by the backend onboarding or
              invitation flow. F1 will add the full signup screens.
            </p>
            <label className="mt-6 block text-sm font-medium" htmlFor="token">
              Backend session token
            </label>
            <div className="mt-2 flex flex-col gap-3 md:flex-row">
              <input
                id="token"
                value={tokenDraft}
                onChange={(event) => setTokenDraft(event.target.value)}
                className="min-h-12 flex-1 rounded-2xl border border-slate-300 px-4 outline-none ring-cyan-500 focus:ring-2"
                placeholder="opes session token"
                type="password"
              />
              <button className="min-h-12 rounded-2xl bg-slate-950 px-6 font-semibold text-white hover:bg-slate-800">
                Load workspace
              </button>
            </div>
            {error !== "" ? <ErrorMessage message={error} /> : null}
            <p className="mt-4 text-xs text-slate-500">
              API: {getApiBaseUrl()}
            </p>
          </form>
        ) : (
          <div className="grid gap-6 lg:grid-cols-[320px_1fr]">
            <aside className="rounded-3xl border border-white/10 bg-white/[0.04] p-5">
              <div className="flex items-start justify-between gap-4">
                <div>
                  <p className="text-xs uppercase tracking-[0.22em] text-slate-400">
                    Signed in
                  </p>
                  <p className="mt-2 font-semibold">
                    {user?.displayName ?? "Loading..."}
                  </p>
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

            <section className="rounded-3xl border border-white/10 bg-white p-6 text-slate-950 shadow-xl md:p-8">
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

              {error !== "" ? <ErrorMessage message={error} /> : null}
              {isLoading ? <p className="mt-6 text-slate-600">Loading...</p> : null}

              <div className="mt-8 grid gap-4 md:grid-cols-3">
                <InfoCard label="Role" value={selectedOrganization?.role} />
                <InfoCard
                  label="Agent status"
                  value={selectedOrganization?.agentLifecycleStatus}
                />
                <InfoCard label="Execution" value={executionLabel} />
              </div>

              <div className="mt-8 rounded-2xl border border-slate-200 bg-slate-50 p-5">
                <h3 className="font-semibold">F0 guardrails</h3>
                <ul className="mt-3 space-y-2 text-sm leading-6 text-slate-600">
                  <li>API calls include only the bearer session token.</li>
                  <li>Organization selection is tenant-scoped and local.</li>
                  <li>No operator wallet keys or privileged signing runs here.</li>
                </ul>
              </div>
            </section>
          </div>
        )}
      </section>
    </main>
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

function LabelSelect({
  label,
  value,
  options,
  onChange,
}: {
  label: string;
  value: string;
  options: string[];
  onChange: (value: string) => void;
}) {
  return (
    <label className="block text-xs font-medium uppercase tracking-[0.18em] text-slate-400">
      {label}
      <select
        value={value}
        onChange={(event) => onChange(event.target.value)}
        className="mt-2 min-h-11 w-full rounded-2xl border border-white/10 bg-slate-900 px-3 text-sm normal-case tracking-normal text-white outline-none ring-cyan-500 focus:ring-2"
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
      <p className="text-xs uppercase tracking-[0.18em] text-slate-500">
        {label}
      </p>
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

function ErrorMessage({ message }: { message: string }) {
  return (
    <p className="mt-4 rounded-2xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
      {message}
    </p>
  );
}
