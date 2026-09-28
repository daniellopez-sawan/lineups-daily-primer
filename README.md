# Lineups Daily Primer — skill

Guided assistant that builds the Lineups Daily Primer email in Customer.io from articles tagged
on lineups.com. Everything the agent needs is in `SKILL.md`; the two scripts are the deterministic
core (no network, JSON in / JSON out):

- `scripts/map.mjs` — articles → snippet values (entity decoding, image size, tag filter, dedupe,
  subject/preheader composition, the `<!-- empty -->` sentinel for unused slots). Refuses loudly.
- `scripts/plan.mjs` — the shared week plan (`show / set / remove / confirm / today / mark_built /
  mark_sent`), with the one-pending-broadcast rule and an optimistic concurrency check.
- `fixtures/` — author cache, event-tag vocabulary, and sample inputs for the self-test.

## Run it (Claude Desktop → Code tab)
Install per `INSTALL-CLAUDE-CODE.md` — a `git clone` of this repo into
`~/.claude/skills/lineups-daily-primer/`. The skill pulls the latest version of itself every time
it starts, so updates need nothing from the team. In a new Code session type **Lineups Daily
Primer** and follow the numbered menu:
**Preview** (writes nothing) → **Send a test** → **Build & schedule the broadcast**.

The regular chat tab cannot read lineups.com's article API; the Code tab can.

## Who does what
Thom tags articles on the site. Kenny/Alvin plan, confirm and build. Vivien owns the template.
Daniel for anything that stops and you don't know why.

## Self-test
`node scripts/map.mjs < fixtures/sample-2026-09-15.json` → must print `"ok": true`.
