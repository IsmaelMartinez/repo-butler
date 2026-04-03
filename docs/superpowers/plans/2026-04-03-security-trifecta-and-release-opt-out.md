# Security Trifecta and Release Opt-Out Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Broaden repo-butler's security assessment from Dependabot-only to a three-scanner model (Dependabot + code scanning + secret scanning), and allow stable repos to opt out of the 90-day release requirement for Gold tier.

**Architecture:** Two new fetcher functions mirror the existing `fetchDependabotAlerts` pattern. `computeHealthTier` gains an optional `options` parameter for release exemption and its security checks widen to accept any of three scanner sources. Config adds a `release_exempt` comma-separated string.

**Tech Stack:** Node 22, ES modules, node:test, node:assert/strict, zero dependencies.

---

## Tasks

### Task 1: Add code scanning and secret scanning fetchers to observe.js

**Files:**
- Modify: `src/observe.js:287-321` (add two new functions after `fetchDependabotAlerts`)
- Modify: `src/observe.js:12-36` (add to Promise.all destructuring)
- Modify: `src/observe.js:60-77` (add to snapshot return object)
- Modify: `src/observe.js:351-398` (add to buildSummary)
- Test: `src/observe.test.js`

- [ ] **Step 1: Write failing tests for the two new fetchers**

Add to `src/observe.test.js`:

```js
describe('fetchCodeScanningAlerts', () => {
  it('returns structured alert counts on success', async () => {
    const gh = {
      request: async () => [
        { rule: { security_severity_level: 'critical' } },
        { rule: { security_severity_level: 'high' } },
        { rule: { security_severity_level: 'medium' } },
      ],
    };
    const result = await fetchCodeScanningAlerts(gh, 'owner', 'repo');
    assert.deepStrictEqual(result, {
      count: 3, critical: 1, high: 1, medium: 1, low: 0, max_severity: 'critical',
    });
  });

  it('returns null on 403 (not configured)', async () => {
    const gh = { request: async () => { throw new Error('403 Forbidden'); } };
    const result = await fetchCodeScanningAlerts(gh, 'owner', 'repo');
    assert.equal(result, null);
  });

  it('returns null on 404', async () => {
    const gh = { request: async () => { throw new Error('404 Not Found'); } };
    const result = await fetchCodeScanningAlerts(gh, 'owner', 'repo');
    assert.equal(result, null);
  });
});

describe('fetchSecretScanningAlerts', () => {
  it('returns count on success', async () => {
    const gh = {
      request: async () => [
        { state: 'open', secret_type: 'aws_access_key' },
        { state: 'open', secret_type: 'github_token' },
      ],
    };
    const result = await fetchSecretScanningAlerts(gh, 'owner', 'repo');
    assert.deepStrictEqual(result, { count: 2 });
  });

  it('returns null on 403 (not enabled)', async () => {
    const gh = { request: async () => { throw new Error('404 Not Found'); } };
    const result = await fetchSecretScanningAlerts(gh, 'owner', 'repo');
    assert.equal(result, null);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test src/observe.test.js`
Expected: FAIL — `fetchCodeScanningAlerts` and `fetchSecretScanningAlerts` are not defined.

- [ ] **Step 3: Implement the two fetchers in observe.js**

Add after `fetchDependabotAlerts` (after line 321):

