#!/usr/bin/env python3
"""The owner's dashboard: what the grant agent has written and sent, and what needs the owner.

    python3 scripts/dashboard.py --open     # start on this computer and open the browser
    python3 scripts/dashboard.py --demo     # the same page filled with made-up sample data
    python3 scripts/dashboard.py --port 8765

It only listens on this computer (127.0.0.1); nothing is published anywhere. It reads:
  applications/<slug>.json   one record per application, written by the agent (schema in config/spec.md)
  applications/<slug>.md     the full application text
  applications/files/<slug>/ package files such as CHECKLIST.md
  state/last_run.json        the agent's end-of-run summary
and writes ONLY:
  config/owner-input.json    the owner's answers, approvals, "done" marks and results
  data/docs/                 files the owner uploads
The agent reads owner-input.json on its next run and never edits it, so neither side can overwrite
the other. Standard library only.
"""
import argparse
import base64
import datetime
import http.server
import json
import os
import re
import secrets
import shutil
import subprocess
import sys
import tempfile
import threading
import urllib.parse
import webbrowser
from pathlib import Path

HERE = Path(__file__).resolve().parent.parent
PAGE = HERE / "dashboard" / "index.html"
SLUG_RE = re.compile(r"^[a-z0-9][a-z0-9-]{0,120}$")
NEED_RE = re.compile(r"^[A-Za-z0-9_-]{1,40}$")
MAX_UPLOAD = 15 * 1024 * 1024
MAX_ANSWER = 5000
OWNER_FIELDS = ("approved_at", "submitted_by_owner_at", "outcome", "outcome_amount_usd", "outcome_at")
LOCK = threading.Lock()


def now():
    return datetime.datetime.now().isoformat(timespec="minutes")


def read_json(p, default):
    try:
        return json.loads(Path(p).read_text())
    except (OSError, ValueError):
        return default


def write_json_atomic(p, data):
    p = Path(p)
    p.parent.mkdir(parents=True, exist_ok=True)
    fd, tmp = tempfile.mkstemp(dir=p.parent, prefix=".tmp-", suffix=".json")
    with os.fdopen(fd, "w") as f:
        json.dump(data, f, indent=1)
    os.replace(tmp, p)


def next_run(schedule):
    """When the next scheduled check should happen, from settings.schedule. None for manual."""
    freq = schedule.get("frequency", "manual")
    hour = int(schedule.get("hour", 9))
    days = {"daily": range(7), "weekdays": range(5), "twice-weekly": (0, 3), "weekly": (0,)}.get(freq)
    if days is None:
        return None
    t = datetime.datetime.now()
    for i in range(8):
        d = (t + datetime.timedelta(days=i)).replace(hour=hour, minute=0, second=0, microsecond=0)
        if d.weekday() in days and d > t:
            return d.isoformat(timespec="minutes")
    return None


