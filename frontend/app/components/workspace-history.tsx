"use client";

import { FormEvent, useCallback, useEffect, useState } from "react";
import { toast } from "sonner";
import { getWorkspaceRecord, listWorkspaceRecords } from "@/lib/api";
import type {
  WorkspaceDetail,
  WorkspaceKind,
  WorkspaceRecord,
} from "@/lib/workspace-api.generated";
import { formatAtomic } from "@/lib/money";

const kinds: Array<{ value: WorkspaceKind; label: string }> = [
  { value: "invoice", label: "Invoices" },
  { value: "decision", label: "Decisions" },
  { value: "execution", label: "Payments" },
  { value: "vendor", label: "Vendors" },
  { value: "subscription", label: "Subscriptions" },
  { value: "escrow", label: "Escrow" },
  { value: "ledger", label: "Ledger" },
  { value: "evidence", label: "Evidence" },
  { value: "audit", label: "Audit" },
  { value: "connector", label: "Connectors" },
];

export function WorkspaceHistory({ token, organizationId }: { token: string; organizationId: string }) {
  const [kind, setKind] = useState<WorkspaceKind>("invoice");
  const [items, setItems] = useState<WorkspaceRecord[]>([]);
  const [detail, setDetail] = useState<WorkspaceDetail | null>(null);
  const [searchDraft, setSearchDraft] = useState("");
  const [search, setSearch] = useState("");
  const [statusDraft, setStatusDraft] = useState("");
  const [status, setStatus] = useState("");
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadFailed, setLoadFailed] = useState(false);
  const [retryKey, setRetryKey] = useState(0);

  const load = useCallback(async (cursor?: string) => {
    setLoading(true);
    setLoadFailed(false);
    try {
      const page = await listWorkspaceRecords(token, organizationId, kind, {
        cursor,
        search: search || undefined,
        status: status || undefined,
        limit: 12,
      });
      setItems((current) => (cursor ? [...current, ...page.items] : page.items));
      setNextCursor(page.nextCursor);
      if (!cursor) setDetail(null);
    } catch (reason) {
      setLoadFailed(true);
      toast.error(reason instanceof Error ? reason.message : "Unable to load workspace history", {
        id: "workspace-history-load-error",
        action: { label: "Retry", onClick: () => setRetryKey((current) => current + 1) },
      });
    } finally {
      setLoading(false);
    }
  }, [kind, organizationId, search, status, token]);

  useEffect(() => {
    let cancelled = false;
    listWorkspaceRecords(token, organizationId, kind, {
      search: search || undefined,
      status: status || undefined,
      limit: 12,
    }).then((page) => {
      if (cancelled) return;
      setItems(page.items);
      setNextCursor(page.nextCursor);
      setDetail(null);
      setLoadFailed(false);
    }).catch((reason: unknown) => {
      if (!cancelled) {
        setLoadFailed(true);
        toast.error(reason instanceof Error ? reason.message : "Unable to load workspace history", {
          id: "workspace-history-load-error",
          action: { label: "Retry", onClick: () => setRetryKey((current) => current + 1) },
        });
      }
    }).finally(() => {
      if (!cancelled) setLoading(false);
    });
    return () => { cancelled = true; };
  }, [kind, organizationId, retryKey, search, status, token]);

  async function openRecord(record: WorkspaceRecord) {
    try {
      setDetail(await getWorkspaceRecord(token, organizationId, record.kind, record.id));
    } catch (reason) {
      toast.error(reason instanceof Error ? reason.message : "Unable to load record detail");
    }
  }

  function submitSearch(event: FormEvent) {
    event.preventDefault();
    setItems([]);
    setLoading(true);
    setSearch(searchDraft.trim());
    setStatus(statusDraft.trim().toUpperCase());
  }

  return (
    <section className="rounded-3xl border border-slate-200 bg-white p-5 shadow-sm md:p-6" aria-labelledby="workspace-history-title">
      <div className="flex flex-col gap-4 lg:flex-row lg:items-end lg:justify-between">
        <div>
          <p className="text-xs font-semibold uppercase tracking-[0.2em] text-cyan-700">Persistent workspace</p>
          <h3 id="workspace-history-title" className="mt-2 text-2xl font-semibold">History and evidence</h3>
          <p className="mt-2 max-w-2xl text-sm text-slate-600">Reload every treasury record, inspect its timeline, and follow confirmed transactions to the explorer.</p>
        </div>
        <form onSubmit={submitSearch} className="flex w-full max-w-xl flex-col gap-2 sm:flex-row">
          <label className="sr-only" htmlFor="workspace-search">Search records</label>
          <input id="workspace-search" value={searchDraft} onChange={(event) => setSearchDraft(event.target.value)} placeholder="Search title or vendor" className="min-h-11 flex-1 rounded-2xl border border-slate-300 px-4 outline-none focus:ring-2 focus:ring-cyan-500" />
          <label className="sr-only" htmlFor="workspace-status">Filter status</label>
          <input id="workspace-status" value={statusDraft} onChange={(event) => setStatusDraft(event.target.value)} placeholder="Status" className="min-h-11 w-full rounded-2xl border border-slate-300 px-4 outline-none focus:ring-2 focus:ring-cyan-500 sm:w-32" />
          <button className="btn">Filter</button>
        </form>
      </div>

      <div className="mt-5 flex gap-2 overflow-x-auto pb-2" role="tablist" aria-label="Workspace record type">
        {kinds.map((item) => (
          <button key={item.value} type="button" role="tab" aria-selected={kind === item.value} onClick={() => { setKind(item.value); setItems([]); setLoading(true); }} className={kind === item.value ? "rounded-full bg-slate-950 px-4 py-2 text-sm font-semibold text-white" : "rounded-full border border-slate-300 px-4 py-2 text-sm font-semibold text-slate-700"}>{item.label}</button>
        ))}
      </div>

      {loading && items.length === 0 ? <p className="mt-6 text-sm text-slate-600" role="status">Loading records…</p> : null}
      {!loading && !loadFailed && items.length === 0 ? <p className="mt-6 rounded-2xl border border-dashed border-slate-300 p-8 text-center text-sm text-slate-600">No {kinds.find((item) => item.value === kind)?.label.toLowerCase()} match this view.</p> : null}

      <div className="mt-5 grid gap-5 xl:grid-cols-[minmax(0,1fr)_minmax(320px,0.72fr)]">
        <div className="grid content-start gap-3 sm:grid-cols-2">
          {items.map((record) => <RecordCard key={record.id} record={record} selected={detail?.record.id === record.id} onOpen={() => void openRecord(record)} />)}
          {nextCursor ? <button type="button" disabled={loading} onClick={() => void load(nextCursor)} className="btn-secondary sm:col-span-2">{loading ? "Loading…" : "Load more"}</button> : null}
        </div>
        <DetailPanel detail={detail} />
      </div>
    </section>
  );
}

