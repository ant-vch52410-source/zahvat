// План телефона: обе формы, локальные покупки и склейка с квитанциями ПК (задача 36.3).
import * as db from './db.js';
import {adjustedBalances} from './sync-core.js';
import {purchasePayload,isoDay} from './capture.js';
const money=n=>(n/100).toLocaleString('ru-RU',{maximumFractionDigits:2})+' ₽';
const same=(a,b)=>JSON.stringify(a)===JSON.stringify(b);
const node=(tag,cls,text)=>{const e=document.createElement(tag);if(cls)e.className=cls;if(text!==undefined)e.textContent=text;return e;};
const localId=id=>'capture:'+id;
const defaultChoice=p=>({id:p.id,version:p.version,day:p.day||'',included:p.included??!!p.day});

/** Учитывать локальную запись ровно до соответствующего снимка ПК, независимо от задержки квитанции. */
export function mergedPurchases(packet,entries,balances){
  const rows=(packet?.purchases||[]).map(p=>({...p}));
  const origins=new Set(rows.filter(p=>p.captureId).map(p=>p.captureId+':'+p.captureRevision));
  const applied=new Map((balances?.applied||[]).map(p=>[p.id,p.revision]));
  for(const e of entries){
    const p=e.payload;if(p?.kind!=='finance'||p.planned!==true)continue;
    if(origins.has(e.id+':'+e.updatedAt)||applied.get(e.id)===e.updatedAt)continue;
    rows.push({id:localId(e.id),version:e.updatedAt,captureId:e.id,captureRevision:e.updatedAt,
      title:p.text,amount:p.amount,day:p.day,included:true,eligible:true,pending:true,
      error:e.deliveryError||'',delivery:e.delivery});
  }
  return rows;
}

/** Перенести местные решения с capture-id на id покупки ПК, не маскируя чужие правки. */
export function reconcileChoices(purchases,choices=[]){
  const previous=new Map(choices.map(c=>[c.id,c]));
  const result=purchases.map(p=>{
    const c=previous.get(p.id);
    if(c)return {...c};
    const local=p.captureId&&previous.get(localId(p.captureId));
    if(local&&local.version===p.captureRevision)return {...local,id:p.id,version:p.version};
    return defaultChoice(p);
  });
  // Пропавшая покупка ПК требует проверки; удалённая местная запись исчезает сразу.
  for(const c of choices)if(typeof c.id==='number'&&!purchases.some(p=>p.id===c.id))result.push({...c});
  return result;
}

/** Только подушка финансирует покупки; факт и свободные деньги не списываются повторно. */
export function projectScenario(packet,choices,offset=0){
  const purchases=new Map(packet.purchases.map(p=>[p.id,p]));
  const start=packet.start||packet.curve[0]?.day;
  const tomorrow=new Date(Date.parse(start+'T12:00:00')+86400000).toLocaleDateString('sv-SE');
  return packet.curve.map(point=>{
    let spending=0;
    for(const choice of choices){const p=purchases.get(choice.id),day=choice.day&&choice.day<=start?tomorrow:choice.day;if(p&&p.eligible!==false&&choice.included&&day&&day<=point.day)spending+=p.amount;}
    return {...point,free:point.free+(typeof offset==='function'?offset(point.day):offset),cushion:point.cushion-spending};
  });
}

/** Значения реального дневного графика в начале, середине и конце. */
export function graphSamples(curve){
  if(!curve.length)return [];
  return [0,Math.floor((curve.length-1)/2),curve.length-1].map((i,position)=>({...curve[i],position}));
}

