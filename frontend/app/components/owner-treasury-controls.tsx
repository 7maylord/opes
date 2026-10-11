"use client";
import { useState } from "react";
import { useSendTransaction } from "@privy-io/react-auth";
import { confirmLifecycleAction, prepareTreasuryAction } from "@/lib/api";

export function OwnerTreasuryControls({token,organizationId}:{token:string;organizationId:string}){
  const {sendTransaction}=useSendTransaction();const [amount,setAmount]=useState('1000000');const [address,setAddress]=useState('');const [message,setMessage]=useState('');const [pending,setPending]=useState(false);
  async function run(action:string,input:Record<string,unknown>={}){setPending(true);setMessage('');try{const prepared=await prepareTreasuryAction(token,organizationId,{action,...input});const transaction=await sendTransaction({to:prepared.to,data:prepared.data,chainId:prepared.chainId,value:0});await confirmLifecycleAction(token,organizationId,prepared.id,transaction.hash);setMessage(`${action} confirmed`);}catch(error){setMessage(error instanceof Error?error.message:'Treasury action failed');}finally{setPending(false);}}
  return <div className="space-y-3 text-sm">
    <p className="text-slate-600">Every control opens a Privy owner signature and is recorded only after exact onchain confirmation.</p>
    <div className="grid gap-2 sm:grid-cols-2"><input aria-label="Atomic USDC amount" value={amount} onChange={e=>setAmount(e.target.value)} className="min-h-11 rounded-2xl border px-4"/><input aria-label="Vendor or successor address" value={address} onChange={e=>setAddress(e.target.value)} placeholder="0x…" className="min-h-11 rounded-2xl border px-4"/></div>
    <div className="flex flex-wrap gap-2">
      <button disabled={pending} onClick={()=>run('PAUSE_VAULT')} className="btn-secondary">Pause vault</button><button disabled={pending} onClick={()=>run('RESUME_VAULT')} className="btn-secondary">Resume vault</button>
      <button disabled={pending} onClick={()=>run('PAUSE_ESCROW')} className="btn-secondary">Pause escrow</button><button disabled={pending} onClick={()=>run('RESUME_ESCROW')} className="btn-secondary">Resume escrow</button>
      <button disabled={pending} onClick={()=>run('SET_LIMITS',{autonomousAtomic:amount,singleAtomic:amount,dailyAtomic:amount})} className="btn-secondary">Set limits</button>
      <button disabled={pending} onClick={()=>run('SET_VENDOR',{vendor:address,allowed:true,dailyAtomic:amount})} className="btn-secondary">Allow vendor</button>
      <button disabled={pending} onClick={()=>run('RECOVER_USDC',{amountAtomic:amount})} className="btn-secondary">Recover USDC</button>
      <button disabled={pending} onClick={()=>run('HANDOVER_VAULT',{newAdmin:address})} className="btn-secondary">Handover vault</button><button disabled={pending} onClick={()=>run('HANDOVER_ESCROW',{newAdmin:address})} className="btn-secondary">Handover escrow</button>
    </div>{message?<p className="rounded-xl border p-3">{message}</p>:null}
  </div>;
}
