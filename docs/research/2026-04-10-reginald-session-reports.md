# Reginald Session Reports — Research

Date: 2026-04-10

## Idea

Extend the butler-briefing skill with a second report type: a session activity report where Reginald reviews Claude Code session history and summarises what was accomplished, using a local model (Gemma 4 or similar via Ollama) to process the session transcripts.

## Two Report Types

1. `/butler-briefing` (existing) — portfolio health status from repo-butler snapshot data. Already works. ASCII comic with Reginald.

2. `/butler-debrief` (new) — session activity summary. Reginald reviews the day's Claude Code sessions and presents what was worked on, PRs opened/merged, files changed, and notable decisions. Uses a local model to summarise large session transcripts.

## Session Data Available

Claude Code stores session data in `~/.claude/projects/{project-dir-hash}/`. The data structure:

`~/.claude/history.jsonl` — one line per user message across all sessions. Fields: `display` (user message preview, ~80 chars), `timestamp` (epoch ms), `project` (absolute path), `sessionId`. This is the index — 8600+ entries, lightweight, easy to scan for today's sessions.

`~/.claude/projects/{hash}/{sessionId}.jsonl` — full session transcript. Each line is a JSON message with `type` (user/assistant), `message.content` (the actual text/tool calls), `timestamp`, `cwd`, `gitBranch`. These files can be large (2000+ lines for long sessions like this one). Subagent transcripts live in `{sessionId}/subagents/agent-{id}.jsonl`.

## Processing Pipeline

The skill would:

1. Scan `history.jsonl` for today's entries, group by sessionId and project.
2. For each session, read the session JSONL and any subagent transcripts under `{sessionId}/subagents/agent-{id}.jsonl` to extract: user messages (the intent), tool calls (what was done — especially git commits, file edits, bash commands), and assistant summaries. Subagent transcripts often hold the substantive work for delegated tasks and would be missed otherwise.
3. Feed the extracted data to a local model (Gemma 4 via Ollama) with a prompt like: "Summarise this Claude Code session in 3-5 bullet points. Focus on what was built, fixed, or shipped. Include PR numbers and repo names."
4. Aggregate the summaries into Reginald's comic format.

## Why a Local Model

The session JSONLs are too large to feed directly into the butler-briefing skill's context. This session alone is 2000+ lines of JSONL. A local model can process each session's transcript independently and return a concise summary. Gemma 4 (12B or 27B) running via Ollama can handle this at acceptable speed.

Alternative: instead of summarising the full transcript, extract only the git commits made during the session (`git log --since="today"` per repo) and the user's messages from `history.jsonl`. This might be sufficient without needing a local model at all — git commits are already concise summaries of what was done.

## Hybrid Approach (Recommended)

For the initial version, skip the local model entirely. Use git history as the primary data source:

1. Parse `history.jsonl` first to identify which project directories had Claude sessions today — this is the cheap index. Iterating every project dir blind would do unnecessary disk I/O.
2. For each active project, run `git log --since="today" --oneline --all` to get today's commits.
3. Count PRs opened/merged today via `gh pr list --state all --limit 50 --json createdAt,mergedAt,number,title` (the `--limit` keeps the request bounded for repos with large PR histories).
4. Present the data as Reginald's evening debrief.

This avoids the Ollama dependency entirely. If richer summaries are needed later, add the local model as an enhancement.

For the local model version, the flow would be: extract user messages from `history.jsonl` (already short previews) and git diffs, send to Gemma 4 via `ollama run gemma4 "Summarise: {data}"`, and incorporate into the comic.

## ASCII Comic Format

Same visual style as the butler-briefing but with different panels:

Panel 1: "The Evening Debrief" — how many sessions across how many projects today
Panel 2: "The Accomplishments" — top 3-5 things that were shipped (PRs, features, fixes)
Panel 3: "The Minutiae" — files changed, tests added, lines of code
Panel 4: "The Unfinished Business" — branches with uncommitted work, open PRs awaiting review
Panel 5: Sign-off — witty closing, tone based on productivity ("A most industrious day, sir" vs "A contemplative day, sir — the muse does not always cooperate")

## Implementation Location

This skill lives in `~/.claude/skills/butler-debrief/` alongside the existing `butler-briefing`. Both share the Reginald character but serve different purposes — one is forward-looking (what needs attention), the other is backward-looking (what was accomplished).

## Dependencies

Minimum version (git-only): no dependencies beyond git and gh CLI.
Enhanced version (local model): Ollama with Gemma 4 or similar. Check via `ollama list | grep gemma`.
