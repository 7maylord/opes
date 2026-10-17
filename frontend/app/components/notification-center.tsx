"use client";

import { useEffect, useState } from "react";
import { toast } from "sonner";
import { getWorkspaceRecord, listNotifications, markAllNotificationsRead, markNotificationRead, type NotificationView, type WorkspaceNotificationResponse } from "@/lib/api";

export function NotificationCenter({ token, organizationId, onNavigate, onUnreadChange }: {
  token: string; organizationId: string;
  onNavigate: (view: NotificationView, invoiceVersionId?: string) => void;
  onUnreadChange: (count: number) => void;
}) {
  const [items, setItems] = useState<WorkspaceNotificationResponse[]>([]);
  const [loading, setLoading] = useState(true);
  useEffect(() => {
    let cancelled = false;
    listNotifications(token, organizationId).then((next) => {
      if (cancelled) return;
      setItems(next);
      onUnreadChange(next.filter((item) => !item.readAt).length);
    }).catch((error: unknown) => {
      if (!cancelled) toast.error(error instanceof Error ? error.message : "Unable to load notifications");
    }).finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [organizationId, onUnreadChange, token]);

  async function open(item: WorkspaceNotificationResponse) {
    if (!item.readAt) {
      await markNotificationRead(token, organizationId, item.id);
      setItems((current) => current.map((entry) => entry.id === item.id ? { ...entry, readAt: new Date().toISOString() } : entry));
      onUnreadChange(Math.max(0, items.filter((entry) => !entry.readAt).length - 1));
    }
    if (item.type === "PAYMENT_FAILED" && item.subjectId) {
      try {
        const detail = await getWorkspaceRecord(token, organizationId, "execution", item.subjectId);
        const invoiceVersionId = detail.record.details.sourceVersionId;
        onNavigate("invoices", typeof invoiceVersionId === "string" ? invoiceVersionId : undefined);
      } catch {
        onNavigate("invoices");
      }
      return;
    }
    if (item.actionView) onNavigate(item.actionView);
  }

  async function readAll() {
    await markAllNotificationsRead(token, organizationId);
    setItems((current) => current.map((item) => ({ ...item, readAt: item.readAt ?? new Date().toISOString() })));
    onUnreadChange(0);
    toast.success("All notifications marked as read");
  }

  return <section className="space-y-6" aria-labelledby="notifications-title">
    <div className="flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between"><div><p className="text-xs font-semibold uppercase tracking-[0.2em] text-cyan-700">Activity requiring attention</p><h3 id="notifications-title" className="mt-2 text-3xl font-semibold">Notifications</h3><p className="mt-2 max-w-2xl text-sm leading-6 text-slate-600">Follow invoices, approvals, scheduled payments, settlement and supplier delivery from one durable record.</p></div><button type="button" className="btn-secondary" disabled={!items.some((item) => !item.readAt)} onClick={() => void readAll()}>Mark all read</button></div>
    {loading ? <p role="status" className="rounded-2xl bg-slate-50 p-6 text-sm text-slate-500">Loading notifications…</p> : null}
    {!loading && !items.length ? <div className="rounded-3xl border border-dashed border-slate-300 p-10 text-center"><p className="font-semibold">Nothing needs your attention</p><p className="mt-2 text-sm text-slate-500">New invoice and treasury events will appear here.</p></div> : null}
    <div className="space-y-3">{items.map((item) => <article key={item.id} className={`grid gap-4 rounded-2xl border p-5 sm:grid-cols-[auto_1fr_auto] sm:items-start ${item.readAt ? "border-slate-200 bg-white" : "border-cyan-300 bg-cyan-50/60"}`}><span className={`mt-1 size-3 rounded-full ${tone(item.priority)}`} /><div><div className="flex flex-wrap items-center gap-2"><h4 className="font-semibold">{item.title}</h4>{!item.readAt ? <span className="rounded-full bg-cyan-100 px-2 py-0.5 text-[10px] font-semibold uppercase text-cyan-800">New</span> : null}</div><p className="mt-2 text-sm leading-6 text-slate-600">{item.body}</p><p className="mt-3 text-xs text-slate-400">{new Date(item.createdAt).toLocaleString()} · {humanize(item.type)}</p></div><button type="button" onClick={() => void open(item)} className="btn-secondary">{item.actionView || item.type === "PAYMENT_FAILED" ? "Open" : item.readAt ? "Read" : "Mark read"}</button></article>)}</div>
  </section>;
}

function tone(priority: WorkspaceNotificationResponse["priority"]) { return priority === "ACTION" ? "bg-blue-600" : priority === "WARNING" ? "bg-amber-500" : priority === "SUCCESS" ? "bg-emerald-500" : "bg-slate-400"; }
function humanize(value: string) { return value.replaceAll("_", " ").toLowerCase(); }
