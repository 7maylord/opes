"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { toast } from "sonner";
import {
  listOperationalExceptions,
  type ExceptionCenterResponse,
  type NotificationView,
  type OperationalExceptionResponse,
} from "@/lib/api";

type Filter = "ALL" | OperationalExceptionResponse["category"];

export function ExceptionCenter({ token, organizationId, onNavigate }: {
  token: string;
  organizationId: string;
  onNavigate: (view: NotificationView, relatedRecordId?: string) => void;
}) {
  const [data, setData] = useState<ExceptionCenterResponse | null>(null);
  const [filter, setFilter] = useState<Filter>("ALL");
  const [loading, setLoading] = useState(true);

  const fetchExceptions = useCallback(
    () => listOperationalExceptions(token, organizationId),
    [organizationId, token],
  );

  useEffect(() => {
    let cancelled = false;
    fetchExceptions().then((next) => {
      if (!cancelled) setData(next);
    }).catch((error: unknown) => {
      if (!cancelled) toast.error(error instanceof Error ? error.message : "Unable to load exceptions");
    }).finally(() => {
      if (!cancelled) setLoading(false);
    });
    return () => { cancelled = true; };
  }, [fetchExceptions]);

  async function refresh() {
    setLoading(true);
    try {
      setData(await fetchExceptions());
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Unable to load exceptions");
    } finally {
      setLoading(false);
    }
  }

  const categories = useMemo(() => Array.from(new Set(data?.items.map((item) => item.category) ?? [])), [data]);
  const items = filter === "ALL" ? data?.items ?? [] : data?.items.filter((item) => item.category === filter) ?? [];

  return <section className="space-y-6" aria-labelledby="exceptions-title">
    <div className="flex flex-col gap-4 lg:flex-row lg:items-end lg:justify-between">
      <div><p className="text-xs font-semibold uppercase tracking-[0.2em] text-rose-700">Operational safety</p><h3 id="exceptions-title" className="mt-2 text-3xl font-semibold">Exception & recovery center</h3><p className="mt-2 max-w-3xl text-sm leading-6 text-slate-600">See what failed, what OPES is reconciling automatically, and the safest next action. Unknown onchain submissions are never offered for blind retry.</p></div>
      <button type="button" className="btn-secondary" disabled={loading} onClick={() => void refresh()}>{loading ? "Refreshing…" : "Refresh"}</button>
    </div>

    {data ? <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4"><Metric label="Open exceptions" value={data.summary.total} tone="slate" /><Metric label="Critical" value={data.summary.critical} tone="rose" /><Metric label="Your action" value={data.summary.userAction} tone="amber" /><Metric label="Reconciling" value={data.summary.autoRecovering} tone="blue" /></div> : null}

    {categories.length > 1 ? <div className="flex gap-2 overflow-x-auto pb-1" role="tablist" aria-label="Exception category"><FilterButton active={filter === "ALL"} onClick={() => setFilter("ALL")}>All</FilterButton>{categories.map((category) => <FilterButton key={category} active={filter === category} onClick={() => setFilter(category)}>{humanize(category)}</FilterButton>)}</div> : null}

    {loading && !data ? <p role="status" className="rounded-2xl bg-slate-50 p-6 text-sm text-slate-500">Loading operational state…</p> : null}
    {!loading && data?.items.length === 0 ? <div className="rounded-3xl border border-emerald-200 bg-emerald-50 p-10 text-center"><div className="mx-auto flex size-12 items-center justify-center rounded-full bg-emerald-600 text-xl text-white">✓</div><h4 className="mt-4 text-lg font-semibold text-emerald-950">Operations are clear</h4><p className="mt-2 text-sm text-emerald-800">No payment, treasury, agreement, intake, provisioning, or worker exceptions need attention.</p></div> : null}
    {!loading && data && data.items.length > 0 && items.length === 0 ? <p className="rounded-2xl border border-dashed border-slate-300 p-8 text-center text-sm text-slate-500">No exceptions in this category.</p> : null}

    <div className="grid gap-4 xl:grid-cols-2">{items.map((item) => <ExceptionCard key={`${item.subjectType}-${item.id}`} item={item} onOpen={() => onNavigate(item.actionView, item.actionView === "invoices" ? item.relatedRecordId ?? undefined : undefined)} />)}</div>
  </section>;
}

function ExceptionCard({ item, onOpen }: { item: OperationalExceptionResponse; onOpen: () => void }) {
  const automatic = item.recoveryMode === "AUTO_RECOVERING";
  return <article className={`rounded-3xl border p-5 ${item.severity === "CRITICAL" ? "border-rose-200 bg-rose-50/60" : "border-amber-200 bg-amber-50/50"}`}>
    <div className="flex flex-wrap items-center gap-2"><span className={`rounded-full px-2.5 py-1 text-[10px] font-bold uppercase tracking-wide ${item.severity === "CRITICAL" ? "bg-rose-600 text-white" : "bg-amber-400 text-amber-950"}`}>{item.severity}</span><span className="rounded-full bg-white/80 px-2.5 py-1 text-[10px] font-semibold uppercase text-slate-600">{humanize(item.category)}</span><span className="ml-auto text-xs text-slate-500">{new Date(item.updatedAt).toLocaleString()}</span></div>
    <h4 className="mt-4 text-lg font-semibold">{item.title}</h4><p className="mt-2 text-sm leading-6 text-slate-700">{item.reason}</p>
    <div className="mt-4 rounded-2xl bg-white/75 p-4"><p className="text-xs font-semibold uppercase tracking-[0.16em] text-slate-500">{automatic ? "What OPES is doing" : item.recoveryMode === "PLATFORM_ACTION" ? "Platform action" : "Recommended recovery"}</p><p className="mt-2 text-sm leading-6 text-slate-700">{item.recommendation}</p></div>
    <div className="mt-4 flex items-center justify-between gap-3"><span className={`text-xs font-semibold ${automatic ? "text-blue-700" : "text-slate-500"}`}>{automatic ? "Automatic reconciliation active" : humanize(item.status)}</span><button type="button" className="btn-secondary" onClick={onOpen}>{item.actionLabel}</button></div>
  </article>;
}

function Metric({ label, value, tone }: { label: string; value: number; tone: "slate" | "rose" | "amber" | "blue" }) {
  const colors = { slate: "bg-slate-950 text-white", rose: "bg-rose-100 text-rose-950", amber: "bg-amber-100 text-amber-950", blue: "bg-blue-100 text-blue-950" };
  return <div className={`rounded-2xl p-4 ${colors[tone]}`}><p className="text-xs font-semibold uppercase tracking-[0.14em] opacity-70">{label}</p><p className="mt-2 text-3xl font-semibold">{value}</p></div>;
}

function FilterButton({ active, onClick, children }: { active: boolean; onClick: () => void; children: React.ReactNode }) {
  return <button type="button" role="tab" aria-selected={active} onClick={onClick} className={active ? "rounded-full bg-slate-950 px-4 py-2 text-sm font-semibold text-white" : "rounded-full border border-slate-200 bg-white px-4 py-2 text-sm font-medium text-slate-600 hover:bg-slate-50"}>{children}</button>;
}

function humanize(value: string) { return value.replaceAll("_", " ").toLowerCase(); }
