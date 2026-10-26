// Setup: everything the agent needs from the owner, one short step at a time. What the owner types
// is saved as they type (the main process keeps it in config/setup.json); the agent's own files
// are written from it when the owner turns the agent on, and on every "Save changes" after that.
// Uses esc, $, api, toast, shortDate and refresh from app.js.
const SU = {
  active: false, draft: null, review: { blocking: [], gaps: [] }, steps: [], step: "welcome", results: false,
  platform: "", demo: false, savedAt: "", saving: false, errors: {}, checks: null, finish: null, mailMsg: null,
  mailBusy: false, justDone: "", firstRun: true,
};

const STEP_TITLES = {
  welcome: "Welcome", business: "You and the business", details: "Location and size", ownership: "Who owns it",
  nonprofit: "A nonprofit too?", story: "Your story", money: "What the money is for", facts: "Questions funders ask",
  documents: "Documents", targets: "Which grants", sending: "How it sends", email: "Funder emails", finish: "Turn it on",
};

// ── The draft ────────────────────────────────────────────────────────────────────
const getPath = (p) => p.split(".").reduce((o, k) => (o == null ? undefined : o[k]), SU.draft);
function setPath(p, v) {
  const ks = p.split(".");
  let o = SU.draft;
  for (const k of ks.slice(0, -1)) o = o[k];
  o[ks.at(-1)] = v;
}
const editing = () => !!(SU.draft && SU.draft.completed_at);
const money = (v) => {
  const t = String(v ?? "").replace(/[$,\s]/g, "");
  return /^\d+(\.\d{1,2})?$/.test(t) ? Number(t) : null;
};
const fmtUSD = (n) => "$" + n.toLocaleString("en-US", { minimumFractionDigits: Number.isInteger(n) ? 0 : 2, maximumFractionDigits: 2 });
const total = (p) => p.items.reduce((s, i) => s + (money(i.amount) || 0), 0);

// ── Field builders. Every input carries data-path, the draft field it edits. ─────
const fid = (p) => "f-" + p.replace(/[^A-Za-z0-9]+/g, "-");
const optional = (o) => (o.optional ? ' <span class="opt">(optional)</span>' : "");
const width = (o) => (o.w ? ` w${o.w}` : "");

function described(id, o) {
  const ids = [o.hint && `${id}-h`, SU.errors[o.path] && `${id}-e`].filter(Boolean);
  return ids.length ? ` aria-describedby="${ids.join(" ")}"` : "";
}
function hintAndError(id, o) {
  return [o.hint ? `<span class="hint" id="${id}-h">${esc(o.hint)}</span>` : "", SU.errors[o.path] ? `<p class="error" id="${id}-e">${esc(SU.errors[o.path])}</p>` : ""];
}

function text(path, label, o = {}) {
  o.path = path;
  const id = fid(path);
  const [hint, err] = hintAndError(id, o);
  const attrs = [
    `type="${o.type || "text"}"`, `id="${id}"`, `data-path="${esc(path)}"`, `value="${esc(getPath(path))}"`,
    `autocomplete="${o.auto || "off"}"`, o.inputmode ? `inputmode="${o.inputmode}"` : "", o.placeholder ? `placeholder="${esc(o.placeholder)}"` : "",
    o.required ? 'aria-required="true"' : "", SU.errors[path] ? 'aria-invalid="true"' : "", 'spellcheck="false"',
  ].filter(Boolean).join(" ");
  return `<div class="field${width(o)}"><label for="${id}">${esc(label)}${optional(o)}</label><input ${attrs}${described(id, o)}>${hint}${err}</div>`;
}

function long(path, label, o = {}) {
  o.path = path;
  const id = fid(path);
  const [hint, err] = hintAndError(id, o);
  const count = o.words ? `<span class="count" data-count="${esc(path)}" data-target="${o.words}" aria-live="off"></span>` : "";
  return `<div class="field${width(o)}"><label for="${id}">${esc(label)}${optional(o)}</label>
    <textarea id="${id}" data-path="${esc(path)}" rows="${o.rows || 4}"${o.placeholder ? ` placeholder="${esc(o.placeholder)}"` : ""}${described(id, o)}>${esc(getPath(path))}</textarea>${count}${hint}${err}</div>`;
}

// options: [value, label, description?]
function choice(path, label, options, o = {}) {
  o.path = path;
  const id = fid(path);
  const [hint, err] = hintAndError(id, o);
  const now = String(getPath(path) ?? "");
  const opts = options.map(([v, l, d]) => `<label class="choice"><input type="radio" name="${id}" data-path="${esc(path)}" value="${esc(v)}"${now === v ? " checked" : ""}>
      <span class="choice-text">${d ? `<strong>${esc(l)}</strong><span>${esc(d)}</span>` : esc(l)}</span></label>`).join("");
  return `<div class="field${width(o)}" role="radiogroup" aria-labelledby="${id}-l"${described(id, o)}><span class="label" id="${id}-l">${esc(label)}${optional(o)}</span>${hint}
    <div class="choices${o.cards ? " cards" : ""}${o.stack ? " stack" : ""}">${opts}</div>${err}</div>`;
}

// A yes-or-no question. `skip` names the third answer, which leaves the field empty; false drops it.
function yesno(path, label, o = {}) {
  const opts = [["yes", "Yes"], ["no", "No"]];
  if (o.skip !== false) opts.push(["", o.skip || "Prefer not to say"]);
  return choice(path, label, opts, o);
}

function check(path, label, o = {}) {
  const on = getPath(path) === "yes";
  return `<div class="field${width(o)}"><label class="choice"><input type="checkbox" data-path="${esc(path)}" data-check${on ? " checked" : ""}>
    <span class="choice-text">${o.desc ? `<strong>${esc(label)}</strong><span>${esc(o.desc)}</span>` : esc(label)}</span></label></div>`;
}

function select(path, label, options, o = {}) {
  o.path = path;
  const id = fid(path);
  const [hint, err] = hintAndError(id, o);
  const now = String(getPath(path) ?? "");
  return `<div class="field${width(o)}"><label for="${id}">${esc(label)}${optional(o)}</label><select id="${id}" data-path="${esc(path)}"${described(id, o)}>
    ${options.map(([v, l]) => `<option value="${esc(v)}"${now === v ? " selected" : ""}>${esc(l)}</option>`).join("")}</select>${hint}${err}</div>`;
}

