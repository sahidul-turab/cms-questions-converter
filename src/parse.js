// Raw question text (already carrying inline $LaTeX$) -> structured rows.
//
// Rule-based structural parsing that tolerates the many raw layouts the
// Knowledge Team uses. The same logical field is written many ways across
// files, so every marker below is matched in all its observed spellings:
//
//   answer:      উত্তর / সঠিক উত্তর / Answer / Ans / Correct Answer/Option /
//                Uttor / Sothik Uttor / Sothik Answer (any of : ： ঃ . - )
//   explanation: ব্যাখ্যা / সমাধান / Solution / Explanation (+ the ব্যাখ্য্যা typo)
//   difficulty:  [E]/[M]/[H], [Easy]/[Medium]/[Hard], a trailing EASY/MEDIUM/HARD
//                word, "Difficulty Level: X", "[Medium, Topic: ...]"
//   options:     A. / A)  and Bengali ক)/খ)/গ)/ঘ); one- or many-per-line (tab-sep)
//   topic:       [Topic: ...], bracketed "[5.1 ...]", a standalone "5.1<tab>name"
//                line, or a bare "Topic:" line followed by the section line
//
// Topic is parsed only so it can be removed from the question text (the UI
// fills the topic column from the metadata panel, not from the raw file).
// Difficulty is kept and surfaced as the per-question difficulty.

const BN_DIGITS = '০১২৩৪৫৬৭৮৯';
export function bnToEn(s) {
  return String(s || '').replace(/[০-৯]/g, (d) => BN_DIGITS.indexOf(d));
}

// Bengali option letters -> A/B/C/D/E.
const BN_OPT = { 'ক': 'A', 'খ': 'B', 'গ': 'C', 'ঘ': 'D', 'ঙ': 'E' };
function optLetterToLatin(ch) {
  return BN_OPT[ch] || String(ch).toUpperCase();
}

// ---- line markers ---------------------------------------------------------
// The separator after the unambiguous Bengali markers is optional (some files
// write "ব্যাখ্যা $...$" with no colon); it stays required after the short
// Latin tokens so an English stem like "Answer the following" is not eaten.
const ANS_RE = /^\s*(?:(?:সঠিক\s*উত্তর|সঠিক\s*উওর|উত্তর|উওর)\s*[:：ঃ.\-]?|(?:correct\s*answer|correct\s*option|answer|ans|sothik\s*uttor|sothik\s*answer|sothik|uttor)\s*[:：ঃ.\-])\s*/i;
// ব্যাখ্য(্য)?া also matches the "ব্যাখ্য্যা" typo (an extra ্য) seen in raw files.
const EXP_RE = /^\s*(?:(?:ব্যাখ্য(?:্য)?া|ব্যখ্যা|সমাধান|সমধান)\s*[:：ঃ.\-]?|(?:solution|soln|explanation|explain|somadhan|bekkha)\s*[:：ঃ.\-])\s*/i;
const DIFF_LINE_RE = /^\s*dif?fic?ulty\s*level\s*[:：.\-]\s*(easy|medium|hard|e|m|h)\b/i;
const TOPIC_LINE_RE = /^\s*topic\s*[:：.\-]\s*(.*)$/i;

// Option line / answer-letter, latin or bengali marker.
const OPT_RE = /^([A-Eকখগঘঙ])\s*[.)]\s*(.*)$/;
const OPT_HEAD_RE = /^[A-Eকখগঘঙ]\s*[.)]/;
// Leading answer letter, tolerating a wrapping paren: "B." / "(ঘ)" / "গ)".
const ANS_LETTER_RE = /^[(\[]?\s*([A-Eকখগঘঙ])\s*[.)\]]*/;

function normDiff(s) {
  const t = String(s || '').trim().toLowerCase();
  if (!t) return '';
  if (t === 'e' || t.startsWith('eas')) return 'Easy';
  if (t === 'm' || t.startsWith('med')) return 'Medium';
  if (t === 'h' || t.startsWith('har')) return 'Hard';
  return '';
}

const tidy = (s) => String(s || '').replace(/\s+/g, ' ').trim();

// Run `re.replace` only on the parts of `str` that sit OUTSIDE $...$ math
// spans, so we never disturb brackets/braces that belong to LaTeX.
function replaceOutsideMath(str, re, fn) {
  return str
    .split(/(\$[^$]*\$)/)
    .map((p) => (p.startsWith('$') && p.endsWith('$') ? p : p.replace(re, fn)))
    .join('');
}

function isDiffTag(t) {
  return /^(e|m|h|easy|medium|hard)$/i.test(t.trim());
}
function isTopicTag(t) {
  // "[Topic: ...]" or a section number like "6.4 ..." / "5.1 ..." / "3.3<tab>..."
  return /topic/i.test(t) || /^[০-৯0-9]{1,2}\s*\.\s*[০-৯0-9]/.test(t.trim());
}

