import { readFileSync } from 'node:fs';
import { DOMParser } from '@xmldom/xmldom';
import { docxToText } from '../src/docx.js';
import { parseRaw } from '../src/parse.js';
const parseXml = (xml) => new DOMParser().parseFromString(xml, 'text/xml');
const f = process.argv[2];
const qs = parseRaw(docxToText(readFileSync(f), parseXml));
qs.forEach((q, i) => {
  const bad = !q.title || !q.correct || !(q.options.A && q.options.B && q.options.C && q.options.D);
  if (process.argv.includes('-all') || bad) {
    console.log(`#${i + 1} title="${q.title.slice(0, 60)}" correct=${q.correct} diff=${q.difficulty}`);
    console.log(`   A="${q.options.A.slice(0,25)}" B="${q.options.B.slice(0,25)}" C="${q.options.C.slice(0,25)}" D="${q.options.D.slice(0,25)}"`);
  }
});
