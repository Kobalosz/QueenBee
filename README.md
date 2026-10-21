# QueenBee

A set of agents that handle a small business's recurring back-office work, each one in its own
folder, each one run by Claude Code on a schedule, each one keeping the client's data on the
client's machine.

| Agent | Status | What it does |
|---|---|---|
| [`grants/`](grants/) | First build | Finds small-business and nonprofit grants, writes the applications from the owner's real facts, submits simple web-form grants, and prepares federal and state packages for the owner to submit. The owner follows along in the Grants app. |
| [`grant-results/`](grant-results/) | First build | Reads funders' emails about submitted grants (read-only, only those emails) and shows the owner each decision or request in the Grants app to confirm. |

Everything runs on **Windows**, macOS and Linux: launchers and schedules are Python
([`shared/`](shared/): Task Scheduler on Windows, launchd on macOS, cron on Linux), secrets live in
the system's password store, and the Grants app builds a Windows installer.

## Conventions for every agent
- **The client's facts live in gitignored config** (`config/*.json`, `config/*.md` without
  `.example`), set up through one guided conversation. Templates are tracked as `*.example.*`.
- **Never invent a fact.** A missing fact becomes a question, not a guess.
- **Scheduled runs use a tool allowlist**, never skipped permissions.
- **Everything is written down before it is sent**, with a log, a per-item record and a
  screenshot.
- **Anything legally binding, paid, or signed stays with the owner.**
- **Each agent gets only the tools it needs.** The email reader has no web or browser tools at all.
