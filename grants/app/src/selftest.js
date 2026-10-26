// Plain-node checks for the rules the app depends on: npm run check.
const assert = require("assert");
const fs = require("fs");
const path = require("path");
const { Store, isGrantsFolder, nextRun, runActive } = require("./store");
const { createDemoRoot } = require("./demo");

const root = createDemoRoot();
try {
  const store = new Store(root);
  assert.ok(isGrantsFolder(root), "demo folder is a grants folder");
  assert.ok(!isGrantsFolder(path.dirname(root)), "a random folder is not");

  let s = store.state();
  assert.strictEqual(s.business, "Sample Business LLC");
  assert.strictEqual(s.applications.length, 8);
  const growth = s.applications.find((a) => a.slug === "sample-foundation-growth-2026");
  assert.strictEqual(growth.outcome, "AWARDED", "owner results come through");

  // A record cannot approve itself or claim a result: those fields come only from owner-input.json.
  const forged = path.join(root, "applications", "sample-utility-main-street-2026.json");
  const rec = JSON.parse(fs.readFileSync(forged, "utf8"));
  Object.assign(rec, { approved_at: "2026-01-01T00:00", outcome: "AWARDED", needs: [{ id: "bad id'", kind: "question", ask: "x" }] });
  fs.writeFileSync(forged, JSON.stringify(rec));
  s = store.state();
  const main = s.applications.find((a) => a.slug === "sample-utility-main-street-2026");
  assert.strictEqual(main.approved_at, undefined, "forged approval ignored");
  assert.strictEqual(main.outcome, undefined, "forged outcome ignored");
  assert.strictEqual(main.needs.length, 0, "malformed need id dropped");

  // Owner answers land in owner-input.json and merge back onto the need.
  assert.ok(store.hasNeed("sample-community-fund-small-business-2026", "headcount"));
  assert.ok(!store.hasNeed("sample-community-fund-small-business-2026", "nope"));
  store.setNeed("sample-community-fund-small-business-2026", "headcount", { answer: "3 and 1", answered_at: "2026-10-21T10:00" });
  const need = store.state().applications
    .find((a) => a.slug === "sample-community-fund-small-business-2026").needs.find((n) => n.id === "headcount");
  assert.strictEqual(need.answer, "3 and 1");

  // Paths stay inside the grants folder.
  assert.strictEqual(store.doc("sample-state-workforce-training-2026", "../../config/profile.json"), null);
  assert.strictEqual(store.doc("../config", null), null);
  assert.ok(store.doc("sample-state-workforce-training-2026", "CHECKLIST.md").includes("Deadline"));
  assert.strictEqual(store.screenshotPath({ screenshot: "config/profile.json" }), null);
  assert.strictEqual(store.screenshotPath({ screenshot: "screenshots/../config/x.jpg" }), null);

  // Uploads: only document types, copied under data/docs/.
  const exe = path.join(root, "evil.sh");
  fs.writeFileSync(exe, "echo hi");
  assert.strictEqual(store.saveUpload("sample-community-fund-small-business-2026", "w9", exe).ok, false);
  const pdf = path.join(root, "My W-9 (2026).pdf");
  fs.writeFileSync(pdf, "%PDF-1.4 demo");
  const up = store.saveUpload("sample-community-fund-small-business-2026", "w9", pdf);
  assert.ok(up.ok && up.file.startsWith("data/docs/"), "upload saved under data/docs");

  // Schedule: weekly at 9 lands on a Monday 09:00 after now.
  const nr = nextRun({ frequency: "weekly", hour: 9 }, new Date(2026, 9, 21, 12, 0));
  assert.strictEqual(nr, "2026-10-26T09:00");
  assert.strictEqual(nextRun({ frequency: "manual" }), null);

  // Funder emails: well-formed findings attach to their application; a forged one is dropped;
  // confirming or dismissing goes to owner-input.json.
  s = store.state();
  const util = s.applications.find((a) => a.slug === "sample-utility-main-street-2026");
  assert.strictEqual(util.email.length, 1);
  assert.strictEqual(util.email[0].kind, "AWARDED");
  assert.ok(s.inbox_checked_at, "inbox time shown");
  const ef = path.join(root, "state", "email-findings.json");
  const data = JSON.parse(fs.readFileSync(ef, "utf8"));
  data.findings.push({ id: "f-<script>", slug: "sample-utility-main-street-2026", kind: "AWARDED", summary: "x" });
  data.findings.push({ id: "f-aaaaaaaaaaaa", slug: "sample-utility-main-street-2026", kind: "PAID_IN_FULL", summary: "x" });
  fs.writeFileSync(ef, JSON.stringify(data));
  assert.strictEqual(store.state().applications.find((a) => a.slug === "sample-utility-main-street-2026").email.length, 1,
    "malformed findings dropped");
  assert.ok(store.finding("sample-utility-main-street-2026", "f-0a1b2c3d4e5f"));
  assert.strictEqual(store.finding("sample-foundation-growth-2026", "f-0a1b2c3d4e5f"), null, "finding belongs to its own slug");
  store.setFinding("sample-foundation-growth-2026", "f-1b2c3d4e5f60", { confirmed_at: "2026-10-21T10:00" });
  const growthNow = store.state().applications.find((a) => a.slug === "sample-foundation-growth-2026");
  assert.strictEqual(growthNow.email.find((f) => f.id === "f-1b2c3d4e5f60").confirmed_at, "2026-10-21T10:00");

  // Run detection: a live process id counts, a dead one (a crashed run) does not.
  const lock = path.join(root, ".run.lock");
  fs.writeFileSync(lock, String(process.pid));
  assert.strictEqual(runActive(lock), true, "live run detected");
  fs.writeFileSync(lock, "999999");
  assert.strictEqual(runActive(lock), false, "stale lock ignored");
  fs.rmSync(lock);
  assert.strictEqual(runActive(lock), false, "no lock, no run");

  // Setup: what the owner enters becomes the agent's files, word for word, and nothing else.
  const Setup = require("./setup");
  const blank = createDemoRoot({ blank: true });
  try {
    const d = Setup.normalize({
      owner: { first_name: "Ann", last_name: "Lee", email: "ann@example.com" },
      business: { legal_name: "Sample Shop LLC", state: "OH", revenue: "182,400", revenue_year: "2025", certifications: "WOSB, SBA, certified 2025-03-01" },
      demographics: { woman_owned: "yes" },
      story: { one_line: "We make cabinets." },
      money: { projects: [{ name: "Saw", items: [{ item: "Panel saw", amount: "$12,500" }, { item: "Install", amount: "about 800" }] }] },
      targets: { keywords: "cabinets, equipment", skip_funders: "Smith, Jones & Co." },
      sending: { mode: "approve" },
      not_a_field: { x: 1 },
    }, Setup.defaults());
    assert.strictEqual(d.not_a_field, undefined, "unknown fields dropped");
    assert.deepStrictEqual(Setup.review(d).blocking, [], "minimal setup is enough to start");
    assert.ok(Setup.review(Setup.defaults()).blocking.some((b) => b.step === "money"), "no priced project blocks");
    Setup.writeAgentFiles(blank, d);
    const prof = JSON.parse(fs.readFileSync(path.join(blank, "config", "profile.json"), "utf8"));
    const sett = JSON.parse(fs.readFileSync(path.join(blank, "config", "settings.json"), "utf8"));
    const ans = fs.readFileSync(path.join(blank, "config", "answers.md"), "utf8");
    assert.strictEqual(prof.ownership_demographics.woman_owned_51pct, "Yes");
    assert.strictEqual(prof.ownership_demographics.veteran_owned, "", "unanswered stays empty, never No");
    assert.deepStrictEqual(prof.business.certifications, ["WOSB, SBA, certified 2025-03-01"], "a line with commas stays one entry");
    assert.strictEqual(sett.submission.mode, "approve");
    assert.deepStrictEqual(sett.targets.skip_funders, ["Smith, Jones & Co."]);
    assert.deepStrictEqual(sett.targets.keywords, ["cabinets", "equipment"]);
    assert.ok(!/One or two sentences/.test(sett.targets.fit_note), "the template's example fit note is not kept");
    assert.ok(ans.includes("  - Panel saw: $12,500\n  - Total: $12,500"), "budget lines in the format grant_docs.py reads");
    assert.ok(!ans.includes("about 800"), "a price that isn't a number is left out");
    assert.ok(ans.includes("- Revenue: $182,400 in fiscal year 2025."), "revenue copied as typed");
    // Setting up in a chat first: the app keeps what it can't place, and backs up the old file.
    fs.writeFileSync(path.join(blank, "config", "answers.md"), "# Mine\n\n## The owner's story\nI began in 2019.\n\n## Awards\nBest of Dayton.\n");
    fs.rmSync(path.join(blank, "config", "setup.json"), { force: true });
    const imported = Setup.load(blank);
    assert.strictEqual(imported.story.owner_story, "I began in 2019.");
    assert.ok(imported.story.extra.includes("Best of Dayton."), "unknown sections kept");
    assert.strictEqual(imported.business.legal_name, "Sample Shop LLC");
    Setup.writeAgentFiles(blank, imported);
    assert.ok(fs.readdirSync(path.join(blank, "config", "backup")).length === 1, "hand-written answers.md backed up");
    assert.ok(fs.readFileSync(path.join(blank, "config", "answers.md"), "utf8").includes("Best of Dayton."));
    // Document paths only ever point inside data/docs.
    const forged = Setup.normalize({}, Object.assign(Setup.defaults(), { documents: { w9: "../../etc/passwd", photos: ["data/docs/a.png", "/tmp/x.png"] } }));
    assert.strictEqual(forged.documents.w9, "");
    assert.deepStrictEqual(forged.documents.photos, ["data/docs/a.png"]);
    // The email agent's settings point back at this folder.
    const results = path.join(blank, "..", "results-x");
    fs.mkdirSync(path.join(results, "config"), { recursive: true });
    const rs = Setup.buildResultsSettings(Object.assign(Setup.defaults(), { mail: Object.assign(Setup.defaults().mail, { address: "a@gmail.com", provider: "gmail", spam_folder: "yes" }) }), {}, results, blank);
    assert.strictEqual(path.resolve(results, rs.grants_folder), path.resolve(blank));
    assert.deepStrictEqual(rs.mail.folders, ["INBOX", "[Gmail]/Spam"]);
    assert.strictEqual(rs.mail.imap_host, "imap.gmail.com");
    fs.rmSync(results, { recursive: true, force: true });
  } finally {
    fs.rmSync(blank, { recursive: true, force: true });
  }

  console.log("selftest OK");
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}
