// Одна вкладка, один сценарий; включение покупки не создаёт факт (задача 36.3).
import * as db from './db.js';
import {adjustedBalances} from './sync-core.js';
const money=n=>(n/100).toLocaleString('ru-RU',{maximumFractionDigits:2})+' ₽';
const same=(a,b)=>JSON.stringify(a)===JSON.stringify(b);
const node=(tag,cls,text)=>{const e=document.createElement(tag);if(cls)e.className=cls;if(text!==undefined)e.textContent=text;return e;};

/** Покупки финансируются общей подушкой; свободные деньги не списываются второй раз. */
export function projectScenario(packet,choices,offset=0){
  const purchases=new Map(packet.purchases.map(p=>[p.id,p]));
  return packet.curve.map(point=>{
    let spending=0;
    for(const choice of choices){const p=purchases.get(choice.id);if(p&&p.eligible!==false&&choice.included&&choice.day&&choice.day<=point.day)spending+=p.amount;}
    return {...point,free:point.free+(typeof offset==='function'?offset(point.day):offset),cushion:point.cushion-spending};
  });
}

export class PhonePlan{
  constructor(drive,entries){this.drive=drive;this.entries=entries;this.packet=null;this.draft=null;this.command=null;}
  async init(){this.draft=await db.getSetting('phoneScenario')||null;await this.refresh();}
  async refresh(){
    this.packet=this.drive.state.snapshot?.plan||null;this.command=await db.getSetting('phonePlanCommand')||null;
    if(this.packet){
      if(!this.draft||!this.draft.dirty){this.resetDraft();}
      else if(this.command?.delivery==='received'&&this.packet.version!==this.draft.base){
        const unchanged=same(this.draft.choices,this.command.payload.choices);
        this.draft.base=this.packet.version;this.draft.dirty=!unchanged;if(unchanged)this.resetDraft();
      }
    }
    this.render();
  }
  resetDraft(){
    if(!this.packet)return;
    const saved=new Map(this.packet.choices.map(r=>[r.id,r]));
    this.draft={base:this.packet.version,dirty:false,choices:this.packet.purchases.map(p=>{
      const r=saved.get(p.id);return {id:p.id,version:p.version,day:r?.day??p.day??'',included:r?.included??p.included??!!p.day};
    })};
    db.setSetting('phoneScenario',this.draft);
  }
  offset(day){
    const balances=this.drive.state.snapshot?.balances;
    const rows=adjustedBalances(balances,this.entries(),day)||[];
    return rows.filter(r=>r.currency==='RUB'&&r.in_forecast).reduce((sum,r)=>sum+r.pending,0);
  }
  changed(p,choice,fields){
    Object.assign(choice,fields,{version:p.version});this.draft.dirty=true;
    db.setSetting('phoneScenario',structuredClone(this.draft));this.renderChart();this.renderStatus();
  }
  render(){
    const root=document.getElementById('phonePlanView');if(!root)return;root.replaceChildren();
    if(!this.packet){root.append(node('p','notice','Подключите Google Диск через меню и запустите Финансы на компьютере. После обмена здесь появятся остатки, график и покупки.'));return;}
    const totals=node('section','totals');
    for(const [caption,value] of [['Свободно сейчас',this.packet.freeNow+this.offset(new Date().toLocaleDateString('sv-SE'))],['Подушка сейчас',this.packet.cushionNow]]){
      const box=node('div');box.append(node('small','',caption),node('strong','',money(value)));totals.append(box);
    }
    const asOf=this.drive.state.snapshot.balances.asOf;
    const adjustments=adjustedBalances(this.drive.state.snapshot.balances,this.entries(),new Date().toLocaleDateString('sv-SE'))||[];
    const note=adjustments.some(a=>a.uncertain)?' · есть неразобранные':adjustments.some(a=>a.pending)?' · с новыми записями':'';
    root.append(totals,node('p','stamp','Данные ПК · '+new Date(asOf).toLocaleString('ru-RU',{day:'2-digit',month:'2-digit',hour:'2-digit',minute:'2-digit'})+note));
    const graph=node('section','graph');graph.setAttribute('aria-label','Прогноз сценария');
    graph.innerHTML='<div class="legend"><span>● Свободно</span><span>● Подушка</span></div><svg viewBox="0 0 320 90" role="img" aria-label="Прогноз свободных денег и подушки"></svg><div class="axis"></div>';
    graph.querySelector('.axis').append(node('span','',this.packet.start.slice(8,10)+'.'+this.packet.start.slice(5,7)),node('span','','3 месяца'),node('span','',this.packet.end.slice(8,10)+'.'+this.packet.end.slice(5,7)));
    const section=node('div','section');section.append(node('h2','','Мой сценарий'),node('small','','1 сценарий · 3 месяца'));
    const info=node('p','notice');info.id='planMinimum';
    root.append(graph,section,info);
    const list=node('div');list.id='planPurchases';
    for(const p of this.packet.purchases){
      let c=this.draft.choices.find(c=>c.id===p.id);
      if(!c){c={id:p.id,version:p.version,day:p.day||'',included:!!p.included};this.draft.choices.push(c);}
      const row=node('article','purchase'),title=node('strong','',p.title),amount=node('span','',money(p.amount));title.title=p.title;amount.title='Из общей подушки';
      const date=node('input');date.type='date';date.value=c.day;date.min=new Date(Date.parse((this.packet.start>new Date().toLocaleDateString('sv-SE')?this.packet.start:new Date().toLocaleDateString('sv-SE'))+'T12:00:00')+86400000).toLocaleDateString('sv-SE');date.max=p.deadline&&p.deadline<this.packet.end?p.deadline:this.packet.end;date.disabled=!!p.pinned;date.setAttribute('aria-label','Дата: '+p.title);
      date.onchange=()=>{this.changed(p,c,{day:date.value});};
      const approve=node('button');approve.type='button';approve.disabled=!!p.pinned;
      const buttonState=()=>{approve.textContent=c.included?'✓':'＋';approve.setAttribute('aria-pressed',c.included);approve.setAttribute('aria-label',(c.included?'Убрать из сценария: ':'Утвердить: ')+p.title);approve.title=c.included?'Убрать из сценария':'Утвердить: включить в сценарий';};
      buttonState();approve.onclick=()=>{if(!c.day){date.focus();document.getElementById('planStatus').textContent='Сначала задайте дату';return;}this.changed(p,c,{included:!c.included});buttonState();};
      if(c.version!==p.version){row.classList.add('stale');row.title='Покупка изменилась на ПК. Проверьте дату и включение.';}
      row.append(title,amount,date,approve);list.append(row);
    }
    if(!this.packet.purchases.length)list.append(node('p','notice','Неоплаченных плановых покупок нет.'));
    root.append(list);
    const footer=node('div','footer'),send=node('button','save send-icon');send.id='planSend';send.type='button';send.title='Передать сценарий на компьютер';send.setAttribute('aria-label',send.title);
    send.innerHTML='<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 16V3m-5 5 5-5 5 5M4 15v6h16v-6"/></svg>';send.onclick=()=>this.submit();
    const reset=node('button','reset-icon','↶');reset.type='button';reset.title='Получить сценарий компьютера, отменив местные правки';reset.setAttribute('aria-label',reset.title);reset.onclick=()=>{this.resetDraft();this.render();};
    const status=node('span');status.id='planStatus';footer.append(send,reset,status);root.append(footer,node('p','notice','Утверждение включает покупку в сценарий. Деньги не списываются.'));
    this.renderChart();this.renderStatus();
  }
  renderChart(){
    if(!this.packet)return;const root=document.getElementById('phonePlanView'),svg=root.querySelector('svg[role="img"]');if(!svg)return;
    const curve=projectScenario(this.packet,this.draft.choices,day=>this.offset(day));
    const all=curve.flatMap(r=>[r.free,r.cushion]),min=Math.min(0,...all),max=Math.max(100,...all),y=v=>84-(v-min)/(max-min)*76;
    const points=key=>curve.map((p,i)=>`${i/(curve.length-1)*320},${y(p[key])}`).join(' ');
    svg.innerHTML=`<path d="M0 ${y(0)}H320" stroke="var(--line)"/><polyline points="${points('free')}" fill="none" stroke="var(--accent)" stroke-width="2"/><polyline points="${points('cushion')}" fill="none" stroke="#b28245" stroke-width="2"/>`;
    const minimum=Math.min(...curve.map(p=>p.cushion)),info=document.getElementById('planMinimum');info.textContent='Минимум подушки: '+money(minimum);info.classList.toggle('negative',minimum<0);
    if(curve.some(p=>p.free<0))info.append(document.createTextNode(' · есть нехватка свободных денег'));
  }
  renderStatus(){
    const status=document.getElementById('planStatus'),send=document.getElementById('planSend');if(!status)return;
    const busy=this.command&&!['received','rejected'].includes(this.command.delivery);
    const stale=this.draft.base!==this.packet.version||this.draft.choices.some(c=>this.packet.purchases.find(p=>p.id===c.id)?.version!==c.version);
    status.textContent=!this.drive.config?'Диск не подключён':busy?'Сценарий ждёт ПК':stale?'Данные изменены на ПК · проверьте сценарий':this.command?.delivery==='rejected'?this.command.deliveryError:this.draft.dirty?'Есть изменения':'Сценарий сохранён';
    send.disabled=!this.drive.config||busy||stale||!this.draft.dirty;
  }
  async submit(){
    try{
      for(const c of this.draft.choices)if(c.included&&(!c.day||c.day<=this.packet.start||c.day>this.packet.end))throw new Error('Выберите будущие даты в пределах графика.');
      const now=Date.now();this.command={id:'scenario-'+crypto.randomUUID(),ts:now,updatedAt:now,text:'Сценарий телефона',source:'text',payload:{v:3,kind:'finance',mode:'phone_scenario',base:this.packet.version,choices:structuredClone(this.draft.choices)}};
      await db.setSetting('phonePlanCommand',this.command);this.renderStatus();this.drive.schedule(true);
    }catch(error){document.getElementById('planStatus').textContent=error.message;}
  }
}
