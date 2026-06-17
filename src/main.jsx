import React, { useMemo, useState, useCallback, useEffect, useRef } from 'react';
import { createRoot } from 'react-dom/client';
import * as XLSX from 'xlsx';
import katex from 'katex';
import 'katex/dist/katex.min.css';
import './style.css';

import { docxToContent, IMG_PLACEHOLDER_PREFIX } from './docx.js';
import { applyConventions } from './omml.js';
import { isUploadConfigured, uploadImages } from './upload.js';
import { parseRaw, bnToEn } from './parse.js';
import { toCmsRow, buildCorpus, attachNearest, MATH_FIELDS } from './style.js';
import { listSubjects, getDataset, putDataset, deleteDataset } from './db.js';
import knowledge from './knowledge.json';
import taxonomy from './taxonomy.json';

// The app is pre-trained: apply CMS conventions learned offline from the full
// corpus (tools/train.mjs) to every conversion. No reference upload needed.
applyConventions(knowledge.conventions);

const KNOWN_SUBJECTS = Object.keys(knowledge.subjects || {}).sort();

// Number style (plain "0" vs "$0$") for a subject, falling back to the global
// corpus average.
function numberStyleFor(subject) {
  const s = (knowledge.subjects || {})[subject];
  const plain = s ? s.plain : knowledge.numberStyle.plain;
  const dollar = s ? s.dollar : knowledge.numberStyle.dollar;
  return {
    sampleSize: s ? s.count : knowledge.meta.questions,
    plainNumberOptions: plain,
    dollarNumberOptions: dollar,
    unwrapNumbers: plain >= dollar,
  };
}

// Export schema = "Sample Structure for CMS Auto Input". The download must
// match this exactly so rows drop straight into the CMS. Generated fields
// (title/options/correct/solution/has_math/difficulty) carry the converted
// content; the rest come from the editable dummy defaults below.
const AUTO_INPUT_COLUMNS = ['class', 'group', 'subject', 'chapter', 'topic', 'title', 'option_a', 'option_b', 'option_c', 'option_d', 'correct_option', 'solution', 'difficulty_level', 'has_math_equation', 'allocated_time', 'allocated_marks', 'question_source_category', 'question_type', 'is_active', 'markdown_version', 'description'];
// Dummy metadata taken from the sample file (editable in the UI).
const AUTO_INPUT_DEFAULTS = {
  class: 'Class 6', group: '', subject: '', chapter: '', topic: '',
  difficulty_level: 'Easy', allocated_time: '1', allocated_marks: '',
  question_source_category: 'Engineering', question_type: 'MCQ',
  is_active: 'true', markdown_version: '1', description: '',
};
const CONFIG_FIELDS = ['class', 'group', 'subject', 'chapter', 'question_source_category', 'question_type', 'difficulty_level', 'allocated_time', 'allocated_marks', 'is_active', 'markdown_version'];
// Class/group/subject/chapter are driven by the CMS taxonomy snapshot (cascading
// dropdowns); the rest stay free-text. Topic is NOT picked here — it is read
// per-question from the uploaded doc and matched against the taxonomy per row.
const TAXONOMY_FIELDS = ['class', 'group', 'subject', 'chapter'];
const META_TEXT_FIELDS = CONFIG_FIELDS.filter((k) => !TAXONOMY_FIELDS.includes(k));

// ---- CMS taxonomy lookups (Class → Subject → Chapter → Topic) ----
// Built offline by tools/taxonomy-exporter.user.js against cms.shikho.com.
const TAX_ENUMS_PRESENT = Object.keys(taxonomy.enums || {});
// Only offer class labels we actually have data for (e.g. C6-only snapshot).
const CLASS_OPTIONS = Object.keys(taxonomy.classLabelToEnum || {})
  .filter((label) => TAX_ENUMS_PRESENT.includes(taxonomy.classLabelToEnum[label]));

function taxGroupsFor(classLabel) {
  const en = (taxonomy.classLabelToEnum || {})[classLabel];
  return (taxonomy.groupsByEnum && taxonomy.groupsByEnum[en]) || [''];
}
function taxNeedsGroup(classLabel) {
  const g = taxGroupsFor(classLabel);
  return !(g.length === 1 && g[0] === '');
}
function taxSubjects(classLabel, group) {
  const en = (taxonomy.classLabelToEnum || {})[classLabel];
  const node = (taxonomy.enums || {})[en];
  if (!node) return [];
  const key = taxNeedsGroup(classLabel) ? (group || '') : '';
  return (node[key] && node[key].subjects) || [];
}
function taxChapters(classLabel, group, subjectName) {
  const s = taxSubjects(classLabel, group).find((x) => x.name === subjectName);
  return s ? s.chapters : [];
}
function taxTopics(classLabel, group, subjectName, chapterName) {
  const c = taxChapters(classLabel, group, subjectName).find((x) => x.name === chapterName);
  return c ? c.topics : [];
}

// ---- Document metadata detection & mismatch checks ----

// Bengali ordinals used in paper/chapter headers.
const BN_ORDINALS = [
  ['প্রথম','1'],['দ্বিতীয়','2'],['তৃতীয়','3'],['চতুর্থ','4'],
  ['পঞ্চম','5'],['ষষ্ঠ','6'],['সপ্তম','7'],['অষ্টম','8'],
  ['নবম','9'],['দশম','10'],
];

