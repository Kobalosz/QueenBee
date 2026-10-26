// Setup in the app instead of a chat. Everything the owner enters is kept in config/setup.json, and
// from it this module writes the files the agents read:
//   config/profile.json, config/answers.md, config/settings.json   the grants agent
//   ../grant-results/config/settings.json                           the email agent, when turned on
// Values are written exactly as the owner typed them: nothing here guesses or fills in a fact.
// No Electron in here, so src/selftest.js can test it with plain node.
const fs = require("fs");
const path = require("path");
const { writeJSONAtomic, now, localDate } = require("./store");

const STEPS = [
  "welcome", "business", "details", "ownership", "nonprofit", "story", "money",
  "facts", "documents", "targets", "sending", "email", "finish",
];
const T = 300; // a short answer
const L = 6000; // a paragraph or a list

// Every field the setup keeps, with its longest allowed length. Anything else is dropped.
const SHAPE = {
  owner: { first_name: T, last_name: T, title: T, email: T, phone: T, ownership_percent: T, years_experience: T },
  business: {
    legal_name: T, dba: T, entity_type: T, state_of_formation: T, year_founded: T, website: T,
    industry_description: L, naics: T, street: T, city: T, county: T, state: T, zip: T, home_based: T, rural: T,
    full_time: T, part_time: T, employees_as_of: T, revenue: T, revenue_year: T, fiscal_year_end: T,
    ein: T, uei: T, sam_registration: T, sam_active_until: T, certifications: L,
  },
  demographics: { woman_owned: T, minority_owned: T, veteran_owned: T, disability_owned: T, lgbtq_owned: T, race_ethnicity: T, gender: T },
  nonprofit: {
    has: T, apply: T, legal_name: T, ein: T, irs_status: T, fiscal_sponsor_name: T, fiscal_sponsor_ein: T,
    year_incorporated: T, operating_budget: T, board_count: T, volunteers: T, people_served: T, address: T,
    website: T, mission: L,
  },
  story: { one_line: T * 2, short: L, standard: L, owner_story: L, products: L, customers: L, challenges: L, voice_sample: L, extra: L * 4 },
  money: { need: L, impact: L, sustainability: L },
  facts: { extra: L, tax_liens: T, matching_funds: T, matching_detail: T, publicity: T, site_visit: T, federal_funds: T, how_heard: T },
  targets: {
    keywords: L, min_award: T, national: T, state: T, local: T, federal: T, fit_note: L,
    priority_funders: L, skip_funders: L, vote_contests: T,
  },
  sending: { mode: T, max_fee: T, typed_signature: T, checkbox_cert: T },
  mail: { enabled: T, address: T, provider: T, imap_host: T, spam_folder: T },
  schedule: { frequency: T, hour: T, mail_frequency: T, mail_hour: T },
};
// Fields only this process sets (uploads, the password check, completion), never the window.
const DOC_KEYS = [
  "w9", "financial_statements", "tax_returns_most_recent", "business_plan", "business_license",
  "budget_spreadsheet", "irs_determination_letter", "board_list", "logo", "owner_headshot",
];
const DOC_RE = /^data\/docs\/[A-Za-z0-9._-]{1,160}$/;
const FREQUENCIES = ["manual", "daily", "weekdays", "twice-weekly", "weekly"];
const PROVIDERS = {
  gmail: "imap.gmail.com",
  icloud: "imap.mail.me.com",
  yahoo: "imap.mail.yahoo.com",
};
const MARKER = "<!-- Written by the Grants app from what the owner entered in setup.";

function defaults() {
  const d = {};
  for (const [group, fields] of Object.entries(SHAPE)) {
    d[group] = {};
    for (const k of Object.keys(fields)) d[group][k] = "";
  }
  Object.assign(d.demographics, { race_ethnicity: "Decline to self-identify", gender: "Decline to self-identify" });
  Object.assign(d.facts, { how_heard: "Online search" });
  Object.assign(d.targets, { min_award: "1000", national: "yes", state: "yes", local: "yes", federal: "yes", vote_contests: "no" });
  Object.assign(d.sending, { mode: "auto", max_fee: "0", typed_signature: "no", checkbox_cert: "yes" });
  Object.assign(d.schedule, { frequency: "weekly", hour: "9", mail_frequency: "daily", mail_hour: "8" });
  d.money.projects = [];
  d.documents = { photos: [], pitch_video_url: "" };
  for (const k of DOC_KEYS) d.documents[k] = "";
  d.mail.password_saved_at = "";
  d.mail.check = "";
  d.done = [];
  d.version = 1;
  d.completed_at = "";
  d.updated_at = "";
  return d;
}

