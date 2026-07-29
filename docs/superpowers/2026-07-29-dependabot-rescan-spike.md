# Spike: is there a legitimate way to force a Dependabot rescan?

Date: 2026-07-29

Status: Complete. **The answer is no**, and the goal that depended on it is dead
as specified. A replacement is proposed, drawn from what the spike found instead.

## Why this spike existed

The plan of record (`2026-07-25-autonomous-garden-plan.md`) argues at line 47
that rescan-nudging — detect an alert open N hours with no corresponding
Dependabot PR, then force a rescan — is a cheaper and higher-value automation
than the trimmer it spent G5 and G6 building. That recommendation rests on a
premise the same document flags at line 59 as untested: there may be no public
API to force a Dependabot security scan, and the only thing observed to work was
pushing a commit to the default branch, which is a poor design for a bot.

That document has been wrong three times in one day about dependency-management
mechanics. So the premise was tested before anything was committed to.

## Finding 1 — there is no programmatic trigger, and there will not be one

`dependabot/dependabot-core#6098` asks for exactly this capability: an API or CLI
to trigger Dependabot scans across repositories, for use in a release process.
It was opened 2022-11-09 and is **closed as not planned**. That is not an absent
feature; it is a declined one, which is a much stronger signal and means waiting
for it is not a strategy.

The issue also documents the only known trigger. The web UI's "Check for updates"
button issues a request to `https://github.com/{repo}/network/updates?update_config_id={ID}`.
That route is undocumented, unversioned, absent from the REST API, and keyed by a
per-repository config ID with no published way to obtain it. Driving a bot
through it would mean depending on an internal endpoint that GitHub has never
promised to keep.

The public Dependabot REST namespace covers four things — alerts, alert dismissal
requests, repository access, and secrets. There is no run, trigger, job, or
rescan endpoint anywhere in it.

## Finding 2 — you cannot even read *why* Dependabot did not act

The natural fallback, once triggering is ruled out, is to surface the reason
instead: GitHub's own troubleshooting documentation says that when Dependabot is
blocked from opening a pull request it "posts the error message on the alert".

It does not put that message anywhere an API can reach. The live alert object was
inspected directly rather than trusting the schema docs, and carries exactly
these top-level keys:

```
assignees, auto_dismissed_at, created_at, dependency, dismissal_request,
dismissed_at, dismissed_by, dismissed_comment, dismissed_reason, fixed_at,
html_url, number, security_advisory, security_vulnerability, state, updated_at, url
```

There is no error field, no update-job status, no job-log link, and no reference
to a pull request that was or was not opened. The "Recent update jobs" view and
the per-alert error text are web-UI surfaces only. So a detector cannot ask
Dependabot why it is stuck; it can only observe that it is.

## Finding 3 — the two remaining mechanisms do not apply

`@dependabot recreate` and `@dependabot rebase` do force a re-evaluation, and are
documented and supported. Both operate on an **existing pull request**, which is
precisely what the stalled case does not have. They solve "this PR is stale", not
"no PR was ever opened".

Copilot Autofix is for **code-scanning** alerts, not Dependabot alerts. The
`assignees` field on the alert object is real, but no documented API route was
found for assigning a Dependabot alert to an agent, and inventing one on the
strength of an unused field would be exactly the kind of speculation this spike
exists to prevent.

## Finding 4 — the live stalled alert is not stalled for any of the reasons assumed

The portfolio carries exactly one open Dependabot alert:
`teams-for-linux` #153, `http-proxy-middleware`, transitive, in
`docs-site/package-lock.json`, opened **2026-06-24** and still open on
2026-07-29 — thirty-five days. Severity is `medium`, which is why the existing
`open-vulnerability` detector (critical/high only) has never mentioned it.

Two plausible explanations were tested against the live repository and **both are
wrong**:

*Not a configuration gap.* `teams-for-linux` has a `.github/dependabot.yml`, and
it explicitly covers `/docs-site` with a weekly npm schedule. The directory is
configured.

*Not a settings gap.* `GET /repos/{owner}/{repo}/automated-security-fixes`
returns `{"enabled":true,"paused":false}` for that repo, and for every other repo
checked. Dependabot security updates are on and not paused.

What is true is narrower and more useful. The parent, `webpack-dev-server`,
declares `http-proxy-middleware: "^2.0.9"`; the installed version is `2.0.9`; the
first patched version is `2.0.10`. A caret on a 2.x version floats the patch, so
**`^2.0.9` already admits `2.0.10`**. Nothing needs to change in any manifest.
The fix is a lockfile refresh, and Dependabot has not performed one in
thirty-five days.

The just-merged trimmer was run against the real lockfile and manifest, and
returned:

```json
{
  "action": "refuse",
  "reason": "reachable-by-update",
  "detail": "every parent range already admits http-proxy-middleware@2.0.10; refresh the lockfile instead"
}
```

This is the first time `src/trimmer.js` has met production data it was not built
from, and it classified it correctly. That is worth recording on its own: the
module's most counter-intuitive design decision — that `reachable-by-update` is a
**refusal** rather than a fallback — is the decision that made it right here.

One caveat, held as a hypothesis rather than a conclusion because two hypotheses
already died above. `teams-for-linux` recently merged a *grouped* version-update
PR for `docs-site` (`dependabot/npm_and_yarn/docs-site/minor-and-patch-479fbeca4e`),
and the alert survived it. That is consistent with grouped version updates moving
only the direct dependencies named in the manifest and never refreshing a
transitive lockfile entry — but it was not proven, and it should not be relied on
without proof.

## What this means for the plan

Rescan-nudging as written cannot be built. There is no supported trigger, the
declined issue means none is coming, and the two workarounds are an internal web
route and a bot pushing commits — both rejected.

But the thirty-five-day alert is real, and the reason it is invisible is not that
Dependabot is mysterious. It is that **nothing in the butler is watching for
"an alert with no pull request"**, and nothing classifies whether such an alert
is stuck because it is hard or stuck because nobody ran an update.

The butler already owns the classifier. `planOverride` returns
`reachable-by-update`, `out-of-scope`, `direct-dependency`, `disjoint-ranges` or
an override plan — which is a triage vocabulary for exactly this question, and
using it **read-only** costs nothing in trust-model terms because it writes
nothing. That turns G6's inert core into a working component without touching the
write path it is deliberately disconnected from.

The proposal, specified in the companion plan, is therefore to replace
rescan-nudging with detection-and-explanation: a `stalled-alert` governance
finding that says *this alert has been open N days, no Dependabot PR exists for
it, and here is why it is stuck*. Remediation stays human. Whether the butler
should later template a refresh workflow into target repos is a separate question
behind its own ADR, and deliberately parked.

## Sources

- [API to trigger dependabot · dependabot/dependabot-core#6098](https://github.com/dependabot/dependabot-core/issues/6098) — closed as not planned
- [REST API endpoints for Dependabot](https://docs.github.com/en/rest/dependabot)
- [REST API endpoints for Dependabot alerts](https://docs.github.com/en/rest/dependabot/alerts)
- [Dependabot pull request comment commands](https://docs.github.com/en/code-security/reference/supply-chain-security/dependabot-pull-request-comment-commands)
- [About Copilot Autofix for code scanning](https://docs.github.com/en/code-security/concepts/code-scanning/copilot-autofix-for-code-scanning)
- [Dependabot errors](https://docs.github.com/en/code-security/reference/supply-chain-security/troubleshoot-dependabot/dependabot-errors)

Live evidence gathered 2026-07-29 against `IsmaelMartinez/teams-for-linux`
(alert #153) and the `automated-security-fixes` endpoint across five portfolio
repositories.