const group = (legend, lede, inner, when) =>
  `<fieldset${when ? ` data-when="${esc(when)}"` : ""}>${legend ? `<legend>${esc(legend)}</legend>` : ""}${lede ? `<p class="group-lede">${esc(lede)}</p>` : ""}<div class="grid">${inner}</div></fieldset>`;
// Shown only while a condition holds: "path=value", "path!=value", or "path~a|b" for any of several.
const when = (cond, inner) => `<div class="when" data-when="${esc(cond)}">${inner}</div>`;
const note = (html, kind) => `<div class="note${kind ? " " + kind : ""}">${html}</div>`;

function updateWhen() {
  document.querySelectorAll("#setup [data-when]").forEach((el) => {
    const c = el.dataset.when;
    let show;
    if (c.includes("!=")) {
      const [p, v] = c.split("!=");
      show = String(getPath(p) ?? "") !== v;
    } else if (c.includes("~")) {
      const [p, v] = c.split("~");
      show = v.split("|").includes(String(getPath(p) ?? ""));
    } else {
      const i = c.indexOf("=");
      show = String(getPath(c.slice(0, i)) ?? "") === c.slice(i + 1);
    }
    el.hidden = !show;
  });
}

function updateCounts() {
  document.querySelectorAll("#setup [data-count]").forEach((el) => {
    const n = String(getPath(el.dataset.count) || "").trim().split(/\s+/).filter(Boolean).length;
    const target = Number(el.dataset.target);
    el.textContent = n ? `${n} ${n === 1 ? "word" : "words"}, aiming for about ${target}` : `Aim for about ${target} words`;
    el.classList.toggle("over", n > target * 1.25);
  });
  document.querySelectorAll("#setup [data-total]").forEach((el) => {
    const p = SU.draft.money.projects[Number(el.dataset.total)];
    if (p) el.textContent = fmtUSD(total(p));
  });
  document.querySelectorAll("#setup [data-bad]").forEach((el) => {
    const p = SU.draft.money.projects[Number(el.dataset.bad)];
    el.hidden = !p || !p.items.some((it) => String(it.amount).trim() && money(it.amount) === null);
  });
}

// ── The steps ────────────────────────────────────────────────────────────────────
const ENTITIES = [["", "Choose one"], ["LLC", "LLC"], ["Sole proprietorship", "Sole proprietorship"], ["Partnership", "Partnership"],
  ["S corporation", "S corporation"], ["C corporation", "C corporation"], ["Cooperative", "Cooperative"],
  ["Nonprofit corporation", "Nonprofit corporation"], ["Other", "Other"]];
const FREQS = [["weekly", "Every Monday"], ["twice-weekly", "Mondays and Thursdays"], ["weekdays", "Every weekday"],
  ["daily", "Every day"], ["manual", "Only when I click Check for grants now"]];
