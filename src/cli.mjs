#!/usr/bin/env node
import { appendNote, saveNote, context, pull, hasBrain, parseJournal, NOTE_TYPES, DEFAULT_NOTE_TYPE } from './brain.mjs';

const USAGE = `brain <command>

  note [--type ${NOTE_TYPES.join('|')}] "text"   append one dated line to today's journal
  save "# title\\nbody"                          write a long note as its own file
  show                                           print the whole context an agent should read
  journal [--days N]                             print parsed journal entries as JSON
  sync                                           git pull the brain

Environment:
  BRAIN_DIR    path to the brain repository (default: ./brain)
  BRAIN_TZ     timezone used to date entries (default: UTC)
  BRAIN_GIT    set to 0 to skip git entirely
  BRAIN_SOURCE label written next to each entry (default: cli)
`;

function takeFlag(args, name, fallback) {
  let value = fallback;
  const rest = [];
  for (let i = 0; i < args.length; i += 1) {
    const a = args[i];
    if (a === `--${name}`) {
      value = args[i + 1] ?? '';
      i += 1;
    } else if (a.startsWith(`--${name}=`)) {
      value = a.slice(name.length + 3);
    } else {
      rest.push(a);
    }
  }
  return { value, rest };
}

const [, , cmd, ...args] = process.argv;
const source = process.env.BRAIN_SOURCE || 'cli';

function requireBrain() {
  if (hasBrain()) return;
  console.error(`no brain found: expected a "self" directory inside ${process.env.BRAIN_DIR || './brain'}`);
  process.exit(1);
}

try {
  if (cmd === 'note') {
    requireBrain();
    const { value: type, rest } = takeFlag(args, 'type', process.env.BRAIN_TYPE || DEFAULT_NOTE_TYPE);
    const text = rest.join(' ').trim();
    if (!text) throw new Error('nothing to write');
    const { date, type: kind } = appendNote(text, { source, type: String(type).toLowerCase() });
    console.log(`written to the journal of ${date} as (${kind})`);
  } else if (cmd === 'save') {
    requireBrain();
    const text = args.join(' ').trim();
    if (!text) throw new Error('nothing to write');
    const { file } = saveNote(text, { source });
    console.log(file);
  } else if (cmd === 'show') {
    requireBrain();
    console.log(context());
  } else if (cmd === 'journal') {
    requireBrain();
    const { value } = takeFlag(args, 'days', '');
    const days = value === '' ? undefined : Number(value);
    console.log(JSON.stringify(parseJournal({ days }), null, 2));
  } else if (cmd === 'sync') {
    console.log(pull({ force: true }) ? 'brain up to date' : 'pull failed');
  } else {
    console.log(USAGE);
    process.exit(cmd ? 1 : 0);
  }
} catch (err) {
  console.error(err.message);
  process.exit(1);
}
