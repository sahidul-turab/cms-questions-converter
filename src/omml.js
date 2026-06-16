// OMML (Office Math Markup Language) -> LaTeX converter.
//
// Operates on standard DOM Element nodes, so it runs unchanged in the browser
// (native DOMParser) and in Node tests (@xmldom/xmldom). The output style is
// tuned to match the existing CMS export ("source of truth"): inline $...$,
// \frac{}{}, \sqrt{}, ^{}, _{}, \left(\right), \mathbb{}, etc.

const ELEMENT_NODE = 1;
const TEXT_NODE = 3;

// Conventions calibrated from the CMS corpus by the offline trainer
// (tools/train.mjs -> knowledge.json). Defaults match what the sample export
// uses; applyConventions() overrides them with corpus-majority spellings.
const CONV = {
  leq: '\\leq ', geq: '\\geq ', neq: '\\neq ',
  arrow: '\\rightarrow ', frac: '\\frac',
};
const DYN = { '≤': 'leq', '≥': 'geq', '≠': 'neq', '→': 'arrow' };

export function applyConventions(c) {
  if (!c) return;
  if (c.leq) CONV.leq = c.leq + ' ';
  if (c.geq) CONV.geq = c.geq + ' ';
  if (c.neq) CONV.neq = c.neq + ' ';
  if (c.arrow) CONV.arrow = c.arrow + ' ';
  if (c.frac) CONV.frac = c.frac;
}

// Local name of a node, ignoring the namespace prefix ("m:f" -> "f").
function local(node) {
  const n = node.nodeName || node.tagName || '';
  const i = n.indexOf(':');
  return i === -1 ? n : n.slice(i + 1);
}

function attr(node, name) {
  if (!node.getAttribute) return null;
  // Try both prefixed and bare attribute names.
  return node.getAttribute('m:' + name) ?? node.getAttribute(name);
}

// Iterate element children only.
function elemChildren(node) {
  const out = [];
  const kids = node.childNodes;
  if (!kids) return out;
  for (let i = 0; i < kids.length; i++) {
    if (kids[i].nodeType === ELEMENT_NODE) out.push(kids[i]);
  }
  return out;
}

// First element child with the given local name.
function child(node, name) {
  for (const c of elemChildren(node)) if (local(c) === name) return c;
  return null;
}
function children(node, name) {
  return elemChildren(node).filter((c) => local(c) === name);
}

// --- Unicode math symbol -> LaTeX -----------------------------------------
const SYMBOLS = {
  '⊂': '\\subset ', '⊃': '\\supset ', '⊄': '\\not\\subset ',
  '⊆': '\\subseteq ', '⊇': '\\supseteq ', '∈': '\\in ', '∉': '\\notin ',
  '∋': '\\ni ', '∪': '\\cup ', '∩': '\\cap ', '∅': '\\emptyset ',
  '∖': '\\setminus ', '∀': '\\forall ', '∃': '\\exists ',
  '≤': '\\leq ', '≥': '\\geq ', '≠': '\\neq ', '≈': '\\approx ',
  '≡': '\\equiv ', '≅': '\\cong ', '∝': '\\propto ', '≪': '\\ll ', '≫': '\\gg ',
  '±': '\\pm ', '∓': '\\mp ', '×': '\\times ', '÷': '\\div ', '⋅': '\\cdot ',
  '∗': '*', '∘': '\\circ ',
  '∞': '\\infty ', 'π': '\\pi ', '∑': '\\sum ', '∏': '\\prod ', '∫': '\\int ',
  '∂': '\\partial ', '∇': '\\nabla ', '√': '\\sqrt',
  '→': '\\rightarrow ', '←': '\\leftarrow ', '↔': '\\leftrightarrow ',
  '⇒': '\\Rightarrow ', '⇐': '\\Leftarrow ', '⇔': '\\Leftrightarrow ',
  '∴': '\\therefore ', '∵': '\\because ', '∠': '\\angle ', '∥': '\\parallel ',
  '⊥': '\\perp ', '°': '^{\\circ}', '′': "'", '″': "''",
  '…': '\\ldots ', '⋯': '\\cdots ', '·': '\\cdot ',
  // Literal characters that are special in LaTeX must be escaped when they
  // come from a text run (vs. structural braces the converter emits itself).
  '{': '\\{', '}': '\\}', '%': '\\%', '#': '\\#', '&': '\\&',
  // Greek lower
  'α': '\\alpha ', 'β': '\\beta ', 'γ': '\\gamma ', 'δ': '\\delta ',
  'ε': '\\varepsilon ', 'θ': '\\theta ', 'λ': '\\lambda ', 'μ': '\\mu ',
  'ρ': '\\rho ', 'σ': '\\sigma ', 'τ': '\\tau ', 'φ': '\\phi ', 'ω': '\\omega ',
  'ϕ': '\\phi ', 'χ': '\\chi ', 'ψ': '\\psi ', 'η': '\\eta ', 'ξ': '\\xi ',
  // Greek upper
  'Δ': '\\Delta ', 'Σ': '\\Sigma ', 'Π': '\\Pi ', 'Ω': '\\Omega ',
  'Θ': '\\Theta ', 'Λ': '\\Lambda ', 'Φ': '\\Phi ', 'Γ': '\\Gamma ',
  // blackboard letters (when they arrive as literal chars rather than m:scr)
  'ℝ': '\\mathbb{R}', 'ℤ': '\\mathbb{Z}', 'ℕ': '\\mathbb{N}',
  'ℚ': '\\mathbb{Q}', 'ℂ': '\\mathbb{C}',
  '−': '-', '–': '-', '—': '-', ' ': ' ',
};

