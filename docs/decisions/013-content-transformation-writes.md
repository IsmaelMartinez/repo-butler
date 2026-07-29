# ADR-013: Content-Transformation Writes — Editing a File the Butler Did Not Author

Date: 2026-07-29

Status: Accepted (capability ships inert — see Consequences)

Extends [ADR-005](005-cross-repo-pr-gates.md) (templated file writes) and
[ADR-009](009-settings-level-writes.md) (PR-less settings writes). Neither
covers this class. ADR-005's argument rests on a property this class does not
have — that every cross-repo write is a fixed string whose target is never read —
so its benign-worst-case reasoning does not carry over and is redone here.
[ADR-012](012-dependabot-security-updates-settings-write.md) is the model for
that redoing, including its candour about how its own class fails the inherited
test.

## Context

The butler's cross-repo write surface has had exactly one shape since ADR-005:
`applyToRepo` (`src/apply.js:465`) resolves the default branch, creates
`repo-butler/apply-<tool>`, and PUTs a file whose entire content came from a
`TEMPLATES` generator (`src/apply.js:29`). It passes **no `sha`**, so it cannot
update an existing file — every templated apply is a blind create. The target
file's prior content is never fetched, never parsed, and never influences what
is written.

That invariant is what makes ADR-005's worst case small. A wrong template is a
wrong *new file*: reviewable as a whole in the PR diff, revertible by deleting
it, and incapable of corrupting anything that was already there.

G6 (the trimmer) breaks it. To clear a transitive advisory it must read a
`package.json`, parse it, merge one entry into its `overrides` block, and write
the result back — the first capability whose output is a **function of content
the butler did not author**. Read-modify-write mechanics already exist in the
codebase (`src/onboard.js:103,127,150` appends to `CLAUDE.md`; `putFile` in
`src/github.js:161` auto-discovers the blob sha and retries once on a 409), but
`onboard.js` is a standalone string append outside the ADR-005 gate stack, so
there is no gated precedent for a *structured* transform.

The scope is narrower than "fix transitive vulnerabilities". Reviewing ~23 real
advisories across this portfolio established that Dependabot was **stalled, not
incapable**: once a push forced a rescan it cleared nearly all of them itself.
Two needed a hand-written override, and both shared one shape — a caret on a
`0.x` version is minor-locked, so `^0.34.5` means `>=0.34.5 <0.35.0` and cannot
reach a `0.35.x` patch however the lockfile is refreshed. Everything else was
reachable by `npm update --package-lock-only`. This ADR authorises the narrow
shape only.

## Why this class does not pass ADR-005's benign-worst-case test

1. **The output depends on input the butler did not write.** A template is a
   constant; a transform is a function. Its correctness depends on the target's
   existing shape, which can be malformed, unexpectedly nested, or carry a
   comment-preserving format the butler's `JSON.parse`/`stringify` round trip
   would silently destroy. ADR-005 never had to reason about a corrupted target
   because it never read one.

2. **A wrong override breaks a build in a way a config file cannot.** An
   `overrides` entry rewrites *transitive resolution across the whole tree*, not
   just the file it appears in. A wrong version can change what every dependent
   package resolves to. A bad `SECURITY.md` is cosmetic; a bad override is a
   broken install for every consumer of that repo.

3. **The edit lands in shared real estate, so it is not name-guardable.** ADR-009
   leaned on a distinctively-named ruleset to tell "the butler did this" from "a
   human did this". An `overrides` block has no such affordance: the butler's
   entry sits in the same object as hand-written ones, and a later reader cannot
   attribute them. This is the same un-name-guardable problem ADR-012 documents
   for the autofix flag, and it has the same consequence — the butler must never
   remove or rewrite an entry it did not add.

