#!/usr/bin/env python3
"""End-to-end check of the mail scripts against made-up emails, with no mailbox and no network.

    python tests/selftest.py

Builds a throwaway QueenBee folder (a grants folder with two submitted applications, this agent's
scripts, and a folder of .eml files), runs fetch_mail.py --from-dir, writes findings the way the
agent would (good and bad), runs publish_findings.py, and checks what reached the Grants app.
"""
import json
import shutil
import subprocess
import sys
import tempfile
from email.message import EmailMessage
from pathlib import Path

HERE = Path(__file__).resolve().parent.parent


def eml(path, sender, subject, date, text=None, html=None):
    m = EmailMessage()
    m["From"], m["To"], m["Subject"], m["Date"] = sender, "owner@example.com", subject, date
    m["Message-ID"] = f"<{path.stem}@test>"
    if text:
        m.set_content(text)
    if html:
        if text:
            m.add_alternative(html, subtype="html")
        else:
            m.set_content(html, subtype="html")
    path.write_bytes(bytes(m))


def run(cwd, *args):
    r = subprocess.run([sys.executable, *args], cwd=cwd, capture_output=True, text=True, encoding="utf-8")
    return r.returncode, r.stdout + r.stderr


def main():
    tmp = Path(tempfile.mkdtemp(prefix="grant-results-test-"))
    try:
        grants, agent, mail = tmp / "grants", tmp / "grant-results", tmp / "mail"
        for d in (grants / "applications", grants / "config", agent / "config", mail):
            d.mkdir(parents=True)
        shutil.copytree(HERE / "scripts", agent / "scripts")
        (grants / "CLAUDE.md").write_text("test\n", encoding="utf-8")
        (agent / "config" / "settings.json").write_text(json.dumps({
            "grants_folder": "../grants", "mail": {"address": "owner@example.com", "imap_host": "imap.example.com"},
            "platform_senders": ["submittable.com"], "max_messages_per_run": 40, "retention_days": 60}), encoding="utf-8")
        recs = [
            {"slug": "family-growth-2026", "funder": "Sample Family Foundation", "program": "Growth Grant",
             "status": "SUBMITTED", "submitted_at": "2026-09-01T10:00", "url": "https://www.samplefamilyfoundation.org/growth"},
            {"slug": "electric-main-street-2026", "funder": "Sample Electric Co.", "program": "Main Street Grant",
             "status": "SUBMITTED", "submitted_at": "2026-09-20T10:00", "url": "https://sampleelectric.com/main-street"},
            {"slug": "not-sent-yet-2026", "funder": "Unsent Fund", "program": "X", "status": "READY FOR APPROVAL",
             "url": "https://unsent.org"},
        ]
        for r in recs:
            (grants / "applications" / f"{r['slug']}.json").write_text(json.dumps(r), encoding="utf-8")

        eml(mail / "award.eml", "Grants Team <grants@samplefamilyfoundation.org>", "Your Growth Grant application",
            "Fri, 16 Oct 2026 09:12:00 -0400",
            html="<p>Dear applicant,</p><p>We are pleased to inform you that your business has been selected to receive "
                 "a <b>$7,500</b> Growth Grant.</p><p>Please confirm acceptance by November 3, 2026.</p>")
        eml(mail / "decline.eml", "Submittable <notifications@submittable.com>", "Update on your submission",
            "Mon, 12 Oct 2026 14:00:00 -0400",
            text="Thank you for applying to the Sample Electric Co. Main Street Grant. After careful review, we are unable "
                 "to fund your application this cycle.")
        eml(mail / "docs.eml", "Pat Lee <patlee@gmail.com>", "Main Street Grant - one more document",
            "Tue, 13 Oct 2026 08:00:00 -0400", text="Hi, could you send your W-9 by October 30? Thanks, Pat")
        eml(mail / "news.eml", "News <hello@someshop.com>", "Fall sale", "Wed, 14 Oct 2026 08:00:00 -0400",
            text="Nothing about grants here.")
        eml(mail / "old.eml", "Grants Team <grants@samplefamilyfoundation.org>", "Applications now open",
            "Mon, 03 Aug 2026 09:00:00 -0400", text="Our Growth Grant opens soon.")

        code, out = run(agent, "scripts/fetch_mail.py", "--from-dir", str(mail))
        assert code == 0, out
        watch = json.loads((agent / "state" / "watchlist.json").read_text(encoding="utf-8"))
        assert sorted(w["slug"] for w in watch) == ["electric-main-street-2026", "family-growth-2026"], watch
        cands = json.loads((agent / "state" / "candidates.json").read_text(encoding="utf-8"))
        by_subject = {c["subject"]: c for c in cands}
        assert set(by_subject) == {"Your Growth Grant application", "Update on your submission",
                                   "Main Street Grant - one more document"}, by_subject.keys()
        award = by_subject["Your Growth Grant application"]
        assert award["slugs"] == ["family-growth-2026"]
        award_text = json.loads((agent / "state" / "inbox" / f"{award['id']}.json").read_text(encoding="utf-8"))["text"]
        assert "$7,500" in award_text and "<b>" not in award_text, "HTML-only email turned into plain text"
        decline = by_subject["Update on your submission"]
        docs = by_subject["Main Street Grant - one more document"]

        findings = [
            {"message": award["id"], "slug": "family-growth-2026", "kind": "AWARDED", "amount_usd": 7500,
             "summary": "Sample Family Foundation says you won $7,500.",
             "quote": "We are pleased to inform you that your business has been selected to receive a $7,500 Growth Grant."},
            {"message": award["id"], "slug": "family-growth-2026", "kind": "NEEDS_REPLY", "reply_by": "2026-11-03",
             "summary": "They ask you to confirm acceptance by November 3.", "quote": "Please confirm acceptance by November 3, 2026."},
            {"message": decline["id"], "slug": "electric-main-street-2026", "kind": "DECLINED",
             "summary": "Sample Electric Co. did not select this application.",
             "quote": "we are unable to fund your application this cycle"},
            # Three the checks must stop:
            {"message": docs["id"], "slug": "electric-main-street-2026", "kind": "AWARDED", "amount_usd": 25000,
             "summary": "Won.", "quote": "could you send your W-9 by October 30?"},
            {"message": docs["id"], "slug": "family-growth-2026", "kind": "NEEDS_REPLY",
             "summary": "Send the W-9.", "quote": "could you send your W-9 by October 30?"},
            {"message": decline["id"], "slug": "electric-main-street-2026", "kind": "UPDATE",
             "summary": "An update.", "quote": "We loved your application and will fund it."},
        ]
        (agent / "state" / "findings.json").write_text(json.dumps({"findings": findings}), encoding="utf-8")
        code, out = run(agent, "scripts/publish_findings.py")
        assert code == 1, "rejected findings make the script exit 1"
        assert "does not appear in the email" in out, out
        assert "slug must be one this email was matched to" in out, out
        assert "quote does not appear word for word" in out, out

        pub = json.loads((grants / "state" / "email-findings.json").read_text(encoding="utf-8"))
        kinds = sorted((f["slug"], f["kind"], f["amount_usd"]) for f in pub["findings"])
        assert kinds == [("electric-main-street-2026", "DECLINED", None), ("family-growth-2026", "AWARDED", 7500),
                         ("family-growth-2026", "NEEDS_REPLY", None)], kinds
        assert pub.get("inbox_checked_at")
        left = json.loads((agent / "state" / "findings.json").read_text(encoding="utf-8"))["findings"]
        assert len(left) == 3, "rejected findings stay for the agent to fix"
        seen = json.loads((agent / "state" / "seen.json").read_text(encoding="utf-8"))
        assert seen == ["<award@test>"], f"only emails whose every finding passed are done: {seen}"

        # The agent fixes the rejects: the docs email is a NEEDS_REPLY on the right application,
        # and the decline needs no extra UPDATE.
        fixed = [{"message": docs["id"], "slug": "electric-main-street-2026", "kind": "NEEDS_REPLY", "reply_by": "2026-10-30",
                  "summary": "The funder asks for your W-9 by October 30.", "quote": "could you send your W-9 by October 30?"},
                 # The decline email had a rejected UPDATE, so it is not done yet: its DECLINED goes again.
                 findings[2]]
        (agent / "state" / "findings.json").write_text(json.dumps({"findings": fixed}), encoding="utf-8")
        code, out = run(agent, "scripts/publish_findings.py")
        assert code == 0, out
        pub = json.loads((grants / "state" / "email-findings.json").read_text(encoding="utf-8"))
        assert len(pub["findings"]) == 4, "the decline was not published twice"

        # Second fetch: every email is done, nothing new to classify.
        code, out = run(agent, "scripts/fetch_mail.py", "--from-dir", str(mail))
        assert code == 0 and json.loads((agent / "state" / "candidates.json").read_text(encoding="utf-8")) == [], out

        # Once the owner records a result, that application stops being watched.
        (grants / "config" / "owner-input.json").write_text(json.dumps({"family-growth-2026": {"outcome": "AWARDED"}}), encoding="utf-8")
        run(agent, "scripts/fetch_mail.py", "--from-dir", str(mail))
        watch = json.loads((agent / "state" / "watchlist.json").read_text(encoding="utf-8"))
        assert [w["slug"] for w in watch] == ["electric-main-street-2026"], watch
        print("selftest OK")
    finally:
        shutil.rmtree(tmp, ignore_errors=True)


if __name__ == "__main__":
    main()
