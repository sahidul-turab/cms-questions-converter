// DOCX -> plain text with inline $LaTeX$ and image placeholders.
//
// Replaces mammoth.extractRawText, which silently drops both OMML math objects
// AND embedded images. Walks word/document.xml in document order so each
// equation / image lands exactly where it sits in the sentence/option.
//
// Math  -> $...$  (see omml.js)
// Image -> <img src="IMG_PLACEHOLDER_PREFIX + <media-basename>" width=".." height=".."/>
//          e.g. <img src="shikho-img:image1.png" width="450" height="250"/>
//          The bytes travel out in the returned `images` map; the app uploads
//          each one and rewrites the placeholder src to the hosted CMS URL
//          (<img src="https://res.cloudinary.com/..." width=".." height=".."/>),
//          which is exactly the HTML the CMS question/option/solution boxes use.

import { unzipSync, strFromU8 } from 'fflate';
import { ommlToLatex, local, elemChildren } from './omml.js';

const ELEMENT_NODE = 1;

// URL scheme used inside the placeholder src so the parser leaves the tag alone
// (no brackets/numbers it would treat as metadata) and the app can find images
// to upload by basename. The CMS pastes images as a fixed-size <img> tag.
export const IMG_PLACEHOLDER_PREFIX = 'shikho-img:';
export const IMG_DEFAULT_WIDTH = 450;
export const IMG_DEFAULT_HEIGHT = 250;
export const imgPlaceholder = (basename) =>
  `<img src="${IMG_PLACEHOLDER_PREFIX}${basename}" width="${IMG_DEFAULT_WIDTH}" height="${IMG_DEFAULT_HEIGHT}"/>`;

const MIME_BY_EXT = {
  png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif',
  bmp: 'image/bmp', webp: 'image/webp', tiff: 'image/tiff', svg: 'image/svg+xml',
  emf: 'image/emf', wmf: 'image/wmf',
};
function mimeFor(name) {
  const ext = (name.split('.').pop() || '').toLowerCase();
  return MIME_BY_EXT[ext] || 'application/octet-stream';
}

function defaultParseXml(xml) {
  // Browser-native parser.
  return new DOMParser().parseFromString(xml, 'application/xml');
}

// The "relationships" namespace, used by r:embed / r:id on image elements.
const REL_NS = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';

function relId(node) {
  if (!node.getAttribute) return null;
  // a:blip uses r:embed; v:imagedata (legacy VML) uses r:id.
  return node.getAttribute('r:embed') || node.getAttribute('r:id') ||
    (node.getAttributeNS ? (node.getAttributeNS(REL_NS, 'embed') || node.getAttributeNS(REL_NS, 'id')) : null);
}

// Find the relationship id of the first image reference under a drawing/pict.
function findImageRid(node) {
  for (const c of elemChildren(node)) {
    const name = local(c);
    if (name === 'blip' || name === 'imagedata') {
      const id = relId(c);
      if (id) return id;
    }
    const nested = findImageRid(c);
    if (nested) return nested;
  }
  return null;
}

// Parse word/_rels/document.xml.rels -> { rId: "word/media/imageN.png" }.
function buildRels(files, parseXml) {
  const relsXml = files['word/_rels/document.xml.rels'];
  const map = {};
  if (!relsXml) return map;
  const doc = parseXml(strFromU8(relsXml));
  const rels = doc.getElementsByTagName('Relationship');
  for (let i = 0; i < rels.length; i++) {
    const r = rels[i];
    const id = r.getAttribute('Id');
    const target = r.getAttribute('Target');
    const mode = r.getAttribute('TargetMode');
    if (!id || !target || mode === 'External') continue;
    // Targets are relative to word/ (e.g. "media/image1.png").
    map[id] = 'word/' + target.replace(/^\.?\//, '').replace(/^\.\.\//, '');
  }
  return map;
}

// Walk a paragraph (or any block), emitting text + $math$ + ![](image) in order.
// ctx = { rels, files, images } — images collects { basename: { bytes, contentType } }.
function walkInline(node, parts, ctx) {
  for (const c of elemChildren(node)) {
    const name = local(c);
    if (name === 'oMath' || name === 'oMathPara') {
      const tex = ommlToLatex(c);
      if (tex) parts.push('$' + tex + '$');
    } else if (name === 'drawing' || name === 'pict' || name === 'object') {
      emitImage(c, parts, ctx);
    } else if (name === 't') {
      parts.push(c.textContent || '');
    } else if (name === 'tab') {
      parts.push('\t');
    } else if (name === 'br' || name === 'cr') {
      parts.push('\n');
    } else if (name === 'noBreakHyphen') {
      parts.push('-');
    } else {
      // Descend into runs, hyperlinks, smartTags, etc.
      walkInline(c, parts, ctx);
    }
  }
}

// Resolve a drawing/pict to its media file, record the bytes, and emit the
// inline placeholder. Falls back to nothing if the image can't be resolved
// (better a missing image than a crash), but that path is rare.
function emitImage(node, parts, ctx) {
  const rid = findImageRid(node);
  if (!rid) return;
  const path = ctx.rels[rid];
  if (!path || !ctx.files[path]) return;
  const basename = path.split('/').pop();
  if (!ctx.images[basename]) {
    ctx.images[basename] = { bytes: ctx.files[path], contentType: mimeFor(basename) };
  }
  parts.push(imgPlaceholder(basename));
}

// Core: returns { text, images }. parseXml is injectable for Node tests.
export function docxToContent(buffer, parseXml = defaultParseXml) {
  const u8 = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer);
  const files = unzipSync(u8);
  const docXml = files['word/document.xml'];
  if (!docXml) throw new Error('Not a Word .docx (word/document.xml missing).');
  const doc = parseXml(strFromU8(docXml));

  const body = doc.getElementsByTagName('w:body')[0] ||
    doc.getElementsByTagName('body')[0] ||
    doc.documentElement;

  const ctx = { rels: buildRels(files, parseXml), files, images: {} };
  const lines = [];
  // Top-level paragraphs and tables, in order.
  for (const block of elemChildren(body)) {
    const name = local(block);
    if (name === 'p') {
      const parts = [];
      walkInline(block, parts, ctx);
      lines.push(parts.join(''));
    } else if (name === 'tbl') {
      // Flatten table cells row by row, tab-separated (topic/difficulty rows).
      for (const row of elemChildren(block)) {
        if (local(row) !== 'tr') continue;
        const cells = [];
        for (const cell of elemChildren(row)) {
          if (local(cell) !== 'tc') continue;
          const parts = [];
          walkInline(cell, parts, ctx);
          cells.push(parts.join('').trim());
        }
        lines.push(cells.join('\t'));
      }
    }
  }
  return { text: lines.join('\n'), images: ctx.images };
}

// Back-compat: text-only. Existing tools/tests keep working unchanged.
export function docxToText(buffer, parseXml = defaultParseXml) {
  return docxToContent(buffer, parseXml).text;
}
