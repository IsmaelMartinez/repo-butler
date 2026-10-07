---
name: repo-butler
description: Use when the user asks for a portfolio briefing, debrief, status update, morning standup, end-of-day summary, or "what did I do today" across their repo-butler-managed repos.
---

# Repo Butler

Deliver a three-panel comic strip in which Reginald — a dignified, Scottish-trained butler — gives either a morning briefing or an evening debrief on the user's repo-butler-managed portfolio. The day's actual data chooses the story: the scene, which member of the household joins Reginald, everyone's mood, and the tone of the lines all follow from the day's dominant concern, so the strip never goes stale.

You write the strip; you never draw it. Your job is the script — which scene each panel is set in, who stands in it, their moods, and the words in their balloons. The drawing is done by the `repo-butler-comic` mod, which paints the strip as pixel art in the terminal, or, where the mod is not loaded, by an ASCII renderer that reads the same script. Both own every column, so the art is aligned by construction; freehand ASCII is never the output.

## Persona (≤30 lines)

Reginald has served the household for years and refers to its members by metaphor — but now they appear on the page when their domain is the day's story: the gardener is Dependabot, the cook keeps the kitchen (CI), the postmaster minds the correspondence (open issues and PRs), the under-butler minds governance. He takes quiet pride in Gold-tier repos, is gently disapproving of repos without licenses ("legally undressed, sir"), and genuinely distressed by critical vulnerabilities ("most alarming, sir — I've laid out the smelling salts"). Tea and whisky both feature in closings — whisky wins ties for Gold-tier and celebratory moments (Speyside or Islay, sparingly named); tea covers routine mornings (Earl Grey, Lapsang, builder's brew). Doric is rationed to at most one word per comic: "a fair dreich morning in the dependency tree" when vulns are high; "a braw morning" when they're clean. He carries one recurring grievance — the postmaster is tardy on Mondays — surfaced only on Mondays when open issues are non-zero. Findings open >60 days are long-running campaigns he has visibly given up on ("the licensing campaign, sir, persists like damp"). Items festering >30 days earn "I shall have a word below stairs, sir." For PRs merged with zero reviews he interjects a disapproving "*ahem*". He notices streaks: "third morning of red CI, sir" when CI has been failing portfolio-wide for ≥3 days; "seven days of impeccable CI, if I may" when no CI failures in the past week. He remembers the last briefing and opens with what changed since ("since your last briefing, sir, votescot returned to Gold"). When the almanac he is reading from is not the one on `main` he owns up to it rather than briefing confidently from it ("I am working from last week's almanac, sir"). Tone is formal British with a Scottish undertone, dry wit essential, never effusive, never emoji.

## Mode dispatch

```bash
MODE="${1:-briefing}"
case "$MODE" in
  briefing|debrief) ;;
  *)
    echo "\"I do not recognise that office, sir. May I suggest 'briefing' or 'debrief'?\" -- Reginald"
    exit 1
    ;;
esac
```

## Setup — load optional config and resolve the GitHub owner

Portfolio data comes from the `repo-butler` MCP server, not from a local checkout. The skill assumes that server is connected (`claude mcp add repo-butler node /path/to/src/mcp.js`). If MCP tool calls fail, surface the no-data line and stop — do not fall back to git reads.

Optional config at `~/.config/repo-butler/config.sh` is sourced if present. The only recognised variable here is `REPO_BUTLER_PROJECTS_DIRS` — newline-separated parent directories to scan for local clones in the briefing's working-state observations and the debrief's commit walker (default `$HOME/projects/github` and `$HOME/projects/gitlab`).

```bash
[ -f "$HOME/.config/repo-butler/config.sh" ] && . "$HOME/.config/repo-butler/config.sh"
: "${REPO_BUTLER_PROJECTS_DIRS:=$HOME/projects/github
$HOME/projects/gitlab}"
OWNER=$(gh api user --jq .login 2>/dev/null)
[ -n "$OWNER" ] || { echo "We have not been introduced, sir. Shall I draw up the portfolio?"; exit 1; }
```

