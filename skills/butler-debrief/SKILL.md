# Butler Debrief

Generate an ASCII comic strip summarising today's Claude Code session activity. The butler — Reginald, the same dignified, Scottish-trained butler from the butler-briefing — reviews what was accomplished across all repos today and presents the evening debrief.

## Steps

1. Gather today's session data from `~/.claude/history.jsonl`:

```bash
TODAY_START=$(date -u +%s)000
# Approximate: get entries from today by filtering timestamps
node -e "
const fs = require('fs');
const lines = fs.readFileSync(process.env.HOME + '/.claude/history.jsonl', 'utf8').trim().split('\n');
const todayStart = new Date(); todayStart.setHours(0,0,0,0);
const todayMs = todayStart.getTime();
const sessions = {};
for (const line of lines) {
  try {
    const d = JSON.parse(line);
    if (d.timestamp >= todayMs) {
      const key = d.sessionId;
      if (!sessions[key]) sessions[key] = { project: d.project, messages: [], first: d.timestamp, last: d.timestamp };
      sessions[key].messages.push(d.display);
      sessions[key].last = Math.max(sessions[key].last, d.timestamp);
    }
  } catch {}
}
const result = Object.entries(sessions).map(([id, s]) => ({
  id: id.slice(0,8),
  project: s.project?.split('/').pop() || 'unknown',
  messageCount: s.messages.length,
  durationMin: Math.round((s.last - s.first) / 60000),
  firstMessage: s.messages[0]?.slice(0, 80),
}));
console.log(JSON.stringify(result));
"
```

2. Gather today's git activity across all repos (including nested GitLab repos):

```bash
find ~/projects/github ~/projects/gitlab -maxdepth 5 -name ".git" -type d 2>/dev/null | while read gitdir; do
  dir=$(dirname "$gitdir")
  repo=$(echo "$dir" | sed "s|$HOME/projects/||")
  commits=$(git -C "$dir" log --since="midnight" --oneline --all 2>/dev/null)
  if [ -n "$commits" ]; then
    count=$(echo "$commits" | wc -l | tr -d ' ')
    echo "REPO:$repo|COMMITS:$count"
    echo "$commits" | head -5 | while read line; do echo "  $line"; done
  fi
done
```

3. Gather today's PR/MR activity across GitHub repos:

```bash
for repo in repo-butler teams-for-linux votescot local-brain sound3fy generator-atlassian-compass-event-catalog bonnie-wee-plot yourear ismaelmartinez.me.uk ai-model-advisor lounge-tv betis-escocia wifisentinel github-issue-triage-bot; do
  TODAY=$(date +%Y-%m-%d)
  merged=$(gh pr list --repo IsmaelMartinez/$repo --state merged --json number,title,mergedAt --jq "[.[] | select(.mergedAt | startswith(\"$TODAY\"))] | length" 2>/dev/null)
  opened=$(gh pr list --repo IsmaelMartinez/$repo --state all --json number,title,createdAt --jq "[.[] | select(.createdAt | startswith(\"$TODAY\"))] | length" 2>/dev/null)
  closed=$(gh pr list --repo IsmaelMartinez/$repo --state closed --json number,title,closedAt --jq "[.[] | select(.closedAt != null and (.closedAt | startswith(\"$TODAY\")))] | length" 2>/dev/null)
  if [ "$merged" != "0" ] || [ "$opened" != "0" ] || [ "$closed" != "0" ]; then
    echo "GH:$repo|MERGED:$merged|OPENED:$opened|CLOSED:$closed"
  fi
done
```

4. Gather today's MR activity across GitLab repos (if glab is configured):

```bash
# Find GitLab repos with today's git activity and check their MRs
find ~/projects/gitlab -maxdepth 5 -name ".git" -type d 2>/dev/null | while read gitdir; do
  dir=$(dirname "$gitdir")
  repo=$(echo "$dir" | sed "s|$HOME/projects/gitlab/||")
  # Only check repos that had commits today
  has_commits=$(git -C "$dir" log --since="midnight" --oneline --all 2>/dev/null | head -1)
  if [ -n "$has_commits" ]; then
    # Get the GitLab project path from the remote URL
    remote=$(git -C "$dir" remote get-url origin 2>/dev/null)
    if echo "$remote" | grep -q "gitlab"; then
      project_path=$(echo "$remote" | sed 's|.*gitlab.com[:/]||; s|\.git$||')
      TODAY=$(date +%Y-%m-%d)
      merged=$(glab mr list --repo "$project_path" --state merged --output json 2>/dev/null | node -e "const d=JSON.parse(require('fs').readFileSync('/dev/stdin','utf8')); console.log(d.filter(m => m.merged_at?.startsWith('$TODAY')).length)" 2>/dev/null || echo 0)
      opened=$(glab mr list --repo "$project_path" --state opened --output json 2>/dev/null | node -e "const d=JSON.parse(require('fs').readFileSync('/dev/stdin','utf8')); console.log(d.filter(m => m.created_at?.startsWith('$TODAY')).length)" 2>/dev/null || echo 0)
      if [ "$merged" != "0" ] || [ "$opened" != "0" ]; then
        echo "GL:$repo|MERGED:$merged|OPENED:$opened"
      fi
    fi
  fi
done
```

If `glab` is not authenticated, skip this step — the git commit data from step 2 is sufficient for GitLab repos.

