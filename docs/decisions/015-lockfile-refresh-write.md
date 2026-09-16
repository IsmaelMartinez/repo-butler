# ADR-015: Lockfile Refresh Write — Acting on `reachable-by-update`

Date: 2026-09-16

Status: Accepted (ships default-closed — see Consequences)

Extends [ADR-013](013-content-transformation-writes.md), which authorised one
content-transformation shape (a parent-scoped `overrides` entry for a
minor-locked `0.x` caret) and said of everything else: "reachable by
`npm update --package-lock-only`. This ADR authorises the narrow shape only."
This ADR authorises that other shape. It inherits ADR-013's failure-mode
analysis and answers each mode again for a different file, a different engine
and a different gate, and it discharges the caller obligations ADR-013 wrote
down for a write path that did not yet exist.

## Context

G13 (`src/stalled-alert.js`, [ADR-014](014-no-programmatic-dependabot-rescan.md))
classifies every stalled npm alert through the trimmer's `planOverride`, read
only. The most common verdict is the trimmer's own refusal
`reachable-by-update`: every parent range already admits the patched version,
so the lockfile is merely stale and a refresh reaches the fix. Nothing in the
write path acted on that verdict. The dashboard reported it, the finding carried
it, and the alert stayed open until a human ran the command by hand.

