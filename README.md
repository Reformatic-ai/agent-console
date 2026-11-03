# Agent Console

One place for every trading agent — status, dashboards, and reasoning — instead of
four bookmarks.

It is a **read-only consumer**. It does not touch any bot repo, any publish script,
or any existing dashboard URL. Every dashboard stays exactly where it is and keeps
publishing exactly as it does now; the console just reads what is already public.

## What it does

- **Fleet** — one card per agent: headline P&L, win rate, how long ago it published,
  and its most recent decision. Click through to any agent.
- **Agent** — the full stat set, the real dashboard embedded inline, that agent's
  reasoning, and its open positions.
- **Thinking** — every agent's reasoning merged into one reverse-chronological feed,
  colour-coded and searchable. This view exists nowhere else.
- **Add agent** — paste a dashboard URL; the console probes it and wires up the rest.

## Gross and net P&L (2026-11-03)

Each fleet card shows **Gross**, **Costs** and **Net** P&L side by side, read from a
`net_pnl` region each bot publishes in its `dashboard_data.json`. Unlike the other
regions this one is a contract:

```html
<div class="net-pnl" data-gross="938.55" data-costs="101.00" data-net="837.55"
     data-currency="USD" data-since="2026-07-16T19:45:06Z">…</div>
```

Gross is P&L before the simulated trading costs set on the console's `/trading` page,
net after them; numbers are plain (2 decimals, no commas). A bot that doesn't publish
the region yet gets a one-line note instead of numbers.

The dashboards moved with their repositories to the Reformatic-ai organization on
2026-10-22, and GitHub Pages doesn't redirect the old owner's address, so `agents.json`
now points at `reformatic-ai.github.io`. Display names follow Peter's: Swing (Repete),
Crypto (Repete1), Currency (Repete2); Repete 3 keeps its name until it has a new one.

## How it works

Every bot already publishes `dashboard_data.json` next to its dashboard:

```json
{ "generated_at": "...", "hash": "...", "regions": { "cards": "<html>", "decisions": "<html>", ... } }
```

GitHub Pages serves those with `access-control-allow-origin: *`, so the console
fetches all of them directly from the browser. No server, no build step, no
dependencies — just open `index.html`.

`regions` are pre-rendered HTML fragments, and their markup is **not a contract**:
it differs per bot and can change whenever a publish step changes. So every parser
in `assets/parse.js` detects what it can and degrades to "couldn't read this feed —
open the dashboard" rather than showing a blank card or a wrong number.

Anything fetched is sanitized before it reaches the DOM: scripts and event handlers
are stripped, and relative links are rewritten absolute against that agent's own
dashboard (without which Repete 3's `report.html#rec-…` case-file links would 404).
Embedded dashboards run in a `sandbox` without `allow-top-navigation`, so a framed
page can never replace the console.

### Known quirks, handled

| | |
|---|---|
| Repete 1's dashboard is at `/repete1/` | `/repete1-dashboard/` returns 404 |
| Repete 2's decisions table has no `id` and no reasoning column | Columns are located by header text, not by id |
| Three different timestamp formats | Normalised to UTC before merging |
| Pages caches for 10 minutes | Requests are cache-busted; the UI shows data age rather than implying live |

## Adding an agent permanently

Agents added through the UI live in `localStorage`, which is per-browser — they will
not appear on your phone. To make one permanent:

1. Add it in the UI and check it works.
2. Click **Export registry** in the sidebar.
3. Commit the downloaded `agents.json` over the one in this repo.

## Running it locally

```bash
python3 -m http.server 8899 --directory ~/bots/agent-console
```

Then open <http://localhost:8899>. It also works opened straight from Finder.

## Files

| File | Purpose |
|---|---|
| `index.html` | App shell |
| `agents.json` | Seed registry — the four agents |
| `assets/app.js` | Registry, fetching, rendering, routing |
| `assets/parse.js` | Tolerant region parsers + sanitizer |
| `assets/style.css` | Design tokens and layout |
