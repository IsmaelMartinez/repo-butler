# Astro Dashboard Integration

Date: 2026-04-08

## Goal

Replace the standalone GitHub Pages dashboard with Astro components in ismaelmartinez.me.uk that consume repo-butler snapshot data at build time. The personal site gets a `/{lang}/health` page showing portfolio health with the site's own design system. No JavaScript shipped to the browser. Data updates via a daily scheduled rebuild.

## Architecture

Two repos, clean separation of concerns. repo-butler stays as the data collection layer (zero-dependency GitHub Action producing JSON snapshots). The Astro site is the presentation layer, fetching snapshot JSON from the `repo-butler-data` branch at build time via `raw.githubusercontent.com`. No cross-repo tokens, no webhooks, no client-side API calls.

```
repo-butler (GitHub Action, daily 2am UTC)
  → OBSERVE → ASSESS → REPORT
  → writes enriched snapshot to repo-butler-data branch
  → includes pre-computed tiers + schema_version

ismaelmartinez.me.uk (Astro, rebuilds daily 3am UTC + on push)
  → src/data/health.ts fetches snapshot JSON at build time
  → validates with Zod, returns typed data or fallback
  → renders static HTML with site's CSS design system
```

## Changes to repo-butler

### Enrich portfolio-weekly snapshot with computed tiers

Modify `writePortfolioWeekly()` in `src/store.js` to include pre-computed tier results alongside the raw metrics. Currently the snapshot stores raw fields like `communityHealth`, `ciPassRate`, `vulns` etc. and tier computation happens at report time. The enriched format adds a `computed` object per repo:

```json
{
  "schema_version": "v1",
  "repos": {
    "repo-butler": {
      "open_issues": 0,
      "open_bugs": 0,
      "commits_6mo": 175,
      "stars": 2,
      "license": "MIT",
      "communityHealth": 85,
      "ciPassRate": 0.98,
      "vulns": { "count": 0, "max_severity": null },
      "codeScanning": null,
      "secretScanning": { "count": 0 },
      "ci": 4,
      "released_at": "2026-03-31T22:55:25Z",
      "pushed_at": "2026-04-06T20:11:14Z",
      "computed": {
        "tier": "gold",
        "checks": [
          { "name": "Has CI workflows (2+)", "passed": true, "required_for": "gold" },
          { "name": "Has a license", "passed": true, "required_for": "silver" }
        ],
        "next_step": null
      }
    }
  }
}
```

The `computed.tier` is the result of `computeHealthTier()`. The `computed.checks` array mirrors the checks output. The `computed.next_step` is the name of the first failing check scoped to the next tier (or null if all pass). The `schema_version` field sits at the top level.

This change is backward-compatible. The existing `report-portfolio.js` code that reads weekly snapshots won't break because it ignores unknown fields. The Astro site consumes the `computed` fields and uses the raw fields for display (stars, CI%, vulns count, etc).

### Fix report cache invalidation

Include a hash of the report template files in the cache key alongside the snapshot hash. When report code changes, the cache automatically invalidates without needing `force-report=true`. The hash covers `report-portfolio.js`, `report-repo.js`, `report-styles.js`, and `report-shared.js`.

### Parallelise libyear computation

Change the sequential `for...of` loop in `report.js` (line ~228) to batch repos into groups of 4 concurrent computations. This cuts libyear time from ~30s to ~8s without overwhelming the npm registry.

## Changes to ismaelmartinez.me.uk

### Data layer: `src/data/health.ts`

A single TypeScript module that exports `fetchPortfolioHealth()`. At build time, it fetches the latest portfolio-weekly JSON from `https://raw.githubusercontent.com/IsmaelMartinez/repo-butler/repo-butler-data/snapshots/portfolio-weekly/{currentWeek}.json`. If the current week's snapshot doesn't exist yet (e.g. Monday before the pipeline runs), it falls back to the previous week.

The response is validated with a Zod schema using `passthrough()` so unknown fields from future additions are silently accepted. On fetch failure or schema mismatch, returns a fallback `{ available: false, lastUpdated: null, repos: [] }`.

```typescript
import { z } from 'zod';

const RepoHealthSchema = z.object({
  open_issues: z.number(),
  open_bugs: z.number().nullable(),
  commits_6mo: z.number(),
  stars: z.number(),
  license: z.string().nullable(),
  communityHealth: z.number().nullable(),
  ciPassRate: z.number().nullable(),
  vulns: z.object({ count: z.number(), max_severity: z.string().nullable() }).nullable(),
  ci: z.number(),
  pushed_at: z.string().nullable(),
  computed: z.object({
    tier: z.enum(['gold', 'silver', 'bronze', 'none']),
    next_step: z.string().nullable(),
  }).optional(),
}).passthrough();

const SnapshotSchema = z.object({
  schema_version: z.literal('v1'),
  repos: z.record(RepoHealthSchema),
}).passthrough();
```