4. **A redundant override actively breaks Dependabot.** This is not theoretical.
   `bonnie-wee-plot` carried `overrides: {"postcss": "^8.5.10"}` alongside an
   identical direct devDependency, and that redundancy made Dependabot's own
   updater error and retry six times in 25 minutes per scheduled run. A
   generator without a redundancy check would manufacture that bug at portfolio
   scale — the capability would create work while appearing to remove it.

5. **The manifest edit alone is an incomplete change.** Editing `package.json`
   does not regenerate `package-lock.json`, and the butler is an API-only Action
   that cannot run `npm install`. The PR is therefore knowingly partial: correct
   in intent, but requiring CI or a human to complete the lockfile. A template
   write has no such half-state.

6. **The input needed to decide is itself hard to read.** The Contents API caps
   responses at 1 MB and `getFileContent` (`src/github.js:135`) returns `null`
   above it — indistinguishably from "absent", "404" and "rate-limited". Real
   lockfiles exceed 1 MB. A capability that guesses when its input is
   unavailable would be guessing exactly when it is least safe to.

## Decision

The capability is permitted, under the five ADR-005 gates **unchanged** plus
fencing that answers each failure mode above by name.

- **Refusal is the default, and the specification.** The deciding core
  (`src/trimmer.js`) returns an explicit `refuse` with a reason for every case it
  cannot prove safe: `direct-dependency` (→ mode 4), `disjoint-ranges` where a
  patch sits outside a parent's declared major line, `reachable-by-update` where
  a lockfile refresh already reaches the fix, `pnpm-auto-installed-peer` where
  overrides do not apply at all, `override-conflict` where the manifest already
  pins that parent to a string (→ mode 3), `out-of-scope` for anything that is
  not the proven shape, `parent-undeterminable`, and `no-patched-version`. Each
  refusal is drawn from a real case that would have broken a naive
  implementation, and refusing is a success, not a failure to try harder.
- **The proven shape is fenced IN, not merely gestured at.** Every refusal above
  rules a case out; one check rules the single sanctioned case in. An override is
  emitted only when the capping parent declares a **caret on a `0.x` version**
  and the patch sits in the **adjacent** minor line. That fence is what makes
  "only the proven shape" a property of the code rather than a claim in a
  document. It matters because a major-line comparison is blind precisely where
  this capability operates: inside `0.x` every minor is itself a breaking line,
  so `^0.34.5 → 0.35.0` is one crossing while `^0.1.0 → 0.9.0` is eight, and a
  check that compares only majors cannot tell them apart.
- **Never a blanket top-level override, and never a package other than the alert
  subject** (→ mode 2). The emitted form is parent-scoped
  (`{"next": {"sharp": "^0.35.0"}}`), matching the recipe already applied by hand
  across four repos in this portfolio. Matching the established in-house recipe
  is deliberate: it is known to work here.
- **Additive merge only** (→ mode 3). Existing `overrides` entries are carried
  through byte-identical; exactly one key may change, and it must be the alert
  subject's parent. The butler never removes or rewrites an entry it did not add
  — notably, `bonnie-wee-plot`'s apparently-redundant `postcss` override is in
  fact load-bearing, and a "tidy-up" capability would have removed it and
  reintroduced a vulnerability. The sharp edge here is that a parent key may
  already hold a *string* (`overrides: {"next": "16.2.11"}` pins the parent
  itself). Nesting the fix under that key would silently delete a deliberate
  human pin, so the trimmer refuses (`override-conflict`) rather than
  reinterpreting an entry someone else wrote.
- **Fail closed on unreadable input** (→ modes 1, 6). A manifest or lockfile that
  cannot be fetched or parsed is a refusal, never an assumption. This one is a
  **caller obligation**, not a property of the core — see below.
- **Auto-merge-ineligible by construction** (→ mode 2). `isAutoMergeAllowed`
  (`src/apply.js:1160`) requires `Boolean(TEMPLATES[tool])`, and a content
  transform has no `TEMPLATES` entry by its nature. No allow-list entry can make
  this class auto-merge; the restriction is structural, not configured. The
  incomplete-lockfile half-state (mode 5) makes human review mandatory anyway.
