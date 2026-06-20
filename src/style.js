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

// ---- Bengali-in-math helpers -----------------------------------------------
const BENGALI_RE = /[ঀ-৿]/;

// Convert one \begin{matrix} row (with & column separators) to an inline
// "$math$ Bengali" format. Bengali words are moved outside $...$.
function matrixRowToInline(rowContent) {
  const content = rowContent.split(/\s*&\s*/).map(c => c.trim()).filter(Boolean).join(' ');
  if (!content) return null;
  if (!BENGALI_RE.test(content)) return '$' + content + '$';

  let result = '';
  let mathBuf = '';
  let i = 0;

  function flushMath() {
    const m = mathBuf.trim();
    if (m) result += (result ? ' ' : '') + '$' + m + '$';
    mathBuf = '';
  }

  while (i < content.length) {
    const cp = content.codePointAt(i);
    if (cp >= 0x0980 && cp <= 0x09FF) {
      flushMath();
      let bnBuf = '';
      while (i < content.length) {
        const c2 = content.codePointAt(i);
        if (c2 >= 0x0980 && c2 <= 0x09FF) {
          bnBuf += content[i++];
        } else if ((content[i] === ' ' || content[i] === ',') &&
                   i + 1 < content.length && content.codePointAt(i + 1) >= 0x0980) {
          bnBuf += content[i++];
        } else if (content[i] === '.' &&
                   i + 1 < content.length && content.codePointAt(i + 1) >= 0x0980) {
          bnBuf += content[i++]; // dot inside abbreviation e.g. সে.মি.
        } else {
          break;
        }
      }
      if (i < content.length && content[i] === '.') bnBuf += content[i++]; // trailing dot
      const bn = bnBuf.trim();
      if (bn) result += (result ? ' ' : '') + bn;
    } else {
      mathBuf += content[i++];
    }
  }
  flushMath();
  return result.trim() || null;
}

// Replace $\begin{matrix}...\end{matrix}$ blocks with individual lines so
// Bengali text stays outside $...$ and alignment columns become spaces.
function replaceMatrixBlocks(s) {
  return s.replace(/\$\\begin\{[A-Za-z]*matrix\}([\s\S]*?)\\end\{[A-Za-z]*matrix\}\$/g,
    (_, inner) => {
      const rows = inner.split(/\s*\\\\\s*/);
      const lines = rows.map(r => matrixRowToInline(r)).filter(Boolean);
      return lines.join('\n');
    });
}

// Replace $\&=expr \quad \&=expr$ alignment artifacts (from OMML column math)
// with individual $=expr$ lines.
function replaceAmpersandAlignment(s) {
  return s.replace(/\$([^$]*\\&[^$]*)\$/g, (_, inner) => {
    const parts = inner
      .split(/\s*\\quad\s*|\s+(?=\\&)/)
      .map(p => p.replace(/^\\&/, '').trim())
      .filter(Boolean);
    if (parts.length <= 1) return '$' + inner + '$';
    return parts.map(p => '$' + p + '$').join('\n');
  });
}

// Try to extract Bengali text at the very END of a math segment.
// Returns {math, bangla} so Bengali units (সে.মি., একক…) move outside $...$
// instead of being wrapped in \text{}. Returns null if Bengali is embedded
// (inside braces) or the whole content is Bengali.
function extractEndBengali(mathContent) {
  // Match a Bengali run (chars + inter-word spaces + dot-abbreviations) at the end
  const m = mathContent.match(/([ঀ-৿](?:[ \t,.]*[ঀ-৿])*\.?)\s*$/);
  if (!m) return null;
  const mathPart = mathContent.slice(0, m.index).trimEnd();
  if (!mathPart) return null; // entire content is Bengali — don't split
  // Don't extract if Bengali is inside unclosed braces (e.g. \frac{... Bengali})
  let depth = 0;
  for (const c of mathPart) { if (c === '{') depth++; else if (c === '}') depth--; }
  if (depth !== 0) return null;
  return { math: mathPart, bangla: m[1].trim() };
}

