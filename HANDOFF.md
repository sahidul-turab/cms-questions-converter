# CMS Question Formatter — Agent Handoff Document

**Project owner:** sahidul.turab@shikho.com (Shikho Knowledge Team)
**Working directory:** `c:\Users\Shikho\Downloads\cms-question-formatter v2\cms-question-formatter`
**GitHub repo:** https://github.com/sahidul-turab/cms-questions-converter
**Vercel:** auto-deploys from `main` branch on GitHub push
**Dev server:** `http://localhost:5173` (run `npm run dev` to start)
**Last updated:** 2026-06-17

---

## What this project is

A **local, browser-based tool** that converts raw Knowledge Team `.docx` files (Bengali + English mixed, heavily math-laden) into the exact 21-column CSV schema that the Shikho CMS accepts for direct upload (`Sample Structure for CMS Auto Input.csv`).

The core problem it solves: Word DOCX files store all math as **OMML (Office Math Markup Language)** — a proprietary XML format. Any plain text reader (e.g. `mammoth`) silently **drops all math**. This tool unzips the DOCX, walks `word/document.xml`, and converts every OMML object to CMS-style `$LaTeX$` inline.

---

## Deployment

**GitHub:** https://github.com/sahidul-turab/cms-questions-converter
**Vercel:** wired to the `main` branch — a `git push origin main` triggers a redeploy automatically.

`vercel.json` specifies:
```json
{
  "framework": "vite",
  "buildCommand": "npm run build",
  "outputDirectory": "dist",
  "installCommand": "npm ci"
}
```

**Important:** `npm ci` (not `npm install`) is used on Vercel so dependency versions are frozen from `package-lock.json`. Never use `"latest"` version specifiers in `package.json` — they caused Vercel's install to hang (npm re-resolves against the registry and the process never exits). All dependencies are pinned to specific semver ranges.

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
│   ├── parse.js         # Rule-based structural parser (splits Q/options/answer/explanation/topics)
│   ├── style.js         # Normalization, has-math detection, Jaccard similarity, CMS row builder
│   ├── db.js            # IndexedDB per-subject persistence (cfg + corrections)
│   ├── main.jsx         # React UI (taxonomy dropdowns, TopicCell, preview table)
│   ├── style.css        # Shikho brand CSS (includes topic cell styles)
│   ├── knowledge.json   # Distilled corpus (aggregates only, ~7 KB)
│   └── taxonomy.json    # Merged CMS taxonomy — C6/C7/C8/SSC/HSC (~5 MB)
├── tools/
│   ├── train.mjs                  # Offline cumulative trainer
│   ├── merge-taxonomy.mjs         # Merges Taxonomy/*.json → src/taxonomy.json
│   ├── taxonomy-exporter.user.js  # Tampermonkey script to export taxonomy from live CMS
│   ├── dump.mjs                   # Extracts DOCX → text for debugging
│   ├── check.mjs                  # Validates all sample files against the parser
│   └── inspect.mjs                # Dumps parsed questions for one file
├── Taxonomy/
│   ├── C6 - taxonomy.json              # Class 6 snapshot (14 subjects, 668 topics)
│   ├── C7 - taxonomy.json              # Class 7 snapshot (14 subjects, 791 topics)
│   ├── C8 - taxonomy.json              # Class 8 snapshot (25 subjects, 1405 topics)
│   ├── SSC (C9,10) - taxonomy.json    # Class 9-10 snapshot (94 subjects, 5813 topics)
│   └── HSC (C11,12) - taxonomy.json   # Class 11-12 snapshot (111 subjects, 9421 topics)
├── Sample Raw File on Many Patterns/  # 17 sample .docx files covering all observed layouts
├── public/
│   └── shikho-logo.png  # Brand logo (white BG knocked out)
├── index.html           # Poppins + Hind Siliguri fonts from Google Fonts
├── vercel.json          # Vercel deployment config (framework: vite, installCommand: npm ci)
├── .gitignore           # Excludes node_modules, dist, .vercel, *.csv (except sample), tools/_dump
├── package.json         # Pinned deps, engines: node >=20.19, taxonomy script
├── package-lock.json    # Lockfile — critical for npm ci on Vercel
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
Output: array of `{ title, options: {A,B,C,D}, correct, answerValue, explanation, topics: [{no, name}], topic, difficulty }`

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
| **Topic (extracted)** | `[Topic: …]`, bracketed `[5.1 …]`, standalone `5.1<tab>name` lines, a bare `Topic:` line + the section line — extracted into `topics: [{no, name}]` array, section number stripped from output |

**Question splitting:** `splitQuestions()` splits on a line that starts with a
Bengali/ASCII number + `। . )`, with a negative lookahead `(?![০-৯0-9])` so a
section number like `6.4` never starts a new question. Handles the question
number sitting alone on its own line (figure questions).

