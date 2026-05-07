# Deployed-page link surfacing — Implementation Plan

**Goal:** Surface each repo's deployed URL (GitHub Pages, Vercel, Netlify, custom domain, etc.) in the portfolio dashboard, per-repo dashboard, agent card, MCP responses, and the `/repo-butler` skill. Make discovery deterministic and cheap; let the user-set GitHub `homepage` field be the canonical source. Closes the ROADMAP "Future" entry "Deployed-page link surfacing" added in PR #185.

**Non-goals:** Live URL health checks (deploy uptime monitoring is a separate, larger feature). Workflow YAML parsing for deploy-provider detection. README badge regex. Crawling deployed pages for any reason.

**Tech stack:** Existing — Node 22 built-ins, no new dependencies. Schema 2020-12 for the snapshot field. Existing dashboard CSS utility classes for the icon-link styling.

**Inputs:** Discussion in conversation 2026-05-07. Confirmed `homepage` is not yet captured in `src/observe.js`'s meta block (verified by grep + snapshot meta-keys readout).

---

## Sources of deployed-page URLs (ranked)

The implementation uses two sources, both deterministic and cheap. Everything below the line is explicitly out of scope.

### 1. GitHub `homepage` repo field (primary)

The `GET /repos/{owner}/{repo}` endpoint already called by `observe()` returns `homepage` as a string. It is the GitHub-canonical "where this thing is deployed" — set by the user via repo Settings or the API. Covers GitHub Pages, Vercel, Netlify, Cloudflare Pages, custom domains uniformly. Costs zero extra API calls.

Weakness: user-maintained. A repo without `homepage` set surfaces no URL. The remediation is "encourage users to set it" rather than "guess for them" — see PR 4 below for the optional governance nudge.

### 2. GitHub Pages API (fallback)

`GET /repos/{owner}/{repo}/pages` returns the deployed URL when Pages is enabled. Use only when `homepage` is empty AND the meta endpoint's `has_pages` is true. One extra API call per matching repo, cheap, returns 404 cleanly when Pages is disabled.

### Below the line — explicitly out of scope

- README badge regex (fragile; breaks when badge syntax shifts)
- Workflow YAML parsing for `vercel-action` / `netlify-action` / `cloudflare-pages-action` (high maintenance, breaks when action names change)
- `vercel.json` / `netlify.toml` parsing (these don't carry domains anyway)
- `.github/CNAME` / root `CNAME` parsing (GH Pages already covers this via the Pages API)
- Live URL crawling, screenshotting, or status checking (privacy and rate-limit problems against external hosts)

---

## Where to surface

Once captured in the snapshot, the URL appears in five surfaces, each a small mechanical change:

- Portfolio dashboard repo table: small external-link icon next to the repo name, linking to the deployed URL. Hidden when absent. No new column.
- Per-repo dashboard: a "Deployed at" row in the existing summary block, link rendered inline.
- A2A agent card (`reports/.well-known/agent-card.json`): each per-repo skill entry grows a `homepage` field.
- MCP `query_portfolio` and `get_health_tier` responses: the meta block already round-trips through these tools, so the field appears naturally with no tool-schema change.
- `/repo-butler` skill briefing panel 4: optional Reginald flourish — "the estate is presented at {url1} and {url2}, sir" — only when ≥1 deployed repo has a URL. Skipped on lean days.

---

## Sequencing

| PR | Title | Risk |
|----|-------|------|
| 1 | Capture `homepage` and `has_pages` in observe + snapshot schema | Low. Two-line additive change to the meta block. |
| 2 | Pages API fallback fetcher | Low. New `fetchPagesUrl()` returning null on 404, called only when needed. |
| 3 | Surface in dashboards + agent card + skill | Medium. Touches `report-portfolio.js`, `report-repo.js`, `agent-card.js`, and optionally `skills/repo-butler/SKILL.md`. Mechanical but fans out. |
| 4 | Optional: `deployed-without-homepage` governance finding | Low. Detector greps workflow YAML for known deploy action names, flags repos with a deploy workflow and no `homepage`. Closes the PR-1 weakness via the existing apply pipeline. |

PRs 1 and 2 can be combined in a single observe-side PR since both are tiny and touch the same files. PR 3 is the bigger surface-area PR and is best alone. PR 4 is optional and only makes sense after adoption shows real gaps.

---

## PR 1 — Capture `homepage` and `has_pages` in observe + schema

**Files:**
- Modify: `src/observe.js` (meta block construction, ~line 100)
- Modify: `schemas/v1/snapshot.json` (add `meta.homepage`, `meta.has_pages`)
- Modify: `src/observe.test.js` (assert new fields)

### Tasks

- [ ] **Task 1.1: Add `homepage` and `has_pages` to the meta block**
  - In `src/observe.js`, the existing `repo.homepage` and `repo.has_pages` fields from `GET /repos/{owner}/{repo}` are already in scope; just add them to the `meta` object built around line 100.
  - Trim with `.trim?.() || null` for `homepage` to normalise empty strings → null.

- [ ] **Task 1.2: Schema bump**
  - Add `homepage: { type: ['string', 'null'], format: 'uri' }` and `has_pages: { type: 'boolean' }` to the meta object's properties in `schemas/v1/snapshot.json`. Both optional (don't add to `required`).

- [ ] **Task 1.3: Test**
  - One test in `src/observe.test.js` that mocks the repo endpoint with `homepage: 'https://example.com'` and `has_pages: true`, runs observe, and asserts `snapshot.meta.homepage === 'https://example.com'` and `snapshot.meta.has_pages === true`.

**Acceptance:** schema validation tests still pass; new fields present in a sample snapshot run.

---

## PR 2 — Pages API fallback fetcher

