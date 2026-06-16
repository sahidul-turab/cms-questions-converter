// Offline trainer: distill CMS exports into a compact, CUMULATIVE knowledge base.
//
//   node tools/train.mjs "Class 6 - All Converted MCQ.csv" "Class 7 ...csv" ...
//   node tools/train.mjs --reset file.csv      # start fresh instead of appending
//   node tools/train.mjs --force file.csv      # re-count a file already trained
//
// Files are fed in one by one over time, so by default each run ADDS to the
// existing src/knowledge.json (counts are all additive). A file is skipped if
// it was already trained (tracked by name) unless --force is given.
//
// We keep only aggregates — never the questions themselves — so knowledge.json
// stays a few KB regardless of corpus size. The app applies the learned CMS
// conventions to every conversion.

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import Papa from 'papaparse';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const OUT = path.join(ROOT, 'src', 'knowledge.json');

const args = process.argv.slice(2);
const reset = args.includes('--reset');
const force = args.includes('--force');
const files = args.filter((a) => !a.startsWith('--'));
if (!files.length) {
  console.error('Usage: node tools/train.mjs [--reset] [--force] <file.csv> [more.csv ...]');
  process.exit(1);
}

const TEXT_FIELDS = ['question title', 'option a', 'option b', 'option c', 'option d', 'solution'];
const OPTION_FIELDS = ['option a', 'option b', 'option c', 'option d'];
const PLAIN_NUM = /^-?\d+(\.\d+)?$/;
const DOLLAR_NUM = /^\$\s*-?\d+(\.\d+)?\s*\$$/;
const VARIANTS = {
  leq: [/\\leq(?![a-zA-Z])/g, /\\le(?![a-zA-Z])/g],
  geq: [/\\geq(?![a-zA-Z])/g, /\\ge(?![a-zA-Z])/g],
  neq: [/\\neq(?![a-zA-Z])/g, /\\ne(?![a-zA-Z])/g],
  arrow: [/\\rightarrow(?![a-zA-Z])/g, /\\to(?![a-zA-Z])/g],
  frac: [/\\frac(?![a-zA-Z])/g, /\\dfrac(?![a-zA-Z])/g],
  mult: [/\\times(?![a-zA-Z])/g, /\\cdot(?![a-zA-Z])/g],
};
const CMD_RE = /\\[a-zA-Z]+/g;

// --- load (or init) cumulative counters ---
let prev = {};
if (!reset && fs.existsSync(OUT)) {
  try { prev = JSON.parse(fs.readFileSync(OUT, 'utf8')); } catch { prev = {}; }
}
const counts = {
  questions: prev.meta?.questions || 0,
  mathQuestions: prev.meta?.mathQuestions || 0,
  plain: prev.numberStyle?.plain || 0,
  dollar: prev.numberStyle?.dollar || 0,
  variants: {},
  commands: new Map(Object.entries(prev.commands || {})),
  subjects: JSON.parse(JSON.stringify(prev.subjects || {})),
  sources: [...(prev.meta?.sources || [])],
};
for (const k of Object.keys(VARIANTS)) counts.variants[k] = (prev.variantCounts?.[k] || [0, 0]).slice();

// case-insensitive column resolver; reads the row passed in.
let colMap = null;
function get(row, name) {
  if (!colMap) {
    colMap = {};
    for (const k of Object.keys(row)) colMap[k.toLowerCase().trim().replace(/^"|"$/g, '')] = k;
  }
  return row[colMap[name.toLowerCase()]] ?? '';
}
function countMatches(re, s) { const m = s.match(re); return m ? m.length : 0; }