- **Manual dispatch only, and off the `apply-schedule` allow-list**, until
  soaked — the ADR-012 posture, for the same reason: this class's blast radius
  is not bounded by the per-run cap alone.
- **Dry-run fail-closed** (`src/index.js:29`; only the literal `false` writes).
  The dry-run preview must print the full proposed `overrides` diff, so the
  preview is the audit record.
- **`require_approval` master switch** (`src/apply.js:373`), per-run cap via
  `capPerTool` (`src/apply.js:337`), and `REPO_NAME_PATTERN` validation
  (`src/safety.js:435`) — inherited unchanged. Note the polarity: for apply,
  `require_approval: true` is the *operating* state and `false` is the kill
  switch.

### What the caller must guarantee

The core is pure, which means several of the fences above cannot live inside it.
Writing them down here is the point: with no caller yet, these are the easiest
things in this ADR to violate by accident when the write path is wired.

The caller owns fetching and parsing, so it owns failing closed. `getFileContent`
(`src/github.js:135`) returns `null` for absent, 404, rate-limited **and** over
1 MB alike, and real lockfiles exceed 1 MB — so a `null` must abort that repo,
never proceed with a partial view. It owns correspondence, too: the trimmer
trusts that the `lock`, the `manifest` and `alert.manifestPath` it is handed all
describe the same project, and it cannot check this. Handing it a root lockfile
alongside a sub-directory manifest would defeat the `direct-dependency` fence,
because the direct-dependency read would consult the wrong manifest. It owns the
dry-run preview printing the full proposed `overrides` diff, since the preview is
the audit record. And it owns writing back only `merged`, whole, without
reformatting the rest of the file — a `JSON.parse`/`stringify` round trip over
the entire manifest would reflow the whole document and bury the one real change
in the diff, which is mode 1.

### Benign worst case, stated plainly

With the fences above, the worst case is: the butler opens a manual-dispatch PR
against one repo that adds one parent-scoped `overrides` entry pointing at a
version that does not fix the alert, or that pins a subtree tighter than
necessary. CI runs on that PR. A human reviews a small, legible diff. Nothing
auto-merges. Reverting is deleting one JSON key.

The worst case this ADR does **not** claim to have eliminated: because the
lockfile is not regenerated by the butler, a merged PR can leave a manifest and
lockfile briefly inconsistent until an install runs. That is why the class stays
review-mandatory and off auto-merge, rather than being argued away.

### Executor and lane

The `open-vulnerability` finding stays `executor: 'manual'` (ADR-002/ADR-011
lane boundary: resolving a specific alert is per-repo work, not a cross-repo
statistic). Like `applyDependabotSecurityUpdates`, the trimmer is a **sibling**
apply action behind the same gate stack, not a branch inside
`applyGovernanceFindings`, which filters on `executor === 'template'`.

## Consequences

The deciding core ships first and is inert: it is a pure function with no
caller in the write path, so nothing changes for any repo until a wiring change
is made deliberately. Going live is a maintainer's explicit
`dry-run=false tools=trimmer` dispatch, after a dry-run preview has been read.

The acceptance the plan sets for G6 — a canary PR that installs cleanly and
whose alert clears on rescan — **cannot currently be evaluated**: the portfolio
has zero open critical/high alerts, so there is no live case to exercise. The
capability is therefore proven against real lockfile structure and real
historical cases in tests, and remains unproven end-to-end until an advisory
appears. That gap is recorded rather than papered over.

**What this ADR does not authorise:** scheduled or unattended execution;
auto-merge of the resulting PRs; removing or rewriting any `overrides` entry the
butler did not add; a blanket top-level override; touching any package that is
not the subject of an alert; editing any file other than the manifest the alert
names; or extending content transformation to any other file type. Each of those
needs its own argument.