function RecordCard({ record, selected, onOpen }: { record: WorkspaceRecord; selected: boolean; onOpen: () => void }) {
  const explorer = transactionUrl(record.chainId, record.transactionHash);
  return (
    <article className={selected ? "rounded-2xl border border-cyan-500 bg-cyan-50 p-4" : "rounded-2xl border border-slate-200 bg-slate-50 p-4"}>
      <div className="flex items-start justify-between gap-3">
        <div><h4 className="font-semibold">{record.title}</h4><p className="mt-1 text-sm text-slate-600">{record.subtitle}</p></div>
        <Status value={record.status} />
      </div>
      {record.amountAtomic && record.assetSymbol ? <p className="mt-4 text-xl font-semibold">{formatAtomic(record.amountAtomic, 6)} <span className="text-sm text-slate-500">{record.assetSymbol}</span></p> : null}
      <p className="mt-3 text-xs text-slate-500">{new Date(record.createdAt).toLocaleString()}</p>
      <div className="mt-4 flex gap-3 text-sm font-semibold">
        <button type="button" onClick={onOpen} className="text-cyan-800 underline">View detail</button>
        {explorer ? <a href={explorer} target="_blank" rel="noreferrer" className="text-cyan-800 underline">Explorer</a> : null}
      </div>
    </article>
  );
}