class Store:
    def __init__(self, root):
        self.root = Path(root)
        self.input_path = self.root / "config" / "owner-input.json"

    def owner_input(self):
        return read_json(self.input_path, {})

    def state(self):
        settings = read_json(self.root / "config" / "settings.json", {})
        profile = read_json(self.root / "config" / "profile.json", {})
        owner = self.owner_input()
        apps = []
        for f in sorted((self.root / "applications").glob("*.json")):
            rec = read_json(f, None)
            if not isinstance(rec, dict) or not SLUG_RE.match(str(rec.get("slug", ""))):
                continue
            # Approvals, "I submitted it" and results are the owner's alone: only owner-input.json
            # may set them, so a record that carries them is ignored on those fields.
            for k in OWNER_FIELDS:
                rec.pop(k, None)
            mine = owner.get(rec["slug"], {})
            # Need ids end up inside button handlers on the page, so a malformed one is dropped.
            rec["needs"] = [n for n in rec.get("needs") or [] if isinstance(n, dict) and NEED_RE.match(str(n.get("id", "")))]
            for n in rec["needs"]:
                n.update({k: v for k, v in (mine.get("needs") or {}).get(str(n.get("id")), {}).items()
                          if k in ("answer", "file", "answered_at", "done_at")})
            for k in OWNER_FIELDS:
                if mine.get(k) not in (None, ""):
                    rec[k] = mine[k]
            rec["has_doc"] = (self.root / "applications" / f"{rec['slug']}.md").is_file()
            files = self.root / "applications" / "files" / rec["slug"]
            rec["package_files"] = sorted(p.name for p in files.glob("*.md")) if files.is_dir() else []
            shot = rec.get("screenshot") or ""
            rec["has_screenshot"] = bool(shot) and (self.root / shot).is_file()
            apps.append(rec)
        biz = profile.get("business", {})
        last = read_json(self.root / "state" / "last_run.json", {})
        if not last and (self.root / "state" / "status.md").is_file():
            m = datetime.datetime.fromtimestamp((self.root / "state" / "status.md").stat().st_mtime)
            last = {"finished_at": m.isoformat(timespec="minutes")}
        schedule = settings.get("schedule", {})
        return {
            "business": biz.get("dba") or biz.get("legal_name") or "",
            "configured": (self.root / "config" / "profile.json").is_file(),
            "mode": settings.get("submission", {}).get("mode", "auto"),
            "frequency": schedule.get("frequency", "manual"),
            "next_run": next_run(schedule),
            "last_run": last,
            "running": (self.root / ".run.lock").is_dir(),
            "applications": apps,
            "today": datetime.date.today().isoformat(),
        }

    def known(self, slug, need_id=None):
        rec = read_json(self.root / "applications" / f"{slug}.json", None)
        if not isinstance(rec, dict):
            return None
        if need_id is not None and not any(str(n.get("id")) == need_id for n in rec.get("needs") or []):
            return None
        return rec

    def update(self, slug, fn):
        with LOCK:
            data = self.owner_input()
            entry = data.setdefault(slug, {})
            fn(entry)
            write_json_atomic(self.input_path, data)

    def doc(self, slug, name=None):
        if name is None:
            p = self.root / "applications" / f"{slug}.md"
        else:
            if not re.match(r"^[A-Za-z0-9._-]+\.(md|txt)$", name):
                return None
            p = self.root / "applications" / "files" / slug / name
        return p.read_text() if p.is_file() else None


