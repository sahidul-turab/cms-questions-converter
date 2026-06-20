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
const TOPIC_LINE_RE = /^\s*topic(?:\s+name[s]?)?\s*[:：.\-]\s*(.*)$/i;
const CHAPTER_LINE_RE = /^\s*(?:chapter(?:\s+no\.?)?|অধ্যায়)\s*[:：.\-]\s*(.+)$/i;

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

// A whole line that is ONLY a difficulty marker, optionally wrapped in ()/[]/{}:
// "(medium)", "[Hard]", "Easy", "(E)". Single letters must be wrapped so a bare
// "M" or "H" in prose is never mistaken for a difficulty.
const DIFF_WORD_LINE_RE = /^[(\[{]?\s*(easy|medium|hard)\s*[)\]}]?$/i;
const DIFF_LETTER_LINE_RE = /^[(\[{]\s*([emh])\s*[)\]}]$/i;
function standaloneDifficulty(line) {
  const t = String(line || '').trim();
  const m = t.match(DIFF_WORD_LINE_RE) || t.match(DIFF_LETTER_LINE_RE);
  return m ? normDiff(m[1]) : '';
}

// Strip a difficulty marker sitting at the END of a content line — but only when
// it is wrapped in ()/[]/{} (e.g. a solution line ending "… (medium)"), so an
// ordinary word like "hard" inside a sentence is left untouched. Returns the
// cleaned text plus any difficulty found.
const TRAIL_DIFF_TAG_RE = /\s*[(\[{]\s*(easy|medium|hard|[emh])\s*[)\]}]\s*$/i;
function stripTrailingDifficulty(line) {
  const s = String(line || '');
  const m = s.match(TRAIL_DIFF_TAG_RE);
  if (!m) return { text: s, difficulty: '' };
  return { text: s.slice(0, m.index).trim(), difficulty: normDiff(m[1]) };
}

// Roman-numeral list item starters (i), ii), iii), iv)… at line start).
const LIST_ITEM_RE = /^(?:i{1,3}|iv|vi{0,3}|ix)\s*[.)।]\s/i;
// "নিচের কোনটি" / "নিম্নের কোনটি" stem-end lines.
const STEM_END_RE = /^(?:নিচের|নিম্নের|নীচের)\s+কোন/;

// Join collected title lines, inserting \n\n paragraph breaks before each
// Roman-numeral list item and before the "নিচের কোনটি" closing line.
// Also catches items that were run together inline on one source line.
function joinTitle(lines) {
  if (!lines.length) return '';
  const parts = [lines[0]];
  for (let i = 1; i < lines.length; i++) {
    const l = lines[i];
    const sep = (LIST_ITEM_RE.test(l) || STEM_END_RE.test(l)) ? '\n\n' : ' ';
    parts.push(sep + l);
  }
  let text = parts.join('').replace(/[ \t]+/g, ' ').replace(/\n[ \t]+/g, '\n').trim();
  // Catch items that were NOT on separate lines in the source (all on one line).
  text = text.replace(/([^\n])\s+((?:i{1,3}|iv|vi{0,3})\s*[.)।]\s)/gi, (_, b, item) => b + '\n\n' + item);
  text = text.replace(/([^\n])\s+((?:নিচের|নিম্নের|নীচের)\s+কোন)/g, (_, b, stem) => b + '\n\n' + stem);
  return text;
}

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

// Strip a leading difficulty word and/or a "Topic:" label from a topic tag,
// e.g. "Medium, Topic : 4.2 পর্যায় …" -> "4.2 পর্যায় …".
function cleanTopicText(s) {
  return tidy(String(s || '')
    .replace(/^\s*(easy|medium|hard)\s*[,，:：.\-]?\s*/i, '')
    .replace(/^\s*topic[s]?\s*[:：.\-]?\s*/i, ''));
}

// A topic field can carry several topics ("9.2 X, 9.5 Y"). They are separated
// by a comma/semicolon that is FOLLOWED by a new section number — commas inside
// one topic name ("রক্ত, রক্তের উপাদান, লসিকা") are not.
export function splitTopics(s) {
  return tidy(s)
    .split(/\s*[,;，；]\s*(?=[০-৯0-9]{1,2}\s*\.\s*[০-৯0-9])/)
    .map((t) => t.trim())
    .filter(Boolean);
}

