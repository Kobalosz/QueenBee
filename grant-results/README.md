# QueenBee · Grant Results

**An agent that reads funders' emails about grants the business has applied to, and tells the
owner what they say:** won (and how much), not selected, a reply is needed, or just a status update.
Results show up in the Grants app for the owner to confirm with one click.

It works alongside the [grants agent](../grants/), which finds and applies for grants. It runs on
Windows, macOS and Linux.

## What it reads, and what it does not

- **Only emails about submitted applications.** For each application the grants agent sent and
  the owner has not recorded a result for, it searches for emails sent after the application
  went out that come from the funder's own domain, come through a grant platform (Submittable,
  SurveyMonkey Apply, Fluxx and similar) and name the funder, or name the funder or program in the
  subject. Nothing else in the mailbox is opened.
- **Read-only.** The inbox is opened read-only, so nothing is marked as read, moved or deleted. It
  never replies, forwards, or follows a link.
- **Stays on the computer.** A trimmed copy of each matching email is kept in `state/inbox/` for
  60 days (`retention_days`), gitignored.
- **The password never passes through Claude.** The mailbox's app password lives in the
  system's password store (Windows Credential Manager, macOS Keychain, Linux Secret Service). The
  owner types it once into a hidden prompt in their own terminal; only `scripts/fetch_mail.py`
  reads it.

## How a pass works

1. `scripts/fetch_mail.py` signs in over IMAP, searches narrowly, and saves matching emails as
   plain text.
2. Claude reads each one and classifies it (`CLAUDE.md` has the rules: finalist is not a win, an
   unclear email is an update, the quote must be exact). The session has **no web, browser or
   network tools**, so an email written to trick an AI cannot make it send anything anywhere.
3. `scripts/publish_findings.py` checks each finding against the email: the quote must appear
   word for word, and a dollar amount must actually be in the email. Only then does the finding
   go to `../grants/state/email-findings.json`.
4. The Grants app shows it: "Acme Foundation says you won $7,500," with the quote, and **Record as
   won** or **That's not right**. Requests for a reply show with their date and an **I've replied**
   button. The result counts only when the owner confirms it.

## Setup

Open this folder in Claude Code and say *"set us up"*. It explains what will be read, asks for the
owner's agreement, and walks through the app password.

```bash
python -m pip install -r requirements.txt
python scripts/fetch_mail.py --store-password   # the owner, in their own terminal, once
python scripts/fetch_mail.py --check            # can it sign in?
python run.py                                   # one pass now
python scripts/schedule.py install              # daily, by default at 8:00
python tests/selftest.py                        # check the scripts with made-up emails
```

Use `python3` on a Mac or Linux.

**Mail providers:** Gmail, iCloud, Yahoo, and most business email hosts that offer IMAP with app
passwords. **Microsoft (Outlook.com, Hotmail, Microsoft 365) is not supported yet:** Microsoft no
longer accepts app passwords over IMAP, so reading it needs a Microsoft sign-in integration.

## Files

```
grant-results/
├── CLAUDE.md                  # the agent's playbook: setup, each pass, how to classify
├── run.py                     # one headless pass (no web or browser tools)
├── requirements.txt           # keyring, for the password store
├── config/settings.json       # mailbox, grants folder, platforms, retention (gitignored)
├── scripts/
│   ├── fetch_mail.py          # read-only IMAP search and text extraction
│   ├── publish_findings.py    # checks findings against the email, hands them to the Grants app
│   └── schedule.py            # Task Scheduler, launchd or cron
├── tests/selftest.py          # end-to-end check with made-up emails, no mailbox needed
└── state/                     # inbox copies, findings, status (gitignored)
```
