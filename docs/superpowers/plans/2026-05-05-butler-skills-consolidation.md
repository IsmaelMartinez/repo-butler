# Butler Skills Consolidation — Implementation Plan

**Goal:** Merge `butler-briefing` and `butler-debrief` into a single `repo-butler` skill, rename `butler-apply` to `repo-butler-apply`, distributable from this repository, with Reginald's personality enriched but disciplined. Closes the long-standing ROADMAP entry "Butler-briefing/debrief refresh or retirement" and partially closes "Distributable butler skills".

**Non-goals:** Distribution polish (`projectsDirs` settings key, MCP-first data fetcher, install.sh, parametrising the `repo-butler-data` branch name) is deferred to a separate PR after consolidation lands.

**Tech stack:** Markdown skills with bash blocks. No new dependencies.

**Inputs:** Four-hat review (skill-author, end-user, distribution, maintainer) summarised inline below; existing skill files at `skills/butler-briefing/SKILL.md`, `skills/butler-debrief/SKILL.md`, and `~/.claude-home/skills/butler-apply/SKILL.md`.

---

## End State

```
skills/repo-butler/SKILL.md         read-side, mode arg (briefing|debrief)
skills/repo-butler-apply/SKILL.md   write-side, confirm-gated workflow dispatch
```

Two skills, properly frontmattered, no hardcoded user paths/owner, distributable via `git clone`.

---

## Sequencing

| PR | Title | Risk |
|----|-------|------|
| 1 | Hygiene + portability | Low. No persona changes; only structural fixes. |
| 2 | Merge briefing + debrief into `/repo-butler` | Medium. Touches user-facing morning/evening flow. Tag `pre-butler-merge` for one-command revert. |
| 3 | Rename `butler-apply` → `repo-butler-apply` | Low. Directory rename + frontmatter + interaction polish. |
| 4 | Reginald uplift (prose only) | Low. Persona enrichment with a hard line/word budget. |

PR 1 is parallelisable across the three skill files. Each subsequent PR depends on its predecessor.

---

## PR 1 — Hygiene + portability

**Files:**
- Modify: `skills/butler-briefing/SKILL.md`
- Modify: `skills/butler-debrief/SKILL.md`
- Move: `~/.claude-home/skills/butler-apply/` → `skills/butler-apply/` (rename to `repo-butler-apply` happens in PR 3)
- Modify: `skills/butler-apply/SKILL.md` (post-move)

### Tasks

- [ ] **Task 1.1: Add YAML frontmatter to butler-briefing**
  - Description as triggering condition only, third person, no workflow summary
  - Draft: `Use when the user asks for a portfolio briefing, status update, morning standup, or "how are my repos doing" across their repo-butler-managed portfolio.`

- [ ] **Task 1.2: Add YAML frontmatter to butler-debrief**
  - Draft: `Use when the user asks for an evening debrief, end-of-day summary, "what did I do today", or session activity recap across their repos.`

- [ ] **Task 1.3: Fix butler-debrief duplicate step-6 numbering**
  - Lines 98 and 105 both labelled "6". Renumber so step list is sequential.

- [ ] **Task 1.4: Replace hardcoded paths with auto-detect helper (inline bash)**
  - Add a small inline `resolve_repo_butler` shell function at the top of each skill that: checks `$REPO_BUTLER_PATH`, then walks up from cwd looking for `.github/roadmap.yml + src/mcp.js`, then checks `~/projects/github/repo-butler` and `~/repo-butler` as final fallback.
  - Replace every literal `/Users/ismael.martinez/projects/github/repo-butler` reference.

- [ ] **Task 1.5: Resolve owner from git remote**
  - Add inline `resolve_owner`: parses `git -C "$REPO" remote get-url origin` for the `owner/repo` segment.
  - Replace literal `IsmaelMartinez/` in butler-debrief's `gh pr list --repo IsmaelMartinez/$repo` and butler-apply's `gh workflow run --repo IsmaelMartinez/repo-butler`.

- [ ] **Task 1.6: Replace hardcoded portfolio repo list in butler-debrief**
  - Step 3's enumerated list (`for repo in repo-butler teams-for-linux ...`) reads from the latest snapshot's portfolio map: `git -C "$REPO" show origin/repo-butler-data:snapshots/latest.json | jq -r '.portfolio | keys[]'` (or fall back to `gh repo list "$OWNER" --json name --jq '.[].name'` if the data branch is bare).

