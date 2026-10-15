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
      toast.success("Invoice inbox activated");
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
    <section className="rounded-3xl border border-slate-200 bg-white p-5 shadow-sm md:p-8" aria-labelledby="email-inbox-title">
      <div className="flex flex-col gap-4 md:flex-row md:items-start md:justify-between">
        <div>
          <p className="text-xs font-semibold uppercase tracking-[0.2em] text-cyan-700">Automatic intake</p>
          <h3 id="email-inbox-title" className="mt-2 text-3xl font-semibold">Invoice email inbox</h3>
          <p className="mt-2 max-w-2xl text-sm text-slate-600">Attachments become immutable evidence and enter extraction review. Sender details remain untrusted evidence.</p>
        </div>
        <button type="button" onClick={() => void refresh()} disabled={pending} className="btn-secondary">Refresh</button>
      </div>

      <form onSubmit={save} className="mt-6 grid gap-3 rounded-2xl bg-slate-50 p-4 md:grid-cols-[1fr_auto]">
        <label className="text-sm font-medium text-slate-700">
          Workspace inbox
          <input type="email" required disabled={!canManage} value={address} onChange={(event) => setAddress(event.target.value)} placeholder="invoices@mail.maylord.xyz" className="mt-2 min-h-11 w-full rounded-2xl border border-slate-300 bg-white px-4 outline-none focus:ring-2 focus:ring-cyan-500 disabled:bg-slate-100" />
        </label>
        <button disabled={!canManage || pending} className="btn self-end">{inbox ? "Update inbox" : "Activate inbox"}</button>
      </form>
      {!canManage ? <p className="mt-3 text-sm text-slate-500">Only workspace owners and admins can change the inbound address.</p> : null}

      <div className="mt-8 space-y-3">
        <div className="flex items-center justify-between">
          <h4 className="text-lg font-semibold">Delivery history</h4>
          <span className="text-sm text-slate-500">Latest 100</span>
        </div>
        {events.length === 0 ? <p className="rounded-2xl border border-dashed border-slate-300 p-8 text-center text-sm text-slate-600">No email has reached this workspace inbox yet.</p> : null}
        {events.map((item) => (
          <article key={item.id} className="rounded-2xl border border-slate-200 p-4">
            <div className="flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between">
              <div>
                <h5 className="font-semibold">{item.subject || "No subject"}</h5>
                <p className="mt-1 text-sm text-slate-600">From {item.senderAddress} · {new Date(item.receivedAt).toLocaleString()}</p>
              </div>
              <Status value={item.status} />
            </div>
            {item.quarantineReason || item.failureReason ? <p className="mt-3 text-sm text-red-700">{humanize(item.quarantineReason || item.failureReason || "")}</p> : null}
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

function humanize(value: string) { return value.replaceAll("_", " ").toLowerCase(); }