// Scan the raw text header (before questions) for paper-number and subject hints.
function detectDocMeta(rawText) {
  const headerText = (rawText || '').split('\n').slice(0, 20).map(l => l.trim()).filter(Boolean).join(' ');
  let paper = '';
  for (const [bn, num] of BN_ORDINALS) {
    if (headerText.includes(bn + ' পত্র')) { paper = num; break; }
  }
  if (!paper) {
    const m = headerText.match(/\b([123])(st|nd|rd|th)\s*paper\b/i);
    if (m) paper = m[1];
  }
  return { paper };
}

// Extract paper number (1/2/3) from any string (subject name, doc header, etc.).
function paperNum(s) {
  const l = String(s || '').toLowerCase();
  for (const [bn, num] of BN_ORDINALS) {
    if (l.includes(bn + ' পত্র') || l.includes(bn + 'পত্র')) return num;
  }
  if (l.includes('প্রথম') || l.includes('1st') || l.includes('first')) return '1';
  if (l.includes('দ্বিতীয়') || l.includes('2nd') || l.includes('second')) return '2';
  if (l.includes('তৃতীয়') || l.includes('3rd') || l.includes('third')) return '3';
  return '';
}

// Compute mismatch warnings comparing doc metadata + parsed rows against cfg dropdowns.
function computeMismatches(docMeta, built, cfg, allTaxTopics) {
  const warnings = [];

  // Paper number: doc header vs. selected subject name.
  if (docMeta.paper) {
    const selPaper = paperNum(cfg.subject);
    if (selPaper && selPaper !== docMeta.paper) {
      const ordLabel = (n) => n === '1' ? '1st' : n === '2' ? '2nd' : n === '3' ? '3rd' : n + 'th';
      warnings.push({
        level: 'error', field: 'subject',
        msg: `Paper mismatch — document is ${ordLabel(docMeta.paper)} Paper but "${cfg.subject}" (${ordLabel(selPaper)} Paper) is selected.`,
      });
    }
  }

  // Chapter: per-question chapters vs. selected cfg.chapter.
  const docChapters = [...new Set(built.map(r => r['Chapter']).filter(Boolean))];
  if (docChapters.length > 0 && cfg.chapter) {
    if (!docChapters.includes(cfg.chapter.trim())) {
      warnings.push({
        level: 'error', field: 'chapter',
        msg: `Chapter mismatch — "${cfg.chapter}" is selected but document has: ${docChapters.slice(0, 5).join(', ')}${docChapters.length > 5 ? '…' : ''}.`,
      });
    }
  }
  if (docChapters.length > 1) {
    warnings.push({
      level: 'info', field: 'chapter',
      msg: `Document spans ${docChapters.length} chapters — per-question chapters will be used in the export, not the global chapter setting.`,
    });
  }

  // Topic match rate: if a subject is selected but topics barely match, flag it.
  if (cfg.subject && allTaxTopics.length > 0 && built.length > 0) {
    const docTopics = built.flatMap(r => r._docTopics || []).filter(t => t && t.name);
    if (docTopics.length > 0) {
      const hits = docTopics.filter(dt => {
        const s = matchTopic(dt, allTaxTopics).status;
        return s === 'matched' || s === 'suggested';
      }).length;
      const rate = hits / docTopics.length;
      if (rate < 0.35) {
        warnings.push({
          level: 'warn', field: 'subject',
          msg: `Only ${Math.round(rate * 100)}% of doc topics matched "${cfg.subject}" — verify the subject is correct.`,
        });
      }
    }
  }

  return warnings;
}

// Resolve a raw chapter number (Bengali or ASCII) to the taxonomy chapter object.
function taxChapterByNo(classLabel, group, subjectName, rawNo) {
  if (!rawNo) return null;
  const n = bnToEn(String(rawNo)).trim();
  return taxChapters(classLabel, group, subjectName).find((c) => String(c.no).trim() === n) || null;
}

// Every topic of the picked subject (across all its chapters), de-duplicated —
// the candidate set the per-question doc topics are matched against.
function taxAllTopics(classLabel, group, subjectName) {
  const out = [];
  const seen = new Set();
  for (const c of taxChapters(classLabel, group, subjectName)) {
    for (const t of (c.topics || [])) {
      const key = (t.no || '') + '|' + t.name;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({ no: String(t.no || ''), name: t.name, chapter: c.name });
    }
  }
  return out;
}

const normTopic = (s) => String(s || '').normalize('NFC').toLowerCase().replace(/[।,;|()\-–—.]/g, ' ').replace(/\s+/g, ' ').trim();
function topicTokens(s) { return new Set(normTopic(s).split(' ').filter(Boolean)); }
function topicSim(a, b) {
  const A = topicTokens(a), B = topicTokens(b);
  if (!A.size || !B.size) return 0;
  let inter = 0; for (const x of A) if (B.has(x)) inter++;
  return inter / (A.size + B.size - inter);
}