const HOURS = Array.from({ length: 16 }, (_, i) => i + 6).map((h) => [String(h), new Date(2000, 0, 1, h).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" })]);
const STORE_NAME = () => (SU.platform === "win32" ? "Windows Credential Manager" : SU.platform === "darwin" ? "your Mac's Keychain" : "your computer's password store");

const STEP = {
  welcome: () => ({
    big: true,
    title: editing() ? "Your details" : "Let's set up your grant agent.",
    lede: editing()
      ? "Everything the agent knows about your business. Change anything and save; the agent uses it from its next run."
      : "It finds grants your business qualifies for, writes the applications from what you tell it here, and sends the simple ones on a schedule. Plan on 30 to 45 minutes. Everything saves as you type, so you can stop and come back.",
    body: `<p class="kicker">Good to have nearby</p>
      <ul class="welcome-list">
        <li>Your EIN and the business's address</li>
        <li>Last year's revenue, and how many people work for you</li>
        <li>A quote or price list for anything you'd like a grant to pay for</li>
        <li>Your W-9 and last year's financial statements, as files</li>
        <li>The email address funders write to</li>
      </ul>
      ${note("<p>Everything you enter stays on this computer, in the grants folder. The agent types it only into grant applications for your business, and never makes anything up to fill a gap.</p>")}`,
  }),

  business: () => ({
    title: "You and the business",
    lede: "The basics every grant form asks for. Write things exactly as they appear on your paperwork.",
    body:
      group("You", "The person funders contact, and who signs for the business.",
        text("owner.first_name", "First name", { w: 3, required: true, auto: "given-name" }) +
        text("owner.last_name", "Last name", { w: 3, required: true, auto: "family-name" }) +
        text("owner.title", "Your title", { w: 3, placeholder: "Owner" }) +
        text("owner.ownership_percent", "How much of the business you own", { w: 3, optional: true, inputmode: "decimal", hint: "As a percent, like 100." }) +
        text("owner.email", "Email", { w: 3, type: "email", required: true, auto: "email" }) +
        text("owner.phone", "Phone", { w: 3, type: "tel", auto: "tel" }) +
        text("owner.years_experience", "Years you've worked in this industry", { w: 3, optional: true, inputmode: "numeric" })) +
      group("The business", "",
        text("business.legal_name", "Legal name", { required: true, hint: "Exactly as it appears on your IRS paperwork." }) +
        text("business.dba", "Name customers know it by", { optional: true, hint: "Only if it's different from the legal name." }) +
        select("business.entity_type", "Type of business", ENTITIES, { w: 3 }) +
        text("business.state_of_formation", "State where it was formed", { w: 3 }) +
        text("business.year_founded", "Year founded", { w: 2, inputmode: "numeric", placeholder: "2019" }) +
        text("business.website", "Website", { w: 4, type: "url", optional: true }) +
        long("business.industry_description", "What the business does", { rows: 3, hint: "A sentence or two, in plain words." }) +
        text("business.naics", "NAICS code", { w: 3, optional: true, inputmode: "numeric", hint: "The six-digit industry code on your tax return. Leave it blank if you don't know it." })),
  }),

  details: () => ({
    title: "Location and size",
    lede: "Where the business is and how big it is decide which grants it qualifies for. The agent copies these exactly, never rounded.",
    body:
      group("Where it is", "Many state and local grants depend on the county.",
        text("business.street", "Street address", { auto: "street-address" }) +
        text("business.city", "City", { w: 3, auto: "address-level2" }) +
        text("business.county", "County", { w: 3 }) +
        text("business.state", "State", { w: 3, required: true, auto: "address-level1", placeholder: "OH" }) +
        text("business.zip", "ZIP code", { w: 3, inputmode: "numeric", auto: "postal-code" }) +
        yesno("business.home_based", "Do you run the business from your home?", { skip: "Not sure" }) +
        yesno("business.rural", "Is it in a rural area?", { skip: "Not sure", hint: "If you're not sure, leave it. The agent won't claim it." })) +
      group("Size", "Write the numbers the way your records show them, with the year they belong to.",
        text("business.full_time", "Full-time employees", { w: 2, inputmode: "numeric", hint: "Count yourself if you work full-time in it." }) +
        text("business.part_time", "Part-time employees", { w: 2, inputmode: "numeric" }) +
        text("business.employees_as_of", "As of", { w: 2, placeholder: "January 1, 2026" }) +
        text("business.revenue", "Revenue for your last full year", { w: 3, inputmode: "decimal", placeholder: "182,400", hint: "In dollars." }) +
        text("business.revenue_year", "Which year that was", { w: 3, inputmode: "numeric", placeholder: "2025" }) +
        text("business.fiscal_year_end", "Your fiscal year ends on", { w: 3, optional: true, placeholder: "December 31" })) +
      group("Registrations", "",
        text("business.ein", "EIN", { w: 3, placeholder: "12-3456789", hint: "Nine digits, on your IRS letter." }) +
        text("business.uei", "UEI", { w: 3, optional: true, hint: "From SAM.gov, if you have one." }) +
        choice("business.sam_registration", "SAM.gov registration", [["active", "Active"], ["in progress", "In progress"], ["none", "Not registered"], ["", "Not sure"]],
          { hint: "Needed only for federal grants. It's free, and can take a few weeks." }) +
        when("business.sam_registration=active", text("business.sam_active_until", "Active until", { w: 3, placeholder: "2027-03-01", hint: "The date SAM.gov shows, as year-month-day." })) +
        long("business.certifications", "Certifications you hold", { optional: true, rows: 3, hint: "One per line, with who issued it and when, like: WOSB, SBA, certified 2025-03-01. Only ones you actually hold." })),
  }),

  ownership: () => ({
    title: "Who owns the business",
    lede: "Many grants are only for businesses owned by women, people of color, veterans or people with disabilities. Answer only what's true and what you're comfortable sharing. \"Prefer not to say\" means the agent skips grants that require it. It never guesses.",
    body: group("", "",
      yesno("demographics.woman_owned", "Is the business at least 51% owned by one or more women?") +
      yesno("demographics.minority_owned", "Is it at least 51% owned by one or more people from a racial or ethnic minority group?") +
      yesno("demographics.veteran_owned", "Is it owned by a veteran?") +
      yesno("demographics.disability_owned", "Is it owned by a person with a disability?") +
      yesno("demographics.lgbtq_owned", "Is it owned by one or more LGBTQ+ people?") +
      text("demographics.race_ethnicity", "How forms should list your race or ethnicity", { w: 3, hint: "Leave it as it is to decline." }) +
      text("demographics.gender", "How forms should list your gender", { w: 3, hint: "Leave it as it is to decline." })),
  }),

  nonprofit: () => ({
    title: "A nonprofit too?",
    lede: "Some owners also run a nonprofit, which can apply for a different set of grants. The agent never mixes the two: business grants get business facts, nonprofit grants get nonprofit facts.",
    body: group("", "", choice("nonprofit.has", "Do you also run a nonprofit organization?", [["no", "No, just the business"], ["yes", "Yes, we also have a nonprofit"]], { stack: true })) +
      group("The nonprofit", "",
        yesno("nonprofit.apply", "Look for nonprofit grants too?", { skip: false }) +
        text("nonprofit.legal_name", "Legal name") +
        text("nonprofit.ein", "EIN", { w: 3, placeholder: "12-3456789" }) +
        text("nonprofit.year_incorporated", "Year incorporated", { w: 3, inputmode: "numeric" }) +
        choice("nonprofit.irs_status", "IRS status", [["501(c)(3) public charity", "501(c)(3) public charity"], ["501(c)(3) private foundation", "501(c)(3) private foundation"],
          ["other 501(c)", "Another kind of 501(c)"], ["fiscally sponsored", "Fiscally sponsored by another nonprofit"], ["none", "No IRS status yet"]], { stack: true }) +
        when("nonprofit.irs_status=fiscally sponsored",
          text("nonprofit.fiscal_sponsor_name", "Fiscal sponsor's name", { w: 4 }) + text("nonprofit.fiscal_sponsor_ein", "Fiscal sponsor's EIN", { w: 2 })) +
        text("nonprofit.operating_budget", "Yearly operating budget", { w: 2, inputmode: "decimal", hint: "In dollars." }) +
        text("nonprofit.board_count", "Board members", { w: 2, inputmode: "numeric" }) +
        text("nonprofit.volunteers", "Volunteers", { w: 2, inputmode: "numeric" }) +
        text("nonprofit.people_served", "People served last year", { w: 3, inputmode: "numeric" }) +
        text("nonprofit.website", "Website", { w: 3, type: "url", optional: true }) +
        text("nonprofit.address", "Address", { hint: "Only if different from the business." , optional: true }) +
        long("nonprofit.mission", "Mission statement", { rows: 3, hint: "Exactly as your board adopted it." }), "nonprofit.has=yes"),
  }),

  story: () => ({
    title: "Your story",
    lede: "Funders ask for the same description at different lengths. Write each one once and the agent uses the one that fits. Write the way you talk.",
    body:
      group("Describe the business", "",
        long("story.one_line", "In one line: what you do, for whom, and where", { rows: 2, words: 25 }) +
        long("story.short", "A short version", { rows: 3, words: 50, hint: "Add when it started and one fact that shows it's real." }) +
        long("story.standard", "The full version", { rows: 6, words: 150, hint: "What you do, who you serve, how it started, what makes it different, and a result or two." })) +
      group("In your own words", "This is what small-business judges decide on most often.",
        long("story.owner_story", "Why you started it, the hard parts, and what you're building toward", { rows: 7 }) +
        long("story.challenges", "A real obstacle you faced, and what you did about it", { rows: 4 })) +
      group("What you sell", "",
        long("story.products", "What you make or sell, and who buys it", { rows: 3 }) +
        long("story.customers", "Who your customers are", { rows: 3, optional: true, hint: "Kinds of customers, where they are, any you're happy to name." })) +
      group("How you write", "",
        long("story.voice_sample", "Something you wrote yourself", { rows: 5, optional: true, hint: "An email, a post, or your About page. The agent matches its tone so applications sound like you." })) +
      (String(SU.draft.story.extra || "").trim()
        ? group("Other notes", "Kept from an earlier setup. The agent reads these too.", long("story.extra", "Notes", { rows: 8 }))
        : ""),
  }),

  money: () => ({
    title: "What the money is for",
    lede: "The agent can only ask for money for a project listed here, and never more than its total. Add two or three things a grant could pay for, with real prices from a quote, an invoice or a catalog.",
    body:
      SU.draft.money.projects.map(projectHtml).join("") +
      `<div class="actions"><button class="quiet" data-act="proj-add">Add ${SU.draft.money.projects.length ? "another" : "a"} project</button></div>` +
      group("Why it matters", "",
        long("money.need", "Why the business needs outside money now", { rows: 4, hint: "The problem or the opportunity, and what happens with and without the money." }) +
        long("money.impact", "What changes if you're funded", { rows: 4, hint: "Jobs, revenue, customers, capacity. Say which numbers are your projections." }) +
        long("money.sustainability", "How it keeps going after the grant money is spent", { rows: 3 })),
  }),

  facts: () => ({
    title: "Questions funders ask",
    lede: "Grant forms ask the same few questions of fact. Answer them once here. Anything you skip, the agent leaves for you to answer on the form.",
    body:
      group("", "",
        yesno("facts.tax_liens", "Does the business have any unpaid tax liens, court judgments or federal debt?", { skip: "Skip for now" }) +
        yesno("facts.matching_funds", "Could the business put in some of its own money alongside a grant?", { skip: "Skip for now", hint: "Some grants require this, called a match." }) +
        when("facts.matching_funds=yes", text("facts.matching_detail", "How much, and from where", { w: 4, placeholder: "$2,000 from savings" })) +
        yesno("facts.publicity", "Is it okay for a funder to feature you in their publicity?", { skip: "Skip for now" }) +
        yesno("facts.site_visit", "Would you do a pitch, an interview or a site visit if asked?", { skip: "Skip for now" }) +
        yesno("facts.federal_funds", "Is the business getting any federal money right now?", { skip: "Skip for now", hint: "Grants, loans or contracts from a federal agency." }) +
        text("facts.how_heard", "When a form asks how you heard about it", { w: 3 })) +
      group("Facts a funder can check", "Your founding year, revenue and staff count are already included. Add anything else that's true and checkable, one per line. The agent can combine these but never adds to them.",
        long("facts.extra", "Awards, press, customers served, equipment, memberships, past grants or loans", {
          rows: 6, placeholder: "Featured in the local paper, 2024\n140 customers served in 2025\nReceived a $5,000 city grant in 2023",
        })),
  }),

  documents: () => ({
    title: "Your documents",
    lede: "Grant forms often ask for these. Add what you have. When a form needs something that isn't here, the agent leaves it for you. Each file is copied into the grants folder on this computer.",
    body: `<div class="docs">${DOCS.map(docRow).join("")}</div>` +
      group("", "", text("documents.pitch_video_url", "Link to a pitch video", { type: "url", optional: true, hint: "Some contests ask for a short video. A YouTube or Vimeo link works." })),
  }),

  targets: () => ({
    title: "Which grants to go after",
    lede: "The agent searches federal, state and local programs and checks each one against what you've told it. These narrow the search.",
    body:
      group("What to look for", "",
        long("targets.keywords", "Words that describe your work and what you need money for", { rows: 2, hint: "Separate them with commas, like: woodworking, equipment, women-owned, rural." }) +
        text("targets.min_award", "Skip grants smaller than", { w: 3, inputmode: "numeric", placeholder: "1,000", hint: "In dollars." }) +
        long("targets.fit_note", "In your own words, what's worth going after?", { rows: 3, hint: "The agent uses this to decide. For example: grants that pay for equipment or training; skip anything under $2,000 that takes more than an hour to write." })) +
      group("Where to look", "",
        check("targets.national", "National programs") +
        check("targets.state", "Programs in your state") +
        check("targets.local", "Local programs", { desc: "City, county, utility companies, the chamber of commerce" }) +
        check("targets.federal", "Federal grants on Grants.gov", { desc: "These need a SAM.gov registration, and you always submit them yourself." })) +
      group("Funders", "",
        long("targets.skip_funders", "Never apply to", { rows: 2, optional: true, hint: "One funder per line." }) +
        long("targets.priority_funders", "Look at these first", { rows: 2, optional: true, hint: "One funder per line." }) +
        yesno("targets.vote_contests", "Include contests decided by public votes?", { skip: false, hint: "Winning one means promoting it yourself." })),
  }),

  sending: () => ({
    title: "How applications go out",
    lede: "Either way, government grants and larger packages are prepared for you to submit yourself, because they need your signature.",
    body:
      group("", "",
        choice("sending.mode", "When an application is ready", [
          ["auto", "Send simple ones on their own", "Short online forms that pass every check go out on schedule. Your very first one waits for your OK, so you see the quality first."],
          ["approve", "Ask me before sending each one", "The agent writes each application and waits. You read it here, click Approve, and it goes out on the next run."],
        ], { cards: true })) +
      group("Signatures, boxes and fees", "",
        yesno("sending.typed_signature", "May the agent type your name where a form asks for a signature?", { skip: false, hint: "If not, it fills everything else and leaves the form for you to sign." }) +
        yesno("sending.checkbox_cert", "May it tick boxes like \"I certify this information is accurate\"?", { skip: false, hint: "Everything it fills in comes from what you entered here." }) +
        text("sending.max_fee", "Apply to grants with a fee of up to", { w: 3, inputmode: "numeric", placeholder: "0", hint: "In dollars. Most real grants are free. The agent never pays: a fee always comes to you." })),
  }),

  email: () => ({
    title: "Funder emails",
    lede: "A second helper can read the emails funders send about applications you've sent, so news like \"you won\" or \"we need a document\" shows up here. This step is optional.",
    body: !SU.results
      ? note("<p>The email helper isn't in this QueenBee folder, so you can skip this step.</p>", "warn")
      : note("<p>Once an application has been sent, it checks your inbox only for emails from that funder, or emails that name that grant, sent after the application went out. It opens your inbox read-only, so nothing is marked as read or moved, and keeps a short copy of each matching email on this computer for 60 days.</p><p>It never reads other email, never replies, and never sends anything anywhere. You confirm every result yourself.</p>") +
        group("", "", check("mail.enabled", "Yes, read those emails")) +
        when("mail.enabled=yes", group("Your mailbox", "",
          text("mail.address", "The email address funders write to", { w: 4, type: "email", auto: "email" }) +
          choice("mail.provider", "Who runs that email", [["gmail", "Gmail or Google Workspace"], ["icloud", "iCloud"], ["yahoo", "Yahoo"],
            ["microsoft", "Outlook, Hotmail or Microsoft 365"], ["other", "Something else"]]) +
          when("mail.provider=other", text("mail.imap_host", "Mail server (IMAP)", { w: 4, placeholder: "imap.example.com", hint: "Ask whoever runs your email." })) +
          when("mail.provider=gmail", check("mail.spam_folder", "Also check the Spam folder", { desc: "Funders' emails sometimes land there." })) +
          when("mail.provider=microsoft", `<div class="field">${note("<p>Microsoft mailboxes can't be read yet: Microsoft no longer allows app passwords for this. You can still record results yourself in the app.</p>", "warn")}</div>`)) +
        group("App password", "An app password lets the helper sign in without your real password. You can cancel it any time from your email account.",
          when("mail.provider=gmail", steps([
            "Turn on 2-Step Verification for your Google account, if it isn't on already.",
            'Open <a href="https://myaccount.google.com/apppasswords" target="_blank" rel="noopener noreferrer">myaccount.google.com/apppasswords</a>, name it Grants, and click Create.',
            "Copy the password it shows and paste it below. In Gmail's settings, under Forwarding and POP/IMAP, check that IMAP is on.",
          ])) +
          when("mail.provider=icloud", steps([
            'Open <a href="https://account.apple.com" target="_blank" rel="noopener noreferrer">account.apple.com</a> and sign in.',
            "Under Sign-In and Security, choose App-Specific Passwords and add one named Grants.",
            "Paste it below.",
          ])) +
          when("mail.provider=yahoo", steps([
            'Open <a href="https://login.yahoo.com/account/security" target="_blank" rel="noopener noreferrer">your Yahoo account security page</a>.',
            "Choose Generate app password and name it Grants.",
            "Paste it below.",
          ])) +
          when("mail.provider=other", `<div class="field"><p class="group-lede">Your email provider's help pages explain how to make an app password for IMAP. Paste it below.</p></div>`) +
          passwordField(), "mail.provider~gmail|icloud|yahoo|other")),
  }),

  finish: () => ({
    title: editing() ? "Schedule and this computer" : "Turn it on",
    lede: editing()
      ? "When the agent looks for grants, and whether this computer can run it."
      : "Check what the agent knows, choose when it looks for grants, and turn it on. You can change any of this later under Settings.",
    body: finishHtml(),
  }),
};
const steps = (items) => `<div class="field"><ol class="instructions">${items.map((i) => `<li>${i}</li>`).join("")}</ol></div>`;

function passwordField() {
  const m = SU.draft.mail;
  let status = "";
  if (SU.mailMsg) status = `<p class="${SU.mailMsg.ok ? "pw-ok" : "error"}" role="status">${esc(SU.mailMsg.text)}</p>`;
  else if (m.password_saved_at) {
    status = `<p class="${m.check === "ok" ? "pw-ok" : "hint"}">Saved ${esc(shortDate(m.password_saved_at))}.${m.check === "ok" ? " It signed in fine." : m.check ? " The last sign-in check said: " + esc(m.check) : ""}</p>`;
  }
  return `<div class="field"><label for="mail-pw">Paste the app password here</label>
    <div class="pw-row"><input type="password" id="mail-pw" autocomplete="off" spellcheck="false" aria-describedby="mail-pw-h">
    <button data-act="mail-save"${SU.mailBusy ? " disabled" : ""}>${SU.mailBusy ? "Checking…" : "Save and test"}</button></div>
    <span class="hint" id="mail-pw-h">It goes straight into ${esc(STORE_NAME())}. The app doesn't keep a copy.</span>
    ${status}${m.password_saved_at && !SU.mailBusy ? `<button class="link" data-act="mail-check">Test the sign-in again</button>` : ""}</div>`;
}

// ── Projects (the budget presets) ───────────────────────────────────────────────
function projectHtml(p, i) {
  const base = `money.projects.${i}`;
  const rows = p.items.map((it, j) => {
    const bad = String(it.amount).trim() && money(it.amount) === null;
    return `<tr><td><input type="text" data-path="${base}.items.${j}.item" value="${esc(it.item)}" aria-label="Item ${j + 1}" placeholder="What it is"></td>
      <td class="amt"><input type="text" inputmode="decimal" data-path="${base}.items.${j}.amount" value="${esc(it.amount)}" aria-label="Price of item ${j + 1}, in dollars" placeholder="$0"${bad ? ' aria-invalid="true"' : ""}></td>
      <td class="rm"><button class="link" data-act="item-remove" data-i="${i}" data-j="${j}" aria-label="Remove item ${j + 1}">Remove</button></td></tr>`;
  }).join("");
  return `<section class="project" aria-label="Project ${i + 1}">
    <div class="project-head"><h3>Project ${i + 1}</h3><button class="link danger" data-act="proj-remove" data-i="${i}">Remove project</button></div>
    <div class="grid">
      ${text(`${base}.name`, "Name", { w: 3, placeholder: "New equipment" })}
      ${text(`${base}.cost_source`, "Where the prices come from", { w: 3, placeholder: "A quote from the supplier" })}
      ${long(`${base}.buys`, "What it buys", { rows: 2 })}
      ${long(`${base}.outcome`, "What changes once it's paid for", { rows: 2 })}
    </div>
    <table class="items"><thead><tr><th scope="col">Item</th><th scope="col">Price</th><th><span class="sr">Remove</span></th></tr></thead>
      <tbody>${rows}</tbody>
      <tfoot><tr><td>Total</td><td class="amt" data-total="${i}">${fmtUSD(total(p))}</td><td></td></tr></tfoot></table>
    <p class="error" data-bad="${i}" hidden>Write each price as a plain number, like 800. A price that isn't is left out of the total, and the agent won't use it.</p>
    <div class="actions"><button class="quiet" data-act="item-add" data-i="${i}">Add a line</button></div></section>`;
}

// ── Documents ───────────────────────────────────────────────────────────────────
const DOCS = [
  ["w9", "W-9", "Most forms ask for it."],
  ["financial_statements", "Last year's financial statements", "Profit and loss, and a balance sheet if you have one."],
  ["tax_returns_most_recent", "Most recent business tax return", ""],
  ["business_plan", "Business plan", "Any version, even an old one."],
  ["business_license", "Business license", ""],
  ["budget_spreadsheet", "Quotes or a budget", "The prices behind your projects."],
  ["irs_determination_letter", "IRS determination letter", "The letter that confirms the nonprofit's status.", true],
  ["board_list", "Board list", "Names and roles of the nonprofit's board.", true],
  ["logo", "Logo", "A PNG or JPG."],
  ["owner_headshot", "A photo of you", "Some applications ask for one."],
  ["photos", "Photos of the business", "Your shop, your work, your team. Add several."],
];

function docRow([key, name, why, nonprofitOnly]) {
  const d = SU.draft.documents;
  let files, buttons;
  if (key === "photos") {
    files = d.photos.length
      ? d.photos.map((f) => `<span class="doc-file">${esc(f.split("/").pop())} <button class="link" data-act="doc-remove" data-key="photos" data-file="${esc(f)}">Remove</button></span>`).join("")
      : `<span class="doc-file none">None added</span>`;
    buttons = `<button class="quiet" data-act="doc-add" data-key="photos">Add photos</button>`;
  } else {
    files = d[key] ? `<span class="doc-file">${esc(d[key].split("/").pop())}</span>` : `<span class="doc-file none">Not added</span>`;
    buttons = d[key]
      ? `<button class="quiet" data-act="doc-add" data-key="${key}">Replace</button><button class="link" data-act="doc-remove" data-key="${key}">Remove</button>`
      : `<button class="quiet" data-act="doc-add" data-key="${key}">Add file</button>`;
  }
  const row = `<div class="doc-row"><div class="doc-name">${esc(name)}</div>${why ? `<div class="doc-why">${esc(why)}</div>` : ""}<div>${files}</div><div class="doc-actions">${buttons}</div></div>`;
  return nonprofitOnly ? when("nonprofit.has=yes", row) : row;
}

// ── Finish ──────────────────────────────────────────────────────────────────────
const CHECK_HELP = {
  python: ['Install Python from <a href="https://www.python.org/downloads/" target="_blank" rel="noopener noreferrer">python.org</a>. On the first installer screen, tick "Add python.exe to PATH".', "Python"],
  claude: ['Install <a href="https://claude.com/claude-code" target="_blank" rel="noopener noreferrer">Claude Code</a>, then open it once and sign in.', "Claude Code"],
  git: ['Install <a href="https://git-scm.com/downloads/win" target="_blank" rel="noopener noreferrer">Git for Windows</a>. The default choices are fine.', "Git for Windows"],
};

function finishHtml() {
  const r = SU.review;
  const known = [
    ...r.blocking.map((x) => `<li><span class="mark-no" aria-hidden="true"></span><span><strong>Needed:</strong> ${esc(x.text)}.</span><button class="link" data-act="setup-go" data-step="${x.step}">Add it</button></li>`),
    ...r.gaps.map((x) => `<li><span class="mark-gap" aria-hidden="true"></span><span>Not yet: ${esc(x.text)}.<span class="sub">Grants that need it wait for you.</span></span><button class="link" data-act="setup-go" data-step="${x.step}">Add it</button></li>`),
  ];
  const knows = known.length ? `<ul class="checklist">${known.join("")}</ul>` : `<ul class="checklist"><li><span class="mark-ok" aria-hidden="true"></span><span>Everything the agent needs is here.</span><span></span></li></ul>`;

  let computer = `<p class="group-lede">Checking…</p>`;
  if (SU.checks) {
    const rows = Object.entries(SU.checks).map(([k, c]) =>
      `<li><span class="${c.ok ? "mark-ok" : "mark-no"}" aria-hidden="true"></span><span>${esc(c.detail)}${c.ok ? "" : `<span class="sub">${CHECK_HELP[k][0]}</span>`}</span><span></span></li>`);
    rows.push(`<li><span class="mark-gap" aria-hidden="true"></span><span>Claude in Chrome, which fills in online forms in your Chrome<span class="sub">The app can't check this one. Install <a href="https://claude.ai/chrome" target="_blank" rel="noopener noreferrer">Claude in Chrome</a> and sign in with the same account as Claude Code.</span></span><span></span></li>`);
    computer = `<ul class="checklist">${rows.join("")}</ul><div class="actions"><button class="quiet" data-act="setup-checks">Check again</button></div>`;
  }
  const mailOn = SU.draft.mail.enabled === "yes" && SU.draft.mail.password_saved_at;
  const schedule = group("When it looks", "It runs while this computer is on and you're signed in.",
    select("schedule.frequency", "Look for grants", FREQS, { w: 4 }) + select("schedule.hour", "At", HOURS, { w: 2 }) +
    (mailOn ? select("schedule.mail_frequency", "Read funder emails", FREQS.map(([v, l]) => [v, v === "manual" ? "Only when started by hand" : l]), { w: 4 }) + select("schedule.mail_hour", "At", HOURS, { w: 2 }) : ""));

  let done = "";
  if (SU.finish) {
    done = `<fieldset><legend>${!SU.finish.ok ? "Not everything worked" : SU.firstRun ? "The agent is on" : "Saved"}</legend><ul class="checklist">${SU.finish.steps.map((s) =>
      `<li><span class="${s.ok ? "mark-ok" : "mark-no"}" aria-hidden="true"></span><span>${esc(s.text)}${s.detail ? `<span class="sub">${esc(s.detail)}</span>` : ""}</span><span></span></li>`).join("")}</ul>
      <div class="actions"><button data-act="run-now">Check for grants now</button><button class="quiet" data-act="close-setup">Go to your grants</button></div></fieldset>`;
  }
  const blocked = r.blocking.length > 0;
  return group("What the agent knows", "", `<div class="field">${knows}</div>`) + schedule +
    group("This computer", "", `<div class="field">${computer}</div>`) +
    `<div class="actions finish-go"><button data-act="finish"${blocked ? " disabled" : ""}>${editing() ? "Save and update the schedule" : "Turn on the agent"}</button>
    ${blocked ? `<span class="hint">Add what's marked Needed first.</span>` : ""}</div>` + done;
}

// ── Drawing ─────────────────────────────────────────────────────────────────────
function railHtml() {
  const done = new Set(SU.draft.done);
  return `<nav class="rail" aria-label="Setup steps"><ol>${SU.steps.map((s, i) => {
    const cls = [done.has(s) ? "done" : "", s === SU.step ? "current" : "", s === SU.justDone ? "just-done" : ""].filter(Boolean).join(" ");
    return `<li class="${cls}"><button data-act="setup-go" data-step="${s}"${s === SU.step ? ' aria-current="step"' : ""}>
      <span class="cell" aria-hidden="true"><span class="inner"><span class="fill"></span></span><span class="num">${i + 1}</span></span>
      <span class="rail-label">${esc(STEP_TITLES[s])}<span class="sr">${done.has(s) ? ", done" : ""}</span></span></button></li>`;
  }).join("")}</ol><p class="rail-note">Saved as you type. Stop any time and pick up where you left off.</p></nav>`;
}

function stepbarHtml() {
  const i = SU.steps.indexOf(SU.step);
  const next = SU.steps[i + 1];
  const back = i > 0 ? `<button class="quiet" data-act="setup-back">Back</button>` : "";
  let primary = "";
  if (editing()) {
    primary = SU.step === "finish" ? "" : `<button data-act="setup-save">Save changes</button>`;
    if (next) primary += `<button class="quiet" data-act="setup-next" data-save="0">Next: ${esc(STEP_TITLES[next])}</button>`;
  } else if (SU.step === "welcome") primary = `<button data-act="setup-next">Start</button>`;
  else if (next) primary = `<button data-act="setup-next">Save and continue</button>`;
  return `<div class="stepbar"><span class="saved" id="su-saved" aria-live="polite">${savedText()}</span><div class="go">${back}${primary}</div></div>`;
}

function savedText() {
  if (SU.saving) return "Saving…";
  if (!SU.savedAt) return "";
  const t = new Date(SU.savedAt);
  return isNaN(t) ? "Saved" : `Saved at ${t.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" })}`;
}

function renderSetup(focusTitle) {
  const v = STEP[SU.step]();
  const i = SU.steps.indexOf(SU.step);
  $("setup").innerHTML = `<div class="wrap">${railHtml()}<div class="pane">
    <p class="step-count">Step ${i + 1} of ${SU.steps.length}</p>
    <h1 tabindex="-1" id="su-title"${v.big ? ' class="big"' : ""}>${esc(v.title)}</h1>
    ${v.lede ? `<p class="lede">${esc(v.lede)}</p>` : ""}
    ${v.body}${stepbarHtml()}</div></div>`;
  updateWhen();
  updateCounts();
  SU.justDone = "";
  if (focusTitle) {
    window.scrollTo(0, 0);
    $("su-title").focus({ preventScroll: true });
  }
}

// ── Saving ──────────────────────────────────────────────────────────────────────
let saveTimer = null;
function queueSave() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => saveNow(false), 700);
}
async function saveNow(apply) {
  clearTimeout(saveTimer);
  SU.saving = true;
  const el = $("su-saved");
  if (el) el.textContent = savedText();
  const r = await api.setupSave({ draft: SU.draft, apply });
  SU.saving = false;
  if (r.ok) {
    SU.review = r.review;
    SU.savedAt = new Date().toISOString();
  } else toast(r.error || "That didn't save. Try again.", true);
  const el2 = $("su-saved");
  if (el2) el2.textContent = r.ok ? savedText() : "Not saved";
  return r;
}

