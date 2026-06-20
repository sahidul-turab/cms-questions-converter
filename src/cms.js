// CMS API client — logs in and creates questions straight from the browser,
// replacing the Tampermonkey uploader. Both the login endpoint
// (POST /auth/v3/cms/login) and the GraphQL endpoint return
// `access-control-allow-origin: *`, so this works cross-origin from the
// deployed formatter with no proxy. Each user logs in with their own CMS
// credentials; only the returned access token is kept (in sessionStorage),
// never the password.
//
// Name→ID resolution and the CreateQuestionBank mutation are ported verbatim
// from the production Tampermonkey uploader so behaviour matches what the team
// already trusts.

export const ENVS = {
  dev: { label: 'DEV', api: 'https://api.shikho.dev' },
  prod: { label: 'PROD', api: 'https://api.shikho.com' },
};

const VENDOR = 'shikho';

// ---- token storage (per env, sessionStorage so it clears on tab close) ----
const tokenKey = (env) => `cms_token_${env}`;
const emailKey = (env) => `cms_email_${env}`;

export function getToken(env) {
  try { return sessionStorage.getItem(tokenKey(env)) || null; } catch { return null; }
}
export function getEmail(env) {
  try { return sessionStorage.getItem(emailKey(env)) || ''; } catch { return ''; }
}
function setSession(env, token, email) {
  try {
    sessionStorage.setItem(tokenKey(env), token);
    if (email) sessionStorage.setItem(emailKey(env), email);
  } catch { /* ignore */ }
}
export function clearToken(env) {
  try {
    sessionStorage.removeItem(tokenKey(env));
    sessionStorage.removeItem(emailKey(env));
  } catch { /* ignore */ }
  resetCache(env);
}

