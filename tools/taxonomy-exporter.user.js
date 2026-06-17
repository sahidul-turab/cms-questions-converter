// ==UserScript==
// @name         Shikho CMS Taxonomy Exporter
// @namespace    shikho-cms-formatter
// @version      1.1
// @description  Walk Class -> Subject -> Chapter -> Topic on cms.shikho.com and download a single taxonomy.json for the CMS Question Formatter dropdowns. No token is stored in the script — it is captured live from your own session.
// @match        https://cms.shikho.com/*
// @run-at       document-start
// @grant        GM_xmlhttpRequest
// @connect      api.shikho.com
// ==/UserScript==

(function () {
  'use strict';

  const API = 'https://api.shikho.com/graphql';

  // ---- subject-lookup class enums (NOT the create-mutation C9/C10/... enums) ----
  // Class 9/10 share the SSC subject tree; Class 11/12 share HSC. We fetch each
  // enum once and let the formatter map friendly labels -> enum.
  const GROUPS = ['Science', 'Humanities', 'Business Studies'];
  const PLAN = [
    { enum: 'C6', groups: [''] },
    { enum: 'C7', groups: [''] },
    { enum: 'C8', groups: [''] },
    { enum: 'SSC', groups: GROUPS },
    { enum: 'HSC', groups: GROUPS },
  ];
  const CLASS_LABEL_TO_ENUM = {
    'Class 6': 'C6', 'Class 7': 'C7', 'Class 8': 'C8',
    'Class 9': 'SSC', 'Class 10': 'SSC', 'Class 11': 'HSC', 'Class 12': 'HSC',
  };

  // ---- minimal queries (only the fields the dropdowns need) ----
  const Q_SUBJECTS = `query subjects($class: ClassEnum, $group: StudyGroupTypeEnum) {
  subjects(class: $class, group: $group) { display display_bn code }
}`;
  const Q_CHAPTERS = `query Chapters($subject_code: String, $pageNo: Int) {
  chapters(subject_code: $subject_code, filter: {page: $pageNo, limit: 500}) {
    data { id name no active } meta { count }
  }
}`;
  const Q_TOPICS = `query Topics($chapter_id: String!, $page: Int!, $size: Int) {
  topics(chapter_id: $chapter_id, filter: {page: $page, limit: $size}) {
    data { id name no } meta { count }
  }
}`;

  // ---- capture the Authorization header live from the page's own GraphQL calls ----
  // IMPORTANT: with @grant, the userscript runs in a sandbox, so we must patch the
  // REAL page window (unsafeWindow), not our sandboxed copy, to see the app's calls.
  const PAGE = (typeof unsafeWindow !== 'undefined') ? unsafeWindow : window;
  let TOKEN = null;
  function rememberToken(headers) {
    if (!headers) return;
    const auth = headers.authorization || headers.Authorization ||
      (typeof headers.get === 'function' ? headers.get('authorization') : null);
    if (auth && /^Bearer /.test(auth)) TOKEN = auth;
  }
  try {
    const _fetch = PAGE.fetch;
    PAGE.fetch = function (input, init) {
      try {
        const url = typeof input === 'string' ? input : (input && input.url);
        if (url && url.indexOf('/graphql') !== -1) {
          rememberToken((init && init.headers) || (input && input.headers));
        }
      } catch (e) { /* ignore */ }
      return _fetch.apply(this, arguments);
    };
    const XHR = PAGE.XMLHttpRequest.prototype;
    const _open = XHR.open;
    const _setRH = XHR.setRequestHeader;
    XHR.open = function (m, u) { this.__isGql = (u || '').indexOf('/graphql') !== -1; return _open.apply(this, arguments); };
    XHR.setRequestHeader = function (k, v) {
      if (this.__isGql && /^authorization$/i.test(k) && /^Bearer /.test(v)) TOKEN = v;
      return _setRH.apply(this, arguments);
    };
  } catch (e) { console.warn('[taxonomy] hook install failed', e); }

  // Fallback: pull the JWT straight out of the app's storage (no timing needed).
  function tokenFromStorage() {
    const jwt = /eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/;
    const stores = [];
    try { stores.push(PAGE.localStorage); } catch (e) { /* ignore */ }
    try { stores.push(PAGE.sessionStorage); } catch (e) { /* ignore */ }
    for (const store of stores) {
      if (!store) continue;
      for (let i = 0; i < store.length; i++) {
        const v = store.getItem(store.key(i));
        const m = v && v.match(jwt);
        if (m) return 'Bearer ' + m[0];
      }
    }
    return null;
  }
  function ensureToken() {
    if (!TOKEN) TOKEN = tokenFromStorage();
    return TOKEN;
  }

  // ---- GraphQL via GM_xmlhttpRequest (bypasses CORS, same as the exporter) ----
  function gql(operationName, query, variables) {
    return new Promise((resolve, reject) => {
      if (!ensureToken()) return reject(new Error('No auth token found. Do one search/click in CMS first, then retry.'));
      GM_xmlhttpRequest({
        method: 'POST',
        url: API,
        headers: { 'content-type': 'application/json', 'authorization': TOKEN, 'x-vendor': 'shikho' },
        data: JSON.stringify({ operationName, query, variables }),
        onload: (r) => {
          try {
            const j = JSON.parse(r.responseText);
            if (j.errors) return reject(new Error(JSON.stringify(j.errors)));
            resolve(j.data);
          } catch (e) { reject(e); }
        },
        onerror: () => reject(new Error('Network error calling ' + operationName)),
      });
    });
  }

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  async function fetchChapters(subjectCode) {
    const all = [];
    for (let page = 1; page <= 50; page++) {
      const d = await gql('Chapters', Q_CHAPTERS, { subject_code: subjectCode, pageNo: page });
      const rows = (d && d.chapters && d.chapters.data) || [];
      all.push(...rows);
      if (rows.length < 500) break;
      await sleep(120);
    }
    return all;
  }

  async function fetchTopics(chapterId) {
    const all = [];
    const size = 200;
    for (let page = 1; page <= 50; page++) {
      const d = await gql('Topics', Q_TOPICS, { chapter_id: chapterId, page, size });
      const rows = (d && d.topics && d.topics.data) || [];
      all.push(...rows);
      if (rows.length < size) break;
      await sleep(120);
    }
    return all;
  }

  // ---- UI ----
  const log = (msg) => {
    const box = document.getElementById('tax-log');
    if (box) { box.textContent += msg + '\n'; box.scrollTop = box.scrollHeight; }
    console.log('[taxonomy]', msg);
  };

  function buildPanel() {
    const wrap = document.createElement('div');
    wrap.style.cssText = 'position:fixed;right:16px;bottom:16px;z-index:999999;width:340px;font:13px/1.4 system-ui,sans-serif;background:#fff;border:1px solid #ccc;border-radius:10px;box-shadow:0 6px 24px rgba(0,0,0,.18);overflow:hidden';
    const checks = PLAN.map((p) =>
      `<label style="display:inline-block;margin:2px 8px 2px 0"><input type="checkbox" class="tax-enum" value="${p.enum}" checked> ${p.enum}</label>`
    ).join('');
    wrap.innerHTML = `
      <div style="background:#5b3df5;color:#fff;padding:8px 12px;font-weight:600;display:flex;justify-content:space-between;align-items:center">
        <span>CMS Taxonomy Exporter</span>
        <span id="tax-close" style="cursor:pointer">×</span>
      </div>
      <div style="padding:10px 12px">
        <div style="margin-bottom:6px;color:#555">Classes to export:</div>
        <div style="margin-bottom:8px">${checks}</div>
        <button id="tax-run" style="background:#5b3df5;color:#fff;border:0;border-radius:6px;padding:7px 12px;cursor:pointer">Build &amp; download taxonomy.json</button>
        <pre id="tax-log" style="margin:10px 0 0;height:150px;overflow:auto;background:#0b1021;color:#cfe;padding:8px;border-radius:6px;white-space:pre-wrap"></pre>
      </div>`;
    document.body.appendChild(wrap);
    wrap.querySelector('#tax-close').onclick = () => wrap.remove();
    wrap.querySelector('#tax-run').onclick = run;
  }

  async function run() {
    const btn = document.getElementById('tax-run');
    btn.disabled = true; btn.textContent = 'Working…';
    const selected = Array.from(document.querySelectorAll('.tax-enum:checked')).map((c) => c.value);
    const plan = PLAN.filter((p) => selected.includes(p.enum));

    const out = {
      source: 'cms.shikho.com',
      generatedAt: new Date().toISOString(),
      classLabelToEnum: CLASS_LABEL_TO_ENUM,
      groupsByEnum: Object.fromEntries(PLAN.map((p) => [p.enum, p.groups])),
      enums: {},
    };

    try {
      let subjN = 0, chapN = 0, topN = 0;
      for (const p of plan) {
        out.enums[p.enum] = {};
        for (const group of p.groups) {
          log(`\n== ${p.enum}${group ? ' / ' + group : ''} ==`);
          const vars = group ? { class: p.enum, group } : { class: p.enum };
          const sd = await gql('subjects', Q_SUBJECTS, vars);
          const subjects = (sd && sd.subjects) || [];
          const subjOut = [];
          for (const s of subjects) {
            log(`  subject: ${s.display} (${s.code})`);
            subjN++;
            const chapters = await fetchChapters(s.code);
            const chapOut = [];
            for (const c of chapters) {
              chapN++;
              const topics = await fetchTopics(c.id);
              topN += topics.length;
              chapOut.push({
                id: c.id, no: c.no, name: c.name, active: c.active,
                topics: topics.map((t) => ({ id: t.id, no: t.no, name: t.name })),
              });
              await sleep(100);
            }
            subjOut.push({ name: s.display, name_bn: s.display_bn, code: s.code, chapters: chapOut });
          }
          out.enums[p.enum][group] = { subjects: subjOut };
        }
      }
      log(`\nDONE: ${subjN} subjects, ${chapN} chapters, ${topN} topics.`);
      download(out);
    } catch (e) {
      log('ERROR: ' + (e && e.message ? e.message : e));
    } finally {
      btn.disabled = false; btn.textContent = 'Build & download taxonomy.json';
    }
  }

  function download(obj) {
    const blob = new Blob([JSON.stringify(obj, null, 2)], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = 'taxonomy.json';
    document.body.appendChild(a); a.click(); a.remove();
    log('Downloaded taxonomy.json');
  }

  // boot
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', buildPanel);
  else buildPanel();
})();
