# Funders

Recurring grant programs worth checking every cycle. `scripts/funder_sweep.py` reads every URL in
the tables below, notices when a page changes, and pulls out open/closed wording and dates, so a
run only opens the pages that moved.

**This list holds no amounts or deadlines on purpose.** They change every cycle, and a stale figure
here would end up in an application. The funder's own page is the only source for what is open,
for how much, and for whom. Pages marked *blocks scripts* answer the sweep with 403 or 429; check
those in the browser when a run has room.

When a run finds a new recurring program, add a row. When a program dies, strike it through with
the date rather than deleting it, so the next run does not rediscover it.

`For` uses the entity names from `config/profile.json`: business, nonprofit, or both.

## Small-business programs (corporate and foundation)
| Program | Page | For | Channel | Notes |
|---|---|---|---|---|
| WomensNet / Amber Grants | https://ambergrantsforwomen.com | business, woman-owned (their page says nonprofits are eligible too) | web form | Monthly awards plus category grants from one application. Check for an application fee against `submission.max_application_fee_usd`. |
| WomensNet grants overview | https://www.womensnet.net | business, woman-owned | web form | Same organization; lists the year's grant calendar. |
| Hello Alice grants | https://helloalice.com/grants | business | signed-in portal | Rolling, sponsor-funded programs, often with narrow eligibility. Needs the client's own account. *Blocks scripts.* |
| NASE Growth Grants | https://www.nase.org | business | web form | Check whether membership is required; a paid membership is a fee, so FOR YOU. |
| Comcast RISE | https://www.comcastrise.com | business | web form | Rounds limited to specific cities; check the client's market. |
| FedEx Small Business Grant Contest | https://www.fedex.com/en-us/small-business/grant-contest.html | business | web form | Contest; check whether any round uses public voting (`targets.allow_public_vote_contests`). |
| Tory Burch Foundation | https://www.toryburchfoundation.org | business, woman-owned | web form | Fellows and capital programs; cohort-based, annual. |
| Cartier Women's Initiative | https://www.cartierwomensinitiative.com | business, woman-led | web form | Annual, international, impact-driven businesses; a long application (treat as Tier B if it asks for uploads). |

## Government
| Program | Page | For | Channel | Notes |
|---|---|---|---|---|
| Grants.gov (all federal) | https://www.grants.gov | both | package | Covered by `scripts/grants_gov_sweep.py`. Needs UEI + active SAM.gov. Always Tier B. |
| SBA grants | https://www.sba.gov/funding-programs/grants | business | package | SBA says it does not give grants to start or grow a business. What it lists: manufacturing grants (Made in America Manufacturing), STEP export grants through states, Empower to Grow, SBIR/STTR. |
| SBA local assistance | https://www.sba.gov/local-assistance | business | none | Finds the client's SBDC and Women's Business Center, the best source for state and city grants. |
| NIST Manufacturing Extension Partnership | https://www.nist.gov/mep | business (manufacturers) | none | Each state's MEP center runs or knows of manufacturer programs. Source, not a grant. |
| USDA Rural Business Development Grants | https://www.rd.usda.gov/programs-services/business-programs/rural-business-development-grants | nonprofit (and public bodies) | package | Paid to organizations that then help rural small businesses; a business benefits through them. *Blocks scripts.* |
| U.S. Economic Development Administration | https://www.eda.gov | nonprofit (and public bodies) | package | Regional programs; mostly not direct to businesses. *Blocks scripts.* |
| SAM.gov | https://www.sam.gov | both | none | Registration and UEI status. The client manages it; the agent only reads it. |

## Nonprofit programs
| Program | Page | For | Channel | Notes |
|---|---|---|---|---|
| Walmart local community grants | https://walmart.org/how-we-give/local-community-grants | nonprofit | signed-in portal | Local store-level grants. |
| Google Ad Grants | https://www.google.com/grants/ | nonprofit | signed-in portal | In-kind search ad credit, not cash. Needs Google for Nonprofits. |
| Community foundation locator | https://www.cof.org/community-foundation-locator | nonprofit | none | Find the client's community foundation, then add its grant page here. *Blocks scripts.* |
| ProPublica Nonprofit Explorer API | https://projects.propublica.org/nonprofits/api | nonprofit | none | Research tool: look up foundations' 990s to see whom they fund and how much. |

## Industry programs
Fill in during setup from what the client actually does. Example for a manufacturing or machining
business, kept only if it fits:

| Program | Page | For | Channel | Notes |
|---|---|---|---|---|
| Gene Haas Foundation | https://www.ghaasfoundation.org | nonprofit | web form | Funds CNC machining education and training programs. Fits only a nonprofit or training arm. |

## State and local
Setup fills this section for the client's state, county and city: the state economic development
agency, the SBDC's grant page, city and county small-business grants, the local chamber, utility
company programs. These are often the best odds for a small business.

| Program | Page | For | Channel | Notes |
|---|---|---|---|---|

## Aggregators (sources only, never apply through them)
| Site | Page | Notes |
|---|---|---|
| GrantWatch | https://www.grantwatch.com | Listings partly paywalled. Find the program, then apply on the funder's page. |
| Instrumentl | https://www.instrumentl.com | Paid. Useful if the client already subscribes. |
| Candid (Foundation Directory) | https://candid.org | Paid. The deepest foundation data. *Blocks scripts.* |
| Submittable | https://www.submittable.com | Not a source: the form platform many foundations use. Applications there need the client's account. |
