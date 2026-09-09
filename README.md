# mentor-engine

A persistent memory for AI agents, stored as plain markdown in a git repository.

A model has no memory between two calls. Any memory an agent appears to have is something
you built around it. This is the smallest version of that thing I could get away with: a
directory of markdown files, a few functions to write to it, and one function that returns
everything an agent should read before it answers.

I run it as the memory behind my own assistant. Four clients write to the same brain: two
coding agents, a Telegram bot I talk to while walking, and a script that turns chat
conversations into dated notes. They never talk to each other. They talk to the repository.

## Why markdown and git rather than a database

- I can read it. When the agent says something odd, I open the file and see why.
- Every write is a commit, so the memory has a history and I can see what changed and when.
- Any client that can run `git pull` can read the memory. No server, no schema migration.
- If this project disappears, the memory is still a folder of readable files.

The cost is real and worth naming: no queries, no indexes, and concurrent writers rely on
git rather than transactions. For a memory that one person feeds a few dozen times a day,
that trade is fine. For a multi tenant product it is not.

## The brain layout

```
brain/
  self/       what is settled and changes slowly, edited by hand
  journal/    one file per day, one line per event, append only
  notes/      long notes kept whole, one file each
  reviews/    periodic summaries, the most recent one is read back
```

`self/` is the part the agent must not rewrite mid conversation. `journal/` is the raw
flow. The separation matters: an agent that can edit the profile will quietly drift it
toward whatever was said in the last five minutes.

A working example lives in `example-brain/`. It is fictional.

## Install

```bash
npm install
export BRAIN_DIR=./example-brain
export BRAIN_TZ=Europe/Paris
export BRAIN_GIT=0     # skip git while you are trying it out
```

## Use it from the command line

```bash
node src/cli.mjs note --type decision "dropped the second queue, one is enough"
node src/cli.mjs save "# Reading list
The Rust book, chapters 13 to 16"
node src/cli.mjs journal --days 7
node src/cli.mjs show
```

`show` prints the whole context: profile, recent journal, long notes, latest review. That
string is what you paste into a system prompt, or hand to an agent as a file.

## Use it from code

```js
import { appendNote, parseJournal, context } from 'mentor-engine';

const options = { dir: '/srv/brain', timezone: 'Europe/Paris' };

appendNote('the queue drains in 40 seconds now', { source: 'telegram', type: 'fact', ...options });

const entries = parseJournal({ days: 7, ...options });
const commitments = entries.filter((e) => e.type === 'commitment');

const system = `You know this about the person.\n\n${context(options)}`;
```

## Note types

Five, on purpose. Enough to sort a week, few enough to pick one without thinking.

| Type | For |
|---|---|
| `fact` | something that happened |
| `decision` | a call that was made, with what it rules out |
| `commitment` | something the person said they would do |
| `want` | a desire that appeared or grew |
| `state` | how they are, when it explains the rest |

An unknown type is refused rather than stored, because a memory where anything can be
written stops being searchable within a month.

## What it does not do

- No retrieval, no embeddings, no ranking. The context is assembled by recency and by
  section, then truncated by character budget. If your brain outgrows a context window,
  this is the wrong tool.
- No conflict resolution. Two clients writing the same second will produce a git conflict
  and you will fix it by hand.
- No access control. Anyone who can read the repository can read the memory, which is why
  mine is private and only this engine is public.

## Environment

| Variable | Default | Meaning |
|---|---|---|
| `BRAIN_DIR` | `./brain` | path to the brain repository |
| `BRAIN_TZ` | `UTC` | timezone used to date entries |
| `BRAIN_JOURNAL_DAYS` | `21` | how far back `context` reads |
| `BRAIN_GIT` | on | set to `0` to work on disk without committing |
| `BRAIN_SOURCE` | `cli` | label written next to each entry |

## Tests

```bash
npm test
```

Eight tests covering the write path, the parse path, the context assembly, and the two
failures that matter: an empty note and an unknown type.

## License

MIT.