On 2026-09-16 that happened five times in one afternoon: one high alert on
`betis-escocia` and four Silver-tier regressions across `yourear`,
`ismaelmartinez.me.uk`, `bonnie-wee-plot` and `wifisentinel`, all the same
sharp/libheif advisory rolling repo by repo as GitHub rescanned, plus a fresh
js-yaml alert the minute the first merge landed. Every one of the five fixes was
lockfile-only. The diagnosis was the same each time (`analyse.js`: is the
patched version inside every parent's range?), the action was the same
(`npm update <pkg> --package-lock-only`), and the acceptance check was the same
(a diff of `packages[].version` proving every change stayed in the alert
package's family, then CI). Those three steps are a workflow, not a judgment,
and the classification that selects them already runs four times a day.

The same session evaluated PydanticAI and docker agent as runtimes for this
flow and found neither necessary: the judgment lives in the gate, which is
deterministic, and the transform lives in npm, which is not the butler's code.
The agentic residue — `ERESOLVE`, co-versioned pairs, workspaces, the cases
where npm refuses — is tracked separately and is out of scope here.

## Why this class does not pass ADR-005's benign-worst-case test, again

ADR-013's six modes, re-answered for a lockfile refresh:

1. **The output depends on input the butler did not write.** Worse than
   ADR-013: the output is not even computed by the butler. npm reads the
   manifest and lockfile and writes a new lockfile according to its own
   resolver. The butler cannot reason about what npm will do; it can only
   inspect what npm did.
2. **A wrong lockfile breaks an install.** A lockfile that resolves to a version
   a parent never declared, or that drops an entry, is a broken `npm ci` for
   every consumer of that repo — and unlike an `overrides` entry it is not a
   small legible diff. Lockfile diffs are hundreds of lines of `resolved` and
   `integrity` noise; a human reviewer cannot see a wrong version in them.
3. **The edit lands in shared real estate.** Every entry in `packages[]` sits
   beside every other. There is no name-guard; the only attribution is the PR.
4. **A redundant change breaks Dependabot.** ADR-013's `bonnie-wee-plot`
   lesson applies in a milder form: a refresh that also moves packages
   Dependabot has its own open PR for produces a merge conflict on that PR and
   a retry loop.
5. **The change is complete.** This is the one mode ADR-013's shape failed and
   this shape passes: a lockfile refresh is the whole change. `package.json` is
   untouched, and the gate refuses if it is not.
6. **The input is hard to read.** Identical to ADR-013: the Contents API caps
   inline content at 1 MB and real lockfiles exceed it.

## Decision

The capability is permitted, under the five ADR-005 gates **unchanged**, with
npm as the transform engine and a deterministic gate as the fence. It lives in
`src/lockfile-update.js` and is a sibling apply action (`applyLockfileUpdates`)
behind the same gate stack, dispatched from `runApply` in `src/index.js`, not a
branch inside `applyGovernanceFindings`.

- **npm is the engine, never the butler.** The butler writes the manifest and
  lockfile it read into a scratch directory, runs
  `npm update <pkgs> --package-lock-only --ignore-scripts`, and reads both files
  back. `--package-lock-only` needs no `node_modules`, so the registry is the
  only thing npm touches; `--ignore-scripts` because nothing here may execute
  code from the target repo. The butler never edits lockfile JSON itself (→
  mode 1: the butler does not need to understand the resolver, only to check
  its output). The child runs with a minimal environment (`npmChildEnv`):
  `PATH`, `HOME` and `TMPDIR` only, the registry pinned to
  `registry.npmjs.org`, and user and global npm config pointed at two absent
  files — never the runner's tokens, `NODE_ENV`, or any inherited
  `npm_config_*` — because the manifest and lockfile are the target's files
  and a resolver that honoured inherited auth or a redirected registry would
  be acting on their behalf with the butler's credentials. Three consequences
  of the scratch directory holding only those two files: a project that
  carries its own `.npmrc` is skipped (`npmrc-unsupported`), because a
  private registry or `legacy-peer-deps` would shape the project's installs
  and not this refresh, and carrying the file over would mean honouring
  arbitrary config, tokens included; the fixed-host boundary of SECURITY.md
  is checked BEFORE npm is spawned (`non-registry-source`): a git, tarball,
  `file:`, `link:` or `workspace:` spec anywhere in the manifest or its
  `overrides`, or a lockfile entry not `resolved` from `registry.npmjs.org`
  (an absent `resolved` included), is a host the target chose and npm would
  contact it while building the tree, long before the gate could refuse the
  result; every changed entry's `resolved` must then also point at the public
  registry afterwards (`unexpected-registry`), so the lockfile, not the
  butler, can never choose where the bytes come from; and when npm
  fails, only its error code (`npm update failed: code ERESOLVE`) reaches the
  result and the log — the rest of stderr is built from the target's files
  and the Actions log is public. The same rule keeps the safety validators'
  matched text out of the log when a composed title or body fails: the log
  gets a count.
- **The gate is the write decision, and refusal is its specification** (→
  modes 2, 3, 4). `computeLockfileGate` is pure and returns the first rule that
  fails, in this order: `manifest-changed` (only the lockfile may move — this
  is what makes mode 5 pass), `workspaces-unsupported`, `unparseable-lockfile`,
  `unsupported-lockfile` (v1 has no `packages` map),
  `lockfile-metadata-changed` (anything outside `packages[]` moved — a
  `lockfileVersion` bump is a format rewrite, not a fix; the v2 `dependencies`
  mirror is excluded because npm regenerates it from `packages` on every
  write, so the `packages` diff already accounts for it), `no-patched-version`,
  `non-release-version` (a patched or compared version that is not a plain
  `M.m.p` release: the trimmer's `parseVersion` tolerates any residual suffix,
  so `1.2.3-beta.0`, `1.2.3-beta.1`, `1.2.3+build` and `1.2.3foo` would all
  compare as `1.2.3`, and refusing is the only comparison the gate can vouch
  for), `no-change`, `not-updated`
  (something moved but the alert package did not — a metadata-only rewrite of
  a copy already at the patch does not count),
  `not-patched` (any copy of the alert package still below its patch — nested
  duplicates included — or no copy left at all; when two alerts name one
  package the higher patch is the requirement), `out-of-family` (a change to
  any package outside the alert package's transitive dependency closure —
  additions, removals and metadata-only changes to an entry's `resolved`,
  `integrity` or dependency map included, since the whole file is what gets
  pushed), `release-line-crossing` (a version change across a major, or
  across a minor inside `0.x`, the trimmer's release-line lesson — in place,
  or by an added copy of a package that shares no release line with any copy
  the tree had before, so a relocation cannot be how a new major enters), and
  `unexpected-registry`. The v2 `dependencies` mirror is excluded from the
  envelope on lockfileVersion 2 only; a v3 file has no such mirror, so one
  appearing there is exactly the unaccounted top-level change the envelope
  exists to catch. A lockfile diff a human cannot read is therefore never
  what decides; the gate reads it and the PR body carries only the gate's own
  table.
- **The alert is re-read live at apply time** (the ADR-012 posture). A finding
  can be six hours stale. An alert that is no longer open, or whose live
  package, ecosystem or `manifest_path` directory disagree with the finding,
  is dropped as fixed or mismatched — the directory check is what ties the
  live alert to the lockfile about to be refreshed, so an alert that moved
  since OBSERVE cannot refresh whichever other lockfile happens to contain the
  package; an alert that cannot be read is an `error`, not a skip, so a run
  made inert by a lost scope is not mistaken for a healthy run with nothing to
  do (the G12 lesson).
- **The caller obligations ADR-013 wrote down are discharged in code.** One
  commit is the frame of reference: the default branch head is resolved once,
  both files are read from that sha through the Contents API and, when it
  declines to inline them, through the blob API — so a lockfile over 1 MB is
  read, not guessed at; a genuine 404 skips the repo; any other failure throws
  — and the PR branch is created at that same sha, never at a freshly resolved
  head, so a default branch that moves during the read or the npm run cannot
  be overwritten by a lockfile computed against its predecessor (the PR simply
  opens behind). The manifest and lockfile are read from the same directory
  the alert's `manifest_path` names, so correspondence holds by construction.
  The dry-run preview prints the gate's change list, which is the diff the PR
  would carry. Nothing is reformatted: the lockfile npm wrote is the lockfile
  that is pushed. Alert package names and directories are pattern-checked at
  selection because they become npm arguments, API paths, branch names and
  markdown; an alert with no manifest path is dropped rather than read as the
  root, and so is one whose manifest is `yarn.lock` or `pnpm-lock.yaml` —
  Dependabot's `npm` ecosystem covers those managers too, and refreshing
  `package-lock.json` would leave such an alert open behind a green run. The
  same two checks are repeated against the live alert. The composed title and
  body still pass `validateIssueTitle`
  and `validateIssueBody` before anything is written — a failure there is an
  `error`, since it means a bug or hostile input, never a quiet skip.
- **One PR per (repo, directory), one target at a time.** Every
  `reachable-by-update` alert in the same lockfile rides one refresh and one
  PR, because one `npm update` call refreshes one lockfile. Non-root
  directories get their own branch
  (`repo-butler/apply-lockfile-update-<slug>-<8-hex sha256 of the directory>`)
  so two lockfiles in one repo never contend for one branch, even when their
  paths slugify alike. The decline cooldown (`screenApplyTarget`) applies per
  branch: a closed-unmerged refresh is a decline for that lockfile. The
  per-run cap counts targets that got past that screen, so a repo with an
  open or recently declined PR never holds a slot and starves the ones behind
  it — the ordering `screenApplyTarget` exists for.
- **Explicit on a manual dispatch; allow-listed on the schedule.** The tool
  never rides a blank `tools` run — the operator names `lockfile-update`. On
  the scheduled path it is offered on a blank run only (the scheduled
  workflow's manual dispatches set `scheduled` too, and an explicit
  `tools=code-scanning` there must not drag a content write along) and then
  skips by construction unless `apply-schedule` names it, the same two-axis
  default-closed shape ADR-007 stage 4 established, and the same graduation
  path: a reviewed config entry after a track record.
- **Dry-run performs reads and runs npm, never a write.** Unlike the template
  classes, whose dry-run makes no API calls, this dry-run is the real forecast:
  it reads the live alert and the files, runs npm in the scratch directory,
  runs the gate and prints the change list. That is deliberate. The template
  dry-run's no-calls guarantee exists to prove an ADR-005 gate inert; this
  class's preview exists to be the audit record before a human decides on
  `dry-run=false`, and a forecast that skips the transform is not one.
- **Auto-merge-ineligible by construction.** No `TEMPLATES` entry, so
  `isAutoMergeAllowed` cannot admit it. Human review is mandatory: mode 2 says
  the reviewer cannot read the lockfile diff, so what they review is the gate's
  table, CI on the PR, and Dependabot closing the alert on rescan.
- **`require_approval` master switch, per-run cap, `REPO_NAME_PATTERN`** —
  inherited unchanged.

### Benign worst case, stated plainly

With the fences above, the worst case is: the butler opens a manual-dispatch
PR against one repo carrying a lockfile that moved the alert package and its
own dependencies within their release lines, that `npm ci` accepts, but that
picks a version with a runtime regression nobody's CI catches. A human
reviews the gate's table and CI's verdict, and merges. Reverting is reverting
one commit that touched one file. Nothing auto-merges. The alert state on
GitHub, not the PR, is the proof of fix.

The worst case this ADR does **not** claim to have eliminated: the family check
resolves dependency names across the whole lockfile rather than by npm's
nearest-ancestor rule, so it can over-approximate a family and admit a change
to a same-named package elsewhere in the tree. The release-line check still
applies to every such change, which bounds it to a patch or minor bump of
something the alert package also depends on.

### Executor and lane

The `stalled-alert` finding stays `executor: 'manual'` (ADR-002/ADR-011 lane
boundary). This tool consumes it as a sibling apply action; it does not change
the finding, the classification, or the dashboard.

## Consequences

The capability ships default-closed on both axes: it never runs on a blank
manual dispatch, and it never runs on the schedule until `apply-schedule` names
it. Going live is a maintainer's explicit `dry-run=false tools=lockfile-update`
dispatch after reading the dry-run preview. The first graduation onto the
schedule is its own reviewed config change, after a track record of
human-reviewed refresh PRs that installed cleanly and whose alerts closed on
rescan.

Two things are proven and one is not. The gate is proven against fixture
lockfiles and mutation-checked (disabling the release-line rule and the family
rule each fails its test). The npm path is proven once against the live
registry: a `js-yaml@4.1.0` lockfile refreshed to `4.3.2` in under five
seconds with `package.json` byte-identical and the gate passing. The blob-API
fallback for lockfiles over 1 MB follows GitHub's documented response shape
(`content: ""`, `encoding: "none"`) and is unit-tested against that shape, but
no portfolio lockfile currently exceeds 1 MB, so it has not been exercised
live.

**What this ADR does not authorise:** any change to `package.json` (the gate
refuses it); any package manager other than npm, or any lockfile version below
2; workspaces roots; running npm scripts; auto-merge of the resulting PRs;
touching a package outside the alert packages' dependency closure; the
`override` shape (that is ADR-013's, and still inert); or acting on the cases
where npm itself refuses. That last set — `ERESOLVE`, split co-versioned pairs,
peer conflicts — is the residue that needs judgment, and it is the subject of
the agentic-flow proposal tracked separately, not of this decision.