// Combining / accent chars -> LaTeX accent command.
const ACCENTS = {
  '̇': '\\dot', '̈': '\\ddot', '̅': '\\overline',
  '¯': '\\overline', '‾': '\\overline', '̄': '\\bar',
  '̂': '\\hat', '̃': '\\tilde', '⃗': '\\vec',
  '→': '\\vec', '̆': '\\breve', '́': '\\acute',
  '̀': '\\grave',
};

// Function names that get a backslash in LaTeX. (cosec/cot etc. that the CMS
// export keeps as plain text are intentionally NOT here.)
const FUNCS = new Set([
  'sin', 'cos', 'tan', 'sec', 'csc', 'cot', 'sinh', 'cosh', 'tanh',
  'log', 'ln', 'lg', 'exp', 'lim', 'limsup', 'liminf', 'max', 'min',
  'arg', 'det', 'gcd', 'deg', 'dim', 'ker', 'sup', 'inf', 'mod',
]);

function mapText(s, { doubleStruck = false } = {}) {
  let out = '';
  for (const ch of String(s)) {
    if (doubleStruck && /[A-Za-z]/.test(ch)) {
      out += '\\mathbb{' + ch + '}';
    } else if (DYN[ch]) {
      out += CONV[DYN[ch]]; // corpus-tuned spelling (\leq vs \le, etc.)
    } else if (SYMBOLS[ch] !== undefined) {
      out += SYMBOLS[ch];
    } else {
      out += ch;
    }
  }
  return out;
}

// Wrap in braces unless it is a single token (so x^2 not x^{2} only when safe).
function brace(s) {
  const t = s.trim();
  if (t.length <= 1) return t;
  if (/^\\[A-Za-z]+$/.test(t)) return t; // single command
  return '{' + t + '}';
}

// --- Node renderers --------------------------------------------------------
function renderNodes(node) {
  return elemChildren(node).map(render).join('');
}

function render(node) {
  switch (local(node)) {
    case 'oMath':
    case 'oMathPara':
    case 'e':
    case 'num':
    case 'den':
    case 'sup':
    case 'sub':
    case 'deg':
    case 'fName':
      return renderNodes(node);

    case 'r':
      return renderRun(node);
    case 't':
      return mapText(node.textContent || '');

    case 'f':
      return renderFraction(node);
    case 'rad':
      return renderRadical(node);
    case 'sSup':
      return renderSup(node);
    case 'sSub':
      return brace(render(child(node, 'e'))) + '_' + brace(render(child(node, 'sub')));
    case 'sSubSup':
      return brace(render(child(node, 'e'))) +
        '_' + brace(render(child(node, 'sub'))) +
        '^' + brace(render(child(node, 'sup')));
    case 'sPre': {
      const pre = '_' + brace(render(child(node, 'sub'))) + '^' + brace(render(child(node, 'sup')));
      return pre + render(child(node, 'e'));
    }
    case 'd':
      return renderDelimiter(node);
    case 'func':
      return renderFunc(node);
    case 'nary':
      return renderNary(node);
    case 'acc':
      return renderAccent(node);
    case 'bar':
      return '\\overline{' + render(child(node, 'e')) + '}';
    case 'limLow':
      return brace(render(child(node, 'e'))) + '_' + brace(render(child(node, 'lim')));
    case 'limUpp':
      return brace(render(child(node, 'e'))) + '^' + brace(render(child(node, 'lim')));
    case 'eqArr':
      return children(node, 'e').map(render).join(' \\quad ');
    case 'm':
      return renderMatrix(node);
    case 'groupChr':
      return render(child(node, 'e'));

    // structural wrappers we skip
    case 'rPr': case 'fPr': case 'radPr': case 'sSupPr': case 'sSubPr':
    case 'sSubSupPr': case 'dPr': case 'funcPr': case 'naryPr': case 'accPr':
    case 'eqArrPr': case 'mPr': case 'ctrlPr': case 'limLowPr': case 'limUppPr':
    case 'barPr': case 'groupChrPr': case 'sPrePr': case 'mc': case 'mcs':
    case 'mcPr': case 'mr':
      return local(node) === 'mr' ? children(node, 'e').map(render).join(' & ') : '';

    default:
      // Unknown wrapper: descend so we never lose content.
      return renderNodes(node);
  }
}