// Resolve one doc topic against the subject taxonomy:
//   matched   → exact section-number or name hit (use the canonical CMS name)
//   suggested → best fuzzy guess (user should confirm or repick)
//   none      → no taxonomy for this class / no good match (keep the doc text)
function matchTopic(docTopic, taxTopics) {
  const docName = (docTopic && docTopic.name) || '';
  if (!taxTopics || !taxTopics.length) return { status: 'none', name: docName };
  if (docTopic.no) {
    const byNo = taxTopics.find((t) => t.no === docTopic.no);
    if (byNo) return { status: 'matched', name: byNo.name, no: byNo.no };
  }
  const target = normTopic(docName);
  if (target) {
    const exact = taxTopics.find((t) => normTopic(t.name) === target);
    if (exact) return { status: 'matched', name: exact.name, no: exact.no };
  }
  let best = null, score = 0;
  for (const t of taxTopics) { const s = topicSim(docName, t.name); if (s > score) { score = s; best = t; } }
  if (best && score >= 0.5) return { status: 'suggested', name: best.name, no: best.no, score };
  return { status: 'none', name: docName };
}

// Cascading Class → Group → Subject → Chapter → Topic dropdowns. Writes the
// exact CMS names into cfg (output stays names-only) so the upload file matches
// the live CMS taxonomy with no guessing.
function TaxonomyPicker({ cfg, setCfg, warnings }) {
  const needGroup = taxNeedsGroup(cfg.class);
  const subjects = taxSubjects(cfg.class, cfg.group);
  const chapters = taxChapters(cfg.class, cfg.group, cfg.subject);
  const opt = (val, label) => <option key={val} value={val}>{label}</option>;
  const flag = (field) => {
    const w = (warnings || []).find(w => w.field === field);
    if (!w) return null;
    return <span className={'taxflag taxflag-' + w.level} title={w.msg}>{w.level === 'error' ? '⚠' : '!'}</span>;
  };
  return (
    <>
      <label>class
        <select value={CLASS_OPTIONS.includes(cfg.class) ? cfg.class : ''}
          onChange={(e) => setCfg({ ...cfg, class: e.target.value, group: '', subject: '', chapter: '', topic: '' })}>
          {!CLASS_OPTIONS.includes(cfg.class) && <option value="">Select class…</option>}
          {CLASS_OPTIONS.map((c) => opt(c, c))}
        </select>
      </label>
      <label>group
        <select value={cfg.group || ''} disabled={!needGroup}
          onChange={(e) => setCfg({ ...cfg, group: e.target.value, subject: '', chapter: '', topic: '' })}>
          {needGroup
            ? [<option key="" value="">Select group…</option>, ...taxGroupsFor(cfg.class).map((g) => opt(g, g))]
            : [<option key="" value="">— not used —</option>]}
        </select>
      </label>
      <label>subject {flag('subject')}
        <select value={cfg.subject || ''}
          onChange={(e) => setCfg({ ...cfg, subject: e.target.value, chapter: '', topic: '' })}>
          <option value="">Select subject…</option>
          {subjects.map((s) => opt(s.name, s.name.trim() + (s.name_bn ? '  ·  ' + s.name_bn : '')))}
        </select>
      </label>
      <label>chapter {flag('chapter')}
        <select value={cfg.chapter || ''} disabled={!cfg.subject}
          onChange={(e) => setCfg({ ...cfg, chapter: e.target.value })}>
          <option value="">Select chapter…</option>
          {chapters.map((c) => opt(c.name, (c.no ? c.no + '. ' : '') + c.name))}
        </select>
      </label>
    </>
  );
}

// Searchable combobox for the taxonomy topic list.
// Two-state design: closed = clickable display div; open = real text input.
// This avoids controlled-value flickering that hides typed text.
function SearchableSelect({ value, options, onChange, placeholder }) {
  const [search, setSearch] = useState('');
  const [open, setOpen] = useState(false);
  const wrapRef = useRef(null);
  const inputRef = useRef(null);

  // Auto-focus the search input when opened.
  useEffect(() => {
    if (open && inputRef.current) inputRef.current.focus();
  }, [open]);

  // Close on outside click.
  useEffect(() => {
    if (!open) return;
    const handler = (e) => {
      if (wrapRef.current && !wrapRef.current.contains(e.target)) {
        setOpen(false); setSearch('');
      }
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [open]);

  const selectedLabel = (options.find((o) => o.value === value) || {}).label || value || '';
  const filtered = search
    ? options.filter((o) => o.label.toLowerCase().includes(search.toLowerCase()))
    : options;

  return (
    <div className="topic-search-wrap" ref={wrapRef}>
      {open ? (
        <input
          ref={inputRef}
          className="topic-search-input"
          value={search}
          placeholder="Type to search…"
          onChange={(e) => setSearch(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Escape') { setOpen(false); setSearch(''); }
            if (e.key === 'Enter' && filtered.length > 0) {
              onChange(filtered[0].value); setOpen(false); setSearch('');
            }
          }}
        />
      ) : (
        <div
          className={'topic-display' + (value ? '' : ' topic-placeholder')}
          onClick={() => { setSearch(''); setOpen(true); }}
          tabIndex={0}
          onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { setSearch(''); setOpen(true); } }}
        >
          {value ? selectedLabel : (placeholder || '— select topic —')}
          <span className="topic-chevron">▾</span>
        </div>
      )}
      {open && (
        <div className="topic-dropdown">
          {filtered.map((o) => (
            <div
              key={o.value || '_empty'}
              className={'topic-option' + (o.value === value ? ' active' : '')}
              onMouseDown={(e) => {
                e.preventDefault();
                onChange(o.value); setOpen(false); setSearch('');
              }}
            >
              {o.label}
            </div>
          ))}
          {filtered.length === 0 && (
            <div className="topic-option" style={{ color: 'var(--ink-400)', cursor: 'default' }}>No matches</div>
          )}
        </div>
      )}
    </div>
  );
}

