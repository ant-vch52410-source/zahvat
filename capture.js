// Шесть разделов и структурированный обмен с Органайзером (задача 7).
// Формы разделов «Захвата» и точные поля обмена с Органайзером (задача 36).
export const SECTIONS = [
  ['', 'Захват', 'finance'], ['Задача', 'Задачи', 'task'], ['Заметка', 'Заметки', 'note'],
  ['Идея', 'Идеи', 'idea'], ['Время', 'Время', 'clock'], ['Работа', 'Работы', 'work'],
];
export const isoDay = (d = new Date()) => `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
export function parseDay(value) {
  const m = /^(\d{2})\.(\d{2})\.(\d{4})$/.exec(value || '');
  if (!m) return null;
  const d = new Date(+m[3], +m[2]-1, +m[1], 12);
  return d.getFullYear()===+m[3] && d.getMonth()===+m[2]-1 && d.getDate()===+m[1] && +m[3]>=1900 && +m[3]<=2100 ? d : null;
}
export function cents(value) {
  if (!/^\d+(?:[,.]\d{1,2})?$/.test(value || '')) throw new Error('Укажите сумму больше нуля.');
  const [a,b=''] = value.replace(',','.').split('.');
  const n = Number(a)*100+Number(b.padEnd(2,'0'));
  if (!Number.isSafeInteger(n) || n<=0 || n>1e14) throw new Error('Проверьте сумму.');
  return n;
}
const $ = id => document.getElementById(id);
const h = (tag, text, attrs={}) => { const el=document.createElement(tag); if(text)el.textContent=text; for(const [k,v]of Object.entries(attrs))el.setAttribute(k,v); return el; };

export class CaptureForm {
  constructor(changed) {
    this.changed=changed; this.tag=''; this.mode='expense'; this.date=new Date().toLocaleDateString('ru-RU');
    this.values={}; this.catalog={}; this.lists={accounts:[],cats:[]};
    $('captureMode').onclick=e=>{const b=e.target.closest('[data-mode]');if(!b)return;this.readFields();this.mode=b.dataset.mode;this.onMode?.();this.render();this.changed();};
    $('opPrev').onclick=()=>this.shift(-1);$('opNext').onclick=()=>this.shift(1);
    $('operationDate').oninput=()=>{this.date=$('operationDate').value;this.error('');this.changed();};
    $('catSearch').onfocus=() => this.options();
    $('catSearch').oninput=()=>{this.onCategory?.(null);this.options();};
    $('catSearch').onkeydown=e=>{if(e.key==='Escape')this.closeOptions();if(e.key==='ArrowDown'){e.preventDefault();$('catOptions').querySelector('button')?.focus();}if(e.key==='Enter'){e.preventDefault();$('catOptions').querySelector('button')?.click();}};
    document.addEventListener('click',e=>{if(!e.target.closest('.picker'))this.closeOptions();});
    $('captureFields').addEventListener('input',e=>{this.readFields();this.recalc(e.target.id);this.changed();});
    $('captureFields').addEventListener('change',e=>{this.readFields();if(e.target.id==='client'){this.values.project='';this.render();}this.changed();});
  }
  error(message) {$('captureError').textContent=message;$('captureError').hidden=!message;}
  shift(delta) {const d=parseDay($('operationDate').value);if(!d){this.error('Введите существующую дату: ДД.ММ.ГГГГ.');return;}d.setDate(d.getDate()+delta);this.date=d.toLocaleDateString('ru-RU');$('operationDate').value=this.date;this.error('');this.changed();}
  closeOptions() {$('catOptions').hidden=true;$('catSearch').setAttribute('aria-expanded','false');}
  articles() {
    if (this.catalog.articles) return this.catalog.articles.filter(a=>a.mode===this.mode).map(a=>a.name);
    return this.mode==='income' ? ['Зарплата','Доп.заработок','Проценты','Прочее'] : this.lists.cats;
  }
  options() {
    const q=$('catSearch').value.toLocaleLowerCase().replaceAll('ё','е');
    const list=this.articles().filter(s=>s.toLocaleLowerCase().replaceAll('ё','е').includes(q));
    $('catOptions').replaceChildren(...list.map(name=>{const b=h('button',name,{type:'button',role:'option'});b.onmousedown=e=>e.preventDefault();b.onclick=()=>{this.onCategory?.(name);$('catSearch').value=name;this.closeOptions();};return b;}));
    if(!list.length)$('catOptions').append(h('p','Статья не найдена',{class:'none'}));
    $('catOptions').hidden=false;$('catSearch').setAttribute('aria-expanded','true');
  }
  readFields() {for(const e of $('captureFields').querySelectorAll('[data-field]'))this.values[e.id]=e.type==='checkbox'?e.checked:e.value;}
  setTag(tag) {this.readFields();this.tag=tag||'';this.error('');this.closeOptions();this.render();}
  render() {
    const def=SECTIONS.find(s=>s[0]===this.tag)||SECTIONS[0];
    $('captureTitle').textContent=def[1];$('captureHint').textContent=this.tag?'':'Без суммы — заметка';
    $('captureFin').hidden=!!this.tag;$('captureMode').hidden=!!this.tag;
    $('captureMode').querySelectorAll('button').forEach(b=>b.classList.toggle('chosen',b.dataset.mode===this.mode));
    $('operationDate').value=this.date;
    $('categoryArea').hidden=this.mode==='transfer';
    const dateBox=$('opDateBox');dateBox.remove();$('captureFields').replaceChildren();
    const fields=$('captureFields');$('captureFin').parentElement.insertBefore(fields,$('captureError'));fields.classList.toggle('transfer-fields',!this.tag&&this.mode==='transfer');
    if(!this.tag && this.mode!=='transfer')$('categoryArea').append(dateBox);
    if(this.tag || this.mode==='transfer')fields.append(dateBox);
    dateBox.hidden=!!this.tag;
    if(!this.tag && this.mode==='transfer'){
      fields.hidden=false;$('captureFin').append(fields);this.select('from','Откуда',this.accounts(),false);this.select('to','Куда',this.accounts(),false);fields.append(dateBox);
    }else fields.hidden=!this.tag;
    if(this.tag==='Задача'){
      this.field('day','Дата','date',isoDay());this.field('at','Время','time');
      this.select('priority','Приоритет',[['normal','Обычный'],['high','Высокий'],['low','Низкий']],false);this.select('project','Проект',this.projects());
      const row=h('div','',{class:'segment quick wide'});
      for(const [label,days] of [['Сегодня',0],['Завтра',1],['Без срока',null]]){const b=h('button',label,{type:'button'});b.onclick=()=>{const d=new Date();d.setDate(d.getDate()+(days||0));this.values.day=days===null?'':isoDay(d);$('day').value=this.values.day;this.changed();};row.append(b);}fields.append(row);
    }
    if(this.tag==='Заметка'){this.select('folder','Папка',(this.catalog.folders||[]).map(r=>[String(r.id),r.name]));this.field('tags','Теги');this.field('important','Важно','checkbox');}
    if(this.tag==='Идея'){this.select('project','Проект / тема',this.projects());this.field('tags','Теги');}
    if(this.tag==='Время'){
      this.select('activity','Занятие',(this.catalog.activities||[]).map(r=>[String(r.id),r.name]));this.select('project','Проект',this.projects());
      this.field('day','Дата','date',isoDay());this.field('duration','Длительность, мин','number','');
      this.field('start','Начало','time');this.field('end','Конец','time');
    }
    if(this.tag==='Работа'){
      this.select('client','Клиент',(this.catalog.workClients||[]).map(r=>[String(r.id),r.name]));
      this.select('project','Проект',this.projects(this.values.client));this.field('workAmount','Сумма, ₽','text');this.field('day','Дата','date',isoDay());
    }
    if(this.tag && !Object.keys(this.catalog).length)fields.append(h('p','Загрузите справочники Органайзера через меню.',{class:'hint wide'}));
    this.readFields();
  }
  accounts(){return this.catalog.accounts?this.catalog.accounts.map(r=>[r.name,r.name]):this.lists.accounts.map(n=>[n,n]);}
  projects(client) {return (this.catalog.projects||[]).filter(p=>!client||String(p.client_id)===String(client)).map(p=>[String(p.id),p.name]);}
  field(id,label,type='text',fallback='') {
    const l=h('label',label,{class:'field'}),i=h('input','',{id,type,'data-field':''});
    if(type==='checkbox')i.checked=!!this.values[id];else i.value=this.values[id]??fallback;
    if(type==='number')i.min='1';if(id==='workAmount')i.inputMode='decimal';l.append(i);$('captureFields').append(l);
  }
  select(id,label,options,empty=true) {
    const l=h('label',label,{class:'field'}),s=h('select','',{id,'data-field':''});
    if(empty)s.append(h('option','Не выбрано',{value:''}));
    for(const [value,name]of options)s.append(h('option',name,{value}));
    s.value=this.values[id]??(empty?'':options[0]?.[0]||'');l.append(s);$('captureFields').append(l);
  }
  ref(list,value,required=false) {
    if(!value){if(required)throw new Error('Выберите обязательное значение из справочника.');return null;}
    const item=(list||[]).find(r=>String(r.id)===String(value));if(!item)throw new Error('Обновите справочники Органайзера.');return {id:item.id,name:item.name};
  }
  recalc(id) {
    if(this.tag!=='Время')return;
    const minutes=v=>{if(!/^\d\d:\d\d$/.test(v||''))return NaN;const[h,m]=v.split(':').map(Number);return h*60+m;};
    const start=minutes(this.values.start),end=minutes(this.values.end);
    if(id==='duration' && Number.isFinite(start)){const v=start+Number(this.values.duration);if(Number.isFinite(v)&&v>start&&v<1440){this.values.end=String(Math.floor(v/60)).padStart(2,'0')+':'+String(v%60).padStart(2,'0');$('end').value=this.values.end;}}
    else if(['start','end'].includes(id)&&Number.isFinite(start)&&end>start){this.values.duration=String(end-start);$('duration').value=this.values.duration;}
  }
  payload(raw, amount, account, article) {
    this.readFields();const f=this.values;let kind={'Задача':'task','Заметка':'note','Идея':'idea','Время':'time','Работа':'work'}[this.tag]||'note';
    if(!this.tag && amount){kind='finance';const day=parseDay(this.date);if(!day)throw new Error('Проверьте дату операции.');
      const p={v:1,kind,text:raw,day:isoDay(day),mode:this.mode,amount:cents(amount)};
      if(this.mode==='transfer'){p.account=f.from;p.to_account=f.to;if(!p.account||!p.to_account||p.account===p.to_account)throw new Error('Выберите разные счета перевода.');}
      else{if(!account||!article)throw new Error('Выберите счёт и статью.');p.account=account;p.article=article;}
      return p;
    }
    if(!raw)throw new Error('Введите текст записи.');
    const p={v:1,kind,text:raw};
    if(kind==='task'){p.day=f.day||null;p.at=f.at||null;p.priority=f.priority||'normal';}
    if(kind==='note'){p.folder=this.ref(this.catalog.folders,f.folder);p.important=!!f.important;}
    if(['note','idea'].includes(kind))p.tags=f.tags||'';
    if(['task','idea','time','work'].includes(kind))p.project=this.ref(this.catalog.projects,f.project);
    if(kind==='time'){
      p.day=f.day;p.start=f.start;p.end=f.end;p.activity=this.ref(this.catalog.activities,f.activity,true);
      if(!p.day||!p.start||!p.end||p.end<=p.start)throw new Error('Укажите дату, начало и конец интервала в тот же день.');
    }
    if(kind==='work'){p.day=f.day;p.client=this.ref(this.catalog.workClients,f.client,true);p.amount=cents(f.workAmount);if(!p.day)throw new Error('Укажите дату работы.');}
    return p;
  }
  snapshot(){this.readFields();return {tag:this.tag,mode:this.mode,date:this.date,values:{...this.values}};}
  restore(data){if(!data)return;this.tag=data.tag||'';this.mode=['expense','income','transfer'].includes(data.mode)?data.mode:'expense';this.date=data.date||new Date().toLocaleDateString('ru-RU');this.values=data.values||{};this.render();}
  reset(){this.values={};this.date=new Date().toLocaleDateString('ru-RU');this.render();this.error('');}
}

export function recordKind(e){if(e.payload)return e.payload.kind;const head=e.text.split(':')[0].toLocaleLowerCase();return ({'финансы':'finance','задача':'task','заметка':'note','мысли':'note','идея':'idea','идеи':'idea','время':'time','работа':'work','чек':'receipt'})[head]||'note';}
export function recordText(p){
  const tag={finance:'Финансы',task:'Задача',note:'Заметка',idea:'Идея',time:'Время',work:'Работа'}[p.kind];
  if(p.kind==='finance')return `${tag}: ${p.mode==='transfer'?p.account+' → '+p.to_account:p.account+' · '+p.article} · ${(p.amount/100).toLocaleString('ru-RU')} ₽${p.text?' · '+p.text:''} · ${p.day}`;
  const detail=[];
  if(p.kind==='work')detail.push((p.amount/100).toLocaleString('ru-RU')+' ₽',p.client?.name);
  if(p.kind==='time')detail.push(p.activity?.name,`${p.start}–${p.end}`);
  if(['task','time','work'].includes(p.kind)&&p.day)detail.push(p.day+(p.at?' '+p.at:''));
  if(p.project?.name)detail.push(p.project.name);
  if(p.folder?.name)detail.push(p.folder.name);
  if(p.important)detail.push('Важно');
  if(p.tags)detail.push(p.tags);
  return `${tag}: ${p.text}`+(detail.filter(Boolean).length?' · '+detail.filter(Boolean).join(' · '):'');
}
