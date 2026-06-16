import React, { useMemo, useState, useCallback, useEffect, useRef } from 'react';
import { createRoot } from 'react-dom/client';
import * as XLSX from 'xlsx';
import katex from 'katex';
import 'katex/dist/katex.min.css';
import './style.css';

import { docxToText } from './docx.js';
import { applyConventions } from './omml.js';
import { parseRaw } from './parse.js';
import { toCmsRow, buildCorpus, attachNearest, MATH_FIELDS } from './style.js';
import { listSubjects, getDataset, putDataset, deleteDataset } from './db.js';
import knowledge from './knowledge.json';

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
  class: 'Class 6', group: '', subject: 'ICT', chapter: 'test', topic: 'test',
  difficulty_level: 'Easy', allocated_time: '1', allocated_marks: '',
  question_source_category: 'Engineering', question_type: 'MCQ',
  is_active: 'true', markdown_version: '1', description: '',
};
const CONFIG_FIELDS = ['class', 'group', 'subject', 'chapter', 'topic', 'question_source_category', 'question_type', 'difficulty_level', 'allocated_time', 'allocated_marks', 'is_active', 'markdown_version'];

const GEN_FIELDS = ['Question Title', 'Option A', 'Option B', 'Option C', 'Option D', 'Correct Option', 'Solution', 'Has Math Equation'];
const PREVIEW_COLS = [...GEN_FIELDS, 'Difficulty Level', 'Topic(s)'];

// Bare option value for Auto Input (strip the leading "A. " / "B) " etc.).
function stripOptionPrefix(v) { return String(v || '').replace(/^\s*[A-D]\s*[.)]\s*/, ''); }


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
    const parts = s.split(/(\$[^$]*\$)/g);
    return parts.map((p) => {
      if (/^\$[^$]*\$$/.test(p)) {
        try {
          return katex.renderToString(p.slice(1, -1), { throwOnError: false, output: 'html' });
        } catch {
          return '<span class="mathbad">' + p.replace(/</g, '&lt;') + '</span>';
        }
      }
      return p.replace(/</g, '&lt;');
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
  const [rows, setRows] = useState([]);
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
    setCfg({ ...AUTO_INPUT_DEFAULTS, subject: name, ...(ds?.cfg || {}) });
    const ns = numberStyleFor(name);
    setStyle({ ...ns, unwrapNumbers: ds?.unwrapNumbers ?? ns.unwrapNumbers });
    setSubject(name);
    setRows([]); setRaw('');
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
      const text = docxToText(buf); // native DOMParser in the browser
      setRaw(text);
    } catch (e) {
      alert('DOCX read failed: ' + e.message);
    }
    setBusy('');
  }, []);

  const format = useCallback(() => {
    const parsed = parseRaw(raw);
    const built = parsed.map((q) => {
      const base = toCmsRow(q, style);
      const withMeta = { 'Difficulty Level': q.difficulty || '', 'Topic(s)': q.topic || '' };
      return attachNearest({ ...base, ...withMeta }, corpus);
    });
    setRows(built);
  }, [raw, style, corpus]);

  const updateCell = (i, col, val) => setRows((rs) => rs.map((r, idx) => (idx === i ? { ...r, [col]: val } : r)));

  const reformatStyle = (unwrap) => {
    setStyle((s) => ({ ...s, unwrapNumbers: unwrap }));
  };

  // Map a previewed/edited row to the Auto-Input schema (dummy meta from cfg).
  const buildAutoRow = useCallback((r) => ({
    class: cfg.class,
    group: cfg.group,
    subject: cfg.subject,
    chapter: cfg.chapter,
    topic: cfg.topic,
    title: r['Question Title'] || '',
    option_a: stripOptionPrefix(r['Option A']),
    option_b: stripOptionPrefix(r['Option B']),
    option_c: stripOptionPrefix(r['Option C']),
    option_d: stripOptionPrefix(r['Option D']),
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
        <p className="sub">These fill every column except the converted question/options/solution. Pre-filled from the sample file — edit as needed. <code>difficulty_level</code> here is only a fallback; the value parsed from each question wins.</p>
        <div className="grid">
          {CONFIG_FIELDS.map((k) => (
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
              {rows.map((r, i) => (
                <tr key={i} className={r._duplicate === 'Yes' ? 'dup' : ''}>
                  <td className="rownum">{i + 1}</td>
                  {PREVIEW_COLS.map((c) => (
                    <td key={c}>
                      <textarea value={r[c] || ''} onChange={(e) => updateCell(i, c, e.target.value)} />
                      {showMath && MATH_FIELDS.includes(c) && r[c] && <MathText value={r[c]} />}
                    </td>
                  ))}
                  <td className="matchcell">
                    <div className="score">{r._matchScore ? `score ${r._matchScore} (${r._matchSource})` : 'no match'}</div>
                    {r._matchTitle && <div className="mtitle">{r._matchTitle}</div>}
                  </td>
                </tr>
              ))}
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