const str = (v, max) => String(v ?? "").replace(/\r\n?/g, "\n").slice(0, max);

// What the window sent, cut down to the known fields and lengths. `stored` keeps the fields only
// this process may set.
function normalize(input, stored) {
  const src = input && typeof input === "object" ? input : {};
  const base = stored || defaults();
  const d = defaults();
  for (const [group, fields] of Object.entries(SHAPE)) {
    const g = src[group] && typeof src[group] === "object" ? src[group] : {};
    const was = base[group] || {};
    for (const [k, max] of Object.entries(fields)) d[group][k] = str(g[k] !== undefined ? g[k] : was[k] !== undefined ? was[k] : d[group][k], max);
  }
  const projects = Array.isArray((src.money || {}).projects) ? src.money.projects : [];
  d.money.projects = projects.slice(0, 8).map((p) => ({
    name: str(p && p.name, T), buys: str(p && p.buys, L), cost_source: str(p && p.cost_source, T), outcome: str(p && p.outcome, L),
    items: (Array.isArray(p && p.items) ? p.items : []).slice(0, 25).map((i) => ({ item: str(i && i.item, T), amount: str(i && i.amount, 40) })),
  }));
  const docs = base.documents || {};
  for (const k of DOC_KEYS) d.documents[k] = DOC_RE.test(String(docs[k] || "")) ? docs[k] : "";
  d.documents.photos = (Array.isArray(docs.photos) ? docs.photos : []).filter((x) => DOC_RE.test(String(x))).slice(0, 12);
  d.documents.pitch_video_url = str((src.documents || {}).pitch_video_url ?? docs.pitch_video_url ?? "", T);
  for (const k of ["password_saved_at", "check"]) d.mail[k] = (base.mail || {})[k] || "";
  d.done = (Array.isArray(src.done) ? src.done : base.done || []).filter((s) => STEPS.includes(s));
  d.done = [...new Set(d.done)];
  d.completed_at = base.completed_at || "";
  d.updated_at = now();
  return d;
}

// ── Reading what is already there ────────────────────────────────────────────────
function readJSON(p) {
  try {
    return JSON.parse(fs.readFileSync(p, "utf8"));
  } catch {
    return null;
  }
}

const setupPath = (root) => path.join(root, "config", "setup.json");

// The setup as last saved; or, for a folder set up in a Claude Code chat, the setup rebuilt from
// the files that chat wrote; or a blank one.
function load(root) {
  const saved = readJSON(setupPath(root));
  if (saved && typeof saved === "object") {
    const d = normalize(saved, Object.assign(defaults(), saved));
    d.updated_at = saved.updated_at || "";
    return d;
  }
  if (fs.existsSync(path.join(root, "config", "profile.json"))) return importExisting(root);
  return defaults();
}

function save(root, d) {
  writeJSONAtomic(setupPath(root), d);
}

const yn = (v) => (/^y(es)?$/i.test(String(v || "").trim()) ? "yes" : /^no?$/i.test(String(v || "").trim()) ? "no" : "");
// A list the owner typed: `rows` is one per line (names, certifications, facts may hold commas);
// `list` also splits on commas (keywords, NAICS codes).
const rows = (v) => (Array.isArray(v) ? v : String(v || "").split("\n")).map((s) => String(s).trim()).filter(Boolean);
const list = (v) => rows(v).flatMap((s) => s.split(",")).map((s) => s.trim()).filter(Boolean);