The function also computes derived values the Astro components need: tier distribution counts, gold percentage, and sorted repo list.

### Page: `src/pages/[lang]/health.astro`

Follows the exact pattern of `projects.astro`: imports `Layout`, calls `getStaticPaths()` with the 3 locales, gets translations via `useTranslations(lang)`. Calls `fetchPortfolioHealth()` for data.

The page structure:

1. Page header with title and description (translated)
2. `TierPulse` component — headline "N% Gold" with tier badge counts
3. `HealthTable` component — repo list with tier, issues, CI%, vulns, next step
4. `<details>` toggle for the full metrics view

If `available` is false, shows a "Health data currently unavailable" message with a link to the standalone dashboard as fallback.

### Components

All pure Astro components (no framework, no hydration, no JavaScript). Styled with the site's CSS custom properties. New tier-specific properties added to `global.css`:

```css
--color-tier-gold: #ffd700;
--color-tier-silver: #c0c0c0;
--color-tier-bronze: #cd7f32;
--color-tier-none: #525252;
```

`TierPulse.astro` — the headline section. Shows the gold percentage as a large number, tier badges below, and a repo count summary. Uses `.card` for the container.

`HealthTable.astro` — the repo health table. Default view: repo name (linked to GitHub), tier badge (CSS-only, using `background-color` from tier custom properties), open issues count, CI pass rate (colour-coded), vulnerability count, and next step text. Mobile layout (below 768px) switches to a stacked card view using the existing `.grid` pattern, showing only repo name, tier badge, and next step. The full metrics view lives inside a `<details>` element.

`PortfolioHealthBadge.astro` — a small inline badge ("14 repos · 93% Gold") for the projects page header, linking to `/{lang}/health`. Only renders if health data is available.

`Sparkline.astro` — generates an inline SVG polyline from a weekly commit array. Pure markup, no JavaScript. Reuses the same algorithm as `generateSparklineSVG()` in repo-butler's `report-portfolio.js`.

### i18n translations

Add a `health.*` namespace to `src/i18n/translations.ts` for all 3 locales:

```typescript
'health.title': 'Portfolio Health',
'health.description': 'Health status across all open source repositories',
'health.pulse.gold': 'Gold',
'health.pulse.silver': 'Silver',
'health.pulse.bronze': 'Bronze',
'health.pulse.repos': 'repos',
'health.table.repo': 'Repo',
'health.table.tier': 'Tier',
'health.table.issues': 'Issues',
'health.table.ci': 'CI%',
'health.table.vulns': 'Vulns',
'health.table.nextStep': 'Next Step',
'health.table.allPass': 'All checks pass',
'health.table.showAll': 'Show all metrics',
'health.unavailable': 'Health data currently unavailable',
'health.badge': 'Portfolio Health',
```

### Navigation

Add "Health" to the nav menu in `Layout.astro`, after "Projects". Translation key: `nav.health`.

### Build pipeline

Add a `schedule` trigger to `.github/workflows/gh-pages.yml` (or `ci.yml` if that's the trigger):

```yaml
on:
  schedule:
    - cron: '0 3 * * *'  # 3am UTC, after repo-butler's 2am run
```

This ensures the site rebuilds daily with fresh snapshot data. The existing `on: push` trigger continues to work for normal deployments.

### Testing

Add to `tests/build/output.test.ts`: verify that `dist/en/health/index.html`, `dist/es/health/index.html`, and `dist/cat/health/index.html` exist in the build output.

Add `tests/data/health.test.ts`: unit test `fetchPortfolioHealth()` with mocked fetch responses (valid JSON, malformed JSON, network error) to verify Zod validation and fallback behaviour.

## What stays the same

The standalone GitHub Pages dashboard at `ismaelmartinez.github.io/repo-butler/` continues to work as a fallback. The repo-butler pipeline, tier logic, MCP server, and all other phases are unchanged. The Astro site's existing pages, design system, and deployment are untouched.

## What gets retired (eventually)

Once the Astro integration is stable and the health page is live, the standalone dashboard can be deprecated. The repo-butler REPORT phase could be simplified to only produce JSON data (no HTML generation), and the GitHub Pages deployment removed. This is a future decision, not part of this implementation.

## Implementation scope

This design spans two repos. The implementation should be split into two independent streams that can be developed and merged separately:

Stream 1 (repo-butler): enrich snapshot with computed tiers, add schema_version, fix cache invalidation, parallelise libyear. These are backward-compatible changes that improve repo-butler regardless of the Astro integration.

Stream 2 (ismaelmartinez.me.uk): data module, components, page, translations, nav update, tests, cron schedule. Depends on Stream 1 being deployed (so the snapshot has computed tiers), but can be developed against a mocked/sample snapshot.
