#!/usr/bin/env python3
"""QueenBee grants: launch one bounded grant run in a fresh Claude Code session.

    python run.py              one run now, using config/settings.json
    python run.py 1            at most one submission this run
    python run.py --scheduled  what the scheduler runs: everything goes to logs/scheduled-run.log

Works the same on Windows, macOS and Linux. The session runs with the tool allowlist in
.claude/settings.json; anything else is denied, and the agent may never edit its own config,
scripts or permissions.
"""
import json
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE.parent / "shared"))
from launcher import python_command, run, utf8_stdout  # noqa: E402

DISALLOWED = [
    "Edit(config/**)", "Edit(scripts/**)", "Edit(.claude/**)", "Edit(run.py)", "Edit(CLAUDE.md)",
    "Edit(state/email-findings.json)", "Bash(curl:*)", "Bash(rm:*)", "Bash(git:*)",
]


def load(name):
    return json.loads((HERE / "config" / name).read_text(encoding="utf-8"))


def agent_has_submitted():
    """Whether the agent has ever sent an application itself (the owner's own submissions don't count)."""
    for f in (HERE / "applications").glob("*.json"):
        try:
            rec = json.loads(f.read_text(encoding="utf-8"))
        except (OSError, ValueError):
            continue
        if isinstance(rec, dict) and rec.get("status") == "SUBMITTED" and rec.get("submitted_at"):
            return True
    return False


def settings_prompt(s, p, max_override=None, first=False):
    """Turn config/settings.json into the sentences the agent has to obey this run. first: the agent
    has never submitted anything, so in auto mode the first application waits for the owner's OK."""
    run_, sub, t = s.get("run", {}), s.get("submission", {}), s.get("targets", {})
    ch, sf = s.get("channels", {}), s.get("safety", {})
    out = []
    mx = max_override if max_override is not None else run_.get("max_submissions_per_run", 2)
    out.append(f"Submit at most {mx} Tier A applications and draft at most {run_.get('max_drafts_per_run', 4)} "
               "packages or approval drafts this run, then exit.")
    if sub.get("mode", "auto") == "approve":
        out.append("SUBMISSION MODE IS APPROVE: submit ONLY applications the owner approved in the Grants app (approved_at set "
                   "in config/owner-input.json), filled from the approved applications/<slug>.md without changing a word. "
                   "For every other Tier A application, write the full doc, lint it, set its record to READY FOR APPROVAL, "
                   "and do not open its form.")
    else:
        out.append("SUBMISSION MODE IS AUTO: submit Tier A web-form applications that clear every gate in config/spec.md. "
                   "Tier B (federal, state, document packages) is NEVER submitted: draft the package and mark PACKAGE READY.")
        if first and sub.get("hold_first_for_approval", True):
            out.append("FIRST APPLICATION: you have never submitted one for this owner, so the owner sees the quality first. "
                       "Until an application has been approved in the Grants app and sent, treat Tier A exactly as approve "
                       "mode: write the doc, lint it, set the record to READY FOR APPROVAL, and do not submit.")
    out.append(f"Note any form closing in under {run_.get('min_days_before_deadline_to_submit', 2)} day(s); never start a "
               f"package closing in under {run_.get('min_days_before_deadline_to_draft', 14)} days (log TOO TIGHT instead).")
    if run_.get("one_application_per_funder_per_run", True):
        out.append("One application per funder per run.")
    out.append(f"At most {run_.get('max_applications_per_program_per_cycle', 1)} application per program per cycle: run "
               "./scripts/dupe_check.sh \"<Funder>\" \"<Program>\" before writing anything; exit 3 is a hard skip.")
    entities = [e for e in t.get("apply_as", ["business"]) if p.get(e, {}).get("enabled", e == "business")]
    out.append("Apply only as these entities from config/profile.json: " + (", ".join(entities) or "NONE (stop and log it)")
               + ". Never present one entity with the other's facts.")
    if "nonprofit" in entities:
        out.append(f"Nonprofit IRS status: {p.get('nonprofit', {}).get('irs_status') or 'UNKNOWN'}. A program requiring "
                   "501(c)(3) status is a skip unless that status, or a fiscal sponsor the program accepts, is on file.")
    if t.get("min_award_usd"):
        out.append(f"Skip programs whose maximum award is under ${t['min_award_usd']:,}.")
    scope = [k for k, v in (("national", t.get("include_national", True)), ("state", t.get("include_state", True)),
                            ("local", t.get("include_local", True))) if v]
    out.append("Geographic scope: " + ", ".join(scope) + " programs. The client's location is "
               + (p.get("business", {}).get("business_address_full") or "NOT SET in profile.json; skip location-restricted programs")
               + ".")
    if not t.get("allow_public_vote_contests", False):
        out.append("Public-vote contests go to FOR YOU, not submitted.")
    if not t.get("allow_equity_or_loans", False):
        out.append("Loans, equity and investment pitch competitions are out of scope; skip them.")
    if t.get("fit_note"):
        out.append("Fit bar, in the client's own words: " + t["fit_note"])
    if t.get("priority_funders"):
        out.append("Prioritize: " + ", ".join(t["priority_funders"]) + ".")
    if t.get("skip_funders"):
        out.append("NEVER apply to: " + ", ".join(t["skip_funders"]) + ".")
    fee = sub.get("max_application_fee_usd", 0)
    out.append(f"Application fees above ${fee} go to FOR YOU with the amount." if fee else
               "Any application fee sends the program to FOR YOU with the amount.")
    out.append("Certification checkboxes ('the information is accurate') may be ticked." if sub.get("allow_checkbox_certification", True)
               else "Any certification checkbox makes the application NEEDS HUMAN.")
    if not sub.get("allow_typed_signature", False):
        out.append("A typed or drawn signature field makes the application NEEDS HUMAN: fill everything else, leave that tab open, log it.")
    if ch.get("signed_in_portals"):
        out.append("Portals where the client is signed in and you may apply: " + ", ".join(ch["signed_in_portals"])
                   + ". Confirm the signed-in header before touching a form.")
    if ch.get("never_submit_on"):
        out.append("Never submit on, sign in to, or fill forms on: " + ", ".join(ch["never_submit_on"]) + ".")
    if ch.get("source_only"):
        out.append("Aggregators are sources only, never apply through them: " + ", ".join(ch["source_only"]) + ".")
    if sf.get("never_create_accounts", True):
        out.append("Never create accounts or enter passwords.")
    if sf.get("never_solve_interactive_captcha", True):
        out.append("Never solve interactive CAPTCHA; log NEEDS HUMAN.")
    if sf.get("never_fabricate_a_fact", True):
        out.append("Never fabricate a fact, a number or a dollar amount. Every narrative passes scripts/grant_docs.py lint and "
                   "every budget passes scripts/grant_docs.py budget before it is used.")
    if sf.get("never_enter_ssn_or_bank_details", True):
        out.append("Never type an SSN, a date of birth, a bank account or a card number, and never pay anything; such a field is NEEDS HUMAN.")
    if sf.get("screenshot_every_submit", True):
        out.append("Save a confirmation screenshot as JPG under screenshots/ after each submit.")
    if sf.get("require_log_before_submit", True):
        out.append("Before clicking submit, append the full entry to logs/grants-log.md and write applications/<slug>.md with "
                   "every question, every answer, the amount requested, the URL and today's date.")
    return " ".join(out)