function importExisting(root) {
  const d = defaults();
  const p = readJSON(path.join(root, "config", "profile.json")) || {};
  const s = readJSON(path.join(root, "config", "settings.json")) || {};
  const o = p.owner || {}, b = p.business || {}, dem = p.ownership_demographics || {}, np = p.nonprofit || {};
  Object.assign(d.owner, {
    first_name: o.first_name || "", last_name: o.last_name || "", title: o.title || "", email: o.email || "",
    phone: o.phone || "", ownership_percent: o.ownership_percent || "", years_experience: o.years_experience_in_industry || "",
  });
  const sam = String(b.sam_registration || "");
  Object.assign(d.business, {
    legal_name: b.legal_name || "", dba: b.dba || "", entity_type: b.entity_type || "", state_of_formation: b.state_of_formation || "",
    year_founded: b.year_founded || "", website: b.website || "", industry_description: b.industry_description || "",
    naics: list(b.naics_codes).join(", "), street: b.business_address_street || "", city: b.business_address_city || "",
    county: b.business_address_county || "", state: b.business_address_state || "", zip: b.business_address_zip || "",
    home_based: yn(b.home_based), rural: yn(b.rural), full_time: b.full_time_employees || "", part_time: b.part_time_employees || "",
    employees_as_of: b.employees_as_of || "", revenue: b.annual_revenue_last_fiscal_year || "", revenue_year: b.annual_revenue_year || "",
    fiscal_year_end: b.fiscal_year_end || "", ein: b.ein || "", uei: b.uei || "",
    sam_registration: /^active/i.test(sam) ? "active" : /progress/i.test(sam) ? "in progress" : /^none/i.test(sam) ? "none" : "",
    sam_active_until: (sam.match(/\d{4}-\d{2}-\d{2}/) || [""])[0], certifications: rows(b.certifications).join("\n"),
  });
  Object.assign(d.demographics, {
    woman_owned: yn(dem.woman_owned_51pct), minority_owned: yn(dem.minority_owned_51pct), veteran_owned: yn(dem.veteran_owned),
    disability_owned: yn(dem.disability_owned), lgbtq_owned: yn(dem.lgbtq_owned),
    race_ethnicity: dem.race_ethnicity || d.demographics.race_ethnicity, gender: dem.gender || d.demographics.gender,
  });
  const t = s.targets || {}, sub = s.submission || {}, sch = s.schedule || {};
  Object.assign(d.nonprofit, {
    has: np.enabled ? "yes" : "no", apply: (t.apply_as || []).includes("nonprofit") ? "yes" : "no", legal_name: np.legal_name || "",
    ein: np.ein || "", irs_status: np.irs_status || "", fiscal_sponsor_name: np.fiscal_sponsor_name || "",
    fiscal_sponsor_ein: np.fiscal_sponsor_ein || "", year_incorporated: np.year_incorporated || "",
    operating_budget: np.annual_operating_budget || "", board_count: np.board_members_count || "", volunteers: np.volunteers_count || "",
    people_served: np.people_served_last_year || "", address: np.address_full || "", website: np.website || "",
  });
  const docs = p.documents || {};
  for (const k of DOC_KEYS) d.documents[k] = DOC_RE.test(String(docs[k] || "")) ? docs[k] : "";
  d.documents.photos = (Array.isArray(docs.photos) ? docs.photos : []).filter((x) => DOC_RE.test(String(x)));
  d.documents.pitch_video_url = docs.pitch_video_url || "";
  const pre = p.presets || {};
  Object.assign(d.facts, { how_heard: pre.how_did_you_hear || d.facts.how_heard, federal_funds: yn(pre.currently_receiving_federal_funds) });
  Object.assign(d.targets, {
    keywords: list(t.keywords).join(", "), min_award: t.min_award_usd != null ? String(t.min_award_usd) : d.targets.min_award,
    national: t.include_national === false ? "no" : "yes", state: t.include_state === false ? "no" : "yes",
    local: t.include_local === false ? "no" : "yes", federal: (t.federal || {}).enabled === false ? "no" : "yes",
    fit_note: /^One or two sentences/.test(t.fit_note || "") ? "" : t.fit_note || "",
    priority_funders: rows(t.priority_funders).join("\n"), skip_funders: rows(t.skip_funders).join("\n"),
    vote_contests: t.allow_public_vote_contests ? "yes" : "no",
  });
  Object.assign(d.sending, {
    mode: sub.mode === "approve" ? "approve" : "auto", max_fee: String(sub.max_application_fee_usd ?? 0),
    typed_signature: sub.allow_typed_signature ? "yes" : "no", checkbox_cert: sub.allow_checkbox_certification === false ? "no" : "yes",
  });
  if (FREQUENCIES.includes(sch.frequency)) d.schedule.frequency = sch.frequency;
  if (Number.isInteger(sch.hour)) d.schedule.hour = String(sch.hour);
  importAnswers(d, readText(path.join(root, "config", "answers.md")));
  d.done = STEPS.slice(0, -1);
  d.completed_at = now();
  return d;
}