// Per-question chapter selector. Shows a searchable dropdown of taxonomy chapters
// for the chosen subject, with a ✓/✎ status badge identical to TopicCell.
function ChapterCell({ row, taxChapterList, onChange }) {
  const val = row['Chapter'] || '';
  const inTax = taxChapterList.length > 0 && !!val && taxChapterList.some((c) => c.name === val);
  const badge = inTax ? 'ok' : 'doc';
  const tipText = inTax
    ? 'Exact chapter match ✓'
    : taxChapterList.length === 0
    ? 'No taxonomy loaded — verify name matches CMS'
    : val
    ? 'Chapter not in taxonomy — will fail upload'
    : 'No chapter set';
  return (
    <div className="chaptercell">
      <div className="topicrow">
        <span className={'tbadge ' + badge} title={tipText}>
          {badge === 'ok' ? '✓' : '✎'}
        </span>
        <SearchableSelect
          value={val}
          placeholder="— select chapter —"
          options={taxChapterList.map((c) => ({ value: c.name, label: (c.no ? c.no + ' ' : '') + c.name }))}
          onChange={onChange}
        />
      </div>
      {badge === 'doc' && taxChapterList.length > 0 && val && (
        <div className="thint">⚠ Not in taxonomy — will fail upload</div>
      )}
    </div>
  );
}

// Per-question topic editor. Topics come from the uploaded doc (one question may
// carry several). When the picked subject has a taxonomy, each doc topic is
// matched to it: a green ✓ means an exact hit (canonical name auto-filled), an
// amber ~ is a fuzzy suggestion to confirm/repick, and ✎ means free doc text
// (no taxonomy for this class yet). Always editable; one-click accept = leave as is.
function TopicCell({ row, taxTopics, onChange }) {
  const docTopics = row._docTopics || [];
  const chosen = (row._topics && row._topics.length) ? row._topics : [''];
  const hasTax = taxTopics.length > 0;
  const setSlot = (i, v) => { const next = chosen.slice(); next[i] = v; onChange(next); };
  const addSlot = () => onChange([...chosen, '']);
  const delSlot = (i) => onChange(chosen.filter((_, j) => j !== i));

  let warnCount = 0, errCount = 0;
  const slots = chosen.map((val, i) => {
    const dt = docTopics[i] || { no: '', name: val };
    const docMatch = hasTax ? matchTopic(dt, taxTopics) : { status: 'none', name: '' };
    const valInTax = hasTax && !!val && taxTopics.some((t) => t.name === val);
    const isAutoSuggested = valInTax && docMatch.status === 'suggested' && val === docMatch.name;
    const badge = valInTax ? (isAutoSuggested ? 'warn' : 'ok') : 'doc';
    if (badge === 'warn') warnCount++;
    if (badge === 'doc' && hasTax && val) errCount++;
    const tipText = badge === 'ok'
      ? 'Exact CMS match ✓'
      : badge === 'warn'
      ? 'Auto-matched to closest CMS name — verify it is correct before exporting'
      : hasTax
      ? 'Not found in taxonomy — this text will fail CMS upload, search and select the correct name'
      : 'No taxonomy loaded — verify name matches CMS exactly';
    return { val, dt, badge, tipText };
  });

  return (
    <div className="topiccell">
      {slots.map(({ val, dt, badge, tipText }, i) => (
        <div className="topicrow" key={i}>
          <span className={'tbadge ' + badge} title={tipText}>
            {badge === 'ok' ? '✓' : badge === 'warn' ? '~' : '✎'}
          </span>
          {hasTax ? (
            <SearchableSelect
              value={val}
              placeholder="— select topic —"
              options={taxTopics.map((t) => ({ value: t.name, label: (t.no ? t.no + ' ' : '') + t.name }))}
              onChange={(v) => setSlot(i, v)}
            />
          ) : (
            <input value={val} onChange={(e) => setSlot(i, e.target.value)} placeholder="topic from doc" />
          )}
          {chosen.length > 1 && (
            <button type="button" className="tdel" title="remove topic" onClick={() => delSlot(i)}>×</button>
          )}
        </div>
      ))}
      <button type="button" className="tadd" onClick={addSlot}>+ topic</button>
      {(warnCount > 0 || errCount > 0) && (
        <div className="thint">
          {warnCount > 0 && `~ ${warnCount} auto-matched CMS name — hover badge to confirm`}
          {warnCount > 0 && errCount > 0 && ' · '}
          {errCount > 0 && `⚠ ${errCount} not found in taxonomy — search and select`}
        </div>
      )}
    </div>
  );
}

const GEN_FIELDS = ['Question Title', 'Option A', 'Option B', 'Option C', 'Option D', 'Correct Option', 'Solution', 'Has Math Equation'];
const PREVIEW_COLS = [...GEN_FIELDS, 'Difficulty Level', 'Chapter', 'Topic(s)'];

// Fields that can carry an inline image placeholder from the DOCX.
const IMG_FIELDS = ['Question Title', 'Option A', 'Option B', 'Option C', 'Option D', 'Solution'];
// Matches the basename inside <img src="shikho-img:imageN.png" …/> (stops at the
// closing quote, whitespace, or paren).
const PLACEHOLDER_RE = new RegExp(IMG_PLACEHOLDER_PREFIX.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '([^)\\s"]+)', 'g');

