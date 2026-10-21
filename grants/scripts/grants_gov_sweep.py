#!/usr/bin/env python3
"""Federal sweep: every forecasted or posted Grants.gov opportunity that matches targets.keywords and
is open to one of the client's entities, with award size, deadline and eligibility text.

    python3 scripts/grants_gov_sweep.py           # search, then remember what was seen
    python3 scripts/grants_gov_sweep.py --dry     # same, but do not update state/federal_seen.json
    python3 scripts/grants_gov_sweep.py --limit 20  # fetch details for at most 20 (testing)

RUN IT IN THE FOREGROUND, once per run. It stops itself at DEADLINE seconds no matter what.
Uses the public Grants.gov API (search2 + fetchOpportunity), which needs no key or login.

Outputs state/sweep/federal.json and, on stdout, rows grouped as NEW, STILL OPEN, TOO TIGHT
(closes inside run.min_days_before_deadline_to_draft) and FORECASTED (not open yet: Watch list).
A ★ row names the client's entity type outright; the others are open to "others" or "unrestricted"
applicants, which in practice is mostly research awards: read their eligibility text before keeping one.
Every federal grant is Tier B: the agent drafts the package, the client submits it.
"""
import datetime
import html
import json
import os
import re
import ssl
import sys
import time
import urllib.request

R = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
API = "https://api.grants.gov/v1/api"
SEEN_FILE = os.path.join(R, "state", "federal_seen.json")
CACHE_FILE = os.path.join(R, "state", "federal_cache.json")
OUT = os.path.join(R, "state", "sweep")
DEADLINE = 300          # seconds; the Bash tool timeout must exceed this
ROWS = 100
MAX_PAGES = 3           # per keyword

# Grants.gov applicant-type codes.
SMALL_BUSINESS, NONPROFIT_501C3, NONPROFIT_OTHER, OTHERS, UNRESTRICTED = "23", "12", "13", "25", "99"

args = sys.argv[1:]
dry = "--dry" in args
LIMIT = int(args[args.index("--limit") + 1]) if "--limit" in args else None
TODAY = datetime.date.today()


def load(p, default):
    try:
        with open(p) as f:
            return json.load(f)
    except (OSError, ValueError):
        return default


settings = load(os.path.join(R, "config", "settings.json"), None)
profile = load(os.path.join(R, "config", "profile.json"), None)
if settings is None or profile is None:
    sys.exit("ERROR: config/settings.json or config/profile.json is missing. Run setup first.")
T = settings.get("targets", {})
FED = T.get("federal", {})
if FED.get("enabled") is False:
    print("Federal sweep is off (targets.federal.enabled is false).")
    sys.exit(0)
LEAD = int(settings.get("run", {}).get("min_days_before_deadline_to_draft", 14))
MIN_AWARD = float(T.get("min_award_usd") or 0)
EXCLUDE = [k.lower() for k in T.get("exclude_keywords", [])]
KEYWORDS = T.get("keywords") or ["small business"]

# Which applicant types the client can apply as. "Others" and "Unrestricted" are kept because their
# real rule lives in the eligibility text, which the agent reads.
codes = {OTHERS: "others (read eligibility text)", UNRESTRICTED: "unrestricted"}
apply_as = T.get("apply_as", ["business"])
if "business" in apply_as and profile.get("business", {}).get("enabled", True):
    codes[SMALL_BUSINESS] = "small business"
np_ = profile.get("nonprofit", {})
if "nonprofit" in apply_as and np_.get("enabled"):
    status = (np_.get("irs_status") or "").lower()
    if "501(c)(3)" in status:
        codes[NONPROFIT_501C3] = "nonprofit 501(c)(3)"
    elif status and status != "none":
        codes[NONPROFIT_OTHER] = "nonprofit, not 501(c)(3)"