function readText(p) {
  try {
    return fs.readFileSync(p, "utf8");
  } catch {
    return "";
  }
}

// The sections of answers.md, by "## " heading.
function sections(md) {
  const out = [];
  let cur = null;
  for (const line of String(md).split(/\r?\n/)) {
    const m = line.match(/^##\s+(.*)/);
    if (m) out.push((cur = { head: m[1].trim(), body: [] }));
    else if (cur) cur.body.push(line);
  }
  return out.map((s) => ({ head: s.head, body: s.body.join("\n").trim() }));
}

const EMPTY = /^(_(Not provided yet|None given|No facts yet|No projects yet)[^\n]*_|Not answered yet[^\n]*|\[[^\]]*\])$/;
const clean = (s) => (EMPTY.test(String(s).trim()) ? "" : String(s).trim());

// Best effort for an answers.md written in a chat: known sections go to their fields, anything
// else is kept word for word in story.extra, so saving from the app never loses it.
function importAnswers(d, md) {
  if (!md.trim()) return;
  const extra = [];
  for (const { head, body } of sections(md)) {
    const h = head.toLowerCase();
    const bullet = (label) => {
      const m = body.match(new RegExp(`^- \\*\\*${label}[^*]*:\\*\\*\\s*(.*)$`, "im"));
      return m ? clean(m[1]) : "";
    };
    if (h.startsWith("writing style") || h.startsWith("things the agent must refuse")) continue;
    if (h.startsWith("boilerplate")) {
      d.story.one_line = bullet("One line");
      d.story.short = bullet("Short");
      d.story.standard = bullet("Standard");
      d.nonprofit.mission = bullet("Nonprofit mission");
    } else if (h.startsWith("the owner's story")) d.story.owner_story = clean(body);
    else if (h.startsWith("products")) {
      const [products, ...rest] = body.split(/\n\s*\n/);
      d.story.products = clean(products || "");
      d.story.customers = clean(rest.join("\n\n"));
    } else if (h.startsWith("need statement")) d.money.need = clean(body);
    else if (h.startsWith("use of funds")) d.money.projects = importPresets(body);
    else if (h.startsWith("impact")) d.money.impact = clean(body);
    else if (h.startsWith("sustainability")) d.money.sustainability = clean(body);
    else if (h.startsWith("challenges")) d.story.challenges = clean(body);
    else if (h.startsWith("voice sample")) d.story.voice_sample = clean(body);
    else if (h.startsWith("fact sheet")) {
      d.facts.extra = body.split("\n").filter((l) => /^- /.test(l) && !/^- (Founded|Revenue|Employees): /.test(l) && !EMPTY.test(l.slice(2).trim()))
        .map((l) => l.slice(2).trim()).join("\n");
    } else if (h.startsWith("preset answers")) {
      const pick = (label) => {
        const m = body.match(new RegExp(`^- ${label}[^:]*:\\s*(.*)$`, "im"));
        return m ? m[1].trim() : "";
      };
      d.facts.tax_liens = yn(pick("Any outstanding tax liens"));
      const match = pick("Matching funds available");
      d.facts.matching_funds = yn(match.split(/[,\s]/)[0]);
      d.facts.matching_detail = d.facts.matching_funds === "yes" ? match.replace(/^yes[,\s]*/i, "") : "";
      d.facts.publicity = yn(pick("Willing to be featured"));
      d.facts.site_visit = yn(pick("Willing to participate"));
    } else extra.push(`## ${head}\n${body}`);
  }
  d.story.extra = extra.join("\n\n").slice(0, SHAPE.story.extra);
}

function importPresets(body) {
  return body.split(/^###\s+/m).slice(1).map((block) => {
    const [head, ...rest] = block.split("\n");
    const text = rest.join("\n");
    const field = (label) => {
      const m = text.match(new RegExp(`^- ${label}:\\s*(.*)$`, "im"));
      return m ? clean(m[1]) : "";
    };
    const items = [];
    for (const m of text.matchAll(/^\s{2,}[-*]\s+(.+?):\s*\$?([\d,]+(?:\.\d{1,2})?)\s*$/gm)) {
      if (!/^total$/i.test(m[1].trim())) items.push({ item: m[1].trim(), amount: m[2] });
    }
    return {
      name: head.replace(/^Preset\s*\d*:\s*/i, "").trim(), buys: field("What it buys"),
      cost_source: field("Cost").replace(/^\$[\d,.]+,?\s*(from\s+)?/i, ""), outcome: field("What changes when it is funded"), items,
    };
  }).slice(0, 8);
}