def make_handler(store, token, port):
    allowed_hosts = {f"127.0.0.1:{port}", f"localhost:{port}"}

    class H(http.server.BaseHTTPRequestHandler):
        server_version = "QueenBeeDashboard"

        def log_message(self, *a):
            pass

        def send(self, code, body, ctype="application/json", extra=None):
            if isinstance(body, (dict, list)):
                body = json.dumps(body)
            if isinstance(body, str):
                body = body.encode()
            self.send_response(code)
            self.send_header("Content-Type", ctype)
            self.send_header("Content-Length", str(len(body)))
            self.send_header("Cache-Control", "no-store")
            self.send_header("X-Content-Type-Options", "nosniff")
            self.send_header("Referrer-Policy", "no-referrer")
            for k, v in (extra or {}).items():
                self.send_header(k, v)
            self.end_headers()
            self.wfile.write(body)

        def host_ok(self):
            # Refuses DNS-rebinding: only requests addressed to this computer by name are served.
            return self.headers.get("Host", "") in allowed_hosts

        def do_GET(self):
            if not self.host_ok():
                return self.send(403, {"error": "wrong host"})
            u = urllib.parse.urlparse(self.path)
            q = urllib.parse.parse_qs(u.query)
            if u.path in ("/", "/index.html"):
                html = PAGE.read_text().replace("__TOKEN__", token)
                return self.send(200, html, "text/html; charset=utf-8", {
                    "Content-Security-Policy": "default-src 'self'; img-src 'self' data:; "
                    "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; "
                    "font-src https://fonts.gstatic.com; script-src 'self' 'unsafe-inline'; frame-ancestors 'none'"})
            if u.path == "/api/state":
                return self.send(200, store.state())
            if u.path == "/api/doc":
                slug = (q.get("slug") or [""])[0]
                if not SLUG_RE.match(slug):
                    return self.send(400, {"error": "bad slug"})
                text = store.doc(slug, (q.get("file") or [None])[0])
                return self.send(200, {"text": text}) if text is not None else self.send(404, {"error": "not found"})
            if u.path == "/api/screenshot":
                slug = (q.get("slug") or [""])[0]
                rec = store.known(slug) if SLUG_RE.match(slug) else None
                shot = (rec or {}).get("screenshot") or ""
                p = (store.root / shot).resolve()
                if not rec or not shot or (store.root / "screenshots").resolve() not in p.parents or not p.is_file():
                    return self.send(404, {"error": "not found"})
                ctype = "image/png" if p.suffix.lower() == ".png" else "image/jpeg"
                return self.send(200, p.read_bytes(), ctype)
            self.send(404, {"error": "not found"})

        def do_POST(self):
            if not self.host_ok() or self.headers.get("X-Dashboard-Token") != token:
                return self.send(403, {"error": "This page is out of date. Reload it and try again."})
            try:
                n = int(self.headers.get("Content-Length") or 0)
                if n > MAX_UPLOAD * 1.4 + 4096:
                    return self.send(413, {"error": "That file is too large. The limit is 15 MB."})
                body = json.loads(self.rfile.read(n) or b"{}")
            except ValueError:
                return self.send(400, {"error": "bad request"})
            slug, need = str(body.get("slug", "")), str(body.get("need_id", ""))
            if not SLUG_RE.match(slug):
                return self.send(400, {"error": "bad slug"})
            path = urllib.parse.urlparse(self.path).path

            if path in ("/api/answer", "/api/done", "/api/upload"):
                if not NEED_RE.match(need) or not store.known(slug, need):
                    return self.send(404, {"error": "That request is no longer open. Reload the page."})
            elif not store.known(slug):
                return self.send(404, {"error": "That application no longer exists. Reload the page."})

            if path == "/api/answer":
                answer = str(body.get("answer", "")).strip()
                if not answer:
                    return self.send(400, {"error": "Write an answer first."})
                if len(answer) > MAX_ANSWER:
                    return self.send(400, {"error": f"Keep the answer under {MAX_ANSWER} characters."})
                store.update(slug, lambda e: e.setdefault("needs", {}).setdefault(need, {}).update(
                    answer=answer, answered_at=now()))
                return self.send(200, {"ok": True})
            if path == "/api/done":
                store.update(slug, lambda e: e.setdefault("needs", {}).setdefault(need, {}).update(done_at=now()))
                return self.send(200, {"ok": True})
            if path == "/api/upload":
                name = re.sub(r"[^A-Za-z0-9._-]+", "-", Path(str(body.get("filename", ""))).name).strip("-.")
                if not re.search(r"\.(pdf|docx?|xlsx?|csv|png|jpe?g|txt)$", name, re.I):
                    return self.send(400, {"error": "Upload a PDF, Word, Excel, CSV, image or text file."})
                try:
                    data = base64.b64decode(str(body.get("data", "")), validate=True)
                except ValueError:
                    return self.send(400, {"error": "The file could not be read. Try again."})
                if not data or len(data) > MAX_UPLOAD:
                    return self.send(400, {"error": "That file is empty or larger than 15 MB."})
                docs = store.root / "data" / "docs"
                docs.mkdir(parents=True, exist_ok=True)
                dest = docs / f"{slug}-{name}"
                dest.write_bytes(data)
                rel = str(dest.relative_to(store.root))
                store.update(slug, lambda e: e.setdefault("needs", {}).setdefault(need, {}).update(
                    file=rel, answered_at=now()))
                return self.send(200, {"ok": True, "file": rel})
            if path == "/api/reveal":
                # Opens the package folder in Finder (or the Linux file manager) on this computer.
                folder = store.root / "applications" / "files" / slug
                if not folder.is_dir():
                    return self.send(404, {"error": "The files for this application are not there any more."})
                subprocess.Popen(["open" if sys.platform == "darwin" else "xdg-open", str(folder)])
                return self.send(200, {"ok": True})
            if path == "/api/approve":
                store.update(slug, lambda e: e.update(approved_at=now()))
                return self.send(200, {"ok": True})
            if path == "/api/submitted":
                store.update(slug, lambda e: e.update(submitted_by_owner_at=now()))
                return self.send(200, {"ok": True})
            if path == "/api/outcome":
                outcome = body.get("outcome")
                if outcome not in ("AWARDED", "DECLINED", ""):
                    return self.send(400, {"error": "bad outcome"})
                amount = None
                if outcome == "AWARDED" and str(body.get("amount", "")).strip():
                    try:
                        amount = round(float(str(body["amount"]).replace(",", "").replace("$", "")), 2)
                    except ValueError:
                        return self.send(400, {"error": "Write the amount as a number, like 5000."})
                store.update(slug, lambda e: e.update(outcome=outcome, outcome_amount_usd=amount,
                                                      outcome_at=now() if outcome else ""))
                return self.send(200, {"ok": True})
            self.send(404, {"error": "not found"})

    return H