if not ({SMALL_BUSINESS, NONPROFIT_501C3, NONPROFIT_OTHER} & set(codes)):
    sys.exit("ERROR: no enabled entity to search for. Check targets.apply_as and the business/nonprofit "
             "blocks in config/profile.json.")


def _ctx():
    """A verifying SSL context that works under launchd and with a bare python."""
    try:
        import certifi
        return ssl.create_default_context(cafile=certifi.where())
    except Exception:
        pass
    if os.path.exists("/etc/ssl/cert.pem"):
        return ssl.create_default_context(cafile="/etc/ssl/cert.pem")
    return ssl.create_default_context()


CTX = _ctx()
errors = {}


def post(endpoint, body):
    for attempt in (1, 2):
        try:
            req = urllib.request.Request(f"{API}/{endpoint}", data=json.dumps(body).encode(),
                                         headers={"Content-Type": "application/json", "User-Agent": "Mozilla/5.0"})
            with urllib.request.urlopen(req, timeout=30, context=CTX) as r:
                d = json.load(r)
            if d.get("errorcode", 0) != 0:
                raise ValueError(d.get("msg"))
            return d.get("data") or {}
        except Exception as e:
            k = f"{endpoint}:{type(e).__name__}"
            errors[k] = errors.get(k, 0) + 1
            if attempt == 2:
                return None
            time.sleep(2)


def text(s, n=None):
    s = re.sub(r"<[^>]+>", " ", html.unescape(s or ""))
    s = re.sub(r"\s+", " ", s).strip()
    return s[:n] + "..." if n and len(s) > n else s


def parse_date(s):
    """Grants.gov uses MM/DD/YYYY in search results and YYYY-MM-DD-HH-MM-SS in details."""
    s = (s or "").strip()
    for fmt, cut in (("%m/%d/%Y", 10), ("%Y-%m-%d", 10), ("%b %d, %Y", 12)):
        try:
            return datetime.datetime.strptime(s[:cut], fmt).date()
        except ValueError:
            continue
    return None


def money(s):
    try:
        v = float(str(s).replace(",", "").replace("$", ""))
        return v if v > 0 else None
    except ValueError:
        return None


t0 = time.time()
hits = {}
for kw in KEYWORDS:
    for page in range(MAX_PAGES):
        if time.time() - t0 > DEADLINE / 3:
            break
        body = {"keyword": kw, "oppStatuses": FED.get("statuses", "forecasted|posted"),
                "eligibilities": "|".join(sorted(codes)), "rows": ROWS, "startRecordNum": page * ROWS}
        if FED.get("agencies"):
            body["agencies"] = "|".join(FED["agencies"])
        d = post("search2", body)
        if not d:
            break
        for h in d.get("oppHits", []):
            h.setdefault("_keywords", [])
            hits.setdefault(h["id"], h)["_keywords"].append(kw)
        if (page + 1) * ROWS >= int(d.get("hitCount") or 0):
            break
        time.sleep(0.5)