// Collect every image basename still referenced by a placeholder across rows.
function neededImages(rows) {
  const set = new Set();
  for (const r of rows) {
    for (const f of IMG_FIELDS) {
      const s = r[f];
      if (typeof s !== 'string' || s.indexOf(IMG_PLACEHOLDER_PREFIX) === -1) continue;
      let m; PLACEHOLDER_RE.lastIndex = 0;
      while ((m = PLACEHOLDER_RE.exec(s))) set.add(m[1]);
    }
  }
  return set;
}

// Rewrite shikho-img:<basename> -> hosted URL in every image-bearing field.
function applyImageUrls(rows, urlByBasename) {
  return rows.map((r) => {
    let changed = false;
    const next = { ...r };
    for (const f of IMG_FIELDS) {
      const s = next[f];
      if (typeof s !== 'string' || s.indexOf(IMG_PLACEHOLDER_PREFIX) === -1) continue;
      const rep = s.replace(PLACEHOLDER_RE, (m, base) => urlByBasename[base] || m);
      if (rep !== s) { next[f] = rep; changed = true; }
    }
    return changed ? next : r;
  });
}

// Auto Input options must carry their "A. " / "B. " … label — the CMS upload
// expects each option self-numbered, and dropping it forces the team to re-add
// every prefix by hand. Strip whatever letter prefix the reviewer left (Latin or
// Bengali, "A." or "A)") and re-apply the canonical "<L>. <value>", so a manual
// edit that changed or removed the prefix still exports correctly. Only the
// options get numbered — question title and the rest stay label-free.
function ensureOptionPrefix(letter, v) {
  const body = String(v || '').replace(/^\s*[A-Eক-ঙ]\s*[.)]\s*/, '').trim();
  return body ? letter + '. ' + body : '';
}