// What a step can't go on without. Everything else can be filled in later.
function validate(step) {
  const e = {};
  const need = (p, msg) => {
    if (!String(getPath(p) || "").trim()) e[p] = msg;
  };
  if (step === "business") {
    need("owner.first_name", "Add your first name.");
    need("owner.last_name", "Add your last name.");
    need("owner.email", "Add your email.");
    if (!e["owner.email"] && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(SU.draft.owner.email.trim())) e["owner.email"] = "That doesn't look like an email address.";
    need("business.legal_name", "Add the business's legal name.");
  }
  if (step === "details") need("business.state", "Add the state.");
  return e;
}

async function go(step, { save = true, markDone = false } = {}) {
  if (markDone && !SU.draft.done.includes(SU.step)) {
    SU.draft.done.push(SU.step);
    SU.justDone = SU.step;
  }
  if (save) await saveNow(editing());
  SU.step = step;
  SU.errors = {};
  SU.finish = null;
  SU.mailMsg = null;
  renderSetup(true);
  if (step === "finish") loadChecks();
}

async function loadChecks() {
  SU.checks = null;
  const r = await api.setupChecks();
  SU.checks = r.ok ? r.checks : {};
  if (SU.active && SU.step === "finish") renderSetup(false);
}

// ── Opening and closing ─────────────────────────────────────────────────────────
async function openSetup(edit) {
  const r = await api.setupGet();
  if (!r.ok) {
    toast(r.error || "Setup couldn't be opened.", true);
    return;
  }
  Object.assign(SU, {
    active: true, draft: r.draft, review: r.review, steps: r.steps, results: r.results, platform: r.platform, demo: r.demo,
    savedAt: r.draft.updated_at || "", errors: {}, finish: null, mailMsg: null, checks: null,
    firstRun: !r.draft.completed_at,
  });
  SU.step = edit ? "welcome" : SU.steps.find((s) => !SU.draft.done.includes(s)) || "finish";
  $("dash").hidden = true;
  $("setup").hidden = false;
  render();
  renderSetup(true);
  if (SU.step === "finish") loadChecks();
}

