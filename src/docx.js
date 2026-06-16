// DOCX -> plain text with inline $LaTeX$.
//
// Replaces mammoth.extractRawText, which silently drops OMML math objects.
// Walks word/document.xml in document order so each equation lands exactly
// where it sits in the sentence/option, wrapped as $...$.

import { unzipSync, strFromU8 } from 'fflate';
import { ommlToLatex, local } from './omml.js';

const ELEMENT_NODE = 1;

function defaultParseXml(xml) {
  // Browser-native parser.
  const doc = new DOMParser().parseFromString(xml, 'application/xml');
  return doc;
}

function elemChildren(node) {
  const out = [];
  const kids = node.childNodes;
  if (!kids) return out;
  for (let i = 0; i < kids.length; i++) {
    if (kids[i].nodeType === ELEMENT_NODE) out.push(kids[i]);
  }
  return out;
}

// Walk a paragraph (or any block), emitting text + $math$ in order.
function walkInline(node, parts) {
  for (const c of elemChildren(node)) {
    const name = local(c);
    if (name === 'oMath' || name === 'oMathPara') {
      const tex = ommlToLatex(c);
      if (tex) parts.push('$' + tex + '$');
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
      walkInline(c, parts);
    }
  }
}

// Convert a DOCX ArrayBuffer/Uint8Array to text. parseXml is injectable for
// Node tests; defaults to the browser DOMParser.
export function docxToText(buffer, parseXml = defaultParseXml) {
  const u8 = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer);
  const files = unzipSync(u8);
  const docXml = files['word/document.xml'];
  if (!docXml) throw new Error('Not a Word .docx (word/document.xml missing).');
  const doc = parseXml(strFromU8(docXml));

  const body = doc.getElementsByTagName('w:body')[0] ||
    doc.getElementsByTagName('body')[0] ||
    doc.documentElement;

  const lines = [];
  // Top-level paragraphs and tables, in order.
  for (const block of elemChildren(body)) {
    const name = local(block);
    if (name === 'p') {
      const parts = [];
      walkInline(block, parts);
      lines.push(parts.join(''));
    } else if (name === 'tbl') {
      // Flatten table cells row by row, tab-separated (topic/difficulty rows).
      for (const row of elemChildren(block)) {
        if (local(row) !== 'tr') continue;
        const cells = [];
        for (const cell of elemChildren(row)) {
          if (local(cell) !== 'tc') continue;
          const parts = [];
          walkInline(cell, parts);
          cells.push(parts.join('').trim());
        }
        lines.push(cells.join('\t'));
      }
    }
  }
  return lines.join('\n');
}