**Files:**
- Modify: `src/observe.js` (new fetcher, called from the `Promise.all`)

### Tasks

- [ ] **Task 2.1: `fetchPagesUrl(gh, owner, repo)`**
  - `GET /repos/{owner}/{repo}/pages` via the existing `gh.request()` client.
  - Returns `data.html_url ?? null`.
  - Catches 404 (Pages disabled) and 403 (insufficient scope) — both return null without logging.

- [ ] **Task 2.2: Conditional call**
  - In `observe()`, after the meta block is built: if `meta.homepage` is empty and `meta.has_pages` is true, call `fetchPagesUrl()` and assign the result to `meta.homepage`. Document the precedence in a comment.

- [ ] **Task 2.3: Test**
  - One test for the 200-with-URL path, one for the 404 fallback. Existing observe-test fetch mock pattern applies.

**Acceptance:** repos with Pages enabled and no `homepage` set surface the Pages URL; repos without Pages return null cleanly.

---

## PR 3 — Surface in dashboards, agent card, skill

**Files:**
- Modify: `src/report-portfolio.js` (table row construction)
- Modify: `src/report-repo.js` (per-repo summary block)
- Modify: `src/report-styles.js` (`.deployed-link` icon utility class)
- Modify: `src/agent-card.js` (per-repo skill entry)
- Modify: `skills/repo-butler/SKILL.md` (panel 4 estate flourish — optional)
- Modify: `src/report-portfolio.test.js`, `src/report-repo.test.js`, `src/agent-card.test.js`

### Tasks

- [ ] **Task 3.1: Portfolio table — repo-name icon link**
  - Where the portfolio table renders the repo name as a link to the per-repo dashboard, append a small external-link icon (Unicode ↗ or a CSS pseudo-element) linking to `meta.homepage` when present.
  - `target="_blank" rel="noopener noreferrer"` on the external link.

- [ ] **Task 3.2: Per-repo summary — "Deployed at" row**
  - Add to the existing summary block on the per-repo dashboard, between Description and Stars. Render as `Deployed at <a href="{homepage}">{homepage}</a>` when present; skip the row when null.

- [ ] **Task 3.3: Agent card — `homepage` per skill entry**
  - The per-repo entries inside `buildAgentCard()` grow a `homepage` field (string or null). Stays optional in the AgentCard schema.

- [ ] **Task 3.4: CSS utility (small)**
  - `.deployed-link::after { content: " ↗"; opacity: 0.6; font-size: 0.85em; }` or equivalent. Reuse the existing utility-class pattern from PR #146.

- [ ] **Task 3.5: Skill — Reginald estate flourish (optional)**
  - In `skills/repo-butler/SKILL.md` panel 4 sign-off pool, add a conditional line: when `≥1` portfolio repo has a `homepage`, Reginald may say "the estate is presented at {top URL}{, and N others}, sir." Stays within the existing 8-entry closing pool by replacing one of the routine-tea closings, OR add as a new entry 9 (which would breach the budget — prefer replacement).

- [ ] **Task 3.6: Tests**
  - Snapshot-style tests for portfolio and per-repo HTML asserting the link renders with `homepage` and is absent without it. Agent-card test asserting the field round-trips.

**Acceptance:** sample snapshot with mixed homepage/no-homepage repos renders correctly across all four surfaces; tests cover both branches.

---

## PR 4 — Optional: `deployed-without-homepage` governance finding

**Files:**
- Modify: `src/governance.js` (new `detectDeployedWithoutHomepage()`)
- Modify: `src/governance.test.js`

### Tasks

- [ ] **Task 4.1: Detector**
  - For each portfolio repo with `meta.homepage` empty, fetch `.github/workflows/` directory listing via the existing `gh.listDir()` helper.
  - Grep each workflow YAML body for known deploy actions: `vercel/action`, `netlify/actions`, `cloudflare/pages-action`, `peaceiris/actions-gh-pages`, `actions/deploy-pages`.
  - If any match, emit a `standards-gap` finding with type `deployed-without-homepage` listing the matched action and the repo.

- [ ] **Task 4.2: Apply template (deferred)**
  - The apply pipeline already opens PRs for `code-scanning` and `dependabot` standards gaps. Adding a `homepage` template would automate "set the homepage to {derived URL}", but deriving the URL from the workflow is fragile. Skip the apply template; let the finding be advisory and let the user fix it manually. Document this in the finding body.

- [ ] **Task 4.3: Tests**
  - Mock workflow YAML with each known action name, assert detection. Mock with no deploy actions, assert no finding.

**Acceptance:** repos with a deploy workflow but no homepage surface as a governance finding; the dashboard's Governance section shows them; no PR is opened automatically.

---

## Dependencies / order

PRs 1 and 2 are observe-side and additive; can ship together. PR 3 depends on PR 1+2 having landed and at least one weekly snapshot run so the field is populated. PR 4 is independent of 3 (it's a governance-side feature) and can ship after 1+2 in any order relative to 3.

The whole programme is gated on the UPDATE prompt soak completing (~2026-05-20) only because we don't want to layer changes during the soak.

---

## Backout

PR 1+2 backout: revert the observe + schema commit. Snapshots gracefully tolerate missing fields. PR 3 backout: revert the surfacing commit; existing dashboards keep working without the link. PR 4 backout: trivial — revert the detector.

---

## Open questions

None blocking. One worth flagging on review:

- The portfolio table is already crowded after the Dashboard Narrative Restructure (PR #93). The icon-link approach in PR 3 keeps the row width unchanged, but if the icon feels noisy alongside the existing GitHub repo link, consider moving the deployed-URL link into a hover popover or a separate "External" column. Decide during PR 3 review with a sample render.
