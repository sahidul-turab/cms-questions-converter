// Dump extracted text from sample docx files to study parsing patterns.
import { readFileSync, readdirSync, writeFileSync, mkdirSync } from 'node:fs';
import { DOMParser } from '@xmldom/xmldom';
import { docxToText } from '../src/docx.js';

const dir = process.argv[2] || 'Sample Raw File on Many Patterns';
const parseXml = (xml) => new DOMParser().parseFromString(xml, 'text/xml');
mkdirSync('tools/_dump', { recursive: true });

const files = readdirSync(dir).filter((f) => f.endsWith('.docx'));
for (const f of files) {
  try {
    const buf = readFileSync(`${dir}/${f}`);
    const text = docxToText(buf, parseXml);
    writeFileSync(`tools/_dump/${f.replace(/[^\w.-]/g, '_')}.txt`, text);
    console.log(`OK   ${f}  (${text.length} chars)`);
  } catch (e) {
    console.log(`FAIL ${f}: ${e.message}`);
  }
}