// "4.1 রক্ত, রক্তের উপাদান" -> { no: "4.1", name: "রক্ত, রক্তের উপাদান" }.
export function topicParts(t) {
  const m = tidy(t).match(/^([০-৯0-9]{1,2}(?:\s*\.\s*[০-৯0-9]{1,2})+)\s*[-–—.]?\s*(.*)$/);
  if (m) return { no: bnToEn(m[1]).replace(/\s+/g, ''), name: m[2].trim() };
  return { no: '', name: tidy(t) };
}

// Parse the combined "Chap.: <name>  Topic: N.M  <topic_name>  Diff: D" format
// found in Math/Science MCQ docs. Returns { chapter, topic, difficulty } or null.
function parseChapTopicBracket(inner) {
  const m = inner.match(
    /Chap(?:ter)?\.?\s*[:：]\s*(.+?)\s{2,}Topic\s*[:：]\s*([\d০-৯]+\.[\d০-৯]+)\s+(.*?)\s*Diff(?:iculty)?\.?\s*(?:Level)?\s*[:：.]?\s*([EMHemh])\s*$/i,
  ) || inner.match(
    /Chap(?:ter)?\.?\s*[:：]\s*(.+?)\s{2,}Topic\s*[:：]\s*([\d০-৯]+\.[\d০-৯]+)(?:\s+(.+))?\s*$/i,
  );
  if (!m) return null;
  const topicNo = bnToEn(m[2]).replace(/\s/g, ''); // "4.2"
  const topicName = (m[3] || '').trim();
  const diff = m[4] ? normDiff(m[4]) : '';
  const chapterNo = topicNo.split('.')[0]; // "4.2" → chapter "4"
  return { chapter: chapterNo, topic: topicName ? topicNo + ' ' + topicName : topicNo, difficulty: diff };
}

// Strip bracketed difficulty/topic tags and a trailing EASY/MEDIUM/HARD word
// from a stem or answer line. Returns the cleaned text plus any meta found.
function stripInlineMeta(line) {
  let topic = '';
  let difficulty = '';
  let chapter = '';

  // A trailing wrapped difficulty tag, e.g. an answer line "Ans: C (Easy)".
  const td = stripTrailingDifficulty(line);
  if (td.difficulty) { difficulty = td.difficulty; line = td.text; }

  let out = replaceOutsideMath(line, /\[([^\]]*)\]/g, (full, inner) => {
    const t = inner.trim();
    if (isDiffTag(t)) { difficulty = difficulty || normDiff(t); return ' '; }
    // Combined Chap./Topic/Diff bracket (Math/Science MCQ format)
    const ct = parseChapTopicBracket(t);
    if (ct) {
      if (ct.difficulty) difficulty = difficulty || ct.difficulty;
      if (ct.chapter) chapter = chapter || ct.chapter;
      topic = ct.topic;
      return ' ';
    }
    if (isTopicTag(t)) {
      const dm = t.match(/\b(easy|medium|hard)\b/i);
      if (dm) difficulty = difficulty || normDiff(dm[1]);
      topic = cleanTopicText(t);
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
      // slice removes the difficulty word; also strip any separator (dash/colon) before it
      out = out.slice(0, trail.index).replace(/[\s\-–—:]+$/, '');
    }
  }
  // Only trim whitespace — preserve trailing hyphens/dashes that are part of the sentence
  return { text: out.trim(), topic, difficulty, chapter };
}

