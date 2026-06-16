# CMS Question Formatter — Agent Handoff Document

**Project owner:** sahidul.turab@shikho.com (Shikho Knowledge Team)
**Working directory:** `c:\Users\Shikho\Downloads\cms-question-formatter v2\cms-question-formatter`
**Dev server:** `http://localhost:5173` (run `npm run dev` to start)
**Last trained:** 2026-06-16

---

## What this project is

A **local, browser-based tool** that converts raw Knowledge Team `.docx` files (Bengali + English mixed, heavily math-laden) into the exact 21-column CSV schema that the Shikho CMS accepts for direct upload (`Sample Structure for CMS Auto Input.csv`).

The core problem it solves: Word DOCX files store all math as **OMML (Office Math Markup Language)** — a proprietary XML format. Any plain text reader (e.g. `mammoth`) silently **drops all math**. This tool unzips the DOCX, walks `word/document.xml`, and converts every OMML object to CMS-style `$LaTeX$` inline.

---

## Current training state

The knowledge base (`src/knowledge.json`) has been distilled from the following CMS export files:

| File | Questions |
|---|---|
| Class 6 - All Converted MCQ.csv | 3,022 |
| Class 7 - All Converted MCQ.csv | 3,392 |
| Class 8 - All Converted MCQ.csv | 13,728 |
| Class 9 Science - All Converted MCQ.csv | 56,203 |
| Class 11 Science - All Converted MCQ.csv | 77,558 |
| Converted Math File from CMS.csv (Higher Math 1st) | 5,637 |
| **TOTAL** | **159,540 across 101 subjects** |

The user has ~239,800 total questions. They will feed more class/subject CSV files over time. The trainer is **cumulative** — each new file appends to the existing counts without overwriting.

### What the training actually stores

**Training does NOT store question content.** It only stores aggregate counts:
- LaTeX convention variants (`\leq` vs `\le`, `\frac` vs `\dfrac`, `\rightarrow` vs `\to`, `\times` vs `\cdot`)
- Number style counts (`plain: 32019` vs `dollar: 6395`) — whether options like `0` are written as `0` or `$0$`
- Per-subject stats (question count, plain/dollar counts)
- `knowledge.json` stays ~7 KB regardless of corpus size

### Learned conventions (from corpus)
```json
{
  "leq": "\\leq",
  "geq": "\\geq",
  "neq": "\\neq",
  "arrow": "\\rightarrow",
  "frac": "\\frac",
  "mult": "\\times",
  "unwrapNumbers": true
}
```

---

## How to train on a new file

When the user drops a new CMS export CSV in the working directory:

```bash
node tools/train.mjs "Class 10 - All Converted MCQ.csv"
npm run build
```

- The trainer skips files already in `meta.sources` (deduplication by filename)
- `--reset` starts the corpus over from scratch
- `--force` re-counts an already-trained file
- The trainer streams CSVs via PapaParse `NODE_STREAM_INPUT` — handles files of any size

**Important:** `new file.csv` and `cms_auto_input.csv` in the working folder are **tool output** (Auto-Input format), NOT CMS exports. Do not train on them. The trainer would count 0 questions from them anyway (column names differ: `title` vs `Question Title`, `option_a` vs `Option A`).

The trainer handles two CMS export schemas:
1. **Auto-Input schema** (21-col lowercase): `class, group, subject, title, option_a...` — older class files
2. **Full CMS export schema** (27-col): `ID, Class, Subject Code, Subject, Question Title, Option A...` — `Converted Math File from CMS.csv` is this format

Both are handled because `get(row, name)` does case-insensitive column matching.

---

## File structure

