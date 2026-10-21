# Where Grants Come From

Three lanes, cheapest first. Each run uses all three, then works `data/queue.md`.

## 1. Federal: `scripts/grants_gov_sweep.py`
The public Grants.gov API, filtered to opportunities open to the client's entity types, above the
award floor, and far enough from the deadline to draft a package. Read the ★ rows first; they name
the client's entity type outright. The rest are open to "others" or "unrestricted" and are mostly
research awards, so read the eligibility text before keeping one.

Set expectations with the client early: federal grants to a for-profit small business are mostly
research and development (SBIR/STTR), export (STEP, through the state), and narrow programs like
SBA's manufacturing grants. SBA's own grants page says it does not give grants to start or grow a
business. Federal money for general operations goes to nonprofits and public bodies.

## 2. Known funders: `scripts/funder_sweep.py`
Every program page in `data/funders.md`, checked for changes. Open a page in the browser only when
the sweep says CHANGED or NEW PAGE, or when it is BLOCKED and the program's usual window is near.

## 3. Web search (capped)
At most `6` searches per run, rotated so a week of runs covers all of them. Record which ones ran
in `state/status.md` so the next run takes the next ones. Fill in the client's real state, county,
city and industry from `config/profile.json`.

- `"<state>" small business grant <year>` and `"<state>" economic development grant small business`
- `"<county>" OR "<city>" small business grant`
- `"<city>" community foundation grants`
- `<industry> small business grant <year>` (from `business.industry_description`)
- `woman-owned business grant <year>`, and the same for each ownership fact the client confirmed
- `<utility company in the client's area> small business grant`
- `"<state>" workforce training grant employer` (pays for training employees; common for
  manufacturers)
- For a nonprofit: `"<state>" foundation grants <program area>`, then look the funder up on the
  ProPublica Nonprofit Explorer to see who it actually funds.

A search result is a lead, never a fact. Open the funder's own page, confirm it is open and who is
eligible, and apply there. A recurring program goes into `data/funders.md`.

## Red flags: skip and log the reason
- A fee to apply, to "process", or to "release" an award. (Fee within the client's ceiling is a
  choice for the client, not a scam, but it is never the agent's to pay.)
- Asks for bank login, bank account numbers, or a card to "verify" before an award.
- Guarantees approval, or says the client was "selected" for a grant the client never applied to.
- Uses a government name on a site that is not `.gov`, or reached the client by text, call or
  social media. Federal agencies do not cold-call about grants.
- Charges for SAM.gov registration or a UEI. Registration is free at sam.gov; paid "registration
  services" are not the government.
- Cannot say who funds it, or the "funder" has no history of awards anyone can find.
- A grant "matching service" that charges to send the client listings.

## Calendar hints
- Federal fiscal year starts October 1. Many agencies post forecasts in the fall and winter and
  open in the spring. Forecasted opportunities go on the Watch list.
- Corporate small-business programs often run annual or monthly rounds, and some announce rounds
  only through a newsletter: note in `data/funders.md` when a program says to subscribe.
- Community foundations commonly have one or two cycles a year; record each one's dates once found.
