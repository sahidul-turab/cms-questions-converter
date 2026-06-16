# CMS Question Formatter

A local, browser-based tool that converts raw Knowledge-Team question files into
the exact structure and LaTeX formatting used by the Shikho CMS.

## Pre-trained on the CMS corpus (no reference upload)

The app ships a distilled **knowledge base** ([src/knowledge.json](src/knowledge.json))
built offline from the full CMS export by [tools/train.mjs](tools/train.mjs).
At startup the app applies the CMS LaTeX conventions it learned (e.g. arrow
`\to` vs `\rightarrow`, `\frac` vs `\dfrac`, `\leq` vs `\le`, pure-number
wrapping) to every conversion. There is **no reference-file upload in the UI** —
the corpus is background knowledge, not something the team loads each time.

Training is **cumulative** — feed exports one at a time as you download them and
each run adds to the corpus (a file already trained is skipped):

```bash
node tools/train.mjs "Class 6 - All Converted MCQ.csv"   # adds to knowledge.json
node tools/train.mjs "Class 7 - All Converted MCQ.csv"   # adds on top
node tools/train.mjs --reset file.csv                    # start the corpus over
node tools/train.mjs --force file.csv                    # re-count an already-trained file
npm run build                                            # ship the updated knowledge
```

The trainer streams each CSV (handles very large files) and keeps only
aggregates — never the questions themselves — so `knowledge.json` stays a few KB.
The `Subject` column drives the subject list and per-subject number style;
`Class` is ignored (it is not a meaningful field for formatting).

## Why this is not "just a regex parser"

The raw `.docx` files store every equation as **Word OMML** (Office Math
Markup) objects, *not* as text. A plain text reader (the old approach) silently
**drops all the math** — which in these files is most of the question. This tool:

1. **Unzips the `.docx` and walks `document.xml` in order**, converting each OMML
   object to CMS-style `$LaTeX$` (`src/omml.js`, `src/docx.js`). Covers fractions,
   radicals (incl. `\sqrt[n]{}`), super/subscripts, delimiters (parentheses,
   absolute value, set braces, intervals, cases via `\right.`), n-ary operators
   (∫, ∑, ∏), functions (`\sin`, `\log_3`, …), accents, blackboard sets
   (`\mathbb{R}`), Greek letters, and the full math symbol set.
2. **Parses structure with rules** (`src/parse.js`): question number, options
   (including two-per-line tab-separated layouts), `উত্তর:` answer, and
   `ব্যাখ্যা:` explanation.
3. **Learns formatting style from your CMS CSV** (`src/style.js`): the CMS export
   is the source of truth. It learns conventions (e.g. whether pure numbers are
   written `0` or `$0$`), normalizes output to match, builds the CMS `Solution`
   string (`<answer> ব্যাখ্যা: <explanation>`), and attaches the **closest
   existing CMS example** to each row so you can compare style and catch
   duplicates.

## Generated fields (current scope)

Question Title · Option A–D · Correct Option · Solution · Has Math Equation.
All other CMS columns are filled from the **Default metadata** panel so the
exported file matches the CMS header and can be uploaded directly.

## Run locally

```bash
npm install
npm run dev      # open the localhost URL
```

## Workflow

1. **CMS reference data** — upload one or more downloaded CMS CSVs (source of
   truth + training). Reference rows stay in memory for the session.
2. **Default metadata** — set Subject, Category, etc.
3. **Raw input** — upload a `.docx` (math auto-converts to `$LaTeX$`) or paste text.
4. **Format** — review the editable table. The KaTeX preview renders each math
   field so you can eyeball correctness; possible duplicates are highlighted.
5. **Save corrections as training** — reviewed rows persist to browser storage
   and become reference examples for future runs.
6. **Download CSV / XLSX** — full CMS-column output.

## Architecture

| File | Responsibility |
|------|----------------|
| `src/omml.js`  | OMML DOM node → LaTeX (style-matched to CMS) |
| `src/docx.js`  | `.docx` (zip) → text with inline `$LaTeX$`, in document order |
| `src/parse.js` | structured question extraction (rules) |
| `src/style.js` | CMS style learning, normalization, has-math, example matching |
| `src/main.jsx` | React UI: upload, preview/edit, train, export |

The OMML converter and parser run against the standard DOM API, so they are
unit-testable in Node (`@xmldom/xmldom`) and run unchanged in the browser
(native `DOMParser`).

## Limitations

- Very unusual OMML (large matrices, nested equation arrays) converts
  best-effort — always check the math preview before uploading.
- CMS reference is kept in memory per session (not persisted) because the export
  files are large; reviewed corrections *are* persisted in `localStorage`.