- [ ] **Task 1.7: Move butler-apply into repo**
  - `mkdir -p skills/butler-apply && cp ~/.claude-home/skills/butler-apply/SKILL.md skills/butler-apply/`
  - The original location can stay or be removed by the user separately; the in-repo copy is the canonical home from this PR forward.

- [ ] **Task 1.8: Apply tasks 1.4 + 1.5 to butler-apply (post-move)**
  - Same `resolve_repo_butler` and `resolve_owner` snippets.
  - Replace `sleep 60` with a polling loop on `gh run list ... --json status,conclusion` that breaks out when status leaves `queued`/`in_progress` or after a 5-minute ceiling.

**Acceptance:**
- `head -10` of each SKILL.md shows valid YAML frontmatter.
- `grep -r "/Users/ismael.martinez" skills/` returns nothing.
- `grep -rn "IsmaelMartinez/" skills/` returns nothing.
- Running `/butler-briefing`, `/butler-debrief`, and `/butler-apply` (with explicit "no" to the dispatch prompt) all complete without error from any cwd.

---

## PR 2 — Merge briefing + debrief into `/repo-butler`

**Files:**
- Create: `skills/repo-butler/SKILL.md`
- Delete: `skills/butler-briefing/`
- Delete: `skills/butler-debrief/`

### Tasks

- [ ] **Task 2.1: Tag the pre-merge commit**
  - `git tag pre-butler-merge` on the commit that lands PR 1, so revert is one command if morning flow breaks.

- [ ] **Task 2.2: Draft the merged SKILL.md frontmatter**
  - `description: Use when the user asks for a portfolio briefing, debrief, status update, morning standup, end-of-day summary, or "what did I do today" across their repo-butler-managed repos.`

- [ ] **Task 2.3: Mode dispatch**
  - First positional arg = `briefing` (default) or `debrief`. No clock magic. Reject any other value with Reginald's "I do not recognise that office, sir."

- [ ] **Task 2.4: Concentrate the data fetchers**
  - Briefing-mode block: latest snapshot + portfolio weekly + governance findings + local working state scan.
  - Debrief-mode block: today's history.jsonl + today's git activity + today's PR/MR activity (GitHub + GitLab).
  - Single shared resolver helpers from PR 1.

- [ ] **Task 2.5: Drop the bare panels**
  - Tier-distribution panel (briefing panel 1) and ledger panel (debrief panel 3) carry only numbers — fold them into Reginald's prose in the surviving panels.

- [ ] **Task 2.6: Render comic**
  - One comic frame, one set of eye glyphs, one panel template. The mode-specific content is what changes; the frame does not.

- [ ] **Task 2.7: Delete predecessor skills**
  - `rm -rf skills/butler-briefing skills/butler-debrief`. No deprecation shims.

**Acceptance:**
- `/repo-butler` defaults to briefing-style output.
- `/repo-butler debrief` produces evening-style output.
- `/repo-butler nonsense` produces Reginald's rejection line.
- Running both modes against the current portfolio produces an output the user prefers to the pre-merge baselines (subjective, three-sample comparison).

---

## PR 3 — Rename `butler-apply` → `repo-butler-apply`

**Files:**
- Move: `skills/butler-apply/` → `skills/repo-butler-apply/`
- Modify: `skills/repo-butler-apply/SKILL.md`

### Tasks

- [ ] **Task 3.1: Directory rename**
  - `git mv skills/butler-apply skills/repo-butler-apply`

- [ ] **Task 3.2: Frontmatter description rewrite**
  - `description: Use when the user wants to act on governance findings, open remediation PRs, fix standards gaps, or apply tier-uplift / policy-drift / stale-Dependabot fixes across the portfolio.`
  - No workflow summary.

- [ ] **Task 3.3: Replace dispatch prompt**
  - `Reply 'yes' to dispatch, or any other word to leave the tray on the sideboard.`
  - → `Shall I ring for the staff, sir? (yes/no)`
  - Update parser to accept `yes`/`y`/`go`/`dispatch` as affirmative.

- [ ] **Task 3.4: gh auth precheck**
  - Before dispatch, run `gh api user --jq .login` and compare to `$OWNER` from the resolver. On mismatch, render a "the wrong steward holds the keys, sir" panel and abort.

**Acceptance:**
- `gh pr list` and `gh workflow run` both target the resolved owner, not literal IsmaelMartinez.
- Dispatch proceeds only after a yes/y/go/dispatch reply.
- Auth-mismatch path renders the abort comic without dispatching.