def build_prompt(settings, profile, max_override=None):
    py = python_command()
    return f"""Continue the grant run in {HERE}. This is a fresh session: derive all durable state from repository files, not from chat history.

PYTHON: on this computer run every script as `{py} scripts/<name>.py`.

Read and follow, in order: CLAUDE.md, config/settings.json, config/profile.json, config/answers.md, config/spec.md, config/documents.md, data/queue.md, data/funder-notes.md, state/status.md, logs/grants-log.md, and config/owner-input.json. Act on the owner's answers, uploads, approvals and results in config/owner-input.json first; you never edit that file.

RUN CONFIG (from config/settings.json, obey exactly): {settings_prompt(settings, profile, max_override, not agent_has_submitted())}

SOURCING: run {py} scripts/grants_gov_sweep.py and {py} scripts/funder_sweep.py, each ONCE, in the FOREGROUND with the Bash tool (timeout 400000). Never background them: a headless session ends when your turn ends. Then run the capped web-search lane in data/sources.md, taking the searches the last status block did not. Every lead is verified on the funder's own page before anything is written.

METHOD: work data/queue.md top-down by deadline, then the new leads. Gate each one (config/spec.md), classify its tier, write answers per config/documents.md. For Tier A forms use the connected real Chrome through the Claude-in-Chrome extension with trusted computer-tool input and file_upload for attachments. At the start, call tabs_context_mcp and close only leftover grant-form tabs inside your own tab group; never touch any tab outside it. Work in one reused tab. Before exiting, close EVERY tab in your group and confirm tabs_context_mcp says no tab group exists.

SCOPE: a hard eligibility mismatch is a one-line SKIP, not NEEDS HUMAN. Never submit a weak fit just to reach the cap; zero strong applications beats one poor one. A tool call that is denied is denied on purpose: log what you needed in state/status.md and move on.

THE OWNER'S GRANTS APP reads applications/<slug>.json (schema in config/spec.md). Write or update the record every time an application's status changes, put every single thing the owner must do in its needs list in plain words, and run {py} scripts/grant_docs.py record on it until it prints OK.

END OF RUN: write state/last_run.json, update the per-application docs and records, data/queue.md, logs/grants-log.md (summary at the top, with the next deadlines in date order), data/funders.md for any new recurring program, and add a new status block at the top of state/status.md. If Chrome is disconnected, Tier A work waits: still do sourcing, gating and Tier B drafting, and log it."""


def main():
    utf8_stdout()
    args = [a for a in sys.argv[1:] if a != "--scheduled"]
    scheduled = "--scheduled" in sys.argv[1:]
    max_override = None
    if args:
        if not args[0].isdigit():
            sys.exit("Usage: python run.py [max_submissions] [--scheduled]")
        max_override = int(args[0])
    for f in ("settings.json", "profile.json", "answers.md"):
        if not (HERE / "config" / f).is_file():
            sys.exit(f"ERROR: config/{f} is missing. Finish setup in the Grants app, or open this folder in Claude Code "
                     "and say \"set us up\".")
    for d in ("applications/files", "logs", "screenshots", "state"):
        (HERE / d).mkdir(parents=True, exist_ok=True)
    prompt = build_prompt(load("settings.json"), load("profile.json"), max_override)
    sys.exit(run(HERE, prompt, DISALLOWED, scheduled=scheduled, chrome=True))


if __name__ == "__main__":
    main()
