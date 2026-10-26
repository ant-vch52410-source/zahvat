// Запуск тех же проверок, что tests.html, без браузера: node tests/run.mjs.
import { readFile } from 'node:fs/promises';
const root = new URL('../', import.meta.url);
const dataUrl = source => 'data:text/javascript;base64,' + Buffer.from(source).toString('base64');
const core = dataUrl(await readFile(new URL('core.js', root), 'utf8'));
const speech = dataUrl((await readFile(new URL('speech.js', root), 'utf8')).replace("'./core.js'", JSON.stringify(core)));
const nodes = { out: { append(li) { if (li.className === 'fail') console.error(li.textContent); } }, summary: {} };
globalThis.window = {};
globalThis.document = { getElementById: id => nodes[id], createElement: () => ({}), body: { dataset: {} } };
const tests = (await readFile(new URL('tests/tests.js', root), 'utf8'))
  .replace("'../core.js'", JSON.stringify(core)).replace("'../speech.js'", JSON.stringify(speech));
await import(dataUrl(tests));
console.log(nodes.summary.textContent);
if (document.body.dataset.done !== 'ok') process.exitCode = 1;
