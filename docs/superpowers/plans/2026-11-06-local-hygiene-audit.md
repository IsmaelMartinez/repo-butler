# Local Hygiene Audit Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship Phase 1 of the factory design. That is a local audit that sorts every worktree and stash under the project directories into prunable, needs-look or live, plus a guarded prune helper, an approvals record, and wiring into the apply and briefing skills.

**Architecture:** `src/local-hygiene.js` holds a pure classifier (readings to verdicts), a thin git and `gh` reader, the guarded prune, and the approvals record. `scripts/local-hygiene.js` is a CLI over it with the subcommands `audit`, `prune`, `record` and `streak`, in the style of `scripts/check-skills.js`. Nothing touches the data branch.

**Tech Stack:** Node 22 ESM, `node:test`, zero dependencies. Git is called through `execFileSync`, the same way `runGit` does it in `src/staleness.js`. PR lookups go through the `gh` CLI.

**Spec:** `docs/superpowers/specs/2026-11-06-agentic-factory-design.md`, sections 4 to 6.

## Global Constraints

- The code is zero-dependency. Git runs through `execFileSync('git', args)` with no shell. Every helper call is a single command, never chained.
- No readings are cached. Every unreadable reading yields `needs-look`, never `prunable`. "Could not check" must never look like "checked, it is fine".
- The prune helper never passes `--force`. It deletes branches only with `git update-ref -d refs/heads/<branch> <expectTip>`. It re-runs every prunable condition at action time.
- A branch has landed only when it is an ancestor of the default branch, or a PR from it is `MERGED` and that PR's `headRefOid` contains the local tip (it is equal to it or a descendant of it; see the spec). A `CLOSED` PR is never landed.
- Stashes are never prunable.
- `at-risk` means the checkout has more than 20 dirty files, sits on a detached HEAD, or has more than 3 stashes.
- The approvals file is `${XDG_STATE_HOME:-~/.local/state}/repo-butler/approvals.jsonl`. Each line has exactly the fields `{ ts, findingType, actionClass, repo, item, outcome }`. `outcome` is one of `accepted-unchanged`, `edited`, `rejected` or `skipped`.
- Only two action classes are graduation-eligible: `prune-merged-worktree` and `release-reopen-for-ci`. A class graduates after 8 consecutive `accepted-unchanged` outcomes, and any `edited` or `rejected` resets the count. The code only reports the streak. Graduating is the owner's config change.

## Review Focus

- A worktree locked by an agent whose PID has died is treated as unlocked. A lock with no parseable PID is treated as live. Tested in Task 1.
- A branch tip that moves between audit and prune means the prune is refused, and the branch and its new commit survive. Tested in Task 3.
- A repo with no `origin/HEAD` (default branch unknown) cannot prove ancestry, so its worktrees are `needs-look` unless the PR head matches. Tested in Task 1.
- When `gh` is missing or unauthenticated, the PR reading is `null`. Nothing is prunable on PR evidence alone, and the audit still completes. Tested in Task 2.
- The main checkout itself is never listed as a worktree to prune. Tested in Task 1.

---

### Task 1: Pure classifier

**Files:**
- Create: `src/local-hygiene.js`
- Test: `src/local-hygiene.test.js`

**Interfaces:**
- Produces `classifyWorktree(reading) -> { status: 'main'|'live'|'prunable'|'needs-look', reasons: string[] }`. A `reading` is `{ path, branch: string|null, head: string, isMain: boolean, dirty: boolean|null, lockPid: number|null|undefined, lockLive: boolean, unpushed: number|null, stashOnBranch: boolean, ancestorOfDefault: boolean|null, pr: { state: 'OPEN'|'MERGED'|'CLOSED'|'NONE', headSha?: string, number?: number }|null }`. `lockPid` is `undefined` when the worktree is not locked.
- Produces `summariseRepo({ repo, repoDir, slug, worktrees, stashes, mainDirtyCount, mainDetached, staleEntries, scriptPath, today }) -> finding|null`. The finding is `{ type: 'local-hygiene', repo, path, worktrees: [{ path, branch, head, status, reasons }], stashes, staleEntries, atRisk, priority, remediation: { executor: 'manual', targetFiles: [], intent, rationale, acceptanceCriteria, commands } }`. It returns null when nothing is prunable, needs a look, is stale or is at risk.

