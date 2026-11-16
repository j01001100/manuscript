'use strict';
require('./helpers');
const test = require('node:test');
const assert = require('node:assert/strict');
const { analyze } = require('../public/diagnostics');

const group = (d, key) => d.groups.find((g) => g.key === key).items;

test('counts words, sentences, paragraphs and dialogue', () => {
  const text = 'She waited. The boat did not come.\n\n“Thursday,” he said. “Take the Thursday boat.”';
  const d = analyze(text);
  assert.equal(d.words, 14);
  assert.equal(d.sentences, 4);
  assert.equal(d.paragraphs, 2);
  assert.deepEqual(d.lens, [2, 5, 3, 4]);
  assert.equal(d.avg, 3.5);
  assert.equal(d.dialoguePct, Math.round((5 / 14) * 100));
});

test('every finding points at the right place in the text', () => {
  const text = 'She suddenly felt a wave of relief wash over her, and her heart pounded loudly. '
    + 'He saw that the ledger was taken by somebody. It was only a family matter, really.';
  const d = analyze(text);
  for (const g of d.groups) for (const it of g.items) {
    if (['starts', 'monotone', 'long'].includes(g.key)) continue;
    assert.equal(text.slice(it.start, it.end), it.text, `${g.key}: ${it.text}`);
  }
  assert.deepEqual(group(d, 'adverbs').map((i) => i.text), ['suddenly', 'loudly', 'really'], '“only” and “family” are not adverbs');
  assert.deepEqual(group(d, 'filters').map((i) => i.text.toLowerCase()), ['felt', 'saw']);
  assert.deepEqual(group(d, 'cliches').map((i) => i.text), ['a wave of', 'heart pounded']);
  assert.deepEqual(group(d, 'passive').map((i) => i.text), ['was taken by']);
  assert.ok(group(d, 'weak').some((i) => i.text === 'suddenly') && group(d, 'weak').some((i) => i.text === 'It was'));
});

test('echoes, repeated openings, flat rhythm and long sentences', () => {
  const echo = analyze('The ledger lay open. Nobody touched the ledger until the morning came round again.');
  assert.deepEqual(group(echo, 'echoes').map((i) => i.text), ['ledger']);
  assert.equal(group(analyze('Teodor came. Then Teodor went. Only Teodor knew.'), 'echoes').length, 0, 'names are not echoes');

  const starts = analyze('She rose. She dressed. She left the house. Nobody saw.');
  assert.equal(group(starts, 'starts').length, 1);
  assert.match(group(starts, 'starts')[0].text, /begin “she”/);

  const flat = analyze(Array.from({ length: 6 }, (_, i) => `Sentence number ${i} has exactly seven words here.`).join(' '));
  assert.equal(group(flat, 'monotone').length, 1);
  assert.equal(group(analyze('Short. Then a much longer sentence that goes on for a while. Tiny. Another of middling length here. No.'), 'monotone').length, 0);

  const long = analyze(`Brief. ${Array.from({ length: 50 }, (_, i) => `word${i}`).join(' ')}.`);
  assert.deepEqual(group(long, 'long').map((i) => i.text), ['50 words']);
});

test('clean prose reports nothing, and empty text does not throw', () => {
  const d = analyze('The ferry left the island twice a week. Ines missed it on purpose.');
  assert.deepEqual(d.groups.filter((g) => g.items.length).map((g) => g.key), []);
  assert.equal(analyze('').words, 0);
});
