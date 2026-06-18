// Phase 9 tier-change detection (ADR-008, healthTierChanged channel).
//
// Pure, GitHub-free diff of each repo's computed health tier against the
// last-emitted-tier state the butler persists on the data branch
// (snapshots/tier-state.json). This is the unit-testable core; the live
// transport — a `dispatch()` method on the GitHub client, the report-phase
// wiring, the compare-and-swap state write, and the default-off
// INPUT_EMIT_EVENTS flag — is a deferred follow-on per ADR-008. Until that
// lands nothing calls this, so behaviour is byte-identical to today.
//
// Why diff against a dedicated last-emitted state rather than a weekly
// snapshot (ADR-008): the current-week portfolio file is overwritten up to 4×
// a day, so a same-week baseline self-compares and never fires; the
// previous-week file stays static until the week rolls over, so it re-fires the
// same transition on every run for the rest of the week. A state file updated
// only after a successful emit makes each transition emit exactly once.

// Frozen to the health-tier.v1 enum (schemas/v1/health-tier.v1.schema.json).
// A value outside this set is not a tier the butler computes, so it is ignored
// rather than recorded as a baseline or surfaced as a transition.
const TIERS = new Set(['gold', 'silver', 'bronze', 'none']);

// Keep only entries whose value is a known tier. Guards the boundary: a repo
// whose tier could not be computed must not poison the state with a non-tier
// baseline (which would later read back as a spurious transition).
function normalizeTiers(tiers) {
  // Null-prototype map: repo names are external, and an underscore-bearing name
  // like "__proto__" is a valid GitHub repo. On a plain object `out["__proto__"]
  // = tier` is swallowed by the prototype setter (the repo silently vanishes);
  // a prototype-free object stores it as an ordinary own key instead.
  const out = Object.create(null);
  for (const [repo, tier] of Object.entries(tiers || {})) {
    if (TIERS.has(tier)) out[repo] = tier;
  }
  return out;
}

/**
 * Diff current computed tiers against the last-emitted state.
 *
 * @param {Object<string,string>} currentTiers - map of repo identifier -> tier
 *   (gold|silver|bronze|none), one entry per repo currently in the portfolio.
 * @param {Object<string,string>|null|undefined} lastEmitted - the persisted
 *   last-emitted-tier state, or null/undefined when the state file does not yet
 *   exist (first run with emission enabled).
 * @returns {{ changes: Array<{repo: string, previousTier: string, newTier: string}>,
 *             nextState: Object<string,string>, isFirstRun: boolean }}
 *   - changes: transitions to emit, one per repo whose recorded tier moved.
 *     Empty on the first run and when nothing moved.
 *   - nextState: the state to persist after a successful emit — the current
 *     tiers, which prunes orphans (repos no longer in the portfolio drop out)
 *     and baselines newcomers at their current tier.
 *   - isFirstRun: true when there was no prior state; the caller writes
 *     nextState as the baseline and emits nothing.
 */
export function detectTierChanges(currentTiers, lastEmitted) {
  const current = normalizeTiers(currentTiers);
  // nextState is the current tiers: orphaned repos are absent (pruned) and
  // newcomers are present at their current tier (baselined). Writing this after
  // a successful emit is what dedups same-week re-runs and prevents a reused
  // repo name from inheriting a stale tier.
  const nextState = { ...current };

  // First run: no prior state to diff against. Record the baseline silently.
  if (lastEmitted == null) {
    return { changes: [], nextState, isFirstRun: true };
  }

  const changes = [];
  for (const [repo, newTier] of Object.entries(current)) {
    // A repo with no prior recorded tier (a newcomer, or a name whose orphaned
    // entry was pruned) has no transition to report — it is baselined via
    // nextState and only emits once a later run sees its tier move. Use
    // Object.hasOwn rather than an `=== undefined` check so a repo whose name
    // collides with an Object.prototype member (e.g. "constructor",
    // "toString") is not read through the prototype chain as a bogus tier.
    if (!Object.hasOwn(lastEmitted, repo)) continue;
    const previousTier = lastEmitted[repo];
    if (previousTier !== newTier) {
      changes.push({ repo, previousTier, newTier });
    }
  }

  return { changes, nextState, isFirstRun: false };
}
