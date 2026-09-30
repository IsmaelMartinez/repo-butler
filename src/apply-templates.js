// Pure apply templates and helpers: the static files the governance apply path
// commits, plus the constants and predicates that detection code needs without
// importing the write module. No client, no network — safety.js only.
//
// Auto-merge eligibility is "has a TEMPLATES entry" (apply.js isAutoMergeAllowed),
// so the ADR-012/013/015 classes and code-review-bot must never be added here.

import { codeqlLanguageFor, validateGitHubUsername } from './safety.js';

// Dependabot manager candidates per detectEcosystem() ecosystem, with the root
// manifests that prove each manager applies. Java lists two candidates because
// detectEcosystem confirms it for Maven and Gradle repos alike; the live root
// listing in applyToRepo disambiguates. Keys must track ECOSYSTEM_MAP in
// safety.js — an ecosystem added there without an entry here degrades to a
// github-actions-only config.
const DEPENDABOT_MANAGERS = {
  JavaScript: [{ manager: 'npm', manifests: ['package.json'] }],
  TypeScript: [{ manager: 'npm', manifests: ['package.json'] }],
  Go: [{ manager: 'gomod', manifests: ['go.mod'] }],
  Python: [{ manager: 'pip', manifests: ['requirements.txt', 'pyproject.toml', 'setup.py', 'Pipfile'] }],
  Rust: [{ manager: 'cargo', manifests: ['Cargo.toml'] }],
  Java: [
    { manager: 'maven', manifests: ['pom.xml'] },
    { manager: 'gradle', manifests: ['build.gradle', 'build.gradle.kts'] },
  ],
};

