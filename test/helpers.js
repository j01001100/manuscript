'use strict';
// Every test file gets its own empty books folder and config file, so nothing here can
// touch a real manuscript. Require this before anything from lib/.
const fs = require('fs');
const os = require('os');
const path = require('path');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'manuscript-test-'));
process.env.BOOKS_ROOT = path.join(dir, 'books');
process.env.MANUSCRIPT_CONFIG = path.join(dir, 'config.json');
process.on('exit', () => fs.rmSync(dir, { recursive: true, force: true }));

// `n` words of filler that never repeats a capitalised name.
const words = (n, word = 'lorem') => Array.from({ length: n }, (_, i) => (i % 12 === 11 ? `${word}.` : word)).join(' ');

module.exports = { dir, words };