export class PhonePlan{
  constructor(drive,entries,actions={}){
    this.drive=drive;this.entries=entries;this.actions=actions;this.packet=null;this.purchases=[];
    this.draft=null;this.command=null;this.creation={};this.formOpen=false;this.saving=false;this.error='';
  }
  async init(){this.draft=await db.getSetting('phoneScenario')||null;this.creation=await db.getSetting('phonePurchaseDraft')||{};this.formOpen=!!Object.values(this.creation).some(Boolean);await this.refresh();}
  async refresh(){
    this.packet=this.drive.state.snapshot?.plan||null;this.command=await db.getSetting('phonePlanCommand')||null;
    this.purchases=mergedPurchases(this.packet,this.entries(),this.drive.state.snapshot?.balances);
    if(!this.draft||!this.draft.dirty)this.resetDraft();
    else{
      if(this.packet&&this.command?.delivery==='received'&&this.packet.version!==this.draft.base){
        const unchanged=same(this.draft.choices,this.command.payload.choices);
        this.draft.base=this.packet.version;this.draft.dirty=!unchanged;if(unchanged)this.resetDraft();
      }
      this.draft.choices=reconcileChoices(this.purchases,this.draft.choices);
      // Первый снимок после работы без связи становится базой, не стирая местных решений.
      if(this.draft.base===null&&this.packet)this.draft.base=this.packet.version;
      await db.setSetting('phoneScenario',structuredClone(this.draft));
    }
    this.render();
  }
  resetDraft(){
    const saved=new Map((this.packet?.choices||[]).map(r=>[r.id,r]));
    this.draft={base:this.packet?.version??null,dirty:false,choices:this.purchases.map(p=>{
      const r=saved.get(p.id);return {id:p.id,version:p.version,day:r?.day??p.day??'',included:r?.included??p.included??!!p.day,...(r?.removed&&r.version===p.version?{removed:true}:{})};
    })};
    db.setSetting('phoneScenario',structuredClone(this.draft));
  }
  offset(day){
    const rows=adjustedBalances(this.drive.state.snapshot?.balances,this.entries(),day)||[];
    return rows.filter(r=>r.currency==='RUB'&&r.in_forecast).reduce((sum,r)=>sum+r.pending,0);
  }
  changed(p,choice,fields){
    Object.assign(choice,fields,{version:p.version});this.draft.dirty=true;
    db.setSetting('phoneScenario',structuredClone(this.draft));this.renderChart();this.renderStatus();
  }
  render(){
    const root=document.getElementById('phonePlanView');if(!root)return;
    // Сетевой ответ сохраняет незавершённый ввод и фокус в компактной форме.
    const focused=root.contains(document.activeElement)?document.activeElement.id:null;
    const selection=focused&&document.activeElement.selectionStart;
    const scrollTop=document.getElementById('planPurchases')?.scrollTop||0;
    root.replaceChildren();
    if(this.packet){
      const totals=node('section','totals');
      for(const [caption,value] of [['Свободно сейчас',this.packet.freeNow+this.offset(isoDay())],['Подушка сейчас',this.packet.cushionNow]]){
        const box=node('div');box.append(node('small','',caption),node('strong','',money(value)));totals.append(box);
      }
      const asOf=this.drive.state.snapshot.balances?.asOf;
      const adjustments=adjustedBalances(this.drive.state.snapshot.balances,this.entries(),isoDay())||[];
      const note=adjustments.some(a=>a.uncertain)?' · есть неразобранные':adjustments.some(a=>a.pending)?' · с новыми записями':'';
      root.append(totals,node('p','stamp','Данные ПК · '+new Date(asOf).toLocaleString('ru-RU',{day:'2-digit',month:'2-digit',hour:'2-digit',minute:'2-digit'})+note));
      const graph=node('section','graph');graph.setAttribute('aria-label','Прогноз сценария');
      graph.innerHTML='<div class="legend"><span>● Свободно</span><span>● Подушка</span><span class="units">тыс. ₽</span></div><svg viewBox="0 0 320 90" role="img" aria-label="Прогноз свободных денег и подушки"></svg><div class="axis"></div>';
      graph.querySelector('.axis').append(node('span','',this.packet.start.slice(8,10)+'.'+this.packet.start.slice(5,7)),node('span','','3 месяца'),node('span','',this.packet.end.slice(8,10)+'.'+this.packet.end.slice(5,7)));root.append(graph);
    }else root.append(node('p','notice','Прогноз появится после обмена с ПК. Покупки можно добавлять сейчас, в том числе без интернета.'));
    const section=node('div','section'),add=node('button','purchase-add','+');add.id='planAdd';add.type='button';add.title='Добавить покупку';add.setAttribute('aria-label',add.title);add.setAttribute('aria-expanded',String(this.formOpen));add.setAttribute('aria-controls','planPurchaseForm');
    add.onclick=()=>{this.formOpen=!this.formOpen;this.render();if(this.formOpen)document.getElementById('planPurchaseTitle').focus();};
    section.append(node('h2','','Мой сценарий'),node('small','','1 сценарий · 3 месяца'),add);root.append(section);
    if(this.packet){const info=node('p','notice');info.id='planMinimum';root.append(info);}
    root.append(this.creationForm());
    const list=node('div');list.id='planPurchases';list.tabIndex=0;
    list.setAttribute('role','region');list.setAttribute('aria-label','Покупки сценария');
    const popup=node('div','purchase-actions');popup.id='planPurchaseActions';popup.setAttribute('popover','auto');
    const remove=node('button','','Удалить');remove.type='button';remove.autofocus=true;popup.append(remove);
    list.addEventListener('scroll',()=>{if(popup.matches(':popover-open'))popup.hidePopover();});
    for(const p of this.purchases){
      const c=this.draft.choices.find(c=>c.id===p.id);
      if(c.removed&&c.version===p.version)continue;
      const row=node('article','purchase'),title=node('strong','',p.title),amount=node('span','',money(p.amount));title.title=p.title;amount.title='Из общей подушки';
      let name=title;
      if(p.pending){name=node('span','purchase-name');const dot=node('span','pending-dot','●');dot.title=p.error||'Ждёт ПК';dot.setAttribute('aria-label',dot.title);name.append(dot,title);row.title=p.error||'Ждёт ПК';}
      const date=node('input');date.type='date';date.value=c.day;
      date.min=isoDay(new Date(Date.now()+86400000));if(this.packet)date.max=p.deadline&&p.deadline<this.packet.end?p.deadline:this.packet.end;
      date.disabled=!!p.pinned;date.setAttribute('aria-label','Дата: '+p.title);date.onchange=()=>{this.changed(p,c,{day:date.value,removed:false});};
      const approve=node('button');approve.type='button';approve.disabled=!!p.pinned;
      const buttonState=()=>{approve.textContent=c.included?'✓':'＋';approve.setAttribute('aria-pressed',c.included);approve.setAttribute('aria-label',(c.included?'Убрать из сценария: ':'Утвердить: ')+p.title);approve.title=c.included?'Убрать из сценария':'Утвердить: включить в сценарий';};
      buttonState();approve.onclick=()=>{if(!c.day){date.focus();document.getElementById('planStatus').textContent='Сначала задайте дату';return;}this.changed(p,c,{included:!c.included,removed:false});buttonState();};
      if(c.version!==p.version){row.classList.add('stale');row.title='Покупка изменилась на ПК. Проверьте дату и включение.';}
      const actions=node('button','purchase-more','⋯');actions.type='button';actions.id='planPurchaseMore-'+p.id;
      actions.setAttribute('aria-label','Действия: '+p.title);actions.setAttribute('aria-controls',popup.id);
      actions.setAttribute('aria-expanded','false');actions.disabled=!!p.pinned;
      if(p.pinned)actions.title='Дата покупки закреплена на компьютере';
      actions.onclick=()=>{
        if(popup.matches(':popover-open')){
          const sameTrigger=actions.getAttribute('aria-expanded')==='true';
          popup.hidePopover();
          if(sameTrigger)return;
        }
        popup.onbeforetoggle=event=>{if(event.newState==='closed')actions.setAttribute('aria-expanded','false');};
        remove.onclick=()=>{
          popup.hidePopover();
          this.removedPurchase={id:p.id,captureId:p.captureId,choice:{...c}};
          this.changed(p,c,{included:false,removed:true});
          this.render();
          document.getElementById('planUndoRemoval').focus();
        };
        popup.showPopover({source:actions});
        const anchor=actions.getBoundingClientRect();
        const below=anchor.bottom+4,above=anchor.top-popup.offsetHeight-4;
        popup.style.top=Math.max(4,below+popup.offsetHeight<=list.getBoundingClientRect().bottom?below:above)+'px';
        popup.style.left=Math.max(4,anchor.right-popup.offsetWidth)+'px';
        actions.setAttribute('aria-expanded','true');
      };
      row.append(name,amount,date,approve,actions);list.append(row);
    }
    if(!list.childElementCount)list.append(node('p','notice','Неоплаченных плановых покупок нет.'));
    root.append(list,popup);list.scrollTop=scrollTop;
    const pending=this.purchases.filter(p=>p.pending);if(pending.length)root.append(node('p','notice pending-count',`● Ждёт ПК: ${pending.length}`));
    if(pending.some(p=>p.error))root.append(node('p','error',pending.find(p=>p.error).error));
    const footer=node('div','footer'),send=node('button','save send-icon');send.id='planSend';send.type='button';send.title='Передать сценарий на компьютер';send.setAttribute('aria-label',send.title);
    send.innerHTML='<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 16V3m-5 5 5-5 5 5M4 15v6h16v-6"/></svg>';send.onclick=()=>this.submit();
    const reset=node('button','reset-icon','↶');reset.type='button';reset.title='Получить сценарий компьютера, отменив местные правки';reset.setAttribute('aria-label',reset.title);reset.onclick=()=>{this.removedPurchase=null;this.resetDraft();this.render();};
    const status=node('span');status.id='planStatus';footer.append(send,reset,status);root.append(footer,node('p','notice','Утверждение включает покупку в сценарий. Деньги не списываются.'));
    const undo=this.removedPurchase;
    const purchase=undo&&this.purchases.find(p=>p.id===undo.id||(undo.captureId&&p.captureId===undo.captureId));
    const choice=purchase&&this.draft.choices.find(c=>c.id===purchase.id);
    if(choice?.removed&&!purchase.pinned){
      const undoButton=node('button','purchase-undo','Отменить удаление');undoButton.type='button';undoButton.id='planUndoRemoval';
      undoButton.onclick=()=>{
        this.removedPurchase=null;
        const {day,included}=undo.choice;
        this.changed(purchase,choice,{day,included,removed:false});
        this.render();
        document.getElementById('planPurchaseMore-'+purchase.id)?.focus();
      };
      footer.append(undoButton);
    }
    this.renderChart();this.renderStatus();
    if(focused){const el=document.getElementById(focused);if(el){el.focus();if(typeof selection==='number'&&el.type==='text')el.setSelectionRange(selection,selection);}}
  }
  creationForm(){
    const form=node('form','plan-purchase-form');form.id='planPurchaseForm';form.hidden=!this.formOpen;form.noValidate=true;
    const options=this.actions.options?.()||{articles:[]};
    const first=node('div','purchase-form-grid'),title=node('input');title.id='planPurchaseTitle';title.type='text';title.name='title';title.maxLength=200;title.placeholder='Название';title.setAttribute('aria-label','Название');title.title='Название покупки';title.value=this.creation.title||'';
    const article=node('select');article.id='planPurchaseArticle';article.name='article';article.title='Статья расхода';article.setAttribute('aria-label','Статья');article.append(new Option('Статья',''));for(const name of options.articles)article.append(new Option(name,name));article.value=this.creation.article||'';first.append(title,article);
    const second=node('div','purchase-form-end'),amount=node('input');amount.id='planPurchaseAmount';amount.type='text';amount.name='amount';amount.inputMode='decimal';amount.placeholder='Сумма, ₽';amount.setAttribute('aria-label','Сумма, ₽');amount.value=this.creation.amount||'';
    const day=node('input');day.id='planPurchaseDay';day.type='date';day.name='day';day.setAttribute('aria-label','Дата');day.title='Дата покупки';day.value=this.creation.day||isoDay();
    const save=node('button','save','Сохранить');save.type='submit';save.disabled=this.saving;
    const cancel=node('button','purchase-cancel','×');cancel.type='button';cancel.title='Отмена';cancel.setAttribute('aria-label','Отмена');cancel.onclick=()=>{this.formOpen=false;this.render();document.getElementById('planAdd').focus();};
    second.append(amount,day,save,cancel);form.append(first,second);
    const error=node('p','error purchase-error',this.error);error.hidden=!this.error;error.setAttribute('role','alert');form.append(error);
    const read=()=>{this.creation={title:title.value,article:article.value,amount:amount.value,day:day.value};db.setSetting('phonePurchaseDraft',{...this.creation});};
    form.oninput=read;form.onchange=read;
    form.onsubmit=async e=>{
      e.preventDefault();if(this.saving)return;read();
      try{
        const payload=purchasePayload({...this.creation,account:options.account});
        this.saving=true;save.disabled=true;await this.actions.create(payload);
        this.creation={};this.error='';this.formOpen=false;await this.refresh();
      }catch(failure){this.error=failure.message;error.textContent=this.error;error.hidden=false;}
      finally{this.saving=false;save.disabled=false;this.renderStatus();}
    };
    return form;
  }
  renderChart(){
    if(!this.packet)return;const root=document.getElementById('phonePlanView'),svg=root.querySelector('svg[role="img"]');if(!svg)return;
    const curve=projectScenario({...this.packet,purchases:this.purchases},this.draft.choices,day=>this.offset(day));if(!curve.length)return;
    const all=curve.flatMap(r=>[r.free,r.cushion]),min=Math.min(0,...all),max=Math.max(100,...all),y=v=>84-(v-min)/(max-min)*76;
    const points=key=>curve.map((p,i)=>`${i/Math.max(1,curve.length-1)*320},${y(p[key])}`).join(' ');
    svg.innerHTML=`<path d="M0 ${y(0)}H320" class="zero-line"/><polyline points="${points('free')}" fill="none" stroke="var(--accent)" stroke-width="2"/><polyline points="${points('cushion')}" fill="none" stroke="#b28245" stroke-width="2"/>`;
    for(const point of graphSamples(curve))for(const [key,other,color] of [['free','cushion','var(--accent)'],['cushion','free','#b28245']]){
      const text=document.createElementNS('http://www.w3.org/2000/svg','text');text.classList.add('graph-value');text.setAttribute('x',[2,160,318][point.position]);text.setAttribute('y',Math.max(9,Math.min(86,y(point[key])+(point[key]>=point[other]?-5:11))));text.setAttribute('text-anchor',['start','middle','end'][point.position]);text.setAttribute('fill',color);text.textContent=(point[key]/100000).toLocaleString('ru-RU',{maximumFractionDigits:1});svg.append(text);
    }
    const minimum=Math.min(...curve.map(p=>p.cushion)),info=document.getElementById('planMinimum');info.textContent='Минимум подушки: '+money(minimum);info.classList.toggle('negative',minimum<0);
    if(curve.some(p=>p.free<0))info.append(document.createTextNode(' · есть нехватка свободных денег'));
  }
  renderStatus(){
    const status=document.getElementById('planStatus'),send=document.getElementById('planSend');if(!status)return;
    const busy=this.command&&!['received','rejected'].includes(this.command.delivery),pending=this.purchases.some(p=>p.pending);
    const stale=!!this.packet&&(this.draft.base!==this.packet.version||this.draft.choices.some(c=>this.purchases.find(p=>p.id===c.id)?.version!==c.version));
    status.textContent=!this.drive.config?'Диск не подключён':pending?'Покупки ждут ПК':!this.packet?'Ожидается прогноз ПК':busy?'Сценарий ждёт ПК':stale?'Данные изменены на ПК · проверьте сценарий':this.command?.delivery==='rejected'?this.command.deliveryError:this.draft.dirty?'Есть изменения':'Сценарий сохранён';
    send.disabled=this.saving||!this.drive.config||!this.packet||pending||busy||stale||!this.draft.dirty;
  }
  async submit(){
    try{
      if(!this.packet||this.purchases.some(p=>p.pending))throw new Error('Сначала дождитесь приёма новых покупок компьютером.');
      for(const c of this.draft.choices){
        const p=this.packet.purchases.find(p=>p.id===c.id),unchanged=p&&c.day===p.day&&c.included===p.included;
        if(!p||p.version!==c.version)throw new Error('Покупка изменилась на ПК. Проверьте сценарий.');
        if(c.included&&(!c.day||(!unchanged&&(c.day<=this.packet.start||c.day>this.packet.end))))throw new Error('Выберите будущие даты в пределах графика.');
      }
      const now=Date.now();this.command={id:'scenario-'+crypto.randomUUID(),ts:now,updatedAt:now,text:'Сценарий телефона',source:'text',payload:{v:3,kind:'finance',mode:'phone_scenario',base:this.packet.version,choices:structuredClone(this.draft.choices)}};
      await db.setSetting('phonePlanCommand',this.command);this.renderStatus();this.drive.schedule(true);
    }catch(error){document.getElementById('planStatus').textContent=error.message;}
  }
}