// Wrap Bengali text runs EMBEDDED inside a $...$ segment with \text{ Bengali }
// (leading+trailing spaces for proper KaTeX spacing).
// Skips already-wrapped \text{...} to avoid doubling.
function wrapBengaliInMathSegment(inner) {
  if (!BENGALI_RE.test(inner)) return inner;
  const saved = [];
  let base = inner.replace(/\\text\{[^}]*\}/g, m => {
    saved.push(m);
    return '\x01' + (saved.length - 1) + '\x01';
  });
  // Bengali run: consecutive Bengali chars + inter-word spaces + dot-abbreviations.
  // Add leading+trailing space inside \text{} so adjacent math tokens don't crowd it.
  base = base.replace(/([ঀ-৿](?:[ \t,.]*[ঀ-৿])*)/g, bn => '\\text{ ' + bn.trim() + ' }');
  if (saved.length) base = base.replace(/\x01(\d+)\x01/g, (_, i) => saved[+i]);
  return base;
}

// Step-starting Bengali words / symbols that should begin a new line when they
// appear directly after a closing $...$.
const STEP_STARTER_RE = /(\$)[ \t]*(আবার|যেহেতু|কাজেই|সুতরাং|এখন|অর্থাৎ|অতএব|সেহেতু|তাহলে|মনে\s*করি|ধরি|∴)/g;

function normalizeMathField(s, opts) {
  let x = String(s || '').replace(/[ \t]+/g, ' ').replace(/\n{3,}/g, '\n\n').trim();
  if (opts.unwrapNumbers) x = stripDollarsAroundNumbers(x);

  // 1. Replace \begin{matrix}...\end{matrix} blocks with individual lines.
  x = replaceMatrixBlocks(x);

  // 2. Replace \& column-alignment artifacts with individual lines.
  x = replaceAmpersandAlignment(x);

  // 3. Process each $...$ segment:
  //    a) Bengali at the very END → extract outside $...$ (keeps units like সে.মি. in plain text).
  //    b) Bengali embedded in the middle → wrap with \text{ Bengali } for proper spacing.
  x = x.replace(/\$([^$]+)\$/g, (_, inner) => {
    const ext = extractEndBengali(inner);
    if (ext) {
      // Move end-Bengali outside; wrap any remaining embedded Bengali in the math part.
      const mathPart = wrapBengaliInMathSegment(ext.math);
      return '$' + mathPart + '$ ' + ext.bangla;
    }
    return '$' + wrapBengaliInMathSegment(inner) + '$';
  });

  // 4. Wrap equation reference labels (i), (ii)… in $...$ so they render at
  //    correct size and CMS markdown doesn't misparse them as list markers.
  x = x.replace(/(?<![a-zA-Z$])\(([ivxIVX]{1,4})\)(?![a-zA-Z])/g, '$($1)$');

  // 5. Insert \n between $...$ and a following Bengali step-starter word / ∴
  //    so each new reasoning step starts on its own paragraph.
  x = x.replace(STEP_STARTER_RE, '$1\n$2');

  // 6. Ensure newline BEFORE an <img> tag when preceded by text.
  x = x.replace(/([^\n])\s*(<img\b)/g, '$1\n$2');

  // 7. Ensure newline AFTER an <img> tag when followed by text.
  x = x.replace(/(<img\b[^>]*>)\s*([^\n])/g, '$1\n$2');

  // 8. Tidy spacing inside $...$ ("$ x $" -> "$x$").
  x = x.replace(/\$([^$]*)\$/g, (_, inner) => '$' + inner.trim() + '$');

  // 9. Expand all single \n to \n\n (CMS markdown needs double breaks for
  //    visible paragraph gaps). Split/join handles existing \n\n safely.
  x = x.split('\n').join('\n\n').replace(/\n{3,}/g, '\n\n');

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

  // If any option contains math, wrap pure-number options in $...$ too so
  // all options render at the same visual size (Issue 8).
  const anyOptMath = Object.values(optVal).some(v => /\$[^$]+\$/.test(v));
  if (anyOptMath) {
    ['A', 'B', 'C', 'D'].forEach(k => {
      const v = optVal[k];
      if (v && !/\$/.test(v) && /^-?\d+(\.\d+)?$/.test(v.trim())) {
        optVal[k] = '$' + v.trim() + '$';
      }
    });
  }

  const answerValue = norm(q.answerValue || (q.correct && optVal[q.correct]) || '');

  // CMS solution = <answer value> \n\n ব্যাখ্যা: <explanation>
  const explanation = norm(q.explanation);
  let solution = answerValue;
  if (explanation) solution = (solution ? solution + '\n\n' : '') + 'ব্যাখ্যা: ' + explanation;

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