export const TEMPLATES = {
  'code-scanning': {
    path: '.github/workflows/codeql-analysis.yml',
    content: (eco) => {
      const lang = codeqlLanguageFor(eco);
      return `name: CodeQL

on:
  push:
    branches: [main]
  pull_request:
    branches: [main]
  schedule:
    - cron: '0 3 * * 0'

jobs:
  analyze:
    runs-on: ubuntu-latest
    permissions:
      security-events: write
      contents: read
    steps:
      - uses: actions/checkout@v4
        with:
          # The job only reads code; SARIF uploads use the security-events token.
          persist-credentials: false
      - uses: github/codeql-action/init@v3
        with:
          languages: ${lang}
      - uses: github/codeql-action/analyze@v3
`;
    },
  },
  'dependabot-actions': {
    path: '.github/dependabot.yml',
    content: (eco, _owner, rootFiles) => {
      // Candidate Dependabot managers per detectEcosystem() value, each gated
      // on the root manifest that proves it applies. `eco` comes from findings
      // persisted on the data branch, so guard the lookup with Object.hasOwn —
      // a prototype key like 'toString' must miss, not resolve to a Function.
      const candidates = Object.hasOwn(DEPENDABOT_MANAGERS, eco) ? DEPENDABOT_MANAGERS[eco] : [];
      let chosen = null;
      if (Array.isArray(rootFiles)) {
        chosen = candidates.find(c => c.manifests.some(m => rootFiles.includes(m))) || null;
      } else {
        // No live root listing (listing failed, or a caller without one): fall
        // back to the ecosystem's manager only when it is unambiguous. Java is
        // never guessed — this class auto-merges (apply-automerge), so a wrong
        // maven-vs-gradle pick would land unattended and the repo would count
        // as compliant while Dependabot errors on a missing manifest.
        chosen = candidates.length === 1 ? candidates[0] : null;
      }
      const ecosystems = [];
      if (chosen) ecosystems.push({ manager: chosen.manager, directory: '/' });
      ecosystems.push({ manager: 'github-actions', directory: '/' });

      const updates = ecosystems.map(e => `  - package-ecosystem: "${e.manager}"
    directory: "${e.directory}"
    schedule:
      interval: "weekly"`).join('\n');

      return `version: 2
updates:
${updates}
`;
    },
  },
  'issue-form-templates': {
    // A single file in .github/ISSUE_TEMPLATE/ is enough to satisfy the
    // detector (observe.js flips hasIssueTemplate true once the directory has
    // ≥1 entry). The content is deliberately ecosystem-agnostic — a generic
    // bug-report form any repo can use as-is and tailor later.
    path: '.github/ISSUE_TEMPLATE/bug_report.yml',
    content: () => `name: Bug Report
description: Report a problem to help us improve
labels: ["bug"]
body:
  - type: textarea
    id: what-happened
    attributes:
      label: What happened?
      description: Describe the bug and what you expected to happen instead.
    validations:
      required: true
  - type: textarea
    id: steps
    attributes:
      label: Steps to reproduce
      description: How can we reproduce the problem?
    validations:
      required: false
  - type: input
    id: version
    attributes:
      label: Version
      description: Which version or commit are you running?
    validations:
      required: false
`,
  },
  'dependabot-auto-merge': {
    // A single ecosystem-agnostic workflow that auto-merges non-major Dependabot
    // PRs. Uses --squash (matching the proven exemplar): `gh pr merge --auto`
    // with NO method flag errors ("you must specify a merge method") on any repo
    // that has more than one merge method enabled — the GitHub default — so an
    // explicit method is required, not optional. Takes effect only once "Allow
    // auto-merge" is enabled in repo settings and branch protection requires
    // status checks — documented as a PR prerequisite.
    path: '.github/workflows/dependabot-auto-merge.yml',
    content: () => `name: Dependabot auto-merge

on: pull_request

permissions:
  contents: write
  pull-requests: write

jobs:
  auto-merge:
    runs-on: ubuntu-latest
    if: github.event.pull_request.user.login == 'dependabot[bot]'
    steps:
      - name: Fetch Dependabot metadata
        id: metadata
        uses: dependabot/fetch-metadata@v3
        with:
          github-token: \${{ secrets.GITHUB_TOKEN }}

      - name: Enable auto-merge on non-major updates
        if: steps.metadata.outputs.update-type != 'version-update:semver-major'
        env:
          PR_URL: \${{ github.event.pull_request.html_url }}
          GH_TOKEN: \${{ secrets.GITHUB_TOKEN }}
        run: gh pr merge --auto --squash "$PR_URL"
`,
  },
  'codeowners': {
    // Route review of every path to the repo owner. The owner is the GitHub
    // login the apply run targets, so `* @<owner>` is valid and correct for a
    // single-maintainer estate — derived from the owner, not hardcoded, so the
    // standard stays adoptable by other owners. Guard owner before writing: it
    // is interpolated into a file committed on another repo (ADR-005), so it
    // must be a valid GitHub login — a missing owner would ship `* @undefined`,
    // and a newline would inject extra rules. Reject rather than strip, and
    // keep the value out of the message, which apply.js logs.
    path: '.github/CODEOWNERS',
    content: (_eco, owner) => {
      if (!validateGitHubUsername(owner)) {
        throw new Error('codeowners template requires an owner that is a valid GitHub login');
      }
      return `* @${owner}\n`;
    },
  },
  'security-md': {
    // A generic, ecosystem-agnostic security policy that points reporters at
    // GitHub's private vulnerability reporting. No repo-specific contact, so it
    // applies as-is to any repo and can be tailored later.
    path: '.github/SECURITY.md',
    content: () => `# Security Policy

## Reporting a Vulnerability

Please report security vulnerabilities privately rather than opening a public issue.

Use GitHub's private vulnerability reporting on this repository: open the
**Security** tab and choose **Report a vulnerability**. This creates a private
advisory visible only to the maintainers.

We aim to acknowledge reports within a few days and will keep you updated as we
investigate and prepare a fix.

## Supported Versions

Security fixes are applied to the latest released version. Older versions are not
guaranteed to receive updates.
`,
  },
  'release-cadence': {
    // A scheduled patch-release workflow that keeps the "Release in the last
    // 90 days" gold check passing without spamming releases. Ecosystem-agnostic
    // by construction: it only reads git history and calls `gh release create`
    // — it never builds or publishes artifacts. Every ambiguous situation skips
    // rather than guesses: no published release yet (the FIRST release stays a
    // human decision), a non-semver latest tag (won't invent a scheme), no
    // commits since the last release (nothing to release), or a release younger
    // than 60 days (cadence already healthy). Cron fires on the 1st and 15th,
    // so a lapsed repo releases at worst ~75 days after its previous release —
    // comfortably inside the 90-day tier window.
    path: '.github/workflows/release.yml',
    content: () => `name: Scheduled release

# Added by Repo Butler (release-cadence standard). Cuts a patch release with
# generated notes when the latest release is at least 60 days old and unreleased
# commits exist. Skips (never guesses) when there is no published release yet,
# the latest tag is not plain semver, or there is nothing new to release.

on:
  schedule:
    - cron: '0 6 1,15 * *'
  workflow_dispatch:

# A manual dispatch overlapping the cron could race both runs into creating
# the same next tag; serialise instead (never cancel a run mid-release).
concurrency:
  group: \${{ github.workflow }}
  cancel-in-progress: false

# Deliberately only contents: write. \`--generate-notes\` summarises merged pull
# requests, so a \`pull-requests: read\` grant was considered (#327 finding 4) and
# rejected: neither the REST reference nor the release-notes guide documents the
# scope, and the path has never executed here — every scheduled run so far
# skipped on a healthy cadence, so nothing on the estate is evidence either way.
# A declared permissions block sets every unlisted scope to none, so granting on
# an unproven hypothesis widens the token on every repo carrying this template.
# If a first live run fails on it, add it then, with the failure as the evidence.
permissions:
  contents: write

jobs:
  release:
    runs-on: ubuntu-latest
    steps:
      # Pinned to a commit rather than a floating major tag: a moving tag
      # resolves differently in each repo carrying this template, and is a
      # supply-chain surface. The trailing comment records what it resolves to.
      - uses: actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1 # v7.0.1
        with:
          fetch-depth: 0
          # Git operations are read-only (history inspection), so no persisted
          # git credentials are needed; the release write goes through gh,
          # authenticated separately via GH_TOKEN.
          persist-credentials: false

      - name: Cut a patch release when the cadence has lapsed
        env:
          GH_TOKEN: \${{ github.token }}
          DEFAULT_BRANCH: \${{ github.event.repository.default_branch }}
        run: |
          set -euo pipefail
          # A release must come from the default branch, because
          # workflow_dispatch lets any writer choose a ref and a feature branch
          # cut from the latest tag passes every downstream gate — ancestor,
          # commit count, semver — and ships unmerged work.
          #
          # Checked ONLY off the schedule path, and that is load-bearing. The
          # schedule event has no webhook payload, so
          # \${{ github.event.repository.default_branch }} is empty on every cron
          # run; comparing against it unconditionally skips forever and silently
          # disables the standard everywhere it is installed. GitHub documents a
          # scheduled run's GITHUB_REF as the default branch, so there is
          # nothing to verify there — and dispatch, which does carry a payload,
          # is the only path that can go wrong.
          if [ "\${GITHUB_EVENT_NAME:-}" != "schedule" ]; then
            if [ -z "\${DEFAULT_BRANCH:-}" ]; then
              echo "Could not determine the default branch — skipping."
              exit 0
            fi
            if [ "\${GITHUB_REF_NAME:-}" != "$DEFAULT_BRANCH" ]; then
              echo "Running on \${GITHUB_REF_NAME:-unknown}, not the default branch ($DEFAULT_BRANCH) — skipping."
              exit 0
            fi
          fi
          # Keep stderr: discarding it made a 404 (no release yet) and a 500
          # (outage) arrive identically as an empty string, so a real failure
          # reported itself as "the first release stays a human decision" and
          # was undiagnosable from the log. Both still skip — that is correct —
          # but they must say which happened.
          # mktemp failing must skip like every other error here, not go red.
          if ! err=$(mktemp); then
            echo "Could not create a temporary file — skipping."
            exit 0
          fi
          trap 'rm -f "$err"' EXIT
          if ! release=$(gh api "repos/\${GITHUB_REPOSITORY}/releases/latest" --jq '[.tag_name, .published_at] | join(",")' 2>"$err"); then
            # gh's stderr is remote text landing in a public Actions log. Flatten
            # it to one line and neutralise "::" so an error body cannot inject
            # an Actions workflow command (::error::, ::add-mask::), then cap it.
            details=$(tr '\\n\\r' '  ' < "$err" | sed 's/::/:./g' | cut -c1-200)
            # Anchor on gh's rendered status, not a bare "404": a request id or
            # rate-limit body containing those digits was reported as "no
            # release yet", re-creating the conflation this exists to remove.
            case "$details" in
              *"(HTTP 404)"*)
                echo "No published release yet — skipping; the first release stays a human decision." ;;
              *)
                echo "Could not read the latest release — skipping rather than guessing. gh reported: \${details:-no detail}" ;;
            esac
            exit 0
          fi
          if [ -z "$release" ]; then
            echo "Latest release lookup returned nothing — skipping."
            exit 0
          fi
          IFS=',' read -r tag published <<< "$release"
          if [ -z "$tag" ] || [ -z "$published" ]; then
            echo "Incomplete release data retrieved — skipping."
            exit 0
          fi
          if ! published_epoch=$(date -d "$published" +%s 2>/dev/null); then
            echo "Unparseable release date ($published) — skipping rather than failing."
            exit 0
          fi
          age_days=$(( ( $(date +%s) - published_epoch ) / 86400 ))
          if [ "$age_days" -lt 60 ]; then
            echo "Latest release $tag is \${age_days} day(s) old — cadence healthy, skipping."
            exit 0
          fi
          # The only guard here whose absence causes a WRONG RELEASE rather than
          # a skip. A tag cut from a release branch is not reachable from the
          # default branch, so "$tag..HEAD" still counts commits and every
          # downstream gate passes — the workflow then cuts the next patch from
          # unrelated history. Verified: without this, a side-branch v2.0.0
          # produced "release create v2.0.1". Fails closed, since a merge-base
          # error is also a reason not to release.
          # merge-base exits 1 for a genuine non-ancestor and something else
          # (128) when the ref will not resolve at all. Reporting both as "not
          # an ancestor" would assert a branch topology that may not exist —
          # the same false-cause defect findings 2 and 3 exist to remove.
          set +e
          git merge-base --is-ancestor "$tag" HEAD 2>/dev/null
          ancestry=$?
          set -e
          if [ "$ancestry" -eq 1 ]; then
            echo "Latest tag $tag is not an ancestor of HEAD — skipping; releasing from here would ship unrelated history."
            exit 0
          elif [ "$ancestry" -ne 0 ]; then
            echo "Could not resolve $tag against HEAD (git exited $ancestry) — skipping."
            exit 0
          fi
          # Defence in depth. With the ancestry check above passing, rev-list
          # has no remaining way to fail, so this branch is unreachable by
          # construction — kept because it costs nothing and the alternative
          # (defaulting a failure to zero) reported the wrong cause.
          if ! commits=$(git rev-list --count "$tag..HEAD"); then
            echo "Could not count commits since $tag — skipping."
            exit 0
          fi
          if [ "$commits" -eq 0 ]; then
            echo "No commits since $tag — nothing to release, skipping."
            exit 0
          fi
          if [[ "$tag" =~ ^(v?)([0-9]+)\\.([0-9]+)\\.([0-9]+)$ ]]; then
            next="\${BASH_REMATCH[1]}\${BASH_REMATCH[2]}.\${BASH_REMATCH[3]}.$(( 10#\${BASH_REMATCH[4]} + 1 ))"
          else
            echo "Latest tag $tag is not plain semver — skipping rather than guessing a scheme."
            exit 0
          fi
          echo "Cutting $next: $commits commit(s) since $tag (\${age_days} days old)."
          gh release create "$next" --target "\${GITHUB_SHA}" --generate-notes
`,
  },
  'osv-scanner': {
    // Unlike every neighbouring entry, this content is deliberately NOT a
    // function of ecosystem: OSV-Scanner discovers lockfiles itself and the
    // reusable workflows take no language input, so all three content()
    // arguments (eco, owner, rootFiles) are ignored on purpose.
    //
    // `upload-sarif: false` is load-bearing. computeHealthTier
    // (report-shared.js) and detectOpenVulnerabilities (governance.js) both read
    // codeScanning.max_severity, and every repo's code-scanning signal today is
    // CodeQL (SAST only). Uploading SCA advisories into code scanning would drop
    // repos off Gold tier without a single new vulnerability existing.
    //
    // `security-events: write` is REQUIRED even though that upload is disabled.
    // Both called reusable workflows declare it as a job-level permissions block
    // and GitHub validates the caller's grant against that declaration BEFORE
    // any step runs; `upload-sarif: false` gates STEPS, it cannot make a JOB's
    // permission request conditional. Granting less fails the run at validation
    // time on every repo. The rule is: add the permission, never enable the
    // upload.
    //
    // The fork guard on scan-pr is not optional either. On a pull_request from a
    // fork GitHub caps GITHUB_TOKEN at read-only regardless of the permissions
    // key, so the static security-events: write request fails validation and the
    // job never starts — without the guard every external contributor's PR gets
    // a failing check.
    //
    // `fail-on-vuln: true` on scan-scheduled is the ONLY reporting channel that
    // job has, and an earlier draft set it false — which left the weekly scan
    // completely mute. At this pinned SHA the reusable workflow's three outputs
    // are the SARIF upload (gated on upload-sarif), GitHub annotations
    // (hard-coded off upstream via --gh-annotations=false) and the process exit
    // code (gated on fail-on-vuln). With the first two unavailable to us, the
    // exit code is all that is left, so a red job IS the report. `export-results`
    // is not a fourth option: at this SHA the scanner writes results.json while
    // the export step tests for osv-results.json, so it always yields nothing.
    // The cost is that a repo carrying a vulnerability backlog shows a failing
    // weekly run, which feeds ciPassRate — accepted deliberately, because a scan
    // nobody can hear is worse than a noisy one.
    path: '.github/workflows/osv-scanner.yml',
    content: () => `name: OSV-Scanner

on:
  pull_request:
  schedule:
    - cron: '0 4 * * 1'

permissions:
  contents: read
  actions: read
  security-events: write

jobs:
  scan-pr:
    if: >-
      github.event_name == 'pull_request' &&
      github.event.pull_request.head.repo.full_name == github.repository
    uses: google/osv-scanner-action/.github/workflows/osv-scanner-reusable-pr.yml@8deb546fdb875b9996d27d4950be7312dac076a1 # v2.5.0
    with:
      upload-sarif: false
      fail-on-vuln: true

  scan-scheduled:
    if: github.event_name == 'schedule'
    uses: google/osv-scanner-action/.github/workflows/osv-scanner-reusable.yml@8deb546fdb875b9996d27d4950be7312dac076a1 # v2.5.0
    with:
      upload-sarif: false
      fail-on-vuln: true
`,
  },
};

