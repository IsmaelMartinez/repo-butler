---
name: repo-butler
description: Use when the user asks for a portfolio briefing, debrief, status update, morning standup, end-of-day summary, or "what did I do today" across their repo-butler-managed repos.
---

# Repo Butler

Generate an ASCII comic strip in which Reginald — a dignified, slightly world-weary Scottish-trained butler — delivers either a morning briefing or an evening debrief on the user's repo-butler-managed portfolio. Reginald has served the household for years, takes quiet pride in repos that reach Gold tier, is gently disapproving of repos without licenses ("legally undressed, sir") and genuinely distressed by critical vulnerabilities ("most alarming, sir — I've laid out the smelling salts").

## Mode dispatch

The first positional argument selects the office Reginald should attend to. Default is `briefing`.

```bash
MODE="${1:-briefing}"
case "$MODE" in
  briefing|debrief) ;;
  *)
    cat <<'EOF'
+================================================================+
|  .-------.                                                     |
|  | >   < |  "I do not recognise that office, sir."             |
|  |  \_/  |                                                     |
|  | /   \ |  "May I suggest 'briefing' or 'debrief'?"           |
|  '---|---'                                                     |
|      |                                                         |
|     /|\                                                        |
+================================================================+
EOF
    exit 0
    ;;
esac
```

No clock magic — the user picks the mode explicitly.

## Setup — resolve the repo-butler checkout and owner

Inline these helpers once at the top of the bash session. They are reused by both modes.

```bash
resolve_repo_butler() {
  if [ -n "$REPO_BUTLER_PATH" ] && [ -d "$REPO_BUTLER_PATH/.git" ]; then
    echo "$REPO_BUTLER_PATH"; return 0
  fi
  d="$PWD"
  while [ "$d" != "/" ] && [ -n "$d" ]; do
    if [ -f "$d/.github/roadmap.yml" ] && [ -f "$d/src/mcp.js" ]; then
      echo "$d"; return 0
    fi
    d=$(dirname "$d")
  done
  for c in "$HOME/projects/github/repo-butler" "$HOME/repo-butler"; do
    if [ -d "$c/.git" ] && [ -f "$c/.github/roadmap.yml" ]; then
      echo "$c"; return 0
    fi
  done
  return 1
}

resolve_owner() {
  git -C "$1" remote get-url origin 2>/dev/null \
    | sed -E 's|.*[:/]([^/]+)/[^/]+(\.git)?$|\1|'
}

REPO=$(resolve_repo_butler) || { echo "Reginald cannot locate the repo-butler residence, sir. Set REPO_BUTLER_PATH or run from inside the checkout."; exit 1; }
OWNER=$(resolve_owner "$REPO")
[ -n "$OWNER" ] || { echo "Reginald cannot determine the repository owner, sir."; exit 1; }
```

If `resolve_repo_butler` returns non-zero, render a single panel with Reginald saying "I cannot locate the repo-butler residence, sir. Set REPO_BUTLER_PATH or run me from inside the checkout." and stop.

## Briefing mode — data fetchers

Run this block when `MODE=briefing`.

```bash
# Latest snapshot
git -C "$REPO" show origin/repo-butler-data:snapshots/latest.json 2>/dev/null

# Latest portfolio weekly (find newest file)
LATEST_WEEKLY=$(git -C "$REPO" ls-tree --name-only origin/repo-butler-data snapshots/portfolio-weekly/ 2>/dev/null | sort | tail -1)
git -C "$REPO" show "origin/repo-butler-data:$LATEST_WEEKLY" 2>/dev/null

# Governance findings (may not exist yet)
git -C "$REPO" show origin/repo-butler-data:snapshots/governance.json 2>/dev/null

# Local working state across all known project directories
for dir in "$HOME/projects/github/"*/ "$HOME/projects/gitlab/"*/; do
  [ -d "$dir/.git" ] || continue
  repo=$(basename "$dir")
  status=$(git -C "$dir" status --porcelain 2>/dev/null | head -5)
  branches=$(git -C "$dir" branch --no-merged main 2>/dev/null | grep -v '^\*' | head -5)
  stash=$(git -C "$dir" stash list 2>/dev/null | head -3)
  current=$(git -C "$dir" branch --show-current 2>/dev/null)
  if [ -n "$status" ] || [ -n "$branches" ] || [ -n "$stash" ]; then
    echo "REPO:$repo|BRANCH:$current|DIRTY:$([ -n "$status" ] && echo yes || echo no)|UNMERGED:$(echo "$branches" | grep -c .)|STASH:$(echo "$stash" | grep -c .)"
  fi
done
```

If the data commands all return empty, tell the user: "The butler is indisposed — no portfolio data found on the repo-butler-data branch. Run the pipeline first."

