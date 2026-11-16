'use strict';
require('./helpers');
const test = require('node:test');
const assert = require('node:assert/strict');
const zlib = require('zlib');
const store = require('../lib/store');
const exporter = require('../lib/export');

// Read a zip the way Word does: from the central directory at the end.
function unzip(buf) {
  const end = buf.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  const count = buf.readUInt16LE(end + 10);
  let at = buf.readUInt32LE(end + 16);
  const files = {};
  for (let i = 0; i < count; i++) {
    assert.equal(buf.readUInt32LE(at), 0x02014b50);
    const crc = buf.readUInt32LE(at + 16);
    const size = buf.readUInt32LE(at + 20);
    const nameLen = buf.readUInt16LE(at + 28);
    const local = buf.readUInt32LE(at + 42);
    const name = buf.toString('utf8', at + 46, at + 46 + nameLen);
    const start = local + 30 + buf.readUInt16LE(local + 26) + buf.readUInt16LE(local + 28);
    const data = zlib.inflateRawSync(buf.subarray(start, start + size));
    assert.equal(zlib.crc32(data), crc, `${name} checksum`);
    files[name] = data.toString('utf8');
    at += 46 + nameLen + buf.readUInt16LE(at + 30) + buf.readUInt16LE(at + 32);
  }
  return files;
}

function sample() {
  const book = store.createBook({ title: 'The Salt House', author: 'Ines M. Calloway' });
  store.importManuscript(book.id, 'Chapter One\n\nShe *missed* it & stayed.\n\n***\n\nA **second** scene <here>.\n\nChapter Two\n\n\n\nChapter Three\n\nThe end.');
  return book;
}

test('markdown export has the title, author and only chapters with text', () => {
  const md = exporter.markdown(sample().id);
  assert.ok(md.startsWith('# The Salt House\n\n*Ines M. Calloway*\n\n## Chapter One\n\n'));
  assert.ok(md.includes('## Chapter Three\n\nThe end.'));
  assert.ok(!md.includes('Chapter Two'));
});

test('docx is a valid package in manuscript format', () => {
  const files = unzip(exporter.docx(sample().id));
  assert.deepEqual(Object.keys(files).sort(), ['[Content_Types].xml', '_rels/.rels', 'word/_rels/document.xml.rels', 'word/document.xml', 'word/header1.xml']);
  const doc = files['word/document.xml'];

  // Title page: title, author, length.
  assert.ok(doc.includes('>THE SALT HOUSE<') && doc.includes('>by Ines M. Calloway<') && doc.includes('>about 100 words<'));
  // Chapters start on new pages; the empty chapter is left out.
  assert.equal(doc.split('<w:pageBreakBefore/>').length - 1, 2);
  // Emphasis becomes real formatting, special characters are escaped, scene breaks are a centred #.
  assert.ok(doc.includes('<w:i/></w:rPr><w:t xml:space="preserve">missed</w:t>'));
  assert.ok(doc.includes('<w:b/></w:rPr><w:t xml:space="preserve">second</w:t>'));
  assert.ok(doc.includes(' it &amp; stayed.') && doc.includes(' scene &lt;here&gt;.'));
  assert.ok(doc.includes('<w:jc w:val="center"/></w:pPr><w:r><w:rPr>') && doc.includes('>#<'));
  // Double-spaced, and every paragraph's properties are in the order Word requires.
  for (const pPr of doc.match(/<w:pPr>.*?<\/w:pPr>/g)) {
    assert.match(pPr, /^<w:pPr>(<w:pageBreakBefore\/>)?<w:spacing [^>]*w:line="480"[^>]*\/>(<w:ind [^>]*\/>)?(<w:jc [^>]*\/>)?<\/w:pPr>$/);
  }
  // Running header: surname / TITLE / page, not on the title page.
  assert.ok(files['word/header1.xml'].includes('>Calloway / THE SALT HOUSE / <'));
  assert.ok(files['word/header1.xml'].includes(' PAGE '));
  assert.ok(doc.includes('<w:headerReference w:type="default" r:id="rId1"/>') && doc.includes('<w:titlePg/>'));
  assert.ok(files['word/_rels/document.xml.rels'].includes('Target="header1.xml"'));
  assert.ok(files['[Content_Types].xml'].includes('/word/header1.xml'));
});

test('the length on the title page is rounded the way manuscripts state it', () => {
  assert.equal(exporter.roundedWords(84321), '84,000');
  assert.equal(exporter.roundedWords(84500), '85,000');
  assert.equal(exporter.roundedWords(9449), '9,400');
  assert.equal(exporter.roundedWords(12), '100');
});