- [ ] **Step 1: Write the failing tests** in `describe('classifyWorktree')` and `describe('summariseRepo')`. The cases and their expected results:
  - `main` when `isMain` is true;
  - `live` when `pr.state` is `OPEN`;
  - `prunable` when the branch is an ancestor, clean, `unpushed` is 0, there is no stash and no lock;
  - `prunable` when squash-merged, that is `pr` `{ state: 'MERGED', headSha: head }` with `ancestorOfDefault` false and `unpushed` 3, because the deleted source branch makes local commits look unpushed;
  - `needs-look` with a reason matching `/closed without merging/` when `pr.state` is `CLOSED`;
  - `needs-look` for a `MERGED` PR whose `headSha` is not `head`;
  - `needs-look` when `dirty` is true, when `dirty` is null (reason `/could not read/`), when `stashOnBranch` is true, or when `branch` is null (detached);
  - `needs-look` when `lockLive` is true;
  - `prunable` when `lockPid` is 999999 and `lockLive` is false;
  - `needs-look` when `ancestorOfDefault` is null and `pr` is null.

  For `summariseRepo`:
  - returns null when every worktree is `main` or `live` and nothing is at risk;
  - a prunable worktree yields `priority: 'medium'` and exactly the command `node <scriptPath> prune <repoDir> <path> --expect-tip <head>`;
  - `mainDetached` true, or more than 3 stashes, or `mainDirtyCount` above 20, yields `atRisk: true` and `priority: 'high'`;
  - when the checkout is detached or dirty, the commands include `git -C <repoDir> switch -c wip/<today>-rescue`;
  - no command contains `--force`, `-D`, `stash` or `reset`.
- [ ] **Step 2: Run `node --test src/local-hygiene.test.js`.** Expected: FAIL, because the module is missing.
- [ ] **Step 3: Implement both functions.** `lockLive` is computed by the reader, not here. A non-null `pr` with `state: 'NONE'` plus `ancestorOfDefault` false is `needs-look` with the reason "no PR and not merged".
- [ ] **Step 4: Run the tests.** Expected: PASS.
- [ ] **Step 5: Commit** with `feat(hygiene): pure worktree classifier`.

### Task 2: Reader and audit, against real git fixtures

**Files:**
- Modify: `src/local-hygiene.js`
- Test: `src/local-hygiene.test.js`

**Interfaces:**
- Consumes `classifyWorktree` and `summariseRepo`.
- Produces `readRepo(repoDir, { lookupPR, fetch = true, scriptPath, today }) -> finding|null`.
- Produces `auditDirs(parentDirs: string[], opts) -> finding[]`. It scans only immediate children that have a `.git` directory.
- Produces `defaultLookupPR(slug, branch) -> pr|null`. It runs `gh pr list --repo <slug> --state all --head <branch> --json state,headRefOid,number --limit 5`, and prefers `OPEN`, then `MERGED`, then `CLOSED`. It returns `{ state: 'NONE' }` for an empty list and null on any failure.

- [ ] **Step 1: Write the failing fixture tests.**

  The `before` hook builds a fixture in a temp directory: a bare `remote.git`, a clone `repo` with `origin/HEAD` set, a `main` branch, and these worktrees under `repo/.claude/worktrees/`:
  - `merged` (a branch merged into main and pushed);
  - `squashed` (local commits; `lookupPR` stub returns `MERGED` with its head);
  - `closed` (`lookupPR` returns `CLOSED`);
  - `dirty` (an uncommitted file);
  - `open` (`lookupPR` returns `OPEN`).

  The tests:
  - `readRepo` with `fetch: false` gives `merged` and `squashed` status `prunable`, `closed` and `dirty` status `needs-look`, and `open` status `live`;
  - the main checkout never appears with status `prunable`;
  - a `lookupPR` that returns null leaves `squashed` as `needs-look`;
  - `auditDirs([tmp])` returns one finding for `repo` and ignores a sibling plain directory.
