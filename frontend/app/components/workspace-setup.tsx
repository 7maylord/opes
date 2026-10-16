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
  const readyCount = checks.filter((check) => check.complete).length;
  const complete = readyCount === checks.length;
  const progress = checks.length ? Math.round((readyCount / checks.length) * 100) : 0;

  return <div className="space-y-6">
    <header className="grid gap-5 rounded-3xl bg-slate-950 p-6 text-white lg:grid-cols-[1fr_18rem] lg:p-8">
      <div><p className="text-xs font-semibold uppercase tracking-[0.2em] text-cyan-300">Workspace activation</p><h3 className="mt-3 text-3xl font-semibold">{complete ? "Your treasury is deployed" : "Let’s set up your treasury"}</h3><p className="mt-3 max-w-2xl text-sm leading-6 text-slate-300">OPES creates the agent wallet and Arc contracts. You fund the treasury and choose the rules that govern each payment.</p></div>
      <div className="rounded-2xl bg-white/10 p-5"><div className="flex items-end justify-between"><strong className="text-3xl">{progress}%</strong><span className="text-xs text-slate-300">{readyCount} of {checks.length} ready</span></div><div className="mt-4 h-2 overflow-hidden rounded-full bg-white/15"><div className="h-full rounded-full bg-[#dce8c6]" style={{ width: `${progress}%` }} /></div><p className="mt-3 text-xs text-slate-300">Completed steps are saved automatically.</p></div>
    </header>

    <section className="rounded-3xl border border-slate-200 bg-white p-5 md:p-6">
      <div className="flex items-start gap-3"><Step number="1" complete={complete} /><div><h4 className="font-semibold">Wallets and contracts</h4><p className="mt-1 text-sm leading-6 text-slate-600">Deployment gas is paid by OPES. This status refreshes while the factory creates your vault and escrow.</p></div></div>
      <ul className="mt-5 grid gap-3 sm:grid-cols-2">{checks.map((check) => <li key={check.label} className="flex items-start gap-3 rounded-2xl bg-slate-50 p-4"><span className={`mt-0.5 size-2.5 shrink-0 rounded-full ${check.complete ? "bg-emerald-500" : "bg-amber-400"}`} /><div><div className="flex flex-wrap items-center gap-2"><span className="text-sm font-semibold">{check.label}</span><span className={`text-xs ${check.complete ? "text-emerald-700" : "text-amber-700"}`}>{check.complete ? "Ready" : "Pending"}</span></div><p className="mt-1 break-all text-xs leading-5 text-slate-500">{check.detail}</p></div></li>)}</ul>
      {deployment?.status === "FAILED" ? <div className="mt-4 rounded-2xl bg-amber-50 p-4"><p className="text-sm text-amber-900">Deployment needs attention. {metadata?.failureReason || "Contact your OPES administrator to check deployment funding and permissions."}</p>{canManage ? <button className="btn mt-3" disabled={pending} onClick={onRetry}>Retry contract deployment</button> : null}</div> : null}
    </section>

    <section className="rounded-3xl border border-slate-200 bg-white p-5 md:p-6">
      <div className="flex items-start gap-3"><Step number="2" complete={false} /><div><h4 className="font-semibold">Fund your test wallets</h4><p className="mt-1 text-sm leading-6 text-slate-600">Select USDC and Arc Testnet in Circle’s faucet. Treasury balance verification happens separately before payment.</p></div></div>
      <div className="mt-5 grid gap-3 lg:grid-cols-3">{[
        ["Owner wallet", user?.ownerWalletAddress, "Signs policy changes and approvals."],
        ["Operator wallet", operator?.address, "Submits the agent’s transactions."],
        ["Treasury vault", vault?.status === "ACTIVE" ? vault.address : null, "Holds funds available for payment."],
      ].map(([label, address, detail]) => <div key={label} className="rounded-2xl border border-slate-200 p-4"><p className="text-sm font-semibold">{label}</p><p className="mt-1 min-h-10 text-xs leading-5 text-slate-500">{detail}</p><div className="mt-3 flex items-center gap-2 rounded-xl bg-slate-50 p-2"><code className="min-w-0 flex-1 truncate text-xs">{address || "Waiting for setup"}</code>{address ? <button type="button" aria-label={`Copy ${label?.toLowerCase()}`} title={`Copy ${label?.toLowerCase()}`} className="inline-flex size-8 shrink-0 items-center justify-center rounded-lg text-blue-700 hover:bg-blue-50" onClick={() => { void navigator.clipboard.writeText(address).then(() => toast.success(`${label} address copied`)).catch(() => toast.error("Unable to copy address")); }}><CopyIcon /></button> : null}</div></div>)}</div>
      <a className="btn mt-5 inline-flex items-center" href="https://faucet.circle.com/" target="_blank" rel="noreferrer">Open Circle USDC faucet ↗</a>
    </section>

    <section className="rounded-3xl border border-slate-200 bg-[#edf1e5] p-5 md:p-6"><div className="flex items-start gap-3"><Step number="3" complete={false} /><div><h4 className="font-semibold">Set rules and connect invoice sources</h4><p className="mt-1 text-sm leading-6 text-slate-600">Choose your buffer and budget, then add the channels that bring obligations into OPES.</p></div></div><div className="mt-5 grid gap-3 sm:grid-cols-3"><SetupAction title="Treasury rules" detail="Budget, buffer and contract controls" onClick={onTreasury} /><SetupAction title="Email inbox" detail="Receive invoices and attachments" onClick={onInbox} /><SetupAction title="Accounting" detail="Sync ERPNext or Odoo records" onClick={onIntegrations} /></div></section>
  </div>;
}

function Step({ number, complete }: { number: string; complete: boolean }) { return <span className={`flex size-9 shrink-0 items-center justify-center rounded-full text-sm font-semibold ${complete ? "bg-emerald-600 text-white" : "bg-slate-950 text-white"}`}>{complete ? "✓" : number}</span>; }
function SetupAction({ title, detail, onClick }: { title: string; detail: string; onClick: () => void }) { return <button type="button" onClick={onClick} className="rounded-2xl bg-white p-4 text-left shadow-sm transition hover:-translate-y-0.5"><span className="font-semibold">{title} →</span><span className="mt-1 block text-xs leading-5 text-slate-500">{detail}</span></button>; }
function CopyIcon() { return <svg aria-hidden="true" viewBox="0 0 24 24" className="size-4 fill-none stroke-current" strokeWidth="1.8"><rect x="9" y="9" width="11" height="11" rx="2" /><path d="M15 9V6a2 2 0 0 0-2-2H6a2 2 0 0 0 2 2v7a2 2 0 0 0 2 2h3" /></svg>; }
