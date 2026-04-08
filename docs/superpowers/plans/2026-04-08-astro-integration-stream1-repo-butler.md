# Astro Integration Stream 1: repo-butler Changes

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Enrich the portfolio-weekly snapshot with pre-computed tiers, fix report cache invalidation, and parallelise libyear computation.

**Architecture:** Three independent improvements to repo-butler that prepare it as a clean data source for the Astro integration. The snapshot gets a `schema_version` field and pre-computed tier data. The cache key includes template file hashes. Libyear runs in batches of 4.

**Tech Stack:** Node 22, ES modules, `node:test` + `node:assert/strict`, zero npm dependencies.

**Spec:** `docs/superpowers/specs/2026-04-08-astro-dashboard-integration-design.md`

---

## File Map

| File | Action | Responsibility |
|------|--------|----------------|
| `src/store.js` | Modify | Add computed tiers and schema_version to `writePortfolioWeekly()` |
| `src/store.test.js` | Modify | Add tests for enriched snapshot format |
| `src/report.js` | Modify | Fix cache key to include template file hashes |
| `src/report-portfolio.js` | Modify | Parallelise libyear computation |
| `src/report.test.js` | Modify | Add cache invalidation test |

---

### Task 1: Enrich portfolio-weekly snapshot with computed tiers

**Files:**
- Modify: `src/store.js:205-232`
- Modify: `src/store.test.js`

The `writePortfolioWeekly()` function currently stores raw metrics. We need to add pre-computed tiers from `computeHealthTier()` and a top-level `schema_version` field.

- [ ] **Step 1: Write failing test for enriched snapshot**

Add to `src/store.test.js`:

```javascript
import { computeHealthTier, isReleaseExempt } from './report-shared.js';

describe('writePortfolioWeekly enrichment', () => {
  it('enrichPortfolioSummary adds computed tier data', async () => {
    // Import the enrichment function we're about to create
    const { enrichPortfolioSummary } = await import('./store.js');
    const summary = {
      open_issues: 0,
      open_bugs: 0,
      commits_6mo: 100,
      stars: 5,
      license: 'MIT',
      communityHealth: 90,
      ciPassRate: 0.98,
      vulns: { count: 0, max_severity: null },
      codeScanning: null,
      secretScanning: { count: 0 },
      ci: 4,
      released_at: new Date().toISOString(),
      pushed_at: new Date().toISOString(),
    };
    const result = enrichPortfolioSummary(summary, 'test-repo', {});
    assert.ok(result.computed, 'should have computed field');
    assert.equal(result.computed.tier, 'gold');
    assert.ok(Array.isArray(result.computed.checks), 'should have checks array');
    assert.equal(result.computed.next_step, null, 'gold repo should have no next step');
  });

  it('enrichPortfolioSummary shows next_step for non-gold repo', async () => {
    const { enrichPortfolioSummary } = await import('./store.js');
    const summary = {
      open_issues: 0,
      open_bugs: 0,
      commits_6mo: 10,
      stars: 0,
      license: null,
      communityHealth: 40,
      ciPassRate: null,
      vulns: null,
      codeScanning: null,
      secretScanning: null,
      ci: 0,
      released_at: null,
      pushed_at: new Date().toISOString(),
    };
    const result = enrichPortfolioSummary(summary, 'test-repo', {});
    assert.ok(result.computed.tier !== 'gold', 'should not be gold');
    assert.ok(result.computed.next_step !== null, 'should have a next step');
  });

  it('buildPortfolioSnapshot includes schema_version', async () => {
    const { buildPortfolioSnapshot } = await import('./store.js');
    const repos = [{ name: 'a', archived: false, fork: false, stars: 1, pushed_at: new Date().toISOString(), open_issues: 0 }];
    const details = { a: { open_issues: 0, open_bugs: 0, commits: 10, license: 'MIT', ci: 2, communityHealth: 80, vulns: null, ciPassRate: 0.9, released_at: new Date().toISOString() } };
    const snapshot = buildPortfolioSnapshot(repos, details, {});
    assert.equal(snapshot.schema_version, 'v1');
    assert.ok(snapshot.repos.a.computed, 'repo should have computed field');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test src/store.test.js`
Expected: FAIL — `enrichPortfolioSummary` and `buildPortfolioSnapshot` not exported yet.

