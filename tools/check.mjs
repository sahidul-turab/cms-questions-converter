// Parse every sample docx and report per-file quality.
import { readFileSync, readdirSync } from 'node:fs';
import { DOMParser } from '@xmldom/xmldom';
import { docxToText } from '../src/docx.js';
import { parseRaw } from '../src/parse.js';

const dir = process.argv[2] || 'Sample Raw File on Many Patterns';
const parseXml = (xml) => new DOMParser().parseFromString(xml, 'text/xml');
const verbose = process.argv.includes('-v');

for (const f of readdirSync(dir).filter((x) => x.endsWith('.docx'))) {
  const qs = parseRaw(docxToText(readFileSync(`${dir}/${f}`), parseXml));
  const noTitle = qs.filter((q) => !q.title).length;
  const lt4 = qs.filter((q) => !(q.options.A && q.options.B && q.options.C && q.options.D)).length;
  const noAns = qs.filter((q) => !q.correct).length;
  const withDiff = qs.filter((q) => q.difficulty).length;
  const topicLeak = qs.filter((q) => /\bTopic\b|\[(E|M|H|Easy|Medium|Hard)\]/i.test(q.title)).length;
  const withExp = qs.filter((q) => q.explanation).length;
  const expLeak = qs.filter((q) => /ব্যাখ্য|সমাধান/.test(q.answerValue)).length;
  console.log(
    `\n=== ${f}\n    questions:${qs.length}  no-title:${noTitle}  <4opts:${lt4}  ` +
    `no-correct:${noAns}  with-difficulty:${withDiff}  with-exp:${withExp}  ` +
    `title-meta-leak:${topicLeak}  exp-in-answer:${expLeak}`
  );
  if (verbose) {
    for (const q of qs.slice(0, 2)) {
      console.log('    Q:', q.title.slice(0, 70));
      console.log('      A:', q.options.A.slice(0, 30), '| B:', q.options.B.slice(0, 30),
        '| C:', q.options.C.slice(0, 30), '| D:', q.options.D.slice(0, 30));
      console.log('      correct:', q.correct, '| diff:', q.difficulty, '| ansVal:', q.answerValue.slice(0, 30));
      console.log('      exp:', q.explanation.slice(0, 60));
    }
  }
}