// ── Money ────────────────────────────────────────────────────────────────────────
function amount(v) {
  const t = String(v ?? "").replace(/[$,\s]/g, "");
  if (!/^\d+(\.\d{1,2})?$/.test(t)) return null;
  return Number(t);
}
function dollars(n) {
  const whole = Number.isInteger(n);
  return "$" + n.toLocaleString("en-US", { minimumFractionDigits: whole ? 0 : 2, maximumFractionDigits: 2 });
}
function projectTotal(p) {
  const vals = p.items.map((i) => amount(i.amount)).filter((n) => n !== null);
  return vals.length ? Math.round(vals.reduce((a, b) => a + b, 0) * 100) / 100 : 0;
}

// ── Writing the agent's files ────────────────────────────────────────────────────
const YES_NO = { yes: "Yes", no: "No" };
const sayYN = (v) => YES_NO[v] || "";

function buildProfile(d, base) {
  const p = JSON.parse(JSON.stringify(base || {}));
  const o = d.owner, b = d.business, dem = d.demographics, np = d.nonprofit;
  p.owner = Object.assign(p.owner || {}, {
    first_name: o.first_name, last_name: o.last_name, legal_name: [o.first_name, o.last_name].filter(Boolean).join(" "),
    title: o.title, email: o.email, phone: o.phone, ownership_percent: o.ownership_percent, years_experience_in_industry: o.years_experience,
  });
  p.ownership_demographics = Object.assign(p.ownership_demographics || {}, {
    woman_owned_51pct: sayYN(dem.woman_owned), minority_owned_51pct: sayYN(dem.minority_owned), veteran_owned: sayYN(dem.veteran_owned),
    disability_owned: sayYN(dem.disability_owned), lgbtq_owned: sayYN(dem.lgbtq_owned),
    race_ethnicity: dem.race_ethnicity || "Decline to self-identify", gender: dem.gender || "Decline to self-identify",
  });
  const sam = b.sam_registration === "active" ? `active${b.sam_active_until ? " until " + b.sam_active_until : ""}` : b.sam_registration;
  const cityLine = [b.city, [b.state, b.zip].filter(Boolean).join(" ")].filter(Boolean).join(", ");
  p.business = Object.assign(p.business || {}, {
    enabled: true, legal_name: b.legal_name, dba: b.dba, entity_type: b.entity_type, state_of_formation: b.state_of_formation,
    year_founded: b.year_founded, ein: b.ein, uei: b.uei, sam_registration: sam, naics_codes: list(b.naics),
    industry_description: b.industry_description, full_time_employees: b.full_time, part_time_employees: b.part_time,
    employees_as_of: b.employees_as_of, annual_revenue_last_fiscal_year: b.revenue, annual_revenue_year: b.revenue_year,
    fiscal_year_end: b.fiscal_year_end, business_address_street: b.street, business_address_city: b.city,
    business_address_county: b.county, business_address_state: b.state, business_address_zip: b.zip,
    business_address_full: [b.street, cityLine].filter(Boolean).join(", "), home_based: sayYN(b.home_based), rural: sayYN(b.rural),
    website: b.website, certifications: rows(b.certifications),
  });
  p.nonprofit = Object.assign(p.nonprofit || {}, {
    enabled: np.has === "yes", legal_name: np.legal_name, ein: np.ein, irs_status: np.irs_status,
    fiscal_sponsor_name: np.fiscal_sponsor_name, fiscal_sponsor_ein: np.fiscal_sponsor_ein, year_incorporated: np.year_incorporated,
    annual_operating_budget: np.operating_budget, board_members_count: np.board_count, volunteers_count: np.volunteers,
    people_served_last_year: np.people_served, address_full: np.address, website: np.website,
  });
  p.documents = Object.assign(p.documents || {}, { photos: d.documents.photos.slice(), pitch_video_url: d.documents.pitch_video_url });
  for (const k of DOC_KEYS) p.documents[k] = d.documents[k];
  p.presets = Object.assign(p.presets || {}, {
    how_did_you_hear: d.facts.how_heard, currently_receiving_federal_funds: sayYN(d.facts.federal_funds),
  });
  return p;
}

