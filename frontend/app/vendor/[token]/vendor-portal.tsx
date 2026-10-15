"use client";

import { FormEvent, useEffect, useState } from "react";
import { getVendorPortal, listVendorPortalSubmissions, submitVendorPortalDocument, type VendorPortalSubmission } from "@/lib/api";

export function VendorPortal({ token }: { token: string }) {
  const [portal, setPortal] = useState<{ organizationName: string; vendorName: string } | null>(null);
  const [submissions, setSubmissions] = useState<VendorPortalSubmission[]>([]);
  const [file, setFile] = useState<File | null>(null);
  const [note, setNote] = useState("");
  const [replaces, setReplaces] = useState("");
  const [message, setMessage] = useState("Loading secure portal…");
  const [pending, setPending] = useState(false);

  useEffect(() => {
    Promise.all([getVendorPortal(token), listVendorPortalSubmissions(token)])
      .then(([details, history]) => { setPortal(details); setSubmissions(history); setMessage(""); })
      .catch((error: unknown) => setMessage(error instanceof Error ? error.message : "Portal unavailable"));
  }, [token]);

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (!file) return setMessage("Choose a document.");
    setPending(true);
    try {
      await submitVendorPortalDocument(token, file, note, replaces || undefined);
      setSubmissions(await listVendorPortalSubmissions(token));
      setFile(null); setNote(""); setReplaces(""); setMessage("Document submitted for review.");
    } catch (error) { setMessage(error instanceof Error ? error.message : "Submission failed"); }
    finally { setPending(false); }
  }

  return <main className="min-h-screen bg-slate-950 px-5 py-16 text-slate-100">
    <div className="mx-auto max-w-3xl">
      <p className="text-sm font-semibold uppercase tracking-[0.3em] text-cyan-300">OPES vendor portal</p>
      <h1 className="mt-4 text-4xl font-semibold">{portal ? `${portal.vendorName} × ${portal.organizationName}` : "Secure document intake"}</h1>
      <p className="mt-3 text-slate-400">Submit invoices and corrections for review. This portal cannot approve payments or change payout details.</p>
      {message ? <p className="mt-6 rounded-xl border border-slate-700 bg-slate-900 p-4">{message}</p> : null}
      {portal ? <form onSubmit={submit} className="mt-8 space-y-5 rounded-3xl border border-slate-800 bg-slate-900 p-6">
        <label className="block">Invoice or supporting document<input className="mt-2 block w-full" type="file" accept=".pdf,.json,.jpg,.jpeg,.png,.csv,.txt" onChange={(event) => setFile(event.target.files?.[0] ?? null)} required /></label>
        <label className="block">Correction of<select className="mt-2 block w-full rounded-xl bg-slate-800 p-3" value={replaces} onChange={(event) => setReplaces(event.target.value)}><option value="">New submission</option>{submissions.filter((item) => item.status === "SUBMITTED").map((item) => <option key={item.id} value={item.id}>{item.filename} · version {item.version}</option>)}</select></label>
        <label className="block">Note<textarea className="mt-2 block min-h-24 w-full rounded-xl bg-slate-800 p-3" maxLength={2000} value={note} onChange={(event) => setNote(event.target.value)} /></label>
        <button className="rounded-full bg-cyan-300 px-6 py-3 font-semibold text-slate-950 disabled:opacity-50" disabled={pending}>{pending ? "Submitting…" : "Submit for review"}</button>
      </form> : null}
      <section className="mt-10"><h2 className="text-xl font-semibold">Submission history</h2><div className="mt-4 space-y-3">{submissions.map((item) => <article key={item.id} className="flex items-center justify-between rounded-2xl border border-slate-800 p-4"><div><p className="font-medium">{item.filename}</p><p className="text-sm text-slate-400">Version {item.version}</p></div><span className="rounded-full bg-slate-800 px-3 py-1 text-sm">{item.status}</span></article>)}</div></section>
    </div>
  </main>;
}