- [ ] **Step 2: Run the tests.** Expected: FAIL.
- [ ] **Step 3: Implement `readRepo`.**
  - It parses `git worktree list --porcelain`, which gives `worktree`, `HEAD`, `branch refs/heads/x`, `detached` and `locked <reason>`.
  - `lockPid` comes from `/pid[ =:]?(\d+)/i` on the lock reason. `lockLive` is the result of `process.kill(pid, 0)`, or true when the lock has no PID.
  - `dirty` comes from `git -C <wt> status --porcelain`.
  - `unpushed` comes from `git rev-list --count <head> --not --remotes`.
  - The default branch comes from `git symbolic-ref --short refs/remotes/origin/HEAD`, and is null if that fails.
  - Ancestry is `git merge-base --is-ancestor <head> <default>`. That command signals through its exit code, so add a `gitOk(args, cwd) -> boolean|null` helper using `spawnSync`.
  - Stashes come from `git stash list --format=%gd%x09%ci%x09%gs`, matching each branch through `/^(?:WIP on|On) ([^:]+):/`.
  - Stale entries come from `git worktree prune --dry-run --verbose`.
  - The slug comes from `git remote get-url origin`.
  - When `fetch` is true, it runs `git fetch --prune --quiet` once, with a 30 s timeout.
  - Use a local `git(args, cwd, timeout)` helper that returns `string|null`, rather than importing `runGit`, because `runGit` swallows stderr and its 5 s timeout is too short for fetch.
- [ ] **Step 4: Run the tests.** Expected: PASS.
- [ ] **Step 5: Commit** with `feat(hygiene): read worktrees, stashes and PR state`.

### Task 3: Guarded prune

**Files:**
- Modify: `src/local-hygiene.js`
- Test: `src/local-hygiene.test.js`

**Interfaces:**
- Consumes `readRepo` internals. Factor out `readWorktree(repoDir, path, ctx)` so a single worktree can be re-read.
- Produces `pruneWorktree({ repoDir, worktreePath, expectTip, lookupPR }) -> { ok: boolean, reason?: string }`.

- [ ] **Step 1: Write the failing fixture tests.**
  - A prunable worktree is pruned: the directory is gone and `refs/heads/<b>` no longer exists.
  - An `expectTip` that does not match the live head is refused with `/tip moved/`, and the worktree and branch survive.
  - A commit added after the audit, with the old tip passed, is refused, and the new commit is still reachable.
  - A worktree made dirty after the audit is refused with `/not prunable/`.
  - A `closed` worktree is refused.
- [ ] **Step 2: Run the tests.** Expected: FAIL.
- [ ] **Step 3: Implement the prune** in this order:
  1. Re-read the worktree and classify it.
  2. Refuse if it is not `prunable`, or if its head is not `expectTip`.
  3. Run `git worktree remove <path>`, and refuse if that fails.
  4. Run `git update-ref -d refs/heads/<branch> <expectTip>`. If that fails, return `{ ok: false, reason: 'worktree removed but branch ref moved; left in place' }`.
- [ ] **Step 4: Run the tests.** Expected: PASS.
- [ ] **Step 5: Commit** with `feat(hygiene): guarded prune with compare-and-delete`.

### Task 4: Approvals record and the CLI

**Files:**
- Modify: `src/local-hygiene.js`
- Create: `scripts/local-hygiene.js`
- Test: `src/local-hygiene.test.js`