---

## PR 4 — Reginald uplift (prose only)

**Hard scope budget — written into the PR body before any prose lands:**
- `skills/repo-butler/SKILL.md` body ≤ 250 lines
- Persona section ≤ 30 lines
- Closing-remark pool ≤ 8 entries per mode
- One ASCII frame, plus one black-bordered "mourning frame" for genuine breaches (secret leak, fresh critical vuln). No other frame variants.
- Two ASCII figures only: Option A (bowler + moustache + bow tie) for read-side; Option C (silver tray) for `repo-butler-apply` only. No third variant.
- No new named characters; "household members" referenced by metaphor only (kitchen = CI, gardener = Dependabot, postmaster = PR queue, under-butler = governance).

### Tasks

- [ ] **Task 4.0: Replace stick-figure Reginald with butler silhouettes**
  - Read-side (`repo-butler`) — Option A: bowler hat, moustache, bow tie. Eye glyphs (`B B` / `> <` / `o o` / `^ ^` / `- -`) still drive mood. Same panel height as the original.
    ```
       ,-===-,
       | B B |
       |_~m~_|
       |\>=</|
       |/   \|
       '--|--'
         /|\
    ```
  - Write-side (`repo-butler-apply`) — Option C: silver tray. Tray contents vary by panel/mood: a dram for Gold-tier celebration, a folded telegram for governance findings, a calling card on dispatch. Ties to the established "ringing for staff" framing.
    ```
       ,---.
       | B B |
       | ~m~ |
       | >=< |
       ( | | )
        \===/
       [_____]
    ```
  - No third figure variant. Stick figure is gone.

- [ ] **Task 4.1: Tea + whisky tier mapping (whisky preferred)**
  - Mix tea and whisky as period-appropriate household flourishes. Whisky wins ties — Gold-tier and celebratory moments default to a dram (Speyside or Islay, sparingly named, not a connoisseur's catalogue). Tea stays in-character for routine morning notes (Earl Grey, Lapsang, builder's brew). Used in closings and on the apply tray. Both, not either-or.

- [ ] **Task 4.2: Sparing Doric flavour**
  - "A fair dreich morning in the dependency tree" when vulns are high; "braw" when they're clean. Rule: at most one Doric word per comic.

- [ ] **Task 4.3: One recurring grievance**
  - The postmaster (PR queue) is tardy on Mondays — surface this on Mondays only, when the open-PR count is non-zero.

- [ ] **Task 4.4: Giving-up lore for stale findings**
  - When a governance finding has been open >60 days, Reginald acknowledges it as a long-running campaign he has visibly given up on (e.g. "the licensing campaign, sir, persists like damp").

- [ ] **Task 4.5: Streak awareness + quiet pride**
  - "Third morning of red CI, sir" when CI has been failing across the portfolio for ≥3 days.
  - "Seven days of impeccable CI, if I may" when no CI failures in the past week.

- [ ] **Task 4.6: Disapproving `*ahem*` glyph**
  - For PRs merged without review (gh review count = 0).

- [ ] **Task 4.7: Below-stairs aside**
  - For items festering >30 days: "I shall have a word below stairs, sir."

- [ ] **Task 4.8: Failure-mode lines**
  - No data: "The household is not yet in residence, sir; I shall lay the fires and await your instruction."
  - Pipeline down 3+ days: "Forgive me — the dumbwaiter has been stuck since Tuesday."
  - Brand-new machine: "We have not been introduced, sir. Shall I draw up the portfolio?"

- [ ] **Task 4.9: Reserved extremis signals**
  - Black-bordered mourning frame for genuine breaches only (secret leak, fresh critical vuln). Logged via a single conditional in the renderer.
  - Burns half-line for true extremis. Rate-limited to once per fortnight via a tiny state file.

- [ ] **Task 4.10: Seasonal nods**
  - Burns Night (25 January), Hogmanay (31 December). Date-conditional only.

- [ ] **Task 4.11: Update ROADMAP**
  - Mark "Butler-briefing/debrief refresh or retirement" as SHIPPED with PR number + date.

**Acceptance:** Subjective. Read three sample outputs from each mode; prefer the new ones over PR 2's baseline.

---

## Backout

If PR 2 breaks the morning/evening flow, revert via:
```bash
git revert <merge-commit-sha>
```
Predecessor skills are recoverable from the `pre-butler-merge` tag:
```bash
git checkout pre-butler-merge -- skills/butler-briefing skills/butler-debrief
```