function DetailPanel({ detail }: { detail: WorkspaceDetail | null }) {
  if (!detail) return <aside className="rounded-2xl border border-dashed border-slate-300 p-6 text-sm text-slate-600">Choose a record to inspect its stored fields and activity.</aside>;
  const visibleDetails = Object.entries(detail.record.details).filter(([, value]) => value !== null && value !== "");
  const exportPayload = detail;
  function exportLineage() {
    const url = URL.createObjectURL(new Blob([JSON.stringify(exportPayload, null, 2)], { type: "application/json" }));
    const link = document.createElement("a");
    link.href = url;
    link.download = `opes-${exportPayload.record.kind}-${exportPayload.record.id}-lineage.json`;
    link.click();
    URL.revokeObjectURL(url);
  }
  return (
    <aside className="rounded-2xl border border-slate-200 bg-slate-950 p-5 text-slate-100">
      <div className="flex items-start justify-between gap-3"><h4 className="text-lg font-semibold">{detail.record.title}</h4><button type="button" onClick={exportLineage} className="text-sm font-semibold text-cyan-300 underline">Export lineage</button></div>
      {detail.blockers.length > 0 ? <section className="mt-5 rounded-2xl border border-red-400/40 bg-red-950/40 p-4" aria-labelledby="workspace-blockers"><h5 id="workspace-blockers" className="font-semibold text-red-200">Payment blockers and exceptions</h5><ul className="mt-3 space-y-2 text-sm text-red-100">{detail.blockers.map((blocker) => <li key={`${blocker.code}-${blocker.sourceId}`}><strong>{humanize(blocker.code)}:</strong> {blocker.message}</li>)}</ul></section> : <p className="mt-5 rounded-xl border border-emerald-400/30 bg-emerald-950/30 p-3 text-sm text-emerald-200">No stored blockers in this lineage.</p>}
      <dl className="mt-4 space-y-3 text-sm">
        {visibleDetails.map(([key, value]) => <div key={key} className="border-b border-white/10 pb-3"><dt className="text-slate-400">{humanize(key)}</dt><dd className="mt-1 break-words">{renderValue(value)}</dd></div>)}
      </dl>
      <h5 className="mt-6 font-semibold">Timeline</h5>
      {detail.history.length === 0 ? <p className="mt-3 text-sm text-slate-400">No linked activity yet.</p> : <ol className="mt-3 space-y-3">{detail.history.map((event) => <li key={event.id} className="rounded-xl bg-white/5 p-3 text-sm"><div className="flex justify-between gap-3"><span>{humanize(event.eventType)}</span><Status value={event.status} /></div><time className="mt-2 block text-xs text-slate-400">{new Date(event.createdAt).toLocaleString()}</time></li>)}</ol>}
      <h5 className="mt-6 font-semibold">Evidence and authorization lineage</h5>
      {detail.lineage.length === 0 ? <p className="mt-3 text-sm text-slate-400">This record has no invoice payment lineage.</p> : <ol className="mt-3 space-y-3">{detail.lineage.map((node) => { const chainId = typeof node.details.chainId === "number" ? node.details.chainId : detail.record.chainId; const explorer = transactionUrl(chainId, node.transactionHash); return <li key={`${node.type}-${node.id}`} className="rounded-xl border border-white/10 bg-white/5 p-3 text-sm"><div className="flex justify-between gap-3"><div><p className="font-semibold">{node.label}</p><p className="mt-1 text-xs text-slate-400">{humanize(node.type)} · {new Date(node.createdAt).toLocaleString()}</p></div><Status value={node.status} /></div>{Object.keys(node.details).length ? <details className="mt-3"><summary className="cursor-pointer text-cyan-300">Stored evidence</summary><pre className="mt-2 overflow-auto whitespace-pre-wrap break-words text-xs text-slate-300">{JSON.stringify(node.details, null, 2)}</pre></details> : null}{explorer ? <a href={explorer} target="_blank" rel="noreferrer" className="mt-3 inline-block text-cyan-300 underline">Transaction evidence</a> : null}</li>; })}</ol>}
    </aside>
  );
}

function Status({ value }: { value: string }) {
  return <span className="shrink-0 rounded-full bg-slate-200 px-2.5 py-1 text-xs font-semibold text-slate-700">{humanize(value)}</span>;
}

function humanize(value: string) { return value.replace(/[._]/g, " ").replace(/([a-z])([A-Z])/g, "$1 $2").toLowerCase(); }
function renderValue(value: unknown) { return typeof value === "object" ? JSON.stringify(value) : String(value); }
function transactionUrl(chainId: number | null, hash: string | null) {
  if (!hash) return null;
  const base = chainId === 5042002 ? "https://testnet.arcscan.app/tx/" : chainId === 84532 ? "https://sepolia.basescan.org/tx/" : null;
  return base ? `${base}${hash}` : null;
}
