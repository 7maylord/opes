"use client";

import { toast } from "sonner";
import type { BusinessAgentDetail, SessionUser } from "@/lib/api";
import type { SetupCheck } from "@/lib/setup-checklist";

export function WorkspaceSetup({ agent, user, checks, canManage, pending, onRetry, onTreasury, onInbox, onIntegrations }: {
  agent: BusinessAgentDetail | null; user: SessionUser | null; checks: SetupCheck[];
  canManage: boolean; pending: boolean; onRetry: () => void;
  onTreasury: () => void; onInbox: () => void; onIntegrations: () => void;
}) {
  const bindings = agent?.resourceBindings.filter((item) => item.environment === "arc-testnet") ?? [];
  const vault = bindings.find((item) => item.resourceType === "business_policy_vault_contract");
  const operator = bindings.find((item) => item.resourceType === "operator_wallet");
  const deployment = bindings.find((item) => item.resourceType === "factory_provisioning");
  const metadata = deployment?.metadata as { failureReason?: string } | undefined;
  const complete = checks.every((check) => check.complete);
  return <div className="space-y-7">
    <div><p className="text-xs font-semibold uppercase tracking-widest text-blue-700">Your workspace, ready for its first payment</p><h3 className="mt-2 text-3xl font-semibold">{complete ? "Your treasury is deployed" : "Let’s set up your treasury"}</h3><p className="mt-3 max-w-2xl text-sm leading-6 text-slate-600">Your organization and wallets are saved automatically. Return here any time to continue; completed deployment steps do not need to be repeated.</p></div>
    <section className="rounded-2xl border border-slate-200 bg-white p-6">
      <h4 className="font-semibold">1. Wallets and contracts</h4><p className="mt-2 text-sm leading-6 text-slate-600">OPES creates your Circle operator wallet and deploys your Arc vault and escrow automatically. Deployment gas is paid by OPES. Status refreshes while setup is in progress.</p>
      <ul className="mt-5 grid gap-3 sm:grid-cols-2">{checks.map((check) => <li key={check.label} className="rounded-xl bg-slate-50 p-3"><span className="text-sm font-medium">{check.label}</span><span className={`ml-3 text-xs ${check.complete ? "text-emerald-700" : "text-amber-700"}`}>{check.complete ? "Ready" : "Pending"}</span><p className="mt-1 break-all text-xs text-slate-500">{check.detail}</p></li>)}</ul>
      {deployment?.status === "FAILED" ? <div className="mt-4"><p className="text-sm text-amber-800">Deployment needs attention. {metadata?.failureReason || "Contact your OPES administrator to check deployment funding and permissions."}</p>{canManage ? <button className="btn mt-3" disabled={pending} onClick={onRetry}>Retry contract deployment</button> : null}</div> : null}
    </section>
    <section className="rounded-2xl border border-slate-200 bg-white p-6"><h4 className="font-semibold">2. Fund your test wallets</h4><p className="mt-2 text-sm leading-6 text-slate-600">Select USDC and Arc Testnet in Circle’s faucet, then paste the address for the purpose below. A faucet request is not proof of funding; treasury balances are verified before payment.</p>
      <div className="mt-4 space-y-4">{[
        ["Owner wallet", user?.ownerWalletAddress, "Gas for owner-signed policy changes and approvals."],
        ["Operator wallet", operator?.address, "Gas for your agent’s transactions."],
        ["Treasury vault", vault?.status === "ACTIVE" ? vault.address : null, "Payment funds. Available after contract deployment."],
      ].map(([label, address, detail]) => <div key={label} className="rounded-xl bg-slate-50 p-4"><p className="text-sm font-semibold">{label}</p><p className="mt-1 text-xs text-slate-500">{detail}</p><div className="mt-2 flex flex-wrap items-center gap-3"><code className="break-all text-xs">{address || "Waiting for setup"}</code>{address ? <button className="text-xs font-semibold text-blue-700" onClick={() => { void navigator.clipboard.writeText(address).then(() => toast.success(`${label} address copied`)).catch(() => toast.error("Unable to copy address")); }}>Copy {label?.toLowerCase()}</button> : null}</div></div>)}</div>
      <a className="btn mt-4 inline-flex items-center" href="https://faucet.circle.com/" target="_blank" rel="noreferrer">Open Circle USDC faucet ↗</a>
    </section>
    <section className="rounded-2xl border border-slate-200 bg-white p-6"><h4 className="font-semibold">3. Set your rules and connect invoice sources</h4><p className="mt-2 text-sm leading-6 text-slate-600">Review your treasury buffer, budget and spending policy before authorizing payments. Connect an inbox or accounting system when you are ready to receive invoices.</p><div className="mt-4 flex flex-wrap gap-3"><button className="btn" onClick={onTreasury}>Configure treasury</button><button className="btn-secondary" onClick={onInbox}>Set up email inbox</button><button className="btn-secondary" onClick={onIntegrations}>Connect accounting</button></div></section>
  </div>;
}