def demo_root():
    """A throwaway folder with made-up applications, so the page can be seen before setup."""
    root = Path(tempfile.mkdtemp(prefix="queenbee-demo-"))
    for d in ("applications/files", "config", "state", "screenshots"):
        (root / d).mkdir(parents=True, exist_ok=True)
    today = datetime.date.today()
    day = lambda n: (today + datetime.timedelta(days=n)).isoformat()
    ago = lambda n: (datetime.datetime.now() - datetime.timedelta(days=n)).isoformat(timespec="minutes")
    (root / "config/profile.json").write_text(json.dumps({"business": {"legal_name": "Sample Business LLC"}}))
    (root / "config/settings.json").write_text(json.dumps({"submission": {"mode": "auto"},
                                                           "schedule": {"frequency": "weekly", "hour": 9}}))
    recs = [
        {"slug": "sample-community-fund-small-business-2026", "funder": "Sample Community Fund",
         "program": "Small Business Grant", "tier": "A", "status": "NEEDS HUMAN", "deadline": day(24),
         "award_max_usd": 10000, "amount_requested_usd": 10000, "url": "https://example.org/grant",
         "summary": "A county grant for equipment and training. Everything is filled except two answers.",
         "needs": [
             {"id": "n1", "kind": "question", "ask": "How many people did the business employ on January 1 of this year, full-time and part-time?",
              "why": "The form asks for headcount on that date, and your files only give today's number."},
             {"id": "n2", "kind": "document", "ask": "Upload the business's W-9.",
              "why": "The program requires it with the application."}]},
        {"slug": "sample-bank-women-owned-grant-2026", "funder": "Sample Bank Foundation",
         "program": "Women-Owned Business Grant", "tier": "A", "status": "FOR YOU", "deadline": day(9),
         "award_max_usd": 5000, "amount_requested_usd": 5000, "url": "https://example.org/bank",
         "summary": "Written and ready, but the form ends with a typed signature.",
         "needs": [{"id": "n1", "kind": "signature", "ask": "Open the form and type your signature at the end, then press Submit.",
                    "why": "A signature is you signing for the business, so the agent leaves it to you."}]},
        {"slug": "sample-state-workforce-training-2026", "funder": "Sample State Commerce Dept.",
         "program": "Workforce Training Grant", "tier": "B", "status": "PACKAGE READY", "deadline": day(38),
         "award_max_usd": 25000, "amount_requested_usd": 18400, "url": "https://example.gov/training",
         "summary": "A state package for training two employees. The checklist lists the steps left for you."},
        {"slug": "sample-utility-main-street-2026", "funder": "Sample Electric Co.", "program": "Main Street Grant",
         "tier": "A", "status": "SUBMITTED", "deadline": day(-6), "submitted_at": ago(12),
         "award_max_usd": 2500, "amount_requested_usd": 2500, "url": "https://example.com/main-street",
         "summary": "A grant for storefront improvements."},
        {"slug": "sample-foundation-growth-2026", "funder": "Sample Family Foundation", "program": "Growth Grant",
         "tier": "A", "status": "SUBMITTED", "deadline": day(-40), "submitted_at": ago(45),
         "award_max_usd": 15000, "amount_requested_usd": 15000, "url": "https://example.org/growth",
         "summary": "A grant toward new equipment."},
        {"slug": "sample-national-accelerator-2027", "funder": "Sample National Network", "program": "Spring Grants",
         "tier": "A", "status": "WATCH", "deadline": "", "opens": day(70), "award_max_usd": 20000,
         "url": "https://example.org/spring", "summary": "Opens in the spring. The agent will check back then."},
        {"slug": "sample-research-grant-2026", "funder": "Sample Federal Agency", "program": "Research Grant",
         "tier": "B", "status": "SKIP", "deadline": day(30), "url": "https://example.gov/research",
         "summary": "Only universities can apply."},
    ]
    for r in recs:
        r.setdefault("updated_at", ago(1))
        (root / "applications" / f"{r['slug']}.json").write_text(json.dumps(r))
        (root / "applications" / f"{r['slug']}.md").write_text(
            f"# {r['funder']} — {r['program']}\n\n- Deadline: {r['deadline'] or 'not set'}\n\n"
            "## Describe your business\nThis is sample text. In a real run, every answer the agent wrote appears here.\n")
    (root / "config/owner-input.json").write_text(json.dumps({"sample-foundation-growth-2026": {
        "outcome": "AWARDED", "outcome_amount_usd": 7500, "outcome_at": ago(10)}}))
    pk = root / "applications" / "files" / "sample-state-workforce-training-2026"
    pk.mkdir(parents=True)
    (pk / "CHECKLIST.md").write_text(
        f"**Deadline: {day(38)}**\n\n1. Sign in to the state grants portal.\n2. Upload narrative.md and budget.md.\n"
        "3. Upload the W-9 and last year's financial statements.\n4. Sign and submit.\n")
    (root / "state/last_run.json").write_text(json.dumps({"finished_at": ago(2), "submitted": 1, "drafted": 2,
                                                          "needs_you": 2, "note": "Checked 31 programs, sent 1, wrote 2 more."}))
    return root


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawTextHelpFormatter)
    ap.add_argument("--port", type=int, default=8765)
    ap.add_argument("--open", action="store_true", help="open the dashboard in the browser")
    ap.add_argument("--demo", action="store_true", help="show made-up sample data")
    ap.add_argument("--root", help=argparse.SUPPRESS)
    a = ap.parse_args()
    root = demo_root() if a.demo else Path(a.root or HERE)
    token = secrets.token_urlsafe(24)
    server = None
    for port in range(a.port, a.port + 20):
        try:
            server = http.server.ThreadingHTTPServer(("127.0.0.1", port), make_handler(Store(root), token, port))
            break
        except OSError:
            continue
    if server is None:
        sys.exit(f"Could not start: ports {a.port}-{a.port + 19} are all in use.")
    url = f"http://127.0.0.1:{server.server_address[1]}/"
    print(f"Grants dashboard is open at {url}" + ("  (sample data)" if a.demo else ""))
    print("Keep this window open while you use it. Close it, or press Control-C, to stop.")
    if a.open:
        threading.Timer(0.4, lambda: webbrowser.open(url)).start()
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()
        if a.demo:
            shutil.rmtree(root, ignore_errors=True)


if __name__ == "__main__":
    main()