// ---- auth ----
// POST /auth/v3/cms/login {email, password} -> { code, tokens: { access_token, ... } }
export async function login(env, email, password) {
  const base = ENVS[env].api;
  const res = await fetch(`${base}/auth/v3/cms/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    credentials: 'omit',
    body: JSON.stringify({ email, password }),
  });
  let json = null;
  try { json = await res.json(); } catch { /* fall through */ }
  if (!res.ok || !json) {
    const detail = json && (json.message || json.error) ? (json.message || json.error) : `HTTP ${res.status}`;
    throw new Error(`Login failed: ${detail}`);
  }
  const token = json.tokens && json.tokens.access_token;
  if (!token) throw new Error('Login succeeded but no access_token in response.');
  setSession(env, token, email);
  return token;
}

// ---- GraphQL ----
const GRAPHQL_PATH = '/graphql';

async function gql(env, operationName, query, variables) {
  const token = getToken(env);
  if (!token) throw new Error('Not logged in. Log in to the CMS first.');
  const res = await fetch(ENVS[env].api + GRAPHQL_PATH, {
    method: 'POST',
    headers: {
      accept: '*/*',
      'content-type': 'application/json',
      'x-vendor': VENDOR,
      authorization: token.startsWith('Bearer ') ? token : `Bearer ${token}`,
    },
    credentials: 'omit',
    body: JSON.stringify({ operationName, query, variables }),
  });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* non-JSON */ }
  if (json && json.errors) {
    const msg = JSON.stringify(json.errors);
    if (/no token found|unauthor|expired|invalid token/i.test(msg)) {
      throw new AuthError('Session expired — log in again.');
    }
    throw new Error(msg);
  }
  if (!json || !json.data) {
    if (/no token found|unauthor/i.test(text)) throw new AuthError('Session expired — log in again.');
    throw new Error(`No data from ${operationName} (HTTP ${res.status}): ${text.slice(0, 200)}`);
  }
  return json.data;
}

export class AuthError extends Error {}

const SINGLE_MODEL_TEST_QUERY = `query SingleModelTest($id: String!) {
  modelTest(id: $id) {
    id title class group stages { id title serial type subject_id }
  }
}`;
const MCQ_EXAM_QUERY = `query MCQExam($id: String!) {
  mcqExam(id: $id) {
    id title is_active is_published parent_id parent_type
    subject { code display display_bn }
    chapters { id name no }
  }
}`;
const CREATE_MCQ_RELATION_MUTATION = `mutation CreateMcqRelation($exam_session_id: String, $question_id: String, $question_ids: [String]) {
  createMcqRelation(exam_session_id: $exam_session_id, question_id: $question_id, question_ids: $question_ids) {
    relations { id question_id exam_session_id title }
  }
}`;

const LIST_LIVE_EXAM_SESSIONS_QUERY = `query ListLiveExamV2($exam_type: LiveExamSessionTypeEnum!, $chapter_ids: [String], $is_active: Boolean, $subject_id: String, $title: String, $page_size: Int, $page_number: Int) {
  listLiveExamV2(exam_type: $exam_type, chapter_ids: $chapter_ids, is_active: $is_active, subject_id: $subject_id, title: $title, page_size: $page_size, page_number: $page_number) {
    data { id title exam_type is_active start_time end_time total_number_of_question subject { code display display_bn class group } chapters { id name no } }
    meta { count }
  }
}`;
const CREATE_LIVE_EXAM_QUESTION_MUTATION = `mutation CreateLiveExamMCQQuestion($question_no: String, $allocated_marks: Float, $allocated_time: Float, $solution: String, $title: String, $correct_option: String, $subject_id: String, $chapter_id: String, $live_exam_session_id: String, $question_type: LiveExamSessionTypeEnum, $topic_ids: [String], $difficulty_level: DifficultyLevelTypeEnum, $has_math_equation: Boolean, $mcq_options: [CreateAcademicProgramMCQOptionsInputObject], $is_active: Boolean = true, $markdown_version: Int) {
  createAcademicProgramLiveExamQuestion(subject_id: $subject_id, chapter_id: $chapter_id, question_no: $question_no, question_type: $question_type, topic_ids: $topic_ids, allocated_marks: $allocated_marks, allocated_time: $allocated_time, difficulty_level: $difficulty_level, has_math_equation: $has_math_equation, solution: $solution, title: $title, correct_option: $correct_option, mcq_options: $mcq_options, exam_session_id: $live_exam_session_id, is_active: $is_active, markdown_version: $markdown_version) {
    id live_exam_session_id title allocated_marks allocated_time correct_option difficulty_level
  }
}`;

const PROGRAMS_QUERY = `query academicPrograms($page_number: Int, $page_size: Int) {
  academicPrograms(page_number: $page_number, page_size: $page_size) {
    data { id title title_bn classes group subjects { display display_bn code } }
    meta { count }
  }
}`;
const PHASES_QUERY = `query programPhases($program_id: String!) {
  programPhases(program_id: $program_id) { data { id title batch_id } }
}`;
const PROGRAM_CHAPTERS_QUERY = `query listAcademicProgramChapters($program_id: String!, $phase_id: String, $subject_id: String) {
  listAcademicProgramChapters(program_id: $program_id, phase_id: $phase_id, subject_id: $subject_id) {
    data { chapter_id chapter_name chapter_no subject_id subject_name }
    meta { count }
  }
}`;

const SUBJECTS_QUERY = `query subjects($class: ClassEnum, $group: StudyGroupTypeEnum) {
  subjects(class: $class, group: $group) { display display_bn code }
}`;
const CHAPTERS_QUERY = `query Chapters($subject_code: String, $pageNo: Int) {
  chapters(subject_code: $subject_code, filter: {page: $pageNo, limit: 500}) {
    data { id name no }
  }
}`;
const TOPICS_QUERY = `query Topics($chapter_id: String!, $page: Int!, $size: Int) {
  topics(chapter_id: $chapter_id, filter: {page: $page, limit: $size}) {
    data { id name no }
  }
}`;
const CREATE_QUESTION_MUTATION = `mutation CreateQuestionBank($allocated_marks: Float, $allocated_time: Float, $chapter_id: String, $correct_option: String, $description: String, $difficulty_level: DifficultyLevelTypeEnum, $has_math_equation: Boolean, $is_active: Boolean, $markdown_version: Int, $mcq_options: [CreateQuestionBankMCQOptionsInputObject], $question_type: LiveExamSessionTypeEnum, $solution: String, $subject_id: String, $title: String, $topic_ids: [String], $class: [ClassEnumCommon], $question_source_category_list: [String]) {
  createQuestionBank(allocated_marks: $allocated_marks, allocated_time: $allocated_time, chapter_id: $chapter_id, correct_option: $correct_option, description: $description, difficulty_level: $difficulty_level, has_math_equation: $has_math_equation, is_active: $is_active, markdown_version: $markdown_version, mcq_options: $mcq_options, question_type: $question_type, solution: $solution, subject_id: $subject_id, title: $title, topic_ids: $topic_ids, class: $class, question_source_category_list: $question_source_category_list) {
    id
    title
  }
}`;

// ---- per-env lookup cache (dev and prod have different IDs) ----
const caches = {};
function envCache(env) {
  if (!caches[env]) caches[env] = { subjects: {}, chapters: {}, topics: {} };
  return caches[env];
}
function resetCache(env) { caches[env] = { subjects: {}, chapters: {}, topics: {} }; }

// ---- normalisation + class/group mapping (ported from the prod userscript) ----
function normalize(v) {
  return String(v || '')
    // Bengali text can arrive composed (NFC) or decomposed (NFD) — visually
    // identical, byte-different. buildAutoRow exports NFC; the live CMS may
    // return NFD. Normalize both sides here or exact name→id matching fails on
    // names that look the same (e.g. "…জনসংখ্যা ও উন্নয়ন চর্চার সম্পর্ক").
    .normalize('NFC')
    .toLowerCase()
    .replace(/[’‘]/g, "'")
    .replace(/[–—]/g, '-')
    .replace(/[০-৯]/g, (d) => '০১২৩৪৫৬৭৮৯'.indexOf(d))
    .replace(/\s+/g, ' ')
    .trim();
}

export function needsGroup(classValue) {
  const c = normalize(classValue);
  return ['class 9', 'class 10', 'class 11', 'class 12', 'c9', 'c10', 'c11', 'c12', 'ssc', 'hsc'].includes(c);
}

function mapSubjectClass(v) {
  const x = normalize(v);
  const map = {
    'class 5': 'C5', c5: 'C5',
    'class 6': 'C6', c6: 'C6',
    'class 7': 'C7', c7: 'C7',
    'class 8': 'C8', c8: 'C8',
    'class 9': 'SSC', c9: 'SSC',
    'class 10': 'SSC', c10: 'SSC', ssc: 'SSC',
    'class 11': 'HSC', c11: 'HSC',
    'class 12': 'HSC', c12: 'HSC', hsc: 'HSC',
  };
  return map[x] || v;
}

function mapCreateClass(v) {
  const x = normalize(v);
  const map = {
    'class 5': 'C5', c5: 'C5',
    'class 6': 'C6', c6: 'C6',
    'class 7': 'C7', c7: 'C7',
    'class 8': 'C8', c8: 'C8',
    'class 9': 'C9', c9: 'C9',
    'class 10': 'C10', c10: 'C10',
    'class 11': 'C11', c11: 'C11',
    'class 12': 'C12', c12: 'C12',
  };
  return map[x] || v;
}

function mapGroup(v) {
  const x = normalize(v);
  const map = {
    sci: 'Science', science: 'Science',
    humanities: 'Humanities', hum: 'Humanities',
    business: 'Business Studies', commerce: 'Business Studies', 'business studies': 'Business Studies',
  };
  return map[x] || v || undefined;
}

function findByName(list, name, fields) {
  const target = normalize(name);
  return list.find((item) => fields.some((f) => normalize(item[f]) === target))
    || list.find((item) => fields.some((f) => {
      const value = normalize(item[f]);
      return value && (value.includes(target) || target.includes(value));
    }));
}

// Topics may be joined with '|' (userscript convention) or '; ' (formatter export).
function splitMulti(v) {
  return String(v || '').split(/[|;]/).map((x) => x.trim()).filter(Boolean);
}
function toBool(v, fallback = true) {
  if (!v) return fallback;
  return ['true', 'yes', '1', 'y'].includes(normalize(v));
}

// ---- name → id resolution ----
async function resolveSubject(env, row) {
  const cache = envCache(env);
  const subjectClass = mapSubjectClass(row.class);
  const group = row.group ? mapGroup(row.group) : undefined;
  const key = `${subjectClass}|${group || ''}`;
  if (!cache.subjects[key]) {
    const data = await gql(env, 'subjects', SUBJECTS_QUERY, { class: subjectClass, group });
    cache.subjects[key] = data.subjects || [];
  }
  const found = findByName(cache.subjects[key], row.subject, ['display', 'display_bn', 'code']);
  if (!found) {
    throw new Error(`Subject not found: ${row.subject}. Used class=${subjectClass}, group=${group || 'blank'}. Found: ${cache.subjects[key].map((s) => s.display).join(', ')}`);
  }
  return found.code;
}

async function resolveChapter(env, row, subjectId) {
  const cache = envCache(env);
  if (!cache.chapters[subjectId]) {
    const data = await gql(env, 'Chapters', CHAPTERS_QUERY, { subject_code: subjectId, pageNo: 1 });
    cache.chapters[subjectId] = (data.chapters && data.chapters.data) || [];
  }
  const found = findByName(cache.chapters[subjectId], row.chapter, ['name', 'no']);
  if (!found) {
    throw new Error(`Chapter not found: ${row.chapter}. Found: ${cache.chapters[subjectId].map((c) => c.name).join(', ')}`);
  }
  return found.id;
}

// lenient=true: skip topic names that don't exist (dev/live-mode fallback) instead of throwing.
// Returns { ids, skipped } where skipped is an array of unmatched topic names.
async function resolveTopics(env, row, chapterId, lenient = false) {
  // _topicIds: pre-resolved IDs from the live topic picker (dev default topic).
  if (Array.isArray(row._topicIds)) return { ids: row._topicIds, skipped: [] };

  const cache = envCache(env);
  if (!cache.topics[chapterId]) {
    const data = await gql(env, 'Topics', TOPICS_QUERY, { chapter_id: chapterId, page: 1, size: 500 });
    cache.topics[chapterId] = (data.topics && data.topics.data) || [];
  }
  const ids = [];
  const skipped = [];
  for (const name of splitMulti(row.topic)) {
    const found = findByName(cache.topics[chapterId], name, ['name', 'no']);
    if (!found) {
      if (lenient) { skipped.push(name); continue; }
      throw new Error(`Topic not found: ${name}. Found: ${cache.topics[chapterId].map((t) => t.name).join(', ')}`);
    }
    ids.push(found.id);
  }
  return { ids, skipped };
}

async function buildVariables(env, row) {
  // _subjectId / _chapterId / _classEnums are pre-resolved when live taxonomy mode is active.
  // _topicIds is pre-resolved when a default topic is picked in the live picker (dev mode).
  // _liveExamSessionId signals destination = Live Exam Questions (different mutation, no class field).
  // In live mode (IDs pre-set) use lenient topic matching so dev dummy names don't block uploads.
  const liveModeIds = !!(row._subjectId && row._chapterId);
  const subjectId = row._subjectId || await resolveSubject(env, row);
  const chapterId = row._chapterId || await resolveChapter(env, row, subjectId);
  const { ids: topicIds, skipped } = await resolveTopics(env, row, chapterId, liveModeIds);
  const mcq_options = [
    { no: 'A', description: row.option_a || '' },
    { no: 'B', description: row.option_b || '' },
    { no: 'C', description: row.option_c || '' },
    { no: 'D', description: row.option_d || '' },
  ];
  const common = {
    title: row.title,
    question_type: row.question_type || 'MCQ',
    has_math_equation: toBool(row.has_math_equation, true),
    allocated_time: Number(row.allocated_time || 1),
    allocated_marks: row.allocated_marks ? Number(row.allocated_marks) : undefined,
    difficulty_level: row.difficulty_level || 'Easy',
    correct_option: String(row.correct_option || '').toUpperCase(),
    solution: row.solution || '',
    is_active: toBool(row.is_active, true),
    markdown_version: Number(row.markdown_version || 1),
    subject_id: subjectId,
    chapter_id: chapterId,
    topic_ids: topicIds,
    mcq_options,
    _skippedTopics: skipped,
  };
  if (row._liveExamSessionId) {
    return { ...common, live_exam_session_id: row._liveExamSessionId, _destination: 'live_exam' };
  }
  // Question Bank fields (also used by Exam Builder, which creates a QB question then links it)
  const qbVars = {
    ...common,
    description: row.description || undefined,
    question_source_category_list: splitMulti(row.question_source_category),
    class: row._classEnums || [mapCreateClass(row.class)],
  };
  if (row._examSessionId) {
    return { ...qbVars, _examSessionId: row._examSessionId, _destination: 'exam_builder' };
  }
  return qbVars;
}

// Validate one row (returns an error string or null). i is the 0-based data index.
// When _subjectId/_chapterId are pre-resolved (live taxonomy mode), skip name-based fields.
// When _topicIds is pre-resolved (default topic from live picker), skip the topic name requirement.
export function validateRow(row, i) {
  const hasLiveIds = row._subjectId && row._chapterId;
  const hasPresetTopics = Array.isArray(row._topicIds);
  const topicFields = hasPresetTopics ? [] : ['topic'];
  const required = hasLiveIds
    ? [...topicFields, 'title', 'option_a', 'option_b', 'option_c', 'option_d', 'correct_option']
    : ['class', 'subject', 'chapter', ...topicFields, 'title', 'option_a', 'option_b', 'option_c', 'option_d', 'correct_option'];
  if (!hasLiveIds && needsGroup(row.class)) required.splice(1, 0, 'group');
  const missing = required.filter((k) => !row[k]);
  if (!['A', 'B', 'C', 'D'].includes(String(row.correct_option || '').toUpperCase())) {
    missing.push('correct_option A/B/C/D');
  }
  return missing.length ? `Row ${i + 2}: Missing/invalid ${missing.join(', ')}` : null;
}

// Destination taxonomy guard. When the upload targets a session (Live Exam or Exam Builder),
// the resolved subject/chapter of each row MUST belong to that session — otherwise the question
// is created in the Question Bank but silently never links. `expect` is built by the UI from the
// selected session: { label, subjectCode, subjectName, chapterIds, chapterNames }. `row` is the
// original row (for naming the question's own subject/chapter in the message). Returns a
// human-readable mismatch reason, or null when the row matches.
function destinationMismatch(expect, vars, row) {
  if (expect.subjectCode && vars.subject_id !== expect.subjectCode) {
    const qSubject = (row && row.subject) ? `"${row.subject}"` : 'this question';
    return `subject ${qSubject} does not match the ${expect.label}, which is "${expect.subjectName || expect.subjectCode}". `
      + `The question would be created in the Question Bank but never link. `
      + `Pick a session for ${qSubject}, or set a matching taxonomy override.`;
  }
  if (expect.chapterIds && expect.chapterIds.length && !expect.chapterIds.includes(vars.chapter_id)) {
    const qChapter = (row && row.chapter) ? `"${row.chapter}"` : 'this question';
    return `chapter ${qChapter} is not part of the ${expect.label} (it covers: ${expect.chapterNames}). `
      + `The question would be created in the Question Bank but never link. `
      + `Fix the chapter, or pick a session that includes it.`;
  }
  return null;
}

// Phase 1: resolve all IDs for every row WITHOUT creating anything.
// If any row fails, returns { ok: false, failedAt: index, resolved: <partial> }.
// No questions are created regardless of outcome.
export async function validateRows(env, rows, { onLog, onProgress, expect } = {}) {
  const log = (m) => onLog && onLog(m);
  const resolved = [];
  for (let i = 0; i < rows.length; i++) {
    try {
      log(`🔍 Row ${i + 2}: resolving IDs…`);
      const vars = await buildVariables(env, rows[i]);
      if (expect) {
        const mm = destinationMismatch(expect, vars, rows[i]);
        if (mm) {
          log(`❌ Row ${i + 2}: ${mm}`);
          onProgress && onProgress(i + 1, rows.length);
          return { ok: false, failedAt: i, resolved };
        }
      }
      if (vars._skippedTopics && vars._skippedTopics.length) {
        if (vars._destination === 'live_exam' && (!vars.topic_ids || vars.topic_ids.length === 0)) {
          log(`❌ Row ${i + 2}: Live Exam questions require at least one topic. Topic(s) not found in ${env}: ${vars._skippedTopics.join(', ')}. Either create these topics in the ${env} CMS, or pick a "Default topic" in the taxonomy override picker.`);
          onProgress && onProgress(i + 1, rows.length);
          return { ok: false, failedAt: i, resolved };
        }
        log(`⚠ Row ${i + 2}: topic(s) not in ${env} (will upload without): ${vars._skippedTopics.join(', ')}`);
      }
      if (vars._destination === 'live_exam' && (!vars.topic_ids || vars.topic_ids.length === 0)) {
        log(`❌ Row ${i + 2}: Live Exam questions require at least one topic but none is set. Pick a "Default topic" in the taxonomy override picker.`);
        onProgress && onProgress(i + 1, rows.length);
        return { ok: false, failedAt: i, resolved };
      }
      log(`✓ Row ${i + 2}: OK`);
      resolved.push(vars);
    } catch (e) {
      log(`❌ Row ${i + 2}: ${e.message || e}`);
      if (e instanceof AuthError) throw e;
      onProgress && onProgress(i + 1, rows.length);
      return { ok: false, failedAt: i, resolved };
    }
    onProgress && onProgress(i + 1, rows.length);
    await new Promise((r) => setTimeout(r, 150));
  }
  return { ok: true, failedAt: null, resolved };
}

// Phase 2: create questions from pre-validated vars (output of validateRows).
// Stops on the first creation error and returns stoppedAt for potential retry.
// startFrom allows resuming from a specific index if a creation error occurred.
export async function createFromResolved(env, resolved, { onLog, onProgress, onId, startFrom = 0 } = {}) {
  const log = (m) => onLog && onLog(m);
  const ids = [];
  let success = 0, failed = 0;
  for (let i = startFrom; i < resolved.length; i++) {
    try {
      const destLabels = { live_exam: 'Live Exam Session', exam_builder: 'Exam Builder MCQ Session' };
      const dest = destLabels[resolved[i]._destination] || 'Question Bank';
      log(`⏳ Row ${i + 2}: creating in ${dest}…`);
      const res = await createQuestion(env, resolved[i]);
      success++;
      ids.push(res.id);
      onId && onId(res.id);
      log(`✅ Row ${i + 2}: created ${res.id}`);
    } catch (e) {
      failed++;
      log(`❌ Row ${i + 2}: ${e.message || e}`);
      if (e instanceof AuthError) { onProgress && onProgress(i + 1, resolved.length); throw e; }
      log(`\nStopped at row ${i + 2}. Fix this question and retry, or skip it.`);
      onProgress && onProgress(i + 1, resolved.length);
      return { success, failed, ids, stoppedAt: i };
    }
    onProgress && onProgress(i + 1, resolved.length);
    await new Promise((r) => setTimeout(r, 300));
  }
  return { success, failed, ids, stoppedAt: null };
}

// Routes to the correct mutation(s) based on _destination, strips internal fields before sending.
async function createQuestion(env, vars) {
  const { _destination, _skippedTopics, _examSessionId, ...cleanVars } = vars;
  if (_destination === 'live_exam') {
    const data = await gql(env, 'CreateLiveExamMCQQuestion', CREATE_LIVE_EXAM_QUESTION_MUTATION, cleanVars);
    return data.createAcademicProgramLiveExamQuestion;
  }
  // Question Bank (or Exam Builder — same first step)
  const data = await gql(env, 'CreateQuestionBank', CREATE_QUESTION_MUTATION, cleanVars);
  const question = data.createQuestionBank;
  if (_destination === 'exam_builder' && _examSessionId) {
    // Link the new question to the MCQ session
    await gql(env, 'CreateMcqRelation', CREATE_MCQ_RELATION_MUTATION, {
      exam_session_id: _examSessionId,
      question_id: question.id,
      question_ids: [question.id],
    });
  }
  return question;
}

// ---- program / phase / chapter live lookups ----

export async function fetchPrograms(env, { pageSize = 500 } = {}) {
  const data = await gql(env, 'academicPrograms', PROGRAMS_QUERY, { page_number: 1, page_size: pageSize });
  return (data.academicPrograms && data.academicPrograms.data) || [];
}

export async function fetchPhases(env, programId) {
  const data = await gql(env, 'programPhases', PHASES_QUERY, { program_id: programId });
  return (data.programPhases && data.programPhases.data) || [];
}

export async function fetchProgramChapters(env, programId, phaseId, subjectCode) {
  const vars = { program_id: programId };
  if (phaseId) vars.phase_id = phaseId;
  if (subjectCode) vars.subject_id = subjectCode;
  const data = await gql(env, 'listAcademicProgramChapters', PROGRAM_CHAPTERS_QUERY, vars);
  return (data.listAcademicProgramChapters && data.listAcademicProgramChapters.data) || [];
}

// Fallback: fetch chapters directly by subject code (used when program has no linked chapters).
export async function fetchSubjectChapters(env, subjectCode) {
  const data = await gql(env, 'Chapters', CHAPTERS_QUERY, { subject_code: subjectCode, pageNo: 1 });
  const list = (data.chapters && data.chapters.data) || [];
  return list.map((c) => ({ chapter_id: c.id, chapter_name: c.name, chapter_no: c.no }));
}

export async function fetchModelTest(env, modelTestId) {
  const data = await gql(env, 'SingleModelTest', SINGLE_MODEL_TEST_QUERY, { id: modelTestId });
  return data.modelTest || null;
}

export async function fetchMcqExam(env, sessionId) {
  const data = await gql(env, 'MCQExam', MCQ_EXAM_QUERY, { id: sessionId });
  return data.mcqExam || null;
}

export async function fetchLiveExamSessions(env, { chapterIds = [], subjectId, examType = 'MCQ', title, pageSize = 300 } = {}) {
  const vars = { exam_type: examType, page_size: pageSize, page_number: 1 };
  if (chapterIds.length) vars.chapter_ids = chapterIds;
  if (subjectId) vars.subject_id = subjectId;
  if (title) vars.title = title;
  const data = await gql(env, 'ListLiveExamV2', LIST_LIVE_EXAM_SESSIONS_QUERY, vars);
  return (data.listLiveExamV2 && data.listLiveExamV2.data) || [];
}

export async function fetchSubjects(env, classEnum, group) {
  const data = await gql(env, 'subjects', SUBJECTS_QUERY, { class: classEnum, group: group || undefined });
  return data.subjects || [];
}

export async function fetchTopicsForChapter(env, chapterId) {
  const cache = envCache(env);
  if (!cache.topics[chapterId]) {
    const data = await gql(env, 'Topics', TOPICS_QUERY, { chapter_id: chapterId, page: 1, size: 500 });
    cache.topics[chapterId] = (data.topics && data.topics.data) || [];
  }
  return cache.topics[chapterId];
}

// Upload an array of rows (already in the Auto-Input column schema).
// Options:
//   stopOnError (default true)  — halt on the first failure; returns stoppedAt index so caller
//                                 can resume from that row after fixing the cause.
//   startFrom   (default 0)     — skip rows before this index (used for resume).
// Returns { success, failed, ids, stoppedAt } where stoppedAt is the failed row index or null.
export async function uploadRows(env, rows, { onLog, onProgress, onId, stopOnError = true, startFrom = 0 } = {}) {
  const log = (m) => onLog && onLog(m);
  const ids = [];
  let success = 0, failed = 0;
  for (let i = startFrom; i < rows.length; i++) {
    try {
      log(`⏳ Row ${i + 2}: resolving IDs…`);
      const vars = await buildVariables(env, rows[i]);
      if (vars._skippedTopics && vars._skippedTopics.length) {
        log(`⚠ Row ${i + 2}: ${vars._skippedTopics.length} topic(s) not matched in this env — uploading without them: ${vars._skippedTopics.join(', ')}`);
      }
      log(`⏳ Row ${i + 2}: creating question…`);
      const { _skippedTopics, ...cleanVars } = vars;
      const res = await createQuestion(env, cleanVars);
      success++;
      ids.push(res.id);
      onId && onId(res.id);
      log(`✅ Row ${i + 2}: created ${res.id}`);
    } catch (e) {
      failed++;
      log(`❌ Row ${i + 2}: ${e.message || e}`);
      if (e instanceof AuthError) { onProgress && onProgress(i + 1, rows.length); throw e; }
      if (stopOnError) {
        log(`\nStopped after row ${i + 2} error. Fix the issue then resume or skip this row.`);
        onProgress && onProgress(i + 1, rows.length);
        return { success, failed, ids, stoppedAt: i };
      }
    }
    onProgress && onProgress(i + 1, rows.length);
    await new Promise((r) => setTimeout(r, 300));
  }
  return { success, failed, ids, stoppedAt: null };
}