```
cms-question-formatter/
├── src/
│   ├── omml.js          # OMML DOM node → LaTeX (THE core conversion engine)
│   ├── docx.js          # .docx (zip) → plain text with inline $LaTeX$
│   ├── parse.js         # Rule-based structural parser (splits Q/options/answer/explanation)
│   ├── style.js         # Normalization, has-math detection, Jaccard similarity, CMS row builder
│   ├── db.js            # IndexedDB per-subject persistence (cfg + corrections)
│   ├── main.jsx         # React UI
│   ├── style.css        # Shikho brand CSS
│   └── knowledge.json   # Distilled corpus (aggregates only, ~7 KB)
├── tools/
│   └── train.mjs        # Offline cumulative trainer
├── public/
│   └── shikho-logo.png  # Brand logo (white BG knocked out)
├── index.html           # Poppins + Hind Siliguri fonts from Google Fonts
├── Sample Structure for CMS Auto Input.csv   # Schema reference (21-col)
└── HANDOFF.md           # This file
```

---

## Source file deep-dives

### `src/omml.js` — OMML → LaTeX

The most critical file. Converts Word's internal XML math (`<m:oMath>`) to `$LaTeX$`.

**Key exports:**
- `ommlToLatex(node)` — converts one `<m:oMath>` element to a LaTeX string
- `applyConventions(c)` — overrides the `CONV` table with corpus-learned spellings (called at startup from `knowledge.json`)

**OMML elements handled:**
| OMML tag | LaTeX output |
|---|---|
| `f` | `\frac{num}{den}` or `num/den` (linear fraction) |
| `rad` | `\sqrt{e}` or `\sqrt[n]{e}` |
| `sSup` | `base^{sup}` — prime detection: `ℚ^'` → `ℚ'` |
| `sSub` | `base_{sub}` |
| `sSubSup` | `base_{sub}^{sup}` |
| `sPre` | `_{sub}^{sup}base` (pre-scripts) |
| `d` | `\left( \right)`, `\left\{ \right.`, `\left\| \right\|`, `\lfloor`, `\lceil`, `\langle` etc. |
| `func` | `\sin`, `\log_3`, `\lim` etc. |
| `nary` | `\int_{a}^{b}`, `\sum`, `\prod` |
| `acc` | `\hat{}`, `\dot{}`, `\vec{}`, `\overline{}` |
| `bar` | `\overline{}` |
| `eqArr` | elements joined with `\quad` |
| `m` | `\begin{matrix}...\end{matrix}` |

**Critical fixes already applied (do not undo):**
1. `SYMBOLS` map includes `'{': '\\{', '}': '\\}', '%': '\\%'` — literal braces in OMML text runs must be escaped or KaTeX throws parse errors
2. `renderSup()` detects prime/complement chars (`'′″‴`) and emits `base'` not `base^{'}` which KaTeX cannot parse
3. `renderFunc()` unwraps braces around function names: `{log}_3` → `\log_3`
4. `mapText()` uses `DYN` table to apply corpus-tuned spellings (`≤` → `CONV.leq` which is `\leq`)

---

### `src/docx.js` — DOCX → text with math

Uses `fflate` (in-browser unzip) to open the `.docx` as a zip, reads `word/document.xml`, walks it in document order:
- `<m:oMath>` / `<m:oMathPara>` → calls `ommlToLatex()` → wraps as `$...$`
- `<w:t>` → text content
- `<w:tab>` → `\t`
- `<w:br>` / `<w:cr>` → `\n`
- `<w:tbl>` → table rows flattened, cells tab-separated (used for topic/difficulty metadata rows)
- All other nodes: descend (hyperlinks, smartTags, etc.)

**Why not mammoth?** mammoth silently drops OMML. A sample DOCX had 522 OMML math objects — all would be lost.

---

### `src/parse.js` — Structural parser

Input: plain text string (with `$LaTeX$` already inline)
Output: array of `{ title, options: {A,B,C,D}, correct, answerValue, explanation, topic, difficulty }`

This file was rewritten to absorb the **many different raw layouts** the Knowledge
Team uses (validated against all 17 files in `Sample Raw File on Many Patterns/`).
The same logical field shows up spelled many ways; every variant below is matched:

| Field | Variants handled |
|---|---|
| **Answer marker** | `উত্তর`, `সঠিক উত্তর`, `Answer`, `Ans`, `Correct Answer/Option`, `Uttor`, `Sothik Uttor/Answer` — sep `: ： ঃ . -`; Bengali markers tolerate a missing separator |
| **Answer letter** | `B.`, `(ঘ)`, `গ)` (paren-wrapped, Bengali); if only a *value* is given (`উত্তর: $value$`) the letter is recovered by matching the value to an option |
| **Explanation** | `ব্যাখ্যা`, `সমাধান`, `Solution`, `Explanation` (+ the `ব্যাখ্য্যা` typo) |
| **Difficulty** | `[E]/[M]/[H]`, `[Easy]/[Medium]/[Hard]`, a trailing `EASY/MEDIUM/HARD` word, `Difficulty Level: X`, `[Medium, Topic: …]` — normalized to `Easy/Medium/Hard` |
| **Options** | `A.` / `A)` and Bengali `ক)/খ)/গ)/ঘ)`; one- or many-per-line tab/wide-space separated |
| **Topic (stripped)** | `[Topic: …]`, bracketed `[5.1 …]`, standalone `5.1<tab>name` lines, a bare `Topic:` line + the section line — removed from the question (UI fills topic from the metadata panel) |

**Question splitting:** `splitQuestions()` splits on a line that starts with a
Bengali/ASCII number + `। . )`, with a negative lookahead `(?![০-৯0-9])` so a
section number like `6.4` never starts a new question. Handles the question
number sitting alone on its own line (figure questions).

**Robustness rules worth keeping:**
- Standalone section-topic lines require a **tab** (`3.1<tab>name`) — this is what
  distinguishes a topic row from a stem that opens with a decimal (`8. 30 kg …`,
  `২. 2.5 সে.মি. …`). Equation lines (`=`/`$`) are also excluded.
- `replaceOutsideMath()` strips bracket meta only **outside** `$…$`, so LaTeX
  brackets/braces (`$\left[ {MLT}^{-2} \right]$`) are never disturbed.
- A trailing bare difficulty word is only stripped when the line carries Bengali
  or the word is ALL CAPS, so an English stem ending in "…hard?" survives.
- `parseRaw()` keeps only blocks with **≥2 options**, dropping file titles, count
  headers (`EASY MEDIUM HARD`), and passage preambles.

**Validation tools** (`tools/`): `dump.mjs` extracts docx → text; `check.mjs`
parses every sample and reports per-file quality (no-title / <4opts / no-correct
/ with-difficulty / with-exp / meta-leak); `inspect.mjs` dumps a single file's
parsed questions. Re-run `node tools/check.mjs` after any parser change.

---

### `src/style.js` — Normalization + row building

**`toCmsRow(q, style)`** — maps parsed question → CMS preview row:
- Normalizes all text fields (trim, `$num$` → `num` if `unwrapNumbers`)
- Trims spacing inside `$...$` only, never touches spaces between math and Bangla text (critical — earlier a bug stripped Bangla spacing)
- `Solution` column = `<answer value> ব্যাখ্যা: <explanation>`
- Options prefixed with `A. `, `B. `, etc. in the preview (stripped again in `buildAutoRow()` for export)

**`hasMath(fields)`** — returns `'Yes'`/`'No'` based on whether any field contains `$...$` or a LaTeX command.

**`similarity(a, b)`** — Jaccard token similarity for duplicate detection (threshold 0.92).

**`buildCorpus(cmsRows, corrections)`** — builds in-memory corpus from user-saved corrections. Reviewed corrections take precedence over CMS rows on ties.

**`attachNearest(row, corpus)`** — finds closest corpus match, attaches `_matchScore`, `_matchTitle`, `_duplicate`.

---

### `src/db.js` — IndexedDB persistence

