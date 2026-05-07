# Deployed-page link surfacing — Implementation Plan

**Goal:** Surface each repo's deployed URL in the portfolio dashboard, per-repo dashboard, agent card, MCP responses, and the `/repo-butler` skill — by enforcing the GitHub `homepage` field as the single canonical source. The butler reads `homepage`; the butler nags repos that should have it set but don't; the apply pipeline auto-sets it when the URL can be derived from a known platform (GitHub Pages); everything else gets an advisory governance finding for the user to fix manually. Closes the ROADMAP "Future" entry "Deployed-page link surfacing" added in PR #185.

**Non-goals:** Multi-source URL discovery (Pages API as a runtime fallback, README badge regex, workflow YAML parsing for deploy-provider detection, `vercel.json` / `netlify.toml` / `CNAME` parsing). Live URL health checks (deploy uptime monitoring is a separate, larger feature). Crawling the deployed pages for any reason.

**Tech stack:** Existing — Node 22 built-ins, no new dependencies.

**Inputs:** Discussion in conversation 2026-05-07. Confirmed `homepage` is not yet captured in `src/observe.js`'s meta block (verified by grep + snapshot meta-keys readout).

---

## The pattern

This is a worked example of "metadata as standard". The butler's job is governance — checking that the same convention is followed across every portfolio repo and surfacing gaps. Picking GitHub's `homepage` field as the canonical source means:

- One read path for everyone: `repo.homepage` from the standard repo-meta endpoint, already fetched.
- One write path: `PATCH /repos/{owner}/{repo}` with `{ homepage: "..." }`.
- One governance finding: "repo deploys but `homepage` is unset".
- One apply template: derive URL from a known platform; open a PR (or dispatch a settings change) to set the field.

The same shape generalises to other metadata-as-standard items: `description`, `topics`, security policy URL, contributing guide URL. Land this one cleanly and the next becomes a copy-paste with a different field name.

---

## Sources of deployed-page URLs

Single source: GitHub's `homepage` field on the repo. Set by the user via repo Settings or the API. Returned by the existing `GET /repos/{owner}/{repo}` call already in `observe()`. Covers GitHub Pages, Vercel, Netlify, Cloudflare Pages, custom domains, anything else, all uniformly.

Weakness: user-maintained. A repo that deploys but doesn't have `homepage` set surfaces no URL. That weakness is the whole reason this plan exists — the butler's job is to detect and close it via governance.

### What the butler does NOT do at runtime

- Does not call the GitHub Pages API as a fallback for repos with `homepage` unset.
- Does not parse `.github/workflows/*.yml` for deploy actions to derive a URL.
- Does not read README badges, `vercel.json`, `netlify.toml`, or `CNAME` files.

The Pages API and the workflow file ARE consulted — but only inside the governance detector, to decide whether to flag the repo. The dashboards, agent card, MCP, and skill all read `homepage` directly. If `homepage` is empty, no link surfaces. The fix path is the apply pipeline, not a runtime fallback.

---

## Sequencing

| PR | Title | Risk |
|----|-------|------|
| 1 | Capture `homepage` in observe + snapshot schema | Low. One field added to the meta block. |
| 2 | Surface in dashboards + agent card + skill | Medium. Touches `report-portfolio.js`, `report-repo.js`, `agent-card.js`, optionally `skills/repo-butler/SKILL.md`. Mechanical but fans out. |
| 3 | Governance finding: `homepage-missing` | Low-medium. Detector queries Pages API + greps workflow files for known deploy actions; flags repos where signals say "deployed" but `homepage` is empty. |
| 4 | Apply template: auto-set `homepage` when derivable (Pages only) | Medium. Adds a third template alongside `code-scanning` and `dependabot` in `src/apply.js`, calling `PATCH /repos/.../{repo}` to set the field. |

PR 1 and PR 2 can ship together if you want; they're both small. PR 3 requires PR 1 to have landed and a snapshot run. PR 4 requires PR 3.

---

## PR 1 — Capture `homepage` in observe + schema

**Files:**
- Modify: `src/observe.js` (`fetchRepoMeta` return shape AND `observePortfolio` portfolio map)
- Modify: `schemas/v1/repository-snapshot.v1.schema.json` (add `meta.homepage` and `meta.has_pages`)
- Modify: `src/observe.test.js` (assert new fields)

### Tasks

