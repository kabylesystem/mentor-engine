# mentor-engine

Persistent memory for AI agents: a markdown brain, several writers, and a context assembler
that tells you what it left out.

## The problem

A model has no memory between two calls. Whatever memory an agent seems to have, someone
built it. Once you build it, two things bite you, and neither is the storage.

**The brain grows forever, the context window does not.** Every call has to leave something
out. Most systems handle this by truncating at some character count, which quietly removes
the middle of a day and produces an agent that is confidently missing a week. That is worse
than an agent that says it is missing a week.

**Several clients write to the same memory with no coordinator.** Mine has four: two coding
agents, a Telegram bot I talk to while walking, and a script that turns chat conversations
into dated notes. They do not know about each other. Two of them writing in the same second
is normal traffic, not an incident.

This repository is the smallest thing that handles both honestly.

## What it actually does

### Context assembly with a reported budget

`assemble({ tokens })` fills the window under a stated policy and hands back an account of
what it cost and what did not make it in.

```bash
$ brain budget --tokens 200
{
  "tokens": 228,
  "budget": 200,
  "sections": 2,
  "dropped": [
    "profile: 228 tokens, over the whole budget of 200",
    "journal: 2 day files did not fit",
    "long notes: 77 tokens did not fit",
    "latest review: did not fit"
  ]
}
```

The policy, in order:

1. **The profile is never dropped.** It is small, hand written, and it is what makes the
   rest legible. If it alone exceeds the budget, the section is kept anyway and the overrun
   is reported as an error, because silently returning nothing is not a better outcome.
2. **The journal is filled newest first, one day file at a time.** A day that does not fit
   whole is skipped whole. Half a day is worse than no day: an agent reading a truncated
   Tuesday will answer as if it knows Tuesday.
3. **Long notes, then the latest review**, added while budget remains.

The token count is a heuristic, four characters per token by default and configurable. It
is there to make the budget decision, not to bill you. Count properly with your provider's
tokenizer if the number has to be exact.

The point is the `dropped` array. An agent that can read it can say "I am missing the last
eleven days" instead of answering with a hole in it.

### Writes that survive four clients

Every write is an append to a line or a new file, so concurrent writes do not conflict in
content, only in git. A push therefore fails routinely rather than exceptionally: someone
else committed first.

`commit` handles that as the normal case. It commits, tries to push, and on failure pulls
with rebase and retries with a growing pause, four times by default. If the rebase itself
fails it aborts cleanly and leaves the work on disk rather than half applied. Every write
returns its `sync` result, so a caller can tell the difference between "written and pushed"
and "written locally, the push is behind".

```js
const { file, sync } = appendNote('the queue drains in 40 seconds', { source: 'telegram', type: 'fact' });
// sync: { committed: true, pushed: true, attempts: 2 }
```

### A journal that parses back

The daily file is written for a human to read and shaped so a machine can read it too.

```
- 14:30 [cli] (decision) dropped the second queue, one is enough
```

`parseJournal()` returns `{ date, time, source, type, text }` per line, so you can ask for
every commitment made in the last week without a database. Unknown tags are preserved in
the text rather than thrown away, because a memory that discards what it does not recognise
loses exactly the things you did not plan for.

## The brain layout

```
brain/
  self/       what is settled, changes slowly, edited by hand
  journal/    one file per day, one line per event, append only
  notes/      long notes kept whole, one file each
  reviews/    periodic summaries, the most recent one is read back
```

The split between `self/` and `journal/` is the load bearing decision. An agent that can
rewrite the profile will drift it toward whatever was said in the last five minutes, and
you will not notice for a month. The profile changes by hand. Everything the agent writes
is append only, dated, and attributed to the client that wrote it.

A fictional example lives in `example-brain/`.

## Install and try it

```bash
npm install
export BRAIN_DIR=./example-brain
export BRAIN_GIT=0          # work on disk, no commits, while you look around

node src/cli.mjs show --tokens 400
node src/cli.mjs budget --tokens 200
node src/cli.mjs journal --days 7
node src/cli.mjs note --type decision "dropped the second queue"
```

## From code

```js
import { appendNote, parseJournal, assemble } from 'mentor-engine';

const brain = { dir: '/srv/brain', timezone: 'Europe/Paris' };

appendNote('the queue drains in 40 seconds now', { source: 'telegram', type: 'fact', ...brain });

const commitments = parseJournal({ days: 7, ...brain }).filter((e) => e.type === 'commitment');

const { text, tokens, dropped } = assemble({ tokens: 12_000, ...brain });
if (dropped.length) console.warn('context is incomplete:', dropped);
```

## Note types

Five, on purpose. Enough to sort a week, few enough to pick one without thinking.

| Type | For |
|---|---|
| `fact` | something that happened |
| `decision` | a call that was made, and what it rules out |
| `commitment` | something the person said they would do |
| `want` | a desire that appeared or grew |
| `state` | how they are, when it explains the rest |

An unknown type is refused rather than stored. A memory where anything can be written stops
being searchable within a month.

## What it does not do

- **No retrieval and no embeddings.** Selection is by recency and section, not by relevance
  to the question. If your brain no longer fits a window even after budgeting, you want a
  retrieval layer and this is the wrong tool.
- **No merge resolution.** Rebase handles the ordinary case. A genuine content conflict is
  reported and left for a human.
- **No access control.** Anyone who can read the repository can read the memory. That is why
  mine is private and only the engine is public.

## Environment

| Variable | Default | Meaning |
|---|---|---|
| `BRAIN_DIR` | `./brain` | path to the brain repository |
| `BRAIN_TZ` | `UTC` | timezone used to date entries |
| `BRAIN_JOURNAL_DAYS` | `21` | how far back the journal is read |
| `BRAIN_TOKENS` | none | default budget for `show` and `budget` |
| `BRAIN_CHARS_PER_TOKEN` | `4` | the token estimate |
| `BRAIN_PUSH_ATTEMPTS` | `4` | pushes tried before giving up |
| `BRAIN_GIT` | on | set to `0` to work on disk without committing |
| `BRAIN_SOURCE` | `cli` | label written next to each entry |

## Tests

```bash
npm test
```

Twelve tests. The ones worth reading are the budget cases: a day file that does not fit is
skipped whole, a profile larger than the entire budget is kept and reported, and an
unknown note type is refused.

## License

MIT.