IndexedDB name: `cms_formatter`, store: `datasets`, key: `subject`

Stores per subject: `{ subject, cfg, corrections, unwrapNumbers, updatedAt }`

**Important:** Reference rows were removed from IndexedDB. Only `cfg` (metadata defaults) and `corrections` (user-reviewed rows saved as training) persist. All calls are wrapped in try/catch — if IndexedDB is unavailable the app falls back to defaults gracefully.

---

### `src/main.jsx` — React UI

**CMS Auto-Input columns (exact, must match for upload):**
```js
['class','group','subject','chapter','topic','title','option_a','option_b',
 'option_c','option_d','correct_option','solution','difficulty_level',
 'has_math_equation','allocated_time','allocated_marks',
 'question_source_category','question_type','is_active','markdown_version','description']
```

**Default metadata (editable in UI, filled from sample file):**
```js
{ class:'Class 6', group:'', subject:'ICT', chapter:'test', topic:'test',
  difficulty_level:'Easy', allocated_time:'1', allocated_marks:'',
  question_source_category:'Engineering', question_type:'MCQ',
  is_active:'true', markdown_version:'1', description:'' }
```

**Key flows:**
1. On mount: unions `KNOWN_SUBJECTS` (from `knowledge.json`) + IndexedDB subjects; restores last-used subject from `localStorage`
2. `loadSubject(name)` → loads cfg + corrections from IndexedDB for that subject
3. `loadDocx(file)` → `file.arrayBuffer()` → `docxToText()` → sets `raw`
4. `format()` → `parseRaw(raw)` → `toCmsRow()` → `attachNearest()` → `setRows()`
5. `buildAutoRow(r)` → maps preview row to 21-column Auto-Input schema; strips `A. ` prefix from options
6. `exportCSV()` / `exportXLSX()` → downloads file in CMS-ready format
7. `saveAsTraining()` → pushes current rows to `corrections` → triggers IndexedDB persist

**`applyConventions(knowledge.conventions)`** is called at module level (before any render) — this wires the corpus-learned LaTeX spellings into the OMML converter globally.

---

### `src/style.css` — Shikho brand UI

Follows Shikho brand guidelines from `Shikho - Claude Design - Brand Template.pdf`.

**Color tokens:**
```css
--indigo:#304090;    /* primary — 70% of screen */
--magenta:#C02080;   /* accent */
--sunrise:#E0A010;   /* warning/highlight */
--coral:#E03050;     /* danger/error */
--ink-900:#0F1322;   /* body text */
```

**Rules:**
- All interactive surfaces: rounded corners (minimum `--r-sm: 8px`; buttons use `--r-pill: 999px`)
- Sharp corners are banned
- Fonts: `Poppins` for headings/UI labels, `Hind Siliguri` for Bengali/body text
- Table headers: indigo background, white text, sticky top
- Duplicate rows: sunrise-50 highlight

---

### `tools/train.mjs` — Cumulative offline trainer

```bash
node tools/train.mjs "filename.csv"             # append to existing corpus
node tools/train.mjs --reset "filename.csv"     # start corpus fresh
node tools/train.mjs --force "filename.csv"     # re-count already-trained file
node tools/train.mjs "file1.csv" "file2.csv"    # multiple files in one run
```

**What it learns per file:**
- `question_title` presence → question count
- `has_math_equation` → math question count
- `option_a/b/c/d` values → plain number vs `$dollar$` number style (per subject + global)
- All text fields → LaTeX variant counts (`\leq` vs `\le`, etc.)
- Per-subject: `{ count, plain, dollar }`

**Closure bug (already fixed):** Earlier version used `makeGetter(firstRow)` which closed over the first row only. Fixed with stateless `get(row, name)` function that takes the current row as argument.

After training, always run `npm run build` to bundle the updated `knowledge.json` into the app.

---

## Bugs fixed in previous sessions (do not re-introduce)

