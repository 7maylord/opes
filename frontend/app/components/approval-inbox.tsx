"use client";

import { useEffect, useState } from "react";
import { toast } from "sonner";
import { getApprovalInbox, type ApprovalInboxResponse, type NotificationView } from "@/lib/api";
import { formatAtomic } from "@/lib/money";

export function ApprovalInbox({ token, organizationId, onNavigate }: { token: string; organizationId: string; onNavigate: (view: NotificationView, relatedRecordId?: string) => void }) {
  const [data, setData] = useState<ApprovalInboxResponse | null>(null);
  const [loading, setLoading] = useState(true);
  useEffect(() => { let active = true; getApprovalInbox(token, organizationId).then((value) => active && setData(value)).catch((error: unknown) => active && toast.error(error instanceof Error ? error.message : "Unable to load approvals")).finally(() => active && setLoading(false)); return () => { active = false; }; }, [organizationId, token]);
  return <section className="space-y-6" aria-labelledby="approvals-title">
    <div><p className="text-xs font-semibold uppercase tracking-[0.2em] text-amber-700">Human authority</p><h3 id="approvals-title" className="mt-2 text-3xl font-semibold">Approval inbox</h3><p className="mt-2 max-w-3xl text-sm leading-6 text-slate-600">Review payments outside autonomous limits, payout-wallet changes, and submitted milestones from one queue. Opening an item takes you to the evidence and signing workflow.</p></div>
    {data ? <div className="grid gap-3 sm:grid-cols-3"><Metric label="Waiting" value={data.summary.total} /><Metric label="You can act" value={data.summary.actionable} /><Metric label="Expired" value={data.summary.expiring} /></div> : null}
    {loading ? <p role="status" className="rounded-2xl bg-slate-50 p-6 text-sm text-slate-500">Loading approval authority…</p> : null}
    {!loading && data?.items.length === 0 ? <div className="rounded-3xl border border-emerald-200 bg-emerald-50 p-10 text-center"><h4 className="font-semibold text-emerald-950">Nothing is waiting for approval</h4><p className="mt-2 text-sm text-emerald-800">New limit exceptions, wallet changes, and milestone reviews will appear here.</p></div> : null}
    <div className="grid gap-4 xl:grid-cols-2">{data?.items.map((item) => <article key={`${item.kind}:${item.id}`} className="rounded-3xl border border-slate-200 bg-slate-50 p-5"><div className="flex items-start justify-between gap-3"><div><span className="text-[10px] font-bold uppercase tracking-[0.16em] text-amber-700">{humanize(item.kind)}</span><h4 className="mt-2 text-lg font-semibold">{item.title}</h4></div>{item.amountAtomic && item.assetSymbol ? <strong>{formatAtomic(item.amountAtomic, 6)} {item.assetSymbol}</strong> : null}</div><p className="mt-3 text-sm leading-6 text-slate-600">{item.reason}</p><div className="mt-4 rounded-2xl bg-white p-4 text-xs text-slate-600"><p><strong>Authority:</strong> {item.requiredRoles.map(humanize).join(", ")}</p><p className="mt-1"><strong>Expiry:</strong> {item.expiresAt ? new Date(item.expiresAt).toLocaleString() : "No automatic expiry"}</p></div><div className="mt-4 flex items-center justify-between gap-3"><span className={item.canAct ? "text-xs font-semibold text-emerald-700" : "text-xs font-semibold text-rose-700"}>{item.canAct ? "You have authority" : humanize(item.status)}</span><button type="button" className="btn-secondary" onClick={() => onNavigate(item.actionView, item.kind === "PAYMENT_LIMIT" ? item.relatedRecordId : undefined)}>Review & act</button></div></article>)}</div>
  </section>;
}
function Metric({ label, value }: { label: string; value: number }) { return <div className="rounded-2xl bg-slate-950 p-4 text-white"><p className="text-xs font-semibold uppercase tracking-[0.14em] opacity-70">{label}</p><p className="mt-2 text-3xl font-semibold">{value}</p></div>; }
function humanize(value: string) { return value.replaceAll("_", " ").toLowerCase(); }
