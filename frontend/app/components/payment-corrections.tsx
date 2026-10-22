"use client";
import { FormEvent, useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import { createPaymentCorrection, listPaymentCorrections, listWorkspaceRecords, type PaymentCorrectionResponse } from "@/lib/api";
import { formatAtomic, parseDecimalToAtomic } from "@/lib/money";
import type { WorkspaceRecord } from "@/lib/workspace-api.generated";

export function PaymentCorrections({ token, organizationId }: { token: string; organizationId: string }) {
  const submission = useRef<{ fingerprint: string; key: string } | null>(null);
  const [items, setItems] = useState<PaymentCorrectionResponse[]>([]); const [executions, setExecutions] = useState<WorkspaceRecord[]>([]);
  const [type, setType] = useState<"CREDIT_NOTE" | "REFUND">("CREDIT_NOTE"); const [executionId, setExecutionId] = useState(""); const [creditNoteId, setCreditNoteId] = useState(""); const [amount, setAmount] = useState(""); const [reason, setReason] = useState(""); const [transactionHash, setTransactionHash] = useState(""); const [pending, setPending] = useState(false);
  async function load() { const [corrections, page] = await Promise.all([listPaymentCorrections(token, organizationId), listWorkspaceRecords(token, organizationId, "execution", { limit: 50 })]); setItems(corrections); const confirmed=page.items.filter((item)=>item.status==="CONFIRMED"); setExecutions(confirmed); setExecutionId((current)=>current || confirmed[0]?.id || ""); }
  useEffect(() => { let active=true; Promise.all([listPaymentCorrections(token, organizationId), listWorkspaceRecords(token, organizationId, "execution", { limit: 50 })]).then(([corrections,page])=>{if(!active)return;setItems(corrections);const confirmed=page.items.filter((item)=>item.status==="CONFIRMED");setExecutions(confirmed);setExecutionId(confirmed[0]?.id??"");}).catch((error: unknown)=>toast.error(error instanceof Error?error.message:"Unable to load corrections"));return()=>{active=false;}; }, [organizationId, token]);
  const creditNotes=useMemo(()=>items.filter((item)=>item.type==="CREDIT_NOTE"&&item.executionId===executionId),[executionId,items]);
  async function submit(event: FormEvent) {
    event.preventDefault();
    if (pending) return;
    setPending(true);
    try {
      const input = { type, executionId, creditNoteId: type === "REFUND" ? creditNoteId : undefined, amountAtomic: parseDecimalToAtomic(amount, 6), reason, transactionHash: type === "REFUND" ? transactionHash : undefined };
      const fingerprint = JSON.stringify({ organizationId, ...input });
      if (submission.current?.fingerprint !== fingerprint) submission.current = { fingerprint, key: crypto.randomUUID() };
      await createPaymentCorrection(token, organizationId, input, submission.current.key);
      submission.current = null;
      setAmount(""); setReason(""); setTransactionHash("");
      toast.success(type === "REFUND" ? "Verified refund posted" : "Credit note posted");
      await load();
    } catch (error) { toast.error(error instanceof Error ? error.message : "Unable to post correction"); }
    finally { setPending(false); }
  }
  return <section className="space-y-6"><div><p className="text-xs font-semibold uppercase tracking-[0.2em] text-blue-700">Accounting corrections</p><h3 className="mt-2 text-3xl font-semibold">Credit notes and refunds</h3><p className="mt-2 text-sm text-slate-600">Post an immutable correction against a confirmed payment. Refunds must consume an existing credit note. OPES verifies that confirmed USDC returned from the paid vendor wallet to the original treasury.</p></div><form onSubmit={submit} className="grid gap-4 rounded-3xl border border-slate-200 bg-slate-50 p-5 md:grid-cols-2"><Select label="Correction type" value={type} onChange={(value)=>setType(value as typeof type)} options={["CREDIT_NOTE","REFUND"]}/><Select label="Confirmed payment" value={executionId} onChange={setExecutionId} options={executions.map((item)=>item.id)} labels={Object.fromEntries(executions.map((item)=>[item.id,item.title]))}/>{type==="REFUND"?<><Select label="Credit note" value={creditNoteId} onChange={setCreditNoteId} options={creditNotes.map((item)=>item.id)} labels={Object.fromEntries(creditNotes.map((item)=>[item.id,`${formatAtomic(item.amountAtomic,6)} USDC · ${item.reason}`]))}/><Input label="Refund transaction hash" value={transactionHash} onChange={setTransactionHash}/></>:null}<Input label="Amount (USDC)" value={amount} onChange={setAmount}/><Input label="Reason" value={reason} onChange={setReason}/><button disabled={pending||!executionId||(type==="REFUND"&&!creditNoteId)} className="btn md:col-span-2">{pending?"Posting…":`Post ${type.toLowerCase().replace("_"," ")}`}</button></form><div className="space-y-3">{items.map((item)=><article key={item.id} className="rounded-2xl border border-slate-200 p-4"><div className="flex justify-between gap-3"><strong>{item.type.replaceAll("_"," ")}</strong><span>{formatAtomic(item.amountAtomic,6)} USDC</span></div><p className="mt-2 text-sm text-slate-600">{item.reason}</p><p className="mt-2 break-all text-xs text-slate-400">Payment {item.executionId}{item.transactionHash?` · ${item.transactionHash}`:""}</p></article>)}</div></section>;
}
function Input({label,value,onChange}:{label:string;value:string;onChange:(value:string)=>void}){return <label className="text-sm font-medium">{label}<input required value={value} onChange={(event)=>onChange(event.target.value)} className="mt-2 min-h-11 w-full rounded-xl border border-slate-300 bg-white px-3"/></label>}
function Select({label,value,onChange,options,labels={}}:{label:string;value:string;onChange:(value:string)=>void;options:string[];labels?:Record<string,string>}){return <label className="text-sm font-medium">{label}<select required value={value} onChange={(event)=>onChange(event.target.value)} className="mt-2 min-h-11 w-full rounded-xl border border-slate-300 bg-white px-3 pr-9"><option value="">Select</option>{options.map((option)=><option key={option} value={option}>{labels[option]??option.replaceAll("_"," ")}</option>)}</select></label>}
