// A throwaway grants folder filled with made-up applications, so the app can be seen before setup.
const fs = require("fs");
const os = require("os");
const path = require("path");
const { localDate, now } = require("./store");

function createDemoRoot() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "queenbee-demo-"));
  for (const d of ["applications/files", "config", "state", "screenshots", "scripts"]) {
    fs.mkdirSync(path.join(root, d), { recursive: true });
  }
  // The two markers that make a folder a grants folder.
  fs.writeFileSync(path.join(root, "CLAUDE.md"), "Demo folder.\n");
  fs.writeFileSync(path.join(root, "scripts", "grant_docs.py"), "# demo\n");

  const day = (n) => localDate(new Date(Date.now() + n * 86400000));
  const ago = (n) => now(new Date(Date.now() - n * 86400000));
  const write = (rel, data) =>
    fs.writeFileSync(path.join(root, rel), typeof data === "string" ? data : JSON.stringify(data, null, 1));

  write("config/profile.json", { business: { legal_name: "Sample Business LLC" } });
  write("config/settings.json", { submission: { mode: "auto" }, schedule: { frequency: "weekly", hour: 9 } });

  const records = [
    {
      slug: "sample-community-fund-small-business-2026", funder: "Sample Community Fund", program: "Small Business Grant",
      tier: "A", status: "NEEDS HUMAN", deadline: day(24), award_max_usd: 10000, amount_requested_usd: 10000,
      url: "https://example.org/grant",
      summary: "A county grant for equipment and training. Everything is filled except two answers.",
      needs: [
        { id: "headcount", kind: "question",
          ask: "How many people did the business employ on January 1 of this year, full-time and part-time?",
          why: "The form asks for headcount on that date, and your files only give today's number." },
        { id: "w9", kind: "document", ask: "Upload the business's W-9.", why: "The program requires it with the application." },
      ],
    },
    {
      slug: "sample-bank-women-owned-grant-2026", funder: "Sample Bank Foundation", program: "Women-Owned Business Grant",
      tier: "A", status: "FOR YOU", deadline: day(9), award_max_usd: 5000, amount_requested_usd: 5000,
      url: "https://example.org/bank", summary: "Written and ready, but the form ends with a typed signature.",
      needs: [
        { id: "signature", kind: "signature", ask: "Open the form and type your signature at the end, then press Submit.",
          why: "A signature is you signing for the business, so the agent leaves it to you." },
      ],
    },
    {
      slug: "sample-state-workforce-training-2026", funder: "Sample State Commerce Dept.", program: "Workforce Training Grant",
      tier: "B", status: "PACKAGE READY", deadline: day(38), award_max_usd: 25000, amount_requested_usd: 18400,
      url: "https://example.gov/training",
      summary: "A state package for training two employees. The checklist lists the steps left for you.",
    },
    {
      slug: "sample-local-arts-fund-2026", funder: "Sample Arts Council", program: "Creative Business Grant",
      tier: "A", status: "READY FOR APPROVAL", deadline: day(17), award_max_usd: 3000, amount_requested_usd: 3000,
      url: "https://example.org/arts", summary: "A small grant for signage and a new website. Written and waiting for your OK.",
    },
    {
      slug: "sample-utility-main-street-2026", funder: "Sample Electric Co.", program: "Main Street Grant",
      tier: "A", status: "SUBMITTED", deadline: day(-6), submitted_at: ago(12), award_max_usd: 2500,
      amount_requested_usd: 2500, url: "https://example.com/main-street", summary: "A grant for storefront improvements.",
    },
    {
      slug: "sample-foundation-growth-2026", funder: "Sample Family Foundation", program: "Growth Grant",
      tier: "A", status: "SUBMITTED", deadline: day(-40), submitted_at: ago(45), award_max_usd: 15000,
      amount_requested_usd: 15000, url: "https://example.org/growth", summary: "A grant toward new equipment.",
    },
    {
      slug: "sample-national-accelerator-2027", funder: "Sample National Network", program: "Spring Grants",
      tier: "A", status: "WATCH", deadline: "", opens: day(70), award_max_usd: 20000,
      url: "https://example.org/spring", summary: "Opens in the spring. The agent will check back then.",
    },
    {
      slug: "sample-research-grant-2026", funder: "Sample Federal Agency", program: "Research Grant",
      tier: "B", status: "SKIP", deadline: day(30), url: "https://example.gov/research", summary: "Only universities can apply.",
    },
  ];
  for (const r of records) {
    r.updated_at = ago(1);
    write(`applications/${r.slug}.json`, r);
    write(
      `applications/${r.slug}.md`,
      `# ${r.funder}, ${r.program}\n\n- Deadline: ${r.deadline || "not set"}\n\n## Describe your business\n` +
        "This is sample text. In a real run, every answer the agent wrote appears here.\n"
    );
  }
  const pkg = path.join(root, "applications", "files", "sample-state-workforce-training-2026");
  fs.mkdirSync(pkg);
  fs.writeFileSync(
    path.join(pkg, "CHECKLIST.md"),
    `**Deadline: ${day(38)}**\n\n1. Sign in to the state grants portal.\n2. Upload narrative.md and budget.md.\n` +
      "3. Upload the W-9 and last year's financial statements.\n4. Sign and submit.\n"
  );
  write("config/owner-input.json", {
    "sample-foundation-growth-2026": { outcome: "AWARDED", outcome_amount_usd: 7500, outcome_at: ago(10) },
  });
  // What the grant-results agent would have read in the owner's inbox.
  write("state/email-findings.json", {
    inbox_checked_at: ago(0),
    findings: [
      { id: "f-0a1b2c3d4e5f", slug: "sample-utility-main-street-2026", kind: "AWARDED", amount_usd: 2500, reply_by: "",
        summary: "Sample Electric Co. says you won the $2,500 Main Street Grant.",
        quote: "We are delighted to let you know that your business has been selected to receive a $2,500 Main Street Grant.",
        from: "Community Programs <grants@example.com>", subject: "Your Main Street Grant application", date: ago(1) },
      { id: "f-1b2c3d4e5f60", slug: "sample-foundation-growth-2026", kind: "NEEDS_REPLY", amount_usd: null, reply_by: day(6),
        summary: "Sample Family Foundation needs your signed award agreement before they send the money.",
        quote: "Please sign and return the attached award agreement so we can release your funds.",
        from: "Sample Family Foundation <awards@example.org>", subject: "Award agreement", date: ago(3) },
      { id: "f-2c3d4e5f6071", slug: "sample-foundation-growth-2026", kind: "UPDATE", amount_usd: null, reply_by: "",
        summary: "Sample Family Foundation said your application reached the final round.",
        quote: "Your application has advanced to our final review round.",
        from: "Sample Family Foundation <awards@example.org>", subject: "Application update", date: ago(20) },
    ],
  });
  write("state/last_run.json", { finished_at: ago(2), submitted: 1, drafted: 2, needs_you: 3, note: "Checked 31 programs." });
  return root;
}

module.exports = { createDemoRoot };
