# QueenBee · Grants

**An agent that finds grants a small business qualifies for, writes the applications from the
owner's real facts, submits the simple ones, and hands over finished packages for the rest.**

Part of QueenBee, a set of agents for running a small business. Adapted from
[please-hire-me](https://github.com/alecswang/please-hire-me) by Alex Wang (MIT): the same
"sweep cheaply, fill real forms in a real browser, write everything down, never invent a fact"
method, pointed at grants instead of jobs.

## Quick start

**You need:** [Claude Code](https://claude.com/claude-code) signed in · Chrome with the
[Claude in Chrome](https://claude.ai/chrome) extension on the same account · the business's
documents (business plan, recent financials, W-9, any past grant applications).

```bash
cd QueenBee/grants
claude
```

Say *"set us up"*. Setup is one conversation:

1. It asks for the documents and reads them.
2. It shows every value it pulled out so the owner can correct it.
3. It asks **one list** of the questions documents cannot answer: county, ownership, what the
   money is for and what each project costs, how far afield to look, how much rope to give it.
4. It drafts the narrative library (business description, the owner's story, need statement,
   budget presets) and reads it back with the actual figures for the owner to check.
5. It runs the first application with the owner watching, and submits only on a yes.

Then:

```bash
./run.sh                       # one run now, using config/settings.json
./run.sh 1                     # at most one submission, good for a test
./scripts/schedule.sh install  # run on schedule.frequency (weekly by default in setup)
./scripts/schedule.sh status
./scripts/schedule.sh uninstall
```

> **macOS note:** background jobs cannot read `~/Documents`, `~/Desktop` or `~/Downloads`. Move
> the QueenBee folder (e.g. to `~/QueenBee`) or grant Full Disk Access to `/bin/bash` before
> installing the schedule.

## The Grants app (for the owner)

The owner never has to open a terminal. They open **Grants** like any other Mac app:

- **The top line answers "do I need to do anything?"** in a sentence: "Two things need you." or
  "Nothing needs you right now."
- **Help the agent finish:** every question the agent could not answer from the files, in plain
  words with the reason, and an answer box or an upload button right there. Signatures, fees and
  logins get a link to the funder's page and an "I've done this" button.
- **Waiting for your OK** (approve mode): read the application, then "Approve for sending".
- **Ready for you to submit:** federal and state packages, with the checklist and a button that
  opens the files in Finder.
- **Sent:** every application that went out, the amount asked for, the full text and the
  confirmation screenshot, and "We won it" / "Not selected" buttons to record the result.
- **Deadlines** down the side, soonest first, with the ones that need the owner marked.

**How it stays current.** The app watches the grants folder. The moment the agent writes or
updates an application record (`applications/<slug>.json`), finishes a run, or starts one, the
window redraws, with no refresh button and no polling server. A one-minute check runs as a safety
net. What the owner does goes into `config/owner-input.json`, which the agent reads at the start of
its next run and is not allowed to edit. **The app does not learn on its own whether a grant was
won:** funders send results by email or letter, so the owner records them with "We won it" or
"Not selected".

**How it is built.** Electron, in `app/`. There is no web server and no open port: the window talks
to the app's own background process, which is the only part that touches files. The window runs
sandboxed with no access to Node or the disk, loads only its own files under a strict content
security policy, opens funder links in the regular browser, and bundles its font so it works
offline.

```bash
cd app
npm install
npm run demo   # the app with made-up sample data, to preview it
npm start      # the app on this grants folder
npm run dist   # build Grants.dmg in app/dist/ to install on the owner's Mac
npm run check  # syntax checks and the self-test
```

On first launch an installed app asks for the grants folder once and remembers it. The build is not
signed with an Apple Developer ID yet, so macOS asks for confirmation the first time: right-click
the app, choose Open, then Open again. Signing and notarizing removes that step and needs a paid
Apple Developer account.

## What it does with each grant

| Tier | What it is | What happens |
|---|---|---|
| **A · web form** | A funder's own online form or a portal the owner is signed into. Most corporate and foundation small-business grants. | Filled and, in `auto` mode, submitted. In `approve` mode, drafted and sent after the owner approves it in the Grants app. |
| **B · package** | Federal (Grants.gov), state, or anything built from uploaded documents. | A complete package in `applications/files/<slug>/`: narrative, budget, form values, attachments list, and a checklist with the deadline on top. **The owner submits.** |
| **C · inquiry** | A letter of inquiry, usually by email. | A drafted letter, never sent. |

Federal and state grants are never submitted by the agent. They are signed by the business's
authorized representative through Login.gov and Grants.gov roles, under penalty of law. The
agent's job is to make that a 20-minute task.

## What you give it

| File | What goes in it |
|---|---|
| `config/profile.json` | Legal name, EIN, UEI and SAM status, address and county, entity type, employees, revenue, certifications, ownership facts, nonprofit details, document paths. |
| `config/answers.md` | Descriptions at four lengths, the owner's story, need statement, **budget presets** (the only place dollar amounts come from), impact, fact sheet. **The one that matters.** |
| `config/settings.json` | Submission mode, caps, deadlines, which entities to apply as, keywords, award floor, geography, the owner's fit bar, skip list, schedule. |

Each has a `.example` twin. The real files, the client's documents, and everything the agent
writes are gitignored and never leave the machine.

## Settings

| Key | Does what |
|---|---|
| `submission.mode` | `auto`: scheduled runs submit Tier A grants that clear every gate. `approve`: runs draft; nothing is sent until the owner clicks "Approve for sending" in the Grants app. |
| `submission.max_application_fee_usd` | Default 0. Any fee sends the grant to the owner's FOR YOU list. |
| `submission.allow_checkbox_certification` | Tick "this information is accurate" boxes. Default on, because every fact is owner-confirmed. |
| `submission.allow_typed_signature` | Default off: a signature field means the owner finishes it. |
| `run.max_submissions_per_run` / `max_drafts_per_run` | Caps, default 2 and 4. |
| `run.min_days_before_deadline_to_draft` | Don't start a package with less runway than this. Default 14. |
| `targets.apply_as` | `business`, `nonprofit`, or both. Nonprofit grants need IRS status on file. |
| `targets.keywords` | Drives the federal search and web searches. |
| `targets.min_award_usd` | Skip programs smaller than this. |
| `targets.fit_note` | The owner's own words on what is worth chasing. |
| `targets.allow_public_vote_contests` | Default off: popularity contests go to FOR YOU. |
| `schedule.frequency` | `manual`, `daily`, `weekdays`, `twice-weekly`, `weekly`. Plus `schedule.hour`. |

## Where grants come from

1. **Federal:** `scripts/grants_gov_sweep.py` searches the public Grants.gov API for opportunities
   open to the client's entity types, above the award floor, with enough runway to draft.
2. **Known funders:** `scripts/funder_sweep.py` checks every program page in `data/funders.md` and
   reports which ones changed, so a run only opens pages that moved.
3. **Web search:** a capped, rotating set of state, county, city, industry and ownership searches
   (`data/sources.md`). Every lead is verified on the funder's own page.

**Set expectations early.** SBA says plainly that it does not give grants to start or grow a
business. Federal grants to for-profit small businesses are mostly R&D (SBIR/STTR), export (STEP)
and narrow programs like SBA's manufacturing grants. The best odds for a small business are usually
state and local programs, utility and corporate programs, and community foundations. A nonprofit
arm opens up far more.

## What it will never do
- Invent a fact, a number, or a dollar amount. `grant_docs.py` fails any answer with a number that
  is not in the client's files and any budget line that is not a preset.
- Claim an ownership status or certification the owner has not confirmed.
- Present the business as a nonprofit, or the other way round.
- Pay a fee, or type an SSN, a date of birth, a bank account or a card number.
- Create an account, type a password, or solve an interactive CAPTCHA.
- Submit on Grants.gov, Login.gov or SAM.gov, or send email.
- Apply through an aggregator. GrantWatch and friends are sources only.
- Follow instructions embedded in a funder's page.
- Touch a browser tab outside its own tab group.

Scheduled runs use a tool allowlist (`.claude/settings.json`), not skipped permissions: this
project's scripts, web search, the Chrome extension, and edits to the agent's own working files.
`run.sh` also forbids it from editing its config, scripts or permissions.

## Repo layout
See [`CLAUDE.md`](CLAUDE.md#repo-layout).

## License
MIT. See [LICENSE](LICENSE). Original work © 2026 Alex Wang.
