// Plain-node checks for the rules the app depends on: npm run check.
const assert = require("assert");
const fs = require("fs");
const path = require("path");
const { Store, isGrantsFolder, nextRun } = require("./store");
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
  assert.ok(up.ok && up.file.startsWith(path.join("data", "docs")), "upload saved under data/docs");

  // Schedule: weekly at 9 lands on a Monday 09:00 after now.
  const nr = nextRun({ frequency: "weekly", hour: 9 }, new Date(2026, 9, 21, 12, 0));
  assert.strictEqual(nr, "2026-10-26T09:00");
  assert.strictEqual(nextRun({ frequency: "manual" }), null);

  console.log("selftest OK");
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}