- [ ] **Step 3: Implement enrichPortfolioSummary and buildPortfolioSnapshot**

In `src/store.js`, add the import at the top:

```javascript
import { computeHealthTier, isReleaseExempt } from './report-shared.js';
```

Add two exported functions before `createStore()`:

```javascript
export function enrichPortfolioSummary(summary, repoName, config) {
  const { tier, checks } = computeHealthTier(summary, { releaseExempt: isReleaseExempt(repoName, config) });
  const nextTier = tier === 'none' ? 'bronze' : tier === 'bronze' ? 'silver' : tier === 'silver' ? 'gold' : null;
  const firstFail = nextTier
    ? checks.find(c => !c.passed && (c.required_for === nextTier || (nextTier === 'gold' && c.required_for === 'silver')))
    : null;
  return {
    ...summary,
    computed: {
      tier,
      checks: checks.map(c => ({ name: c.name, passed: c.passed, required_for: c.required_for })),
      next_step: firstFail ? firstFail.name : null,
    },
  };
}

export function buildPortfolioSnapshot(repos, repoDetails, config) {
  const summaries = {};
  for (const r of repos) {
    if (r.archived || r.fork) continue;
    const details = repoDetails[r.name];
    const raw = {
      open_issues: details?.open_issues ?? r.open_issues ?? 0,
      open_bugs: details?.open_bugs ?? null,
      commits_6mo: details?.commits || 0,
      stars: r.stars || 0,
      license: details?.license ?? null,
      communityHealth: details?.communityHealth ?? null,
      ciPassRate: details?.ciPassRate ?? null,
      vulns: details?.vulns ?? null,
      codeScanning: details?.codeScanning ?? null,
      secretScanning: details?.secretScanning ?? null,
      ci: details?.ci ?? 0,
      released_at: details?.released_at ?? null,
      pushed_at: r.pushed_at ?? null,
    };
    summaries[r.name] = enrichPortfolioSummary(raw, r.name, config);
  }
  return { schema_version: 'v1', repos: summaries };
}
```

Then update `writePortfolioWeekly()` to use `buildPortfolioSnapshot()`:

```javascript
async function writePortfolioWeekly(portfolio, repoDetails, config = {}) {
  if (!portfolio?.repos || !repoDetails) return;
  const weekKey = isoWeekKey(new Date());
  const snapshot = buildPortfolioSnapshot(portfolio.repos, repoDetails, config);
  const path = `${PORTFOLIO_WEEKLY_DIR}/${weekKey}.json`;
  await writeFile(path, JSON.stringify(snapshot, null, 2));
  console.log(`Portfolio weekly snapshot saved as ${weekKey} (${Object.keys(snapshot.repos).length} repos)`);
  // ... rest of pruning logic stays the same
}
```

Note: the function signature gains a `config` parameter. Update the caller in `src/report.js` (line ~211) to pass `config`:

```javascript
await store.writePortfolioWeekly(portfolio, repoDetails, config);
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test`
Expected: all pass.

- [ ] **Step 5: Commit**

```bash
git add src/store.js src/store.test.js src/report.js
git commit -m "feat: enrich portfolio snapshot with computed tiers and schema_version"
```

---

### Task 2: Fix report cache invalidation

**Files:**
- Modify: `src/report.js:47-58`
- Modify: `src/store.js:10-14` (computeSnapshotHash)
- Modify: `src/store.test.js`

The cache key currently only includes the snapshot summary data and today's date. Presentation changes to report templates don't invalidate the cache, requiring `force-report=true`. Fix by including a hash of the template files.

- [ ] **Step 1: Write failing test**

Add to `src/store.test.js`:

```javascript
describe('computeSnapshotHash includes template version', () => {
  it('produces different hashes when templateVersion differs', () => {
    const snapshot = { summary: { open_issues: 5 } };
    const a = computeSnapshotHash({ ...snapshot, _templateVersion: 'abc123' });
    const b = computeSnapshotHash({ ...snapshot, _templateVersion: 'def456' });
    assert.notEqual(a, b);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test src/store.test.js`