Parse the portfolio weekly JSON. It is a map of repo names to objects with fields: `open_issues`, `commits_6mo`, `stars`, `license`, `communityHealth`, `ciPassRate`, `vulns`, `ci`, `released_at`, `pushed_at`. Compute total repo count, the health-tier distribution using the rules from `computeHealthTier` (Gold: license present, ci>=2, communityHealth>=80, pushed <180d, released <90d, vulns!=null, no critical/high vulns; Silver: license present, ci>=1, communityHealth>=50, pushed <180d; Bronze: commits>0 or pushed <365d; None: everything else), the top concerns (repos with critical/high vulns, CI pass rate <90%, missing license), and the top three repos by `commits_6mo`. If governance findings exist, count standards gaps, policy drift, and tier uplift opportunities.

Parse the local working state output and identify which repos have uncommitted changes, which are on feature branches with work in flight, and which have stashed work. Note specific repo names and branches — Reginald's study panel must reference real items, not vague counts.

## Debrief mode — data fetchers

Run this block when `MODE=debrief`.

```bash
# Today's session activity from claude history
node -e "
const fs = require('fs');
const path = process.env.HOME + '/.claude/history.jsonl';
if (!fs.existsSync(path)) { console.log('[]'); process.exit(0); }
const lines = fs.readFileSync(path, 'utf8').trim().split('\n');
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

# Today's git activity across all repos (GitHub + GitLab)
find "$HOME/projects/github" "$HOME/projects/gitlab" -maxdepth 5 -name ".git" -type d 2>/dev/null | while read gitdir; do
  dir=$(dirname "$gitdir")
  repo=$(echo "$dir" | sed "s|$HOME/projects/||")
  commits=$(git -C "$dir" log --since="midnight" --oneline --all 2>/dev/null)
  if [ -n "$commits" ]; then
    count=$(echo "$commits" | wc -l | tr -d ' ')
    echo "REPO:$repo|COMMITS:$count"
    echo "$commits" | head -5 | while read line; do echo "  $line"; done
  fi
done

# Today's GitHub PR activity, scoped to the portfolio
PORTFOLIO=$(git -C "$REPO" show origin/repo-butler-data:snapshots/latest.json 2>/dev/null \
  | node -e "let d=''; process.stdin.on('data',c=>d+=c); process.stdin.on('end',()=>{
      try { const j=JSON.parse(d); console.log(Object.keys(j.portfolio||{}).join(' ')); }
      catch { process.exit(1); }
    })" 2>/dev/null)
if [ -z "$PORTFOLIO" ]; then
  PORTFOLIO=$(gh repo list "$OWNER" --limit 50 --json name --jq '.[].name' 2>/dev/null | tr '\n' ' ')
fi

TODAY=$(date +%Y-%m-%d)
for repo in $PORTFOLIO; do
  counts=$(gh pr list --repo "$OWNER/$repo" --state all --limit 100 \
    --json createdAt,mergedAt,closedAt 2>/dev/null \
    | node -e "let d='';process.stdin.on('data',c=>d+=c);process.stdin.on('end',()=>{
        try {
          const a=JSON.parse(d), t='$TODAY';
          const m=a.filter(p=>p.mergedAt?.startsWith(t)).length;
          const o=a.filter(p=>p.createdAt?.startsWith(t)).length;
          const c=a.filter(p=>p.closedAt?.startsWith(t) && !p.mergedAt?.startsWith(t)).length;
          console.log(\`\${m} \${o} \${c}\`);
        } catch { console.log('0 0 0'); }
      })" 2>/dev/null)
  read merged opened closed <<<"$counts"
  if [ "$merged" != "0" ] || [ "$opened" != "0" ] || [ "$closed" != "0" ]; then
    echo "GH:$repo|MERGED:$merged|OPENED:$opened|CLOSED:$closed"
  fi
done

# Today's GitLab MR activity (only for repos with commits today; skip if glab missing)
find "$HOME/projects/gitlab" -maxdepth 5 -name ".git" -type d 2>/dev/null | while read gitdir; do
  dir=$(dirname "$gitdir")
  repo=$(echo "$dir" | sed "s|$HOME/projects/gitlab/||")
  has_commits=$(git -C "$dir" log --since="midnight" --oneline --all 2>/dev/null | head -1)
  if [ -n "$has_commits" ]; then
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

If no sessions, no commits, and no PR/MR activity are found, Reginald reports: "A most tranquil day, sir. Not a single commit disturbed the silence."

Parse the data and compute total sessions, total duration, repos touched, total commits across GitHub + GitLab, PRs/MRs merged/opened/closed today, the most-used commit themes, and the top three repos by commit count today. Fold the raw totals into the prose of the surviving panels — there is no separate ledger panel.

## Comic frame and panel template

One frame, one set of eye glyphs, one panel template. The mode-specific content varies; the frame does not. Use exactly four panels (Header / Concerns or Accomplishments / Study or Active Repos / Sign-off). Stick-figure Reginald is unchanged in this PR — visual uplift is deferred.

```
+================================================================+
|  {TITLE}                                          {date}       |
+================================================================+
|                                                                |
|  .-------.                                                     |
|  | {EYE} |  "{line_1}"                                         |
|  |  \_/  |                                                     |
|  | /   \ |  "{line_2}"                                         |
|  '---|---'                                                     |
|      |       {detail_1}                                        |
|     /|\      {detail_2}                                        |
|              {detail_3}                                        |
|                                                                |
+----------------------------------------------------------------+
```

Eye glyphs by mood: `B B` neutral, `> <` worried, `o o` observant, `^ ^` pleased, `- -` calm. Use `\-/` rather than `\_/` for the calm sign-off mouth.

## Briefing mode — panels

Title: `THE DAILY BUTLER BRIEFING`. Four panels.

Panel 1 — The Morning Report. Eyes neutral `B B`. Reginald greets the user and folds the tier counts into prose: "Your portfolio of {N} repos stands as follows: {gold} Gold, {silver} Silver, {bronze} Bronze, {none} Unranked. A {pleased|concerned} morning." If the portfolio is mostly Gold/Silver his tone is pleased; mostly Bronze/None, concerned. The bare tier-distribution panel from the old briefing is gone — its numbers live here.

Panel 2 — The Concerns. Eyes worried `> <`. The top three concerns from: repos with critical/high vulns, repos with CI pass rate below 70%, repos missing a license, governance standards gaps. If there are no concerns, replace this panel with a congratulatory variant (eyes pleased `^ ^`, line: "I have nothing to draw to your attention, sir — a most agreeable state of affairs.").

Panel 3 — The Study. Eyes observant `o o`. Reginald reports on local working state: how many repos have uncommitted work, which branches are in flight, any stashed work that might be forgotten. Reference specific repo names and branches. If a repo is on a feature branch with dirty state, that is active work in progress. Stashes older than the last commit get a gentle note ("a forgotten parcel in the hallway, sir"). If everything is clean: "the study is in impeccable order, sir." Two or three specific observations, not an exhaustive list. Skip this panel entirely if no local project directories are found.

Panel 4 — Sign-off. Eyes calm `- -`. Vary the closing remark: "Will that be all, sir?", "Shall I draw a bath while you triage?", "I've taken the liberty of pressing your commits.", "The portfolio, like a fine wine, improves with attention.", "I shall prepare the tea. Earl Grey, as befits a Silver-tier morning.", "Very good, sir. I shall be in the pantry, rebasing.", "If I may say so, sir, a most productive sprint." Mention the most active repos and any positive trends inside this panel — top three by `commits_6mo` with their commit counts, plus governance uplift opportunities if any repo is close to the next tier.

## Debrief mode — panels

Title: `THE EVENING DEBRIEF`. Four panels.

Panel 1 — The Evening Report. Eyes neutral `B B`. Session count, repos touched, approximate working duration folded into prose: "You had {session_count} session(s) today across {repo_count} repo(s), spanning roughly {total_duration} minutes of work." If it was a long day (>4 hours), Reginald is impressed; if quiet (<30 min), gentle.

Panel 2 — The Accomplishments. Eyes pleased `^ ^`. The top three to five things accomplished, derived from commit messages. Group related commits ("dashboard restructure shipped via PR #93" rather than five individual commits). Fold the raw totals — total commits, PRs merged/opened/closed across GitHub + GitLab — into the closing line of this panel ("In total, {total_commits} commits, {prs_merged} PRs merged, {prs_opened} opened, {prs_closed} closed."). The bare ledger panel from the old debrief is gone — its numbers live here.

Panel 3 — The Active Repos. Eyes observant `o o`. Top three repos by commit count today with counts. If only one repo was active, Reginald focuses on depth rather than breadth and notes the dominant theme of the day's commits.

Panel 4 — Sign-off. Eyes calm `- -`. Examples: "A most productive day, sir. I shall press your commits.", "The repositories are well-tended, sir. Shall I draw a bath?", "I note several branches remain in flight, sir. Tomorrow's concern, perhaps.", "If I may say so, sir — that was rather a lot of rebasing.", "The estate prospers under your stewardship, sir." Reginald notices patterns: lots of Dependabot merges ("the automated staff have been busy, sir"), lots of review comments ("the critics were vocal today, sir"), lots of subagent dispatches ("you delegated liberally, sir — a sign of good management").

## Tone

Formal British English with a Scottish undertone. Reginald has opinions — Gold repos get genuine warmth ("a credit to the household, sir"), Bronze repos get gentle encouragement ("showing promise, sir, like a young cask"), Unranked repos get diplomatic concern ("perhaps best left to rest, sir?"). Many small commits get approval ("methodical, sir"); large monolithic commits get gentle reproach ("rather a parcel, sir — perhaps smaller packages next time?"). Dry wit is essential. Occasional weather, tea, or garden metaphors for portfolio health. Never use emoji in the comic itself. Numbers must be specific (not "some" or "several"). Reference actual repo names. Keep each speech bubble to two or three lines.

## Output

Output ONLY the comic strip — no preamble, no explanation, no markdown code fences around it. Print directly so it renders nicely in the terminal. Sign off as "-- Reginald" at the bottom-right of the final panel.
