# Design: the release advisor

Date: 2026-11-20
Status: ACCEPTED and implemented by `src/release-advisor.js`, `scripts/release-note.js` and the release-advice part of the apply skill's Section C. It replaces the release-pending detector of `2026-11-06-agentic-factory-design.md` (Phase 2). The Reginald pane described at the end is not built.

## Why

The first Phase 2 reported every release PR open for more than two days and led with close-and-reopen. That is wrong for a release-please repo. The release PR is meant to stay open and collect changes until the owner decides to ship, and teams-for-linux ships roughly weekly, so "open more than two days" is the normal state. The owner's question is a different one: is what has piled up worth shipping yet, and what would the release say?

## What it does

For every open release PR it gives one of five verdicts, with a one-sentence reason.

`release-now` means a critical or high Dependabot alert was fixed since the last release in code that ships, or a confirmed fix is merged for a bug filed since the last release. `breaking` means a breaking change is queued; it beats every other verdict, names any waiting security fix, and leaves the timing to the owner. `good-moment` means features or fixes have waited at least the repo's usual gap between releases. `wait` means they have not, and says in how many days they will have. `quiet` means only docs, chores, CI changes or dependency bumps are waiting, and is never shown as a nudge.

The verdict appears in the briefing, on the dashboard's Release Readiness table and, for the first three verdicts, as a note drafted for the release PR. It also reports two facts about the last release that nothing fails on when they are forgotten: a latest release still marked pre-release, and open issues labelled `release ready`.

## Goals, non-goals, anti-goals

The goals are a verdict that is right often enough to trust, a reason short enough to read, and a note the owner can approve at a glance.

It does not judge repos that are released by hand, which have no release PR; their commit-derived verdicts were the least reliable output of the design spike. It does not handle a second release line or back-ports. It does not publish or promote releases.

It never merges. It never posts without the owner's yes on the exact text. It never treats an open release PR as overdue, and it never repeats itself: a verdict carries the date it first held, so a consumer can fold a repeated verdict into a clause.

## The rules

All of this is deterministic code.

The source of what is waiting is the commits between the last published release's tag and the release PR's base branch, not the release PR body, which goes stale when a bot merges without triggering release-please. A `feat` commit is a feature. A `fix`, `perf` or `security` commit is a fix. Anything else, and anything scoped `deps`, `docs`, `ci` or `test`, is noise. A `Revert "…"` commit cancels the commit it names. A `!` or a `BREAKING CHANGE:` footer makes the release breaking; the version number cannot be used for that, because both repos set `bump-minor-pre-major`.

The usual gap is the median number of days between release days over the last thirty published releases, with several releases on one day counted once, clamped to between 3 and 30 days. A repo with fewer than five release days gets 7. Counting days rather than releases matters: delegate-local once shipped four times in a day.

A security fix counts only when the alert is critical or high, has runtime scope, was fixed after the last release, and sits in a manifest whose directory release-please packages (the `packages` keys of `release-please-config.json`, or the root). So a `docs-site/package-lock.json` alert in teams-for-linux never counts. Several alerts on one package are one fix at its worst severity. A commit that merely mentions security is not a security fix.

A confirmed fix counts only when an open issue carries both `bug` and `release ready`, is not `blocked`, was filed after the last release, and at least one fix commit is waiting. Without the date and the waiting fix, an old labelled issue would call for a release that contains only documentation.

## The note and the one write path

The note is a hidden marker line followed by at most six plain lines: the verdict and version, the reason, up to three features, up to three fixes, the security fixes, and whether the PR can be merged as it stands. Commit text in it is written by contributors and would be posted under the owner's account, so it is reduced to a character set without `@`, `#` or `:` and capped: it cannot mention anyone, reference an issue or form a link. For the same reason the note is never stored in a finding, where it would sit next to commands in what MCP clients read; it exists only in the live read. Reginald's voice stops at the briefing; nothing posted to GitHub says "sir".

`scripts/release-note.js draft` prints the live advice with the note and its sha256. `scripts/release-note.js post` takes that hash, re-reads the advice, and refuses unless the note it is about to post hashes to the same value. It then creates the comment, or edits its own earlier one in place. This makes "never posts without a yes" a mechanism: a model cannot pass different text through it, and a note that changed after the approval is refused. It edits only a comment written by the authenticated user, since anyone can type the marker.

## What stays from the first Phase 2

`src/release-pending.js` keeps what a release PR is (`isReleasePR`), whether it can be merged as it stands (`classifyReleasePR`, with `ci-not-triggered` and `ci-awaiting-approval`), the commands (`releaseCommands`) and the live re-check (`recheckRelease`). That state is now the last line of the note and a column on the dashboard. Commands are offered only for a verdict worth acting on. The two-day grace, the `waitingDays` field and the "bug filed since the release" priority are gone.

## Calls made while building

The reviewers of the design wanted a fixed seven-day floor. The owner asked for a cadence learnt per repo, so the floor is the repo's own median gap; it comes out at six or seven days for teams-for-linux either way.

A scoring formula with weights for features, fixes and reported bugs was designed, run against the portfolio and dropped. Its weights decided almost nothing, and its "reported bug" bonus counted issues the owner had filed himself.

Every open release PR gets a finding, including `quiet` ones, so the dashboard can show that it was read and the after-the-release facts have somewhere to live.

Dependency bumps are noise as commits, and count only through a real alert, so one bump is never counted twice.

## Not built: the Reginald pane

A Claude Code mod can dock a small pane beside the chat, opened with a slash command, that shows these verdicts and holds a drafted note until the owner approves it. A spike proved the mechanics, including that approving fills the prompt rather than posting. A pane cannot be dragged, because the terminal places it. It is deferred until the verdicts have run for a few weeks, and it must never open unasked. When it is built it reads these findings and posts only through `scripts/release-note.js post`.