- [ ] **Task 1.1: Add `homepage` and `has_pages` to `fetchRepoMeta`**
  - In `src/observe.js`'s `fetchRepoMeta` (~line 355), the `data.homepage` and `data.has_pages` fields from `GET /repos/{owner}/{repo}` are already in scope; add both to the returned object.
  - Normalise empty strings → null with `data.homepage?.trim() || null`.
  - `has_pages` is needed by the governance detector in PR 3 — capturing it here once is cheaper than re-fetching.

- [ ] **Task 1.2: Add the same fields to `observePortfolio`'s portfolio mapping**
  - The portfolio path (`observePortfolio`, ~line 175) builds its own per-repo entry; add `homepage` and `has_pages` to that mapping too so the portfolio dashboard sees them. Without this, `fetchPortfolioDetails` in `src/report-portfolio.js` won't have the field on hand.

- [ ] **Task 1.3: Schema bump**
  - Add `homepage: { type: ['string', 'null'], format: 'uri' }` and `has_pages: { type: 'boolean' }` to the meta object's properties in `schemas/v1/repository-snapshot.v1.schema.json`. Both optional (don't add to `required`).

- [ ] **Task 1.4: Test**
  - One test in `src/observe.test.js` mocking the repo endpoint with `homepage: 'https://example.com'` and `has_pages: true`, asserting both fields appear on `snapshot.meta` and on the portfolio entry. One test mocking `homepage: ''`, asserting `meta.homepage === null`.

**Acceptance:** schema validation tests pass; new field present in a sample snapshot run.

---

## PR 2 — Surface in dashboards, agent card, skill

**Files:**
- Modify: `src/report-portfolio.js` (table row construction)
- Modify: `src/report-repo.js` (per-repo summary block)
- Modify: `src/report-styles.js` (`.deployed-link` icon utility class)
- Modify: `src/agent-card.js` (per-repo skill entry)
- Modify: `skills/repo-butler/SKILL.md` (panel 4 estate flourish — optional)
- Modify: `src/report-portfolio.test.js`, `src/report-repo.test.js`, `src/agent-card.test.js`

### Tasks

- [ ] **Task 2.1: Portfolio table — repo-name icon link**
  - Where the portfolio table renders the repo name as a link to the per-repo dashboard, append a small external-link icon (Unicode ↗ or a CSS pseudo-element) linking to `meta.homepage` when present.
  - `target="_blank" rel="noopener noreferrer"` on the external link.

- [ ] **Task 2.2: Per-repo summary — "Deployed at" row**
  - Add to the existing summary block, between Description and Stars. Render `Deployed at <a href="{homepage}">{homepage}</a>` when present; skip the row when null.

- [ ] **Task 2.3: Agent card — `homepage` per skill entry**
  - Per-repo entries inside `buildAgentCard()` grow a `homepage` field (string or null).

- [ ] **Task 2.4: CSS utility**
  - `.deployed-link::after { content: " ↗"; opacity: 0.6; font-size: 0.85em; }` or equivalent. Reuse the utility-class pattern from PR #146.

- [ ] **Task 2.5: Skill — Reginald estate flourish (optional)**
  - In `skills/repo-butler/SKILL.md` panel 4, add a conditional line: when `≥1` portfolio repo has a `homepage`, Reginald may say "the estate is presented at {top URL}{, and N others}, sir." Stays within the existing 8-entry closing pool by replacing one of the routine-tea closings rather than adding a 9th.

- [ ] **Task 2.6: Tests**
  - Snapshot-style tests for portfolio and per-repo HTML asserting the link renders with `homepage` and is absent without it. Agent-card test asserting the field round-trips.

**Acceptance:** sample snapshot with mixed homepage/no-homepage repos renders correctly across all surfaces.

---

## PR 3 — Governance finding: `homepage-missing`

**Files:**
- Modify: `src/governance.js` (new `detectHomepageMissing()`)
- Modify: `src/governance.test.js`
- Modify: `src/report-portfolio.js` (governance section already renders generic findings)

### Tasks