// Strip bracketed difficulty/topic tags and a trailing EASY/MEDIUM/HARD word
// from a stem or answer line. Returns the cleaned text plus any meta found.
function stripInlineMeta(line) {
  let topic = '';
  let difficulty = '';

  let out = replaceOutsideMath(line, /\[([^\]]*)\]/g, (full, inner) => {
    const t = inner.trim();
    if (isDiffTag(t)) { difficulty = difficulty || normDiff(t); return ' '; }
    if (isTopicTag(t)) {
      const dm = t.match(/\b(easy|medium|hard)\b/i);
      if (dm) difficulty = difficulty || normDiff(dm[1]);
      const tm = t.match(/topic\s*[:：.\-]?\s*(.*)$/i);
      topic = tidy(tm ? tm[1] : t.replace(/^(easy|medium|hard)\s*,?\s*/i, ''));
      return ' ';
    }
    return full; // a content/math bracket — leave it alone
  });

  // Trailing bare difficulty word: "... এতে- EASY", "... কত? Easy".
  // Only when the line carries Bengali (so it is a stem) or the word is ALL
  // CAPS — guards against eating an English word like "...hard?".
  const trail = out.match(/[\s\-–—:]*\b(EASY|MEDIUM|HARD|Easy|Medium|Hard)\s*$/);
  if (trail) {
    const word = trail[1];
    if (word === word.toUpperCase() || /[ঀ-৿]/.test(out)) {
      difficulty = difficulty || normDiff(word);
      out = out.slice(0, trail.index);
    }
  }
  return { text: out.replace(/[\s\-–—:]+$/, '').trim(), topic, difficulty };
}

// Whole-line metadata (topic-only / difficulty-only / count headers) that
// should be consumed and dropped. Returns null for ordinary content lines.
function classifyMetaLine(line) {
  const t = line.trim();
  if (!t) return null;

  // Count header: "EASY  MEDIUM  HARD", "EASY-9, MEDIUM-9, HARD-7".
  if (/^((easy|medium|hard)[\s,:\-0-9]*){2,}$/i.test(t)) return { kind: 'skip' };

  const dl = t.match(DIFF_LINE_RE);
  if (dl) return { kind: 'difficulty', difficulty: normDiff(dl[1]) };

  const tl = t.match(TOPIC_LINE_RE);
  if (tl) return { kind: 'topic', topic: tidy(tl[1]), expectNext: !tl[1].trim() };

  // Whole-line bracket: "[E]" / "[Topic: ...]" / "[5.1 ...]".
  const whole = t.match(/^\[([^\]]*)\]$/);
  if (whole) {
    const inner = whole[1].trim();
    if (isDiffTag(inner)) return { kind: 'difficulty', difficulty: normDiff(inner) };
    if (isTopicTag(inner)) {
      const dm = inner.match(/\b(easy|medium|hard)\b/i);
      return { kind: 'topic', topic: tidy(inner), difficulty: dm ? normDiff(dm[1]) : '' };
    }
  }

  // Difficulty bracket + topic on one line: "[E]    5.3<tab>Food additives".
  const combo = t.match(/^\[(e|m|h|easy|medium|hard)\]\s*(.+)$/i);
  if (combo && isTopicTag(combo[2])) {
    return { kind: 'topic', topic: tidy(combo[2]), difficulty: normDiff(combo[1]) };
  }

  // Standalone section-topic line: "3.1<tab>name" (a "chapter.section" number
  // then a TAB then the name). The tab is required — it is what separates a
  // real topic row from a question stem that merely opens with a decimal
  // (e.g. "8. 30 kg ...", "২. 2.5 সে.মি. ..."). Equation lines are excluded
  // too, so math explanations survive.
  if (!/[=$]/.test(t) &&
      /^[০-৯0-9]{1,2}\s*\.\s*[০-৯0-9]{1,2}(\s*\.\s*[০-৯0-9]{1,2})?\s*\t/.test(t)) {
    return { kind: 'topic', topic: tidy(t) };
  }
  return null;
}

// Split a multi-question blob into per-question blocks. A new question starts
// at a line beginning with a (Bengali or ASCII) number followed by । . or ) —
// but NOT a "6.4"-style section number (the separator must not be followed by
// another digit), so topic lines never start a new question.
export function splitQuestions(text) {
  const clean = String(text || '')
    .replace(/\r/g, '')
    .replace(/ /g, ' ')
    .replace(/[“”]/g, '"')
    .trim();
  if (!clean) return [];
  return clean
    .split(/\n(?=\s*[০-৯0-9]{1,3}\s*[।.)](?![০-৯0-9]))/g)
    .map((b) => b.trim())
    .filter(Boolean);
}

