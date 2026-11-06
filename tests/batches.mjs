// Группы выгрузки: байты CSV, копии, старая история и версии записей (задачи 7, 36.2).
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
const source=await readFile(new URL('../core.js',import.meta.url),'utf8');
const c=await import('data:text/javascript;base64,'+Buffer.from(source).toString('base64'));
let passed=0;
function test(name,check){check();passed++;console.log('OK '+name);}
const e=(id,ts,text='Пример; \"текст\"\nстрока')=>({id,ts,createdAt:ts,updatedAt:ts,text,source:'text',exportedAt:null,payload:{v:1,kind:'note',text,tags:''}});
const list=[e('newer',200),e('older',100,'=2+2')];
const batch=c.makeExportBatch(list,'stable-group',500);
test('одна отметка, исходные записи не изменены',()=>{assert.equal(list[0].exportedAt,null);assert.deepEqual(batch.records.map(e=>e.exportedAt),[500,500]);assert.ok(batch.records.every(e=>e.exportBatch==='stable-group'));});
test('CSV содержит исходные id и прежние revisions',()=>{const rows=c.parseCsv(batch.csv);assert.deepEqual(rows.slice(1).map(r=>r[0]),['older','newer']);assert.equal(JSON.parse(rows[1][6]).revision,100);assert.equal(rows[1][3],"'=2+2");});
test('снимок не меняется после правки и удаления в текущем списке',()=>{const csv=batch.csv;list[0].payload.text='другое';list.pop();assert.equal(batch.records[0].payload.text,'Пример; \"текст\"\nстрока');assert.equal(batch.records.length,2);assert.equal(batch.csv,csv);});
test('резервная копия сохраняет точные байты и имя CSV',()=>{const restored=c.mergeExportBatches([],JSON.parse(JSON.stringify([batch])))[0];assert.equal(restored.csv,batch.csv);assert.equal(restored.name,batch.name);assert.equal(restored.records.length,2);});
test('группы одного дня остаются отдельными и новые выше',()=>{const second=c.makeExportBatch([e('another',400)],'second',600);assert.deepEqual(c.mergeExportBatches([batch],[second,batch]).map(e=>e.id),['second','stable-group']);});
test('старые записи узнаются по общей дате выгрузки',()=>{assert.equal(c.exportGroupKey({...e('a',1),exportedAt:50}),'legacy-50');assert.equal(c.exportGroupKey({...e('b',2),exportedAt:50}),'legacy-50');assert.equal(c.exportGroupKey(e('unsent',3)),null);});
test('поле группы переживает нормализацию копии',()=>assert.equal(c.normalizeEntry(batch.records[0]).exportBatch,'stable-group'));
test('поддельный CSV из копии не подменяет исходные строки',()=>{const restored=c.mergeExportBatches([],[{...batch,csv:batch.csv.replace('older;','foreign;')}])[0];assert.equal(restored.csv,batch.csv);});
test('неподходящие группы отбрасываются',()=>assert.deepEqual(c.mergeExportBatches([null,{id:'bad',at:1,records:[null]}]),[]));
test('более свежая отметка выгрузки восстанавливается без смены revision',()=>{const original=e('same',100), exported={...original,exportedAt:500,exportBatch:'x'};assert.equal(c.mergeEntries([original],[exported]).toWrite[0].exportBatch,'x');assert.equal(c.mergeEntries([exported],[original]).toWrite.length,0);});
console.log(`${passed} проверок групп CSV пройдены`);
