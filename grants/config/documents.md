# Narratives, Budgets and Packages

How the agent writes grant answers. The law is the same as everywhere else in this project:
**only facts from `config/answers.md` and `config/profile.json`.** The funder's page tells you what
to emphasize and what the reviewer scores. It never supplies a fact about the client.

Every file for one application lands in `applications/files/<slug>/`, where `<slug>` is
`<funder>-<program>-<cycle>` in lowercase with hyphens (`acme-foundation-growth-grant-2026-11`).
The folder is gitignored with the rest of `applications/`.

## Narrative answers

### Read the program before writing a word
Save the program page to `program.txt`: eligibility, the questions, any scoring criteria, the
funder's stated priorities, and the word or character limit on each answer. Reviewers score
against those criteria, so the answer is organized by them, in their order, using the funder's own
names for things where the client's facts support it. Matching the funder's priorities is the job
here; inventing a fit is not. If the client's facts do not reach a criterion, say less, not more.

### Shape of an answer
- **Lead with the answer.** The first sentence answers the question as asked. "We will use the
  $X to buy a [machine], which lets us [result]." Not background.
- **Then the evidence.** One or two facts from the fact sheet that make the first sentence
  believable: a customer count, a revenue figure, a quote the client got.
- **Then what changes.** The outcome, in the client's own projection, labeled as a projection.
- **Specific beats grand.** "Two part-time machinists" beats "job creation in our community".
- **Stay under the limit with room to spare.** Aim for 85-95% of a word limit. A character limit
  counts spaces; check it with `grant_docs.py lint --max-chars`.

### Which source for which question
| The question asks about | Take it from `answers.md` |
|---|---|
| Describe your business | Boilerplate descriptions, at the length that fits |
| Your story / why you started | The owner's story |
| How will you use the funds | The matching budget preset, plus Need statement |
| Impact, outcomes, jobs | Impact and outcomes |
| What happens after the grant | Sustainability |
| Obstacles, challenges | Challenges overcome |
| Mission (nonprofit) | Nonprofit mission, verbatim |

A question with no matching section and no fact in the fact sheet is NEEDS HUMAN. Write down the
exact question in the log so the client can answer it once and it becomes a new section.

### Voice
Follow the "Writing style" section of `config/answers.md`, and when there is a voice sample, match
its sentence length and formality. Small-business grant judges are often deciding between owners,
so the owner's story should sound like the owner. Plain sentences with real verbs. No em dashes,
no lists of nouns, no grant-speak. `grant_docs.py lint` enforces what a script can see.

## Amount requested and budgets
1. Pick the budget preset in `answers.md` that the program can pay for. Read the program's
   allowable and unallowable costs first: many exclude salaries, debt, real estate, or equipment.
2. Request the smaller of the program's maximum and the preset's total, unless
   `presets.amount_requested_default` says otherwise. A preset larger than the maximum may be
   trimmed to whole line items that fit; never scale a line item.
3. Write the budget as `budget.md`: one `- item: $amount` line per item and a `- Total: $amount`
   line. Run `python3 scripts/grant_docs.py budget applications/files/<slug>/budget.md`. It fails
   on any amount that is not in `answers.md` and on a total that does not add up.
4. No preset fits → NEEDS HUMAN, naming what the program funds so the client can add a preset.

## Packages (Tier B)
A package is everything the client needs to submit a federal, state, or document-based application
in one sitting. Write into `applications/files/<slug>/`:

- `CHECKLIST.md`, first line the deadline in bold. Then every remaining step in order, each with
  who does it: register or renew SAM.gov, confirm the Grants.gov roles, gather a signature, upload
  each file, submit. Flag anything that takes longer than the time left (SAM registration can take
  weeks).
- `program.txt`, the saved notice of funding opportunity summary and its required sections.
- `narrative.md`, organized under the notice's own section headings, each within its page or word
  limit. Linted.
- `budget.md` and `budget-justification.md`, built from a preset. Linted.
- `forms.md`, the values for every standard form field the agent can fill from the profile (for
  SF-424: legal name, EIN, UEI, address, contact, congressional district only if the profile has
  it). Fields with no source are listed as BLANK, never guessed.
- `attachments.md`, every required attachment, its path in `profile.json.documents` if the client
  has it, and MISSING if not.

The agent never logs in to Grants.gov, Login.gov or SAM.gov, never submits, and never contacts the
agency. The checklist is the hand-off.

## Letters of inquiry (Tier C)
One page, about 300-400 words: who the client is (boilerplate), what the project is and what it
costs (a preset), why this funder (their stated priorities, quoted from their own page, and how the
project fits them), and the ask. Save as `inquiry.md`, lint it, and log FOR YOU with the address.
Never send it.

## Things a script can check
```
python3 scripts/grant_docs.py lint <answer.md> [--max-words N] [--max-chars N] [--funder "Name"]
python3 scripts/grant_docs.py budget <budget.md> [--max-award N]
```
Both exit 1 on any FAIL. Fix the draft and rerun until each exits 0. A WARN is a judgment call:
read it, fix it if it is right.