**Topic multi-split:** `splitTopics(s)` splits on comma/semicolon **only when followed
by a section number** (`9.2 X, 9.5 Y` → two topics; `রক্ত, রক্তের উপাদান, লসিকা` stays
together). `topicParts(t)` separates `{no: "4.1", name: "রক্ত, রক্তের উপাদান, লসিকা"}`.

**Robustness rules worth keeping:**
- Standalone section-topic lines require a **tab** (`3.1<tab>name`) — this is what
  distinguishes a topic row from a stem that opens with a decimal (`8. 30 kg …`,
  `২. 2.5 সে.মি. …`). Equation lines (`=`/`$`) are also excluded.
- `replaceOutsideMath()` strips bracket meta only **outside** `$…$`, so LaTeX
  brackets/braces (`$\left[ {MLT}^{-2} \right]$`) are never disturbed.
- A trailing bare difficulty word is only stripped when the line carries Bengali
  or the word is ALL CAPS, so an English stem ending in "…hard?" survives.
- `parseRaw()` keeps only blocks with >=2 options, dropping file titles, count
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

### `src/taxonomy.json` — Merged CMS taxonomy

Generated by `npm run taxonomy` (`tools/merge-taxonomy.mjs`). Contains all 5 class snapshots:

| Class label(s) | Enum | Groups | Subjects | Chapters | Topics |
|---|---|---|---|---|---|
| Class 6 | C6 | — (no group) | 14 | 156 | 668 |
| Class 7 | C7 | — (no group) | 14 | 164 | 791 |
| Class 8 | C8 | — (no group) | 25 | 287 | 1405 |
| Class 9, Class 10 | SSC | Science / Humanities / Business Studies | 94 | 1088 | 5813 |
| Class 11, Class 12 | HSC | Science / Humanities / Business Studies | 111 | 1383 | 9421 |
| **Total** | | | **258** | **3078** | **18098** |

The file is ~5 MB — bundled into the Vite build and loaded at runtime. The chunk-size warning from Vite is expected and non-fatal.

**To add or refresh a class snapshot:**
1. Install `tools/taxonomy-exporter.user.js` in Tampermonkey, open `cms.shikho.com`, do one action (session token is captured), click *Build & download taxonomy.json*.
2. Rename the downloaded file (e.g. `C9 - taxonomy.json`) and drop it into `Taxonomy/`.
3. `npm run taxonomy` — rebuilds `src/taxonomy.json` (later files win per enum).
4. `npm run build` then `git add src/taxonomy.json Taxonomy/<new-file>.json && git commit && git push`.

---

### `src/main.jsx` — React UI

**Tech stack:** React 19, Vite 8, fflate, KaTeX, xlsx, PapaParse, IndexedDB

**CMS Auto-Input columns (exact, must match for upload):**
```js
['class','group','subject','chapter','topic','title','option_a','option_b',
 'option_c','option_d','correct_option','solution','difficulty_level',
 'has_math_equation','allocated_time','allocated_marks',
 'question_source_category','question_type','is_active','markdown_version','description']
```

**Taxonomy helpers** (all derived from `src/taxonomy.json`):
- `taxGroupsFor(classLabel)` — returns groups for the class (e.g. `['Science', 'Humanities', 'Business Studies']` for SSC/HSC; `['']` for C6-C8)
- `taxNeedsGroup(classLabel)` — true when the class has multiple groups (C6-C8 return false; SSC/HSC return true)
- `taxSubjects(classLabel, group)` — subject list; for SSC/HSC the `group` arg is required
- `taxChapters(classLabel, group, subjectName)` — chapter list
- `taxAllTopics(classLabel, group, subjectName)` — flat list of `{no, name, chapter}` across all chapters of the subject; used as the candidate set for per-question topic matching

**Topic matching (`matchTopic(docTopic, taxTopics)`):**
1. If `docTopic.no` is set, find a taxonomy entry with the exact same section number → **matched** (green, canonical name)
2. Else try exact normalized-name match → **matched**
3. Else compute token Jaccard similarity against all entries; if best score >= 0.5 → **suggested** (amber, one-click confirm)
4. No match → **doc** (grey, free-text input from doc)

**`TaxonomyPicker` component:** cascading Class → Group → Subject → Chapter dropdowns.
- Group picker is enabled for Class 9-12 (SSC/HSC), disabled/shows "— not used —" for C6-C8
- Chapter onChange does NOT reset topic (topic is per-question, not global)