// Stable marker present in every templated apply PR body. Written when the PR is
// opened (applyToRepo) and re-checked by stage-5 auto-merge before it merges, so
// the merge path can confirm a PR is the butler's OWN — the branch name alone is
// forgeable by anyone with push access. Single source of truth for both sites.
export const APPLY_PR_MARKER = 'Opened automatically by [Repo Butler]';

// --- Deterministic-failure guard --------------------------------------------
// `@dependabot rebase` refreshes a PR onto the latest base and re-runs CI, so it
// only ever helps a PR whose red CI depends on the base having moved. When the
// SAME workflow set has failed the last DETERMINISTIC_ATTEMPTS CI attempts, the
// failure is a property of the change itself (a major-version bump the code
// cannot satisfy, say), not of the base — a rebase regenerates a byte-identical
// red run, every week, forever. Such a PR needs a human decision (fix, pin or
// close), so the nudge stands down and records it as `escalated` instead.
//
// The head SHA deliberately does NOT have to stay put across those attempts. A
// rebase changes the head SHA precisely BECAUSE the base moved, so an identical
// failing workflow set across several DIFFERENT head SHAs is the strongest evidence
// available that rebasing does not help: it has already been tried, repeatedly,
// and changed nothing. Requiring an unchanged SHA threw that evidence away and
// left the guard firing only on the rarer, weaker case of repeated re-runs of
// one identical commit — which is why it never fired in production.
export const DETERMINISTIC_ATTEMPTS = 3;

// Pure predicate over prCiHistory() output (newest attempt first). True only on
// positive evidence: DETERMINISTIC_ATTEMPTS consecutive attempts available, each
// with at least one failing workflow, and an identical failing workflow set throughout.
// Fewer attempts, a clean attempt or a differing failing set → false (nudge as
// before). The head SHA is not compared; see above.
export function isDeterministicFailure(history, attempts = DETERMINISTIC_ATTEMPTS) {
  if (!Array.isArray(history) || history.length < attempts) return false;
  const recent = history.slice(0, attempts);
  const [first] = recent;
  if (!Array.isArray(first?.failing) || first.failing.length === 0) return false;
  const signature = first.failing.join('|');
  return recent.every(a =>
    Array.isArray(a?.failing) && a.failing.length > 0 && a.failing.join('|') === signature,
  );
}
