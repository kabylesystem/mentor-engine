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
  pushAttempts: Number(process.env.BRAIN_PUSH_ATTEMPTS || 4),
  retryBaseMs: Number(process.env.BRAIN_RETRY_MS || 250),
  tokens: Number(process.env.BRAIN_TOKENS || 0),
  charsPerToken: Number(process.env.BRAIN_CHARS_PER_TOKEN || 4),
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

// Four clients write to the same repository with no lock between them. A push therefore
// fails routinely, not exceptionally: someone else committed first. Rebasing our single
// commit on top of theirs is safe here because every write is an append to a different
// line, or a new file. We retry a few times, then give up and leave the work on disk.
function commit(paths, message, o) {
  if (!o.git) return { committed: false, pushed: false, attempts: 0 };
  try {
    git(['add', ...paths], o);
    git(['commit', '--quiet', '-m', message], o);
  } catch (err) {
    return { committed: false, pushed: false, attempts: 0, error: short(err) };
  }
  for (let attempt = 1; attempt <= o.pushAttempts; attempt += 1) {
    try {
      git(['push', '--quiet'], o, 30_000);
      return { committed: true, pushed: true, attempts: attempt };
    } catch (err) {
      if (attempt === o.pushAttempts) {
        console.error(`[brain] push failed after ${attempt} attempts, the commit is local:`, short(err));
        return { committed: true, pushed: false, attempts: attempt, error: short(err) };
      }
      try {
        git(['pull', '--rebase', '--quiet'], o, 30_000);
      } catch (rebaseErr) {
        try { git(['rebase', '--abort'], o); } catch {}
        console.error('[brain] rebase failed, resolve by hand:', short(rebaseErr));
        return { committed: true, pushed: false, attempts: attempt, error: short(rebaseErr) };
      }
      sleep(o.retryBaseMs * attempt);
    }
  }
  return { committed: true, pushed: false, attempts: o.pushAttempts };
}

function short(err) {
  return String(err.stderr || err.message).trim().slice(0, 300);
}

function sleep(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
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
  const sync = commit(['journal'], `journal: note from ${source} on ${date}`, c);
  return { file, date, type: kind, source, text: clean, sync };
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
  const sync = commit(['notes'], `notes: ${title}`, c);
  return { file, title, sync };
}

export function estimateTokens(text, o = {}) {
  return Math.ceil(String(text).length / opts(o).charsPerToken);
}

// Context assembly is the actual problem this repository exists for. The brain grows
// forever, the window does not, so something has to be left out on every single call.
// The policy below is deliberate and reported back, rather than being an implicit
// truncation nobody notices:
//
//   1. the profile is never dropped. It is small, hand written, and it is the part that
//      makes the rest legible. If it alone exceeds the budget, that is a real error and
//      the caller should know.
//   2. the journal is filled newest first, one day at a time. Half a day is worse than
//      no day, so a file that does not fit whole is skipped rather than cut.
//   3. long notes and the latest review are optional. They are added while budget is
//      left, in that order.
//
// Returns the assembled text plus what it cost and what was left out, so an agent can say
// "I am missing the last eleven days" instead of quietly answering with a hole in it.
export function assemble(o = {}) {
  const c = opts(o);
  const budget = Number.isFinite(c.tokens) && c.tokens > 0 ? c.tokens : Infinity;
  const dropped = [];
  const sections = [];
  let used = 0;

  const cost = (text) => estimateTokens(text, c);
  const push = (name, text) => {
    const n = cost(text);
    if (used + n > budget) return false;
    sections.push(text);
    used += n;
    return true;
  };

  if (!hasBrain(c)) return { text: '', tokens: 0, budget, sections: [], dropped: ['brain: not found'] };
  pull(c);

  const self = readDir(join(c.dir, 'self')).map((f) => readFileSync(join(c.dir, 'self', f), 'utf8').trim());
  if (self.length) {
    const block = `## Profile, the source of truth\n\n${self.join('\n\n---\n\n')}`;
    const n = cost(block);
    sections.push(block);
    used += n;
    if (n > budget) dropped.push(`profile: ${n} tokens, over the whole budget of ${budget}`);
  }

  const journalDir = join(c.dir, 'journal');
  const cutoff = localDate(c, new Date(Date.now() - c.journalDays * 86_400_000));
  const days = readDir(journalDir).filter((f) => f.slice(0, 10) >= cutoff).reverse();
  const kept = [];
  let skippedDays = 0;
  for (const f of days) {
    const chunk = readFileSync(join(journalDir, f), 'utf8').trim();
    const header = kept.length ? 0 : cost(`## Journal, last ${c.journalDays} days, most recent first\n\n`);
    if (used + header + cost(chunk) + 2 > budget) { skippedDays += 1; continue; }
    kept.push(chunk);
    used += header + cost(chunk) + 2;
  }
  if (kept.length) sections.push(`## Journal, last ${c.journalDays} days, most recent first\n\n${kept.join('\n\n')}`);
  else sections.push('## Journal: nothing in the recent window.');
  if (skippedDays) dropped.push(`journal: ${skippedDays} day file${skippedDays > 1 ? 's' : ''} did not fit`);

  const notes = readDir(join(c.dir, 'notes')).map((f) => readFileSync(join(c.dir, 'notes', f), 'utf8').trim());
  if (notes.length) {
    const block = `## Long notes\n\n${notes.join('\n\n---\n\n')}`;
    if (!push('notes', block)) dropped.push(`long notes: ${cost(block)} tokens did not fit`);
  }

  const reviews = readDir(join(c.dir, 'reviews'));
  if (reviews.length) {
    const last = reviews[reviews.length - 1];
    const block = `## Latest review (${last.slice(0, 10)})\n\n${readFileSync(join(c.dir, 'reviews', last), 'utf8').trim()}`;
    if (!push('review', block)) dropped.push('latest review: did not fit');
  }

  return { text: sections.join('\n\n'), tokens: used, budget, sections: sections.length, dropped };
}

export function context(o = {}) {
  return assemble(o).text;
}