**`TopicCell` component:** per-row topic editor in the preview table.
- Reads `row._docTopics` (raw from parser) and `row._topics` (matched names, mutable by user)
- Shows a badge (check/tilde/pencil) per topic slot, then either a taxonomy `<select>` (when subject has taxonomy) or a free-text `<input>` (no taxonomy loaded for that class)
- `+ topic` button to add another slot; `x` to remove
- Export joins `_topics` with `; ` as the `topic` column value

**Key flows:**
1. On mount: unions `KNOWN_SUBJECTS` (from `knowledge.json`) + IndexedDB subjects; restores last-used subject from `localStorage`
2. `loadSubject(name)` → loads cfg + corrections from IndexedDB for that subject
3. `loadDocx(file)` → `file.arrayBuffer()` → `docxToText()` → sets `raw`
4. `format()` → `parseRaw(raw)` → `toCmsRow()` → `matchTopic()` per question → `attachNearest()` → `setRows()`
5. `buildAutoRow(r)` → maps preview row to 21-column Auto-Input schema; strips `A. ` prefix from options; topic = `r._topics.join('; ')` (or `r['Topic(s)']` fallback)
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

**Topic cell classes (appended at end of file):**
- `.topiccell` — container for per-row topic editor
- `.topicrow` — one badge + input/select row
- `.tbadge.ok` — green (#1f9d55) for matched topics
- `.tbadge.warn` — sunrise (#E0A010) for suggested topics
- `.tbadge.doc` — ink-300 for free-text doc topics
- `.tdel` / `.tadd` / `.thint` — remove/add buttons and hint text

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

### `tools/merge-taxonomy.mjs` — Taxonomy merger

```bash
npm run taxonomy
# equivalent to: node tools/merge-taxonomy.mjs
```

Reads every `*.json` from `Taxonomy/` in alphabetical order, merges them into `src/taxonomy.json`. Later files win per class enum. Prints a per-file summary with subject/chapter/topic counts. After running, restart the dev server or do `npm run build`.

---

### `tools/taxonomy-exporter.user.js` — Tampermonkey userscript

Install in Tampermonkey. Opens on `cms.shikho.com`. Captures the session token automatically on first CMS action, then walks Class → Group → Subject → Chapter → Topic via GraphQL. Click the *Build & download taxonomy.json* button; the file downloads named after the class (e.g. `C6 - taxonomy.json`). Drop into `Taxonomy/` and run `npm run taxonomy`.

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
| Explanation never split out (merged into answer) | EXP_RE regex was malformed — required a doubled ya and never matched plain Bengali explanation marker | Fixed regex in `EXP_RE` in `parse.js` |
| `ক)/খ)/গ)/ঘ)` option files fully unparsed (e.g. BGS) | Only `[A-D]` markers recognized | Bengali option letters mapped to A-D via `BN_OPT` + `optLetterToLatin()` in `parse.js` |
| Topic lines became junk question rows | Section number `3.1` matched the question-start split | Negative lookahead + tab-required topic rule in `parse.js` |
| Difficulty/topic tags leaked into the title | Only whole-bracket lines were treated as meta | `stripInlineMeta()` pulls inline `[E]`/`[Topic:…]`/trailing `EASY` from stem & answer lines |
| `Medium, Topic :` prefix leaked into topic value | Periodic-table file embedded difficulty+topic in one bracket | `cleanTopicText()` strips leading difficulty word and `Topic:` prefix |
| Parenthesized answer letters not parsed | `ANS_LETTER_RE` did not allow leading parenthesis | Updated regex to allow `(` or `[` prefix before the answer letter |
| Answer with value only (no letter) never matched | Post-processing step missing | If `!ansLetter && answerValue`, match value text against all option texts |
| Vercel build hangs (~8 min, "Exit handler never called") | `"latest"` npm specifiers caused registry re-resolution at install | Pinned all deps; switched to `npm ci` in `vercel.json` |

---

## What the user expects from this tool

1. Upload a `.docx` from the Knowledge Team → all math converts correctly to `$LaTeX$`
2. Review the question table with live KaTeX math preview
3. Edit any cell inline; per-question topics shown with taxonomy match status (green matched / amber suggested / grey from-doc)
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
- More taxonomy class snapshots can be added at any time using the Tampermonkey exporter → `Taxonomy/` → `npm run taxonomy` → build → push
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

# Rebuild taxonomy after adding a new Taxonomy/*.json
npm run taxonomy
npm run build

# Build for production
npm run build

# Push to GitHub (triggers Vercel redeploy)
git add <files>
git commit -m "..."
git push origin main
```

**Tech stack:** React 19, Vite 8, fflate, KaTeX, xlsx, PapaParse, IndexedDB
**Node version:** >=20.19 (set in `package.json` `engines` field)
**No backend** — fully client-side, runs offline after `npm run dev`
