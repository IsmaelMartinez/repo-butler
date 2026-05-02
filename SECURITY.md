# Security Policy

Repo Butler runs as a GitHub Action with cross-repo write capability. This document covers the trust model, the boundaries we enforce, and how to report a vulnerability.

## Reporting a vulnerability

Please report security issues privately via [GitHub Security Advisories](https://github.com/IsmaelMartinez/repo-butler/security/advisories/new) rather than as public issues. Include reproduction steps, the affected commit or version, and the impact you observed. We aim to acknowledge reports within five working days.

Do not open public issues or PRs for security problems. If a vulnerability is already public elsewhere (e.g. an upstream CVE), open a regular issue and link the advisory.

## Threat model

The butler holds three categories of credential at runtime:

A GitHub App token, generated per-run via `actions/create-github-app-token@v3`, scoped to the App's installations across the portfolio. This token can read and write repos, open PRs, create issues, and update branches on every repo where the App is installed. It is the most privileged credential and the most attractive target.

LLM provider keys (`GEMINI_API_KEY`, `CLAUDE_API_KEY`), used to call hosted LLMs for the ASSESS, UPDATE, IDEATE, and MONITOR phases. Compromise leaks API quota and could be used to exfiltrate prompt content but does not grant access to the portfolio.

An optional `TRIAGE_BOT_INGEST_SECRET` for posting snapshots to a separately-deployed triage bot. Compromise allows a third party to post arbitrary `/ingest` payloads to the configured bot.

All three are stored as GitHub Actions secrets. Workflow files reference them by name and never echo them. The CI workflow runs a secret-leak grep over source files looking for hardcoded API keys (patterns `AIza`, `sk-ant-`, and `sk-[a-zA-Z0-9]{40}`) — `safety.js` and `*.test.js` are excluded because they contain detection patterns and fixtures. Runtime output validation in `safety.js` covers a broader set of patterns including GitHub PATs (`ghp_`, `ghs_`) and is applied to all LLM output before it reaches GitHub.

## Trust boundaries

The butler treats two categories of data as untrusted: repo content read via the GitHub API (issue titles, PR descriptions, comments, README content, label names, contributor names) and any external HTTP response (notably the optional triage bot's `/report/trends` payload).

`src/safety.js` is the only module allowed to interpolate untrusted data into LLM prompts or GitHub-bound output. Every prompt-building function (`buildIdeatePrompt`, `buildAssessPrompt`, `buildUpdatePrompt`) wraps external data in `BEGIN/END REPOSITORY DATA` delimiters with a defence preamble against prompt injection. `sanitizeForPrompt()` strips known injection patterns before LLM ingestion.

For LLM output going back to GitHub, `safety.js` enforces a context-aware URL allowlist (core hosts always permitted, docs hosts only in roadmap context), blocks `@mention` patterns, runs API-key detection, applies XSS prevention, and caps lengths. Every phase that writes to GitHub MUST pass output through these validators.

For SSRF prevention on the optional triage bot integration, `validateBotUrl()` requires the destination host to be on the `TRIAGE_BOT_ALLOWED_HOSTS` allowlist before any HTTP call. URLs discovered from `.github/butler.json` in target repos are not trusted by default — only the `TRIAGE_BOT_URL` env var is treated as pre-vetted.

Repo names are interpolated into generated YAML files by the `Governance Apply` workflow. To prevent template injection via a malicious repo name, every name is validated against `^[a-zA-Z0-9._-]+$` before any template generation. Names that fail are skipped with a warning.

## The `repo-butler-data` branch

All persistent state — snapshots, governance findings, monitor events, report cache keys — lives on a `repo-butler-data` orphan branch in this repository. It is not protected and not backed up; treat it as a cache that can be regenerated. The MCP server (`src/mcp.js`) reads it via `git show`, never via the GitHub API, so MCP clients have local read access only.

The dashboard is published to GitHub Pages from the `reports/` tree on the data branch. Pages is public — anyone on the internet can read your portfolio's repo names, languages, vulnerability counts, and commit activity. For this reason, `observe.js` deliberately filters out private repos returned by privileged endpoints before classification. If you need to dashboard a private portfolio, deploy a private fork rather than relying on the public Pages output.

## Cross-repo writes

The butler opens PRs on other repos in three places: `onboard.js` (CLAUDE.md consumer guide), `apply.js` (governance remediation templates), and the `update.js` roadmap PR (in this repo only). All cross-repo writes are gated:

The `Governance Apply` workflow is manual-dispatch only — it never runs on a cron. It defaults to dry-run (any value other than the literal string `'false'` is treated as dry-run, fail-closed). It enforces a hard cap of 5 PRs per run and processes repos in batches of 3 to stay under GitHub's 30-req/min secondary rate limit. It refuses to run if `config.limits.require_approval` is not set to true. It deduplicates by checking for an existing open PR on the target branch (`repo-butler/apply-{tool}`) before opening a new one.

Auto-onboard runs at the end of the daily pipeline and only acts on repos whose `CLAUDE.md` lacks the `repo-butler` marker — it cannot retarget existing onboarded repos.

## Permissions required

The butler workflow needs these GitHub permissions at minimum: `contents: write` (snapshot persistence to data branch + Pages deploy), `issues: write` (PROPOSE phase), `pull-requests: write` (UPDATE roadmap PR + auto-onboard), `pages: write` and `id-token: write` (Pages deploy), and `security-events: read` (Dependabot/CodeQL/secret-scanning alert counts). The Governance Apply workflow additionally needs an App token with the same scopes on every target repo it might write to.

The default `GITHUB_TOKEN` cannot read Dependabot alerts (lacks `vulnerability_alerts: read`) and cannot list repos across an owner's portfolio. Use a GitHub App token (`actions/create-github-app-token`) for production deployments.

## What we do not protect against

The butler is designed for a single-owner trust model: you, your repos, your tokens. It is not hardened against:

- A malicious maintainer with write access to this repo, who could rewrite `safety.js` or the workflows.
- A malicious upstream LLM provider that returns crafted responses designed to exploit a parser bug.
- A compromised GitHub Actions runner.

If you need stronger isolation, run the Governance Apply workflow in a separate locked-down account.
