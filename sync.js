// Событийный обмен при сохранении, возврате и восстановлении связи (задача 36.3).
import * as db from './db.js';
import {connection,isFinancial,wireRecord,mergeResult} from './sync-core.js';
const needsUpload=e=>isFinancial(e)&&e.cloudRevision!==e.updatedAt&&e.cloudConflict!==e.updatedAt&&!['received','rejected'].includes(e.delivery);
export class DriveExchange{
  constructor(changed){this.changed=changed;this.busy=false;this.again=false;this.timer=0;this.config=null;this.last=0;this.failures=0;this.state={};}
  async init(){
    this.config=await db.getSetting('driveConnection')||null;this.state=await db.getSetting('driveState')||{};this.last=this.state.lastSuccess||0;
    window.addEventListener('online',()=>this.schedule(true));
    document.addEventListener('visibilitychange',()=>{if(!document.hidden)this.schedule(false);});this.schedule(false);
  }
  async connect(v){this.config=connection(v);await db.setSetting('driveConnection',this.config);this.last=0;this.schedule(true);}
  async disconnect(){this.config=null;clearTimeout(this.timer);await db.setSetting('driveConnection',null);this.changed();}
  schedule(dirty=false){
    if(!this.config||!navigator.onLine)return;if(this.busy){this.again=this.again||dirty;return;}
    if(!dirty&&Date.now()-this.last<300000)return;clearTimeout(this.timer);this.timer=setTimeout(()=>this.run(),dirty?1500:200);
  }
  async run(){
    if(this.busy||!this.config||!navigator.onLine)return;this.busy=true;this.again=false;this.changed();const config=this.config;
    try{
      const entries=await db.getAllEntries(),command=await db.getSetting('phonePlanCommand');
      let pending=entries.filter(needsUpload).slice(0,command?99:100);
      if(command&&command.cloudRevision!==command.updatedAt&&!['received','rejected'].includes(command.delivery))pending.push(command);
      // Запрос ограничен 180 КБ текста, включая подтверждения.
      let used=1000;pending=pending.filter(e=>{const size=JSON.stringify(wireRecord(e)).length;if(used+size>170000)return false;used+=size;return true;});
      // Неизменяемость фиксируется ДО сети: неопределённый ответ допускает повтор той же версии.
      await db.updateCloud(pending.map(e=>({id:e.id,revision:e.updatedAt,cloudSending:true})),{});
      const acknowledged=command&&['received','rejected'].includes(command.delivery)&&!command.cloudAck?[command]:[];
      const ack=[...entries,...acknowledged].filter(e=>['received','rejected'].includes(e.delivery)&&!e.cloudAck).slice(-100).map(e=>({id:e.id,revision:e.updatedAt}));
      const controller=new AbortController(),timeout=setTimeout(()=>controller.abort(),35000);let response;
      try{
        const http=await fetch(config.url,{method:'POST',credentials:'omit',redirect:'follow',cache:'no-store',headers:{'Content-Type':'text/plain;charset=utf-8'},signal:controller.signal,
          body:JSON.stringify({v:1,role:'phone',key:config.key,action:'exchange',records:pending.map(wireRecord),ack})});
        if(!http.ok)throw new Error('Сервис недоступен');response=await http.json();
      }finally{clearTimeout(timeout);}
      if(!response?.ok||response.v!==1||!Array.isArray(response.uploaded))throw new Error('Нет подтверждения сервиса');if(this.config!==config)return;
      const at=Date.now(),fresh=await db.getAllEntries(),merged=mergeResult(fresh,response,at);
      this.state={lastSuccess:at,error:'',snapshot:response.snapshot||this.state.snapshot};
      const changes=merged.map(e=>({id:e.id,revision:e.updatedAt,cloudRevision:e.cloudRevision,cloudAck:e.cloudAck,cloudConflict:e.cloudConflict,cloudAt:e.cloudAt,cloudSending:e.cloudSending,delivery:e.delivery,deliveryError:e.deliveryError}));
      const settings={driveState:this.state};
      if(command){const updated=mergeResult([command],response,at)[0];const latest=await db.getSetting('phonePlanCommand');if(latest?.id===command.id)settings.phonePlanCommand=updated;}
      if(response.snapshot?.catalog){const c=response.snapshot.catalog;settings.captureCatalog={...c,app:'zahvat-catalog',v:1};
        settings.finLists={accounts:c.accounts.filter(a=>a.currency==='RUB').map(a=>a.name),cats:c.articles.filter(a=>a.mode==='expense').map(a=>a.name),loadedAt:at};}
      await db.updateCloud(changes,settings);this.last=at;this.failures=0;this.again=this.again||!!(settings.phonePlanCommand&&!settings.phonePlanCommand.cloudRevision&&!settings.phonePlanCommand.cloudConflict&&!['received','rejected'].includes(settings.phonePlanCommand.delivery))||merged.some(needsUpload);
    }catch(error){
      this.failures++;this.state={...this.state,error:'Нет подтверждения обмена. Записи сохранены; повтор при открытии или появлении связи.'};await db.setSetting('driveState',this.state);
      if(this.failures<=2&&!document.hidden)this.timer=setTimeout(()=>{if(!document.hidden)this.run();},this.failures===1?60000:300000);
    }finally{this.busy=false;await this.changed();if(this.again)this.schedule(true);}
  }
}
