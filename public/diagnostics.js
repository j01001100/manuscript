'use strict';
// Prose diagnostics. Runs in the browser with no model: counts and patterns an
// editor would mark in the margin. Every finding carries its position so the
// app can jump to it. These are prompts to look, not rules.
(function () {
  const FILTER = ['saw', 'see', 'sees', 'seeing', 'heard', 'hear', 'hears', 'felt', 'feel', 'feels', 'feeling', 'noticed', 'notice', 'notices',
    'watched', 'realized', 'realised', 'realize', 'realise', 'wondered', 'thought', 'knew', 'seemed', 'seems', 'seem', 'appeared', 'decided', 'looked like', 'could see', 'could hear', 'could feel'];
  const WEAK = ['very', 'really', 'just', 'quite', 'rather', 'somewhat', 'slightly', 'suddenly', 'somehow', 'actually', 'basically', 'literally',
    'almost', 'nearly', 'a bit', 'a little', 'sort of', 'kind of', 'began to', 'started to', 'in order to', 'the fact that', 'there was', 'there were', 'it was'];
  const CLICHES = ['heart pounded', 'heart skipped', 'heart sank', 'heart raced', 'let out a breath', "breath she didn't know", "breath he didn't know", 'blood ran cold',
    'shivers down', 'chill down', 'pit of her stomach', 'pit of his stomach', 'time stood still', 'deafening silence', 'crystal clear', 'at the end of the day',
    'in the blink of an eye', 'tears streamed', 'single tear', 'weight of the world', 'needle in a haystack', 'like a ton of bricks', 'only time would tell',
    'little did', 'calm before the storm', 'dead of night', 'easier said than done', 'eyes widened', 'jaw dropped', 'butterflies in', 'lump in her throat',
    'lump in his throat', 'knot in her stomach', 'knot in his stomach', 'white as a sheet', 'sigh of relief', 'the silence was', 'world came crashing', 'testament to',
    'tapestry', 'couldn’t help but', "couldn't help but", 'for what felt like', 'what seemed like an eternity', 'a wave of', 'washed over', 'flooded with'];
  const NOT_ADVERB = new Set(['only', 'early', 'family', 'belly', 'holy', 'lonely', 'lovely', 'ugly', 'silly', 'likely', 'unlikely', 'reply', 'supply', 'apply', 'rely', 'fly',
    'july', 'italy', 'daily', 'friendly', 'elderly', 'curly', 'early', 'ally', 'bully', 'jelly', 'folly', 'lily', 'rally', 'tally', 'ghostly', 'costly', 'deadly', 'lively',
    'homely', 'kindly', 'orderly', 'burly', 'surly', 'woolly', 'hilly', 'chilly', 'smelly', 'wobbly', 'bubbly', 'pebbly', 'stubbly', 'butterfly', 'assembly', 'anomaly', 'monopoly']);
  const STOP = new Set(('the a an and or but nor so yet of to in on at by for with from into onto over under up down out off as is are was were be been being am it its ' +
    'he she they we you i his her their our your my me him them us this that these those there here then than when where what who whom which while if not no ' +
    'had has have having do does did done would could should will shall may might must can said says say one two all some any each every more most much many ' +
    'about after before again back still even only also just very too now never ever always own same other another such through because until though although ' +
    'like went came come go got get made make know knew see saw look looked take took thing things way time').split(' '));
  const IRREGULAR = 'been|done|gone|seen|known|given|taken|made|told|found|left|kept|held|brought|built|sent|caught|bought|thought|written|broken|spoken|chosen|driven|eaten|fallen|forgotten|hidden|stolen|thrown|worn|torn|sold|paid|laid|lost|put|set|cut|shut|hit|hurt|born|drawn|shown|grown|blown|sworn|struck|hung|shot|fed|led|read|said|heard|felt|meant|spent';
  const PASSIVE = new RegExp(`\\b(?:is|are|was|were|be|been|being|am|get|gets|got)\\s+(?:\\w+ly\\s+)?(?:\\w{3,}ed|${IRREGULAR})\\b(?:\\s+by\\b)?`, 'gi');

  const phraseRe = (list) => new RegExp(`(?<![\\p{L}])(?:${list.map((s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/'/g, "['’]")).join('|')})(?![\\p{L}])`, 'giu');

  function findAll(text, re) {
    const out = [];
    let m;
    re.lastIndex = 0;
    while ((m = re.exec(text))) { out.push({ start: m.index, end: m.index + m[0].length, text: m[0] }); if (m.index === re.lastIndex) re.lastIndex++; }
    return out;
  }

  function sentences(text) {
    const out = [];
    const re = /[^.!?…\n]+(?:[.!?…]+["”’')\]]*|\n|$)/g;
    let m;
    while ((m = re.exec(text))) {
      const raw = m[0];
      const words = (raw.match(/[\p{L}\p{N}][\p{L}\p{N}'’-]*/gu) || []);
      if (words.length) out.push({ start: m.index + (raw.length - raw.trimStart().length), end: m.index + raw.trimEnd().length, words: words.length, first: words[0].toLowerCase() });
      if (m.index === re.lastIndex) re.lastIndex++;
    }
    return out;
  }

  function analyze(text) {
    const words = findAll(text, /[\p{L}\p{N}][\p{L}\p{N}'’-]*/gu);
    const sents = sentences(text);
    const n = words.length;
    const lens = sents.map((s) => s.words);
    const avg = lens.length ? lens.reduce((a, b) => a + b, 0) / lens.length : 0;
    const sd = lens.length ? Math.sqrt(lens.reduce((a, b) => a + (b - avg) ** 2, 0) / lens.length) : 0;

    // Dialogue share: words inside double quotation marks.
    let dialogue = 0;
    for (const q of findAll(text, /[“"][^”"\n]{1,2000}[”"]/g)) dialogue += (q.text.match(/[\p{L}\p{N}]+/gu) || []).length;

    const adverbs = words.filter((w) => /ly$/i.test(w.text) && w.text.length > 4 && !NOT_ADVERB.has(w.text.toLowerCase()));
    const filters = findAll(text, phraseRe(FILTER));
    const weak = findAll(text, phraseRe(WEAK));
    const cliches = findAll(text, phraseRe(CLICHES));
    const passive = findAll(text, PASSIVE);

    // The same uncommon word again within 60 words.
    const echoes = [];
    const lastSeen = new Map();
    words.forEach((w, i) => {
      const k = w.text.toLowerCase().replace(/['’]s$/, '');
      if (k.length < 5 || STOP.has(k) || /^[A-Z]/.test(w.text) && i > 0) return;
      const prev = lastSeen.get(k);
      if (prev !== undefined && i - prev.i <= 60 && i - prev.i > 0) echoes.push({ start: w.start, end: w.end, text: w.text, gap: i - prev.i });
      lastSeen.set(k, { i });
    });

    // Runs of sentences that start the same way, and runs of near-identical length.
    const starts = [];
    for (let i = 2; i < sents.length; i++) {
      if (sents[i].first === sents[i - 1].first && sents[i].first === sents[i - 2].first) {
        starts.push({ start: sents[i - 2].start, end: sents[i].end, text: `Three sentences in a row begin “${sents[i].first}”` });
        i += 2;
      }
    }
    const monotone = [];
    for (let i = 0; i + 4 < sents.length; i++) {
      const run = lens.slice(i, i + 5);
      if (Math.max(...run) - Math.min(...run) <= 3 && Math.min(...run) >= 6) {
        monotone.push({ start: sents[i].start, end: sents[i + 4].end, text: `Five sentences of about ${Math.round(run.reduce((a, b) => a + b) / 5)} words each` });
        i += 4;
      }
    }
    const long = sents.filter((s) => s.words >= 45).map((s) => ({ start: s.start, end: s.end, text: `${s.words} words` }));

    // Words leaned on most (content words only).
    const freq = new Map();
    for (const w of words) {
      const k = w.text.toLowerCase();
      if (k.length < 4 || STOP.has(k) || /^[A-Z]/.test(w.text)) continue;
      freq.set(k, (freq.get(k) || 0) + 1);
    }
    const top = [...freq.entries()].filter(([, c]) => c >= 4).sort((a, b) => b[1] - a[1]).slice(0, 12);

    return {
      words: n, sentences: sents.length, paragraphs: text.split(/\n+/).filter((p) => p.trim()).length,
      avg, sd, lens, sents, dialoguePct: n ? Math.round((dialogue / n) * 100) : 0,
      minutes: Math.max(1, Math.round(n / 250)),
      groups: [
        { key: 'cliches', label: 'Stock phrases', note: 'Phrases a reader has met too many times to see.', items: cliches },
        { key: 'filters', label: 'Filter words', note: '“She saw”, “he felt”: these put the character between the reader and the thing.', items: filters, per1000: true },
        { key: 'adverbs', label: '-ly adverbs', note: 'Often propping up a verb that should be stronger.', items: adverbs, per1000: true },
        { key: 'weak', label: 'Hedges and filler', note: '“very”, “just”, “suddenly”, “began to”, “there was”.', items: weak, per1000: true },
        { key: 'passive', label: 'Passive constructions', note: 'Sometimes right. Check each has a reason.', items: passive, per1000: true },
        { key: 'echoes', label: 'Echoes', note: 'The same word again within sixty words.', items: echoes },
        { key: 'starts', label: 'Repeated openings', note: 'Consecutive sentences starting with the same word.', items: starts },
        { key: 'monotone', label: 'Flat rhythm', note: 'Runs of sentences all the same length.', items: monotone },
        { key: 'long', label: 'Very long sentences', note: '45 words or more. Fine if controlled.', items: long },
      ],
      top,
    };
  }

  // Loaded by the page as a script, and by the tests as a module.
  if (typeof module !== 'undefined' && module.exports) module.exports = { analyze, sentences };
  else window.Diagnostics = { analyze };
})();