function tally(row) {
  const title = get(row, 'question title');
  if (!title) return;
  counts.questions++;
  if (/^(yes|true|1)$/i.test(String(get(row, 'has math equation')).trim())) counts.mathQuestions++;

  const subject = (get(row, 'subject') || 'Unknown').trim() || 'Unknown';
  const subj = counts.subjects[subject] || (counts.subjects[subject] = { count: 0, plain: 0, dollar: 0 });
  subj.count++;

  for (const f of OPTION_FIELDS) {
    const body = String(get(row, f)).replace(/^[A-D]\.\s*/, '').trim();
    if (!body) continue;
    if (PLAIN_NUM.test(body)) { counts.plain++; subj.plain++; }
    else if (DOLLAR_NUM.test(body)) { counts.dollar++; subj.dollar++; }
  }

  let blob = '';
  for (const f of TEXT_FIELDS) blob += ' ' + get(row, f);
  for (const [k, [aRe, bRe]] of Object.entries(VARIANTS)) {
    counts.variants[k][0] += countMatches(aRe, blob);
    counts.variants[k][1] += countMatches(bRe, blob);
  }
  let m;
  CMD_RE.lastIndex = 0;
  while ((m = CMD_RE.exec(blob)) !== null) {
    counts.commands.set(m[0], (counts.commands.get(m[0]) || 0) + 1);
  }
}

function trainFile(filePath) {
  return new Promise((resolve, reject) => {
    colMap = null; // recompute columns per file (headers may differ slightly)
    const before = counts.questions;
    const stream = Papa.parse(Papa.NODE_STREAM_INPUT, {
      header: true, skipEmptyLines: true,
      transformHeader: (h) => h.replace(/^﻿/, '').trim(),
    });
    stream.on('data', tally);
    stream.on('end', () => resolve(counts.questions - before));
    stream.on('error', reject);
    fs.createReadStream(filePath).pipe(stream);
  });
}

function write() {
  const pick = (k, a, b) => (counts.variants[k][0] >= counts.variants[k][1] ? a : b);
  const conventions = {
    leq: pick('leq', '\\leq', '\\le'),
    geq: pick('geq', '\\geq', '\\ge'),
    neq: pick('neq', '\\neq', '\\ne'),
    arrow: pick('arrow', '\\rightarrow', '\\to'),
    frac: pick('frac', '\\frac', '\\dfrac'),
    mult: pick('mult', '\\times', '\\cdot'),
  };
  const commandsObj = Object.fromEntries([...counts.commands.entries()].sort((a, b) => b[1] - a[1]));
  const knowledge = {
    meta: {
      questions: counts.questions, mathQuestions: counts.mathQuestions,
      builtAt: new Date().toISOString(), sources: counts.sources,
    },
    numberStyle: { plain: counts.plain, dollar: counts.dollar, unwrapNumbers: counts.plain >= counts.dollar },
    conventions,
    variantCounts: counts.variants,
    topCommands: Object.entries(commandsObj).slice(0, 60),
    commands: commandsObj,
    subjects: counts.subjects,
  };
  fs.writeFileSync(OUT, JSON.stringify(knowledge, null, 2));
  return knowledge;
}

(async () => {
  for (const f of files) {
    const p = path.isAbsolute(f) ? f : path.join(ROOT, f);
    if (!fs.existsSync(p)) { console.error('  ! not found:', f); continue; }
    const base = path.basename(p);
    if (!force && counts.sources.includes(base)) {
      console.log(`  - skip (already trained): ${base}  [use --force to re-count]`);
      continue;
    }
    process.stdout.write(`  · training ${base} … `);
    const added = await trainFile(p);
    if (!counts.sources.includes(base)) counts.sources.push(base);
    console.log(`${added.toLocaleString()} questions`);
  }
  const k = write();
  console.log(`\nTotal corpus: ${k.meta.questions.toLocaleString()} questions across ${Object.keys(k.subjects).length} subjects.`);
  console.log('Sources:', k.meta.sources.join(', '));
  console.log('Conventions:', k.conventions);
  console.log('Number style:', k.numberStyle);
  console.log('Wrote', path.relative(ROOT, OUT));
})();
