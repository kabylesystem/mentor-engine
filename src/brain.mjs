import { existsSync, mkdirSync, readdirSync, readFileSync, appendFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';

export const NOTE_TYPES = ['fact', 'decision', 'commitment', 'want', 'state'];
export const DEFAULT_NOTE_TYPE = 'fact';

const ENTRY_RE = /^-\s+(\d{1,2}:\d{2})\s+\[([^\]]+)\]\s*(?:\(([a-z]+)\)\s*)?(.+)$/;

const DEFAULTS = {
  dir: process.env.BRAIN_DIR || join(process.cwd(), 'brain'),
  timezone: process.env.BRAIN_TZ || 'UTC',
  journalDays: Number(process.env.BRAIN_JOURNAL_DAYS || 21),
  journalMaxChars: 30_000,
  notesMaxChars: 40_000,
  pullIntervalMs: 5 * 60_000,
  git: process.env.BRAIN_GIT !== '0',
};

let lastPull = 0;

function opts(o = {}) {
  return { ...DEFAULTS, ...o };
}

function git(args, o, timeout = 20_000) {
  return execFileSync('git', ['-C', o.dir, ...args], { timeout, stdio: ['ignore', 'pipe', 'pipe'] }).toString().trim();
}

function localDate(o, d = new Date()) {
  return d.toLocaleDateString('sv-SE', { timeZone: o.timezone });
}

function localTime(o, d = new Date()) {
  return d.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', timeZone: o.timezone });
}

function readDir(dir) {
  try {
    return readdirSync(dir).filter((f) => f.endsWith('.md')).sort();
  } catch {
    return [];
  }
}

export function hasBrain(o = {}) {
  return existsSync(join(opts(o).dir, 'self'));
}

export function pull(o = {}) {
  const c = opts(o);
  if (!c.git || !hasBrain(c)) return false;
  if (!c.force && Date.now() - lastPull < c.pullIntervalMs) return true;
  try {
    git(['pull', '--ff-only', '--quiet'], c);
    lastPull = Date.now();
    return true;
  } catch (err) {
    console.error('[brain] pull failed:', String(err.stderr || err.message).slice(0, 300));
    return false;
  }
}

function commit(paths, message, o) {
  if (!o.git) return;
  try {
    git(['add', ...paths], o);
    git(['commit', '--quiet', '-m', message], o);
    git(['push', '--quiet'], o, 30_000);
  } catch (err) {
    console.error('[brain] commit or push failed, the file is still on disk:', String(err.stderr || err.message).slice(0, 300));
  }
}

export function journalPath(date, o = {}) {
  const c = opts(o);
  return join(c.dir, 'journal', `${date || localDate(c)}.md`);
}

export function appendNote(text, { source = 'cli', type = DEFAULT_NOTE_TYPE, ...o } = {}) {
  const c = opts(o);
  const clean = String(text).replace(/\s+/g, ' ').trim();
  if (!clean) throw new Error('empty note');
  const kind = String(type).toLowerCase();
  if (!NOTE_TYPES.includes(kind)) throw new Error(`unknown type: ${kind}. Expected one of ${NOTE_TYPES.join(', ')}`);
  pull({ ...c, force: true });
  const date = localDate(c);
  const file = journalPath(date, c);
  mkdirSync(join(c.dir, 'journal'), { recursive: true });
  const header = existsSync(file) ? '' : `# ${date}\n\n`;
  appendFileSync(file, `${header}- ${localTime(c)} [${source}] (${kind}) ${clean}\n`);
  commit(['journal'], `journal: note from ${source} on ${date}`, c);
  return { file, date, type: kind, source, text: clean };
}

export function parseJournal({ days, ...o } = {}) {
  const c = opts(o);
  const window = Number.isFinite(days) ? days : c.journalDays;
  const dir = join(c.dir, 'journal');
  const cutoff = Number.isFinite(window) ? localDate(c, new Date(Date.now() - window * 86_400_000)) : '';
  const entries = [];
  for (const f of readDir(dir).filter((f) => f.slice(0, 10) >= cutoff)) {
    const date = f.slice(0, 10);
    let raw = '';
    try {
      raw = readFileSync(join(dir, f), 'utf8');
    } catch {
      continue;
    }
    for (const line of raw.split('\n')) {
      const m = ENTRY_RE.exec(line.trim());
      if (!m) continue;
      const [, time, source, tag, text] = m;
      const known = tag && NOTE_TYPES.includes(tag);
      entries.push({
        date,
        time: time.padStart(5, '0'),
        source,
        type: known ? tag : DEFAULT_NOTE_TYPE,
        text: known ? text.trim() : (tag ? `(${tag}) ${text}` : text).trim(),
      });
    }
  }
  return entries.sort((a, b) => `${a.date} ${a.time}`.localeCompare(`${b.date} ${b.time}`));
}

export function slugify(s) {
  return String(s)
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 60) || 'untitled';
}

export function saveNote(text, { source = 'cli', ...o } = {}) {
  const c = opts(o);
  const clean = String(text).trim();
  if (!clean) throw new Error('empty note');
  pull({ ...c, force: true });
  const lines = clean.split('\n');
  const title = lines[0].replace(/^#+\s*/, '').trim().slice(0, 80);
  const body = lines.slice(1).join('\n').trim() || clean;
  const dir = join(c.dir, 'notes');
  mkdirSync(dir, { recursive: true });
  const file = join(dir, `${slugify(title)}.md`);
  writeFileSync(file, `# ${title}\n\nSaved from ${source} on ${localDate(c)} at ${localTime(c)}\n\n${body}\n`);
  commit(['notes'], `notes: ${title}`, c);
  return { file, title };
}

// Assembles everything an agent should know, in one string, cheapest sections last.
// Sections that do not exist are skipped rather than announced.
export function context(o = {}) {
  const c = opts(o);
  if (!hasBrain(c)) return '';
  pull(c);

  const parts = [];

  const self = readDir(join(c.dir, 'self')).map((f) => readFileSync(join(c.dir, 'self', f), 'utf8').trim());
  if (self.length) parts.push(`## Profile, the source of truth\n\n${self.join('\n\n---\n\n')}`);

  const journalDir = join(c.dir, 'journal');
  const cutoff = localDate(c, new Date(Date.now() - c.journalDays * 86_400_000));
  let journal = '';
  for (const f of readDir(journalDir).filter((f) => f.slice(0, 10) >= cutoff).reverse()) {
    const chunk = `${readFileSync(join(journalDir, f), 'utf8').trim()}\n\n`;
    if (journal.length + chunk.length > c.journalMaxChars) break;
    journal += chunk;
  }
  parts.push(journal
    ? `## Journal, last ${c.journalDays} days, most recent first\n\n${journal.trim()}`
    : '## Journal: nothing in the recent window.');

  const notes = readDir(join(c.dir, 'notes')).map((f) => readFileSync(join(c.dir, 'notes', f), 'utf8').trim());
  if (notes.length) {
    let block = '';
    for (const n of notes) {
      if (block.length + n.length > c.notesMaxChars) break;
      block += `${n}\n\n---\n\n`;
    }
    parts.push(`## Long notes\n\n${block.trim()}`);
  }

  const reviews = readDir(join(c.dir, 'reviews'));
  if (reviews.length) {
    const last = reviews[reviews.length - 1];
    parts.push(`## Latest review (${last.slice(0, 10)})\n\n${readFileSync(join(c.dir, 'reviews', last), 'utf8').trim()}`);
  }

  return parts.join('\n\n');
}