hits = {i: h for i, h in hits.items() if not any(x in h.get("title", "").lower() for x in EXCLUDE)}
seen = load(SEEN_FILE, {})
cache = load(CACHE_FILE, {})
rows, fetched, timed_out = [], 0, False
for oid, h in sorted(hits.items(), key=lambda kv: parse_date(kv[1].get("closeDate")) or datetime.date.max):
    key = f"{oid}:{h.get('closeDate', '')}:{h.get('oppStatus', '')}"
    det = cache.get(oid) if cache.get(oid, {}).get("_key") == key else None
    if det is None:
        if time.time() - t0 > DEADLINE or (LIMIT is not None and fetched >= LIMIT):
            timed_out = time.time() - t0 > DEADLINE
            continue
        d = post("fetchOpportunity", {"opportunityId": int(oid)})
        fetched += 1
        time.sleep(0.3)
        if not d:
            continue
        s = d.get("synopsis") or d.get("forecast") or {}
        det = {
            "_key": key,
            "ceiling": money(s.get("awardCeiling")),
            "floor": money(s.get("awardFloor")),
            "cost_sharing": bool(s.get("costSharing")),
            "types": [t.get("id") for t in s.get("applicantTypes") or []],
            "eligibility": text(s.get("applicantEligibilityDesc"), 600),
            "description": text(s.get("synopsisDesc") or s.get("forecastDesc"), 900),
            "close": s.get("responseDateStr") or s.get("estApplicationResponseDateStr") or "",
            "est_open": s.get("estSynopsisPostingDateStr") or "",
            "contact": s.get("agencyContactEmail") or "",
        }
        cache[oid] = det
    close = parse_date(h.get("closeDate")) or parse_date(det.get("close"))
    if close and close < TODAY:
        continue
    if det["types"] and not set(det["types"]) & set(codes):
        continue
    if det["ceiling"] is not None and det["ceiling"] < MIN_AWARD:
        continue
    if h.get("oppStatus") == "forecasted":
        bucket = "FORECASTED"
    elif close and (close - TODAY).days < LEAD:
        bucket = "TOO TIGHT"
    elif oid in seen:
        bucket = "STILL OPEN"
    else:
        bucket = "NEW"
    rows.append({
        "bucket": bucket, "id": oid, "number": h.get("number", ""), "title": text(h.get("title")),
        "agency": text(h.get("agency")), "status": h.get("oppStatus", ""),
        "explicit": bool(set(det["types"]) & (set(codes) - {OTHERS, UNRESTRICTED})),
        "close": close.isoformat() if close else "", "days_left": (close - TODAY).days if close else None,
        "ceiling": det["ceiling"], "floor": det["floor"], "cost_sharing": det["cost_sharing"],
        "eligible_as": [codes[c] for c in det["types"] if c in codes] or ["(no applicant types listed)"],
        "eligibility": det["eligibility"], "description": det["description"], "contact": det["contact"],
        "keywords": h["_keywords"], "url": f"https://www.grants.gov/search-results-detail/{oid}",
    })

os.makedirs(OUT, exist_ok=True)
with open(os.path.join(OUT, "federal.json"), "w") as f:
    json.dump(rows, f, indent=1)
with open(CACHE_FILE, "w") as f:
    json.dump(cache, f)

print(f"keywords {KEYWORDS}  as {sorted(codes.values())}  hits {len(hits)}  kept {len(rows)}  "
      f"details fetched {fetched}  {time.time() - t0:.0f}s"
      + ("  ★ TIMED OUT, some opportunities not checked; seen list NOT updated" if timed_out else ""))
print("Every federal grant is Tier B: draft the package, never submit. "
      + ("Business UEI/SAM: " + (profile.get("business", {}).get("sam_registration") or "UNKNOWN, ask the client")))
for b in ("NEW", "STILL OPEN", "TOO TIGHT", "FORECASTED"):
    # Programs that name the client's entity type first; "others"/"unrestricted" ones are mostly
    # research awards whose real rule is in the eligibility text.
    group = sorted((r for r in rows if r["bucket"] == b), key=lambda r: (not r["explicit"], r["close"] or "9999"))
    if not group:
        continue
    print(f"\n== {b} ({len(group)})")
    for r in group:
        award = f"${r['ceiling']:,.0f}" if r["ceiling"] else "ceiling n/a"
        print("\t".join(["★" if r["explicit"] else " ", r["close"] or "no date", award, "COST SHARE" if r["cost_sharing"] else "",
                         r["agency"][:40], r["title"][:90], ",".join(r["eligible_as"]), r["url"]]))
if errors:
    print("--- request errors by type:", errors)
if not dry and not timed_out and LIMIT is None:
    now = TODAY.isoformat()
    for r in rows:
        seen.setdefault(r["id"], now)
    with open(SEEN_FILE, "w") as f:
        json.dump(seen, f)