Expected: PASS (actually, `computeSnapshotHash` hashes the summary, and `_templateVersion` isn't in summary, so both hashes are equal). This test should fail, confirming the bug.

- [ ] **Step 3: Update computeSnapshotHash to include templateVersion**

In `src/store.js`, change `computeSnapshotHash`:

```javascript
export function computeSnapshotHash(snapshot) {
  const summary = snapshot?.summary ?? null;
  const templateVersion = snapshot?._templateVersion ?? '';
  const data = JSON.stringify(summary) + templateVersion;
  return createHash('sha256').update(data).digest('hex');
}
```

- [ ] **Step 4: Compute template hash in report.js**

In `src/report.js`, add the import at the top:

```javascript
import { readFile as fsReadFile } from 'node:fs/promises';
```

Then in the `report()` function, before the cache check (around line 47), compute a hash of the report template files:

```javascript
// Compute template version hash so presentation changes invalidate cache.
const templateFiles = ['src/report-portfolio.js', 'src/report-repo.js', 'src/report-styles.js', 'src/report-shared.js'];
const templateContents = await Promise.all(templateFiles.map(f => fsReadFile(f, 'utf8').catch(() => '')));
const templateVersion = createHash('sha256').update(templateContents.join('')).digest('hex').slice(0, 12);

const dateBucket = new Date().toISOString().slice(0, 10);
const currentHash = store ? computeSnapshotHash({ ...context.snapshot, _dateBucket: dateBucket, _templateVersion: templateVersion }) : null;
```

Also add `createHash` to the import from `node:crypto`:

```javascript
import { createHash } from 'node:crypto';
```

- [ ] **Step 5: Run tests**

Run: `npm test`
Expected: all pass including the new test.

- [ ] **Step 6: Commit**

```bash
git add src/store.js src/store.test.js src/report.js
git commit -m "fix: include template file hash in report cache key"
```

---

### Task 3: Parallelise libyear computation

**Files:**
- Modify: `src/report-portfolio.js:227-234`

The libyear loop runs one repo at a time. Batch into groups of 4 for ~4x speedup.

- [ ] **Step 1: Replace sequential loop with batched parallel**

In `src/report-portfolio.js`, replace the libyear loop (around line 227-234):

```javascript
  // Compute libyear freshness sequentially (one repo at a time) to avoid
  // fanning out concurrent npm registry requests across all repos.
  for (const r of activeRepos.slice(0, 15)) {
    const sbom = details[r.name]?.sbom;
    if (sbom) {
      details[r.name].libyear = await computeLibyearWithTimeout(sbom.packages, 5000);
    }
  }
```

With:

```javascript
  // Compute libyear freshness in batches of 4 to balance speed vs npm registry load.
  const LIBYEAR_BATCH_SIZE = 4;
  const libyearRepos = activeRepos.slice(0, 15).filter(r => details[r.name]?.sbom);
  for (let i = 0; i < libyearRepos.length; i += LIBYEAR_BATCH_SIZE) {
    const batch = libyearRepos.slice(i, i + LIBYEAR_BATCH_SIZE);
    await Promise.all(batch.map(async (r) => {
      details[r.name].libyear = await computeLibyearWithTimeout(details[r.name].sbom.packages, 5000);
    }));
  }
```

- [ ] **Step 2: Run tests**

Run: `npm test`
Expected: all pass (libyear is not directly tested, but report tests should still pass).

- [ ] **Step 3: Commit**

```bash
git add src/report-portfolio.js
git commit -m "perf: parallelise libyear computation in batches of 4"
```

---

### Task 4: Pass config to writePortfolioWeekly

**Files:**
- Modify: `src/report.js:211`

The `writePortfolioWeekly` call in `report.js` needs to pass `config` so the enrichment can compute release exemptions correctly.

- [ ] **Step 1: Check current call**

Read `src/report.js` line ~211. It currently reads:

```javascript
await store.writePortfolioWeekly(portfolio, repoDetails);
```

- [ ] **Step 2: Update to pass config**

```javascript
await store.writePortfolioWeekly(portfolio, repoDetails, config);
```

- [ ] **Step 3: Run tests**

Run: `npm test`
Expected: all pass.

- [ ] **Step 4: Commit**

```bash
git add src/report.js
git commit -m "fix: pass config to writePortfolioWeekly for release exemption"
```

Note: This may already be handled in Task 1 step 3 if implemented together. If so, skip this task.