5. If no sessions and no git activity found today, Reginald reports: "A most tranquil day, sir. Not a single commit disturbed the silence."

6. Parse the data and compute:
   - Total sessions, total duration, repos touched
   - Total commits made today across all repos (GitHub + GitLab)
   - PRs/MRs merged, opened, and closed today (GitHub + GitLab)
   - Top commit messages (to understand what was done)
   - Which repos saw the most activity

6. Optionally, if Ollama is available with a suitable model, generate richer summaries:

```bash
# Check if Ollama is running and has a model
OLLAMA_MODEL=$(ollama list 2>/dev/null | grep -i "gemma\|llama\|qwen" | head -1 | awk '{print $1}')
if [ -n "$OLLAMA_MODEL" ]; then
  # Feed commit messages to local model for a natural summary
  COMMITS=$(for dir in ~/projects/github/*/; do [ -d "$dir/.git" ] || continue; git -C "$dir" log --since="today" --format="%s" --all 2>/dev/null; done | head -20)
  SUMMARY=$(echo "Summarise these git commits from today's work in 2-3 sentences. Be concise: $COMMITS" | ollama run "$OLLAMA_MODEL" 2>/dev/null | head -5)
fi
```

If Ollama is not available, skip this step — the git data is sufficient.

7. Generate the ASCII comic. Use EXACTLY this format with 4-5 panels. Replace all placeholders with real data.

```
+================================================================+
|  THE EVENING DEBRIEF                              {date}       |
+================================================================+
|                                                                |
|  .-------.                                                     |
|  | B   B |  "Good evening, sir."                               |
|  |  \_/  |                                                     |
|  | /   \ |  "You had {session_count} session(s) today across   |
|  '---|---'   {repo_count} repo(s), spanning roughly            |
|      |       {total_duration} minutes of work."                |
|     /|\                                                        |
|                                                                |
+----------------------------------------------------------------+
|                                                                |
|  .-------.                                                     |
|  | ^   ^ |  "The day's accomplishments, if I may:"             |
|  |  \_/  |                                                     |
|  | /   \ |   {accomplishment_1}                                |
|  '---|---'   {accomplishment_2}                                |
|      |       {accomplishment_3}                                |
|     /|\                                                        |
|                                                                |
+----------------------------------------------------------------+
|                                                                |
|  .-------.                                                     |
|  | o   o |  "In the ledger, sir:"                              |
|  |  \_/  |                                                     |
|  | /   \ |   {total_commits} commits across {active_repos}     |
|  '---|---'     repo(s)                                         |
|      |       {prs_merged} PRs merged, {prs_opened} opened,     |
|     /|\        {prs_closed} closed                             |
|                                                                |
+----------------------------------------------------------------+
|                                                                |
|  .-------.                                                     |
|  | o   o |  "The most industrious corners of the estate:"      |
|  |  \_/  |                                                     |
|  | /   \ |   {top1_repo} ({top1_commits} commits)              |
|  '---|---'   {top2_repo} ({top2_commits} commits)              |
|      |       {top3_repo} ({top3_commits} commits)              |
|     /|\                                                        |
|                                                                |
+----------------------------------------------------------------+
|                                                                |
|  .-------.                                                     |
|  | -   - |  "{closing_remark}"                                 |
|  |  \-/  |                                                     |
|  | /   \ |                                      -- Reginald    |
|  '---|---'                                                     |
|      |                                                         |
|     /|\                                                        |
|                                                                |
+================================================================+
```

## Panel Content Rules

Panel 1 (The Evening Report): Session count, repos touched, approximate working duration. Reginald's eyes are neutral `B B`. If it was a long day (>4 hours), he is impressed. If quiet (<30 min), he is gentle about it.

Panel 2 (The Accomplishments): The top 3-5 things that were done, derived from commit messages. Group related commits ("dashboard restructure shipped via PR #93" rather than listing 5 individual commits). If an Ollama summary is available, use that. Otherwise, use the most significant commit messages. Reginald's eyes are pleased `^ ^`.

Panel 3 (The Ledger): Raw numbers — total commits, PRs merged/opened/closed, repos active. Reginald's eyes are observant `o o`. If many PRs were merged, he is pleased. If many were closed without merge, he notes it diplomatically.

Panel 4 (The Active Repos): Top 3 repos by commit count today. Reginald's eyes are observant `o o`. If only one repo was active, he focuses on depth rather than breadth.

Panel 5 (Sign-off): Witty closing based on the day's activity. Reginald's eyes are calm `- -`. Examples: "A most productive day, sir. I shall press your commits.", "The repositories are well-tended, sir. Shall I draw a bath?", "I note several branches remain in flight, sir. Tomorrow's concern, perhaps.", "If I may say so, sir — that was rather a lot of rebasing.", "The estate prospers under your stewardship, sir."

## Tone

Same as butler-briefing — formal British English with Scottish undertones. For the debrief, Reginald is slightly more relaxed (it's evening). He has opinions about workflow — many small commits get approval ("methodical, sir"), large monolithic commits get gentle reproach ("rather a parcel, sir — perhaps smaller packages next time?"). He notices patterns: lots of Dependabot merges ("the automated staff have been busy, sir"), lots of review comments ("the critics were vocal today, sir"), lots of subagent dispatches ("you delegated liberally, sir — a sign of good management").

## Output

Output ONLY the comic strip — no preamble, no explanation, no markdown code fences. Print directly for terminal rendering.
