// The window. All data comes through window.grants (src/preload.js); every button is wired by one
// click listener reading data-act, so the page needs no inline script. Setup lives in setup.js.
const api = window.grants;
const NUM = ["No", "One", "Two", "Three", "Four", "Five", "Six", "Seven", "Eight", "Nine", "Ten"];
const usd = (n) =>
  n == null || n === "" ? "" : new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 }).format(n);
let STATE = null;
let pending = false; // a change arrived while the owner was typing
const drafts = {}; // unsent answers survive refreshes
const open = new Set(); // expanded rows survive refreshes

const $ = (id) => document.getElementById(id);
function esc(s) {
  return String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
}
function parseDay(s) {
  if (!s) return null;
  const [y, m, d] = s.slice(0, 10).split("-").map(Number);
  return y ? new Date(y, m - 1, d) : null;
}
function daysFrom(s) {
  const d = parseDay(s);
  return d ? Math.round((d - parseDay(STATE.today)) / 86400000) : null;
}
function shortDate(s, withDay) {
  const d = s && s.length > 10 ? new Date(s) : parseDay(s);
  if (!d || isNaN(d)) return "";
  return d.toLocaleDateString(
    "en-US",
    withDay
      ? { weekday: "long", month: "long", day: "numeric" }
      : { month: "short", day: "numeric", year: d.getFullYear() !== new Date().getFullYear() ? "numeric" : undefined }
  );
}
function relDays(n) {
  if (n == null) return "";
  if (n === 0) return "today";
  if (n === 1) return "tomorrow";
  if (n === -1) return "yesterday";
  return n > 0 ? `in ${n} days` : `${-n} days ago`;
}
function dueText(a) {
  if (!a.deadline) return "";
  const n = daysFrom(a.deadline);
  const t = `Due ${shortDate(a.deadline)}, ${relDays(n)}`;
  return n != null && n <= 7 ? `<span class="due-soon">${esc(t)}</span>` : esc(t);
}
const title = (a) => `${a.funder}${a.program ? ", " + a.program : ""}`;
const cap = (s) => s.charAt(0).toUpperCase() + s.slice(1);
const listJoin = (p) => (p.length < 3 ? p.join(" and ") : p.slice(0, -1).join(", ") + ", and " + p.at(-1));
const words = (n) => (NUM[n] || String(n)).toLowerCase();
const attrs = (o) => Object.entries(o).map(([k, v]) => ` data-${k}="${esc(v)}"`).join("");
const funderLink = (a) =>
  a.url ? `<a class="button quiet" href="${esc(a.url)}" target="_blank" rel="noopener noreferrer">Open the funder's page</a>` : "";