function csvEscape(v) {
  v = String(v ?? '');
  return /[",\n]/.test(v) ? '"' + v.replace(/"/g, '""') + '"' : v;
}
function downloadBlob(name, content, type) {
  const blob = new Blob([content], { type });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = name; a.click();
  URL.revokeObjectURL(url);
}

// Render a string with inline $...$ to HTML via KaTeX (errors shown inline).
function MathText({ value }) {
  const html = useMemo(() => {
    const s = String(value || '');
    if (!s) return '';
    const parts = s.split(/(\$[^$]*\$|<img\b[^>]*>)/gi);
    return parts.map((p) => {
      if (/^\$[^$]*\$$/.test(p)) {
        try {
          return katex.renderToString(p.slice(1, -1), { throwOnError: false, output: 'html' });
        } catch {
          return '<span class="mathbad">' + p.replace(/</g, '&lt;') + '</span>';
        }
      }
      if (/^<img\b/i.test(p)) {
        const src = (p.match(/\bsrc="([^"]*)"/i) || [])[1] || '';
        if (src.indexOf(IMG_PLACEHOLDER_PREFIX) === 0) {
          return '<span class="imgchip">🖼 ' + src.slice(IMG_PLACEHOLDER_PREFIX.length).replace(/</g, '&lt;') + ' · pending upload</span>';
        }
        return p; // generated <img> tag — render as-is (CSS caps the preview size)
      }
      return p.replace(/</g, '&lt;').replace(/\n/g, '<br>');
    }).join('');
  }, [value]);
  return <div className="mathprev" dangerouslySetInnerHTML={{ __html: html }} />;
}

function App() {
  const [subjects, setSubjects] = useState(KNOWN_SUBJECTS);
  const [subject, setSubject] = useState('');          // active subject
  const [corrections, setCorrections] = useState([]);
  const [style, setStyle] = useState({ unwrapNumbers: knowledge.numberStyle.unwrapNumbers, sampleSize: 0, plainNumberOptions: 0, dollarNumberOptions: 0 });
  const [raw, setRaw] = useState('');
  const [images, setImages] = useState({}); // { basename: { bytes, contentType } } from the DOCX
  const [rows, setRows] = useState([]);
  const [docWarnings, setDocWarnings] = useState([]);
  const [busy, setBusy] = useState('');
  const [showMath, setShowMath] = useState(true);
  const [cfg, setCfg] = useState({ ...AUTO_INPUT_DEFAULTS });
  const skipPersist = useRef(true);

  // Corpus for example matching = the user's own saved corrections only.
  // (The full CMS corpus lives in the background knowledge base, not in memory.)
  const corpus = useMemo(() => buildCorpus([], corrections), [corrections]);

  // --- subject load / create / delete; per-subject cfg+corrections persist ---
  const loadSubject = useCallback(async (name) => {
    skipPersist.current = true;
    let ds = null;
    try { ds = await getDataset(name); } catch { /* IndexedDB unavailable — use defaults */ }
    setCorrections(ds?.corrections || []);
    // cfg.subject is the CMS taxonomy subject (section 2), independent of the
    // training/style subject selected here — so don't overwrite it.
    setCfg({ ...AUTO_INPUT_DEFAULTS, ...(ds?.cfg || {}) });
    const ns = numberStyleFor(name);
    setStyle({ ...ns, unwrapNumbers: ds?.unwrapNumbers ?? ns.unwrapNumbers });
    setSubject(name);
    setRows([]); setRaw(''); setDocWarnings([]);
    try { localStorage.setItem('cms_last_subject', name); } catch { /* ignore */ }
  }, []);

  // On mount: union of trained subjects + any custom ones; restore last used.
  useEffect(() => {
    (async () => {
      let idbNames = [];
      try { idbNames = await listSubjects(); } catch { /* ignore */ }
      const all = Array.from(new Set([...KNOWN_SUBJECTS, ...idbNames])).sort();
      const list = all.length ? all : ['Higher Math 1st'];
      setSubjects(list);
      let last = null;
      try { last = localStorage.getItem('cms_last_subject'); } catch { /* ignore */ }
      await loadSubject(list.includes(last) ? last : list[0]);
    })();
  }, [loadSubject]);

  // Persist cfg + corrections per subject (debounced; skipped right after load).
  useEffect(() => {
    if (!subject) return;
    if (skipPersist.current) { skipPersist.current = false; return; }
    const t = setTimeout(() => {
      putDataset({ subject, cfg, corrections, unwrapNumbers: style.unwrapNumbers }).catch(() => {});
    }, 300);
    return () => clearTimeout(t);
  }, [subject, cfg, corrections, style.unwrapNumbers]);

  const createSubject = useCallback(async () => {
    const name = (prompt('New subject name (e.g. "Physics 1st", "Chemistry 2nd"):') || '').trim();
    if (!name) return;
    setSubjects((s) => Array.from(new Set([...s, name])).sort());
    await loadSubject(name);
  }, [loadSubject]);

  const removeSubject = useCallback(async () => {
    if (!subject || !confirm(`Reset saved defaults/corrections for "${subject}"?`)) return;
    await deleteDataset(subject);
    const idbNames = await listSubjects();
    const all = Array.from(new Set([...KNOWN_SUBJECTS, ...idbNames])).sort();
    const list = all.length ? all : ['Higher Math 1st'];
    setSubjects(list);
    await loadSubject(list[0]);
  }, [subject, loadSubject]);

  const loadDocx = useCallback(async (file) => {
    setBusy('Extracting math from DOCX…');
    try {
      const buf = await file.arrayBuffer();
      const { text, images: imgs } = docxToContent(buf); // native DOMParser in the browser
      setRaw(text);
      setImages(imgs || {});
    } catch (e) {
      alert('DOCX read failed: ' + e.message);
    }
    setBusy('');
  }, []);

  const subjectTaxTopics = useMemo(
    () => taxAllTopics(cfg.class, cfg.group, cfg.subject),
    [cfg.class, cfg.group, cfg.subject]
  );
  const subjectTaxChapters = useMemo(
    () => taxChapters(cfg.class, cfg.group, cfg.subject),
    [cfg.class, cfg.group, cfg.subject]
  );

  // When the user picks a new chapter from the ChapterCell dropdown, re-resolve
  // the row's doc topics against the new chapter's topic list.
  const onChapterChange = (i, r, newChapter) => {
    const chTopics = taxTopics(cfg.class, cfg.group, cfg.subject, newChapter);
    const docTopics = r._docTopics || [];
    const reResolved = chTopics.length
      ? docTopics.map((dt) => matchTopic(dt, chTopics).name).filter(Boolean)
      : [];
    setRows((rs) => rs.map((row, idx) => idx === i
      ? { ...row, 'Chapter': newChapter, _topics: reResolved }
      : row
    ));
  };

  const format = useCallback(async () => {
    const taxTopics = taxAllTopics(cfg.class, cfg.group, cfg.subject);
    const parsed = parseRaw(raw);
    let built = parsed.map((q) => {
      const base = toCmsRow(q, style);
      const docTopics = (q.topics && q.topics.length) ? q.topics
        : (q.topic ? [{ no: '', name: q.topic }] : []);
      const resolved = docTopics.map((dt) => matchTopic(dt, taxTopics).name);
      let resolvedChapter = '';
      if (q.chapter) {
        const ch = taxChapterByNo(cfg.class, cfg.group, cfg.subject, q.chapter);
        resolvedChapter = ch ? ch.name : bnToEn(String(q.chapter)).trim();
      }
      const withMeta = {
        'Difficulty Level': q.difficulty || '',
        'Chapter': resolvedChapter,
        'Topic(s)': q.topic || '',
        _docTopics: docTopics,
        _topics: resolved,
      };
      return attachNearest({ ...base, ...withMeta }, corpus);
    });

    // Auto-upload inline images and rewrite placeholders to hosted CMS URLs,
    // replacing the manual "save as picture → upload → copy url → paste" flow.
    const needed = neededImages(built);
    const uploadWarnings = [];
    if (needed.size) {
      if (!isUploadConfigured()) {
        uploadWarnings.push({
          level: 'warn', field: 'image',
          msg: `${needed.size} image(s) found in the doc but image upload is not configured — set the upload preset in src/upload.js, or paste the URLs manually. Placeholders are kept so nothing is lost.`,
        });
      } else {
        try {
          const urlMap = await uploadImages(needed, images, (done, total) =>
            setBusy(`Uploading images ${done}/${total}…`));
          built = applyImageUrls(built, urlMap);
          const missed = neededImages(built).size;
          if (missed) uploadWarnings.push({ level: 'warn', field: 'image', msg: `${missed} image(s) could not be uploaded — paste their URLs manually.` });
        } catch (e) {
          uploadWarnings.push({ level: 'error', field: 'image', msg: 'Image upload failed: ' + (e && e.message ? e.message : e) });
        } finally {
          setBusy('');
        }
      }
    }

    setRows(built);
    const docMeta = detectDocMeta(raw);
    setDocWarnings([...uploadWarnings, ...computeMismatches(docMeta, built, cfg, taxTopics)]);
  }, [raw, images, style, corpus, cfg.class, cfg.group, cfg.subject]);

  const updateCell = (i, col, val) => setRows((rs) => rs.map((r, idx) => (idx === i ? { ...r, [col]: val } : r)));
  const setTopics = (i, arr) => setRows((rs) => rs.map((r, idx) => (idx === i ? { ...r, _topics: arr } : r)));

  const reformatStyle = (unwrap) => {
    setStyle((s) => ({ ...s, unwrapNumbers: unwrap }));
  };

  // Map a previewed/edited row to the Auto-Input schema (dummy meta from cfg).
  const buildAutoRow = useCallback((r) => ({
    class: cfg.class,
    group: cfg.group,
    subject: cfg.subject,
    chapter: ((r['Chapter'] && r['Chapter'].trim()) ? r['Chapter'].trim() : cfg.chapter).normalize('NFC'),
    topic: (r._topics && r._topics.length)
      ? r._topics.map((s) => String(s || '').normalize('NFC').trim()).filter(Boolean).join('; ')
      : String(r['Topic(s)'] || '').normalize('NFC'),
    title: r['Question Title'] || '',
    option_a: ensureOptionPrefix('A', r['Option A']),
    option_b: ensureOptionPrefix('B', r['Option B']),
    option_c: ensureOptionPrefix('C', r['Option C']),
    option_d: ensureOptionPrefix('D', r['Option D']),
    correct_option: r['Correct Option'] || '',
    solution: r['Solution'] || '',
    difficulty_level: r['Difficulty Level'] || cfg.difficulty_level,
    has_math_equation: r['Has Math Equation'] === 'Yes' ? 'true' : 'false',
    allocated_time: cfg.allocated_time,
    allocated_marks: cfg.allocated_marks,
    question_source_category: cfg.question_source_category,
    question_type: cfg.question_type,
    is_active: cfg.is_active,
    markdown_version: cfg.markdown_version,
    description: cfg.description,
  }), [cfg]);

  const saveAsTraining = () => {
    const reviewed = rows.map((r) => GEN_FIELDS.reduce((o, k) => ((o[k] = r[k] ?? ''), o), {}));
    setCorrections((c) => [...c, ...reviewed]);
    alert(`${reviewed.length} reviewed rows saved to "${subject}" as training/reference data.`);
  };
  const clearTraining = () => { if (confirm('Clear saved corrections for this subject?')) setCorrections([]); };

  const exportCSV = () => {
    const full = rows.map(buildAutoRow);
    const csv = [
      AUTO_INPUT_COLUMNS.join(','),
      ...full.map((r) => AUTO_INPUT_COLUMNS.map((c) => csvEscape(r[c])).join(',')),
    ].join('\n');
    downloadBlob('cms_auto_input.csv', '﻿' + csv, 'text/csv;charset=utf-8;');
  };
  const exportXLSX = () => {
    const full = rows.map(buildAutoRow);
    const ws = XLSX.utils.json_to_sheet(full, { header: AUTO_INPUT_COLUMNS });
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, 'CMS_Auto_Input');
    XLSX.writeFile(wb, 'cms_auto_input.xlsx');
  };

  const dupCount = rows.filter((r) => r._duplicate === 'Yes').length;

  return (
    <div>
      <header className="appbar">
        <div className="brandplate"><img src="/shikho-logo.png" alt="Shikho" /></div>
        <div>
          <h1>CMS Question Formatter</h1>
          <p>Pre-trained on the CMS corpus. Pick a subject → upload the DOCX → review → export. No reference file needed.</p>
        </div>
      </header>

      <section className="card">
        <h2>1 · Subject</h2>
        <div className="subjectbar">
          <label className="inline">Working subject
            <select value={subject} onChange={(e) => loadSubject(e.target.value)}>
              {subjects.map((s) => <option key={s} value={s}>{s}</option>)}
            </select>
          </label>
          <button onClick={createSubject}>+ New subject</button>
          <button className="danger" onClick={removeSubject} disabled={!subject}>Reset subject</button>
          <span className="pill">Saved corrections: {corrections.length}</span>
          <button className="danger" onClick={clearTraining} disabled={!corrections.length}>Clear</button>
        </div>
        <p className="sub">
          Trained on <b>{knowledge.meta.questions.toLocaleString()}</b> CMS questions ({KNOWN_SUBJECTS.length || 1} subject{KNOWN_SUBJECTS.length === 1 ? '' : 's'}).
          Conventions in use: arrow <code>{knowledge.conventions.arrow}</code>, frac <code>{knowledge.conventions.frac}</code>, ≤ <code>{knowledge.conventions.leq}</code>.
          <label className="inline"><input type="checkbox" checked={style.unwrapNumbers}
            onChange={(e) => reformatStyle(e.target.checked)} /> Unwrap pure-number math (<code>$0$</code> → <code>0</code>)</label>
        </p>
      </section>

      <section className="card">
        <h2>2 · Auto-Input defaults (dummy values for the CMS upload file)</h2>
        <p className="sub">Class → Subject → Chapter are picked from the live CMS taxonomy ({taxonomy.source}, {TAX_ENUMS_PRESENT.join('/') || 'none'}) so the upload file matches CMS exactly. <b>Topic is read per-question from the uploaded doc</b> and matched to the taxonomy in the preview table (step 4) — confirm or repick per row. The rest fill every column except the converted question/options/solution. <code>difficulty_level</code> here is only a fallback; the value parsed from each question wins.</p>
        <div className="grid">
          {CLASS_OPTIONS.length
            ? <TaxonomyPicker cfg={cfg} setCfg={setCfg} warnings={docWarnings} />
            : TAXONOMY_FIELDS.map((k) => (
                <label key={k}>{k}<input value={cfg[k] || ''} onChange={(e) => setCfg({ ...cfg, [k]: e.target.value })} /></label>
              ))}
          {META_TEXT_FIELDS.map((k) => (
            <label key={k}>{k}<input value={cfg[k] || ''} onChange={(e) => setCfg({ ...cfg, [k]: e.target.value })} /></label>
          ))}
        </div>
      </section>

      <section className="card">
        <h2>3 · Raw input</h2>
        <input type="file" accept=".docx" onChange={(e) => e.target.files[0] && loadDocx(e.target.files[0])} />
        <textarea placeholder="…or paste raw questions here. Math from a .docx is auto-converted to $LaTeX$ on upload."
          value={raw} onChange={(e) => setRaw(e.target.value)} />
        <button className="primary" onClick={format} disabled={!raw.trim()}>Format questions</button>
        {busy && <span className="pill">{busy}</span>}
      </section>

      <section className="card">
        <h2>4 · Preview, edit &amp; export <span className="pill">{rows.length} questions</span>
          {dupCount > 0 && <span className="pill warn">{dupCount} possible duplicate(s)</span>}
        </h2>
        {docWarnings.length > 0 && (
          <div className="docwarnings">
            {docWarnings.map((w, i) => (
              <div key={i} className={'docwarn docwarn-' + w.level}>
                <span className="docwarn-icon">{w.level === 'error' ? '⚠' : w.level === 'warn' ? '!' : 'i'}</span>
                {w.msg}
              </div>
            ))}
          </div>
        )}
        <div className="actions">
          <button onClick={saveAsTraining} disabled={!rows.length}>Save corrections as training</button>
          <button onClick={exportCSV} disabled={!rows.length}>Download CSV</button>
          <button onClick={exportXLSX} disabled={!rows.length}>Download XLSX</button>
          <label className="inline"><input type="checkbox" checked={showMath} onChange={(e) => setShowMath(e.target.checked)} /> Show math preview</label>
        </div>
        <div className="tablewrap">
          <table>
            <thead>
              <tr><th>#</th>{PREVIEW_COLS.map((c) => <th key={c}>{c}</th>)}<th>Closest saved fix</th></tr>
            </thead>
            <tbody>
              {rows.map((r, i) => {
                // Scope topic list to the row's chapter if it's confirmed in taxonomy,
                // otherwise fall back to all subject topics so the user can still search.
                const rowChapter = r['Chapter'] || cfg.chapter;
                const chapterConfirmed = subjectTaxChapters.some((c) => c.name === rowChapter);
                const rowTopics = chapterConfirmed
                  ? taxTopics(cfg.class, cfg.group, cfg.subject, rowChapter)
                  : subjectTaxTopics;
                return (
                  <tr key={i} className={r._duplicate === 'Yes' ? 'dup' : ''}>
                    <td className="rownum">{i + 1}</td>
                    {PREVIEW_COLS.map((c) => (
                      <td key={c}>
                        {c === 'Chapter' ? (
                          <ChapterCell
                            row={r}
                            taxChapterList={subjectTaxChapters}
                            onChange={(v) => onChapterChange(i, r, v)}
                          />
                        ) : c === 'Topic(s)' ? (
                          <TopicCell row={r} taxTopics={rowTopics} onChange={(arr) => setTopics(i, arr)} />
                        ) : (
                          <>
                            <textarea value={r[c] || ''} onChange={(e) => updateCell(i, c, e.target.value)} />
                            {showMath && MATH_FIELDS.includes(c) && r[c] && <MathText value={r[c]} />}
                          </>
                        )}
                      </td>
                    ))}
                    <td className="matchcell">
                      <div className="score">{r._matchScore ? `score ${r._matchScore} (${r._matchSource})` : 'no match'}</div>
                      {r._matchTitle && <div className="mtitle">{r._matchTitle}</div>}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </section>

      <section className="note">
        <b>How it works:</b> The app is pre-trained offline on the full CMS corpus — it applies CMS's own LaTeX conventions (learned from {knowledge.meta.questions.toLocaleString()} questions) to every conversion, with no reference upload.
        Word equations (OMML) are extracted and converted to CMS-style <code>$LaTeX$</code> — not dropped like a plain-text reader. Always eyeball the math preview before uploading.
        Re-training on a new corpus: <code>node tools/train.mjs "&lt;file&gt;.csv"</code>.
      </section>
    </div>
  );
}

createRoot(document.getElementById('root')).render(<App />);