async function closeSetup() {
  if (SU.active && !SU.draft.completed_at) return;
  await saveNow(false);
  SU.active = false;
  $("setup").hidden = true;
  $("dash").hidden = false;
  await refresh(true);
  window.scrollTo(0, 0);
}

// ── Typing and clicking ─────────────────────────────────────────────────────────
function onEdit(e) {
  const el = e.target;
  const p = el.dataset && el.dataset.path;
  if (!p || !SU.active) return;
  if (el.type === "radio" && !el.checked) return;
  setPath(p, el.dataset.check !== undefined ? (el.checked ? "yes" : "no") : el.value);
  if (SU.errors[p]) {
    delete SU.errors[p];
    el.removeAttribute("aria-invalid");
    const err = document.getElementById(`${fid(p)}-e`);
    if (err) err.remove();
  }
  if (/\.amount$/.test(p)) el.setAttribute("aria-invalid", String(!!el.value.trim() && money(el.value) === null));
  // A new address suggests who runs it.
  if (p === "mail.address" && e.type === "change" && !SU.draft.mail.provider) {
    const dom = el.value.split("@")[1] || "";
    const guess = /^(gmail|googlemail)\.com$/i.test(dom) ? "gmail" : /^(icloud|me|mac)\.com$/i.test(dom) ? "icloud"
      : /^yahoo\./i.test(dom) ? "yahoo" : /^(outlook|hotmail|live|msn)\./i.test(dom) ? "microsoft" : "";
    if (guess) {
      SU.draft.mail.provider = guess;
      const radio = document.querySelector(`#setup input[data-path="mail.provider"][value="${guess}"]`);
      if (radio) radio.checked = true;
    }
  }
  updateWhen();
  updateCounts();
  queueSave();
}