// Whole-line metadata (topic-only / difficulty-only / count headers) that
// should be consumed and dropped. Returns null for ordinary content lines.
function classifyMetaLine(line) {
  const t = line.trim();
  if (!t) return null;

  // Count header: "EASY  MEDIUM  HARD", "EASY-9, MEDIUM-9, HARD-7".
  if (/^((easy|medium|hard)[\s,:\-0-9]*){2,}$/i.test(t)) return { kind: 'skip' };

  // A whole line that is just a difficulty marker: "(medium)", "[H]", "Easy".
  const sd = standaloneDifficulty(t);
  if (sd) return { kind: 'difficulty', difficulty: sd };

  const dl = t.match(DIFF_LINE_RE);
  if (dl) return { kind: 'difficulty', difficulty: normDiff(dl[1]) };

  const tl = t.match(TOPIC_LINE_RE);
  if (tl) return { kind: 'topic', topic: cleanTopicText(tl[1]), expectNext: !tl[1].trim() };

  const cl = t.match(CHAPTER_LINE_RE);
  if (cl) return { kind: 'chapter', chapter: cl[1].trim() };

  // Whole-line bracket: "[E]" / "[Topic: ...]" / "[5.1 ...]" / "[Medium, Topic: ...]".
  const whole = t.match(/^\[([^\]]*)\]$/);
  if (whole) {
    const inner = whole[1].trim();
    if (isDiffTag(inner)) return { kind: 'difficulty', difficulty: normDiff(inner) };
    // Combined "Chap.: X  Topic: N.M  Name  Diff: D" — check before generic isTopicTag
    const ct = parseChapTopicBracket(inner);
    if (ct) return { kind: 'topic', chapter: ct.chapter, topic: ct.topic, difficulty: ct.difficulty };
    if (isTopicTag(inner)) {
      const dm = inner.match(/\b(easy|medium|hard)\b/i);
      return { kind: 'topic', topic: cleanTopicText(inner), difficulty: dm ? normDiff(dm[1]) : '' };
    }
  }

  // Difficulty bracket + topic on one line: "[E]    5.3<tab>Food additives".
  const combo = t.match(/^\[(e|m|h|easy|medium|hard)\]\s*(.+)$/i);
  if (combo && isTopicTag(combo[2])) {
    return { kind: 'topic', topic: cleanTopicText(combo[2]), difficulty: normDiff(combo[1]) };
  }

  // Standalone section-topic line: "3.1<tab>name" (a "chapter.section" number
  // then a TAB then the name). The tab is required — it is what separates a
  // real topic row from a question stem that merely opens with a decimal
  // (e.g. "8. 30 kg ...", "২. 2.5 সে.মি. ..."). Equation lines are excluded
  // too, so math explanations survive.
  if (!/[=$]/.test(t) &&
      /^[০-৯0-9]{1,2}\s*\.\s*[০-৯0-9]{1,2}(\s*\.\s*[০-৯0-9]{1,2})?\s*\t/.test(t)) {
    return { kind: 'topic', topic: cleanTopicText(t) };
  }
  return null;
}

// A stem line in the table/tag layout ends with "[M] [4.2 …]" — a difficulty
// bracket immediately followed by a topic bracket. In docs exported from a Word
// table (flattened to tab-separated text) the questions carry NO leading number,
// so this tag is the only reliable marker that a new question begins.
const STEM_TAG_RE = /\[\s*[EMHemh]\s*\]\s*\[/;

// Split a multi-question blob into per-question blocks. A new question starts
// at a line beginning with a (Bengali or ASCII) number followed by । . or ) —
// but NOT a "6.4"-style section number (the separator must not be followed by
// another digit), so topic lines never start a new question.
//
// Fallback: when there are no leading numbers (a Word-table export), split on
// the per-question stem tag instead, so the file does not collapse into one block.
export function splitQuestions(text) {
  const clean = String(text || '')
    .replace(/\r/g, '')
    .replace(/ /g, ' ')
    .replace(/[“”]/g, '"')
    .trim();
  if (!clean) return [];
  const byNumber = clean
    .split(/\n(?=\s*[০-৯0-9]{1,3}\s*[।.)](?![০-৯0-9]))/g)
    .map((b) => b.trim())
    .filter(Boolean);
  if (byNumber.length > 1) return byNumber;
  // Number-less, tag-based layout: start a new block at each stem-tag line.
  const lines = clean.split('\n');
  if (lines.filter((l) => STEM_TAG_RE.test(l)).length >= 2) {
    const blocks = [];
    let cur = [];
    for (const line of lines) {
      if (STEM_TAG_RE.test(line) && cur.length) { blocks.push(cur.join('\n')); cur = []; }
      cur.push(line);
    }
    if (cur.length) blocks.push(cur.join('\n'));
    return blocks.map((b) => b.trim()).filter(Boolean);
  }
  return byNumber;
}

