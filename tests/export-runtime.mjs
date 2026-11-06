// Отмена отправки, повтор и сбои хранилища на логике настоящего приложения (задачи 7, 36.2).
// Это чистая модель окружения, браузеры и реальные данные не используются.
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFile} from 'node:fs/promises';
const root=new URL('../',import.meta.url);
const core=await import('data:text/javascript;base64,'+Buffer.from(await readFile(new URL('core.js',root),'utf8')).toString('base64'));
let source=await readFile(new URL('app.js',root),'utf8');
source=source.replace(/^import[\s\S]*?from ['"][^'"]+['"];\s*/gm,'').replaceAll('import.meta.url',"'https://example.invalid/app.js'").replace(/\ninit\(\);\s*$/,'');
function model(share){
 const nodes=new Map();
 const node=()=>({value:'',textContent:'',disabled:false,hidden:true,querySelectorAll:()=>[],setAttribute(){},classList:{toggle(){}},close(){}});
 const settings={},writes=[],files=[];
 const context=vm.createContext({...core,console,File,Date,URL,setTimeout,clearTimeout,
  crypto:{randomUUID:()=> 'group-'+Math.random()},
  document:{getElementById:id=>{if(!nodes.has(id))nodes.set(id,node());return nodes.get(id);}},
  navigator:{canShare:()=>true,share:async args=>{files.push(args.files[0]);return share?.(args);}},
  CaptureForm:class{},Dictation:class{},
  db:{getSetting:async k=>settings[k],putState:async(entries,values)=>{writes.push({entries,values});Object.assign(settings,values);}},
 });
 vm.runInContext(source,context);
 vm.runInContext(`render=()=>{};showToast=()=>{};entries=[{id:'e1',ts:100,createdAt:100,updatedAt:100,text:'Исходный текст',source:'text',exportedAt:null}];`,context);
 return {context,writes,settings,files,run:code=>vm.runInContext(code,context)};
}
let passed=0;
async function test(name,fn){await fn();passed++;console.log('OK '+name);}
await test('отмена Android не создаёт группу и не отмечает записи',async()=>{
 const m=model(()=>{const e=new Error('cancel');e.name='AbortError';throw e;});await m.run("exportCsv('new','share')");assert.equal(m.writes.length,0);assert.equal(m.run('entries[0].exportedAt'),null);assert.equal(m.run('exportBusy'),false);
});
await test('успешная передача записывает группу и отметки атомарно',async()=>{
 const m=model();await m.run("exportCsv('new','share')");assert.equal(m.writes.length,1);assert.equal(m.settings.exportBatches.length,1);assert.equal(m.run('entries[0].exportBatch'),m.settings.exportBatches[0].id);assert.equal(m.settings.exportBatches[0].records[0].updatedAt,100);
});
await test('сбой базы оставляет запись в очереди и снимает блокировку',async()=>{
 const m=model();m.context.db.putState=async()=>{throw new Error('quota');};await assert.rejects(m.run("exportCsv('new','share')"),/quota/);assert.equal(m.run('entries[0].exportedAt'),null);assert.equal(m.run('exportBusy'),false);assert.equal(m.run('exportBatches.length'),0);
});
await test('правка во время передачи остаётся неотправленной',async()=>{
 let release;const m=model(()=>new Promise(r=>{release=r;}));const pending=m.run("exportCsv('new','share')");m.run("entries[0]={...entries[0],updatedAt:200,text:'Правка после начала отправки'}");release();await pending;assert.equal(m.run('entries[0].exportedAt'),null);assert.equal(m.settings.exportBatches[0].records[0].text,'Исходный текст');
});
await test('повтор берёт прежнее имя и байты, сохраняя новые записи и группу',async()=>{
 const m=model();await m.run("exportCsv('new','share')");const original=await m.files[0].text(),name=m.files[0].name;m.run("entries.push({id:'new2',ts:200,updatedAt:200,text:'Новая',exportedAt:null});entries[0].text='Изменённый текущий текст'");await m.run('resendBatch(exportBatches[0])');assert.equal(await m.files[1].text(),original);assert.equal(m.files[1].name,name);assert.equal(m.writes.length,1);assert.equal(m.run('entries[1].exportedAt'),null);
});
await test('повторные нажатия не запускают параллельную передачу',async()=>{
 let release;const m=model(()=>new Promise(r=>{release=r;}));const pending=m.run("exportCsv('new','share')");await m.run("exportCsv('new','share')");assert.equal(m.files.length,1);release();await pending;
});
await test('отмена отметки возвращает прежнюю группу без смены версии записи',async()=>{
 const m=model();m.run("entries[0].exportedAt=50;entries[0].exportBatch='old'");await m.run("exportCsv('all','share')");await m.run('undoExport()');assert.equal(m.run('entries[0].exportedAt'),50);assert.equal(m.run('entries[0].exportBatch'),'old');assert.equal(m.run('entries[0].updatedAt'),100);assert.equal(m.run('exportBatches.length'),0);
});
console.log(`${passed} проверок ошибок и повтора пройдены`);