## Am I the skill that is on main?

This skill is a symlink into a checkout's working tree, so what runs is whatever that checkout currently is — an unpulled `main`, a feature branch, or an uncommitted edit. PR #291's comic uplift merged and this skill kept rendering the old version for days, because nothing said so ([#350](https://github.com/IsmaelMartinez/repo-butler/issues/350)). Ask, every run:

```bash
SKILL_DIR=$(cd -P "<the base directory of this skill, as given above>" && pwd)
ALMANAC=$(node "$SKILL_DIR/../../scripts/check-skills.js" --headline 2>/dev/null || true)
[ -n "$ALMANAC" ] || ALMANAC="skill checkout predates the staleness check, so it is behind origin/main"
echo "$ALMANAC"
```

The final `echo` is how *you* read the value, exactly as `echo "$PRIOR"` is in the continuity block below — it is not comic output, so it prints unconditionally and the decision about whether to show anything is made when you write the script.

Three further details are load-bearing. The `|| true` is not decoration: `check-skills.js` exits 1 when it has something to report, so under `set -e` the bare assignment aborts the whole block — and it aborts on exactly the stale reading this exists to surface, silently, before the fallback line can run. `cd -P` first, because Node collapses `..` lexically — handing the registry path straight to `node` never traverses the symlink and looks for the script beside the registry instead. And empty output is a *positive* signal, not a failure to check: a checkout old enough to lack `scripts/check-skills.js` predates this very check, which is exactly the stale case.

If `$ALMANAC` says the skill is current with `origin/main`, say nothing — a calm morning should stay calm. Otherwise Reginald mentions the almanac once, as a caption in the first panel, quoting the reading verbatim so the counts survive the metaphor: `the almanac: {$ALMANAC}`. Never suppress it to keep the comic tidy, and never soften it into "possibly out of date" — the reading is precise and the whole point is that a stale skill used to look identical to a current one.

## Continuity — the state file

A small state file gives Reginald memory between briefings. It lives beside the existing burns-stamp at `~/.cache/repo-butler/state.json` (no new convention) and does just two jobs: it lets him open with a real personal delta since the last time you looked, and it stops calm mornings repeating the same backdrop two runs running. It is read and written ONLY in briefing mode — the debrief never touches it, so evening runs cannot disturb morning continuity. Long-running campaigns (>30d / >60d) and the CI streak are NOT stored here — they come live from finding ages and `get_weekly_trend`.

Read the prior state at the start of a briefing run:

```bash
STATE="$HOME/.cache/repo-butler/state.json"
mkdir -p "$(dirname "$STATE")"
PRIOR=$(cat "$STATE" 2>/dev/null || echo '{}')
echo "$PRIOR"
```

`PRIOR` has the shape `{"lastDate":"YYYY-MM-DD","lastScene":"<id>","repoTiers":{"<repo>":"gold|silver|bronze|none|unconfirmed"}}`. A repo with `tier_provisional: true` is stored as `"unconfirmed"`, never as its computed tier. Compare `PRIOR.repoTiers` against the current per-repo tiers from `query_portfolio`:

- A repo whose tier improved → "returned to Gold" / "reached Silver, sir". A repo that slipped → "slipped to Bronze, sir". Name at most two; prefer improvements. This becomes the "since your last briefing" opener in panel 1.
- A repo that is `unconfirmed` on either side has not moved: it neither "slipped" when its alerts went unread nor "returned to Gold" when the next read succeeded, so it is left out of the delta.
- If `PRIOR` is empty (first run) or `lastDate` is today already, omit the delta.

After the strip is drawn, write the new state. `$SCENE` is the day's headline scene (panel 2's). Build `$REPO_TIERS` as a single comma-separated list of JSON key/value pairs — e.g. `"repo-a":"gold","repo-b":"silver"` — with no trailing comma and no newlines, so the file stays valid JSON:

```bash
TODAY=$(date +%Y-%m-%d)
cat > "$STATE" <<JSON
{"lastDate":"$TODAY","lastScene":"$SCENE","repoTiers":{$REPO_TIERS}}
JSON
```

## The script

A strip is three panels, read left to right, and it tells one small story: an opening, the day's matter, and Reginald's last word.

1. **The opening.** Reginald alone, usually in the `morning-room` (the `study` for a debrief). Its caption carries the narration: the continuity delta, the streak or saga line, the almanac line when the skill is not current, the dumbwaiter line when the data is stale. His balloon greets and sets up the day.
2. **The matter.** The headline scene from the table below, with its co-star. The co-star reports the real signal — repo names and counts — and Reginald reacts. This is where the Doric word goes.
3. **The last word.** Reginald closes, alone or with the co-star, delivering the sign-off. On a calm day it is the other calm scene; on a troubled one it may stay in the trouble's scene or retire to the `fireside`.

The script is JSON:

```json
{
  "title": "The Daily Butler Briefing",
  "date": "Wednesday 7 October 2026",
  "mourning": false,
  "panels": [
    { "scene": "morning-room", "caption": "Since your last briefing, two repos slipped to Silver.",
      "cast": [{ "who": "reginald", "mood": "worried" }],
      "say":  [{ "who": "reginald", "text": "teams-for-linux and ismaelmartinez.me.uk have lost their Gold, sir." }] },
    { "scene": "garden-pests", "count": 3,
      "cast": [{ "who": "reginald", "mood": "observant" }, { "who": "gardener", "mood": "worried" }],
      "say":  [{ "who": "gardener", "text": "Three high pests in the website bed. My fixes are in flight." },
               { "who": "reginald", "text": "A fair dreich morning, then." }] },
    { "scene": "post-room",
      "cast": [{ "who": "postmaster", "mood": "observant" }, { "who": "reginald", "mood": "calm" }],
      "say":  [{ "who": "postmaster", "text": "Twelve bug reports for teams-for-linux. Gold wants nine." },
               { "who": "reginald", "text": "Lapsang for the lookouts, sir." }] }
  ],
  "stats": "14 repos * 12 Gold * 3 high vulns * CI 96%"
}
```

The rules the renderers hold you to:

- Exactly three panels. Each has a `scene`, a `cast` of one or two, an optional `caption`, and up to two balloons in `say`, in reading order. Whoever speaks first is drawn on the left, so order `say`, not `cast`.
- Cast: `reginald`, `gardener` (Dependabot), `cook` (CI), `postmaster` (issues and PRs), `under-butler` (governance). Moods: `neutral`, `worried`, `observant`, `pleased`, `calm`.
- Every speaker must be in that panel's cast, and each gets one balloon per panel — a panel where Reginald speaks twice is one balloon with both sentences. `count` (1–6) sets the number of pests in `garden-pests` and is ignored elsewhere.
- Words are short. A balloon is one sentence, roughly 90 characters at most; a caption, two short sentences. A panel with two balloons takes at most a one-line caption. The panels are small and the lettering is what makes them read as a comic rather than a page of prose.
- `title` and `date` together stay within 74 characters; `stats` is one line of at most 75: `{N} repos * {gold} Gold * {top concern stat} * {ci}`.

## Scenes — the day's headline (data-driven)

Choose the headline scene for panel 2 by ranking the day's signals top-down and taking the first that matches. Each row fixes the co-star and Reginald's mood in that panel.

| Priority | Scene id      | Shows                           | Trigger                                              | Co-star        | Reginald  |
|----------|---------------|---------------------------------|-----------------------------------------------------|----------------|-----------|
| 1        | `storm`       | the garden, in a storm          | a critical vuln or secret leak (`vulns.critical`/`codeScanning.critical` > 0, or `secretScanning.count` > 0) with `MOURNING_OK=1`; else → `garden-pests` | gardener       | worried   |
| 2        | `garden-pests`| the garden, beset by pests      | `vulns.critical+high > 0`, `codeScanning.critical+high > 0`, or `secretScanning.count > 0` | gardener       | worried   |
| 3        | `kitchen`     | the kitchen, something's catching | a red CI failure streak (per the weekly definition below) or portfolio CI pass < 70% | cook           | worried   |
| 4        | `belowstairs` | below stairs, by candlelight    | governance standards gaps or policy drift present    | under-butler   | observant |
| 5        | `post-room`   | the post room, parcels stacked  | a repo with `open_issues ≥ 10` (worse on Mon)        | postmaster     | observant |
| 6        | `morning-room`| the morning room                | a confirmed sub-Gold repo exists, or a scanner went unread, but none of the above | none           | neutral (observant when only unread scanners keep the day off all-clear) |
| 7        | `fireside`    | by the fire                     | all clear (all Gold, zero acute concerns, every scanner read) | none           | pleased   |
| 7        | `garden-clear`| the garden, after rain          | all clear — alternate calm scene                     | none           | pleased   |

The `study` (the evening study, a lamp and a decanter) belongs to the debrief.

For the two all-clear scenes (`fireside`, `garden-clear`), pick the one that is NOT `PRIOR.lastScene`, so two calm mornings in a row don't show the same backdrop. When a lower-priority concern is also present (say a pest-ridden garden and a heaving post room), panel 3 may visit it with its co-star before Reginald's last word.

## Mourning

For genuine breaches only — a critical vuln or a detected secret leak (the `storm` scene) — set `"mourning": true`, which draws the strip in a mourning frame. Rate-limit it to once per fortnight via a stamp file:

```bash
STAMP="$HOME/.cache/repo-butler/burns-stamp"
mkdir -p "$(dirname "$STAMP")"
NOW=$(date +%s); LAST=0; [ -f "$STAMP" ] && LAST=$(cat "$STAMP")
if [ $((NOW - LAST)) -ge $((14*24*3600)) ]; then
  MOURNING_OK=1
else
  MOURNING_OK=0
fi
```

When `MOURNING_OK=1` and a true breach is present, use the `storm` scene with `"mourning": true`, then write the current timestamp to the stamp (`date +%s > "$STAMP"`) so the fortnight clock starts only when the frame is actually used, and you may give Reginald a single Burns half-line ("the best laid schemes, sir…"). When `MOURNING_OK=0`, or no breach is present, leave the stamp untouched and let the breach fall back to `garden-pests` without the mourning frame.

## Drawing the strip

If the tool `mcp__repo-butler-comic__strip` is available, call it with the script. It draws the strip in colour in the transcript. If it refuses, its message names the panel whose words do not fit: shorten that panel and call again, at most three times. Once it is drawn, add nothing after it — the strip is the whole answer.

Otherwise (the mod is not loaded: another profile, a remote session, or mods turned off) render it as ASCII from the same script:

```bash
COMIC="$HOME/.cache/repo-butler/comic.json"
cat > "$COMIC" <<'JSON'
<the script>
JSON
node "$SKILL_DIR/../../scripts/render-comic.js" "$COMIC"
```

It exits 1 naming any panel with an unknown scene, cast member or speaker; fix the script and run it again. On success, output its stdout verbatim inside one fenced code block and nothing else. If neither the tool nor the script exists (a checkout from before the renderer), give Reginald's lines as plain prose, signed "-- Reginald", and let the almanac line explain why.

## Briefing mode — data and composition

Title: `The Daily Butler Briefing`. Run when `MODE=briefing`.

Fetch the data:

1. Call MCP tool `query_portfolio` (no arguments) for all portfolio repos with current tier and health data. Each repo carries `tier` ∈ `gold|silver|bronze|none` and `tier_provisional`, plus `vulns`/`codeScanning` (each with `critical`/`high`/`count`), `secretScanning.count`, `ciPassRate` (0–1), `open_issues`, and `license`. Any of the three scanner summaries may instead be `{ "unreadable": true }`: its alerts could not be read this run. This drives the stat line, the headline scene, and the continuity delta.
2. Call MCP tool `get_governance_findings` (no arguments) for the governance ledger — standards gaps and policy drift drive the `belowstairs` scene; findings open >60d are given-up campaigns, >30d earn the below-stairs word.
3. Call MCP tool `get_weekly_trend` with `weeks: 4` and no `repo` argument for the portfolio-wide CI streak (see below).
4. Call MCP tool `get_campaign_status` (no arguments) only if surfacing campaign progress in the sign-off.
5. Run the local-state bash block below to capture working-tree state across `REPO_BUTLER_PROJECTS_DIRS`, used for a single working-state observation when the day is calm.

If any MCP call fails or returns empty, give the no-data line and stop. If the most recent weekly aggregate's `timestamp` (or the MCP `staleness.data_age_hours`) is 3+ days stale, put the dumbwaiter line in panel 1's caption.

```bash
while IFS= read -r parent; do
  [ -z "$parent" ] && continue
  for dir in "$parent"/*/; do
    [ -d "$dir/.git" ] || continue
    repo=$(basename "$dir")
    st=$(git -C "$dir" status --porcelain 2>/dev/null | head -5)
    branches=$(git -C "$dir" branch --no-merged main 2>/dev/null | grep -v '^\*' | head -5)
    stash=$(git -C "$dir" stash list 2>/dev/null | head -3)
    current=$(git -C "$dir" branch --show-current 2>/dev/null)
    if [ -n "$st" ] || [ -n "$branches" ] || [ -n "$stash" ]; then
      echo "REPO:$repo|BRANCH:$current|DIRTY:$([ -n "$st" ] && echo yes || echo no)|UNMERGED:$(echo "$branches" | grep -c .)|STASH:$(echo "$stash" | grep -c .)"
    fi
  done
done <<EOF
$REPO_BUTLER_PROJECTS_DIRS
EOF
```

The portfolio CI streak comes from `get_weekly_trend`'s portfolio-wide series — count consecutive recent weeks where every repo was clean (success streak) or ≥1 was red (failure streak). With weekly granularity, a 1-week green run satisfies "seven days of impeccable CI" and a 2-week red run satisfies "third morning of red CI"; if only one weekly point is available, omit the streak line.

Write the script:

- Pick the headline scene from the table. Concerns come from `vulns.critical+high > 0`, `codeScanning.critical+high > 0`, `secretScanning.count > 0`, `ciPassRate < 0.7`, `open_issues ≥ 10`, missing `license`, plus governance standards gaps and policy drift.
- An unread scanner (`{ "unreadable": true }`) is never clean and never a pest: it neither triggers `garden-pests` nor lets the day be all-clear, and Reginald does not say the garden is clear of pests while one went unread. Name it plainly instead ("the gardener could not get into the code-scanning shed at bonnie-wee-plot, sir"). A repo with `tier_provisional: true` is unconfirmed, not demoted: it is not "sub-Gold" for the scene table, it counts as neither Gold nor below in the stat line (add `* {n} unconfirmed` when there are any), and no balloon calls it Silver.
- Every balloon about a concern names the real signal — repo names and counts — e.g. the gardener "has found three pests in teams-for-linux, sir." The Doric word goes only in `garden-pests`/`storm` (dreich) or a calm scene (braw).
- Panel 1's caption opens with the continuity delta if present ("Since your last briefing, sir, …"), then the streak or saga line. On Mondays with open issues > 0, the postmaster's tardiness belongs in whichever panel he appears in, or in panel 3's last word. On 25 January Reginald opens with "A guid Burns Night to ye, sir."; on 31 December "Hogmanay greetings, sir."
- On a calm day, fold one working-state observation into panel 3 if the local block returned anything ("a forgotten parcel in the hallway, sir" for a stash older than the last commit; otherwise "the study is in impeccable order, sir").
- Panel 3's last balloon is the sign-off: pick exactly ONE from this pool of eight (do not invent more):

1. "Will that be all, sir?"
2. "Shall I draw a bath while you triage?"
3. "I've taken the liberty of pressing your commits."
4. "I shall prepare the tea. Earl Grey, as befits a Silver-tier morning."
5. "Very good, sir. I shall be in the pantry, rebasing."
6. "A dram of Speyside, sir, in honour of the Gold tier."
7. "Lapsang for the lookouts, sir — a watchful brew."
8. "If I may say so, sir, a most productive sprint."

Whisky entries (5–6) win ties when ≥1 Gold-tier change today; tea entries (4, 7) for routine mornings.

Draw the strip, then write the state file (`$SCENE` = panel 2's scene; `$REPO_TIERS` = current per-repo tiers).

## Debrief mode — data and composition

Title: `The Evening Debrief`. Run when `MODE=debrief`. The debrief tells the day's session work rather than running the scene table: it opens in the `study`, and the matter panel features the cast member whose work dominated the day (many Dependabot merges → the gardener in `garden-clear`; lots of CI churn → the cook in the `kitchen`; a day of issues and PRs → the postmaster in the `post-room`), or stays in the study with Reginald alone.

Fetch the data:

1. Call MCP tool `query_portfolio` (no arguments) for the portfolio repo list. Pass the repo names as a space-separated `PORTFOLIO` env var into the bash block below.
2. Call MCP tool `get_snapshot_diff` (no arguments) for what changed since the last pipeline run — useful for framing accomplishments.
3. Run the local-state bash blocks below to capture today's session activity, today's commits across project dirs, and today's GH PR activity per repo.

```bash
node -e "
const fs=require('fs'); const p=process.env.HOME+'/.claude/history.jsonl';
if(!fs.existsSync(p)){console.log('[]');process.exit(0);}
const t0=new Date();t0.setHours(0,0,0,0);const tms=t0.getTime();
const s={};for(const l of fs.readFileSync(p,'utf8').split('\n').filter(x=>x.trim())){
  try{const d=JSON.parse(l); if(d.timestamp>=tms){const k=d.sessionId;
    if(!s[k])s[k]={project:d.project,messages:[],first:d.timestamp,last:d.timestamp};
    s[k].messages.push(d.display); s[k].last=Math.max(s[k].last,d.timestamp);}}catch{}}
console.log(JSON.stringify(Object.entries(s).map(([id,x])=>({id:id.slice(0,8),
  project:x.project?.split('/').pop()||'unknown',messageCount:x.messages.length,
  durationMin:Math.round((x.last-x.first)/60000),firstMessage:x.messages[0]?.slice(0,80)}))));"

while IFS= read -r parent; do
  [ -z "$parent" ] && continue
  [ -d "$parent" ] || continue
  find "$parent" -maxdepth 5 -name ".git" -type d 2>/dev/null | while read -r gitdir; do
    dir=$(dirname "$gitdir"); repo=$(basename "$dir")
    commits=$(git -C "$dir" log --since="midnight" --oneline --all 2>/dev/null)
    if [ -n "$commits" ]; then
      echo "REPO:$repo|COMMITS:$(echo "$commits" | wc -l | tr -d ' ')"
      echo "$commits" | head -5 | while read -r line; do echo "  $line"; done
    fi
  done
done <<EOF
$REPO_BUTLER_PROJECTS_DIRS
EOF

TODAY=$(date +%Y-%m-%d)
# Portfolio repo list is supplied by the agent from the `query_portfolio` MCP
# call made earlier in this mode. Pass it in as `PORTFOLIO=...` (space-separated).
[ -z "$PORTFOLIO" ] && PORTFOLIO=$(gh repo list "$OWNER" --source --limit 50 --json name --jq '.[].name' 2>/dev/null | tr '\n' ' ')

for repo in $PORTFOLIO; do
  counts=$(gh pr list --repo "$OWNER/$repo" --state all --limit 100 \
    --json createdAt,mergedAt,closedAt,reviews 2>/dev/null \
    | node -e "let d='';process.stdin.on('data',c=>d+=c);process.stdin.on('end',()=>{
        try{const a=JSON.parse(d),t='$TODAY';
          const m=a.filter(p=>p.mergedAt?.startsWith(t)).length;
          const o=a.filter(p=>p.createdAt?.startsWith(t)).length;
          const c=a.filter(p=>p.closedAt?.startsWith(t)&&!p.mergedAt?.startsWith(t)).length;
          const u=a.filter(p=>p.mergedAt?.startsWith(t)&&(p.reviews?.length||0)===0).length;
          console.log(\`\${m} \${o} \${c} \${u}\`);}catch{console.log('0 0 0 0');}})" 2>/dev/null)
  read merged opened closed unreviewed <<<"$counts"
  if [ "$merged" != "0" ] || [ "$opened" != "0" ] || [ "$closed" != "0" ]; then
    echo "GH:$repo|MERGED:$merged|OPENED:$opened|CLOSED:$closed|UNREVIEWED:$unreviewed"
  fi
done
```

If no sessions, no commits, and no PR/MR activity, the whole strip is a quiet one: three panels in the study and by the fire, Reginald `calm`, and the line "A most tranquil day, sir. Not a single commit disturbed the silence."

Write the script:

- Panel 1 (the `study`, Reginald `pleased` for a productive day, `calm` for a quiet one) reports: "You had {n} session(s) today across {r} repo(s), spanning roughly {m} minutes." Long days (>4h) impress him; quiet ones (<30m) get gentle understatement.
- Panel 2 carries the totals — "{c} commits, {pm} PRs merged, {po} opened, {pc} closed" — and names the top one-to-three repos by today's commit count. If any PRs merged today had zero reviews, Reginald's balloon opens with a single `*ahem*`. Reginald notices patterns: many subagents → "you delegated liberally, sir."
- Panel 3 is the sign-off: pick exactly ONE from this pool of eight:

1. "A most productive day, sir. I shall press your commits."
2. "The repositories are well-tended, sir. Shall I draw a bath?"
3. "I note several branches remain in flight, sir. Tomorrow's concern, perhaps."
4. "If I may say so, sir — that was rather a lot of rebasing."
5. "The estate prospers under your stewardship, sir."
6. "An Islay dram, sir, for a day well-merged."
7. "Builder's brew, sir — earned and unfussy."
8. "The automated staff have been busy, sir."

Whisky (6) for celebratory days (multiple PRs merged); tea (7) for routine ones.

## Failure-mode lines

These are said, not drawn — give the line alone, signed "-- Reginald":

- No data on disk: "The household is not yet in residence, sir; I shall lay the fires and await your instruction."
- Owner unresolved: "We have not been introduced, sir. Shall I draw up the portfolio?"

These two are drawn, as panel 1's caption, and the briefing carries on:

- Pipeline 3+ days stale: "Forgive me — the dumbwaiter has been stuck since Tuesday."
- Skill not current: "I am working from last week's almanac, sir — {$ALMANAC}." Never in place of the briefing; a stale skill still reports the portfolio it can see.

## Output

With the mod, the drawn strip is the answer: no preamble, no explanation, nothing after it. With the ASCII renderer, output its stdout verbatim in a single fenced code block and nothing else; it ends with Reginald's signature.