function buildSettings(d, base) {
  const s = JSON.parse(JSON.stringify(base || {}));
  const t = d.targets, sd = d.sending;
  s.schedule = Object.assign(s.schedule || {}, scheduleOf(d.schedule.frequency, d.schedule.hour, 9));
  s.submission = Object.assign(s.submission || {}, {
    mode: sd.mode === "approve" ? "approve" : "auto", max_application_fee_usd: amount(sd.max_fee) || 0,
    allow_typed_signature: sd.typed_signature === "yes", allow_checkbox_certification: sd.checkbox_cert !== "no",
  });
  const keywords = list(t.keywords);
  s.targets = Object.assign(s.targets || {}, {
    apply_as: d.nonprofit.has === "yes" && d.nonprofit.apply === "yes" ? ["business", "nonprofit"] : ["business"],
    keywords: keywords.length ? keywords : ["small business"], min_award_usd: amount(t.min_award) || 0,
    include_national: t.national !== "no", include_state: t.state !== "no", include_local: t.local !== "no",
    allow_public_vote_contests: t.vote_contests === "yes", fit_note: t.fit_note,
    priority_funders: rows(t.priority_funders), skip_funders: rows(t.skip_funders),
  });
  s.targets.federal = Object.assign(s.targets.federal || {}, { enabled: t.federal !== "no" });
  return s;
}

function scheduleOf(frequency, hour, fallback) {
  const h = parseInt(hour, 10);
  return { frequency: FREQUENCIES.includes(frequency) ? frequency : "manual", hour: h >= 0 && h <= 23 ? h : fallback };
}

// The fixed parts of answers.md (writing style, what to refuse) come from the template, so the
// agent's rules have one home.
function templateSection(template, start) {
  const s = sections(template).find((x) => x.head.toLowerCase().startsWith(start));
  return s ? `## ${s.head}\n${s.body}` : "";
}

