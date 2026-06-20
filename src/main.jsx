import React, { useMemo, useState, useCallback, useEffect, useRef } from 'react';
import { createRoot } from 'react-dom/client';
import * as XLSX from 'xlsx';
import Papa from 'papaparse';
import katex from 'katex';
import 'katex/dist/katex.min.css';
import './style.css';

import { docxToContent, IMG_PLACEHOLDER_PREFIX } from './docx.js';
import { applyConventions } from './omml.js';
import { isUploadConfigured, uploadImages } from './upload.js';
import { parseRaw, bnToEn } from './parse.js';
import { toCmsRow, buildCorpus, attachNearest, MATH_FIELDS } from './style.js';
import { getDataset, putDataset, getSession, putSession, clearSession } from './db.js';
import { ENVS, login as cmsLogin, getToken as cmsGetToken, getEmail as cmsGetEmail, clearToken as cmsClearToken, validateRows, createFromResolved, validateRow, AuthError, fetchPrograms, fetchPhases, fetchProgramChapters, fetchSubjectChapters, fetchTopicsForChapter, fetchLiveExamSessions, fetchModelTest, fetchMcqExam, fetchSubjects } from './cms.js';
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

// Many taxonomy names carry stray leading/trailing/inner whitespace (388 of the
// chapter names alone). Compare them whitespace-insensitively everywhere so a
// name picked from a dropdown always equals the same name used in the blocker
// check — otherwise a valid pick shows a green ✓ yet is flagged "not a CMS
// chapter". The CMS upload resolver already normalizes the same way.
const cleanName = (s) => String(s ?? '').replace(/\s+/g, ' ').trim();

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
  const s = taxSubjects(classLabel, group).find((x) => cleanName(x.name) === cleanName(subjectName));
  return s ? s.chapters : [];
}
function taxTopics(classLabel, group, subjectName, chapterName) {
  const c = taxChapters(classLabel, group, subjectName).find((x) => cleanName(x.name) === cleanName(chapterName));
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

// Fraction of doc topics that resolve against a candidate topic list.
function topicMatchRate(docTopics, taxTopics) {
  if (!taxTopics.length || !docTopics.length) return 0;
  const hits = docTopics.filter((dt) => {
    const s = matchTopic(dt, taxTopics).status;
    return s === 'matched' || s === 'suggested';
  }).length;
  return hits / docTopics.length;
}

// Compute mismatch warnings comparing doc metadata + parsed rows against cfg dropdowns.
function computeMismatches(docMeta, built, cfg, allTaxTopics, liveMode) {
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

  // Topic match rate: if the doc's topics barely match the selected subject, flag
  // it — and, offline, scan sibling subjects to recommend a better fit (one-click
  // switch in the warnings banner).
  if (built.length > 0) {
    const docTopics = built.flatMap(r => r._docTopics || []).filter(t => t && t.name);
    if (docTopics.length > 0) {
      const selRate = cfg.subject ? topicMatchRate(docTopics, allTaxTopics) : 0;
      // Best-matching sibling subject (offline taxonomy only, needs a few topics).
      let best = null, bestRate = 0;
      if (!liveMode && cfg.class && docTopics.length >= 3) {
        for (const s of taxSubjects(cfg.class, cfg.group)) {
          const r = topicMatchRate(docTopics, taxAllTopics(cfg.class, cfg.group, s.name));
          if (r > bestRate) { bestRate = r; best = s.name; }
        }
      }
      if (best && best !== cfg.subject && bestRate >= 0.5 && bestRate - selRate >= 0.25) {
        warnings.push({
          level: 'warn', field: 'subject', suggestSubject: best,
          msg: `These topics match "${best}" (${Math.round(bestRate * 100)}%)${cfg.subject ? ` — not the selected "${cfg.subject}" (${Math.round(selRate * 100)}%)` : ''}.`,
        });
      } else if (cfg.subject && allTaxTopics.length > 0 && selRate < 0.35) {
        warnings.push({
          level: 'warn', field: 'subject',
          msg: `Only ${Math.round(selRate * 100)}% of doc topics matched "${cfg.subject}" — verify the subject is correct.`,
        });
      }
    }
  }

  return warnings;
}

// Normalize a chapter number for comparison: Bengali→ASCII digits, trimmed, and
// leading zeros stripped so the doc's "8" matches the taxonomy's "08".
function normChapterNo(s) {
  return bnToEn(String(s || '')).trim().replace(/^0+(?=\d)/, '');
}

// The CMS difficulty enum (DifficultyLevelTypeEnum) — fixed, no API to fetch.
const DIFFICULTY_OPTIONS = ['Easy', 'Medium', 'Hard'];

// Compare two taxonomy "no" strings as section numbers so dropdowns sort
// naturally: "2" < "8" < "08" wait → "8.4" < "8.10" < "9" < "10". Each dot
// segment is compared numerically; a missing segment sorts first ("8" < "8.1"),
// a non-numeric segment sorts last.
function compareNo(aNo, bNo) {
  const parts = (s) => bnToEn(String(s ?? '')).trim().split('.').map((x) => {
    const n = parseInt(x, 10); return Number.isNaN(n) ? Infinity : n;
  });
  const A = parts(aNo), B = parts(bNo);
  for (let i = 0, len = Math.max(A.length, B.length); i < len; i++) {
    const a = i < A.length ? A[i] : -1;
    const b = i < B.length ? B[i] : -1;
    if (a !== b) return a - b;
  }
  return 0;
}
// Return a copy of a {no,name}[] list sorted by section number.
const sortByNo = (list) => [...(list || [])].sort((a, b) => compareNo(a.no, b.no));

// Resolve a raw chapter number (Bengali or ASCII) to the taxonomy chapter object.
function taxChapterByNo(classLabel, group, subjectName, rawNo) {
  if (!rawNo && rawNo !== 0) return null;
  const n = normChapterNo(rawNo);
  if (!n) return null;
  return taxChapters(classLabel, group, subjectName).find((c) => normChapterNo(c.no) === n) || null;
}

// Best-effort chapter suggestion from a list of taxonomy chapters, using the
// signals available on a parsed row (strongest first):
//   1. the section number of any doc topic ("8.4" → chapter "8")
//   2. the doc's own chapter number ("8")
// Returns { name, reason } for a one-click apply, or null when nothing matches.
function suggestChapterFor(row, chapterList) {
  if (!chapterList || !chapterList.length) return null;
  const byNo = (no) => chapterList.find((c) => normChapterNo(c.no) === normChapterNo(no));
  for (const dt of (row._docTopics || [])) {
    const prefix = String(dt && dt.no || '').split('.')[0];
    if (prefix) { const ch = byNo(prefix); if (ch) return { name: ch.name, reason: `topic ${dt.no}` }; }
  }
  if (row._docChapter) { const ch = byNo(row._docChapter); if (ch) return { name: ch.name, reason: `doc chapter ${row._docChapter}` }; }
  return null;
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
  // Global topic override: drawn from the chosen chapter when set, otherwise the
  // whole subject. Empty = keep the per-question topics read from the doc.
  const topicPool = cfg.subject
    ? (cfg.chapter
        ? taxTopics(cfg.class, cfg.group, cfg.subject, cfg.chapter)
        : taxAllTopics(cfg.class, cfg.group, cfg.subject))
    : [];
  const topicOpts = [
    { value: '', label: '— per-question (from doc) —' },
    ...sortByNo(topicPool).map((t) => ({ value: t.name, label: (t.no ? t.no + ' ' : '') + t.name })),
  ];
  const subjectOpts = [...subjects]
    .sort((a, b) => a.name.localeCompare(b.name))
    .map((s) => ({ value: s.name, label: s.name.trim() + (s.name_bn ? '  ·  ' + s.name_bn : '') }));
  const chapterOpts = sortByNo(chapters).map((c) => ({ value: c.name, label: (c.no ? c.no + '. ' : '') + c.name }));
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
        <SearchableSelect
          value={cfg.subject || ''}
          options={subjectOpts}
          onChange={(val) => setCfg({ ...cfg, subject: val, chapter: '', topic: '' })}
          placeholder="Select subject…"
        />
      </label>
      <label>chapter {flag('chapter')}
        {cfg.subject
          ? <SearchableSelect
              value={cfg.chapter || ''}
              options={chapterOpts}
              onChange={(val) => setCfg({ ...cfg, chapter: val, topic: '' })}
              placeholder="Select chapter…"
            />
          : <select disabled><option>Select subject first…</option></select>}
      </label>
      <label>topic <span style={{ color: 'var(--ink-400)', fontWeight: 400 }} title="Optional. Set this only when every question shares one topic — it overrides the per-question topics read from the doc.">(all questions)</span>
        {cfg.subject
          ? <SearchableSelect
              value={cfg.topic || ''}
              options={topicOpts}
              onChange={(val) => setCfg({ ...cfg, topic: val })}
              placeholder="— per-question (from doc) —"
            />
          : <select disabled><option>Select subject first…</option></select>}
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
  // A valid value is one that exists in the dropdown (whitespace-insensitive) —
  // anything else (e.g. a raw "8" from an old parse) is treated as unset so it
  // can't be exported.
  const inTax = taxChapterList.length > 0 && !!val.trim() && taxChapterList.some((c) => cleanName(c.name) === cleanName(val));
  const isStray = !!val.trim() && taxChapterList.length > 0 && !inTax; // free text not in the dropdown
  const badge = inTax ? 'ok' : 'doc';
  // When there's no valid value, offer the strongest guess (from topic / doc chapter).
  const suggestion = inTax ? null : suggestChapterFor(row, taxChapterList);
  const tipText = inTax
    ? 'Exact chapter match ✓'
    : taxChapterList.length === 0
    ? 'No offline taxonomy loaded — re-checked against the live CMS on Validate'
    : 'No valid chapter selected — pick one from the list';
  return (
    <div className="chaptercell">
      <div className="topicrow">
        <span className={'tbadge ' + badge} title={tipText}>
          {badge === 'ok' ? '✓' : '✎'}
        </span>
        <SearchableSelect
          value={inTax ? val : ''}
          placeholder="— select chapter —"
          options={sortByNo(taxChapterList).map((c) => ({ value: c.name, label: (c.no ? c.no + ' ' : '') + c.name }))}
          onChange={onChange}
        />
      </div>
      {!inTax && suggestion && (
        <div className="chaptersuggest">
          <span>Suggested ({suggestion.reason}):</span>
          <button type="button" className="suggestbtn" onClick={() => onChange(suggestion.name)}>
            {suggestion.name}
          </button>
        </div>
      )}
      {!inTax && (
        <div className="thint thint-err">
          ⛔ {isStray ? `"${val}" isn't a CMS chapter` : 'No chapter'} — pick from the list{suggestion ? ' or apply the suggestion' : ''} (export blocked)
        </div>
      )}
      {taxChapterList.length === 0 && val && (
        <div className="thint">ⓘ No offline taxonomy for this subject — log in & use live taxonomy to pick</div>
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
      ? 'Not in the offline snapshot — Validate re-checks it against the live CMS. If it is genuinely missing there, validation will fail; otherwise search and pick the canonical name.'
      : 'No offline taxonomy loaded — verify the name matches the CMS exactly';
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
              options={sortByNo(taxTopics).map((t) => ({ value: t.name, label: (t.no ? t.no + ' ' : '') + t.name }))}
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


// Pull the document id out of a Google Doc share link (…/document/d/<ID>/…),
// an open/export URL (?id=<ID>), or accept a bare id. Returns '' if none found.
function extractGoogleDocId(s) {
  const str = String(s || '').trim();
  const m = str.match(/\/d\/([a-zA-Z0-9_-]{20,})/) || str.match(/[?&]id=([a-zA-Z0-9_-]{20,})/);
  if (m) return m[1];
  return /^[a-zA-Z0-9_-]{20,}$/.test(str) ? str : '';
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

// Maps CMS class enum (C9, C10…) to human-readable label for display in QB filter hints.
function classEnumLabel(e) { return e.replace(/^C(\d+)$/, 'Class $1'); }

// Short human "x ago" for the restore banner's saved-at timestamp.
function timeAgo(iso) {
  const t = Date.parse(iso || '');
  if (!t) return '';
  const s = Math.max(0, Math.round((Date.now() - t) / 1000));
  if (s < 60) return 'just now';
  const m = Math.round(s / 60); if (m < 60) return `${m} min ago`;
  const h = Math.round(m / 60); if (h < 24) return `${h} hr ago`;
  const d = Math.round(h / 24); return `${d} day${d === 1 ? '' : 's'} ago`;
}

// Strip a leading option label (Latin/Bengali, "A." or "A)") for clean display —
// the full preview shows the letter in its own badge, so a kept prefix would double up.
const stripOptPrefix = (v) => String(v || '').replace(/^\s*[A-Eক-ঙ]\s*[.)]\s*/, '').trim();

// ---- Full CMS Preview overlay ----
// A reading view of every question rendered exactly as the CMS would show it
// (math typeset, correct option highlighted, solution collapsible) so the whole
// set can be proofed at a glance, away from the editable table grid.
function FullPreview({ rows, onClose }) {
  useEffect(() => {
    const onKey = (e) => { if (e.key === 'Escape') onClose(); };
    document.addEventListener('keydown', onKey);
    const prev = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => { document.removeEventListener('keydown', onKey); document.body.style.overflow = prev; };
  }, [onClose]);

  const OPTIONS = [['A', 'Option A'], ['B', 'Option B'], ['C', 'Option C'], ['D', 'Option D']];
  const included = rows.filter((r) => r._include !== false);

  return (
    <div className="cmsmodal-backdrop" onClick={onClose}>
      <div className="cmsmodal" onClick={(e) => e.stopPropagation()}>
        <div className="cmsmodal-head">
          <h2>Full CMS Preview <span className="pill">{included.length} questions</span></h2>
          <button type="button" className="cmsmodal-close" title="Close (Esc)" onClick={onClose}>×</button>
        </div>
        <div className="cmsmodal-body">
          {rows.map((r, i) => {
            const excluded = r._include === false;
            if (excluded) return null;
            const correct = String(r['Correct Option'] || '').trim().toUpperCase();
            const topic = (r._topics && r._topics.filter(Boolean).join('; ')) || r['Topic(s)'] || '';
            return (
              <article key={i} className="qpreview">
                <div className="qpreview-head">
                  <span className="qnum">{i + 1}</span>
                  <div className="qmetabar">
                    {r['Chapter'] && <span className="qmeta">{r['Chapter']}</span>}
                    {topic && <span className="qmeta">{topic}</span>}
                    {r['Difficulty Level'] && <span className="qmeta diff">{r['Difficulty Level']}</span>}
                  </div>
                </div>
                <div className="qtitle"><MathText value={r['Question Title']} /></div>
                <div className="qoptions">
                  {OPTIONS.map(([letter, field]) => (
                    String(r[field] || '').trim() ? (
                      <div key={letter} className={'qopt' + (correct === letter ? ' correct' : '')}>
                        <span className="qopt-letter">{letter}</span>
                        <div className="qopt-body"><MathText value={stripOptPrefix(r[field])} /></div>
                        {correct === letter && <span className="qopt-tick" title="Correct answer">✓</span>}
                      </div>
                    ) : null
                  ))}
                </div>
                {String(r['Solution'] || '').trim() && (
                  <details className="qsolution" open>
                    <summary>Solution</summary>
                    <div className="qsolution-body"><MathText value={r['Solution']} /></div>
                  </details>
                )}
              </article>
            );
          })}
          {included.length === 0 && <p className="sub">No included questions to preview.</p>}
        </div>
      </div>
    </div>
  );
}

// Fields shown in the per-question editor, mirroring the CMS "Add New Question"
// form (each with its own side-by-side live LaTeX preview).
const EDITOR_FIELDS = [
  { key: 'Question Title', label: 'Question Title', math: true },
  { key: 'Option A', label: 'Option A', math: true },
  { key: 'Option B', label: 'Option B', math: true },
  { key: 'Option C', label: 'Option C', math: true },
  { key: 'Option D', label: 'Option D', math: true },
  { key: 'Correct Option', label: 'Correct Option (A/B/C/D)', math: false },
  { key: 'Solution', label: 'Solution', math: true },
];

// ---- CMS-style per-question editor ----
// Reproduces the CMS question-bank layout: an editable box on the left with a
// live "Latex Preview" panel on the right for every field, rendered with the same
// KaTeX engine (pre-trained on the CMS conventions) so the typeset output matches
// exactly what the CMS will show. Edits write straight back to the row.
function QuestionEditor({ row, index, onChange, onClose }) {
  useEffect(() => {
    const onKey = (e) => { if (e.key === 'Escape') onClose(); };
    document.addEventListener('keydown', onKey);
    const prev = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => { document.removeEventListener('keydown', onKey); document.body.style.overflow = prev; };
  }, [onClose]);

  return (
    <div className="cmsmodal-backdrop" onClick={onClose}>
      <div className="cmsmodal cmsmodal-wide" onClick={(e) => e.stopPropagation()}>
        <div className="cmsmodal-head">
          <h2>Edit Question {index + 1} <span className="pill">live LaTeX preview</span></h2>
          <button type="button" className="cmsmodal-close" title="Close (Esc)" onClick={onClose}>×</button>
        </div>
        <div className="cmsmodal-body">
          {EDITOR_FIELDS.map((f) => (
            <div className="fieldedit" key={f.key}>
              <div className="fieldedit-label">{f.label}</div>
              <div className="fieldedit-cols">
                <textarea
                  className="fieldedit-input"
                  value={row[f.key] || ''}
                  onChange={(e) => onChange(f.key, e.target.value)}
                  placeholder="Type here…"
                />
                <div className="fieldedit-preview">
                  <div className="fieldedit-preview-tag">Latex Preview</div>
                  {f.math
                    ? (String(row[f.key] || '').trim()
                        ? <MathText value={row[f.key]} />
                        : <span className="fieldedit-empty">— nothing to preview —</span>)
                    : <span className="fieldedit-plain">{row[f.key] || <span className="fieldedit-empty">—</span>}</span>}
                </div>
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

// Class → Group → Subject → Chapter picker (no program needed).
// Used in the override section and the Live Exam destination for dev/prod taxonomy.
const CLASS_PICK_OPTS = [
  { label: 'Class 5',           sc: 'C5',  enums: ['C5'],         grp: false },
  { label: 'Class 6',           sc: 'C6',  enums: ['C6'],         grp: false },
  { label: 'Class 7',           sc: 'C7',  enums: ['C7'],         grp: false },
  { label: 'Class 8',           sc: 'C8',  enums: ['C8'],         grp: false },
  { label: 'SSC (Class 9–10)',  sc: 'SSC', enums: ['C9', 'C10'],  grp: true  },
  { label: 'HSC (Class 11–12)', sc: 'HSC', enums: ['C11', 'C12'], grp: true  },
];
const QB_GROUP_OPTS = ['Science', 'Humanities', 'Business Studies'];

function ClassChapterPicker({ env, token, onSelect, onClear, showTopic = true, initialValues = null, onClearInitial = null }) {
  const [selClass, setSelClass] = useState(null);
  const [selGroup, setSelGroup] = useState('');
  const [subjects, setSubjects] = useState([]);
  const [selSubject, setSelSubject] = useState(null);
  const [chapters, setChapters] = useState([]);
  const [selChapter, setSelChapter] = useState(null);
  const [topics, setTopics] = useState([]);
  const [selTopic, setSelTopic] = useState(null);
  const [busy, setBusy] = useState('');
  const [err, setErr] = useState('');
  const [lockedToInitial, setLockedToInitial] = useState(false);

  useEffect(() => {
    if (!initialValues) { setLockedToInitial(false); return; }
    setLockedToInitial(true);
    if (initialValues.classLabel) setSelClass(initialValues.classLabel);
    if (initialValues.groupLabel) setSelGroup(initialValues.groupLabel);
    const mockSubj = { code: initialValues.subjectCode, display: initialValues.subjectName, display_bn: initialValues.subjectName };
    const mockCh = { chapter_id: initialValues.chapterId, chapter_name: initialValues.chapterName };
    setSubjects([mockSubj]);
    setSelSubject(mockSubj);
    setChapters([mockCh]);
    setSelChapter(mockCh);
    setTopics([]); setSelTopic(null); setBusy(''); setErr('');
  }, [initialValues]);

  const unlockAndBrowse = () => {
    setLockedToInitial(false);
    setSelClass(null); setSelGroup(''); setSubjects([]);
    setSelSubject(null); setChapters([]); setSelChapter(null);
    setTopics([]); setSelTopic(null);
    onClear();
    if (onClearInitial) onClearInitial();
  };

  const classOpt = CLASS_PICK_OPTS.find((o) => o.label === selClass);

  const buildSel = (ch, subj, opt, topicList, topic) => ({
    subjectCode: subj.code,
    subjectName: subj.display,
    chapterId: ch.chapter_id,
    chapterName: ch.chapter_name,
    classEnums: opt.enums,
    defaultTopicId: topic ? topic.id : null,
    defaultTopicName: topic ? topic.name : '',
    topics: topicList.map((t) => ({ no: String(t.no || ''), name: t.name })),
    chapters: chapters,
  });

  const loadSubjects = async (opt, group) => {
    setBusy('Loading subjects…'); setErr('');
    try {
      const list = await fetchSubjects(env, opt.sc, group || undefined);
      setSubjects(list.sort((a, b) => a.display.localeCompare(b.display)));
    } catch (e) { setErr(e.message); }
    setBusy('');
  };

  const pickClass = async (label) => {
    setLockedToInitial(false);
    setSelClass(label); setSelGroup(''); setSubjects([]);
    setSelSubject(null); setChapters([]); setSelChapter(null);
    setTopics([]); setSelTopic(null); onClear();
    const opt = CLASS_PICK_OPTS.find((o) => o.label === label);
    if (!opt || opt.grp) return;
    await loadSubjects(opt, '');
  };

  const pickGroup = async (group) => {
    setSelGroup(group); setSubjects([]);
    setSelSubject(null); setChapters([]); setSelChapter(null);
    setTopics([]); setSelTopic(null); onClear();
    if (!classOpt) return;
    await loadSubjects(classOpt, group);
  };

  const pickSubject = async (code) => {
    const subj = subjects.find((s) => s.code === code) || null;
    setSelSubject(subj); setChapters([]); setSelChapter(null);
    setTopics([]); setSelTopic(null); onClear();
    if (!subj) return;
    setBusy('Loading chapters…'); setErr('');
    try {
      const list = await fetchSubjectChapters(env, code);
      setChapters(list);
    } catch (e) { setErr(e.message); }
    setBusy('');
  };

  const pickChapter = async (chapterId) => {
    const ch = chapters.find((c) => c.chapter_id === chapterId) || null;
    setSelChapter(ch); setTopics([]); setSelTopic(null); onClear();
    if (!ch || !selSubject || !classOpt) return;
    setBusy('Loading topics…'); setErr('');
    try {
      const topicList = await fetchTopicsForChapter(env, chapterId);
      setTopics(topicList);
      onSelect(buildSel(ch, selSubject, classOpt, topicList, null));
    } catch (e) { setErr(e.message); }
    setBusy('');
  };

  const pickTopic = (topicId) => {
    const t = topics.find((tp) => tp.id === topicId) || null;
    setSelTopic(t);
    if (selChapter && selSubject && classOpt) {
      onSelect(buildSel(selChapter, selSubject, classOpt, topics, t));
    }
  };

  return (
    <div className="grid">
      {lockedToInitial && initialValues && (
        <div style={{ gridColumn: '1 / -1', padding: '6px 10px', background: '#e8f5e9', border: '1px solid #2d7d46', borderRadius: 5, fontSize: '0.85em', display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 8 }}>
          <span>✓ Matched from session: <b>{initialValues.subjectName} · {initialValues.chapterName}</b></span>
          <button type="button" onClick={unlockAndBrowse} style={{ flexShrink: 0 }}>Edit manually</button>
        </div>
      )}
      <label>Class
        <select value={selClass || ''} onChange={(e) => pickClass(e.target.value)}>
          <option value="">— pick class —</option>
          {CLASS_PICK_OPTS.map((o) => <option key={o.label} value={o.label}>{o.label}</option>)}
        </select>
      </label>
      {classOpt && classOpt.grp && (
        <label>Group
          <select value={selGroup} onChange={(e) => pickGroup(e.target.value)}>
            <option value="">— pick group —</option>
            {QB_GROUP_OPTS.map((g) => <option key={g} value={g}>{g}</option>)}
          </select>
        </label>
      )}
      {subjects.length > 0 && (
        <label>Subject
          <select value={selSubject ? selSubject.code : ''} onChange={(e) => pickSubject(e.target.value)}>
            <option value="">— pick subject —</option>
            {subjects.map((s) => <option key={s.code} value={s.code}>{s.display}{s.display_bn ? ' · ' + s.display_bn : ''}</option>)}
          </select>
        </label>
      )}
      {chapters.length > 0 && (
        <label>Chapter
          <select value={selChapter ? selChapter.chapter_id : ''} onChange={(e) => pickChapter(e.target.value)}>
            <option value="">— pick chapter —</option>
            {chapters.map((c) => <option key={c.chapter_id} value={c.chapter_id}>{c.chapter_no ? c.chapter_no + '. ' : ''}{c.chapter_name}</option>)}
          </select>
        </label>
      )}
      {showTopic && topics.length > 0 && (
        <label>Default topic <span style={{ fontWeight: 400, fontSize: '0.82em', color: 'var(--ink-400)' }}>(optional)</span>
          <select value={selTopic ? selTopic.id : ''} onChange={(e) => pickTopic(e.target.value)}>
            <option value="">— none (per-question matching) —</option>
            {topics.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
          </select>
        </label>
      )}
      {busy && <span className="pill" style={{ gridColumn: '1 / -1' }}>{busy}</span>}
      {err && <div className="docwarn docwarn-error" style={{ gridColumn: '1 / -1', marginTop: 4 }}>⚠ {err}</div>}
    </div>
  );
}

// ---- Live CMS taxonomy picker (Program → Phase → Subject → Chapter) ----
// Used in section 1 when the user is logged in and wants program-scoped chapters.
function LiveTaxonomyPicker({ env, token, onSelect, onClear }) {
  const [programs, setPrograms] = useState([]);
  const [selProg, setSelProg] = useState(null);
  const [phases, setPhases] = useState([]);
  const [selPhase, setSelPhase] = useState(null);
  const [selSubject, setSelSubject] = useState(null);
  const [chapters, setChapters] = useState([]);
  const [selChapter, setSelChapter] = useState(null);
  const [topics, setTopics] = useState([]);
  const [selTopic, setSelTopic] = useState(null);
  const [busy, setBusy] = useState('');
  const [err, setErr] = useState('');

  // Fetch all programs once when component mounts / env changes
  useEffect(() => {
    if (!token) return;
    setPrograms([]); setSelProg(null); setPhases([]); setSelPhase(null);
    setSelSubject(null); setChapters([]); setSelChapter(null);
    setTopics([]); setSelTopic(null); setErr('');
    setBusy('Loading programs…');
    fetchPrograms(env).then((list) => {
      setPrograms(list.sort((a, b) => a.title.localeCompare(b.title)));
      setBusy('');
    }).catch((e) => { setErr(e.message); setBusy(''); });
  }, [env, token]);

  // Build the full onSelect payload from current state + overrides.
  const buildSel = (ch, subj, prog, phase, topicList, topic, chapterList) => ({
    programId: prog.id,
    programTitle: prog.title,
    phaseId: phase ? phase.id : null,
    phaseTitle: phase ? phase.title : '',
    subjectCode: subj.code,
    subjectName: subj.display,
    chapterId: ch.chapter_id,
    chapterName: ch.chapter_name,
    classEnums: prog.classes || [],
    defaultTopicId: topic ? topic.id : null,
    defaultTopicName: topic ? topic.name : '',
    topics: topicList.map((t) => ({ no: String(t.no || ''), name: t.name })),
    chapters: chapterList,
  });

  const pickProgram = async (id) => {
    const prog = programs.find((p) => p.id === id);
    setSelProg(prog || null); setSelPhase(null); setSelSubject(null);
    setChapters([]); setSelChapter(null); setTopics([]); setSelTopic(null); onClear();
    if (!prog) return;
    setErr('');
    setBusy('Loading phases…');
    try {
      const list = await fetchPhases(env, id);
      setPhases(list);
    } catch (e) { setErr(e.message); }
    setBusy('');
  };

  const pickPhaseOrSubject = async (phase) => {
    setSelPhase(phase); setSelSubject(null); setChapters([]); setSelChapter(null);
    setTopics([]); setSelTopic(null); onClear();
  };

  const pickSubject = async (subjectCode) => {
    const subj = (selProg && selProg.subjects || []).find((s) => s.code === subjectCode);
    setSelSubject(subj || null); setChapters([]); setSelChapter(null);
    setTopics([]); setSelTopic(null); onClear();
    if (!subj || !selProg) return;
    setErr('');
    setBusy('Loading chapters…');
    try {
      let list = await fetchProgramChapters(env, selProg.id, selPhase && selPhase.id, subjectCode);
      if (!list.length) list = await fetchSubjectChapters(env, subjectCode);
      setChapters(list);
    } catch (e) { setErr(e.message); }
    setBusy('');
  };

  const pickChapter = async (chapterId) => {
    const ch = chapters.find((c) => c.chapter_id === chapterId);
    setSelChapter(ch || null); setTopics([]); setSelTopic(null); onClear();
    if (!ch || !selProg || !selSubject) return;
    setErr('');
    setBusy('Loading topics…');
    try {
      const topicList = await fetchTopicsForChapter(env, chapterId);
      setTopics(topicList);
      onSelect(buildSel(ch, selSubject, selProg, selPhase, topicList, null, chapters));
    } catch (e) { setErr(e.message); }
    setBusy('');
  };

  const pickTopic = (topicId) => {
    const t = topics.find((t) => t.id === topicId) || null;
    setSelTopic(t);
    if (selChapter && selProg && selSubject) {
      onSelect(buildSel(selChapter, selSubject, selProg, selPhase, topics, t, chapters));
    }
  };

  const subjects = (selProg && selProg.subjects) || [];

  return (
    <div style={{ gridColumn: '1 / -1' }}>
      <div className="grid">
        <label>Program <span style={{ fontWeight: 'normal', fontSize: '0.8em', color: 'var(--ink-400)' }}>(determines QB class)</span>
          <select value={selProg ? selProg.id : ''} onChange={(e) => pickProgram(e.target.value)}>
            <option value="">— pick program —</option>
            {programs.map((p) => <option key={p.id} value={p.id}>{p.title}</option>)}
          </select>
          {selProg && selProg.classes && selProg.classes.length > 0 && (
            <span style={{ fontSize: '0.82em', color: '#1a7a3c', fontWeight: 600, marginTop: 3, display: 'block' }}>
              QB class filter: {selProg.classes.map(classEnumLabel).join(', ')}
            </span>
          )}
        </label>
        {phases.length > 0 && (
          <label>Phase
            <select value={selPhase ? selPhase.id : ''} onChange={(e) => pickPhaseOrSubject(phases.find((p) => p.id === e.target.value) || null)}>
              <option value="">— pick phase —</option>
              {phases.map((p) => <option key={p.id} value={p.id}>{p.title}</option>)}
            </select>
          </label>
        )}
        {subjects.length > 0 && (
          <label>Subject
            <select value={selSubject ? selSubject.code : ''} onChange={(e) => pickSubject(e.target.value)}>
              <option value="">— pick subject —</option>
              {subjects.map((s) => <option key={s.code} value={s.code}>{s.display}</option>)}
            </select>
          </label>
        )}
        {chapters.length > 0 && (
          <label>Chapter
            <select value={selChapter ? selChapter.chapter_id : ''} onChange={(e) => pickChapter(e.target.value)}>
              <option value="">— pick chapter —</option>
              {chapters.map((c) => <option key={c.chapter_id} value={c.chapter_id}>{c.chapter_name}</option>)}
            </select>
          </label>
        )}
        {topics.length > 0 && (
          <label>Default topic
            <span style={{ fontWeight: 'normal', fontSize: '0.82em', color: 'var(--ink-400)', marginLeft: 4 }}>
              (optional — pick a dev dummy topic; leave blank for per-question matching)
            </span>
            <select value={selTopic ? selTopic.id : ''} onChange={(e) => pickTopic(e.target.value)}>
              <option value="">— no default (per-question matching) —</option>
              {topics.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
            </select>
          </label>
        )}
      </div>
      {busy && <span className="pill">{busy}</span>}
      {err && <div className="docwarn docwarn-error" style={{ marginTop: 4 }}>⚠ {err}</div>}
    </div>
  );
}

// ---- Section 5: log in to the CMS and create questions directly ----
// Two-phase upload: Phase 1 resolves all IDs without creating anything.
// Only after ALL rows validate clean does Phase 2 create the questions.
// This guarantees that if row 16 fails, rows 1-15 are never deployed.
function CmsUploader({ env, token, onEnvChange, onTokenChange, buildCurrentRows, currentCount, liveIds, blockerRows }) {
  const [email, setEmail] = useState(() => cmsGetEmail(env));
  const [password, setPassword] = useState('');
  const [authBusy, setAuthBusy] = useState(false);
  const [authErr, setAuthErr] = useState('');
  const [log, setLog] = useState('');
  // phase: 'idle' | 'validating' | 'ready' | 'creating' | 'stopped' | 'done'
  const [phase, setPhase] = useState('idle');
  const [resolvedVars, setResolvedVars] = useState(null);
  const [stoppedAt, setStoppedAt] = useState(null);
  const [savedRows, setSavedRows] = useState(null);   // stored for CSV re-validate
  const [savedLabel, setSavedLabel] = useState('');
  const [ids, setIds] = useState([]);
  const [progress, setProgress] = useState('');
  // Destination selection
  const [uploadDest, setUploadDest] = useState('question_bank');
  // Live Exam state — chapter/subject picked independently per-destination (no dep on Section 1)
  const [liveExamIds, setLiveExamIds] = useState(null);
  const [liveExamSessions, setLiveExamSessions] = useState([]);
  const [selectedSession, setSelectedSession] = useState(null);
  const [sessionBusy, setSessionBusy] = useState(false);
  const [sessionErr, setSessionErr] = useState('');
  // Exam Builder state
  const [modelTestIdInput, setModelTestIdInput] = useState('');
  const [modelTest, setModelTest] = useState(null);
  const [selectedStageId, setSelectedStageId] = useState('');
  const [examBuilderSession, setExamBuilderSession] = useState(null);
  const [examBuilderBusy, setExamBuilderBusy] = useState(false);
  const [examBuilderErr, setExamBuilderErr] = useState('');
  // Taxonomy override: force all rows to use a specific subject/chapter/topic (useful for dev testing)
  const [showOverride, setShowOverride] = useState(false);
  const [overrideIds, setOverrideIds] = useState(null);
  // True when overrideIds was filled in one click from the selected session (vs. the manual picker).
  const [overrideFromSession, setOverrideFromSession] = useState(false);
  const fileRef = useRef(null);
  const logRef = useRef(null);
  const isProd = env === 'prod';

  // Reset destination state when destination changes
  useEffect(() => {
    setSelectedSession(null); setLiveExamSessions([]); setSessionErr('');
    setLiveExamIds(null);
    setModelTest(null); setSelectedStageId(''); setExamBuilderSession(null); setExamBuilderErr('');
    // A session-derived override no longer applies once the destination changes.
    if (overrideFromSession) { setOverrideFromSession(false); setOverrideIds(null); }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [uploadDest]);

  // Auto-fetch sessions when the Live Exam chapter picker resolves a chapter
  useEffect(() => {
    if (uploadDest !== 'live_exam' || !liveExamIds || !liveExamIds.chapterId || !token) return;
    setSessionBusy(true); setSessionErr(''); setLiveExamSessions([]); setSelectedSession(null);
    fetchLiveExamSessions(env, { chapterIds: [liveExamIds.chapterId] })
      .then((list) => setLiveExamSessions(list))
      .catch((e) => setSessionErr(e.message))
      .finally(() => setSessionBusy(false));
  }, [uploadDest, liveExamIds, env, token]);

  // Exam Builder: load model test by ID
  const loadModelTest = async () => {
    const id = modelTestIdInput.trim();
    if (!id) return;
    setExamBuilderBusy(true); setExamBuilderErr(''); setModelTest(null); setSelectedStageId(''); setExamBuilderSession(null);
    try {
      const mt = await fetchModelTest(env, id);
      if (!mt) throw new Error('Model test not found.');
      setModelTest(mt);
    } catch (e) { setExamBuilderErr(e.message); }
    setExamBuilderBusy(false);
  };

  // Exam Builder: pick an MCQ stage → fetch its MCQ session
  const pickStage = async (stageId) => {
    setSelectedStageId(stageId); setExamBuilderSession(null); setExamBuilderErr('');
    if (overrideFromSession) { setOverrideFromSession(false); setOverrideIds(null); }
    if (!stageId) return;
    setExamBuilderBusy(true);
    try {
      const session = await fetchMcqExam(env, stageId);
      if (!session) throw new Error('MCQ session not found.');
      setExamBuilderSession(session);
    } catch (e) { setExamBuilderErr(e.message); }
    setExamBuilderBusy(false);
  };

  const reset = () => {
    setPhase('idle'); setResolvedVars(null); setStoppedAt(null);
    setSavedRows(null); setSavedLabel(''); setIds([]); setProgress('');
  };

  // One-click: copy the selected session's exact subject + chapter into the taxonomy override, so
  // the user never has to hand-match the cascading dropdowns. `chapter` lets the caller pick which
  // chapter to use when the session covers several; defaults to the only/first one.
  const useSessionTaxonomy = (sess, chapter, classLabel = null, groupLabel = null) => {
    if (!sess) return;
    if (!sess.subject || !sess.subject.code) {
      alert('This session has no subject set in the CMS — nothing to copy.');
      return;
    }
    const chs = sess.chapters || [];
    const ch = chapter || chs[0] || null;
    if (!ch) {
      alert('This session has no chapter set in the CMS — nothing to copy.');
      return;
    }
    setShowOverride(true);
    setOverrideFromSession(true);
    setOverrideIds({
      subjectId: sess.subject.code,
      subjectName: sess.subject.display,
      chapterId: ch.id,
      chapterName: ch.name,
      classEnums: undefined, // fall back to each row's Step-1 class for the QB record
      classLabel: classLabel,
      groupLabel: groupLabel,
      topicId: null,
      topicName: null,
    });
  };

  const switchEnv = (e) => {
    onEnvChange(e); setEmail(cmsGetEmail(e) || ''); setPassword(''); setAuthErr(''); reset();
  };

  // Inject only the destination marker (and a taxonomy override when explicitly set) into rows.
  // The questions KEEP their own subject/chapter (from Step 1 or the override) — we never silently
  // rewrite them to the session's taxonomy, or a Bangla question could land in a Math session. The
  // match is instead verified against the session in validateRows (destination guard), which blocks
  // any row whose resolved subject/chapter doesn't belong to the chosen session.
  const injectDest = (rows) => {
    let out = rows;
    if (overrideIds) {
      out = out.map((r) => ({
        ...r,
        _subjectId: overrideIds.subjectId,
        _chapterId: overrideIds.chapterId,
        _classEnums: overrideIds.classEnums,
        ...(overrideIds.topicId ? { _topicIds: [overrideIds.topicId] } : {}),
      }));
    }
    if (uploadDest === 'live_exam' && selectedSession) {
      return out.map((r) => ({ ...r, _liveExamSessionId: selectedSession.id }));
    }
    if (uploadDest === 'exam_builder' && examBuilderSession) {
      return out.map((r) => ({ ...r, _examSessionId: examBuilderSession.id }));
    }
    return out;
  };

  const appendLog = (line) => setLog((l) => l + line + '\n');
  useEffect(() => { if (logRef.current) logRef.current.scrollTop = logRef.current.scrollHeight; }, [log]);

  const doLogin = async () => {
    setAuthBusy(true); setAuthErr('');
    try {
      await cmsLogin(env, email.trim(), password);
      onTokenChange(cmsGetToken(env));
      setPassword('');
    } catch (e) {
      setAuthErr(e.message || String(e));
    } finally {
      setAuthBusy(false);
    }
  };

  const doLogout = () => { cmsClearToken(env); onTokenChange(null); };

  // The subject/chapter the active destination session requires. Question Bank has no session,
  // so it returns null (any resolvable taxonomy is accepted). Used to guard every push so a
  // question can never be created against a session it won't link to.
  const sessionFor = () =>
    uploadDest === 'live_exam' ? selectedSession
    : uploadDest === 'exam_builder' ? examBuilderSession
    : null;
  const destExpectation = () => {
    const sess = sessionFor();
    if (!sess) return null;
    return {
      label: uploadDest === 'live_exam' ? 'Live Exam session' : 'Exam Builder MCQ session',
      subjectCode: sess.subject && sess.subject.code,
      subjectName: (sess.subject && sess.subject.display) || '',
      chapterIds: (sess.chapters || []).map((c) => c.id),
      chapterNames: (sess.chapters || []).map((c) => c.name).join(', '),
    };
  };

  // Phase 1: resolve all IDs — nothing is written to CMS.
  const runValidate = async (rows, label) => {
    const schemaErrors = rows.map((r, i) => validateRow(r, i)).filter(Boolean);
    if (schemaErrors.length) {
      setLog(schemaErrors.join('\n') + '\n');
      alert(`${schemaErrors.length} row(s) have missing/invalid fields — fix them first.`);
      return;
    }
    setSavedRows(rows); setSavedLabel(label);
    setLog(''); setIds([]); setResolvedVars(null); setStoppedAt(null);
    setPhase('validating'); setProgress('');
    appendLog(`Validating ${rows.length} row(s) against ${ENVS[env].label} CMS…\n`);
    try {
      const res = await validateRows(env, rows, {
        onLog: appendLog,
        onProgress: (done, total) => setProgress(`${done}/${total}`),
        expect: destExpectation(),
      });
      setProgress('');
      if (res.ok) {
        setResolvedVars(res.resolved);
        setPhase('ready');
        appendLog(`\n✅ All ${rows.length} row(s) passed — no questions created yet.\nClick "Create questions" to push to ${ENVS[env].label}.`);
      } else {
        setPhase('idle');
        appendLog(`\n❌ Validation failed at row ${res.failedAt + 2}. Fix it and re-validate. Nothing was created.`);
      }
    } catch (e) {
      setProgress('');
      if (e instanceof AuthError) { onTokenChange(null); alert('Session expired — please log in again.'); }
      else appendLog(`\nValidation error: ${e.message || e}`);
      setPhase('idle');
    }
  };

  // Phase 2: create questions from pre-validated vars.
  const runCreate = async (vars, { startFrom = 0 } = {}) => {
    if (startFrom === 0 && !confirm(`Create ${vars.length} question(s) in ${ENVS[env].label} CMS? This cannot be undone.`)) return;
    setPhase('creating'); setProgress('');
    if (startFrom === 0) setIds([]);
    const collected = startFrom > 0 ? [...ids] : [];
    try {
      const res = await createFromResolved(env, vars, {
        onLog: appendLog,
        onProgress: (done, total) => setProgress(`${done}/${total}`),
        onId: (id) => { collected.push(id); setIds([...collected]); },
        startFrom,
      });
      setProgress('');
      if (res.stoppedAt !== null) {
        setStoppedAt(res.stoppedAt); setPhase('stopped');
      } else {
        setStoppedAt(null); setResolvedVars(null); setPhase('done');
        appendLog(`\n✅ All done — ${res.success} question(s) created in ${ENVS[env].label}.`);
        alert(`Done. ${res.success} question(s) created.`);
      }
    } catch (e) {
      setProgress('');
      if (e instanceof AuthError) { onTokenChange(null); alert('Session expired — please log in again.'); }
      else appendLog(`\nFailed: ${e.message || e}`);
      setPhase('stopped');
    }
  };

  // When a taxonomy override is on, the forced subject/chapter must belong to the destination
  // session — otherwise every question would be created but never link. Returns a friendly
  // message naming what the session expects, or null when the override matches (or no session).
  const overrideMismatchMsg = (sess) => {
    if (!sess || !showOverride || !overrideIds) return null;
    const sCode = sess.subject && sess.subject.code;
    const sName = (sess.subject && sess.subject.display) || sCode;
    const chIds = (sess.chapters || []).map((c) => c.id);
    const chNames = (sess.chapters || []).map((c) => c.name).join(', ');
    if (sCode && overrideIds.subjectId !== sCode) {
      return `Subject mismatch — the override subject "${overrideIds.subjectName}" is not this session's subject "${sName}".\n\n`
        + `Change the override subject to "${sName}", or turn the override off to use the session's subject automatically.`;
    }
    if (chIds.length > 0 && !chIds.includes(overrideIds.chapterId)) {
      return `Chapter mismatch — the override chapter "${overrideIds.chapterName}" is not in this session.\n\n`
        + `This session covers: ${chNames}.\n\nPick one of those chapters in the override, or turn the override off.`;
    }
    return null;
  };

  const checkDestReady = () => {
    if (showOverride && !overrideIds) {
      alert('Taxonomy override is on but no chapter is selected yet — pick a chapter (and optionally a topic) in the Override taxonomy picker above.');
      return false;
    }
    if (uploadDest === 'live_exam' && !selectedSession) {
      alert('Pick a Live Exam Session first (under "Upload destination" below).');
      return false;
    }
    if (uploadDest === 'exam_builder' && !examBuilderSession) {
      alert('Select an Exam Builder MCQ session first (under "Upload destination" below).');
      return false;
    }
    if (uploadDest === 'exam_builder' && examBuilderSession && examBuilderSession.is_published) {
      alert('The selected MCQ session is Published — questions cannot be added to a published session. Un-publish it in the CMS Exam Builder first.');
      return false;
    }
    // Unified taxonomy guard for any session destination (Live Exam or Exam Builder), dev or prod.
    const mismatch = overrideMismatchMsg(sessionFor());
    if (mismatch) { alert(mismatch); return false; }
    return true;
  };

  const handleValidateCurrent = () => {
    if (blockerRows && blockerRows.length > 0) {
      alert(
        `Cannot validate — ${blockerRows.length} question(s) are missing mandatory CMS fields:\n\n` +
        blockerRows.map(({ n, issues }) => `Q${n}: missing ${issues.join(', ')}`).join('\n') +
        '\n\nFix them in step 3 (or uncheck the row to exclude it) before validating.'
      );
      return;
    }
    if (!checkDestReady()) return;
    const rows = injectDest(buildCurrentRows());
    if (!rows.length) return alert('No converted rows to validate — format a document first.');
    runValidate(rows, `current rows (${rows.length})`);
  };

  const handleValidateCsv = () => {
    if (!checkDestReady()) return;
    const file = fileRef.current && fileRef.current.files[0];
    if (!file) return alert('Pick a CSV file first.');
    Papa.parse(file, {
      header: true, skipEmptyLines: true,
      complete: (out) => {
        const rows = injectDest((out.data || []).map((r) => {
          const o = {}; Object.keys(r).forEach((k) => { o[k.trim()] = String(r[k] || '').trim(); }); return o;
        }));
        if (!rows.length) return alert('CSV has no data rows.');
        runValidate(rows, file.name);
      },
      error: (err) => alert('CSV parse error: ' + err.message),
    });
  };

  const handleRevalidate = () => {
    if (!checkDestReady()) return;
    const rows = injectDest(savedRows || buildCurrentRows());
    runValidate(rows, savedLabel || 'current rows');
  };

  const copyIds = () => {
    const text = ids.join(',');
    if (!text) return alert('No created IDs yet.');
    navigator.clipboard.writeText(text).then(() => alert('Created IDs copied!'), () => alert('Copy failed.'));
  };

  const busy = phase === 'validating' || phase === 'creating';

  return (
    <section className="card" style={isProd ? { borderColor: '#c0392b' } : undefined}>
      <h2>4 · Upload to CMS
        <span className="pill" style={{ background: isProd ? '#c0392b' : '#2d7d46', color: '#fff' }}>
          {isProd ? 'PRODUCTION' : 'DEV'}
        </span>
      </h2>
      <div className="subjectbar">
        <label className="inline">Environment
          <select value={env} onChange={(e) => switchEnv(e.target.value)}>
            <option value="dev">DEV · cms.shikho.dev</option>
            <option value="prod">PROD · cms.shikho.com</option>
          </select>
        </label>
        {token && <span className="pill">Logged in{cmsGetEmail(env) ? ` · ${cmsGetEmail(env)}` : ''}</span>}
        {token && <button className="danger" onClick={doLogout}>Log out</button>}
      </div>

      {!token ? (
        <div className="grid">
          <label>CMS email
            <input type="email" autoComplete="username" value={email} onChange={(e) => setEmail(e.target.value)} />
          </label>
          <label>CMS password
            <input type="password" autoComplete="current-password" value={password}
              onChange={(e) => setPassword(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter') doLogin(); }} />
          </label>
          <div style={{ alignSelf: 'end' }}>
            <button className="primary" onClick={doLogin} disabled={authBusy || !email || !password}>
              {authBusy ? 'Logging in…' : `Log in to ${ENVS[env].label}`}
            </button>
          </div>
          {authErr && <div className="docwarn docwarn-error" style={{ gridColumn: '1 / -1' }}>⚠ {authErr}</div>}
        </div>
      ) : (
        <>
          <p className="sub">
            <b>Two-phase upload:</b> Validate first (resolves all IDs, nothing created) → only after all rows pass, Create pushes them to CMS.
            If any row fails validation, zero questions are created — fix the issue and re-validate, then push all together.
            {isProd && <b style={{ color: '#c0392b' }}> PRODUCTION — questions go live immediately.</b>}
          </p>

          {/* Taxonomy override — for dev testing when doc uses prod chapter/topic names */}
          <div style={{ marginBottom: 10, padding: '8px 12px', background: isProd ? 'transparent' : 'var(--surface-2, #f5f5f5)', borderRadius: 6, border: isProd ? 'none' : '1px dashed #bbb' }}>
            <label className="inline" style={{ fontWeight: 600, fontSize: '0.9em' }}>
              <input type="checkbox" checked={showOverride} onChange={(e) => {
                setShowOverride(e.target.checked);
                if (!e.target.checked) { setOverrideIds(null); setOverrideFromSession(false); }
              }} />
              {' '}Override taxonomy for all questions
              <span style={{ fontWeight: 400, fontSize: '0.85em', color: 'var(--ink-400)', marginLeft: 6 }}>
                — force a single subject/chapter/topic so dev dummy taxonomy works
              </span>
            </label>
            {overrideIds && (
              <span className="pill" style={{ marginLeft: 8 }}>
                {overrideIds.classEnums && overrideIds.classEnums.length
                  ? <b style={{ color: '#1a7a3c' }}>{overrideIds.classEnums.map(classEnumLabel).join(', ')}</b>
                  : null}
                {overrideIds.classEnums && overrideIds.classEnums.length ? ' · ' : ''}
                {overrideIds.subjectName} · {overrideIds.chapterName}
                {overrideIds.topicName ? ` · ${overrideIds.topicName}` : ''}
              </span>
            )}
            {showOverride && token && (
              <div style={{ marginTop: 8 }}>
                <ClassChapterPicker env={env} token={token}
                  initialValues={overrideFromSession && overrideIds ? {
                    classLabel: overrideIds.classLabel || null,
                    groupLabel: overrideIds.groupLabel || null,
                    subjectCode: overrideIds.subjectId,
                    subjectName: overrideIds.subjectName,
                    chapterId: overrideIds.chapterId,
                    chapterName: overrideIds.chapterName,
                  } : null}
                  onClearInitial={() => setOverrideFromSession(false)}
                  onSelect={(sel) => {
                    setOverrideFromSession(false);
                    setOverrideIds({
                      subjectId: sel.subjectCode,
                      subjectName: sel.subjectName,
                      chapterId: sel.chapterId,
                      chapterName: sel.chapterName,
                      classEnums: sel.classEnums,
                      topicId: sel.defaultTopicId || null,
                      topicName: sel.defaultTopicName || null,
                    });
                  }}
                  onClear={() => { setOverrideIds(null); setOverrideFromSession(false); }}
                />
                {!overrideIds && (
                  <div style={{ fontSize: '0.82em', color: '#b07a00', marginTop: 4 }}>
                    ⚠ Select a <b>Chapter</b> (and optionally a Topic) to activate the override — validation is blocked until complete.
                    {' '}Tip: pick a destination session below and click <b>”Match override to this session”</b> to fill this automatically.
                  </div>
                )}
              </div>
            )}
            {showOverride && !token && (
              <div className="docwarn docwarn-error" style={{ margin: '6px 0 0' }}>⚠ Log in first to load taxonomy.</div>
            )}
          </div>

          {/* Destination selector */}
          <div style={{ marginBottom: 10 }}>
            <b style={{ fontSize: '0.9em' }}>Upload destination</b>
            <div style={{ display: 'flex', gap: 12, marginTop: 6, flexWrap: 'wrap', alignItems: 'flex-start' }}>
              <label className="inline">
                <input type="radio" name="uploadDest" value="question_bank" checked={uploadDest === 'question_bank'}
                  onChange={() => setUploadDest('question_bank')} />
                {' '}Question Bank
              </label>
              <label className="inline">
                <input type="radio" name="uploadDest" value="live_exam" checked={uploadDest === 'live_exam'}
                  onChange={() => setUploadDest('live_exam')} />
                {' '}Live Exam Session
              </label>
              <label className="inline">
                <input type="radio" name="uploadDest" value="exam_builder" checked={uploadDest === 'exam_builder'}
                  onChange={() => setUploadDest('exam_builder')} />
                {' '}Exam Builder MCQ Session
              </label>
            </div>

            {uploadDest === 'exam_builder' && (
              <div style={{ marginTop: 8, padding: '8px 12px', background: 'var(--surface-2, #f5f5f5)', borderRadius: 6 }}>
                <div style={{ fontSize: '0.85em', marginBottom: 6, color: 'var(--ink-400)' }}>
                  Paste the Model Test ID from the Exam Builder URL (e.g. <code>/exam-builder/<b>69b1083…</b>/</code>).
                  Questions are created in <b>Question Bank</b> and also linked to the MCQ session.
                </div>
                <div style={{ display: 'flex', gap: 8, marginBottom: 6 }}>
                  <input
                    type="text"
                    placeholder="Model Test ID (24-char hex)"
                    value={modelTestIdInput}
                    onChange={(e) => setModelTestIdInput(e.target.value)}
                    onKeyDown={(e) => { if (e.key === 'Enter') loadModelTest(); }}
                    style={{ flex: 1 }}
                  />
                  <button onClick={loadModelTest} disabled={examBuilderBusy || !modelTestIdInput.trim()}>
                    {examBuilderBusy ? 'Loading…' : 'Load'}
                  </button>
                </div>
                {examBuilderErr && <div className="docwarn docwarn-error" style={{ margin: '0 0 6px' }}>⚠ {examBuilderErr}</div>}
                {modelTest && (
                  <>
                    <div style={{ fontSize: '0.85em', marginBottom: 6 }}>Exam: <b>{modelTest.title}</b></div>
                    <label>MCQ stage / session
                      <select value={selectedStageId} onChange={(e) => pickStage(e.target.value)} disabled={examBuilderBusy}>
                        <option value="">— pick MCQ stage —</option>
                        {(modelTest.stages || []).map((s) => (
                          <option key={s.id} value={s.id}>
                            {s.title || `Stage ${s.serial}`} ({s.type})
                          </option>
                        ))}
                      </select>
                    </label>
                  </>
                )}
                {examBuilderSession && (
                  examBuilderSession.is_published ? (
                    <div className="docwarn docwarn-error" style={{ margin: '8px 0 0', fontWeight: 500 }}>
                      ⛔ This MCQ session is already <b>Published</b> — questions cannot be injected into a published session.
                      Un-publish it in the CMS Exam Builder first, then reload here.
                    </div>
                  ) : (() => {
                    const sessSubjectCode = examBuilderSession.subject && examBuilderSession.subject.code;
                    const sessSubjectName = (examBuilderSession.subject && examBuilderSession.subject.display) || sessSubjectCode || '—';
                    const sessChapters = examBuilderSession.chapters || [];
                    const sessChapterIds = sessChapters.map((c) => c.id);
                    const sessChapterNames = sessChapters.map((c) => c.name).join(', ');
                    // Only the subject and chapter actually decide whether the question links to the
                    // session. Check the subject first — a subject mismatch makes the chapter (which
                    // lives under a different subject) meaningless to compare.
                    const subjectMismatch = showOverride && overrideIds && sessSubjectCode && overrideIds.subjectId !== sessSubjectCode;
                    const chapterMismatch = !subjectMismatch && showOverride && overrideIds && sessChapterIds.length > 0 && !sessChapterIds.includes(overrideIds.chapterId);
                    return (
                      <>
                        <div className="pill" style={{ marginTop: 6 }}>
                          <b>{examBuilderSession.title}</b>
                          {examBuilderSession.subject && <> · <b style={{ color: '#1a7a3c' }}>{sessSubjectName}</b></>}
                          {sessChapterNames && <> · {sessChapterNames}</>}
                          <span style={{ color: 'var(--ink-400)', fontSize: '0.85em' }}> · ID: {examBuilderSession.id}</span>
                        </div>
                        {/* Exact session taxonomy + one-click match into the override */}
                        <div style={{ marginTop: 8, padding: '8px 10px', background: '#fff', border: '1px dashed #bbb', borderRadius: 6, fontSize: '0.85em' }}>
                          <div style={{ fontWeight: 600, marginBottom: 4 }}>This session expects:</div>
                          <div>Exam: <b>{modelTest ? modelTest.title : '—'}</b></div>
                          {modelTest && modelTest.class && <div>Class: <b>{modelTest.class}</b>{modelTest.group ? <> · Group: <b>{modelTest.group}</b></> : null}</div>}
                          <div>Subject: <b>{sessSubjectName}</b></div>
                          <div>Chapter{sessChapters.length > 1 ? 's' : ''}: <b>{sessChapterNames || '—'}</b></div>
                          {sessSubjectCode && sessChapters.length > 0 && (
                            <div style={{ marginTop: 6, display: 'flex', gap: 6, flexWrap: 'wrap', alignItems: 'center' }}>
                              {sessChapters.length === 1 ? (
                                <button type="button" className="primary" onClick={() => useSessionTaxonomy(examBuilderSession, null,
                                  modelTest && modelTest.class ? (CLASS_PICK_OPTS.find((o) => o.sc === modelTest.class || (o.enums && o.enums.includes(modelTest.class)))?.label || null) : null,
                                  modelTest && modelTest.group ? modelTest.group : null
                                )}>
                                  Match override to this session
                                </button>
                              ) : (
                                <>
                                  <span style={{ color: 'var(--ink-400)' }}>Match override to chapter:</span>
                                  {sessChapters.map((c) => (
                                    <button type="button" key={c.id} onClick={() => useSessionTaxonomy(examBuilderSession, c,
                                      modelTest && modelTest.class ? (CLASS_PICK_OPTS.find((o) => o.sc === modelTest.class || (o.enums && o.enums.includes(modelTest.class)))?.label || null) : null,
                                      modelTest && modelTest.group ? modelTest.group : null
                                    )}>{c.name}</button>
                                  ))}
                                </>
                              )}
                              {overrideFromSession && overrideIds && overrideIds.subjectId === sessSubjectCode && (
                                <span style={{ color: '#1a7a3c', fontWeight: 600 }}>✓ override matched</span>
                              )}
                            </div>
                          )}
                        </div>
                        {subjectMismatch && (
                          <div className="docwarn docwarn-error" style={{ margin: '6px 0 0' }}>
                            ⚠ <b>Subject mismatch</b> — the override subject <b>{overrideIds.subjectName}</b> is not this session's subject <b>{sessSubjectName}</b>.
                            Change the override subject to match, or turn the override off. Validation is blocked until resolved.
                          </div>
                        )}
                        {chapterMismatch && (
                          <div className="docwarn docwarn-error" style={{ margin: '6px 0 0' }}>
                            ⚠ <b>Chapter mismatch</b> — the override chapter <b>{overrideIds.chapterName}</b> is not in this session ({sessChapterNames}).
                            Pick a matching chapter, or turn the override off. Validation is blocked until resolved.
                          </div>
                        )}
                        {!subjectMismatch && !chapterMismatch && (
                          <div className="sub" style={{ margin: '6px 0 0', color: 'var(--ink-400)' }}>
                            Questions keep their own subject &amp; chapter (from Step 1{showOverride ? ' / the override' : ''}). They must match this
                            session — <b>{sessSubjectName}{sessChapterNames ? ` · ${sessChapterNames}` : ''}</b> — or each mismatching row is blocked at validation.
                          </div>
                        )}
                      </>
                    );
                  })()
                )}
              </div>
            )}

            {uploadDest === 'live_exam' && (
              <div style={{ marginTop: 8, padding: '8px 12px', background: 'var(--surface-2, #f5f5f5)', borderRadius: 6 }}>
                <div style={{ fontSize: '0.85em', marginBottom: 8, color: 'var(--ink-400)' }}>
                  Pick the class, subject and chapter — sessions are filtered automatically.
                </div>
                <ClassChapterPicker env={env} token={token} showTopic={false}
                  onSelect={(sel) => setLiveExamIds(sel)}
                  onClear={() => { setLiveExamIds(null); setLiveExamSessions([]); setSelectedSession(null); }}
                />
                {liveExamIds && (
                  <>
                    {sessionBusy && <span className="pill" style={{ marginTop: 6, display: 'inline-block' }}>Loading sessions…</span>}
                    {sessionErr && <div className="docwarn docwarn-error" style={{ margin: '6px 0 0' }}>⚠ {sessionErr}</div>}
                    {!sessionBusy && !sessionErr && liveExamSessions.length > 0 && (
                      <label style={{ marginTop: 8, display: 'block' }}>Live Exam Session
                        <select value={selectedSession ? selectedSession.id : ''}
                          onChange={(e) => {
                            setSelectedSession(liveExamSessions.find((s) => s.id === e.target.value) || null);
                            if (overrideFromSession) { setOverrideFromSession(false); setOverrideIds(null); }
                          }}>
                          <option value="">— pick session —</option>
                          {liveExamSessions.map((s) => (
                            <option key={s.id} value={s.id}>
                              {s.title}{s.is_active ? '' : ' (inactive)'}{s.total_number_of_question ? ` · ${s.total_number_of_question}Q` : ''}
                            </option>
                          ))}
                        </select>
                      </label>
                    )}
                    {liveExamSessions.length === 0 && !sessionBusy && !sessionErr && (
                      <div className="sub" style={{ marginTop: 4 }}>No sessions found for this chapter — create one in CMS first.</div>
                    )}
                    {selectedSession && (() => {
                      const mismatch = overrideMismatchMsg(selectedSession);
                      const sChs = selectedSession.chapters || [];
                      const sCode = selectedSession.subject && selectedSession.subject.code;
                      return (
                        <>
                          <div className="pill" style={{ marginTop: 6 }}>
                            <b>{selectedSession.title}</b>
                            {selectedSession.subject && <> · <b style={{ color: '#1a7a3c' }}>{selectedSession.subject.display}</b></>}
                            {sChs.length > 0 && <> · {sChs.map((c) => c.name).join(', ')}</>}
                            <span style={{ color: 'var(--ink-400)', fontSize: '0.85em' }}> · {selectedSession.total_number_of_question || 0} existing</span>
                          </div>
                          {/* Exact session taxonomy + one-click match into the override */}
                          <div style={{ marginTop: 8, padding: '8px 10px', background: '#fff', border: '1px dashed #bbb', borderRadius: 6, fontSize: '0.85em' }}>
                            <div style={{ fontWeight: 600, marginBottom: 4 }}>This session expects:</div>
                            <div>Subject: <b>{(selectedSession.subject && selectedSession.subject.display) || '—'}</b></div>
                            <div>Chapter{sChs.length > 1 ? 's' : ''}: <b>{sChs.map((c) => c.name).join(', ') || '—'}</b></div>
                            {sCode && sChs.length > 0 && (
                              <div style={{ marginTop: 6, display: 'flex', gap: 6, flexWrap: 'wrap', alignItems: 'center' }}>
                                {sChs.length === 1 ? (
                                  <button type="button" className="primary" onClick={() => useSessionTaxonomy(selectedSession, null,
                                    selectedSession.subject?.class ? (CLASS_PICK_OPTS.find((o) => o.sc === selectedSession.subject.class || (o.enums && o.enums.includes(selectedSession.subject.class)))?.label || null) : null,
                                    selectedSession.subject?.group || null
                                  )}>
                                    Match override to this session
                                  </button>
                                ) : (
                                  <>
                                    <span style={{ color: 'var(--ink-400)' }}>Match override to chapter:</span>
                                    {sChs.map((c) => (
                                      <button type="button" key={c.id} onClick={() => useSessionTaxonomy(selectedSession, c,
                                        selectedSession.subject?.class ? (CLASS_PICK_OPTS.find((o) => o.sc === selectedSession.subject.class || (o.enums && o.enums.includes(selectedSession.subject.class)))?.label || null) : null,
                                        selectedSession.subject?.group || null
                                      )}>{c.name}</button>
                                    ))}
                                  </>
                                )}
                                {overrideFromSession && overrideIds && overrideIds.subjectId === sCode && (
                                  <span style={{ color: '#1a7a3c', fontWeight: 600 }}>✓ override matched</span>
                                )}
                              </div>
                            )}
                          </div>
                          {mismatch && (
                            <div className="docwarn docwarn-error" style={{ margin: '6px 0 0', whiteSpace: 'pre-line' }}>
                              ⚠ {mismatch} Validation is blocked until resolved.
                            </div>
                          )}
                          {!mismatch && (
                            <div className="sub" style={{ margin: '6px 0 0', color: 'var(--ink-400)' }}>
                              Questions keep their own subject &amp; chapter (from Step 1{showOverride ? ' / the override' : ''}). They must match this
                              session{selectedSession.subject ? ` — ${selectedSession.subject.display}` : ''} — or each mismatching row is blocked at validation.
                            </div>
                          )}
                        </>
                      );
                    })()}
                  </>
                )}
              </div>
            )}
          </div>

          {(phase === 'idle' || phase === 'done') && (
            <div className="actions">
              <button className="primary" onClick={handleValidateCurrent} disabled={!currentCount}>
                Validate current rows ({currentCount})
              </button>
              <span className="sub">or CSV:</span>
              <input ref={fileRef} type="file" accept=".csv" />
              <button onClick={handleValidateCsv}>Validate CSV</button>
              {phase === 'done' && <button onClick={reset}>Start over</button>}
            </div>
          )}

          {busy && (
            <div className="actions">
              <span className="pill">{phase === 'validating' ? 'Validating…' : 'Creating…'} {progress}</span>
            </div>
          )}

          {phase === 'ready' && resolvedVars && (
            <div className="docwarn" style={{ background: '#e8f5e9', borderColor: '#2d7d46', display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
              <span>✅ {resolvedVars.length} row(s) validated — nothing created yet.</span>
              <button className="primary" onClick={() => runCreate(resolvedVars)}>
                Create {resolvedVars.length} question(s) in {ENVS[env].label}
              </button>
              <button onClick={handleRevalidate}>Re-validate</button>
              <button className="danger" onClick={reset}>Discard</button>
            </div>
          )}

          {phase === 'stopped' && resolvedVars && stoppedAt !== null && (
            <div className="docwarn docwarn-error" style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
              <span>⚠ Creation stopped at row {stoppedAt + 2}. {ids.length > 0 ? `(${ids.length} already created)` : ''}</span>
              <button onClick={() => runCreate(resolvedVars, { startFrom: stoppedAt })}>
                Retry row {stoppedAt + 2}
              </button>
              <button onClick={() => runCreate(resolvedVars, { startFrom: stoppedAt + 1 })}>
                Skip row {stoppedAt + 2} &amp; continue
              </button>
              <button onClick={handleRevalidate}>Re-validate all</button>
              <button className="danger" onClick={reset}>Discard</button>
            </div>
          )}

          <textarea ref={logRef} readOnly value={log} placeholder="Validation and creation log appears here…"
            style={{ width: '100%', height: 200, fontSize: 12, fontFamily: 'monospace' }} />
          <div className="actions">
            <textarea readOnly value={ids.join(',')} placeholder="Created question IDs appear here"
              style={{ flex: 1, minWidth: 200, height: 56, fontSize: 12 }} />
            <button onClick={copyIds} disabled={!ids.length}>Copy created IDs</button>
          </div>
        </>
      )}
    </section>
  );
}

// Per-row CMS upload blockers — surfaced as a ⚠ marker and the summary count.
// Strip $…$ spans so embedded option-letter checks don't fire inside math.
function stripMath(s) { return String(s || '').replace(/\$[^$]*\$/g, ' '); }
// True when text outside math contains an embedded option marker (C./D./…)
// that should have been split into its own field — indicates a parser failure.
function hasMergedOptions(optText, fromLetter) {
  const code = fromLetter.charCodeAt(0);
  // Build a char class for the letters that would come AFTER this option.
  const next = String.fromCharCode(code + 1) + '-E';
  return new RegExp('[' + next + ']\\s*[.)]\\s').test(stripMath(optText));
}

// Hard blockers: things that will definitely break CMS upload or produce wrong
// data. These gate the Download and Validate buttons — the user cannot proceed
// until they are fixed. Soft issues (missing topic) stay in rowIssues but do
// not block export.
// Every field the CMS Question Bank treats as mandatory. A blank one is a hard
// blocker: it gates Download CSV/XLSX and the Validate button so an incomplete
// question can never reach the CMS (where a blank field is silently defaulted
// or rejected). Order roughly follows the CMS form so the message reads top-down.
// `chapterNames` (optional Set of valid dropdown chapter names) lets the chapter
// check reject a value that isn't a real CMS chapter — not just a blank one — so
// a stray free-text chapter (e.g. a raw "8" from an old session) is blocked too.
// When the set is absent/empty (no taxonomy loaded) it falls back to non-empty.
function rowBlockers(r, chapterNames) {
  const b = [];
  if (!String(r['Question Title'] || '').trim()) b.push('title');
  if (hasMergedOptions(r['Option B'], 'B')) b.push('options C/D merged into B — parser failed to split');
  else if (hasMergedOptions(r['Option C'], 'C')) b.push('options D/E merged into C — parser failed to split');
  const emptyOpts = ['Option A', 'Option B', 'Option C', 'Option D'].filter((o) => !String(r[o] || '').trim());
  if (emptyOpts.length > 0) b.push('option ' + emptyOpts.map((o) => o.replace('Option ', '')).join('/'));
  if (!['A', 'B', 'C', 'D'].includes(String(r['Correct Option'] || '').trim().toUpperCase())) b.push('correct option');
  // Chapter must be a real dropdown value. Blank, or a stray not in the taxonomy.
  // Compared whitespace-insensitively (chapterNames is cleanName-normalized) so a
  // valid pick is never falsely flagged.
  const chap = String(r['Chapter'] || '').trim();
  if (!chap) b.push('chapter');
  else if (chapterNames && chapterNames.size && !chapterNames.has(cleanName(chap))) b.push(`chapter “${chap}” (not a CMS chapter — pick from the list)`);
  // Topic is mandatory for the Question Bank (cms.js validateRow requires it).
  const hasTopic = (r._topics && r._topics.some((t) => String(t || '').trim())) || String(r['Topic(s)'] || '').trim();
  if (!hasTopic) b.push('topic');
  // Difficulty is mandatory in the CMS — a blank cell would otherwise be
  // silently uploaded as "Easy". Block it so it must be set explicitly.
  if (!String(r['Difficulty Level'] || '').trim()) b.push('difficulty');
  return b;
}

// All mandatory fields are hard blockers, so the per-row issue list IS the
// blocker list — kept as a wrapper for the summary/marker call sites.
function rowIssues(r, chapterNames) {
  return rowBlockers(r, chapterNames);
}

// One preview-table row, memoized so editing a cell re-renders only that row
// instead of the whole grid — the per-keystroke cost that made large docs lag.
// Props are kept referentially stable in App (useCallback handlers, useMemo
// taxonomy lists) so unchanged rows bail out of re-render.
const PreviewRow = React.memo(function PreviewRow({
  row: r, index: i, cfg, liveIds, showMath, showMatch,
  subjectTaxChapters, subjectTaxTopics,
  onCell, onTopics, onChapter, onRemove, onEdit,
}) {
  // In live mode topics are already scoped to the selected chapter.
  // In static mode, scope to the row's chapter if confirmed in taxonomy.
  const rowChapter = r['Chapter'] || cfg.chapter;
  const chapterConfirmed = !liveIds && subjectTaxChapters.some((c) => cleanName(c.name) === cleanName(rowChapter));
  const rowTopics = liveIds
    ? subjectTaxTopics
    : chapterConfirmed
      ? taxTopics(cfg.class, cfg.group, cfg.subject, rowChapter)
      : subjectTaxTopics;
  const excluded = r._include === false;
  const issues = excluded ? [] : rowIssues(r, new Set(subjectTaxChapters.map((c) => cleanName(c.name))));
  return (
    <tr id={'qrow-' + i} className={(r._duplicate === 'Yes' ? 'dup ' : '') + (excluded ? 'excluded' : '')}>
      <td className="rownum">
        <div className="rowctl">
          <span className="rownum-n">{i + 1}</span>
          {issues.length > 0 && (
            <span className="rowwarn" title={'Missing: ' + issues.join(', ')}>⚠</span>
          )}
          <input type="checkbox" title="Include in export & upload"
            checked={!excluded} onChange={(e) => onCell(i, '_include', e.target.checked)} />
          <button type="button" className="rowedit" title="Edit with live LaTeX preview (CMS view)"
            onClick={() => onEdit(i)}>✎</button>
          <button type="button" className="rowdel" title="Remove this question"
            onClick={() => onRemove(i)}>×</button>
        </div>
      </td>
      {PREVIEW_COLS.map((c) => (
        <td key={c}>
          {c === 'Chapter' ? (
            <ChapterCell
              row={r}
              taxChapterList={subjectTaxChapters}
              onChange={(v) => onChapter(i, r, v)}
            />
          ) : c === 'Topic(s)' ? (
            <TopicCell row={r} taxTopics={rowTopics} onChange={(arr) => onTopics(i, arr)} />
          ) : c === 'Difficulty Level' ? (
            <SearchableSelect
              value={DIFFICULTY_OPTIONS.includes(r[c]) ? r[c] : ''}
              placeholder="— select difficulty —"
              options={DIFFICULTY_OPTIONS.map((d) => ({ value: d, label: d }))}
              onChange={(v) => onCell(i, c, v)}
            />
          ) : (
            <>
              <textarea value={r[c] || ''} onChange={(e) => onCell(i, c, e.target.value)} />
              {showMath && MATH_FIELDS.includes(c) && r[c] && <MathText value={r[c]} />}
            </>
          )}
        </td>
      ))}
      {showMatch && (
        <td className="matchcell">
          <div className="score">{r._matchScore ? `score ${r._matchScore} (${r._matchSource})` : 'no match'}</div>
          {r._matchTitle && <div className="mtitle">{r._matchTitle}</div>}
        </td>
      )}
    </tr>
  );
});

function App() {
  const [corrections, setCorrections] = useState([]);
  const [style, setStyle] = useState({ unwrapNumbers: knowledge.numberStyle.unwrapNumbers, sampleSize: 0, plainNumberOptions: 0, dollarNumberOptions: 0 });
  const [raw, setRaw] = useState('');
  const [gdocLink, setGdocLink] = useState(''); // Google Doc share link for direct import
  const [images, setImages] = useState({}); // { basename: { bytes, contentType } } from the DOCX
  const [rows, setRows] = useState([]);
  const [docWarnings, setDocWarnings] = useState([]);
  const [busy, setBusy] = useState('');
  const [showMath, setShowMath] = useState(true);
  const [showFullPreview, setShowFullPreview] = useState(false);
  const [editingRow, setEditingRow] = useState(null); // row index open in the CMS-style editor, or null
  const [cfg, setCfg] = useState({ ...AUTO_INPUT_DEFAULTS });
  const skipPersist = useRef(true);
  // Autosaved working set offered for restore after a reload/crash.
  const [restorable, setRestorable] = useState(null);
  const sessionPending = useRef(false); // true while the latest edits aren't yet flushed to IndexedDB

  // Shared CMS session — used by both the live taxonomy picker (section 2) and the uploader (section 5).
  const [cmsEnv, setCmsEnv] = useState('dev');
  const [cmsToken, setCmsToken] = useState(() => cmsGetToken('dev'));
  // Live taxonomy selection (null = use static snapshot taxonomy).
  const [liveIds, setLiveIds] = useState(null);
  const [liveTaxTopics, setLiveTaxTopics] = useState([]);
  const [liveTaxChapters, setLiveTaxChapters] = useState([]);
  const [useLiveTax, setUseLiveTax] = useState(false);

  const handleEnvChange = (e) => {
    setCmsEnv(e); setCmsToken(cmsGetToken(e));
    setLiveIds(null); setLiveTaxTopics([]); setLiveTaxChapters([]); setUseLiveTax(false);
  };
  const handleTokenChange = (tok) => {
    setCmsToken(tok);
    if (!tok) { setLiveIds(null); setLiveTaxTopics([]); setLiveTaxChapters([]); setUseLiveTax(false); }
  };

  // Corpus for example matching = the user's own saved corrections only.
  // (The full CMS corpus lives in the background knowledge base, not in memory.)
  const corpus = useMemo(() => buildCorpus([], corrections), [corrections]);

  // The training/correction memory is keyed by the CMS subject chosen in step 1
  // (the live subject name in live mode) — so there is a single subject control.
  // No selection (or no subject yet) falls back to a shared "default" bucket.
  const profileKey = (liveIds ? liveIds.subjectName : cfg.subject) || 'default';
  const loadedProfile = useRef(null);

  // Load saved corrections + number-style whenever the active subject changes.
  useEffect(() => {
    if (loadedProfile.current === profileKey) return;
    loadedProfile.current = profileKey;
    let cancelled = false;
    (async () => {
      skipPersist.current = true;
      let ds = null;
      try { ds = await getDataset(profileKey); } catch { /* IndexedDB unavailable */ }
      if (cancelled) return;
      setCorrections(ds?.corrections || []);
      const ns = numberStyleFor(profileKey);
      setStyle({ ...ns, unwrapNumbers: ds?.unwrapNumbers ?? ns.unwrapNumbers });
    })();
    return () => { cancelled = true; };
  }, [profileKey]);

  // Persist corrections per subject (debounced; skipped right after a load).
  // Empty buckets aren't written so browsing subjects doesn't litter storage.
  useEffect(() => {
    if (skipPersist.current) { skipPersist.current = false; return; }
    if (!corrections.length) return;
    const t = setTimeout(() => {
      putDataset({ subject: profileKey, corrections, unwrapNumbers: style.unwrapNumbers }).catch(() => {});
    }, 300);
    return () => clearTimeout(t);
  }, [profileKey, corrections, style.unwrapNumbers]);

  // Remember the last-used Auto-Input defaults (taxonomy + meta) across sessions.
  useEffect(() => {
    try {
      const saved = localStorage.getItem('cms_cfg');
      if (saved) setCfg((c) => ({ ...c, ...JSON.parse(saved) }));
    } catch { /* ignore */ }
  }, []);
  useEffect(() => {
    const t = setTimeout(() => {
      try { localStorage.setItem('cms_cfg', JSON.stringify(cfg)); } catch { /* ignore */ }
    }, 300);
    return () => clearTimeout(t);
  }, [cfg]);

  // On mount, see if a previous review session was left unfinished and offer to
  // restore it (the working rows live only in memory otherwise).
  useEffect(() => {
    (async () => {
      try {
        const s = await getSession();
        if (s && Array.isArray(s.rows) && s.rows.length) setRestorable(s);
      } catch { /* ignore */ }
    })();
  }, []);

  // Autosave the working review set (rows + raw + taxonomy/meta) so a reload or
  // crash never loses edits. Debounced; never writes an empty set so it can't
  // clobber a restorable session before the user has started.
  useEffect(() => {
    if (!rows.length) return;
    sessionPending.current = true;
    const t = setTimeout(() => {
      putSession({ raw, rows, cfg, unwrapNumbers: style.unwrapNumbers, profileKey })
        .finally(() => { sessionPending.current = false; });
    }, 700);
    return () => clearTimeout(t);
  }, [rows, raw, cfg, style.unwrapNumbers, profileKey]);

  // Warn before leaving if the most recent edits haven't been flushed yet.
  useEffect(() => {
    const onBeforeUnload = (e) => {
      if (!sessionPending.current) return;
      e.preventDefault();
      e.returnValue = '';
    };
    window.addEventListener('beforeunload', onBeforeUnload);
    return () => window.removeEventListener('beforeunload', onBeforeUnload);
  }, []);

  const restoreSession = () => {
    const s = restorable;
    if (!s) return;
    if (s.cfg) setCfg((c) => ({ ...c, ...s.cfg }));
    if (typeof s.unwrapNumbers === 'boolean') setStyle((st) => ({ ...st, unwrapNumbers: s.unwrapNumbers }));
    setRaw(s.raw || '');
    setRows(s.rows || []);
    setRestorable(null);
  };
  const dismissSession = () => { setRestorable(null); clearSession().catch(() => {}); };

  // Shared: turn raw .docx bytes into the editable raw text + image map.
  const ingestDocxBuffer = useCallback((buf) => {
    const { text, images: imgs } = docxToContent(buf); // native DOMParser in the browser
    setRaw(text);
    setImages(imgs || {});
  }, []);

  const loadDocx = useCallback(async (file) => {
    setBusy('Extracting math from DOCX…');
    try {
      ingestDocxBuffer(await file.arrayBuffer());
    } catch (e) {
      alert('DOCX read failed: ' + e.message);
    }
    setBusy('');
  }, [ingestDocxBuffer]);

  // Import straight from a public Google Doc link. The /api/gdoc serverless
  // proxy exports the doc to .docx (the browser can't fetch docs.google.com
  // directly — no CORS), then it flows through the same DOCX pipeline as an
  // uploaded file. The doc must be shared "Anyone with the link can view".
  const loadGoogleDoc = useCallback(async (link) => {
    const id = extractGoogleDocId(link);
    if (!id) { alert('That doesn’t look like a Google Doc link — expected something like https://docs.google.com/document/d/…'); return; }
    setBusy('Fetching Google Doc…');
    try {
      const resp = await fetch('/api/gdoc?id=' + encodeURIComponent(id));
      if (!resp.ok) {
        let msg = `Fetch failed (${resp.status})`;
        try { const j = await resp.json(); if (j && j.error) msg = j.error; } catch {}
        throw new Error(msg);
      }
      ingestDocxBuffer(await resp.arrayBuffer());
    } catch (e) {
      alert('Google Doc load failed: ' + e.message);
    }
    setBusy('');
  }, [ingestDocxBuffer]);

  const subjectTaxTopics = useMemo(
    () => liveIds ? liveTaxTopics : taxAllTopics(cfg.class, cfg.group, cfg.subject),
    [liveIds, liveTaxTopics, cfg.class, cfg.group, cfg.subject]
  );
  const subjectTaxChapters = useMemo(
    () => liveIds ? liveTaxChapters : taxChapters(cfg.class, cfg.group, cfg.subject),
    [liveIds, liveTaxChapters, cfg.class, cfg.group, cfg.subject]
  );

  // Re-evaluate taxonomy mismatch warnings when the selection changes (e.g. the
  // user clicks "Switch to X"), without re-parsing the doc. Image warnings from
  // the last format() run are preserved; only the mismatch portion is refreshed.
  useEffect(() => {
    if (!rows.length) return;
    setDocWarnings((prev) => [
      ...prev.filter((w) => w.field === 'image'),
      ...computeMismatches(detectDocMeta(raw), rows, cfg, subjectTaxTopics, !!liveIds),
    ]);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cfg.class, cfg.group, cfg.subject, cfg.chapter, cfg.topic, rows, subjectTaxTopics, liveIds]);

  // When the user picks a new chapter from the ChapterCell dropdown, re-resolve
  // the row's doc topics against the new chapter's topic list.
  const onChapterChange = useCallback((i, r, newChapter) => {
    const chTopics = taxTopics(cfg.class, cfg.group, cfg.subject, newChapter);
    const docTopics = r._docTopics || [];
    const reResolved = chTopics.length
      ? docTopics.map((dt) => matchTopic(dt, chTopics).name).filter(Boolean)
      : [];
    setRows((rs) => rs.map((row, idx) => idx === i
      ? { ...row, 'Chapter': newChapter, _topics: reResolved }
      : row
    ));
  }, [cfg.class, cfg.group, cfg.subject]);

  const format = useCallback(async () => {
    const taxTopics = (liveIds && liveTaxTopics.length) ? liveTaxTopics : taxAllTopics(cfg.class, cfg.group, cfg.subject);
    const parsed = parseRaw(raw);
    let built = parsed.map((q) => {
      const base = toCmsRow(q, style);
      const docTopics = (q.topics && q.topics.length) ? q.topics
        : (q.topic ? [{ no: '', name: q.topic }] : []);
      // A global topic (set in step 2 when the whole doc is one topic) overrides
      // the per-question topics read from the doc. Live mode keeps its own topic IDs.
      const resolved = (!liveIds && cfg.topic)
        ? [cfg.topic]
        : docTopics.map((dt) => matchTopic(dt, taxTopics).name);
      // Chapter must ALWAYS be a real dropdown value (a canonical taxonomy name)
      // or empty — never a raw number. We resolve through the taxonomy; if that
      // fails the cell is left blank and the doc's raw chapter is kept in
      // _docChapter so the ChapterCell can show a red hint + suggestion.
      const docChapterRaw = q.chapter ? bnToEn(String(q.chapter)).trim() : '';
      let resolvedChapter = '';
      if (liveIds) {
        // Live mode targets exactly one chapter (from the picker) — show it on every row.
        resolvedChapter = liveIds.chapterName || '';
      } else if (q.chapter) {
        // The doc names a chapter for this question (multi-chapter file) — it wins,
        // but only if it resolves to a real taxonomy chapter name.
        const ch = taxChapterByNo(cfg.class, cfg.group, cfg.subject, q.chapter);
        resolvedChapter = ch ? ch.name : '';
      } else {
        // No chapter in the doc (single-chapter file): fall back to the one picked
        // in the top taxonomy filter so the whole file gets it without per-row edits.
        resolvedChapter = cfg.chapter || '';
      }
      const baseMeta = { _docTopics: docTopics, _topics: resolved, _docChapter: docChapterRaw };
      // Last resort when the doc chapter didn't resolve: derive it from a topic's
      // section number (8.4 → chapter 8), so a valid dropdown name is auto-filled
      // instead of leaving the row blocked.
      if (!resolvedChapter && !liveIds) {
        const sug = suggestChapterFor(baseMeta, taxChapters(cfg.class, cfg.group, cfg.subject));
        if (sug) resolvedChapter = sug.name;
      }
      const withMeta = {
        'Difficulty Level': q.difficulty || '',
        'Chapter': resolvedChapter,
        'Topic(s)': q.topic || '',
        ...baseMeta,
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
    setDocWarnings([...uploadWarnings, ...computeMismatches(docMeta, built, cfg, taxTopics, !!liveIds)]);
  }, [raw, images, style, corpus, cfg.class, cfg.group, cfg.subject, cfg.chapter, cfg.topic, liveIds, liveTaxTopics]);

  const updateCell = useCallback((i, col, val) => setRows((rs) => rs.map((r, idx) => (idx === i ? { ...r, [col]: val } : r))), []);
  const setTopics = useCallback((i, arr) => setRows((rs) => rs.map((r, idx) => (idx === i ? { ...r, _topics: arr } : r))), []);
  const removeRow = useCallback((i) => setRows((rs) => rs.filter((_, idx) => idx !== i)), []);

  const reformatStyle = (unwrap) => {
    setStyle((s) => ({ ...s, unwrapNumbers: unwrap }));
  };

  // Map a previewed/edited row to the Auto-Input schema (dummy meta from cfg).
  // When liveIds is set, class/subject/chapter come from the live picker and
  // _subjectId/_chapterId/_classEnums are embedded so the uploader skips name→ID resolution.
  const buildAutoRow = useCallback((r) => {
    const row = {
      class: liveIds ? liveIds.classEnums[0] : cfg.class,
      group: liveIds ? '' : cfg.group,
      subject: liveIds ? liveIds.subjectName : cfg.subject,
      chapter: liveIds
        ? liveIds.chapterName
        : ((r['Chapter'] && r['Chapter'].trim()) ? r['Chapter'].trim() : cfg.chapter).normalize('NFC'),
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
    };
    if (liveIds) {
      row._subjectId = liveIds.subjectCode;
      row._chapterId = liveIds.chapterId;
      row._classEnums = liveIds.classEnums;
      if (liveIds.defaultTopicId) {
        row._topicIds = [liveIds.defaultTopicId];
      }
    }
    return row;
  }, [cfg, liveIds]);

  const saveAsTraining = () => {
    const reviewed = rows.map((r) => GEN_FIELDS.reduce((o, k) => ((o[k] = r[k] ?? ''), o), {}));
    setCorrections((c) => [...c, ...reviewed]);
    alert(`${reviewed.length} reviewed rows saved to "${profileKey}" as training/reference data.`);
  };
  const clearTraining = () => { if (confirm(`Clear saved corrections for "${profileKey}"?`)) setCorrections([]); };

  // Rows the user kept checked — the set that gets exported / uploaded.
  const includedRows = rows.filter((r) => r._include !== false);

  // Scroll a question row into view and flash it — used by the blocker banner so
  // the user can jump straight to the offending row (row numbers scroll out of
  // view in the wide table).
  const jumpToRow = (idx) => {
    const el = document.getElementById('qrow-' + idx);
    if (!el) return;
    el.scrollIntoView({ behavior: 'smooth', block: 'center' });
    el.classList.add('rowflash');
    setTimeout(() => el.classList.remove('rowflash'), 1800);
  };

  const exportCSV = () => {
    const full = includedRows.map(buildAutoRow);
    const csv = [
      AUTO_INPUT_COLUMNS.join(','),
      ...full.map((r) => AUTO_INPUT_COLUMNS.map((c) => csvEscape(r[c])).join(',')),
    ].join('\n');
    downloadBlob('cms_auto_input.csv', '﻿' + csv, 'text/csv;charset=utf-8;');
  };
  const exportXLSX = () => {
    const full = includedRows.map(buildAutoRow);
    const ws = XLSX.utils.json_to_sheet(full, { header: AUTO_INPUT_COLUMNS });
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, 'CMS_Auto_Input');
    XLSX.writeFile(wb, 'cms_auto_input.xlsx');
  };

  const dupCount = rows.filter((r) => r._duplicate === 'Yes').length;
  // The "closest saved fix" column only carries data once the user has saved
  // their own corrections — hide it entirely otherwise to reclaim table width.
  const showMatch = corpus.length > 0;

  // Valid chapter names for the current subject — used to reject a stray chapter
  // value (not just a blank one) in the blocker checks. Whitespace-normalized so
  // it agrees with the green ✓ in ChapterCell (taxonomy names carry stray spaces).
  const chapterNameSet = useMemo(
    () => new Set(subjectTaxChapters.map((c) => cleanName(c.name))),
    [subjectTaxChapters]
  );

  // Per-row blockers — the fields the CMS upload requires. Used for the summary
  // bar and a per-row ⚠ marker so problems surface at review time, not after a
  // round-trip to the CMS uploader.
  const mathCount = includedRows.filter((r) => r['Has Math Equation'] === 'Yes').length;
  const needAttention = includedRows.filter((r) => rowIssues(r, chapterNameSet).length > 0).length;
  const excludedCount = rows.length - includedRows.length;

  // Hard-blocker rows: empty/merged options, missing title or correct option.
  // These gate Download CSV/XLSX and the CMS Validate button — nothing can be
  // exported or uploaded until they are fixed or the row is excluded.
  const blockerRows = includedRows
    .map((r) => ({ n: rows.indexOf(r) + 1, issues: rowBlockers(r, chapterNameSet) }))
    .filter((x) => x.issues.length > 0);
  const hasBlockers = blockerRows.length > 0;

  return (
    <div>
      <header className="appbar">
        <div className="brandplate"><img src="/shikho-logo.png" alt="Shikho" /></div>
        <div>
          <h1>CMS Question Formatter</h1>
          <p>Pre-trained on the CMS corpus. Set the subject &amp; CMS taxonomy → upload the DOCX → review → export. No reference file needed.</p>
        </div>
      </header>

      {restorable && !rows.length && (
        <div className="restorebar">
          <span className="restorebar-icon">↺</span>
          <div className="restorebar-text">
            <b>Restore your last review session?</b>
            <span>
              {restorable.rows.length} question{restorable.rows.length === 1 ? '' : 's'}
              {restorable.profileKey && restorable.profileKey !== 'default' ? ` · ${restorable.profileKey}` : ''}
              {restorable.updatedAt ? ` · saved ${timeAgo(restorable.updatedAt)}` : ''} — recovered after a reload.
            </span>
          </div>
          <button className="primary" onClick={restoreSession}>Restore</button>
          <button className="danger" onClick={dismissSession}>Discard</button>
        </div>
      )}

      <section className="card">
        <h2>1 · Subject &amp; upload defaults
          <span className="pill">Saved corrections: {corrections.length}</span>
          {corrections.length > 0 && <button className="danger" onClick={clearTraining}>Clear training</button>}
        </h2>
        <p className="sub">
          {useLiveTax
            ? <>Live <b>{ENVS[cmsEnv].label}</b> taxonomy — Program → Phase → Subject → Chapter fetched directly from the CMS. Topic is still read per-question from the uploaded doc.</>
            : <>Class → Subject → Chapter are picked from the offline snapshot ({taxonomy.source}, {TAX_ENUMS_PRESENT.join('/') || 'none'}). <b>Topic is read per-question from the uploaded doc</b> and matched in step 3 — or set one <b>topic for all questions</b> below to override it.</>}
          {' '}<code>difficulty_level</code> here is a fallback; the value parsed per-question wins.
        </p>
        <p className="sub">
          Math formatting is learned per <b>subject</b>: your <b>{corrections.length}</b> saved correction{corrections.length === 1 ? '' : 's'} for <b>{profileKey}</b> auto-apply, and "Save corrections as training" (step 3) stores new fixes under it. Trained on <b>{knowledge.meta.questions.toLocaleString()}</b> CMS questions. Conventions: arrow <code>{knowledge.conventions.arrow}</code>, frac <code>{knowledge.conventions.frac}</code>, ≤ <code>{knowledge.conventions.leq}</code>.
          <label className="inline"><input type="checkbox" checked={style.unwrapNumbers}
            onChange={(e) => reformatStyle(e.target.checked)} /> Unwrap pure-number math (<code>$0$</code> → <code>0</code>)</label>
        </p>
        {cmsToken && (
          <div style={{ marginBottom: 8 }}>
            <label className="inline">
              <input type="checkbox" checked={useLiveTax} onChange={(e) => {
                setUseLiveTax(e.target.checked);
                if (!e.target.checked) { setLiveIds(null); setLiveTaxTopics([]); setLiveTaxChapters([]); }
              }} />
              {' '}Use live {ENVS[cmsEnv].label} taxonomy (Program → Phase → Subject → Chapter)
            </label>
            {liveIds && (
              <span className="pill" style={{ marginLeft: 8 }}>
                {liveIds.programTitle} · {liveIds.phaseTitle || 'all phases'} · {liveIds.subjectName} · {liveIds.chapterName}
                {liveIds.defaultTopicId ? ` · ${liveIds.defaultTopicName} (default topic)` : ''}
              </span>
            )}
          </div>
        )}
        <div className="grid">
          {useLiveTax && cmsToken
            ? <LiveTaxonomyPicker
                env={cmsEnv} token={cmsToken}
                onSelect={(sel) => {
                  setLiveIds(sel);
                  setLiveTaxTopics(sel.topics);
                  setLiveTaxChapters(sel.chapters.map((c) => ({ id: c.chapter_id, name: c.chapter_name, no: c.chapter_no })));
                  setCfg((c) => ({ ...c, subject: sel.subjectName, chapter: sel.chapterName }));
                }}
                onClear={() => { setLiveIds(null); setLiveTaxTopics([]); setLiveTaxChapters([]); }}
              />
            : CLASS_OPTIONS.length
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
        <h2>2 · Raw input</h2>
        <input type="file" accept=".docx" onChange={(e) => e.target.files[0] && loadDocx(e.target.files[0])} />
        <div className="gdoc-row">
          <input type="url" className="gdoc-input"
            placeholder="…or paste a Google Doc link (must be shared “Anyone with the link can view”)"
            value={gdocLink}
            onChange={(e) => setGdocLink(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter' && gdocLink.trim()) loadGoogleDoc(gdocLink); }} />
          <button type="button" onClick={() => loadGoogleDoc(gdocLink)} disabled={!gdocLink.trim() || !!busy}>
            Load from link
          </button>
        </div>
        <textarea placeholder="…or paste raw questions here. Math from a .docx is auto-converted to $LaTeX$ on upload."
          value={raw} onChange={(e) => setRaw(e.target.value)} />
        <button className="primary" onClick={format} disabled={!raw.trim()}>Format questions</button>
        {busy && <span className="pill">{busy}</span>}
      </section>

      <section className="card">
        <h2>3 · Preview, edit &amp; export <span className="pill">{rows.length} questions</span>
          {dupCount > 0 && <span className="pill warn">{dupCount} possible duplicate(s)</span>}
        </h2>
        {docWarnings.length > 0 && (
          <div className="docwarnings">
            {docWarnings.map((w, i) => (
              <div key={i} className={'docwarn docwarn-' + w.level}>
                <span className="docwarn-icon">{w.level === 'error' ? '⚠' : w.level === 'warn' ? '!' : 'i'}</span>
                {w.msg}
                {w.suggestSubject && (
                  <button className="docwarn-action"
                    onClick={() => setCfg((c) => ({ ...c, subject: w.suggestSubject, chapter: '', topic: '' }))}>
                    Switch to {w.suggestSubject}
                  </button>
                )}
              </div>
            ))}
          </div>
        )}
        {hasBlockers && (
          <div className="blocker-banner">
            <strong>⛔ {blockerRows.length} question{blockerRows.length > 1 ? 's' : ''} with missing mandatory field{blockerRows.length > 1 ? 's' : ''} — export & validate are blocked. Fix each below, or uncheck the row to exclude it:</strong>
            <ul>
              {blockerRows.map(({ n, issues }) => (
                <li key={n}>
                  <button type="button" className="blocker-jump" onClick={() => jumpToRow(n - 1)} title="Scroll to this question">
                    Question {n} ↗
                  </button>
                  {' '}missing <b>{issues.join(', ')}</b>
                </li>
              ))}
            </ul>
          </div>
        )}
        <div className="actions">
          <button className="primary" onClick={() => setShowFullPreview(true)} disabled={!includedRows.length}>👁 Full CMS Preview</button>
          <button onClick={saveAsTraining} disabled={!rows.length}>Save corrections as training</button>
          <button onClick={exportCSV} disabled={!includedRows.length || hasBlockers} title={hasBlockers ? 'Fix the errors above before downloading' : ''}>Download CSV</button>
          <button onClick={exportXLSX} disabled={!includedRows.length || hasBlockers} title={hasBlockers ? 'Fix the errors above before downloading' : ''}>Download XLSX</button>
          <label className="inline"><input type="checkbox" checked={showMath} onChange={(e) => setShowMath(e.target.checked)} /> Show math preview</label>
        </div>
        {rows.length > 0 && (
          <div className="rowsummary">
            <span className="pill">{includedRows.length} to export</span>
            {excludedCount > 0 && <span className="pill">{excludedCount} excluded</span>}
            <span className="pill">{mathCount} with math</span>
            {needAttention > 0
              ? <span className="pill err">⛔ {needAttention} row{needAttention > 1 ? 's' : ''} with missing fields — fix before export</span>
              : <span className="pill ok">✓ all rows complete</span>}
          </div>
        )}
        <div className="tablewrap">
          <table>
            <thead>
              <tr><th className="rownum-h">#</th>{PREVIEW_COLS.map((c) => <th key={c}>{c}</th>)}{showMatch && <th>Closest saved fix</th>}</tr>
            </thead>
            <tbody>
              {rows.map((r, i) => (
                <PreviewRow
                  key={i}
                  row={r}
                  index={i}
                  cfg={cfg}
                  liveIds={liveIds}
                  showMath={showMath}
                  showMatch={showMatch}
                  subjectTaxChapters={subjectTaxChapters}
                  subjectTaxTopics={subjectTaxTopics}
                  onCell={updateCell}
                  onTopics={setTopics}
                  onChapter={onChapterChange}
                  onRemove={removeRow}
                  onEdit={setEditingRow}
                />
              ))}
            </tbody>
          </table>
        </div>
      </section>

      {showFullPreview && <FullPreview rows={rows} onClose={() => setShowFullPreview(false)} />}

      {editingRow !== null && rows[editingRow] && (
        <QuestionEditor
          row={rows[editingRow]}
          index={editingRow}
          onChange={(key, val) => updateCell(editingRow, key, val)}
          onClose={() => setEditingRow(null)}
        />
      )}

      <CmsUploader
        env={cmsEnv} token={cmsToken}
        onEnvChange={handleEnvChange} onTokenChange={handleTokenChange}
        buildCurrentRows={() => includedRows.map(buildAutoRow)} currentCount={includedRows.length}
        liveIds={liveIds}
        blockerRows={blockerRows}
      />

      <section className="note">
        <b>How it works:</b> The app is pre-trained offline on the full CMS corpus — it applies CMS's own LaTeX conventions (learned from {knowledge.meta.questions.toLocaleString()} questions) to every conversion, with no reference upload.
        Word equations (OMML) are extracted and converted to CMS-style <code>$LaTeX$</code> — not dropped like a plain-text reader. Always eyeball the math preview before uploading.
        Re-training on a new corpus: <code>node tools/train.mjs "&lt;file&gt;.csv"</code>.
      </section>
    </div>
  );
}

createRoot(document.getElementById('root')).render(<App />);
