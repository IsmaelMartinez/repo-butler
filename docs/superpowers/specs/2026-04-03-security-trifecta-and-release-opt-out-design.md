# Security Trifecta and Release Opt-Out

Date: 2026-04-03

## Problem

The repo-butler health tier model has two blind spots. First, security assessment relies solely on Dependabot alerts, which only covers known CVEs in declared dependencies. GitHub offers two additional free security APIs for public repos (code scanning and secret scanning) that would give a more complete security posture without introducing external tools. Second, the Gold tier requires a release within the last 90 days, which penalises stable, mature repos that don't need frequent releases.

## Feature 1: Security trifecta

### What changes

Three security data sources instead of one: Dependabot alerts (dependency vulnerabilities, already implemented), code scanning alerts (CodeQL/SAST findings in application code), and secret scanning alerts (leaked tokens and credentials).

### Data collection

Two new fetchers in `src/observe.js`, following the existing `fetchDependabotAlerts` pattern:

`fetchCodeScanningAlerts(gh, owner, repo)` calls `GET /repos/{owner}/{repo}/code-scanning/alerts?state=open&per_page=100`. Returns `{ count, critical, high, medium, low, max_severity }` on success, `null` on 403/404 (scanner not configured). Joins the `Promise.all` in `observe()`.

`fetchSecretScanningAlerts(gh, owner, repo)` calls `GET /repos/{owner}/{repo}/secret-scanning/alerts?state=open&per_page=100`. Returns `{ count }` on success, `null` on 403/404. Secret scanning alerts don't have severity levels in the same way, so the shape is simpler.

Both fetchers are also added to `fetchPortfolioDetails()` in `src/report-portfolio.js`, following the same inline pattern used for the existing Dependabot fetch there.

### Summary and snapshot fields

`buildSummary()` in `src/observe.js` gains two new fields: `code_scanning_alert_count` (number or null) and `secret_scanning_alert_count` (number or null).

The portfolio weekly data shape gains `codeScanning` and `secretScanning` fields alongside the existing `vulns` field. The store snapshot in `src/store.js` is updated to persist these.

### Tier logic changes

In `computeHealthTier()` in `src/report-shared.js`, the two existing security checks change:

The "Dependabot/Renovate configured" check becomes "Security scanning configured" — passes if at least one of `vulns`, `codeScanning`, or `secretScanning` is non-null. This means repos that only have Dependabot today don't lose their Gold status.

The "Zero critical/high vulnerabilities" check broadens to: no critical/high Dependabot alerts AND no critical/high/error code scanning alerts AND no open secret scanning alerts. If a scanner returns null (not configured), it's excluded from this check rather than failing it.

### Report changes

The existing vulnerability card in per-repo reports expands to show findings from all three sources. The portfolio summary table gains columns or indicators for which scanners are active per repo.

## Feature 2: Release cadence opt-out

### What changes

Repos can be exempted from the "Release in the last 90 days" Gold requirement via a central config list.

### Configuration

The `DEFAULTS` object in `src/config.js` gains a new top-level key `release_exempt` defaulting to an empty string. Repo names are listed as a comma-separated string in the repo-butler `roadmap.yml`, since the hand-rolled YAML parser only handles flat and one-level-nested keys:

```yaml
release_exempt: sound3fy,some-other-repo
```

At usage time, the string is split on commas and trimmed to produce an array of repo names.

### Tier logic changes

`computeHealthTier()` gains an optional second parameter `options` with shape `{ releaseExempt: boolean }`. When `releaseExempt` is true, the "Release in the last 90 days" check is auto-passed. The default is false, preserving current behaviour.

Callers that have access to config (the portfolio report path in `report-portfolio.js` and the MCP server) resolve whether a repo is exempt before calling `computeHealthTier`. The single-repo path in `report.js` passes the flag from the pipeline context's config.

### No per-repo config

The exemption lives centrally in repo-butler's roadmap.yml. Individual repos don't need any changes.

## Out of scope

External security tools (Snyk, Socket) are not part of this change. The dependency graph/SBOM data already collected is unaffected. The "vitality" alternative to releases (using push/commit activity as a substitute) was considered and deferred — the simple opt-out covers the immediate need.

## Testing

New tests follow the existing colocated `*.test.js` pattern. The new fetchers get unit tests with mocked API responses for success, 403 (not configured), and error cases. The `computeHealthTier` changes get tests covering: the broadened scanner check (any one of three is enough), the broadened vuln check (each scanner's findings are checked independently), and the release exemption flag.