function buildAnswers(d, template) {
  const or = (v) => (String(v || "").trim() ? String(v).trim() : "_Not provided yet. A question that needs this is NEEDS HUMAN._");
  const preset = (v, detail) => (v === "yes" ? "Yes" + (detail ? `, ${detail}` : "") : v === "no" ? "No" : "Not answered yet (NEEDS HUMAN).");
  const b = d.business, s = d.story, m = d.money, f = d.facts;
  const out = [];
  out.push(`${MARKER} Change it in the app, under Settings; edits made directly here are replaced the next time the owner saves there. -->`);
  out.push("# Narrative Library & Fact Sheet");
  out.push(
    "The **only** source the agent may use for written grant answers, entered by the owner in the Grants app. " +
    "If a question cannot be answered from what is here, the agent leaves it blank and logs NEEDS HUMAN instead of inventing something. " +
    "Every number, date, name and dollar amount here is the owner's own, verbatim."
  );
  out.push(templateSection(template, "writing style"));
  const bp = [
    `- **One line (under 25 words):** ${or(s.one_line)}`,
    `- **Short (about 50 words):** ${or(s.short)}`,
    `- **Standard (about 150 words):** ${or(s.standard)}`,
  ];
  if (d.nonprofit.has === "yes") bp.push(`- **Nonprofit mission (as the board adopted it):** ${or(d.nonprofit.mission)}`);
  out.push("## Boilerplate descriptions\n" + bp.join("\n"));
  out.push("## The owner's story\n" + or(s.owner_story));
  out.push("## Products, services and customers\n" + or(s.products) + (s.customers.trim() ? "\n\n" + s.customers.trim() : ""));
  out.push("## Need statement\n" + or(m.need));
  const presets = m.projects.filter((p) => p.name.trim() || p.items.length).map((p, i) => {
    const items = p.items.filter((x) => x.item.trim() && amount(x.amount) !== null);
    const total = projectTotal({ items });
    return [
      `### Preset ${i + 1}: ${p.name.trim() || "Unnamed project"}`,
      `- What it buys: ${or(p.buys)}`,
      `- Cost: ${items.length ? dollars(total) : "no prices yet"}${p.cost_source.trim() ? ", from " + p.cost_source.trim() : ""}`,
      `- What changes when it is funded: ${or(p.outcome)}`,
      "- Line items:",
      ...items.map((x) => `  - ${x.item.trim()}: ${dollars(amount(x.amount))}`),
      `  - Total: ${dollars(total)}`,
    ].join("\n");
  });
  out.push(
    "## Use of funds and budget presets (the ONLY source for dollar amounts)\n" +
    "Each preset is one project a grant could pay for. The agent picks the preset that fits the program, requests no more than its total, and never invents a line item or a cost.\n\n" +
    (presets.length ? presets.join("\n\n") : "_No projects yet. Without one, no amount can be requested: every application asking for an amount is NEEDS HUMAN._")
  );
  out.push("## Impact and outcomes\n" + or(m.impact));
  out.push("## Sustainability\n" + or(m.sustainability));
  out.push("## Challenges overcome\n" + or(s.challenges));
  const facts = [];
  if (b.year_founded) facts.push(`- Founded: ${b.year_founded}${b.city || b.state ? ", in " + [b.city, b.state].filter(Boolean).join(", ") : ""}.`);
  if (b.revenue) facts.push(`- Revenue: ${/^[\d,.]+$/.test(b.revenue) ? "$" + b.revenue : b.revenue}${b.revenue_year ? " in fiscal year " + b.revenue_year : ""}.`);
  if (b.full_time || b.part_time) {
    const parts = [b.full_time && `${b.full_time} full-time`, b.part_time && `${b.part_time} part-time`].filter(Boolean);
    facts.push(`- Employees: ${parts.join(" and ")}${b.employees_as_of ? ", as of " + b.employees_as_of : ""}.`);
  }
  for (const l of rows(f.extra)) facts.push(`- ${l.replace(/^[-*]\s+/, "")}`);
  out.push("## Fact sheet (the ONLY facts allowed in new answers)\nOne verifiable thing per line. The agent may recombine these but may not add to them.\n\n" +
    (facts.length ? facts.join("\n") : "_No facts yet._"));
  out.push("## Voice sample (optional)\n" + (s.voice_sample.trim() || "_None given._"));
  out.push([
    "## Preset answers for questions of fact",
    "No preset means NEEDS HUMAN, every time.",
    "",
    "- Previously applied to this program: the agent checks applications/ and the log.",
    `- Any outstanding tax liens, judgments or federal debt: ${preset(f.tax_liens)}`,
    `- Matching funds available: ${preset(f.matching_funds, f.matching_detail.trim())}`,
    `- Willing to be featured in funder publicity: ${preset(f.publicity)}`,
    `- Willing to participate in a pitch, interview or site visit: ${preset(f.site_visit)}`,
  ].join("\n"));
  out.push(templateSection(template, "things the agent must refuse"));
  if (s.extra.trim()) out.push(s.extra.trim());
  return out.filter(Boolean).join("\n\n") + "\n";
}

function buildResultsSettings(d, base, resultsRoot, grantsRoot) {
  const s = JSON.parse(JSON.stringify(base || {}));
  const mail = d.mail;
  s.grants_folder = path.relative(resultsRoot, grantsRoot).split(path.sep).join("/") || ".";
  const host = PROVIDERS[mail.provider] || mail.imap_host.trim();
  const folders = ["INBOX"];
  if (mail.provider === "gmail" && mail.spam_folder === "yes") folders.push("[Gmail]/Spam");
  s.mail = Object.assign(s.mail || {}, { address: mail.address.trim(), imap_host: host, imap_port: 993, folders });
  s.mail.keychain_service = s.mail.keychain_service || "queenbee-grant-mail";
  s.schedule = Object.assign(s.schedule || {}, scheduleOf(d.schedule.mail_frequency, d.schedule.mail_hour, 8));
  return s;
}

