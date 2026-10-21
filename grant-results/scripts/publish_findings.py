#!/usr/bin/env python3
"""Check the agent's reading of each funder email, then hand the findings to the Grants app.

    python scripts/publish_findings.py

Reads state/findings.json, which the agent writes:
  {"findings": [{"message": "m-1a2b3c4d5e6f", "slug": "acme-growth-2026", "kind": "AWARDED",
                 "amount_usd": 7500, "reply_by": "", "summary": "...", "quote": "..."}]}

Every finding must hold up against the email itself:
  - the email exists in state/inbox/ and was matched to that application;
  - `quote` appears word for word in the email (spacing aside);
  - an `amount_usd` appears in the email as a dollar figure;
  - `kind` is AWARDED, DECLINED, NEEDS_REPLY, UPDATE or NOT_RELATED.
Findings that pass are merged into <grants>/state/email-findings.json, which the Grants app shows
the owner, and their emails are marked done. Findings that fail are listed and left in place for the
agent to fix; the script then exits 1. A result reaches the owner as a suggestion only: the owner
confirms it in the app before it counts.
"""
import datetime
import hashlib
import json
import os
import re
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent.parent
STATE = HERE / "state"
KINDS = {"AWARDED", "DECLINED", "NEEDS_REPLY", "UPDATE", "NOT_RELATED"}
MONEY = re.compile(r"\$\s?(\d{1,3}(?:,\d{3})+|\d+)(?:\.(\d{2}))?(?:\s?(k|K|thousand|million|M)\b)?")


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


def squash(s):
    s = str(s).replace("’", "'").replace("‘", "'").replace("“", '"').replace("”", '"')
    return re.sub(r"\s+", " ", s).strip().lower()


def amounts(text):
    out = set()
    for m in MONEY.finditer(text):
        v = float(m.group(1).replace(",", "") + ("." + m.group(2) if m.group(2) else ""))
        suf = (m.group(3) or "").lower()
        v *= 1000 if suf in ("k", "thousand") else 1_000_000 if suf in ("m", "million") else 1
        out.add(round(v, 2))
    return out


def check(f, msg):
    """Reasons this finding does not hold up, or an empty list."""
    errs = []
    if msg is None:
        return [f"message {f.get('message')!r} is not in state/inbox/"]
    kind = f.get("kind")
    if kind not in KINDS:
        errs.append(f"kind must be one of {', '.join(sorted(KINDS))}")
    slugs = [h["slug"] for h in msg.get("matches", [])]
    if kind != "NOT_RELATED" and f.get("slug") not in slugs:
        errs.append(f"slug must be one this email was matched to: {', '.join(slugs)}")
    if kind == "NOT_RELATED":
        return errs
    quote = str(f.get("quote", "")).strip()
    if not quote:
        errs.append("quote is empty: copy the sentence that says it, exactly")
    elif len(quote) > 300:
        errs.append("quote is longer than 300 characters: keep the one sentence that says it")
    elif squash(quote) not in squash(msg["subject"] + "\n" + msg["text"]):
        errs.append("quote does not appear word for word in the email")
    summary = str(f.get("summary", "")).strip()
    if not summary or len(summary) > 200:
        errs.append("summary must be one plain sentence for the owner, under 200 characters")
    if re.search(r"https?://|www\.", summary):
        errs.append("summary must not contain links")
    amt = f.get("amount_usd")
    if amt not in (None, ""):
        if kind != "AWARDED":
            errs.append("amount_usd is only for AWARDED")
        elif not isinstance(amt, (int, float)) or amt <= 0:
            errs.append("amount_usd must be a positive number")
        elif round(float(amt), 2) not in amounts(msg["subject"] + "\n" + msg["text"]):
            errs.append(f"${amt:,} does not appear in the email; leave amount_usd null if the email gives no amount")
    rb = str(f.get("reply_by", "") or "")
    if rb and not re.match(r"^\d{4}-\d{2}-\d{2}$", rb):
        errs.append("reply_by must be YYYY-MM-DD or empty")
    if rb and kind != "NEEDS_REPLY":
        errs.append("reply_by is only for NEEDS_REPLY")
    return errs


def main():
    utf8_stdout()
    s = load_json(HERE / "config" / "settings.json", None)
    if s is None:
        sys.exit("config/settings.json is missing.")
    grants = (HERE / s.get("grants_folder", "../grants")).resolve()
    if not (grants / "CLAUDE.md").is_file():
        sys.exit(f"The grants folder was not found at {grants}.")
    out_path = grants / "state" / "email-findings.json"
    published = load_json(out_path, {"findings": []})
    have = {f["id"] for f in published.get("findings", [])}
    seen = set(load_json(STATE / "seen.json", []))
    todo = load_json(STATE / "findings.json", {"findings": []}).get("findings", [])
    now = datetime.datetime.now().strftime("%Y-%m-%dT%H:%M")

    keep, done_msgs, added, rejected = [], set(), 0, 0
    for f in todo:
        msg = load_json(STATE / "inbox" / f"{f.get('message')}.json", None)
        errs = check(f, msg)
        if errs:
            rejected += 1
            keep.append(f)
            print(f"REJECTED {f.get('message')} / {f.get('slug')} / {f.get('kind')}:")
            for e in errs:
                print(f"  - {e}")
            continue
        done_msgs.add(msg["message_id"])
        if f["kind"] == "NOT_RELATED":
            continue
        fid = "f-" + hashlib.sha1(f"{msg['message_id']}|{f['slug']}|{f['kind']}".encode("utf-8")).hexdigest()[:12]
        if fid in have:
            continue
        published.setdefault("findings", []).append({
            "id": fid, "slug": f["slug"], "kind": f["kind"],
            "amount_usd": f.get("amount_usd") if f["kind"] == "AWARDED" else None,
            "reply_by": f.get("reply_by") or "", "summary": f["summary"].strip(), "quote": f["quote"].strip(),
            "from": msg["from"], "subject": msg["subject"], "date": msg["date"], "found_at": now,
        })
        have.add(fid)
        added += 1

    # A message is done only when every finding about it passed.
    for f in keep:
        msg = load_json(STATE / "inbox" / f"{f.get('message')}.json", None)
        if msg:
            done_msgs.discard(msg["message_id"])
    published["inbox_checked_at"] = now
    save_json(out_path, published)
    save_json(STATE / "seen.json", sorted(seen | done_msgs))
    save_json(STATE / "findings.json", {"findings": keep})
    print(f"Published {added} finding(s) to the Grants app; {len(done_msgs)} email(s) done; {rejected} rejected.")
    sys.exit(1 if rejected else 0)


if __name__ == "__main__":
    main()
