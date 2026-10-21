// Reads what the grant agent wrote and records what the owner does. No Electron in here, so it can
// be tested with plain node (src/selftest.js).
//
// Reads:  applications/<slug>.json  one record per application (schema in config/spec.md)
//         applications/<slug>.md    the full application text
//         applications/files/<slug>/ package files such as CHECKLIST.md
//         state/last_run.json        the agent's end-of-run summary
// Writes: config/owner-input.json    answers, approvals, "done" marks and results, and nothing else
//         data/docs/                 files the owner uploads
// The agent reads owner-input.json and never edits it, so neither side can overwrite the other.
const fs = require("fs");
const path = require("path");

const SLUG_RE = /^[a-z0-9][a-z0-9-]{0,120}$/;
const NEED_RE = /^[A-Za-z0-9_-]{1,40}$/;
const DOC_NAME_RE = /^[A-Za-z0-9._-]+\.(md|txt)$/;
const UPLOAD_RE = /\.(pdf|docx?|xlsx?|csv|png|jpe?g|txt)$/i;
const OWNER_FIELDS = ["approved_at", "submitted_by_owner_at", "outcome", "outcome_amount_usd", "outcome_at"];
const MAX_ANSWER = 5000;
const MAX_UPLOAD = 50 * 1024 * 1024;

const pad = (n) => String(n).padStart(2, "0");
function localDate(d = new Date()) {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}
function now(d = new Date()) {
  return `${localDate(d)}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function readJSON(p, fallback) {
  try {
    return JSON.parse(fs.readFileSync(p, "utf8"));
  } catch {
    return fallback;
  }
}

function writeJSONAtomic(p, data) {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  const tmp = `${p}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 1));
  fs.renameSync(tmp, p);
}

// When the next scheduled check should happen, from settings.schedule. null for manual.
function nextRun(schedule, from = new Date()) {
  const days = { daily: [0, 1, 2, 3, 4, 5, 6], weekdays: [1, 2, 3, 4, 5], "twice-weekly": [1, 4], weekly: [1] }[
    schedule.frequency || "manual"
  ];
  if (!days) return null;
  const hour = Number.isInteger(schedule.hour) ? schedule.hour : 9;
  for (let i = 0; i < 8; i++) {
    const d = new Date(from.getFullYear(), from.getMonth(), from.getDate() + i, hour, 0);
    if (days.includes(d.getDay()) && d > from) return now(d);
  }
  return null;
}

// A folder is a grants folder when it holds the agent's playbook and scripts.
function isGrantsFolder(root) {
  return !!root && fs.existsSync(path.join(root, "CLAUDE.md")) && fs.existsSync(path.join(root, "scripts", "grant_docs.py"));
}

class Store {
  constructor(root) {
    this.root = root;
    this.inputPath = path.join(root, "config", "owner-input.json");
  }

  ownerInput() {
    return readJSON(this.inputPath, {});
  }

  state() {
    const settings = readJSON(path.join(this.root, "config", "settings.json"), {});
    const profile = readJSON(path.join(this.root, "config", "profile.json"), {});
    const owner = this.ownerInput();
    const appsDir = path.join(this.root, "applications");
    const apps = [];
    let names = [];
    try {
      names = fs.readdirSync(appsDir).filter((n) => n.endsWith(".json")).sort();
    } catch {}
    for (const name of names) {
      const rec = readJSON(path.join(appsDir, name), null);
      if (!rec || typeof rec !== "object" || !SLUG_RE.test(String(rec.slug || ""))) continue;
      // Approvals, "I submitted it" and results are the owner's alone: only owner-input.json may set them.
      for (const k of OWNER_FIELDS) delete rec[k];
      const mine = owner[rec.slug] || {};
      rec.needs = (Array.isArray(rec.needs) ? rec.needs : []).filter((n) => n && NEED_RE.test(String(n.id || "")));
      for (const n of rec.needs) {
        const got = (mine.needs || {})[String(n.id)] || {};
        for (const k of ["answer", "file", "answered_at", "done_at"]) if (got[k]) n[k] = got[k];
      }
      for (const k of OWNER_FIELDS) if (mine[k] !== undefined && mine[k] !== null && mine[k] !== "") rec[k] = mine[k];
      rec.has_doc = fs.existsSync(path.join(appsDir, `${rec.slug}.md`));
      const files = path.join(appsDir, "files", rec.slug);
      try {
        rec.package_files = fs.readdirSync(files).filter((n) => n.endsWith(".md")).sort();
      } catch {
        rec.package_files = [];
      }
      rec.has_screenshot = !!this.screenshotPath(rec);
      apps.push(rec);
    }
    const biz = profile.business || {};
    let last = readJSON(path.join(this.root, "state", "last_run.json"), {});
    if (!last.finished_at) {
      try {
        last = { finished_at: now(fs.statSync(path.join(this.root, "state", "status.md")).mtime) };
      } catch {}
    }
    const schedule = settings.schedule || {};
    return {
      root: this.root,
      business: biz.dba || biz.legal_name || "",
      configured: fs.existsSync(path.join(this.root, "config", "profile.json")),
      mode: (settings.submission || {}).mode || "auto",
      frequency: schedule.frequency || "manual",
      next_run: nextRun(schedule),
      last_run: last,
      running: fs.existsSync(path.join(this.root, ".run.lock")),
      applications: apps,
      today: localDate(),
    };
  }