// The problems with a setup, in the owner's terms. `blocking` stops the agent from doing anything
// useful; `gaps` only mean some grants wait for the owner.
function review(d) {
  const blocking = [], gaps = [];
  const b = d.business, o = d.owner;
  if (!b.legal_name.trim()) blocking.push({ step: "business", text: "The business's legal name" });
  if (!o.first_name.trim() || !o.last_name.trim() || !o.email.trim()) blocking.push({ step: "business", text: "Your name and email, for the contact on every form" });
  if (!b.state.trim()) blocking.push({ step: "details", text: "The state the business is in" });
  const priced = d.money.projects.filter((p) => p.items.some((i) => amount(i.amount) !== null));
  if (!priced.length) blocking.push({ step: "money", text: "At least one project with prices. Without one, the agent can't ask for any amount" });
  if (!d.story.one_line.trim() && !d.story.standard.trim()) blocking.push({ step: "story", text: "A description of the business" });
  if (!b.county.trim() || !b.city.trim()) gaps.push({ step: "details", text: "City and county, which many local grants depend on" });
  if (!b.revenue.trim()) gaps.push({ step: "details", text: "Last year's revenue" });
  if (!b.full_time.trim() && !b.part_time.trim()) gaps.push({ step: "details", text: "How many people work for the business" });
  if (!b.ein.trim()) gaps.push({ step: "details", text: "The EIN" });
  if (!d.story.owner_story.trim()) gaps.push({ step: "story", text: "Your story, which is what many judges decide on" });
  if (!d.money.need.trim()) gaps.push({ step: "money", text: "Why the business needs the money now" });
  if (!d.documents.w9) gaps.push({ step: "documents", text: "Your W-9" });
  if (!d.documents.financial_statements) gaps.push({ step: "documents", text: "Last year's financial statements" });
  if (d.nonprofit.has === "yes" && d.nonprofit.apply === "yes" && !d.nonprofit.irs_status) gaps.push({ step: "nonprofit", text: "The nonprofit's IRS status" });
  for (const p of d.money.projects) {
    if (p.items.some((i) => String(i.amount).trim() && amount(i.amount) === null))
      gaps.push({ step: "money", text: `A price in "${p.name || "a project"}" that isn't a plain number, so it's left out` });
  }
  return { blocking, gaps };
}

function writeIfChanged(p, text) {
  if (readText(p) === text) return;
  fs.mkdirSync(path.dirname(p), { recursive: true });
  const tmp = `${p}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, text);
  fs.renameSync(tmp, p);
}

// Writes everything the grants agent reads. Keeps settings and profile keys the app does not ask
// about, and keeps a copy of an answers.md the app did not write before replacing it.
function writeAgentFiles(root, d) {
  const cfg = (n) => path.join(root, "config", n);
  for (const dir of ["applications/files", "logs", "screenshots", "state", "data/docs"]) fs.mkdirSync(path.join(root, dir), { recursive: true });
  writeJSONAtomic(cfg("profile.json"), buildProfile(d, readJSON(cfg("profile.json")) || readJSON(cfg("profile.example.json"))));
  writeJSONAtomic(cfg("settings.json"), buildSettings(d, readJSON(cfg("settings.json")) || readJSON(cfg("settings.example.json"))));
  const current = readText(cfg("answers.md"));
  if (current.trim() && !current.startsWith(MARKER)) {
    const backup = path.join(root, "config", "backup", `answers-${now().replace(/[T:]/g, "-")}.md`);
    fs.mkdirSync(path.dirname(backup), { recursive: true });
    fs.writeFileSync(backup, current);
  }
  writeIfChanged(cfg("answers.md"), buildAnswers(d, readText(cfg("answers.example.md"))));
  const queue = path.join(root, "data", "queue.md");
  if (!fs.existsSync(queue) && fs.existsSync(path.join(root, "data", "queue.example.md"))) {
    fs.copyFileSync(path.join(root, "data", "queue.example.md"), queue);
  }
}

function writeResultsSettings(resultsRoot, grantsRoot, d) {
  const p = path.join(resultsRoot, "config", "settings.json");
  const base = readJSON(p) || readJSON(path.join(resultsRoot, "config", "settings.example.json")) || {};
  writeJSONAtomic(p, buildResultsSettings(d, base, resultsRoot, grantsRoot));
}

// The grant-results agent lives beside the grants folder in QueenBee.
function resultsFolder(grantsRoot) {
  const p = path.resolve(grantsRoot, "..", "grant-results");
  return fs.existsSync(path.join(p, "CLAUDE.md")) && fs.existsSync(path.join(p, "scripts", "fetch_mail.py")) ? p : null;
}

module.exports = {
  STEPS, DOC_KEYS, DOC_RE, PROVIDERS, MARKER, defaults, normalize, load, save, importExisting, importAnswers,
  buildProfile, buildSettings, buildAnswers, buildResultsSettings, review, writeAgentFiles, writeResultsSettings,
  resultsFolder, amount, projectTotal, localDate,
};