**Interfaces:**
- Produces `ELIGIBLE_CLASSES` (a Set of the two classes).
- Produces `recordApproval(entry, { file }) -> void`. It validates `outcome` against the enum and throws on anything else.
- Produces `approvalStreak(actionClass, { file }) -> { streak: number, eligible: boolean, graduated: boolean }`, where `graduated` means `streak >= 8 && eligible`.
- Produces `approvalsFile(env) -> string`.
- The CLI is `node scripts/local-hygiene.js audit [--json] [--no-fetch] [--dir D]...`, `prune <repoDir> <worktreePath> --expect-tip <sha>`, `record <findingType> <actionClass> <repo> <item> <outcome>` and `streak <actionClass>`. Exit codes: `audit` exits 0 when there are no findings and 1 when there are; `prune` exits 0 when pruned and 1 when refused; any usage error exits 2.
- Without `--dir`, the directories come from `REPO_BUTLER_PROJECTS_DIRS` (newline-separated), defaulting to `$HOME/projects/github` and `$HOME/projects/gitlab`.

- [ ] **Step 1: Write the failing tests.**
  - The streak counts trailing `accepted-unchanged` outcomes, and an `edited` outcome resets it to 0.
  - A streak of 8 on `owner-move-reply` reports `graduated: false`.
  - An invalid outcome throws.
  - `approvalsFile({ XDG_STATE_HOME: '/x' })` is `/x/repo-butler/approvals.jsonl`.
  - Spawning the CLI with `audit --json --no-fetch --dir <fixture>` prints a parsable array and exits 1.
  - Spawning it with `prune` and a bad tip exits 1.
  - Spawning it with no subcommand exits 2.
- [ ] **Step 2: Run the tests.** Expected: FAIL.
- [ ] **Step 3: Implement.** The human-readable `audit` prints one line per finding, `repo: N prunable, M need a look, K stashes[, AT RISK]`, then that finding's commands, indented.
- [ ] **Step 4: Run `npm test`.** Expected: all suites PASS.
- [ ] **Step 5: Commit** with `feat(hygiene): approvals record and CLI`.

### Task 5: Skill wiring

**Files:**
- Modify: `skills/repo-butler-apply/SKILL.md`, in Section C and at step 7's line that says the manual tray is never actioned.
- Modify: `skills/repo-butler/SKILL.md`, replacing the local-state bash block in "Briefing mode".
- Modify: `docs/superpowers/specs/2026-11-06-agentic-factory-design.md`, adding a Status line that says Phase 1 is implemented.

- [ ] **Step 1: Wire up the apply skill.** Section C runs `node "$SKILL_DIR/../../scripts/local-hygiene.js" audit --json` and lists its findings with the governance manual findings. For each finding that has `remediation.commands`, it shows each command verbatim and runs one only on the owner's explicit yes for that item. After each command it runs `record` with the outcome. It never chains commands and never runs a `prune` without a yes, unless `streak prune-merged-worktree` reports `graduated` and `REPO_BUTLER_GRADUATED` in `~/.config/repo-butler/config.sh` lists that class. Even then it prints what it did. Step 7 is amended to say the manual tray's commands may be actioned item by item in Section C.
- [ ] **Step 2: Wire up the briefing skill.** Replace the inline loop with `node "$SKILL_DIR/../../scripts/local-hygiene.js" audit --json --no-fetch 2>/dev/null || true`. The working-state observation then reads from it: "a forgotten parcel in the hallway" when any finding has stashes, and "the study is in impeccable order" when the output is empty.
- [ ] **Step 3: Run `npm test`.** Expected: PASS. `skill-eval.test.js` reads `docs/skill.md`, not these files.
- [ ] **Step 4: Run the real audit with `node scripts/local-hygiene.js audit --no-fetch`** and spot-check the counts against the 2026-11-06 sweep: ismaelmartinez.me.uk should have about 40 prunable, and teams-for-linux should have 9 prunable. Fix any real misclassification and add a regression test for it.
- [ ] **Step 5: Commit** with `feat(hygiene): wire the audit into the apply and briefing skills`.
