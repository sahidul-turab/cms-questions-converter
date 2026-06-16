// CMS style learning + normalization + example matching.
//
// The CMS export is the "source of truth": we (1) learn a couple of style
// preferences from it, (2) normalize parsed questions toward that style, and
// (3) attach the closest existing CMS example to each output row so a human
// reviewer can compare formatting and catch duplicates.

const MATH_FIELDS = ['Question Title', 'Option A', 'Option B', 'Option C', 'Option D', 'Solution'];

// ---- text similarity (token Jaccard) -------------------------------------
const BN_DIGITS = '০১২৩৪৫৬৭৮৯';
function normalizeForMatch(s) {
  return String(s || '')
    .replace(/[০-৯]/g, (d) => BN_DIGITS.indexOf(d))
    .toLowerCase()
    .replace(/\$/g, ' ')
    .replace(/\\[a-z]+/gi, ' ')
    .replace(/[।.,;:()[\]{}|^_+\-*/\\=<>]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}
function tokens(s) {
  return normalizeForMatch(s).split(' ').filter((t) => t.length > 1);
}
export function similarity(a, b) {
  const A = new Set(tokens(a));
  const B = new Set(tokens(b));
  if (!A.size || !B.size) return 0;
  let inter = 0;
  A.forEach((t) => { if (B.has(t)) inter++; });
  return inter / (A.size + B.size - inter);
}

// ---- style learning from CMS rows ----------------------------------------
const PLAIN_NUM = /^-?\d+(\.\d+)?$/;
const DOLLAR_NUM = /^\$\s*-?\d+(\.\d+)?\s*\$$/;

export function learnStyle(cmsRows) {
  let plain = 0, dollar = 0;
  for (const r of cmsRows) {
    for (const k of ['Option A', 'Option B', 'Option C', 'Option D']) {
      const body = String(r[k] || '').replace(/^[A-D]\.\s*/, '').trim();
      if (!body) continue;
      if (PLAIN_NUM.test(body)) plain++;
      else if (DOLLAR_NUM.test(body)) dollar++;
    }
  }
  return {
    sampleSize: cmsRows.length,
    plainNumberOptions: plain,
    dollarNumberOptions: dollar,
    // Default: unwrap pure-number math if CMS leans that way (it does ~2:1).
    unwrapNumbers: plain >= dollar,
  };
}

// ---- normalization --------------------------------------------------------
function stripDollarsAroundNumbers(s) {
  // "$0$" -> "0", "$-2.5$" -> "-2.5"; leaves real math untouched.
  return String(s).replace(/\$\s*(-?\d+(?:\.\d+)?)\s*\$/g, '$1');
}

function normalizeMathField(s, opts) {
  let x = String(s || '').replace(/\s+/g, ' ').trim();
  if (opts.unwrapNumbers) x = stripDollarsAroundNumbers(x);
  // Tidy spacing ONLY inside each $...$ segment ("$ x $" -> "$x$"); never
  // touch the spaces between math and surrounding Bangla text.
  x = x.replace(/\$([^$]*)\$/g, (m, inner) => '$' + inner.trim() + '$');
  return x.trim();
}

function hasMath(fields) {
  const joined = fields.join('  ');
  // Any remaining $...$ (numbers already unwrapped) or a bare LaTeX command.
  return /\$[^$]+\$/.test(joined) || /\\[A-Za-z]+/.test(joined) ? 'Yes' : 'No';
}

// Build the in-scope CMS row from a parsed question + chosen style.
export function toCmsRow(q, style) {
  const opts = style || { unwrapNumbers: true };
  const norm = (s) => normalizeMathField(s, opts);

  const optVal = {
    A: norm(q.options.A),
    B: norm(q.options.B),
    C: norm(q.options.C),
    D: norm(q.options.D),
  };
  const answerValue = norm(q.answerValue || (q.correct && optVal[q.correct]) || '');

  // CMS solution = <answer value> ব্যাখ্যা: <explanation>
  const explanation = norm(q.explanation);
  let solution = answerValue;
  if (explanation) solution = (solution ? solution + ' ' : '') + 'ব্যাখ্যা: ' + explanation;

  const fields = {
    'Question Title': norm(q.title),
    'Option A': optVal.A ? 'A. ' + optVal.A : '',
    'Option B': optVal.B ? 'B. ' + optVal.B : '',
    'Option C': optVal.C ? 'C. ' + optVal.C : '',
    'Option D': optVal.D ? 'D. ' + optVal.D : '',
    'Correct Option': q.correct || '',
    'Solution': solution.trim(),
  };
  fields['Has Math Equation'] = hasMath([
    fields['Question Title'], fields['Option A'], fields['Option B'],
    fields['Option C'], fields['Option D'], fields['Solution'],
  ]);
  return fields;
}

// ---- example matching -----------------------------------------------------
// corpus: [{ title, row }]
export function buildCorpus(cmsRows, corrections = []) {
  const fromCms = cmsRows
    .filter((r) => r['Question Title'])
    .map((r) => ({ title: r['Question Title'], row: r, source: 'cms' }));
  const fromFix = corrections
    .filter((r) => r['Question Title'])
    .map((r) => ({ title: r['Question Title'], row: r, source: 'reviewed' }));
  return [...fromFix, ...fromCms]; // reviewed corrections take precedence on ties
}

export function attachNearest(row, corpus) {
  let best = null;
  let score = 0;
  for (const ex of corpus) {
    const s = similarity(row['Question Title'], ex.title);
    if (s > score) { score = s; best = ex; }
  }
  return {
    ...row,
    _matchScore: score ? score.toFixed(2) : '',
    _matchSource: best ? best.source : '',
    _matchTitle: best ? best.title : '',
    _matchSolution: best ? best.row['Solution'] || '' : '',
    _duplicate: score >= 0.92 ? 'Yes' : '',
  };
}

export { MATH_FIELDS };