// Some files lay options out many-per-line, tab- or wide-space-separated:
// "A. … \t\t B. …" or "A.1টি \tB. 2টি \tC. 3টি \tD. 4টি". Split into one per line.
function splitInlineOptions(line) {
  const expanded = line
    .replace(/(?:\t+|\s{2,})(?=[A-Eকখগঘঙ]\s*[.)]\s*\S)/g, '\n')
    // When a math span ($…$) closes and the next non-blank token is an option
    // marker for B–E, split even on a single separating space. After a closing
    // "$" the only valid follow-up is prose or another option — never math
    // content — so false positives are not possible. Excludes A to avoid firing
    // on "$expr$ A simple explanation" type prose where A opens a sentence.
    .replace(/(\$)\s+(?=[B-Eখগঘঙ]\s*[.)]\s*\S)/g, '$1\n');
  return expanded.split('\n').map((s) => s.trim()).filter(Boolean);
}

// A stem line that carries its first option(s) inline after a wide gap, e.g.
// "… কত?      A. 108  B. 121". The line does NOT start with an option letter,
// so OPT_HEAD_RE misses it; without splitting, options A/B are swallowed by the
// title and the whole question is later dropped for "missing options A/B".
// Trigger only on an inline A./ক) marker — options always open at A, so this is
// the reliable signal that the options block begins mid-line (and avoids firing
// on a stray "… B. …" inside prose).
const INLINE_OPT_START_RE = /(?:\t+|\s{2,})[Aক]\s*[.)]\s*\S/;

export function parseBlock(block) {
  // Pre-expand many-per-line option rows.
  const lines = [];
  for (const l of block.split('\n')) {
    const t = l.trim();
    if (!t) continue;
    if (OPT_HEAD_RE.test(t) || INLINE_OPT_START_RE.test(t)) lines.push(...splitInlineOptions(t));
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
  let chapter = '';
  let expectTopic = false; // a bare "Topic:" line consumes the next line

  const setMeta = (m) => {
    if (m.topic) topic = m.topic;
    if (m.difficulty) difficulty = difficulty || m.difficulty;
    if (m.chapter) chapter = m.chapter;
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
      const d = stripTrailingDifficulty(line.replace(EXP_RE, '').trim());
      if (d.difficulty) difficulty = difficulty || d.difficulty;
      if (d.text) exp.push(d.text);
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
      // A bracketed difficulty tagged onto the last option ("D. … (medium)").
      const d = stripTrailingDifficulty(line);
      if (d.difficulty) difficulty = difficulty || d.difficulty;
      opt[curOpt] += ' ' + d.text;
    } else if (mode === 'explanation') {
      const d = stripTrailingDifficulty(line);
      if (d.difficulty) difficulty = difficulty || d.difficulty;
      if (d.text) exp.push(d.text);
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

  // A question may carry several topics; expose them structured ({no, name})
  // and as a name-only string (the CMS topic column wants names, not numbers).
  const topics = splitTopics(topic).map(topicParts);
  return {
    title: joinTitle(title),
    options: { A: tidy(opt.A), B: tidy(opt.B), C: tidy(opt.C), D: tidy(opt.D) },
    correct: ansLetter && ansLetter <= 'D' ? ansLetter : '',
    answerValue: tidy(answerValue),
    explanation: exp.join('\n').replace(/[ \t]+/g, ' ').trim(),
    topic: topics.map((t) => t.name).join('; '),
    topics,
    difficulty,
    chapter,
  };
}

export function parseRaw(text) {
  return splitQuestions(text)
    .map(parseBlock)
    // A real MCQ always has at least two options; this drops file titles,
    // count headers, passage preambles, and other non-question blocks.
    .filter((q) => q.options.A && q.options.B);
}
