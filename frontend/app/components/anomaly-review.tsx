"use client";
import { useEffect, useState } from "react";
import { toast } from "sonner";
import { getAnomalyReview, type AnomalySignalResponse, type NotificationView } from "@/lib/api";

export function AnomalyReview({ token, organizationId, onNavigate }: { token: string; organizationId: string; onNavigate: (view: NotificationView, id?: string) => void }) {
  const [signals, setSignals] = useState<AnomalySignalResponse[]>([]);
  useEffect(() => { let active = true; getAnomalyReview(token, organizationId).then((value) => active && setSignals(value.signals)).catch((error: unknown) => toast.error(error instanceof Error ? error.message : "Unable to load anomaly review")); return () => { active = false; }; }, [organizationId, token]);
  return <section className="space-y-5"><div><p className="text-xs font-semibold uppercase tracking-[0.2em] text-blue-700">Explainable review</p><h3 className="mt-2 text-3xl font-semibold">Anomaly review</h3><p className="mt-2 text-sm text-slate-600">Deterministic signals help reviewers focus. They never authorize, reject, or execute a payment.</p></div>{signals.length === 0 ? <p className="rounded-3xl border border-dashed border-slate-300 p-10 text-center text-sm text-slate-500">No duplicate, amount, frequency, or payout-change signals need review.</p> : <div className="grid gap-3 lg:grid-cols-2">{signals.map((signal) => <article key={signal.id} className="rounded-3xl border border-slate-200 bg-slate-50 p-5"><span className="text-xs font-bold uppercase tracking-wider text-amber-700">{signal.kind.replaceAll("_", " ")}</span><h4 className="mt-2 font-semibold">{signal.title}</h4><p className="mt-2 text-sm leading-6 text-slate-600">{signal.explanation}</p><button className="btn-secondary mt-4" onClick={() => onNavigate(signal.actionView, signal.actionView === "invoices" ? signal.relatedRecordId : undefined)}>Review source</button></article>)}</div>}</section>;
}
