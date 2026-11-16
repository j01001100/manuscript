'use strict';
// Export the manuscript: one Markdown file, or a .docx in standard manuscript
// format: 12pt Times, double-spaced, a title page, each chapter on a new page, and a
// running header with the author's surname, the title and the page number.
const zlib = require('zlib');
const store = require('./store');

const chaptersOf = (book) => book.chapters
  .map((c) => ({ title: c.title, text: store.readChapter(book.id, c.id).trim() }))
  .filter((c) => c.text);

function markdown(bookId) {
  const book = store.loadBook(bookId);
  const out = [`# ${book.title}`];
  if (book.author) out.push(`*${book.author}*`);
  for (const c of chaptersOf(book)) out.push(`## ${c.title}`, c.text);
  return `${out.join('\n\n')}\n`;
}

const x = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const RUN = '<w:rFonts w:ascii="Times New Roman" w:hAnsi="Times New Roman" w:cs="Times New Roman"/><w:sz w:val="24"/><w:szCs w:val="24"/>';

// *italic*, _italic_ and **bold** become real formatting.
function runs(line) {
  const out = [];
  const re = /(\*\*([^*]+)\*\*|\*([^*\n]+)\*|(?<![\p{L}\p{N}])_([^_\n]+)_(?![\p{L}\p{N}]))/gu;
  let last = 0;
  let m;
  const push = (t, fmt = '') => { if (t) out.push(`<w:r><w:rPr>${RUN}${fmt}</w:rPr><w:t xml:space="preserve">${x(t)}</w:t></w:r>`); };
  while ((m = re.exec(line))) {
    push(line.slice(last, m.index));
    if (m[2]) push(m[2], '<w:b/>'); else push(m[3] || m[4], '<w:i/>');
    last = m.index + m[0].length;
  }
  push(line.slice(last));
  return out.join('');
}
// One double-spaced paragraph. Word wants these properties in exactly this order.
const para = (inner, { newPage = false, before = 0, after = 0, indent = false, align = '' } = {}) => `<w:p><w:pPr>${
  newPage ? '<w:pageBreakBefore/>' : ''}<w:spacing w:before="${before}" w:after="${after}" w:line="480" w:lineRule="auto"/>${
  indent ? '<w:ind w:firstLine="720"/>' : ''}${align ? `<w:jc w:val="${align}"/>` : ''}</w:pPr>${inner}</w:p>`;
const SCENE_BREAK = /^(\*\s*\*\s*\*|#|-{3,}|⁂)$/;

const W = 'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"';
const R = 'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"';
const XML = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>';
const plain = (text) => `<w:r><w:rPr>${RUN}</w:rPr><w:t xml:space="preserve">${x(text)}</w:t></w:r>`;
const field = (code) => `<w:r><w:rPr>${RUN}</w:rPr><w:fldChar w:fldCharType="begin"/></w:r><w:r><w:rPr>${RUN}</w:rPr><w:instrText xml:space="preserve"> ${code} </w:instrText></w:r><w:r><w:rPr>${RUN}</w:rPr><w:fldChar w:fldCharType="end"/></w:r>`;

// "about 84,000 words", the way a manuscript's title page states its length.
function roundedWords(n) {
  const step = n >= 10000 ? 1000 : 100;
  return (Math.max(step, Math.round(n / step) * step)).toLocaleString('en-US');
}

function docx(bookId) {
  const book = store.loadBook(bookId);
  const chapters = chaptersOf(book);
  const words = chapters.reduce((n, c) => n + store.countWords(c.text), 0);
  const body = [];
  // Title page: title a third of the way down, then the author and the length.
  body.push(para(runs(book.title.toUpperCase()), { before: 4800, align: 'center' }));
  if (book.author) body.push(para(plain(`by ${book.author}`), { align: 'center' }));
  body.push(para(plain(`about ${roundedWords(words)} words`), { before: 480, align: 'center' }));
  for (const c of chapters) {
    // Each chapter starts on a new page, a third of the way down.
    body.push(para(runs(c.title), { newPage: true, before: 2880, after: 480, align: 'center' }));
    for (const line of c.text.split(/\n+/)) {
      const t = line.trim();
      if (!t) continue;
      if (SCENE_BREAK.test(t)) body.push(para(plain('#'), { align: 'center' }));
      else body.push(para(runs(t), { indent: true }));
    }
  }
  // Running header on every page but the title page: Surname / TITLE / page number.
  const surname = (book.author || '').trim().split(/\s+/).pop();
  const head = `${surname ? `${surname} / ` : ''}${book.title.toUpperCase()} / `;
  const header = `${XML}<w:hdr ${W}><w:p><w:pPr><w:jc w:val="right"/></w:pPr>${plain(head)}${field('PAGE')}</w:p></w:hdr>`;
  const document = `${XML}<w:document ${W} ${R}><w:body>${body.join('')}<w:sectPr><w:headerReference w:type="default" r:id="rId1"/><w:pgSz w:w="12240" w:h="15840"/><w:pgMar w:top="1440" w:right="1440" w:bottom="1440" w:left="1440" w:header="720" w:footer="720" w:gutter="0"/><w:pgNumType w:start="0"/><w:titlePg/></w:sectPr></w:body></w:document>`;
  const rel = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
  return zip([
    { name: '[Content_Types].xml', data: `${XML}<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/><Override PartName="/word/header1.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.header+xml"/></Types>` },
    { name: '_rels/.rels', data: `${XML}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="${rel}/officeDocument" Target="word/document.xml"/></Relationships>` },
    { name: 'word/document.xml', data: document },
    { name: 'word/_rels/document.xml.rels', data: `${XML}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="${rel}/header" Target="header1.xml"/></Relationships>` },
    { name: 'word/header1.xml', data: header },
  ]);
}

function zip(files) {
  const chunks = [];
  const central = [];
  let offset = 0;
  for (const f of files) {
    const name = Buffer.from(f.name);
    const data = Buffer.from(f.data);
    const comp = zlib.deflateRawSync(data);
    const crc = zlib.crc32(data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(20, 4); local.writeUInt16LE(0x0800, 6);
    local.writeUInt16LE(8, 8); local.writeUInt16LE(0, 10); local.writeUInt16LE(0x21, 12);
    local.writeUInt32LE(crc, 14); local.writeUInt32LE(comp.length, 18); local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(name.length, 26);
    chunks.push(local, name, comp);
    const cen = Buffer.alloc(46);
    cen.writeUInt32LE(0x02014b50, 0); cen.writeUInt16LE(20, 4); cen.writeUInt16LE(20, 6); cen.writeUInt16LE(0x0800, 8);
    cen.writeUInt16LE(8, 10); cen.writeUInt16LE(0, 12); cen.writeUInt16LE(0x21, 14);
    cen.writeUInt32LE(crc, 16); cen.writeUInt32LE(comp.length, 20); cen.writeUInt32LE(data.length, 24);
    cen.writeUInt16LE(name.length, 28); cen.writeUInt32LE(offset, 42);
    central.push(cen, name);
    offset += 30 + name.length + comp.length;
  }
  const cd = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(files.length, 8); end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(cd.length, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...chunks, cd, end]);
}

module.exports = { markdown, docx, roundedWords };
