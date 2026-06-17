// Merge per-class taxonomy snapshots into one src/taxonomy.json.
//
//   node tools/merge-taxonomy.mjs
//
// The taxonomy exporter (tools/taxonomy-exporter.user.js) downloads one file per
// run (e.g. "C6 - taxonomy.json"). Drop each into Taxonomy/ as you export it;
// this script combines every *.json there into the single bundle the app imports.
// Later snapshots win for an enum that appears in more than one file.

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const DIR = path.join(ROOT, 'Taxonomy');
const OUT = path.join(ROOT, 'src', 'taxonomy.json');

if (!fs.existsSync(DIR)) {
  console.error(`No Taxonomy/ folder at ${DIR}`);
  process.exit(1);
}

const files = fs.readdirSync(DIR).filter((f) => f.toLowerCase().endsWith('.json')).sort();
if (!files.length) {
  console.error('No .json snapshots found in Taxonomy/');
  process.exit(1);
}

const merged = {
  source: null,
  generatedAt: new Date().toISOString(),
  classLabelToEnum: {},
  groupsByEnum: {},
  enums: {},
};

for (const f of files) {
  const t = JSON.parse(fs.readFileSync(path.join(DIR, f), 'utf8'));
  merged.source = merged.source || t.source;
  Object.assign(merged.classLabelToEnum, t.classLabelToEnum || {});
  Object.assign(merged.groupsByEnum, t.groupsByEnum || {});
  for (const [en, groups] of Object.entries(t.enums || {})) {
    merged.enums[en] = { ...(merged.enums[en] || {}), ...groups };
  }
  // quick per-file tally
  let subj = 0, chap = 0, top = 0;
  for (const groups of Object.values(t.enums || {})) {
    for (const g of Object.values(groups)) {
      for (const s of g.subjects || []) {
        subj++;
        for (const c of s.chapters || []) { chap++; top += (c.topics || []).length; }
      }
    }
  }
  console.log(`+ ${f}: enums ${Object.keys(t.enums || {}).join('/')} — ${subj} subjects, ${chap} chapters, ${top} topics`);
}

fs.writeFileSync(OUT, JSON.stringify(merged, null, 2));
const enumsPresent = Object.keys(merged.enums);
const kb = (fs.statSync(OUT).size / 1024).toFixed(0);
console.log(`\nWrote ${path.relative(ROOT, OUT)} — classes ${enumsPresent.join('/')} (${kb} KB).`);
console.log('Run "npm run build" (or restart the dev server) to ship it.');