const armed = new WeakSet();

async function onClick(e) {
  const b = e.target.closest("#setup [data-act]");
  if (!b) return;
  const { i, j } = b.dataset;
  const projects = SU.draft.money.projects;
  switch (b.dataset.act) {
    case "setup-go":
      go(b.dataset.step);
      break;
    case "setup-back":
      go(SU.steps[SU.steps.indexOf(SU.step) - 1]);
      break;
    case "setup-next": {
      const errors = validate(SU.step);
      if (Object.keys(errors).length) {
        SU.errors = errors;
        renderSetup(false);
        const first = document.querySelector('#setup [aria-invalid="true"]');
        if (first) first.focus();
        toast("A few answers are needed before you go on.", true);
        return;
      }
      go(SU.steps[SU.steps.indexOf(SU.step) + 1], { markDone: b.dataset.save !== "0" || !editing() });
      break;
    }
    case "setup-save": {
      const r = await saveNow(true);
      if (r.ok) toast("Saved. The agent uses this from its next run.");
      break;
    }
    case "proj-add":
      projects.push({ name: "", buys: "", cost_source: "", outcome: "", items: [{ item: "", amount: "" }] });
      renderSetup(false);
      document.getElementById(fid(`money.projects.${projects.length - 1}.name`)).focus();
      queueSave();
      break;
    case "proj-remove":
      // Two clicks, so a project and its prices aren't lost to a slip of the mouse.
      if (!armed.has(b)) {
        armed.add(b);
        b.textContent = "Click again to remove it";
        setTimeout(() => {
          if (b.isConnected) {
            armed.delete(b);
            b.textContent = "Remove project";
          }
        }, 4000);
        return;
      }
      projects.splice(Number(i), 1);
      renderSetup(false);
      queueSave();
      break;
    case "item-add":
      projects[Number(i)].items.push({ item: "", amount: "" });
      renderSetup(false);
      document.querySelector(`#setup input[data-path="money.projects.${i}.items.${projects[Number(i)].items.length - 1}.item"]`).focus();
      queueSave();
      break;
    case "item-remove":
      projects[Number(i)].items.splice(Number(j), 1);
      renderSetup(false);
      queueSave();
      break;
    case "doc-add": {
      await saveNow(false);
      b.disabled = true;
      const r = await api.setupUpload({ key: b.dataset.key });
      if (r.ok) {
        SU.draft.documents = r.documents;
        toast(`Added ${r.names.join(", ")}.`);
        renderSetup(false);
      } else {
        b.disabled = false;
        if (!r.cancelled) toast(r.error || "That file couldn't be added.", true);
      }
      break;
    }
    case "doc-remove": {
      const r = await api.setupRemoveDoc({ key: b.dataset.key, file: b.dataset.file || "" });
      if (r.ok) {
        SU.draft.documents = r.documents;
        toast("Removed. The file itself is still on this computer.");
        renderSetup(false);
      }
      break;
    }
    case "mail-save": {
      const input = $("mail-pw");
      const password = input.value;
      input.value = "";
      if (!password.trim()) {
        toast("Paste the app password first.", true);
        input.focus();
        return;
      }
      await saveNow(false);
      SU.mailBusy = true;
      SU.mailMsg = null;
      renderSetup(false);
      const r = await api.mailPassword({ password });
      SU.mailBusy = false;
      if (r.ok) {
        SU.draft.mail = Object.assign(SU.draft.mail, r.mail);
        SU.mailMsg = { ok: r.signed_in, text: r.signed_in ? "Saved, and it signed in fine." : `Saved, but signing in didn't work: ${r.detail}` };
      } else SU.mailMsg = { ok: false, text: r.error };
      renderSetup(false);
      break;
    }
    case "mail-check": {
      SU.mailBusy = true;
      renderSetup(false);
      const r = await api.mailCheck();
      SU.mailBusy = false;
      if (r.ok) SU.draft.mail = Object.assign(SU.draft.mail, r.mail);
      SU.mailMsg = r.ok ? { ok: r.signed_in, text: r.signed_in ? "It signed in fine." : `Signing in didn't work: ${r.detail}` } : { ok: false, text: r.error };
      renderSetup(false);
      break;
    }
    case "setup-checks":
      loadChecks();
      renderSetup(false);
      break;
    case "finish": {
      await saveNow(false);
      b.disabled = true;
      b.classList.add("busy");
      b.textContent = editing() ? "Saving…" : "Turning it on…";
      const r = await api.setupFinish();
      if (r.ok) {
        if (!SU.draft.done.includes("finish")) {
          SU.draft.done.push("finish");
          SU.justDone = "finish";
        }
        SU.draft.completed_at = SU.draft.completed_at || new Date().toISOString();
        SU.finish = { ok: r.steps.every((s) => s.ok), steps: r.steps };
      } else {
        if (r.review) SU.review = r.review;
        toast(r.error || "That didn't work.", true);
      }
      renderSetup(false);
      const out = document.querySelector("#setup .finish-go ~ fieldset");
      if (out) out.scrollIntoView({ block: "start", behavior: matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth" });
      render();
      break;
    }
  }
}

document.addEventListener("input", onEdit);
document.addEventListener("change", onEdit);
document.addEventListener("click", onClick);
