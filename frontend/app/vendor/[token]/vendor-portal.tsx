"use client";

import { FormEvent, useEffect, useState } from "react";
import { toast } from "sonner";
import { getVendorPaymentAdvice, getVendorPortal, getVendorPortalStatus, listVendorPortalSubmissions, requestVendorPayoutChange, submitVendorPortalDocument, type VendorPortalStatus, type VendorPortalSubmission } from "@/lib/api";
import { formatAtomic } from "@/lib/money";

export function VendorPortal({ token }: { token: string }) {
  const [portal, setPortal] = useState<{ organizationName: string; vendorName: string } | null>(null);
  const [submissions, setSubmissions] = useState<VendorPortalSubmission[]>([]);
  const [status, setStatus] = useState<VendorPortalStatus | null>(null);
  const [payoutAddress, setPayoutAddress] = useState("");
  const [file, setFile] = useState<File | null>(null);
  const [note, setNote] = useState("");
  const [replaces, setReplaces] = useState("");
  const [loading, setLoading] = useState(true);
  const [pending, setPending] = useState(false);

  useEffect(() => {
    Promise.all([getVendorPortal(token), listVendorPortalSubmissions(token), getVendorPortalStatus(token)])
      .then(([details, history, current]) => { setPortal(details); setSubmissions(history); setStatus(current); })
      .catch((error: unknown) => toast.error(error instanceof Error ? error.message : "Portal unavailable"))
      .finally(() => setLoading(false));
  }, [token]);

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (!file) return toast.error("Choose a document.");
    setPending(true);
    try {
      await submitVendorPortalDocument(token, file, note, replaces || undefined);
      setSubmissions(await listVendorPortalSubmissions(token));
      setFile(null); setNote(""); setReplaces(""); toast.success("Document submitted for review.");
    } catch (error) { toast.error(error instanceof Error ? error.message : "Submission failed"); }
    finally { setPending(false); }
  }

  async function requestAddressChange(event: FormEvent) {
    event.preventDefault(); setPending(true);
    try { await requestVendorPayoutChange(token, payoutAddress); setStatus(await getVendorPortalStatus(token)); setPayoutAddress(""); toast.success("Payout address sent for re-verification."); }
    catch (error) { toast.error(error instanceof Error ? error.message : "Unable to request address change"); }
    finally { setPending(false); }
  }

  async function downloadAdvice(executionId: string) {
    try {
      const advice = await getVendorPaymentAdvice(token, executionId);
      const text = [`Payment advice from ${advice.organizationName}`, `Invoice: ${advice.invoiceNumber}`, `Amount: ${formatAtomic(advice.amountAtomic, 6)} ${advice.assetSymbol}`, `Network: ${advice.network}`, `Settled: ${new Date(advice.confirmedAt).toLocaleString()}`, `Transaction: ${advice.transactionHash}`].join("\n");
      const link = document.createElement("a"); link.href = URL.createObjectURL(new Blob([text], { type: "text/plain" })); link.download = `payment-advice-${advice.invoiceNumber}.txt`; link.click(); URL.revokeObjectURL(link.href);
    } catch (error) { toast.error(error instanceof Error ? error.message : "Payment advice unavailable"); }
  }

  return <main className="min-h-screen bg-slate-950 px-5 py-16 text-slate-100">
    <div className="mx-auto max-w-3xl">
      <p className="text-sm font-semibold uppercase tracking-[0.3em] text-cyan-300">OPES vendor portal</p>
      <h1 className="mt-4 text-4xl font-semibold">{portal ? `${portal.vendorName} × ${portal.organizationName}` : "Secure document intake"}</h1>
      <p className="mt-3 text-slate-400">Submit invoices and corrections for review. This portal cannot approve payments or change payout details.</p>
      {loading ? <p className="mt-6 text-slate-400" role="status">Loading secure portal…</p> : null}
      {portal ? <form onSubmit={submit} className="mt-8 space-y-5 rounded-3xl border border-slate-800 bg-slate-900 p-6">
        <label className="block">Invoice or supporting document<input className="mt-2 block w-full" type="file" accept=".pdf,.json,.jpg,.jpeg,.png,.csv,.txt" onChange={(event) => setFile(event.target.files?.[0] ?? null)} required /></label>
        <label className="block">Correction of<select className="mt-2 block w-full rounded-xl bg-slate-800 p-3" value={replaces} onChange={(event) => setReplaces(event.target.value)}><option value="">New submission</option>{submissions.filter((item) => item.status === "SUBMITTED").map((item) => <option key={item.id} value={item.id}>{item.filename} · version {item.version}</option>)}</select></label>
        <label className="block">Note<textarea className="mt-2 block min-h-24 w-full rounded-xl bg-slate-800 p-3" maxLength={2000} value={note} onChange={(event) => setNote(event.target.value)} /></label>
        <button className="rounded-full bg-cyan-300 px-6 py-3 font-semibold text-slate-950 disabled:opacity-50" disabled={pending}>{pending ? "Submitting…" : "Submit for review"}</button>
      </form> : null}
      {status ? <section className="mt-8 grid gap-5 md:grid-cols-2"><div className="rounded-3xl border border-slate-800 bg-slate-900 p-6"><h2 className="text-xl font-semibold">Payout address</h2>{status.payoutAddresses[0] ? <p className="mt-3 break-all text-sm text-slate-300">{status.payoutAddresses[0].payoutAddress}<span className="ml-2 rounded-full bg-slate-800 px-2 py-1 text-xs">{status.payoutAddresses[0].status.replaceAll("_", " ").toLowerCase()}</span></p> : <p className="mt-3 text-sm text-slate-400">No payout address is visible yet.</p>}<form onSubmit={requestAddressChange} className="mt-5"><label className="text-sm">Request replacement<input required value={payoutAddress} onChange={(event) => setPayoutAddress(event.target.value)} placeholder="0x…" className="mt-2 block min-h-11 w-full rounded-xl bg-slate-800 px-3" /></label><button disabled={pending || !status.payoutAddresses.some((item) => item.status === "VERIFIED_ACTIVE")} className="mt-3 rounded-full border border-slate-700 px-4 py-2 text-sm">Send for re-verification</button></form></div><div className="rounded-3xl border border-slate-800 bg-slate-900 p-6"><h2 className="text-xl font-semibold">Invoice status</h2><div className="mt-4 space-y-3">{status.invoices.length === 0 ? <p className="text-sm text-slate-400">No invoice status is available yet.</p> : status.invoices.map((invoice) => <div key={invoice.id} className="rounded-2xl bg-slate-800 p-4"><div className="flex justify-between gap-3"><strong>{invoice.invoiceNumber}</strong><span>{formatAtomic(invoice.amountAtomic, 6)} {invoice.assetSymbol}</span></div><p className="mt-2 text-sm text-slate-400">{(invoice.paymentStatus ?? invoice.status).replaceAll("_", " ").toLowerCase()}</p>{invoice.paymentStatus === "CONFIRMED" && invoice.executionId ? <button type="button" onClick={() => void downloadAdvice(invoice.executionId!)} className="mt-3 text-sm font-semibold text-cyan-300">Download payment advice</button> : null}</div>)}</div></div></section> : null}
      <section className="mt-10"><h2 className="text-xl font-semibold">Submission history</h2><div className="mt-4 space-y-3">{submissions.map((item) => <article key={item.id} className="flex items-center justify-between rounded-2xl border border-slate-800 p-4"><div><p className="font-medium">{item.filename}</p><p className="text-sm text-slate-400">Version {item.version}</p></div><span className="rounded-full bg-slate-800 px-3 py-1 text-sm">{item.status}</span></article>)}</div></section>
    </div>
  </main>;
}
