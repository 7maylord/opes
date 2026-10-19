"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { toast } from "sonner";
import {
  getPaymentCalendar,
  type NotificationView,
  type PaymentCalendarItemResponse,
  type PaymentCalendarResponse,
} from "@/lib/api";
import { formatAtomic } from "@/lib/money";

type Filter = "ALL" | PaymentCalendarItemResponse["kind"];

export function PaymentCalendar({ token, organizationId, onNavigate }: {
  token: string;
  organizationId: string;
  onNavigate: (view: NotificationView, relatedRecordId?: string) => void;
}) {
  const [data, setData] = useState<PaymentCalendarResponse | null>(null);
  const [filter, setFilter] = useState<Filter>("ALL");
  const [loading, setLoading] = useState(true);
  const load = useCallback(() => getPaymentCalendar(token, organizationId), [organizationId, token]);

  useEffect(() => {
    let active = true;
    load().then((value) => active && setData(value)).catch((error: unknown) => {
      if (active) toast.error(error instanceof Error ? error.message : "Unable to load payment calendar");
    }).finally(() => active && setLoading(false));
    return () => { active = false; };
  }, [load]);

  async function refresh() {
    setLoading(true);
    try { setData(await load()); }
    catch (error) { toast.error(error instanceof Error ? error.message : "Unable to load payment calendar"); }
    finally { setLoading(false); }
  }

  const items = useMemo(() => data?.items.filter((item) => filter === "ALL" || item.kind === filter) ?? [], [data, filter]);
  const grouped = useMemo(() => Object.entries(Object.groupBy(items, (item) => item.scheduledFor?.slice(0, 10) ?? "Unscheduled")), [items]);

  return <section className="space-y-6" aria-labelledby="calendar-title">
    <div className="flex flex-col gap-4 lg:flex-row lg:items-end lg:justify-between">
      <div><p className="text-xs font-semibold uppercase tracking-[0.2em] text-blue-700">Forward view</p><h3 id="calendar-title" className="mt-2 text-3xl font-semibold">Agent payment calendar</h3><p className="mt-2 max-w-3xl text-sm leading-6 text-slate-600">See when verified invoices, recurring cycles, and accepted milestones can move, why each date applies, and the projected operating balance.</p></div>
      <button type="button" className="btn-secondary" disabled={loading} onClick={() => void refresh()}>{loading ? "Refreshing…" : "Refresh"}</button>
    </div>

    {data ? <><div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4"><Metric label="Spendable now" value={money(data.startingOperatingAvailableAtomic)} /><Metric label="Scheduled 90 days" value={money(data.scheduledOperatingSpendAtomic)} /><Metric label="Projected spendable" value={money(data.projectedOperatingAvailableAtomic)} /><Metric label="Uncovered" value={money(data.uncoveredAtomic)} alert={data.uncoveredAtomic !== "0"} /></div>{data.snapshotStatus !== "FRESH" ? <p className="rounded-2xl border border-amber-200 bg-amber-50 p-4 text-sm text-amber-900">The treasury snapshot is {data.snapshotStatus.toLowerCase()}. Dates remain useful, but projected balances are not confirmed chain balances.</p> : null}</> : null}

    <div className="flex gap-2 overflow-x-auto pb-1" role="tablist" aria-label="Payment type">{(["ALL", "INVOICE", "SUBSCRIPTION", "MILESTONE"] as const).map((kind) => <button key={kind} type="button" role="tab" aria-selected={filter === kind} onClick={() => setFilter(kind)} className={filter === kind ? "rounded-full bg-slate-950 px-4 py-2 text-sm font-semibold text-white" : "rounded-full border border-slate-200 bg-white px-4 py-2 text-sm font-medium text-slate-600"}>{kind === "ALL" ? "All" : title(kind)}</button>)}</div>
    {loading && !data ? <p role="status" className="rounded-2xl bg-slate-50 p-6 text-sm text-slate-500">Loading scheduled obligations…</p> : null}
    {!loading && data?.items.length === 0 ? <p className="rounded-3xl border border-dashed border-slate-300 p-10 text-center text-sm text-slate-500">No unpaid invoices, recurring cycles, or open milestones are scheduled in the next 90 days.</p> : null}
    <div className="space-y-6">{grouped.map(([date, entries]) => <section key={date}><h4 className="mb-3 text-sm font-semibold text-slate-500">{date === "Unscheduled" ? date : new Date(`${date}T00:00:00`).toLocaleDateString(undefined, { weekday: "short", day: "numeric", month: "long", year: "numeric" })}</h4><div className="grid gap-3 xl:grid-cols-2">{entries?.map((item) => <article key={item.id} className="rounded-3xl border border-slate-200 bg-slate-50 p-5"><div className="flex items-start justify-between gap-3"><div><span className="text-[10px] font-bold uppercase tracking-[0.16em] text-blue-700">{title(item.kind)}</span><h5 className="mt-2 font-semibold">{item.title}</h5><p className="mt-1 text-sm text-slate-500">{item.counterparty}</p></div><strong className="whitespace-nowrap">{money(item.amountAtomic)} {item.assetSymbol}</strong></div><p className="mt-4 text-sm leading-6 text-slate-600">{item.explanation}</p><div className="mt-4 flex flex-wrap items-center justify-between gap-3"><div><span className="rounded-full bg-white px-3 py-1 text-xs font-semibold text-slate-600">{title(item.status)}</span>{item.projectedOperatingAvailableAtomic !== null ? <span className="ml-2 text-xs text-slate-500">{money(item.projectedOperatingAvailableAtomic)} USDC after</span> : null}</div><button type="button" className="btn-secondary" onClick={() => onNavigate(item.actionView, item.actionView === "invoices" ? item.relatedRecordId : undefined)}>Open workflow</button></div></article>)}</div></section>)}</div>
  </section>;
}

function Metric({ label, value, alert = false }: { label: string; value: string; alert?: boolean }) { return <div className={alert ? "rounded-2xl bg-rose-100 p-4 text-rose-950" : "rounded-2xl bg-slate-950 p-4 text-white"}><p className="text-xs font-semibold uppercase tracking-[0.14em] opacity-70">{label}</p><p className="mt-2 text-2xl font-semibold">{value} USDC</p></div>; }
function money(value: string) { return formatAtomic(value, 6); }
function title(value: string) { return value.replaceAll("_", " ").toLowerCase().replace(/^./, (letter) => letter.toUpperCase()); }