- [ ] **Task 3.1: Detector**
  - For each portfolio repo where `meta.homepage` is empty, check if the repo "looks deployed" by combining cheap signals:
    - `has_pages: true` from the existing repo-meta call (already known via PR 1)
    - Workflow file matches a known deploy action: `peaceiris/actions-gh-pages`, `actions/deploy-pages`, `vercel/action`, `netlify/actions`, `cloudflare/pages-action`. Use `gh.listDir('.github/workflows/')` and grep each YAML body.
  - If either signal fires, emit a finding with shape:
    ```
    { type: 'standards-gap', tool: 'homepage', repo, signals: ['has_pages', 'vercel-action'] }
    ```
  - The `signals` array distinguishes auto-fixable cases (Pages) from manual ones (everything else) — apply pipeline reads this in PR 4.

- [ ] **Task 3.2: Surfacing**
  - The governance section in `src/report-portfolio.js` already renders findings by tool. The new tool name `homepage` slots in alongside the existing `dependabot`, `code-scanning`, `secret-scanning` rows. No layout change needed.

- [ ] **Task 3.3: Tests**
  - Mock `has_pages: true, homepage: null` → finding emitted with `signals: ['has_pages']`.
  - Mock workflow YAML containing `vercel/action` and `homepage: null` → finding with `signals: ['vercel-action']`.
  - Mock both → finding with both signals.
  - Mock `homepage: 'https://x'` → no finding regardless of signals.

**Acceptance:** repos with deploy signals but no `homepage` surface in the Governance section; repos with `homepage` set never appear regardless of platform.

---

## PR 4 — Apply template: auto-set `homepage` for Pages

**Files:**
- Modify: `src/apply.js` (new template handler)
- Modify: `src/apply.test.js`
- Modify: `.github/workflows/apply.yml` (no change expected; existing dispatch covers it)

### Tasks

- [ ] **Task 4.1: Template handler**
  - For each `homepage-missing` finding where `signals` includes `has_pages`:
    - Call `GET /repos/{owner}/{repo}/pages` to get the actual deployed URL. On 404 (Pages disabled, signals stale) skip silently. On 403 (insufficient token scope) log a `Note: pages API returned 403 for {repo} — check token permissions` line and skip, mirroring the pattern in `fetchDependabotAlerts` (`src/observe.js:411`).
    - Call `PATCH /repos/{owner}/{repo}` with `{ homepage: <url> }`.
    - This is a settings change, not a PR — log it in the run summary instead of opening a PR. Match the existing dry-run / batch-cap / `require_approval` semantics.
  - For findings whose signals are workflow-only (Vercel, Netlify, etc.), the apply skill leaves them alone. The dashboard's Governance section makes the user's manual fix obvious.

- [ ] **Task 4.2: Dry-run output**
  - Dry-run logs `APPLY: would set homepage on {owner}/{repo} to {url}` per repo, with a summary count.

- [ ] **Task 4.3: Tests**
  - Mock pages endpoint → 200 with `html_url`, assert `PATCH` would be called with the right body. Dry-run path asserts no `PATCH` is sent.
  - Findings with no `has_pages` signal → no apply attempt, advisory only.

**Acceptance:** running `apply.yml` against the portfolio with `homepage-missing` findings auto-fixes the Pages cases (dry-run by default), leaves the others advisory.

---

## What this pattern enables next

Once this lands, the same shape works for any repo-metadata standard. Each new "metadata as standard" item is a plug-in:

- A field name (`description`, `topics`, etc.)
- A detector (when is this missing? when does it look wrong?)
- An optional apply template (when can the butler fix it automatically?)

The plumbing — observe captures the field, dashboards surface it, governance flags gaps, apply auto-fixes derivable cases — is reused. Future plans following this template will be much shorter.

---

## Dependencies / order

PRs 1+2 are display-side and additive. PRs 3+4 are governance-side. The two halves are independent — if you only want surfacing without governance, ship 1+2 alone. If you want governance without dashboard changes (unusual), ship 1+3+4 without 2.

The whole programme is gated on the UPDATE prompt soak completing (~2026-05-20) only because we don't want to layer changes during the soak.

---

## Backout

Each PR is independently revertable. PR 1's field gracefully tolerates absence. PR 2 reverts to the previous dashboard layout. PR 3 reverts to no `homepage-missing` findings. PR 4 reverts to no auto-set behaviour, advisory-only governance.

---

## Open questions

None blocking. One worth flagging on review:

- The portfolio table is already crowded after the Dashboard Narrative Restructure (PR #93). The icon-link approach in PR 2 keeps the row width unchanged, but if the icon feels noisy alongside the existing GitHub repo link, consider moving the deployed-URL link into a hover popover or a separate "External" column. Decide during PR 2 review with a sample render.