// Some files lay options out many-per-line, tab- or wide-space-separated:
// "A. … \t\t B. …" or "A.1টি \tB. 2টি \tC. 3টি \tD. 4টি". Split into one per line.
function splitInlineOptions(line) {
  const expanded = line.replace(/(?:\t+|\s{2,})(?=[A-Eকখগঘঙ]\s*[.)]\s*\S)/g, '\n');
  return expanded.split('\n').map((s) => s.trim()).filter(Boolean);
}

export function parseBlock(block) {
  // Pre-expand many-per-line option rows.
  const lines = [];
  for (const l of block.split('\n')) {
    const t = l.trim();
    if (!t) continue;
    if (OPT_HEAD_RE.test(t)) lines.push(...splitInlineOptions(t));
    else lines.push(t);
  }

  const title = [];
  const opt = { A: '', B: '', C: '', D: '', E: '' };
  let ansLetter = '';
  let ansInline = '';
  const exp = [];
  let mode = 'title';
  let curOpt = null;
  let topic = '';
  let difficulty = '';
  let expectTopic = false; // a bare "Topic:" line consumes the next line

  const setMeta = (m) => {
    if (m.topic) topic = m.topic;
    if (m.difficulty) difficulty = difficulty || m.difficulty;
  };

  for (const raw of lines) {
    let line = raw.trim();

    if (expectTopic) {
      expectTopic = false;
      topic = topic || tidy(line);
      continue;
    }

    // Answer line.
    if (ANS_RE.test(line)) {
      const meta = stripInlineMeta(line.replace(ANS_RE, ''));
      setMeta(meta);
      ansInline = meta.text;
      const m = ansInline.match(ANS_LETTER_RE);
      if (m) ansLetter = optLetterToLatin(m[1]);
      mode = 'answer';
      continue;
    }

    // Explanation line.
    if (EXP_RE.test(line)) {
      const e = line.replace(EXP_RE, '').trim();
      if (e) exp.push(e);
      mode = 'explanation';
      continue;
    }

    // Standalone metadata (topic / difficulty / count header) anywhere.
    const meta = classifyMetaLine(line);
    if (meta) {
      if (meta.kind === 'skip') continue;
      setMeta(meta);
      if (meta.expectNext) expectTopic = true;
      continue;
    }

    // Leading question number (only while still building the title).
    const numMatch = line.match(/^[০-৯0-9]{1,3}\s*[।.)](?![০-৯0-9])\s*/);
    if (numMatch && mode === 'title') {
      line = line.slice(numMatch[0].length).trim();
      if (!line) continue;
    }

    // Option line.
    const om = line.match(OPT_RE);
    if (om && (mode === 'title' || mode === 'option')) {
      const L = optLetterToLatin(om[1]);
      opt[L] = om[2].trim();
      mode = 'option';
      curOpt = L;
      continue;
    }

    // Plain content — route to the current section.
    if (mode === 'title') {
      const m = stripInlineMeta(line);
      setMeta(m);
      if (m.text) title.push(m.text);
    } else if (mode === 'option' && curOpt) {
      opt[curOpt] += ' ' + line;
    } else if (mode === 'explanation') {
      exp.push(line);
    } else if (mode === 'answer') {
      const m = stripInlineMeta(line);
      setMeta(m);
      if (m.text) ansInline += ' ' + m.text;
    }
  }

  let answerValue = '';
  if (ansLetter && opt[ansLetter]) answerValue = opt[ansLetter];
  else answerValue = ansInline.replace(ANS_LETTER_RE, '').replace(/^[.)\s]+/, '').trim();

  // Some files give the answer as a bare value ("উত্তর: $value$") with no
  // letter. Recover the letter by matching that value against the options.
  if (!ansLetter && answerValue) {
    const key = (s) => tidy(s).replace(/\s+/g, '').replace(/[।.]+$/, '');
    const target = key(answerValue);
    for (const L of ['A', 'B', 'C', 'D']) {
      if (opt[L] && key(opt[L]) === target) { ansLetter = L; break; }
    }
  }

  return {
    title: tidy(title.join(' ')),
    options: { A: tidy(opt.A), B: tidy(opt.B), C: tidy(opt.C), D: tidy(opt.D) },
    correct: ansLetter && ansLetter <= 'D' ? ansLetter : '',
    answerValue: tidy(answerValue),
    explanation: tidy(exp.join(' ')),
    topic: tidy(topic),
    difficulty,
  };
}

export function parseRaw(text) {
  return splitQuestions(text)
    .map(parseBlock)
    // A real MCQ always has at least two options; this drops file titles,
    // count headers, passage preambles, and other non-question blocks.
    .filter((q) => q.options.A && q.options.B);
}
