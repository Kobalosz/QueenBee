#!/usr/bin/env python3
"""Find emails from funders about grants the business applied to, and save their text for the agent
to read. Nothing else in the mailbox is opened.

    python scripts/fetch_mail.py                  # check the mailbox, save new funder emails
    python scripts/fetch_mail.py --check          # can it sign in? reads no messages
    python scripts/fetch_mail.py --store-password # the OWNER runs this in their own terminal, once
    python scripts/fetch_mail.py --from-dir DIR   # read .eml files instead of a mailbox (testing)

Which emails: only those sent since an application went out, and only when the sender is the
funder's own domain, or a grant platform (Submittable and the like) in an email that names the
funder, or any sender whose subject names the funder or the program. The mailbox is opened
read-only, so nothing is marked as read, moved or deleted.

The password is the mailbox's app password, kept in the system's password store through `keyring`
(Windows Credential Manager, macOS Keychain, or the Linux Secret Service). This script reads it
there and never prints, logs or saves it anywhere else.

Writes, all inside this agent's state/ folder (gitignored):
  state/watchlist.json    the applications being watched
  state/inbox/m-*.json    one file per matched email: sender, subject, date, plain text (trimmed)
  state/candidates.json   matched emails not yet classified
Extracted text older than settings.retention_days is deleted.
"""
import datetime
import email
import email.policy
import email.utils
import hashlib
import html
import imaplib
import json
import os
import re
import ssl
import sys
from pathlib import Path
from urllib.parse import urlparse

HERE = Path(__file__).resolve().parent.parent
STATE = HERE / "state"
INBOX = STATE / "inbox"
SEEN = STATE / "seen.json"
MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"]
MAX_TEXT = 8000


def utf8_stdout():
    for stream in (sys.stdout, sys.stderr):
        try:
            stream.reconfigure(encoding="utf-8", errors="replace")
        except (AttributeError, ValueError):
            pass


