import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { appendNote, parseJournal, saveNote, context, assemble, estimateTokens, slugify, NOTE_TYPES } from '../src/brain.mjs';

function makeBrain() {
  const dir = mkdtempSync(join(tmpdir(), 'brain-'));
  mkdirSync(join(dir, 'self'), { recursive: true });
  writeFileSync(join(dir, 'self', 'profile.md'), '# Profile\n\nWorks on distributed systems.\n');
  return { dir, git: false, timezone: 'UTC' };
}

test('a note lands in today journal with its source and type', () => {
  const o = makeBrain();
  const { file, type, date } = appendNote('the queue drains in 40 seconds', { source: 'cli', type: 'fact', ...o });
  assert.equal(type, 'fact');
  const line = readFileSync(file, 'utf8').trim().split('\n').pop();
  assert.match(line, /^- \d{2}:\d{2} \[cli\] \(fact\) the queue drains in 40 seconds$/);
  assert.match(file, new RegExp(`${date}\\.md$`));
  rmSync(o.dir, { recursive: true, force: true });
});

test('an unknown type is refused instead of silently stored', () => {
  const o = makeBrain();
  assert.throws(() => appendNote('x', { type: 'guess', ...o }), /unknown type/);
  assert.throws(() => appendNote('   ', { ...o }), /empty note/);
  rmSync(o.dir, { recursive: true, force: true });
});

test('the journal parses back into structured entries, oldest first', () => {
  const o = makeBrain();
  mkdirSync(join(o.dir, 'journal'), { recursive: true });
  writeFileSync(join(o.dir, 'journal', '2026-09-08.md'),
    '# 2026-09-08\n\n- 09:12 [phone] (fact) rewrote the retry logic\n- 14:30 [cli] (decision) dropped the second queue\nnot an entry\n');
  const entries = parseJournal({ days: 100000, ...o });
  assert.equal(entries.length, 2);
  assert.deepEqual(entries.map((e) => e.type), ['fact', 'decision']);
  assert.deepEqual(entries.map((e) => e.source), ['phone', 'cli']);
  assert.equal(entries[0].text, 'rewrote the retry logic');
});

test('an entry with no recognised tag keeps its text and falls back to the default type', () => {
  const o = makeBrain();
  mkdirSync(join(o.dir, 'journal'), { recursive: true });
  writeFileSync(join(o.dir, 'journal', '2026-09-08.md'), '- 9:05 [phone] (weird) kept as written\n');
  const [entry] = parseJournal({ days: 100000, ...o });
  assert.equal(entry.type, NOTE_TYPES[0]);
  assert.equal(entry.text, '(weird) kept as written');
  assert.equal(entry.time, '09:05');
});

test('a long note becomes its own file, named after its title', () => {
  const o = makeBrain();
  const { file, title } = saveNote('# Reading list\n\nThe Rust book, chapters 13 to 16', { source: 'phone', ...o });
  assert.equal(title, 'Reading list');
  assert.match(file, /reading-list\.md$/);
  assert.match(readFileSync(file, 'utf8'), /Saved from phone/);
});

test('context carries the profile and the journal, and skips sections that do not exist', () => {
  const o = makeBrain();
  appendNote('dropped the second queue', { type: 'decision', ...o });
  const out = context(o);
  assert.match(out, /## Profile/);
  assert.match(out, /Works on distributed systems/);
  assert.match(out, /## Journal/);
  assert.match(out, /dropped the second queue/);
  assert.ok(!out.includes('## Long notes'));
  assert.ok(!out.includes('## Latest review'));
});

test('context is empty when there is no brain at that path', () => {
  const dir = mkdtempSync(join(tmpdir(), 'empty-'));
  assert.equal(context({ dir, git: false }), '');
  rmSync(dir, { recursive: true, force: true });
});

test('slugify strips accents and punctuation, and never returns an empty name', () => {
  assert.equal(slugify('Réunion: notes du 9/09'), 'reunion-notes-du-9-09');
  assert.equal(slugify('***'), 'untitled');
});

test('assemble reports what it used and never silently drops the profile', () => {
  const o = makeBrain();
  mkdirSync(join(o.dir, 'journal'), { recursive: true });
  for (const d of ['2026-09-06', '2026-09-07', '2026-09-08']) {
    writeFileSync(join(o.dir, 'journal', `${d}.md`), `# ${d}\n\n- 09:00 [cli] (fact) ${'x'.repeat(400)}\n`);
  }
  const full = assemble({ journalDays: 100000, ...o });
  assert.equal(full.budget, Infinity);
  assert.deepEqual(full.dropped, []);
  assert.ok(full.tokens > 0);

  const tight = assemble({ journalDays: 100000, tokens: full.tokens - 120, ...o });
  assert.ok(tight.tokens < full.tokens);
  assert.match(tight.dropped.join(' '), /journal: \d+ day file/);
  assert.match(tight.text, /Works on distributed systems/);
});

test('a day that does not fit is skipped whole, never cut in half', () => {
  const o = makeBrain();
  mkdirSync(join(o.dir, 'journal'), { recursive: true });
  writeFileSync(join(o.dir, 'journal', '2026-09-08.md'), `# 2026-09-08\n\n- 09:00 [cli] (fact) ${'y'.repeat(4000)}\n`);
  const out = assemble({ journalDays: 100000, tokens: 200, ...o });
  assert.ok(!out.text.includes('yyy'));
  assert.match(out.dropped.join(' '), /1 day file/);
});

test('a profile larger than the whole budget is kept and reported as an error', () => {
  const o = makeBrain();
  writeFileSync(join(o.dir, 'self', 'profile.md'), 'z'.repeat(8000));
  const out = assemble({ tokens: 100, ...o });
  assert.match(out.text, /zzz/);
  assert.match(out.dropped.join(' '), /profile: \d+ tokens, over the whole budget/);
});

test('estimateTokens follows the configured characters per token', () => {
  assert.equal(estimateTokens('a'.repeat(40), { charsPerToken: 4 }), 10);
  assert.equal(estimateTokens('a'.repeat(40), { charsPerToken: 8 }), 5);
});