```js
async function fetchCodeScanningAlerts(gh, owner, repo) {
  try {
    const data = await gh.request(`/repos/${owner}/${repo}/code-scanning/alerts`, {
      params: { state: 'open', per_page: 100 },
    });
    const alerts = Array.isArray(data) ? data : [];
    const severityOrder = ['critical', 'high', 'medium', 'low'];
    let critical = 0, high = 0, medium = 0, low = 0;
    let maxSeverityIndex = severityOrder.length;

    for (const alert of alerts) {
      const severity = alert.rule?.security_severity_level;
      if (severity === 'critical') { critical++; }
      else if (severity === 'high') { high++; }
      else if (severity === 'medium') { medium++; }
      else if (severity === 'low') { low++; }
      const idx = severityOrder.indexOf(severity);
      if (idx !== -1 && idx < maxSeverityIndex) { maxSeverityIndex = idx; }
    }

    return {
      count: alerts.length,
      critical,
      high,
      medium,
      low,
      max_severity: maxSeverityIndex < severityOrder.length ? severityOrder[maxSeverityIndex] : null,
    };
  } catch (err) {
    if (err.message?.includes('403') || err.message?.includes('404')) {
      console.log(`Note: Code scanning alerts not available for ${owner}/${repo} (${err.message})`);
    }
    return null;
  }
}

async function fetchSecretScanningAlerts(gh, owner, repo) {
  try {
    const data = await gh.request(`/repos/${owner}/${repo}/secret-scanning/alerts`, {
      params: { state: 'open', per_page: 100 },
    });
    const alerts = Array.isArray(data) ? data : [];
    return { count: alerts.length };
  } catch (err) {
    if (err.message?.includes('403') || err.message?.includes('404')) {
      console.log(`Note: Secret scanning alerts not available for ${owner}/${repo} (${err.message})`);
    }
    return null;
  }
}
```

Export both functions for testing (add to existing exports or use named exports if tests import them directly). If tests import from the module, ensure both are exported.

- [ ] **Step 4: Wire fetchers into the observe() Promise.all**

Update the destructuring at lines 12-36 to add `codeScanningAlerts` and `secretScanningAlerts`:

```js
const [
  openIssues,
  closedIssues,
  mergedPRs,
  labels,
  milestones,
  releases,
  workflows,
  repoMeta,
  communityProfile,
  dependabotAlerts,
  ciPassRate,
  codeScanningAlerts,
  secretScanningAlerts,
] = await Promise.all([
  fetchOpenIssues(gh, owner, repo),
  fetchClosedIssues(gh, owner, repo, since),
  fetchMergedPRs(gh, owner, repo, since),
  fetchLabels(gh, owner, repo),
  fetchMilestones(gh, owner, repo),
  fetchReleases(gh, owner, repo, config.observe?.releases_count || 10),
  fetchWorkflows(gh, owner, repo),
  fetchRepoMeta(gh, owner, repo),
  fetchCommunityProfile(gh, owner, repo),
  fetchDependabotAlerts(gh, owner, repo),
  fetchCIPassRate(gh, owner, repo),
  fetchCodeScanningAlerts(gh, owner, repo),
  fetchSecretScanningAlerts(gh, owner, repo),
]);
```

Add to the snapshot return object (after `dependabot_alerts: dependabotAlerts,`):

```js
code_scanning_alerts: codeScanningAlerts,
secret_scanning_alerts: secretScanningAlerts,
```

Add to buildSummary call (pass `codeScanningAlerts` and `secretScanningAlerts`):

```js
summary: buildSummary({
  openIssues, closedIssues, mergedPRs, releases, repoMeta, labels,
  communityProfile, dependabotAlerts, ciPassRate, codeScanningAlerts, secretScanningAlerts,
}),
```

Update `buildSummary` function signature and add new fields to the returned object:

```js
function buildSummary({ openIssues, closedIssues, mergedPRs, releases, repoMeta, labels, communityProfile, dependabotAlerts, ciPassRate, codeScanningAlerts, secretScanningAlerts }) {
  // ... existing code ...
  return {
    // ... existing fields ...
    code_scanning_alert_count: codeScanningAlerts ? codeScanningAlerts.count : null,
    code_scanning_max_severity: codeScanningAlerts?.max_severity ?? null,
    secret_scanning_alert_count: secretScanningAlerts ? secretScanningAlerts.count : null,
  };
}
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `node --test src/observe.test.js`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add src/observe.js src/observe.test.js
git commit -m "feat: add code scanning and secret scanning fetchers to observe"
```

---

### Task 2: Update computeHealthTier for security trifecta and release opt-out

**Files:**
- Modify: `src/report-shared.js:67-105` (update `computeHealthTier`)
- Test: `src/report.test.js:155-300` (add new tier tests)

- [ ] **Step 1: Write failing tests for the broadened security checks**

Add to the `computeHealthTier` describe block in `src/report.test.js`:

```js
it('gold passes security check with only code scanning configured (no dependabot)', () => {
  const r = {
    ci: 2, license: 'MIT', open_issues: 0, pushed_at: now, released_at: now,
    communityHealth: 85, vulns: null, codeScanning: { count: 0, max_severity: null }, secretScanning: null, commits: 50,
  };
  const { tier } = computeHealthTier(r);
  assert.equal(tier, 'gold');
});

it('gold passes security check with only secret scanning configured', () => {
  const r = {
    ci: 2, license: 'MIT', open_issues: 0, pushed_at: now, released_at: now,
    communityHealth: 85, vulns: null, codeScanning: null, secretScanning: { count: 0 }, commits: 50,
  };
  const { tier } = computeHealthTier(r);
  assert.equal(tier, 'gold');
});

it('gold fails security check when no scanner is configured', () => {
  const r = {
    ci: 2, license: 'MIT', open_issues: 0, pushed_at: now, released_at: now,
    communityHealth: 85, vulns: null, codeScanning: null, secretScanning: null, commits: 50,
  };
  const { tier } = computeHealthTier(r);
  assert.equal(tier, 'silver');
});

it('gold fails when code scanning has critical findings', () => {
  const r = {
    ci: 2, license: 'MIT', open_issues: 0, pushed_at: now, released_at: now,
    communityHealth: 85, vulns: { count: 0, max_severity: null },
    codeScanning: { count: 1, max_severity: 'critical' }, secretScanning: null, commits: 50,
  };
  const { tier } = computeHealthTier(r);
  assert.equal(tier, 'silver');
});

it('gold fails when secret scanning has open alerts', () => {
  const r = {
    ci: 2, license: 'MIT', open_issues: 0, pushed_at: now, released_at: now,
    communityHealth: 85, vulns: { count: 0, max_severity: null },
    codeScanning: null, secretScanning: { count: 1 }, commits: 50,
  };
  const { tier } = computeHealthTier(r);
  assert.equal(tier, 'silver');
});
```

- [ ] **Step 2: Write failing tests for the release opt-out**

Add to the same describe block:

```js
it('gold passes release check when releaseExempt option is true', () => {
  const r = {
    ci: 2, license: 'MIT', open_issues: 0, pushed_at: now, released_at: null,
    communityHealth: 85, vulns: { count: 0, max_severity: null }, commits: 50,
  };
  const { tier } = computeHealthTier(r, { releaseExempt: true });
  assert.equal(tier, 'gold');
});

it('gold still fails release check when releaseExempt is false (default)', () => {
  const r = {
    ci: 2, license: 'MIT', open_issues: 0, pushed_at: now, released_at: null,
    communityHealth: 85, vulns: { count: 0, max_severity: null }, commits: 50,
  };
  const { tier } = computeHealthTier(r);
  assert.equal(tier, 'silver');
});
```

- [ ] **Step 3: Run tests to verify they fail**

Run: `node --test src/report.test.js`
Expected: FAIL — new security fields not recognised, options parameter not supported.

- [ ] **Step 4: Update computeHealthTier in report-shared.js**

Replace the function at lines 67-105:

```js
export function computeHealthTier(r, options = {}) {
  const now = Date.now();
  const pushedAt = r.pushed_at ? new Date(r.pushed_at).getTime() : 0;
  const daysSincePush = pushedAt ? Math.floor((now - pushedAt) / 86400000) : Infinity;
  const releasedAt = r.released_at ? new Date(r.released_at).getTime() : 0;
  const daysSinceRelease = releasedAt ? Math.floor((now - releasedAt) / 86400000) : Infinity;

  const anyScannerConfigured = r.vulns != null || r.codeScanning != null || r.secretScanning != null;

  const noSecurityFindings = (() => {
    if (!anyScannerConfigured) return false;
    if (r.vulns != null && (r.vulns.max_severity === 'critical' || r.vulns.max_severity === 'high')) return false;
    if (r.codeScanning != null && (r.codeScanning.max_severity === 'critical' || r.codeScanning.max_severity === 'high')) return false;
    if (r.secretScanning != null && r.secretScanning.count > 0) return false;
    return true;
  })();

  const checks = [
    { name: 'Has CI workflows (2+)', passed: (r.ci || 0) >= 2, required_for: 'gold' },
    { name: 'Has a license', passed: !!(r.license && r.license !== 'None'), required_for: 'silver' },
    { name: 'Fewer than 20 open issues', passed: (r.open_issues || 0) < 20, required_for: 'gold' },
    { name: 'Release in the last 90 days', passed: options.releaseExempt || daysSinceRelease <= 90, required_for: 'gold' },
    { name: 'Community health above 80%', passed: (r.communityHealth ?? -1) >= 80, required_for: 'gold' },
    { name: 'Security scanning configured', passed: anyScannerConfigured, required_for: 'gold' },
    { name: 'Zero critical/high security findings', passed: noSecurityFindings, required_for: 'gold' },
    { name: 'Has CI workflows', passed: (r.ci || 0) >= 1, required_for: 'silver' },
    { name: 'Community health above 50%', passed: (r.communityHealth ?? -1) >= 50, required_for: 'silver' },
    { name: 'Activity in the last 6 months', passed: daysSincePush <= 180, required_for: 'silver' },
    { name: 'Some activity (within 1 year)', passed: (r.commits || 0) > 0 || daysSincePush <= 365, required_for: 'bronze' },
  ];

  const goldChecks = checks.filter(c => c.required_for === 'gold');
  const silverChecks = checks.filter(c => c.required_for === 'silver');
  const bronzeChecks = checks.filter(c => c.required_for === 'bronze');

  let tier;
  if (goldChecks.every(c => c.passed) && silverChecks.every(c => c.passed)) {
    tier = 'gold';
  } else if (silverChecks.every(c => c.passed)) {
    tier = 'silver';
  } else if (bronzeChecks.some(c => c.passed)) {
    tier = 'bronze';
  } else {
    tier = 'none';
  }

  return { tier, checks };
}
```

- [ ] **Step 5: Fix existing tests that reference old check names**

The check names changed from "Dependabot/Renovate configured" to "Security scanning configured" and from "Zero critical/high vulnerabilities" to "Zero critical/high security findings". Update any test assertions that match on those exact names (check `src/report.test.js`, `src/schema.test.js`, `src/governance.test.js`, and `src/ideate.test.js`).

Search for `Dependabot/Renovate configured` and `Zero critical/high vulnerabilities` across all test files and update to the new names.

- [ ] **Step 6: Run tests to verify they pass**

Run: `node --test src/report.test.js`
Expected: PASS

- [ ] **Step 7: Commit**

```bash
git add src/report-shared.js src/report.test.js
git commit -m "feat: broaden health tier to security trifecta and add release opt-out"
```

---

### Task 3: Add release_exempt to config

**Files:**
- Modify: `src/config.js:4-24` (add to DEFAULTS)
- Modify: `.github/roadmap.yml` (add release_exempt)
- Test: `src/config.test.js` (if exists, otherwise inline test)

- [ ] **Step 1: Write failing test for release_exempt parsing**

Check if `src/config.test.js` exists. If not, add a test to verify the config parses comma-separated `release_exempt` correctly. If the existing test file exists, add to it:

```js
it('parses release_exempt as comma-separated list', async () => {
  // Use parseSimpleYaml indirectly via loadConfig or test the parsed output
  const config = await loadConfig('.github/roadmap.yml');
  assert.ok(Array.isArray(config.release_exempt) || typeof config.release_exempt === 'string');
});
```

Since `parseSimpleYaml` returns the raw string value, the split happens at usage time. The test should verify the default is an empty string:

```js
it('defaults release_exempt to empty string', async () => {
  const config = await loadConfig('/nonexistent/path/roadmap.yml');
  assert.equal(config.release_exempt, '');
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test src/config.test.js` (or whatever test file contains this)
Expected: FAIL — `release_exempt` not in DEFAULTS.

- [ ] **Step 3: Add release_exempt to DEFAULTS in config.js**

In `src/config.js`, add to the DEFAULTS object after `'standards-exclude': {}`:

```js
const DEFAULTS = {
  roadmap: { path: 'ROADMAP.md' },
  schedule: { assess: 'daily', ideate: 'weekly' },
  providers: { default: 'gemini' },
  context: '',
  limits: {
    max_issues_per_run: 3,
    require_approval: true,
    labels: {
      proposal: 'roadmap-proposal',
      agent: 'agent-generated',
    },
  },
  observe: {
    issues_closed_days: 90,
    prs_merged_days: 90,
    releases_count: 10,
  },
  standards: {},
  'standards-exclude': {},
  release_exempt: '',
};
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test src/config.test.js`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/config.js src/config.test.js
git commit -m "feat: add release_exempt config option"
```

---

### Task 4: Wire release_exempt into portfolio tier computation

**Files:**
- Modify: `src/report-portfolio.js:450-452` (pass options to computeHealthTier)
- Modify: `src/report.js:225-229` (pass options to computeHealthTier)
- Modify: `src/mcp.js:197,221,332` (pass options to computeHealthTier)
- Modify: `src/governance.js:218` (pass options to computeHealthTier)

- [ ] **Step 1: Create a helper to resolve release exemption**

The pattern repeats across 4 files. Add a utility function to `src/report-shared.js`:

```js
export function isReleaseExempt(repoName, config) {
  const exempt = config?.release_exempt || '';
  return exempt.split(',').map(s => s.trim()).filter(Boolean).includes(repoName);
}
```

- [ ] **Step 2: Write a test for isReleaseExempt**

Add to `src/report.test.js`:

```js
describe('isReleaseExempt', () => {
  it('returns true for listed repos', () => {
    assert.equal(isReleaseExempt('sound3fy', { release_exempt: 'sound3fy,other-repo' }), true);
  });

  it('returns false for unlisted repos', () => {
    assert.equal(isReleaseExempt('repo-butler', { release_exempt: 'sound3fy' }), false);
  });

  it('returns false when config is empty', () => {
    assert.equal(isReleaseExempt('sound3fy', { release_exempt: '' }), false);
  });

  it('returns false when config is missing', () => {
    assert.equal(isReleaseExempt('sound3fy', {}), false);
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `node --test src/report.test.js`
Expected: FAIL — `isReleaseExempt` not defined.

- [ ] **Step 4: Implement and run tests**

Add the function to `src/report-shared.js` and run: `node --test src/report.test.js`
Expected: PASS

- [ ] **Step 5: Update callers to pass releaseExempt option**

In `src/report-portfolio.js` around line 452, the function `generatePortfolioReport` receives config as a parameter. Update the `computeHealthTier` call:

```js
const { tier } = computeHealthTier(r, { releaseExempt: isReleaseExempt(r.name, config) });
```

Import `isReleaseExempt` from `./report-shared.js`.

In `src/report.js` around line 228, the `report()` function has access to `context.config`. Update:

```js
const { tier } = computeHealthTier(classified, { releaseExempt: isReleaseExempt(r.name, context.config) });
```

In `src/mcp.js` at lines 197, 221, and 332, the MCP server loads config differently (it reads from the data branch). Check whether config is accessible. If not, the MCP server can load config from the data branch or accept it as a parameter. For simplicity, the MCP server should load the roadmap.yml config. If config is not currently available in the MCP context, add a `loadConfig` call at startup and pass it through. Update each `computeHealthTier` call:

```js
const { tier, checks } = computeHealthTier(repoData, { releaseExempt: isReleaseExempt(repoName, config) });
```

In `src/governance.js` at line 218, the function receives `config` as a parameter (check the function signature). Update:

```js
const { tier, checks } = computeHealthTier(classified, { releaseExempt: isReleaseExempt(r.name, config) });
```

If `config` is not available in the governance function's scope, thread it through from the caller.

- [ ] **Step 6: Run full test suite**

Run: `node --test src/**/*.test.js`
Expected: PASS

- [ ] **Step 7: Commit**

```bash
git add src/report-shared.js src/report-portfolio.js src/report.js src/mcp.js src/governance.js src/report.test.js
git commit -m "feat: wire release_exempt config into all tier callers"
```

---

### Task 5: Wire new security data into portfolio details and store

**Files:**
- Modify: `src/report-portfolio.js:146-217` (add code scanning and secret scanning fetches)
- Modify: `src/store.js:210-226` (add new fields to weekly snapshot)

- [ ] **Step 1: Add fetchers to fetchPortfolioDetails Promise.all**

In `src/report-portfolio.js` around line 146, the destructuring has 10 parallel fetches. Add two more:

```js
const [commits, weekly, license, ci, communityProfile, vulns, ciPassRate, openIssues, sbom, releasedAt, codeScanning, secretScanning] = await Promise.all([
  // ... existing 10 fetches ...
  gh.request(`/repos/${owner}/${r.name}/code-scanning/alerts?state=open&per_page=100`)
    .then(alerts => {
      const count = alerts.length;
      let maxSeverity = null;
      const severityOrder = { critical: 4, high: 3, medium: 2, low: 1 };
      for (const a of alerts) {
        const sev = a.rule?.security_severity_level;
        if (sev && (maxSeverity === null || (severityOrder[sev] || 0) > (severityOrder[maxSeverity] || 0))) {
          maxSeverity = sev;
        }
      }
      return { count, max_severity: maxSeverity };
    })
    .catch(() => null),
  gh.request(`/repos/${owner}/${r.name}/secret-scanning/alerts?state=open&per_page=100`)
    .then(alerts => ({ count: Array.isArray(alerts) ? alerts.length : 0 }))
    .catch(() => null),
]);
```

Update the details assignment (line 217) to include the new fields:

```js
details[r.name] = { commits, weekly, license, ci, communityHealth, vulns, ciPassRate, open_issues: openIssues, sbom, released_at: releasedAt, hasIssueTemplate, libyear: null, codeScanning, secretScanning };
```

- [ ] **Step 2: Update store.js to persist new fields in weekly snapshots**

In `src/store.js` around line 214-225, add `codeScanning` and `secretScanning` to the summaries object:

```js
summaries[r.name] = {
  open_issues: details?.open_issues ?? r.open_issues ?? 0,
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
```

- [ ] **Step 3: Run full test suite**

Run: `node --test src/**/*.test.js`
Expected: PASS

- [ ] **Step 4: Commit**

```bash
git add src/report-portfolio.js src/store.js
git commit -m "feat: collect code scanning and secret scanning in portfolio details"
```

---

### Task 6: Update report UI to show all three security sources

**Files:**
- Modify: `src/report-repo.js:395-399` (expand vulnerability card)
- Modify: `src/report-repo.js:223-235` (expand action items for new alert types)
- Modify: `src/report-repo.js:322-335` (update snapshotToTierInput)
- Modify: `src/report-portfolio.js:460-466` (update portfolio table vuln display)

- [ ] **Step 1: Update snapshotToTierInput to pass new fields**

In `src/report-repo.js` at lines 322-335, update:

```js
function snapshotToTierInput(snapshot) {
  const cp = snapshot.community_profile;
  const da = snapshot.dependabot_alerts;
  return {
    ci: snapshot.summary?.ci_workflows || 0,
    license: snapshot.license ?? (cp?.files?.license ? 'present' : 'None'),
    open_issues: snapshot.summary?.open_issues || 0,
    pushed_at: snapshot.pushed_at ?? null,
    released_at: snapshot.releases?.[0]?.published_at ?? null,
    communityHealth: cp?.health_percentage ?? null,
    vulns: da,
    codeScanning: snapshot.code_scanning_alerts ?? null,
    secretScanning: snapshot.secret_scanning_alerts ?? null,
    commits: snapshot.summary?.recently_merged_prs || 0,
  };
}
```

- [ ] **Step 2: Expand the vulnerability card in buildHealthSection**

In `src/report-repo.js` at lines 395-399, replace the `vulnHtml` block with an expanded version that shows all three sources:

```js
const vulnHtml = da ? `<div class="card"><h3>Dependabot Alerts</h3>
<div class="stat" style="color:${da.count === 0 ? '#7ee787' : da.critical > 0 || da.high > 0 ? '#f85149' : '#d29922'}">${da.count}</div>
<div class="stat-label" style="margin-top:0.5rem;line-height:1.8">
${da.critical ? `<span style="color:#f85149">${da.critical} critical</span><br>` : ''}${da.high ? `<span style="color:#f85149">${da.high} high</span><br>` : ''}${da.medium ? `<span style="color:#d29922">${da.medium} medium</span><br>` : ''}${da.low ? `<span style="color:#7ee787">${da.low} low</span>` : ''}${da.count === 0 ? 'No open alerts' : ''}
</div></div>` : `<div class="card"><h3>Dependabot Alerts</h3><div class="stat" style="color:#6e7681">\u2014</div><div class="stat-label">unavailable</div></div>`;

const cs = snapshot.code_scanning_alerts;
const codeScanHtml = cs ? `<div class="card"><h3>Code Scanning</h3>
<div class="stat" style="color:${cs.count === 0 ? '#7ee787' : cs.max_severity === 'critical' || cs.max_severity === 'high' ? '#f85149' : '#d29922'}">${cs.count}</div>
<div class="stat-label">${cs.count === 0 ? 'No open alerts' : 'open alerts'}</div></div>` : `<div class="card"><h3>Code Scanning</h3><div class="stat" style="color:#6e7681">\u2014</div><div class="stat-label">unavailable</div></div>`;

const ss = snapshot.secret_scanning_alerts;
const secretScanHtml = ss ? `<div class="card"><h3>Secret Scanning</h3>
<div class="stat" style="color:${ss.count === 0 ? '#7ee787' : '#f85149'}">${ss.count}</div>
<div class="stat-label">${ss.count === 0 ? 'No open alerts' : 'open alerts'}</div></div>` : `<div class="card"><h3>Secret Scanning</h3><div class="stat" style="color:#6e7681">\u2014</div><div class="stat-label">unavailable</div></div>`;
```

Add `codeScanHtml` and `secretScanHtml` to the returned HTML grid alongside `vulnHtml`.

- [ ] **Step 3: Update action items to flag new alert types**

In `src/report-repo.js` at lines 223-235, add after the existing Dependabot action item block:

```js
// Code scanning critical/high alerts.
const cs = snapshot.code_scanning_alerts;
if (cs && (cs.critical > 0 || cs.high > 0)) {
  const parts = [];
  if (cs.critical > 0) parts.push(`${cs.critical} critical`);
  if (cs.high > 0) parts.push(`${cs.high} high`);
  items.push({
    text: `Fix ${parts.join(', ')} <a href="https://github.com/${repo}/security/code-scanning">code scanning alerts</a>`,
    effort: 'moderate',
    impact: 'high',
    priority: 2,
  });
}

// Secret scanning open alerts.
const ss = snapshot.secret_scanning_alerts;
if (ss && ss.count > 0) {
  items.push({
    text: `Resolve ${ss.count} open <a href="https://github.com/${repo}/security/secret-scanning">secret scanning alerts</a>`,
    effort: 'low',
    impact: 'high',
    priority: 1,
  });
}
```

- [ ] **Step 4: Run full test suite**

Run: `node --test src/**/*.test.js`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/report-repo.js src/report-portfolio.js
git commit -m "feat: display code scanning and secret scanning in reports"
```

---

### Task 7: Update roadmap.yml with initial release_exempt list and run full validation

**Files:**
- Modify: `.github/roadmap.yml` (add release_exempt)
- Modify: `CLAUDE.md` (update architecture notes for new security fields)

- [ ] **Step 1: Add release_exempt to roadmap.yml**

```yaml
release_exempt: sound3fy
```

Add as a top-level key in `.github/roadmap.yml`.

- [ ] **Step 2: Update CLAUDE.md**

In the `src/observe.js` description, note the two new fetchers. In the `src/report-shared.js` notes, mention the broadened security check and release opt-out option. Keep it concise — one sentence each.

- [ ] **Step 3: Run full test suite**

Run: `node --test src/**/*.test.js`
Expected: PASS — all existing and new tests green.

- [ ] **Step 4: Commit**

```bash
git add .github/roadmap.yml CLAUDE.md
git commit -m "feat: configure sound3fy as release-exempt, update docs"
```