def load_json(p, default):
    try:
        return json.loads(Path(p).read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return default


def save_json(p, data):
    p = Path(p)
    p.parent.mkdir(parents=True, exist_ok=True)
    tmp = p.with_name(p.name + ".tmp")
    tmp.write_text(json.dumps(data, indent=1, ensure_ascii=False), encoding="utf-8")
    os.replace(tmp, p)


def settings():
    s = load_json(HERE / "config" / "settings.json", None)
    if s is None:
        sys.exit("config/settings.json is missing. Open this folder in Claude Code and say \"set us up\".")
    return s


def grants_folder(s):
    p = (HERE / s.get("grants_folder", "../grants")).resolve()
    if not (p / "CLAUDE.md").is_file() or not (p / "applications").is_dir():
        sys.exit(f"The grants folder was not found at {p}. Fix grants_folder in config/settings.json.")
    return p


# ── What to watch ────────────────────────────────────────────────────────────────
def domain_of(url_or_addr):
    s = str(url_or_addr or "").strip().lower()
    host = s.rsplit("@", 1)[-1] if "@" in s and "://" not in s else (urlparse(s if "://" in s else "https://" + s).hostname or "")
    host = host.strip(".")
    if host.startswith("www."):
        host = host[4:]
    return host


def watchlist(grants, platforms):
    """Submitted applications with no result recorded yet."""
    owner = load_json(grants / "config" / "owner-input.json", {})
    items = []
    for f in sorted((grants / "applications").glob("*.json")):
        r = load_json(f, None)
        if not isinstance(r, dict) or not r.get("slug"):
            continue
        mine = owner.get(r["slug"], {})
        sent = r.get("submitted_at") or mine.get("submitted_by_owner_at") or ""
        if not sent or (r.get("status") != "SUBMITTED" and not mine.get("submitted_by_owner_at")):
            continue
        if mine.get("outcome"):
            continue
        domains = {domain_of(r.get("url"))} | {domain_of(d) for d in r.get("funder_email_domains") or []}
        domains = sorted(d for d in domains if d and not any(d == p or d.endswith("." + p) for p in platforms))
        items.append({"slug": r["slug"], "funder": str(r.get("funder", "")), "program": str(r.get("program", "")),
                      "submitted_at": sent[:10], "domains": domains})
    return items


def names(item):
    """Phrases that identify the grant in a subject or body: the funder and the program, if specific."""
    out = [item["funder"]]
    if len(item["program"]) >= 12 or len(item["program"].split()) >= 3:
        out.append(item["program"])
    return [n for n in out if len(n) >= 4]


def match(item, msg, platforms):
    """Why this email belongs to this application, or None."""
    sender = domain_of(msg["from_addr"])
    if msg["date"][:10] < item["submitted_at"]:
        return None
    if any(sender == d or sender.endswith("." + d) for d in item["domains"]):
        return f"sent from {sender}"
    hay = (msg["subject"] + "\n" + msg["text"]).lower()
    named = [n for n in names(item) if n.lower() in hay]
    if named and any(sender == p or sender.endswith("." + p) for p in platforms):
        return f"sent through {sender} and names {named[0]}"
    in_subject = [n for n in names(item) if n.lower() in msg["subject"].lower()]
    if in_subject:
        return f"subject names {in_subject[0]}"
    return None


# ── Reading messages ─────────────────────────────────────────────────────────────
def html_to_text(s):
    s = re.sub(r"(?is)<(script|style|head)[^>]*>.*?</\1>", " ", s)
    s = re.sub(r"(?i)<br\s*/?>|</p>|</div>|</li>|</tr>|</h\d>", "\n", s)
    s = re.sub(r"<[^>]+>", " ", s)
    return html.unescape(s)


def parse(raw):
    m = email.message_from_bytes(raw, policy=email.policy.default)
    plain, rich = [], []
    for part in m.walk():
        if part.is_multipart() or part.get_content_disposition() == "attachment":
            continue
        ctype = part.get_content_type()
        if ctype not in ("text/plain", "text/html"):
            continue
        try:
            body = part.get_content()
        except (LookupError, ValueError):
            body = part.get_payload(decode=True).decode("utf-8", "replace") if part.get_payload(decode=True) else ""
        (plain if ctype == "text/plain" else rich).append(body)
    text = "\n".join(plain) if plain else html_to_text("\n".join(rich))
    text = re.sub(r"[ \t ]+", " ", text)
    text = re.sub(r"\n\s*\n\s*\n+", "\n\n", text).strip()
    try:
        when = email.utils.parsedate_to_datetime(m["Date"]).astimezone()
    except (TypeError, ValueError):
        when = datetime.datetime.now().astimezone()
    sender = email.utils.parseaddr(str(m["From"] or ""))
    mid = str(m["Message-ID"] or "").strip() or hashlib.sha1(raw[:4000]).hexdigest()
    return {
        "message_id": mid,
        "date": when.strftime("%Y-%m-%dT%H:%M"),
        "from": str(m["From"] or ""),
        "from_addr": sender[1],
        "subject": str(m["Subject"] or "").strip(),
        "text": text[:MAX_TEXT],
    }


def msg_id_hash(message_id):
    return "m-" + hashlib.sha1(message_id.encode("utf-8")).hexdigest()[:12]


def imap_date(d):
    return f"{d.day:02d}-{MONTHS[d.month - 1]}-{d.year}"


def imap_quote(s):
    s = re.sub(r"[^\x20-\x7e]", " ", s).strip()  # IMAP SEARCH strings stay ASCII here
    return '"' + s.replace("\\", "\\\\").replace('"', '\\"') + '"'


def password(s):
    try:
        import keyring
    except ImportError:
        sys.exit("The keyring package is missing. Run: python -m pip install -r requirements.txt")
    mail = s["mail"]
    pw = keyring.get_password(mail.get("keychain_service", "queenbee-grant-mail"), mail.get("address", ""))
    if not pw:
        sys.exit("No mailbox password stored yet. The owner runs, in their own terminal: "
                 "python scripts/fetch_mail.py --store-password")
    return pw


def connect(s):
    mail = s.get("mail", {})
    if not mail.get("address") or not mail.get("imap_host"):
        sys.exit("mail.address and mail.imap_host are not set in config/settings.json.")
    try:
        conn = imaplib.IMAP4_SSL(mail["imap_host"], int(mail.get("imap_port", 993)), ssl_context=ssl.create_default_context())
        conn.login(mail["address"], password(s))
    except imaplib.IMAP4.error as e:
        sys.exit(f"Could not sign in to {mail['imap_host']} as {mail['address']}: {e}. Check the app password "
                 "(store it again with --store-password) and that IMAP is turned on for the mailbox.")
    except OSError as e:
        sys.exit(f"Could not reach {mail['imap_host']}: {e}")
    return conn


def imap_messages(s, items, platforms, seen, limit):
    """Search each folder narrowly, then fetch only messages that match a watched application."""
    conn = connect(s)
    found = []
    try:
        for folder in s["mail"].get("folders", ["INBOX"]):
            typ, _ = conn.select(imap_quote(folder), readonly=True)
            if typ != "OK":
                print(f"(skipped folder {folder}: it does not exist)")
                continue
            uids = set()
            for it in items:
                since = imap_date(datetime.date.fromisoformat(it["submitted_at"]) - datetime.timedelta(days=1))
                queries = [f"FROM {imap_quote(d)}" for d in it["domains"]]
                queries += [f"TEXT {imap_quote(n)}" for n in names(it)]
                for q in queries:
                    typ, data = conn.uid("SEARCH", None, f"(SINCE {since} {q})")
                    if typ == "OK" and data and data[0]:
                        uids.update(data[0].split())
            for uid in sorted(uids, key=int, reverse=True):
                if len(found) >= limit:
                    break
                typ, data = conn.uid("FETCH", uid, "(BODY.PEEK[])")
                raw = next((part[1] for part in data or [] if isinstance(part, tuple)), None)
                if typ != "OK" or not raw:
                    continue
                msg = parse(raw)
                if msg["message_id"] in seen:
                    continue
                msg["folder"] = folder
                found.append(msg)
    finally:
        try:
            conn.logout()
        except Exception:
            pass
    return found


def dir_messages(folder, seen, limit):
    found = []
    for f in sorted(Path(folder).glob("*.eml")):
        msg = parse(f.read_bytes())
        if msg["message_id"] not in seen:
            msg["folder"] = f"file:{f.name}"
            found.append(msg)
    return found[:limit]


# ── Commands ─────────────────────────────────────────────────────────────────────
def store_password(s):
    if not sys.stdin.isatty():
        sys.exit("Run this yourself in a terminal window, not through the agent: the password must never pass through a chat.")
    try:
        import keyring
    except ImportError:
        sys.exit("The keyring package is missing. Run: python -m pip install -r requirements.txt")
    import getpass
    mail = s.get("mail", {})
    if not mail.get("address"):
        sys.exit("Set mail.address in config/settings.json first.")
    print(f"Mailbox: {mail['address']} on {mail.get('imap_host')}")
    print("Paste the app password and press Enter. Nothing shows while you type or paste; that is normal.")
    pw = getpass.getpass("App password: ").strip().replace(" ", "")
    if not pw:
        sys.exit("Nothing entered; nothing saved.")
    keyring.set_password(mail.get("keychain_service", "queenbee-grant-mail"), mail["address"], pw)
    print("Saved in this computer's password store. Check it with: python scripts/fetch_mail.py --check")


def check(s):
    conn = connect(s)
    folders = s["mail"].get("folders", ["INBOX"])
    missing = [f for f in folders if conn.select(imap_quote(f), readonly=True)[0] != "OK"]
    conn.logout()
    print(json.dumps({"status": "ok" if not missing else "missing_folders", "missing_folders": missing}))


def prune(retention_days):
    cutoff = datetime.datetime.now().timestamp() - retention_days * 86400
    for f in INBOX.glob("m-*.json"):
        if f.stat().st_mtime < cutoff:
            f.unlink()


def main():
    utf8_stdout()
    args = sys.argv[1:]
    s = settings()
    if "--store-password" in args:
        return store_password(s)
    if "--check" in args:
        return check(s)
    grants = grants_folder(s)
    platforms = [p.lower() for p in s.get("platform_senders", [])]
    items = watchlist(grants, platforms)
    INBOX.mkdir(parents=True, exist_ok=True)
    save_json(STATE / "watchlist.json", items)
    prune(int(s.get("retention_days", 60)))
    seen = set(load_json(SEEN, []))
    if not items:
        print("No submitted applications are waiting on a result. Nothing to look for.")
    else:
        limit = int(s.get("max_messages_per_run", 40))
        if "--from-dir" in args:
            msgs = dir_messages(args[args.index("--from-dir") + 1], seen, limit)
        else:
            msgs = imap_messages(s, items, platforms, seen, limit)
        saved = 0
        for msg in msgs:
            hits = [{"slug": it["slug"], "funder": it["funder"], "program": it["program"], "reason": why}
                    for it in items for why in [match(it, msg, platforms)] if why]
            if not hits:
                continue
            mid = msg_id_hash(msg["message_id"])
            msg.update({"id": mid, "matches": hits})
            msg.pop("from_addr", None)
            save_json(INBOX / f"{mid}.json", msg)
            saved += 1
        print(f"Watching {len(items)} application(s). Saved {saved} new funder email(s).")
    # Everything saved and not yet classified, including leftovers from an interrupted run.
    cands = []
    for f in sorted(INBOX.glob("m-*.json")):
        m = load_json(f, None)
        if m and m.get("message_id") not in seen:
            cands.append({"id": m["id"], "date": m["date"], "from": m["from"], "subject": m["subject"],
                          "slugs": [h["slug"] for h in m.get("matches", [])]})
    save_json(STATE / "candidates.json", cands)
    print(f"{len(cands)} email(s) to classify, listed in state/candidates.json.")
    for c in cands:
        print(f"  {c['id']}  {c['date']}  {c['subject'][:80]}  -> {', '.join(c['slugs'])}")


if __name__ == "__main__":
    main()
