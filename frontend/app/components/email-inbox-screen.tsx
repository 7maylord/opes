"use client";

import { FormEvent, useEffect, useState } from "react";
import { toast } from "sonner";
import {
  configureEmailInbox,
  getEmailInbox,
  listInboundEmailEvents,
  type EmailInboxResponse,
  type InboundEmailEventResponse,
} from "@/lib/api";

export function EmailInboxScreen({ token, organizationId, canManage }: { token: string; organizationId: string; canManage: boolean }) {
  const [inbox, setInbox] = useState<EmailInboxResponse | null>(null);
  const [events, setEvents] = useState<InboundEmailEventResponse[]>([]);
  const [address, setAddress] = useState("");
  const [pending, setPending] = useState(false);
  const attachmentCount = events.reduce((total, item) => total + item.documents.length, 0);
  const attentionCount = events.filter((item) => item.status === "FAILED" || item.status === "QUARANTINED").length;

  useEffect(() => {
    let cancelled = false;
    Promise.all([getEmailInbox(token, organizationId), listInboundEmailEvents(token, organizationId)])
      .then(([nextInbox, nextEvents]) => {
        if (cancelled) return;
        setInbox(nextInbox);
        setAddress(nextInbox?.address ?? "");
        setEvents(nextEvents);
      })
      .catch((error: unknown) => {
        if (!cancelled) toast.error(error instanceof Error ? error.message : "Unable to load email inbox");
      });
    return () => { cancelled = true; };
  }, [organizationId, token]);

  async function save(event: FormEvent) {
    event.preventDefault();
    setPending(true);
    try {
      const configured = await configureEmailInbox(token, organizationId, address);
      setInbox(configured);
      setAddress(configured.address);
      toast.success("Workspace inbox saved");
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Unable to configure inbox");
    } finally {
      setPending(false);
    }
  }

  async function refresh() {
    setPending(true);
    try {
      setEvents(await listInboundEmailEvents(token, organizationId));
      toast.success("Inbox refreshed");
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Unable to refresh inbox");
    } finally {
      setPending(false);
    }
  }

  return (
    <section className="space-y-6" aria-labelledby="email-inbox-title">
      <div className="flex flex-col gap-4 md:flex-row md:items-start md:justify-between">
        <div>
          <p className="text-xs font-semibold uppercase tracking-[0.2em] text-cyan-700">Automatic intake</p>
          <h3 id="email-inbox-title" className="mt-2 text-3xl font-semibold">Invoice email inbox</h3>
          <p className="mt-2 max-w-2xl text-sm text-slate-600">Attachments become immutable evidence and enter extraction review. Sender details remain untrusted evidence.</p>
        </div>
        <button type="button" onClick={() => void refresh()} disabled={pending} className="btn-secondary">Refresh</button>
      </div>

      <div className="grid gap-4 xl:grid-cols-[minmax(0,1fr)_20rem]">
        <div className="rounded-3xl bg-slate-950 p-6 text-white">
          <p className="text-xs font-semibold uppercase tracking-[0.2em] text-cyan-300">Receiving address</p>
          <div className="mt-4 flex items-center gap-2">
            <p className="min-w-0 flex-1 break-all text-2xl font-semibold">{inbox?.address || "Not activated"}</p>
            {inbox ? <button type="button" aria-label="Copy workspace inbox" title="Copy workspace inbox" className="inline-flex size-10 shrink-0 items-center justify-center rounded-xl bg-white/10 text-cyan-200 hover:bg-white/20" onClick={() => { void navigator.clipboard.writeText(inbox.address).then(() => toast.success("Inbox address copied")).catch(() => toast.error("Unable to copy address")); }}><CopyIcon /></button> : null}
          </div>
          <p className="mt-3 text-sm leading-6 text-slate-300">Send or forward vendor invoices here. OPES validates attachments and places accepted evidence into review.</p>
          <div className="mt-5 flex items-center gap-2 text-sm"><span className={`size-2.5 rounded-full ${inbox ? "bg-emerald-400" : "bg-amber-400"}`} />{inbox ? "Active and receiving" : "Setup required"}</div>
        </div>
        <form onSubmit={save} className="rounded-3xl border border-slate-200 bg-slate-50 p-5">
          <h4 className="font-semibold">Choose your workspace inbox</h4>
          <p className="mt-1 text-sm leading-6 text-slate-500">Choose an available address on mail.maylord.xyz. Each address can belong to only one workspace.</p>
          <label className="mt-4 block text-sm font-medium text-slate-700">Preferred address<input type="email" required disabled={!canManage} value={address} onChange={(event) => setAddress(event.target.value)} placeholder="accounts@mail.maylord.xyz" className="mt-2 min-h-11 w-full rounded-xl border border-slate-300 bg-white px-4 outline-none focus:ring-2 focus:ring-cyan-500 disabled:bg-slate-100" /></label>
          <button disabled={!canManage || pending} className="btn mt-4 w-full">{inbox ? "Save address" : "Activate inbox"}</button>
        </form>
      </div>
      {!canManage ? <p className="mt-3 text-sm text-slate-500">Only workspace owners and admins can change the workspace inbox.</p> : null}

      <div className="rounded-3xl border border-blue-200 bg-blue-50 p-6">
        <div className="flex flex-col gap-4 md:flex-row md:items-start md:justify-between">
          <div><p className="text-xs font-semibold uppercase tracking-[0.18em] text-blue-700">Gmail forwarding</p><h4 className="mt-2 text-xl font-semibold">Keep using your existing Gmail address</h4><p className="mt-2 max-w-2xl text-sm leading-6 text-slate-600">Gmail can forward invoice messages into this workspace. Your Gmail address remains the address vendors already know.</p></div>
          <a href="https://mail.google.com/mail/u/0/#settings/fwdandpop" target="_blank" rel="noreferrer" className="btn-secondary shrink-0">Open Gmail settings ↗</a>
        </div>
        <ol className="mt-5 grid gap-3 text-sm text-slate-700 md:grid-cols-3">
          <li className="rounded-2xl bg-white p-4"><strong className="block text-slate-950">1. Add the address</strong><span className="mt-1 block">In Gmail forwarding settings, add {inbox?.address || "your OPES workspace inbox"}.</span></li>
          <li className="rounded-2xl bg-white p-4"><strong className="block text-slate-950">2. Verify it here</strong><span className="mt-1 block">Refresh delivery history, then open Gmail&apos;s confirmation message below to copy its code or link.</span></li>
          <li className="rounded-2xl bg-white p-4"><strong className="block text-slate-950">3. Filter invoices</strong><span className="mt-1 block">Create a Gmail filter that forwards only vendor invoice messages and attachments.</span></li>
        </ol>
      </div>

      <div className="grid gap-3 sm:grid-cols-3"><Metric label="Messages" value={events.length} /><Metric label="Attachments accepted" value={attachmentCount} /><Metric label="Needs attention" value={attentionCount} alert={attentionCount > 0} /></div>

      <div className="space-y-3">
        <div className="flex items-center justify-between">
          <h4 className="text-lg font-semibold">Delivery history</h4>
          <span className="text-sm text-slate-500">Latest 100</span>
        </div>
        {events.length === 0 ? <p className="rounded-2xl border border-dashed border-slate-300 p-8 text-center text-sm text-slate-600">No email has reached this workspace inbox yet.</p> : null}
        {events.map((item) => (
          <article key={item.id} className="rounded-2xl border border-slate-200 p-5 transition hover:border-slate-300">
            <div className="flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between">
              <div>
                <h5 className="font-semibold">{item.subject || "No subject"}</h5>
                <p className="mt-1 text-sm text-slate-600">From {item.senderAddress} · {new Date(item.receivedAt).toLocaleString()}</p>
              </div>
              <Status value={item.status} />
            </div>
            {item.quarantineReason || item.failureReason ? <p className="mt-3 text-sm text-red-700">{humanize(item.quarantineReason || item.failureReason || "")}</p> : null}
            {item.previewText ? <details className="mt-3 rounded-xl bg-slate-50 px-3 py-2 text-sm"><summary className="cursor-pointer font-medium">View message text</summary><pre className="mt-3 whitespace-pre-wrap break-words font-sans text-slate-600">{item.previewText}</pre></details> : null}
            {item.documents.length > 0 ? <ul className="mt-3 grid gap-2 sm:grid-cols-2">{item.documents.map((document) => <li key={document.id} className="rounded-xl bg-slate-50 px-3 py-2 text-sm"><span className="font-medium">{document.filename}</span><span className="ml-2 text-slate-500">{humanize(document.status)}</span></li>)}</ul> : <p className="mt-3 text-sm text-slate-500">No accepted attachment.</p>}
          </article>
        ))}
      </div>
    </section>
  );
}

function Status({ value }: { value: string }) {
  const tone = value === "PROCESSED" ? "bg-emerald-100 text-emerald-800" : value === "FAILED" || value === "QUARANTINED" ? "bg-red-100 text-red-800" : "bg-amber-100 text-amber-800";
  return <span className={`w-fit rounded-full px-3 py-1 text-xs font-semibold ${tone}`}>{humanize(value)}</span>;
}

function Metric({ label, value, alert = false }: { label: string; value: number; alert?: boolean }) { return <div className={`rounded-2xl p-4 ${alert ? "bg-red-50" : "bg-slate-50"}`}><p className="text-xs uppercase tracking-[0.16em] text-slate-500">{label}</p><p className={`mt-2 text-2xl font-semibold ${alert ? "text-red-700" : "text-slate-950"}`}>{value}</p></div>; }

function CopyIcon() { return <svg aria-hidden="true" viewBox="0 0 24 24" className="size-4 fill-none stroke-current" strokeWidth="1.8"><rect x="9" y="9" width="11" height="11" rx="2" /><path d="M15 9V6a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v7a2 2 0 0 0 2 2h3" /></svg>; }

function humanize(value: string) { return value.replaceAll("_", " ").toLowerCase(); }
