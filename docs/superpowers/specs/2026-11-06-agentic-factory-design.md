# Design: the "your move" factory

Date: 2026-11-06
Status: PROPOSED. Nothing here is scheduled. The owner skipped the brainstorming questions and asked for the design straight from the 2026-11-06 portfolio sweep, so every choice below not stated by the owner is marked as the author's call.

Facts were read from `origin/main` at `f024c8e4` and from live `gh` output on 2026-11-06.

## Intent

The owner manages about 25 repositories. Several are community projects (teams-for-linux carries 13 open PRs and 21 open issues), and agent sessions do much of the work. The recurring cost is not a lack of hands. It is that the answer to "what is waiting on me, and what do I do about it" is spread across GitHub queues, release PRs stuck behind a CI quirk, and local worktrees and stashes left by agent sessions. Nothing joins these up, so every working session starts with a manual sweep. The 2026-11-06 sweep needed four subagents and found:

- a 2.29.0 regression report (teams-for-linux #3172) where the reporter had answered the owner's questions three days earlier;
- two release-please PRs (teams-for-linux #3158 and delegate-local #690) blocked only because CI never triggered;
- a community PR (#2998) about four days from being closed by the stale bot;
- 90 linked worktrees in ismaelmartinez.me.uk, 53 in pr-agent and 24 in teams-for-linux, 40 of the first with a merged or closed PR;
- a pr-agent checkout on a detached HEAD with 68 staged files and 7 stashes.

The factory turns that sweep into data repo-butler already knows how to carry: governance findings with a remediation plan. Each finding names the existing skill that knows how to act on it. Every outward action still comes back to the owner as a draft or as an exact command.

"Factory" is the owner's word. In practice it means three new detectors, a worker-routing field on the existing remediation contract, and a dispatch step in the existing apply skill, not a new autonomous system.

## Goals

- One list, read over MCP, of every open PR or issue on an eligible repo where the next move is the owner's, ordered by how long it has waited and how much it matters.
- Release PRs that are waiting, with the reason (CI never triggered, CI red, awaiting merge) and the exact commands to unblock them.
- A local audit of worktrees and stashes across the project directories. It sorts each one into safe to prune, needs a look, or live, and prints the commands to act on it.
- A dispatch step that takes each finding to the skill that already handles that kind of work: teams-for-linux-issue-review for teams-for-linux, pr-maintainer for other upstream or community repos, repo-butler-apply's existing trays for governance fixes, and handover for session state.
- A record of every dispatched action and whether the owner accepted it unchanged. That record is what lets a narrow, boring action class run unattended later.

## Non-goals

- Writing replies, reviews or fixes. The worker skills already do that, and this design does not change them.
- Covering archived repos. All eight dormant repos in the sweep (logger-to-kibana, leapp-codeartifact-login-plugin, seagate-photos, votescot and others) are archived, so their roughly 30 bot PRs cannot act and are noise. `eligibleRepos` already drops archived repos, and the factory inherits that.
- Replacing issue-factory. That system supplies verified issues to the upstream pr-agent project, under its own no-write constraints. It stays separate. Only its graduation rule is borrowed.
- Watching private repos. They stay out of the governance lane, as AGENTS.md and the guard in `governance.test.js` require.

## Anti-goals

These would make the factory a failure even if it technically worked:

- Anything that merges. The owner's standing rule is that every merge needs explicit confirmation per PR. A green pipeline is not permission, and no graduation ever covers merging.
- Posting to GitHub without approval. Comments, reviews, labels, closes and reopens are outward-facing. They are drafted and shown, never sent on the factory's own initiative, until a class has graduated under the rule below. Even then only the classes listed there qualify.
- A queue that cries wolf. If the owner-move list routinely contains items that are really the author's move, the owner will stop reading it. Being accurate about whose move it is matters more than catching everything.
- Losing work. The local audit never deletes a worktree with uncommitted changes, unpushed commits or a stash, whatever its PR state.
- Another unread report. The ideas pipeline produced 32 ideas and 0 routed proposals in 14 weeks (#426). Every finding here must name a concrete next action, or it is not emitted.

## Where things stand

`runGovernance` (`src/governance.js`) runs deterministic detectors over `eligibleRepos(portfolio.repos)` and shares one open-PR sweep between them (`fetchOpenPRs`). It attaches a remediation plan to every finding with `attachRemediationPlans` and writes `snapshots/governance.json` to the data branch. `buildRemediationPlan` returns `{ executor, targetFiles, intent, rationale, acceptanceCriteria }`, and `executor` is one of `template`, `settings`, `agent` or `manual`. The finding types are listed in `schemas/v1/governance-finding.v1.schema.json`.

`auditDependabot` (`src/dependabot-audit.js`, 58 lines) and `auditButlerPRs` (`src/butler-pr-audit.js`) are the models for a new PR-reading audit. Both never throw, both read the shared `openPRs` map, and `classifyPR` in the butler-PR audit already maps `gh.prCiState` onto human states (`awaiting-human`, `ci-none`, `ci-pending`, `blocked-persistent`, `blocked-transient`).

`src/mcp.js` serves `get_governance_findings` from the data branch with a staleness envelope.

`skills/repo-butler-apply` sorts findings into template, agent and manual trays. Its manual tray is listed only, and nothing is automated.

`skills/repo-butler` already runs a local bash block over `REPO_BUTLER_PROJECTS_DIRS`, reporting dirty state, unmerged branches and stashes, but only as a one-line observation for the comic.

The pipeline has been red since 2026-11-04 21:40. Provider validation fails with `Gemini API error: 402` before any phase runs (runs 41918238868 onwards). The new detectors are deterministic and need no LLM, but they will not run while that step fails the job.

## Design

### 1. Owner-move detector (`src/owner-move.js`, finding type `owner-move`)

For every eligible repo, this detector lists the open issues and PRs whose next move is the owner's.

Inputs. The open-PR list comes from the shared `openPRs` map. Open issues come from one paginated `/repos/{o}/{r}/issues?state=open` read per repo, with PRs dropped by the `pull_request` key. Conversation comments come from one `/repos/{o}/{r}/issues/comments?since=<60 days ago>` read per repo, grouped by issue number. Reviews come from `/pulls/{n}/reviews`, read only for open PRs. With teams-for-linux's queue that is about 15 calls per repo per run.

"Whose move" is decided from the last human actor. A human is any login that is not a bot. Bots are `[bot]`-suffixed logins plus a small configured list (`owner_move.ignore_actors` in `.github/roadmap.yml`, for actors such as a stale bot that comments as a user). An item is the owner's move when any of these holds:

- it has no comment from the owner and is older than `owner_move.grace_days` (default 2);
- the last human comment is from someone other than the owner;
- it is a PR with commits pushed after the owner's latest review;
- it is a PR from a first-time contributor whose workflow runs are waiting for approval (`/actions/runs?status=action_required` for its head SHA).

It is the author's move, and is left out, when the owner commented or reviewed last, or when the owner's latest review is `CHANGES_REQUESTED` with no push since.

The `awaiting-user-feedback` label settles nothing on its own. The label lags, and the comment trail is the truth.

Each item carries `{ kind: 'pr'|'issue', number, title, reason, waitingDays, labels }`, with `reason` one of `no-response`, `reporter-replied`, `pushed-since-review`, `ci-approval-needed` or `stale-closing`. `stale-closing` is set when the item carries the stale label (`owner_move.stale_label`, default `stale`) or the stale bot has warned. Its `waitingDays` is how many days remain before the bot closes it, if that can be read from the warning, and it always sorts first.

Findings are one per repo, like `dependabot-stale`. Priority is `high` when any item is `stale-closing`, is labelled `bug` and has waited more than 2 days, or has waited more than 7 days. Otherwise it is `medium`.

Author-stale items are a second, separate list. These are PRs where the author owes a move and has been silent for more than 14 days, such as #3095 and #3098 in the sweep. They go in the same finding as `authorStale[]` with priority `low`, so the owner can decide on a nudge. They never raise the finding's priority.

### 2. Release-pending detector (`src/release-pending.js`, finding type `release-pending`)

This detector finds release PRs that are waiting.

A release PR is an open PR whose head ref starts with `release-please--`, whose author is `github-actions[bot]` or the repo's release App, or which carries the `autorelease: pending` label. Two out of three is enough. The idea mirrors `isVerified` in the butler-PR audit: the branch name is the main locator, and identity only backs it up.

State comes from `classifyPR` in `src/butler-pr-audit.js`. It should be exported and reused rather than copied. One extra state is added: `ci-not-triggered`. It applies when the head SHA has check runs but none from the workflows that run on other PRs in that repo, compared against the latest merged non-release PR's check names. This is the known release-please case: a PR opened with the default token triggers no workflows, and only external apps such as SonarCloud report. `ci-not-triggered` takes precedence over `awaiting-human`, because `prCiState` reads those few external checks as green.

The finding fires when a release PR has been open more than `release_pending.grace_days` (default 2). The finding carries `{ number, title, version, state, waitingDays, mergeMethod }`, where `version` is parsed from the title and `mergeMethod` comes from the repo's allowed merge methods (squash preferred). Priority is `high` when the repo has an open issue labelled `bug` that was created after the previous release tag (a shipped regression waiting on a release), and `medium` otherwise.

### 3. Remediation: a `worker` field and exact commands

`buildRemediationPlan` gains cases for both new types, with `executor: 'manual'`, and two optional fields on the plan.

The first is `worker`, the name of the skill that should handle the finding. For `owner-move` it is the repo's entry in a new `factory.workers` map in `.github/roadmap.yml`, `{ teams-for-linux: teams-for-linux-issue-review }`, falling back to `pr-maintainer`. For `release-pending` there is no worker, because the commands are the whole remediation.

The second is `commands`, an array of exact single-line shell commands, never chained. For `ci-not-triggered` they are `gh pr close N -R owner/repo` and `gh pr reopen N -R owner/repo`. For a release PR that is green, it is `gh pr merge N -R owner/repo --<method> --delete-branch`. These are presented to the owner; nothing in the pipeline or the skill runs them unprompted.

Commands are built only from enum values and `REPO_NAME_PATTERN`-checked names, never from PR titles or bodies. This is the same fixed-string rule as ADR-005.

The schema gains both types, `worker`, `commands`, and the item shapes above. `get_governance_findings` returns them unchanged, and its description and summary counts (`ownerMoveItems`, `releasesPending`) are extended.

### 4. Local hygiene audit (`scripts/local-hygiene.js`, local only)

The pipeline reads only the GitHub API, so it cannot see local state. This is a zero-dependency Node script, in the same style as `scripts/check-skills.js`. It walks `REPO_BUTLER_PROJECTS_DIRS`, and for every repo it reads `git worktree list --porcelain`, `git stash list`, `git status --porcelain` and `git worktree prune --dry-run`, after one `git fetch --prune` per repo. It prints JSON findings of type `local-hygiene`, one per repo, in the same shape and with the same remediation contract. It never writes to the data branch, because local state is per machine and the data branch is shared.

Each worktree is classified as follows.

`prunable` requires all of these to hold:

- the worktree has no uncommitted changes;
- it has no commits that are not on a remote branch;
- no stash references its branch;
- it is not locked by a live process (the lock reason's PID is checked with `kill -0`);
- its branch is merged, by `git branch --merged` or by a merged or closed PR found with `gh pr list --state all --head`.

`needs-look` covers worktrees that are dirty, have unpushed commits, have no PR and no merge, or sit on a detached HEAD.

`live` covers worktrees with an open PR.

`stale-entry` covers anything `git worktree prune --dry-run` reports.

Stashes are listed with their age and their source branch, along with whether that branch has since merged. They are never classified as prunable, because a stash's content cannot be proven to have landed.

A checkout with more than 20 dirty files, on a detached HEAD, or with more than 3 stashes gets a separate `at-risk` flag. pr-agent is the motivating case.

The remediation `commands` for prunable worktrees are `git -C <repo> worktree remove <path>` followed by `git -C <repo> branch -d <branch>`, one command per line. `-d` refuses unmerged branches, so a classification mistake fails safe. For `at-risk` checkouts the command creates a WIP branch, `git -C <repo> switch -c wip/<date>-rescue`. It never stashes and never resets.

The `repo-butler` briefing skill swaps its inline bash block for this script and keeps its one-line observation. That removes a copy rather than adding one.

### 5. Dispatch, in `repo-butler-apply`

The apply skill's manual tray stops being list-only. Before the trays, it also runs `scripts/local-hygiene.js` and merges the local findings into the manual tray.

For each manual finding, in priority order, the skill does one of three things:

- When the finding has a `worker`, it offers to run that skill on the finding's items. It passes the repo and item numbers, and the worker produces its usual drafts for approval.
- When the finding has `commands`, it shows them verbatim and runs one only when the owner says so for that item.
- When it has neither, it lists the finding exactly as today.

The owner's existing rules carry over unchanged:

- drafts are shown two at a time;
- a "merge it" for a named item is the confirmation;
- nothing is chained into a wakeup.

When the dispatch spans more than one repo, the skill asks the handover skill to write a progress note before the first worker starts. That way a dropped session loses nothing.

No new skill is created. A separate dispatcher skill would repeat the apply skill's setup and almanac-staleness blocks, and the apply skill already owns "route findings by executor".

### 6. The approvals record and graduation

Every dispatched action appends one line to `~/.local/state/repo-butler/approvals.jsonl`:

`{ ts, findingType, actionClass, repo, item, outcome }`

`outcome` is one of `accepted-unchanged`, `edited`, `rejected` or `skipped`. The action classes are fixed strings, such as `prune-merged-worktree`, `release-reopen-for-ci` and `owner-move-reply`.

The rule is borrowed from issue-factory's BUILD-PLAN. A class graduates after 8 consecutive `accepted-unchanged` outcomes, and any `edited` or `rejected` outcome resets its count. Graduation is a config change the owner makes by hand (`factory.graduated` in `~/.config/repo-butler/config.sh`), not something the skill does to itself.

Only two classes are eligible:

- `prune-merged-worktree`, which is local and reversible from the remote;
- `release-reopen-for-ci`, a close and reopen of a bot's own PR that changes no content.

Replies, reviews, labels, nudges and merges are never eligible. A graduated class runs without asking only inside an owner-started apply run, and it still prints what it did.

## Phasing

Phase 0 is a prerequisite, not part of this design. The Gemini 402 has to be resolved, or provider validation has to stop failing the deterministic phases. Today it blocks all governance output.

Phase 1 is the local hygiene audit plus its dispatch path. It has the fastest payoff, needs no pipeline run, and exercises the approvals record against the 40 or more prunable worktrees in the sweep.

Phase 2 is `release-pending`. It is small, and it catches a problem that has bitten twice.

Phase 3 is `owner-move`. It is the largest, and it is where accuracy has to be proven. It ships report-only first, and the owner compares one week of its output against a manual sweep before its findings reach the apply skill. This is the same soak idea as ADR-007's stages.

## Dependencies on open decisions

Issues #424 to #426 are on hold, and #427 and #428 are settled according to #429. None of them blocks this design. The 2026-11-06 sweep said they should be decided first; on reading them, that was too strong.

#424 (reusable Action or own-portfolio tool) only changes whose "owner" the detector compares against, and that is already the `owner` input.

#425 (the monitor) is unrelated.

#426 (the ideas soak) is complementary. If the soak ends and IDEATE becomes a digest of governance findings, the owner-move and release-pending findings are natural content for that digest.

## Decided here, as the author's call

The owner gave no direction beyond "build an agentic factory for repo-butler". These are the author's calls, for the owner to check:

- it lives inside repo-butler, not issue-factory or a new repo;
- dispatch extends `repo-butler-apply` rather than adding a skill;
- local state stays off the data branch;
- the two graduation-eligible classes are the ones listed in section 6;
- the default thresholds are 2-day grace, 7-day high, 14-day author-stale and 60-day comment window;
- the phase order is local hygiene, then release-pending, then owner-move.

## Left to the builder

These are left to the builder:

- the exact bot heuristics beyond the `[bot]` suffix and the configured list;
- how to parse the stale bot's close date;
- the check-name comparison behind `ci-not-triggered`, provided it fails closed: an unreadable comparison yields `unknown`, never `awaiting-human`;
- the schema field descriptions;
- test fixtures;
- how the apply skill's comic panels depict the new tray behaviour.

Every new audit follows the existing never-throw contract, so a failure degrades to "this detector found nothing" and never to stale output.
