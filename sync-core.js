// Доставка и телефонные остатки без двойного списания (задача 36.3).
export const isFinancial=e=>e.payload?e.payload.kind==='finance':/^(Финансы|Чек):/i.test(e.text);
export const isLocked=e=>!!(e.exportedAt||e.cloudRevision||e.cloudSending);
export function connection(v){
  if(v?.app!=='zahvat-drive'||v.v!==1||v.role!=='phone'||!/^https:\/\/script\.google\.com\/macros\/s\/[A-Za-z0-9_-]+\/exec$/.test(v.url)||typeof v.key!=='string'||v.key.length<64||v.key.length>200)
    throw new Error('Выберите файл organizer-drive-phone.json из своей папки обмена.');
  return {app:v.app,v:1,role:'phone',url:v.url,key:v.key};
}
export function wireRecord(e){
  const d=new Date(e.ts),pad=n=>String(n).padStart(2,'0');
  const captured=`${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
  return {id:e.id,revision:e.updatedAt,captured,text:e.text,source:e.source==='voice'?'voice':'text',payload:e.payload?{...e.payload,revision:e.updatedAt}:null};
}
/** Учитывать только факт, которого ещё нет в этой версии снимка компьютера. */
export function adjustedBalances(snapshot,entries,today){
  if(!snapshot?.accounts)return null;
  const applied=new Map((snapshot.applied||[]).map(r=>[r.id,r.revision])),legacy=new Set(snapshot.legacyApplied||[]);
  const rows=snapshot.accounts.map(a=>({...a,pending:0,uncertain:0})),byName=new Map(rows.map(a=>[a.name,a]));
  for(const e of entries){
    const p=e.payload;if(!isFinancial(e)||applied.get(e.id)===e.updatedAt||legacy.has(e.id))continue;
    if(!p){for(const a of rows)a.uncertain++;continue;}
    if(p.planned||p.day>today)continue;
    const a=byName.get(p.account),to=byName.get(p.to_account);
    if(!Number.isSafeInteger(p.amount)||p.amount<=0||!a){for(const row of rows)row.uncertain++;continue;}
    if(p.mode==='expense')a.pending-=p.amount;else if(p.mode==='income')a.pending+=p.amount;
    else if(p.mode==='transfer'&&to&&a.currency===to.currency){a.pending-=p.amount;to.pending+=p.amount;}else a.uncertain++;
  }
  return rows.map(a=>({...a,estimated:a.amount+a.pending,availableEstimated:a.available+a.pending}));
}
export function mergeResult(entries,response,at){
  const uploaded=new Map((response.uploaded||[]).map(r=>[r.id,r.revision]));
  const receipts=new Map([...(response.snapshot?.receipts||[]),...(response.receipts||[])].map(r=>[r.id,r])),conflicts=new Set(response.conflicts||[]);
  return entries.map(e=>{
    const v={...e};if(uploaded.get(e.id)===e.updatedAt){v.cloudRevision=e.updatedAt;v.cloudAt=at;v.cloudSending=false;}
    if(conflicts.has(e.id)){v.cloudConflict=e.updatedAt;v.delivery='waiting';v.deliveryError='На Диске уже есть другая версия. Исправьте запись в Органайзере.';}
    if((response.acknowledged||[]).some(a=>a.id===e.id&&a.revision===e.updatedAt))v.cloudAck=true;
    const r=receipts.get(e.id);if(r&&r.revision===e.updatedAt&&['received','waiting','rejected'].includes(r.status)){v.delivery=r.status;v.deliveryError=r.error||'';}
    return v;
  });
}