| Bug | Root cause | Fix location |
|---|---|---|
| All math dropped from DOCX | mammoth drops OMML | Replaced with fflate + custom `docx.js` + `omml.js` |
| `$A={x :x\in \mathbb{N}$` parse error | Literal `{` in OMML text run emitted unescaped | `SYMBOLS` map in `omml.js`: `'{': '\\{'` |
| `{\mathbb{Q}}^'` KaTeX error | Prime superscript emitted as `^{'}` | `renderSup()` in `omml.js` detects prime chars |
| `{log}_3` instead of `\log_3` | `renderFunc` didn't unwrap braces | `name.replace(/^\{?([A-Za-z]+)\}?/, ...)` |
| Options B and D missing (two-per-line) | Author put two options on one tab-separated line | `splitInlineOptions()` in `parse.js` |
| Trainer counts all zero | Getter closed over first row | Replaced with stateless `get(row, name)` in `train.mjs` |
| Bangla spaces stripped from math | `$\s+` regex stripped spaces before Bangla text | `normalizeMathField()` trims only inside `$...$` |
| Subject init fails silently | IndexedDB unavailable threw uncaught error | All `db.js` calls wrapped in try/catch in `main.jsx` |
| Explanation never split out (merged into answer) | `ব্যাখ্য্?যা` regex was malformed — it required a doubled `য` and never matched plain `ব্যাখ্যা` | `ব্যাখ্য(?:্য)?া` in `EXP_RE` (`parse.js`) |
| `ক)/খ)/গ)/ঘ)` option files fully unparsed (e.g. BGS) | Only `[A-D]` markers recognized | Bengali option letters mapped to A–D in `parse.js` |
| Topic lines became junk question rows | Section number `3.1` matched the question-start split | `(?![০-৯0-9])` lookahead + tab-required topic rule |
| Difficulty/topic tags leaked into the title | Only whole-bracket lines were treated as meta | `stripInlineMeta()` pulls inline `[E]`/`[Topic:…]`/trailing `EASY` from stem & answer lines |

---

## What the user expects from this tool

1. Upload a `.docx` from the Knowledge Team → all math converts correctly to `$LaTeX$`
2. Review the question table with live KaTeX math preview
3. Edit any cell inline
4. Export CSV/XLSX that matches the CMS Auto-Input schema exactly (21 columns, lowercase headers) — can be uploaded directly to CMS
5. Save reviewed rows as corrections → they become reference examples for that subject in future sessions
6. Subject-specific settings persist across sessions (cfg + corrections in IndexedDB)
7. No reference file upload needed — the corpus is background knowledge

---

## What is NOT implemented (scope)

- Detected duplicates: the `_duplicate` flag works via Jaccard similarity but the corpus in memory is only from the user's own saved corrections (not the full 159k CMS questions — those are too large for browser memory)
- The training calibrates style conventions only. It does not give the AI "knowledge" of what correct questions look like
- Very unusual OMML (large matrices, nested equation arrays) converts best-effort — user should eyeball math preview before uploading

---

## Pending / next steps

- User will drop more CMS export CSV files (Class 10, Class 12, Physics, Chemistry, Biology, English, etc.) into the working folder one by one. For each:
  ```bash
  node tools/train.mjs "<filename>.csv"
  npm run build
  ```
- Target: ~239,800 total questions (currently at 159,540)
- If a specific question converts incorrectly, user will paste it and the OMML converter rule needs to be fixed in `src/omml.js`

---

## Quick reference: running the project

```bash
# Install (first time only)
npm install

# Dev server
npm run dev
# → http://localhost:5173

# Train on a new CMS export
node tools/train.mjs "Class 10 - All Converted MCQ.csv"
npm run build

# Build for production
npm run build
```

**Tech stack:** React 18, Vite, fflate, KaTeX, xlsx, PapaParse, IndexedDB
**Node version:** whatever is installed (no specific constraint found)
**No backend** — fully client-side, runs offline after `npm run dev`
