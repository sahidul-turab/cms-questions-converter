// Diagnose off-by-one question loss: compare raw markers, split blocks, parsed.
import { readFileSync, readdirSync } from 'node:fs';
import { DOMParser } from '@xmldom/xmldom';
import { docxToText } from '../src/docx.js';
import { splitQuestions, parseBlock, parseRaw } from '../src/parse.js';

const dir = process.argv[2] || 'Sample Raw File on Many Patterns';
const parseXml = (xml) => new DOMParser().parseFromString(xml, 'text/xml');

for (const f of readdirSync(dir).filter((x) => x.endsWith('.docx'))) {
  const text = docxToText(readFileSync(`${dir}/${f}`), parseXml);
  const blocks = splitQuestions(text);
  const parsed = parseRaw(text);
  // Count how many blocks pass the options filter vs not
  const parsedBlocks = blocks.map(parseBlock);
  const dropped = parsedBlocks
    .map((q, i) => ({ q, i }))
    .filter(({ q }) => !(q.options.A && q.options.B));
  console.log(`\n=== ${f}`);
  console.log(`    blocks:${blocks.length}  parsed:${parsed.length}  dropped:${dropped.length}`);
  for (const { q, i } of dropped) {
    const head = blocks[i].slice(0, 80).replace(/\n/g, ' ⏎ ');
    console.log(`    DROP block#${i}  A=${JSON.stringify(q.options.A.slice(0,20))} B=${JSON.stringify(q.options.B.slice(0,20))}  :: ${head}`);
  }
}