  record(slug) {
    if (!SLUG_RE.test(String(slug))) return null;
    const rec = readJSON(path.join(this.root, "applications", `${slug}.json`), null);
    return rec && typeof rec === "object" ? rec : null;
  }

  hasNeed(slug, needId) {
    const rec = this.record(slug);
    return !!rec && NEED_RE.test(String(needId)) && (rec.needs || []).some((n) => String(n.id) === String(needId));
  }

  update(slug, fn) {
    const data = this.ownerInput();
    data[slug] = data[slug] || {};
    fn(data[slug]);
    writeJSONAtomic(this.inputPath, data);
  }

  setNeed(slug, needId, fields) {
    this.update(slug, (e) => {
      e.needs = e.needs || {};
      e.needs[needId] = Object.assign(e.needs[needId] || {}, fields);
    });
  }

  doc(slug, name) {
    if (!SLUG_RE.test(String(slug))) return null;
    let p;
    if (!name) p = path.join(this.root, "applications", `${slug}.md`);
    else if (DOC_NAME_RE.test(name)) p = path.join(this.root, "applications", "files", slug, name);
    else return null;
    try {
      return fs.readFileSync(p, "utf8");
    } catch {
      return null;
    }
  }

  screenshotPath(rec) {
    const shot = String((rec && rec.screenshot) || "");
    if (!shot) return null;
    const dir = path.resolve(this.root, "screenshots");
    const p = path.resolve(this.root, shot);
    if (!p.startsWith(dir + path.sep) || !/\.(jpe?g|png)$/i.test(p) || !fs.existsSync(p)) return null;
    return p;
  }

  packageDir(slug) {
    if (!SLUG_RE.test(String(slug))) return null;
    const p = path.join(this.root, "applications", "files", slug);
    return fs.existsSync(p) ? p : null;
  }

  // Copies a file the owner picked into data/docs/ under a safe name, and records it on the need.
  saveUpload(slug, needId, srcPath) {
    const base = path.basename(srcPath).replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^[-.]+|[-.]+$/g, "");
    if (!UPLOAD_RE.test(base)) return { ok: false, error: "Choose a PDF, Word, Excel, CSV, image or text file." };
    const size = fs.statSync(srcPath).size;
    if (!size || size > MAX_UPLOAD) return { ok: false, error: "That file is empty or larger than 50 MB." };
    const docs = path.join(this.root, "data", "docs");
    fs.mkdirSync(docs, { recursive: true });
    const dest = path.join(docs, `${slug}-${base}`);
    fs.copyFileSync(srcPath, dest);
    const rel = path.relative(this.root, dest);
    this.setNeed(slug, needId, { file: rel, answered_at: now() });
    return { ok: true, file: rel, name: base };
  }
}

module.exports = { Store, isGrantsFolder, nextRun, now, localDate, writeJSONAtomic, SLUG_RE, NEED_RE, MAX_ANSWER, OWNER_FIELDS };