function renderRun(r) {
  const rPr = child(r, 'rPr');
  let doubleStruck = false;
  if (rPr) {
    const scr = child(rPr, 'scr');
    if (scr && /double-struck/.test(attr(scr, 'val') || '')) doubleStruck = true;
  }
  let out = '';
  for (const t of children(r, 't')) out += mapText(t.textContent || '', { doubleStruck });
  return out;
}

function renderFraction(node) {
  const num = render(child(node, 'num'));
  const den = render(child(node, 'den'));
  const pr = child(node, 'fPr');
  const type = pr ? attr(child(pr, 'type') || {}, 'val') : null;
  if (type === 'lin') return brace(num) + '/' + brace(den);
  return CONV.frac + '{' + num + '}{' + den + '}';
}

function renderSup(node) {
  const base = brace(render(child(node, 'e')));
  const sup = render(child(node, 'sup')).trim();
  // A prime/complement superscript (ℚ' etc.) must be a TeX prime, not "^'",
  // which KaTeX cannot parse.
  if (/^['′″‴`]+$/.test(sup)) return base + "'".repeat(sup.length);
  return base + '^' + brace(sup);
}

function renderRadical(node) {
  const pr = child(node, 'radPr');
  const degHidden = pr && child(pr, 'degHide') && /1|true|on/.test(attr(child(pr, 'degHide'), 'val') || '1');
  const deg = child(node, 'deg');
  const e = render(child(node, 'e'));
  const degTxt = deg ? render(deg).trim() : '';
  if (!degHidden && degTxt) return '\\sqrt[' + degTxt + ']{' + e + '}';
  return '\\sqrt{' + e + '}';
}

const DELIM_OPEN = { '(': '(', '[': '[', '{': '\\{', '|': '|', '‖': '\\|', '⌊': '\\lfloor ', '⌈': '\\lceil ', '⟨': '\\langle ', '': '.' };
const DELIM_CLOSE = { ')': ')', ']': ']', '}': '\\}', '|': '|', '‖': '\\|', '⌋': '\\rfloor ', '⌉': '\\rceil ', '⟩': '\\rangle ', '': '.' };

function renderDelimiter(node) {
  const pr = child(node, 'dPr');
  let beg = '(', end = ')', sep = '|';
  if (pr) {
    const b = child(pr, 'begChr'); if (b) beg = attr(b, 'val') ?? '';
    const e = child(pr, 'endChr'); if (e) end = attr(e, 'val') ?? '';
    const s = child(pr, 'sepChr'); if (s) sep = attr(s, 'val') ?? '|';
  }
  const parts = children(node, 'e').map(render);
  const inner = parts.join(' ' + (SYMBOLS[sep] || sep) + ' ');
  const open = DELIM_OPEN[beg] !== undefined ? DELIM_OPEN[beg] : beg;
  const close = DELIM_CLOSE[end] !== undefined ? DELIM_CLOSE[end] : end;
  return '\\left' + open + ' ' + inner + ' \\right' + close;
}

function renderFunc(node) {
  let name = render(child(node, 'fName')).trim();
  const arg = render(child(node, 'e'));
  // Backslash known functions; keep the rest verbatim (matches CMS style).
  // Tolerates a braced leading word from a sub/sup name, e.g. "{log}_3".
  name = name.replace(/^\{?([A-Za-z]+)\}?/, (m, w) => (FUNCS.has(w) ? '\\' + w : w));
  return name + ' ' + arg;
}

function renderNary(node) {
  const pr = child(node, 'naryPr');
  let op = '∫';
  if (pr) { const c = child(pr, 'chr'); if (c) op = attr(c, 'val') ?? '∫'; }
  const sym = SYMBOLS[op] ? SYMBOLS[op].trim() : op;
  const sub = child(node, 'sub'), sup = child(node, 'sup');
  const subTxt = sub ? render(sub).trim() : '';
  const supTxt = sup ? render(sup).trim() : '';
  let out = sym;
  const hideSub = pr && child(pr, 'subHide') && /1|true|on/.test(attr(child(pr, 'subHide'), 'val') || '');
  const hideSup = pr && child(pr, 'supHide') && /1|true|on/.test(attr(child(pr, 'supHide'), 'val') || '');
  if (subTxt && !hideSub) out += '_' + brace(subTxt);
  if (supTxt && !hideSup) out += '^' + brace(supTxt);
  out += ' ' + render(child(node, 'e'));
  return out;
}

function renderAccent(node) {
  const pr = child(node, 'accPr');
  let chr = '̂';
  if (pr) { const c = child(pr, 'chr'); if (c) chr = attr(c, 'val') ?? chr; }
  const cmd = ACCENTS[chr] || '\\hat';
  return cmd + '{' + render(child(node, 'e')) + '}';
}

function renderMatrix(node) {
  const rows = children(node, 'mr').map((r) => children(r, 'e').map(render).join(' & '));
  return '\\begin{matrix} ' + rows.join(' \\\\ ') + ' \\end{matrix}';
}

// Public: convert one <m:oMath>/<m:oMathPara> Element to a LaTeX string.
export function ommlToLatex(node) {
  let s = renderNodes(node);
  s = s.replace(/[ \t]+/g, ' ').trim();
  return s;
}

export { local, elemChildren };