function md(text) {
  // A small, safe Markdown subset: everything is escaped first.
  const lines = esc(text).split(/\n/);
  let out = "";
  let list = null;
  const inline = (s) =>
    s.replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>").replace(
      /\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g,
      '<a href="$2" target="_blank" rel="noopener noreferrer">$1</a>'
    );
  const close = () => {
    if (list) out += `</${list}>`;
    list = null;
  };
  for (const raw of lines) {
    const l = raw.trimEnd();
    let m;
    if ((m = l.match(/^#{1,2}\s+(.*)/))) { close(); out += `<h3>${inline(m[1])}</h3>`; }
    else if ((m = l.match(/^#{3,6}\s+(.*)/))) { close(); out += `<h4>${inline(m[1])}</h4>`; }
    else if ((m = l.match(/^\s*[-*]\s+(?:\[[ x]\]\s+)?(.*)/))) {
      if (list !== "ul") { close(); out += "<ul>"; list = "ul"; }
      out += `<li>${inline(m[1])}</li>`;
    } else if ((m = l.match(/^\s*\d+[.)]\s+(.*)/))) {
      if (list !== "ol") { close(); out += "<ol>"; list = "ol"; }
      out += `<li>${inline(m[1])}</li>`;
    } else if (!l.trim()) close();
    else { close(); out += `<p>${inline(l)}</p>`; }
  }
  close();
  return out;
}

// ── What goes where ──────────────────────────────────────────────────────────────
const openNeeds = (a) => (a.needs || []).filter((n) => !n.answered_at && !n.done_at);
// Funder emails the owner still has to look at: a decision not yet recorded, or a request for a reply.
const pendingEmail = (a) =>
  (a.email || []).filter(
    (f) => !f.confirmed_at && !f.dismissed_at &&
      (f.kind === "NEEDS_REPLY" || ((f.kind === "AWARDED" || f.kind === "DECLINED") && !a.outcome))
  );
function classify(a) {
  const st = a.status || "";
  if (st === "SKIP" || st === "TOO TIGHT") return "passed";
  if (st === "WATCH") return "later";
  if (st === "SUBMITTED" || a.submitted_by_owner_at) return "sent";
  if (openNeeds(a).length) return "todo";
  if (st === "READY FOR APPROVAL") return a.approved_at ? "working" : "approve";
  if (st === "PACKAGE READY") return "submit";
  return "working";
}
const NEEDS_YOU = ["todo", "approve", "submit"];

// Setup comes first on a folder that was never set up, or whose setup was left half done.
const needsSetup = (s) => !s.configured || (s.setup && s.setup.started && !s.setup.completed);

function header(s) {
  $("biz").textContent = s.business || "";
  document.title = s.business ? `Grants for ${s.business}` : "Grants";
  $("running").hidden = !s.running;
  const buttons = [];
  if (SU.active) {
    $("clock").innerHTML = "";
    if (SU.draft && SU.draft.completed_at) buttons.push(`<button class="quiet" data-act="close-setup">Back to your grants</button>`);
  } else if (!s.needs_folder) {
    buttons.push(`<button class="quiet" data-act="run-now"${s.running ? " disabled" : ""}>Check for grants now</button>`);
    buttons.push(`<button class="quiet" data-act="open-settings">Settings</button>`);
  }
  $("top-actions").innerHTML = buttons.join("");
}

function render() {
  const s = STATE;
  $("demo").hidden = !s.demo;
  const h1 = $("headline");
  const sub = $("subline");
  const heroActions = $("hero-actions");
  heroActions.hidden = true;
  $("tally").hidden = true;

  if (s.needs_folder) {
    header(s);
    $("biz").textContent = "";
    $("clock").innerHTML = "";
    $("running").hidden = true;
    h1.textContent = "First, find your grants folder.";
    h1.className = "";
    sub.textContent = "This app works with the grant agent's files: the folder named grants inside QueenBee. Choose it once and the app remembers.";
    heroActions.innerHTML = `<button data-act="choose-folder">Choose folder</button>`;
    heroActions.hidden = false;
    $("main").innerHTML = $("aside").innerHTML = "";
    return;
  }
  if (!SU.active && needsSetup(s)) {
    openSetup(false);
    return;
  }
  header(s);
  if (SU.active) return;

  const apps = s.applications;
  const clock = [];
  if (s.last_run && s.last_run.finished_at) {
    const t = new Date(s.last_run.finished_at).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" });
    clock.push(`Last checked ${shortDate(s.last_run.finished_at)} at ${t}`);
  }
  clock.push(s.next_run ? `Next check ${shortDate(s.next_run, true)}` : "Checks only when started by hand");
  if (s.inbox_checked_at) clock.push(`Inbox read ${shortDate(s.inbox_checked_at)}`);
  $("clock").innerHTML = clock.map((c) => `<span>${esc(c)}</span>`).join("");

  const by = { todo: [], approve: [], submit: [], sent: [], working: [], later: [], passed: [] };
  apps.forEach((a) => by[classify(a)].push(a));
  const byDeadline = (x, y) => (x.deadline || "9999").localeCompare(y.deadline || "9999");
  Object.values(by).forEach((l) => l.sort(byDeadline));
  const sentAt = (a) => a.submitted_at || a.submitted_by_owner_at || "";
  by.sent.sort((x, y) => sentAt(y).localeCompare(sentAt(x)));

  const needCount = by.todo.reduce((n, a) => n + openNeeds(a).length, 0);
  const inbox = apps.flatMap((a) => pendingEmail(a).map((f) => ({ a, f }))).sort((x, y) => String(y.f.date).localeCompare(String(x.f.date)));
  const total = inbox.length + needCount + by.approve.length + by.submit.length;
  if (total === 0) {
    h1.textContent = "Nothing needs you right now.";
    h1.className = "calm";
    sub.textContent = apps.length
      ? `The agent keeps looking for grants${s.next_run ? " and checks again " + shortDate(s.next_run, true) : ""}.`
      : s.running
        ? "The agent is on its first look for grants. What it finds shows up here as it goes."
        : `The agent hasn't looked for grants yet.${s.next_run ? " Its first check is " + shortDate(s.next_run, true) + ", or start one now." : " Start its first check now."}`;
    if (!apps.length && !s.running) {
      heroActions.innerHTML = `<button data-act="run-now">Check for grants now</button>`;
      heroActions.hidden = false;
    }
  } else {
    h1.textContent = `${NUM[total] || total} ${total === 1 ? "thing needs" : "things need"} you.`;
    h1.className = "";
    const parts = [];
    if (inbox.length) parts.push(`${inbox.length === 1 ? "an email from a funder" : words(inbox.length) + " emails from funders"} to look at`);
    if (needCount) parts.push(`${needCount === 1 ? "a question or task" : words(needCount) + " questions or tasks"} on applications the agent is writing`);
    if (by.approve.length) parts.push(`${by.approve.length === 1 ? "an application" : words(by.approve.length) + " applications"} waiting for your OK`);
    if (by.submit.length) parts.push(`${by.submit.length === 1 ? "a package" : words(by.submit.length) + " packages"} ready for you to submit`);
    sub.textContent = cap(listJoin(parts)) + ".";
  }

  // A plain record of what has happened so far.
  const won = by.sent.filter((a) => a.outcome === "AWARDED");
  if (by.sent.length) {
    const wonSum = won.reduce((n, a) => n + (Number(a.outcome_amount_usd) || 0), 0);
    $("tally").textContent = `So far: ${by.sent.length} sent${won.length ? `, ${won.length} won${wonSum ? " for " + usd(wonSum) : ""}` : ""}.`;
    $("tally").hidden = false;
  }

  let html = "";
  if (inbox.length)
    html += section("From your inbox", "The agent read these emails from funders. Check each one: nothing is recorded until you confirm it.", `<div class="slips">${inbox.map(({ a, f }) => emailSlip(a, f)).join("")}</div>`);
  if (by.todo.length)
    html += section("Help the agent finish", "Answer here and the agent uses it on its next run. Your answers stay on this computer.", `<div class="slips">${by.todo.map(todoSlips).join("")}</div>`);
  if (by.approve.length)
    html += section("Waiting for your OK", "These are written and ready. Read each one, then approve it and the agent sends it on its next run.", `<div class="slips">${by.approve.map(approveSlip).join("")}</div>`);
  if (by.submit.length)
    html += section("Ready for you to submit", "Government and larger grants have to be submitted by you. Everything is prepared; the checklist says what is left.", `<div class="slips">${by.submit.map(submitSlip).join("")}</div>`);
  html += section(
    "Sent",
    by.sent.length ? "" : "Nothing has been sent yet. Applications appear here as soon as they go out.",
    by.sent.length ? `<div class="rows">${by.sent.map(sentRow).join("")}</div>` : ""
  );
  if (by.working.length)
    html += section("The agent is on it", "Nothing needed from you. These move forward on the next run.", `<div class="rows">${by.working.map(workingRow).join("")}</div>`);
  if (by.later.length || by.passed.length) {
    html += `<div class="section">`;
    if (by.later.length) html += `<details class="more"><summary>Opening later <span>(${by.later.length})</span></summary><div class="rows">${by.later.map(laterRow).join("")}</div></details>`;
    if (by.passed.length) html += `<details class="more"><summary>Passed on <span>(${by.passed.length})</span></summary><div class="rows">${by.passed.map(passedRow).join("")}</div></details>`;
    html += `</div>`;
  }
  // Keep open <details> open across a refresh.
  const openDetails = [...document.querySelectorAll("details.more[open] > summary")].map((x) => x.firstChild.textContent);
  $("main").innerHTML = html;
  document.querySelectorAll("details.more > summary").forEach((x) => {
    if (openDetails.includes(x.firstChild.textContent)) x.parentElement.open = true;
  });

  // Application deadlines, plus dates a funder asked for a reply by.
  const upcoming = [
    ...apps
      .filter((a) => a.deadline && daysFrom(a.deadline) >= 0 && [...NEEDS_YOU, "working"].includes(classify(a)))
      .map((a) => ({ date: a.deadline, what: title(a), mine: NEEDS_YOU.includes(classify(a)) })),
    ...inbox
      .filter(({ f }) => f.kind === "NEEDS_REPLY" && f.reply_by && daysFrom(f.reply_by) >= 0)
      .map(({ a, f }) => ({ date: f.reply_by, what: `Reply to ${a.funder}`, mine: true })),
  ].sort((x, y) => x.date.localeCompare(y.date));
  $("aside").innerHTML =
    `<h2>Deadlines</h2>` +
    (upcoming.length
      ? `<ol class="dates">${upcoming
          .map((d) => `<li class="${d.mine ? "mine" : ""}"><div class="when">${esc(shortDate(d.date))}, ${esc(relDays(daysFrom(d.date)))}</div><div class="what">${esc(d.what)}${d.mine ? ". Needs you." : ""}</div></li>`)
          .join("")}</ol>`
      : `<p class="empty-aside">No open deadlines.</p>`);

  for (const [k, v] of Object.entries(drafts)) {
    const el = document.querySelector(`textarea[data-key="${CSS.escape(k)}"]`);
    if (el) el.value = v;
  }
  open.forEach((id) => {
    const el = document.querySelector(`[data-detail="${CSS.escape(id)}"]`);
    if (el) {
      el.hidden = false;
      loadDetail(el);
    }
  });
}
function section(h, lede, body) {
  return `<section class="section"><h2>${esc(h)}</h2>${lede ? `<p class="lede">${esc(lede)}</p>` : ""}${body}</section>`;
}

// ── Slips: things that need the owner ─────────────────────────────────────────────
const slipHead = (a) => `<div class="slip-head"><strong>${esc(title(a))}</strong><span>${dueText(a)}</span></div>`;

function todoSlips(a) {
  return openNeeds(a)
    .map((n) => {
      const key = `${a.slug}--${n.id}`;
      const ids = { slug: a.slug, need: n.id };
      let act;
      if (n.kind === "question") {
        act = `<label class="sr" for="ans-${esc(key)}">Your answer</label><textarea id="ans-${esc(key)}" data-key="${esc(key)}"></textarea>
          <div class="actions"><button data-act="answer"${attrs(ids)}>Send answer</button></div>`;
      } else if (n.kind === "document") {
        act = `<div class="actions"><button data-act="upload"${attrs(ids)}>Choose file and upload</button></div>`;
      } else {
        const go = ["signature", "fee", "login", "submit"].includes(n.kind) ? funderLink(a) : "";
        act = `<div class="actions">${go}<button data-act="done"${attrs(ids)}>I've done this</button></div>`;
      }
      return `<article class="slip">${slipHead(a)}<p class="ask">${esc(n.ask)}</p>${n.why ? `<p class="why">${esc(n.why)}</p>` : ""}${act}</article>`;
    })
    .join("");
}

function docToggle(a, label, file) {
  const id = `${a.slug}::${file || "doc"}`;
  return `<button class="link" data-act="toggle"${attrs({ id })} aria-expanded="${open.has(id)}">${esc(label)}</button>
    <div${attrs({ detail: id, slug: a.slug, file: file || "" })} hidden></div>`;
}

const asking = (a) =>
  `Asking for ${esc(usd(a.amount_requested_usd) || "an amount set by the program")}${a.award_max_usd && a.award_max_usd !== a.amount_requested_usd ? ` of up to ${esc(usd(a.award_max_usd))}` : ""}.`;

function approveSlip(a) {
  return `<article class="slip">${slipHead(a)}<p class="ask">${esc(a.summary || "Ready to send.")}</p>
    <p class="why">${asking(a)}</p>
    ${a.has_doc ? docToggle(a, "Read the application") : ""}
    <div class="actions"><button data-act="approve"${attrs({ slug: a.slug })}>Approve for sending</button></div></article>`;
}

function submitSlip(a) {
  return `<article class="slip">${slipHead(a)}<p class="ask">${esc(a.summary || "The package is ready.")}</p>
    <p class="why">${asking(a)}</p>
    ${a.package_files.includes("CHECKLIST.md") ? docToggle(a, "Read the checklist", "CHECKLIST.md") : ""}
    <div class="actions">${a.package_files.length ? `<button class="quiet" data-act="reveal"${attrs({ slug: a.slug })}>Show the files</button>` : ""}
    ${funderLink(a)}
    <button data-act="submitted"${attrs({ slug: a.slug })}>I submitted it</button></div></article>`;
}

function emailSlip(a, f) {
  const ids = { slug: a.slug, finding: f.id };
  const quote = f.quote ? `<blockquote class="quote">“${esc(f.quote)}”</blockquote>` : "";
  const sender = `<p class="why">From ${esc(f.from)}: “${esc(f.subject)}”</p>`;
  // The application's own deadline is past and beside the point here; the email's date is what matters.
  const head = `<div class="slip-head"><strong>${esc(title(a))}</strong><span>Email from ${esc(shortDate(f.date))}</span></div>`;
  let act;
  if (f.kind === "AWARDED") {
    act = `<div class="actions"><label class="inline-label" for="won-${esc(f.id)}">Amount won, in dollars</label>
      <input type="text" inputmode="decimal" class="amount" id="won-${esc(f.id)}" placeholder="Amount won" value="${f.amount_usd ? esc(f.amount_usd) : ""}"></div>
      <div class="actions"><button data-act="email-confirm"${attrs(ids)}>Record as won</button>
      <button class="quiet" data-act="email-dismiss"${attrs(ids)}>That's not right</button></div>`;
  } else if (f.kind === "DECLINED") {
    act = `<div class="actions"><button data-act="email-confirm"${attrs(ids)}>Record as not selected</button>
      <button class="quiet" data-act="email-dismiss"${attrs(ids)}>That's not right</button></div>`;
  } else {
    const due = f.reply_by
      ? `<span class="${daysFrom(f.reply_by) <= 7 ? "due-soon" : ""}">Reply by ${esc(shortDate(f.reply_by))}, ${esc(relDays(daysFrom(f.reply_by)))}.</span> `
      : "";
    act = `<p class="why">${due}Answer from your own email; the agent never replies.</p>
      <div class="actions"><button data-act="email-confirm"${attrs(ids)}>I've replied</button>
      <button class="quiet" data-act="email-dismiss"${attrs(ids)}>No reply needed</button></div>`;
  }
  return `<article class="slip">${head}<p class="ask">${esc(f.summary)}</p>${quote}${sender}${act}</article>`;
}

// What funders have said, newest first, inside an application's details.
function funderNews(a) {
  const shown = (a.email || []).filter((f) => !f.dismissed_at);
  if (!shown.length) return "";
  return `<div class="news"><h3>From the funder</h3><ul>${shown
    .map((f) => `<li><span class="when">${esc(shortDate(f.date))}</span> ${esc(f.summary)}</li>`)
    .join("")}</ul></div>`;
}

// ── Rows: things already handled ─────────────────────────────────────────────────
function row(a, sub, right, inner) {
  const id = `${a.slug}::row`;
  return `<div class="row"><button class="rowbtn" data-act="toggle"${attrs({ id })} aria-expanded="${open.has(id)}">
    <span class="row-title">${esc(title(a))}</span><span class="row-right">${right}</span><span class="row-sub">${sub}</span></button>
    <div class="detail"${attrs({ detail: id, slug: a.slug, file: "" })} hidden>${inner}</div></div>`;
}
function facts(a) {
  const f = [];
  if (a.amount_requested_usd) f.push(["Asked for", usd(a.amount_requested_usd)]);
  if (a.award_max_usd) f.push(["Program maximum", usd(a.award_max_usd)]);
  if (a.deadline) f.push(["Deadline", shortDate(a.deadline)]);
  if (a.opens) f.push(["Opens", shortDate(a.opens)]);
  const when = a.submitted_at || a.submitted_by_owner_at;
  if (when) f.push(["Sent", shortDate(when) + (a.submitted_by_owner_at && !a.submitted_at ? ", by you" : "")]);
  return `<dl class="facts">${f.map(([k, v]) => `<dt>${esc(k)}</dt><dd>${esc(v)}</dd>`).join("")}</dl>`;
}
function detailBody(a, withOutcome) {
  return `${a.summary ? `<p>${esc(a.summary)}</p>` : ""}${facts(a)}
    <div class="actions">${funderLink(a)}</div>
    ${withOutcome ? outcomeControls(a) : ""}${funderNews(a)}<div class="doc-slot"></div>`;
}
function outcomeControls(a) {
  const ids = { slug: a.slug };
  if (a.outcome === "AWARDED")
    return `<div class="outcome"><span class="pill won">Won ${esc(usd(a.outcome_amount_usd))}</span><button class="link" data-act="outcome" data-outcome=""${attrs(ids)}>Undo</button></div>`;
  if (a.outcome === "DECLINED")
    return `<div class="outcome"><span class="pill">Not selected</span><button class="link" data-act="outcome" data-outcome=""${attrs(ids)}>Undo</button></div>`;
  return `<div class="outcome"><span>Heard back?</span>
    <label class="sr" for="amt-${esc(a.slug)}">Amount won</label><input type="text" inputmode="decimal" id="amt-${esc(a.slug)}" placeholder="Amount won">
    <button class="quiet" data-act="outcome" data-outcome="AWARDED"${attrs(ids)}>We won it</button>
    <button class="quiet" data-act="outcome" data-outcome="DECLINED"${attrs(ids)}>Not selected</button></div>`;
}
function sentRow(a) {
  const when = a.submitted_at || a.submitted_by_owner_at;
  const right =
    a.outcome === "AWARDED" ? `<span class="pill won">Won ${esc(usd(a.outcome_amount_usd))}</span>`
    : a.outcome === "DECLINED" ? `<span class="pill">Not selected</span>`
    : `<span class="pill">Waiting to hear</span>`;
  return row(a, esc(`Sent ${shortDate(when)}${a.amount_requested_usd ? ", asked for " + usd(a.amount_requested_usd) : ""}`), right, detailBody(a, true));
}
function workingRow(a) {
  const why = a.approved_at
    ? "You approved it. The agent sends it on its next run."
    : (a.needs || []).length
      ? "You answered. The agent finishes it on its next run."
      : "The agent is still writing this one.";
  return row(a, esc(why), dueText(a), detailBody(a, false));
}
const laterRow = (a) =>
  row(a, esc(a.opens ? `Opens ${shortDate(a.opens)}` : "Opening date not announced"), a.award_max_usd ? esc("Up to " + usd(a.award_max_usd)) : "", detailBody(a, false));
const passedRow = (a) => row(a, esc(a.summary || "Not a fit."), "", detailBody(a, false));

async function loadDetail(el) {
  const slot = el.classList.contains("detail") ? el.querySelector(".doc-slot") : el;
  if (!slot || slot.dataset.loaded) return;
  slot.dataset.loaded = "1";
  const { slug, file } = el.dataset;
  const a = STATE.applications.find((x) => x.slug === slug);
  let html = "";
  if (file || (a && a.has_doc)) {
    const r = await api.doc({ slug, file });
    if (r.ok) html += `<div class="doc">${md(r.text)}</div>`;
  }
  if (!file && a && a.has_screenshot) {
    const r = await api.screenshot({ slug });
    if (r.ok) html += `<img class="shot" alt="Confirmation page after sending" src="${esc(r.src)}">`;
  }
  slot.innerHTML = html;
}

// ── Actions ─────────────────────────────────────────────────────────────────────
async function act(fn, arg, btn, okMsg) {
  if (btn) btn.disabled = true;
  const r = await fn(arg);
  if (r.ok) {
    toast(typeof okMsg === "function" ? okMsg(r) : okMsg);
    await refresh(true);
  } else {
    if (!r.cancelled) toast(r.error || "That didn't save. Try again.", true);
    if (btn) btn.disabled = false;
    if (r.error && r.error.includes("has changed")) await refresh(true);
  }
  return r;
}

document.addEventListener("input", (e) => {
  const k = e.target.dataset && e.target.dataset.key;
  if (k) drafts[k] = e.target.value;
});

document.addEventListener("click", async (e) => {
  const b = e.target.closest("[data-act]");
  if (!b) return;
  const { slug, need } = b.dataset;
  switch (b.dataset.act) {
    case "toggle": {
      const id = b.dataset.id;
      const el = document.querySelector(`[data-detail="${CSS.escape(id)}"]`);
      const show = el.hidden;
      el.hidden = !show;
      b.setAttribute("aria-expanded", show);
      show ? open.add(id) : open.delete(id);
      if (show) loadDetail(el);
      break;
    }
    case "answer": {
      const key = `${slug}--${need}`;
      const el = document.querySelector(`textarea[data-key="${CSS.escape(key)}"]`);
      if (!el.value.trim()) {
        toast("Write an answer first.", true);
        el.focus();
        return;
      }
      const r = await act(api.answer, { slug, needId: need, answer: el.value }, b, "Answer sent. The agent uses it on its next run.");
      if (r.ok) delete drafts[key];
      break;
    }
    case "upload":
      act(api.upload, { slug, needId: need }, b, (r) => `Uploaded ${r.name}. The agent attaches it on its next run.`);
      break;
    case "done":
      act(api.done, { slug, needId: need }, b, "Marked as done.");
      break;
    case "approve":
      act(api.approve, { slug }, b, "Approved. The agent sends it on its next run.");
      break;
    case "submitted":
      act(api.submitted, { slug }, b, "Marked as submitted. It's now under Sent.");
      break;
    case "reveal": {
      const r = await act(api.reveal, { slug }, b, "Opened the folder.");
      if (r.ok) b.disabled = false;
      break;
    }
    case "outcome": {
      const value = b.dataset.outcome;
      const amt = $(`amt-${slug}`);
      act(api.outcome, { slug, outcome: value, amount: amt ? amt.value : "" }, b,
        value === "AWARDED" ? "Congratulations. Recorded as won." : value === "DECLINED" ? "Recorded as not selected." : "Result cleared.");
      break;
    }
    case "email-confirm": {
      const amt = $(`won-${b.dataset.finding}`);
      act(api.emailConfirm, { slug, findingId: b.dataset.finding, amount: amt ? amt.value : "" }, b, (r) =>
        r.kind === "AWARDED" ? "Congratulations. Recorded as won." : r.kind === "DECLINED" ? "Recorded as not selected." : "Marked as replied.");
      break;
    }
    case "email-dismiss":
      act(api.emailDismiss, { slug, findingId: b.dataset.finding }, b, "Dismissed. Nothing was recorded.");
      break;
    case "choose-folder":
      act(api.chooseFolder, {}, b, "Folder chosen.");
      break;
    case "open-settings":
      openSetup(true);
      break;
    case "close-setup":
      closeSetup();
      break;
    case "run-now": {
      b.disabled = true;
      const r = await api.runNow();
      if (r.ok) {
        toast("The agent is starting. This window updates as it works.");
        if (SU.active) closeSetup();
      } else {
        toast(r.error || "The agent couldn't start.", true);
        b.disabled = false;
      }
      break;
    }
  }
});

let toastTimer;
function toast(msg, bad) {
  const t = $("toast");
  t.textContent = msg;
  t.className = "toast show" + (bad ? " bad" : "");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (t.className = "toast"), 4200);
}

async function refresh(force) {
  // Never redraw under someone's hands: wait until they leave the field.
  const a = document.activeElement;
  if (!force && a && (a.tagName === "TEXTAREA" || a.tagName === "INPUT")) {
    pending = true;
    return;
  }
  pending = false;
  const r = await api.state();
  if (!r.ok) {
    $("headline").textContent = "The grants folder can't be read.";
    $("subline").textContent = r.error || "";
    return;
  }
  STATE = r.state;
  // Setup is drawn by setup.js; a refresh only updates the header, never the owner's half-typed answers.
  if (SU.active) header(STATE);
  else render();
}
document.addEventListener("focusout", () => setTimeout(() => pending && refresh(), 0));

api.onChange(() => refresh());
setInterval(refresh, 60000); // a safety net: watching covers changes, this covers a new day
refresh(true);
