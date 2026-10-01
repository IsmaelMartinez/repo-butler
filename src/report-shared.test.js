import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { buildActionItems } from './report-repo.js';
import { buildCampaignSection } from './report-portfolio.js';
import { campaignsFor } from './mcp.js';
import { generateHealthBadge, computeHealthTier, isReleaseExempt, isBugIssue, isFeatureIssue, CAMPAIGN_DEFS, buildRepoSnapshot, jsStr, deployedLink, evaluateCampaign, autofixActive, isActionableBug } from './report-shared.js';

describe('jsStr', () => {
  it('quotes and escapes strings for inline <script> embedding', () => {
    assert.equal(jsStr('v1.2.3'), '"v1.2.3"');
    assert.equal(jsStr(`v1'+alert(1)+'`), '"v1\'+alert(1)+\'"');
  });

  it('neutralises script-element breakout sequences', () => {
    const out = jsStr('</script><script>alert(1)</script>');
    assert.ok(!out.includes('</script>'));
    assert.ok(!out.includes('<'));
    assert.ok(!out.includes('>'));
  });

  it('escapes quotes, backslashes, and newlines', () => {
    assert.equal(jsStr('a"b\\c\nd'), '"a\\"b\\\\c\\nd"');
  });
});

describe('generateHealthBadge', () => {
  it('returns a valid SVG string', () => {
    const svg = generateHealthBadge('my-repo', 'gold');
    assert.ok(svg.startsWith('<svg'));
    assert.ok(svg.includes('</svg>'));
    assert.ok(svg.includes('xmlns="http://www.w3.org/2000/svg"'));
  });

  it('publishes an unconfirmed tier as "unconfirmed", never as a downgrade (#452)', () => {
    const svg = generateHealthBadge('repo', 'unconfirmed');
    assert.ok(svg.includes('unconfirmed'));
    assert.ok(!svg.includes('Silver') && !svg.includes('None'));
  });

  it('contains the tier name for gold', () => {
    const svg = generateHealthBadge('repo', 'gold');
    assert.ok(svg.includes('Gold'));
    assert.ok(svg.includes('#ffd700'));
  });

  it('contains the tier name for silver', () => {
    const svg = generateHealthBadge('repo', 'silver');
    assert.ok(svg.includes('Silver'));
    assert.ok(svg.includes('#c0c0c0'));
  });

  it('contains the tier name for bronze', () => {
    const svg = generateHealthBadge('repo', 'bronze');
    assert.ok(svg.includes('Bronze'));
    assert.ok(svg.includes('#cd7f32'));
  });

  it('shows Unranked for none tier', () => {
    const svg = generateHealthBadge('repo', 'none');
    assert.ok(svg.includes('Unranked'));
    assert.ok(svg.includes('#6e7681'));
  });

  it('contains the label text', () => {
    const svg = generateHealthBadge('test-repo', 'silver');
    assert.ok(svg.includes('health'));
  });

  it('escapes HTML in repo name', () => {
    const svg = generateHealthBadge('<script>xss</script>', 'gold');
    assert.ok(!svg.includes('<script>'));
    assert.ok(svg.includes('&lt;script&gt;'));
  });
});

describe('computeHealthTier', () => {
  const now = new Date().toISOString();
  const ninetyOneDaysAgo = new Date(Date.now() - 91 * 86400000).toISOString();
  const sevenMonthsAgo = new Date(Date.now() - 210 * 86400000).toISOString();
  const thirteenMonthsAgo = new Date(Date.now() - 400 * 86400000).toISOString();

  it('assigns gold tier when all criteria are met', () => {
    const r = {
      ci: 2, license: 'MIT', open_issues: 5, pushed_at: now, released_at: now,
      communityHealth: 85, vulns: { count: 0, max_severity: null }, commits: 50,
    };
    const { tier, checks } = computeHealthTier(r);
    assert.equal(tier, 'gold');
    assert.ok(checks.every(c => c.passed), 'all checks should pass for gold');
  });

  it('ignores the Dependabot autofix state — an open high alert still drops the tier (ADR-012 Phase 3)', () => {
    // "In flight" is a governance annotation, NOT a tier reprieve: whether or not
    // autofix is opening bump PRs, the alert is still open, so the Gold security
    // check must fail identically with autofix on, off, or unknown.
    const base = {
      ci: 2, license: 'MIT', open_issues: 5, pushed_at: now, released_at: now,
      communityHealth: 85, vulns: { count: 1, high: 1, max_severity: 'high' }, commits: 50,
    };
    const withOn = computeHealthTier({ ...base, autofix: { enabled: true, paused: false } });
    const withOff = computeHealthTier({ ...base, autofix: { enabled: false, paused: false } });
    const withNone = computeHealthTier(base);
    assert.notEqual(withNone.tier, 'gold', 'an open high alert blocks gold');
    assert.equal(withOn.tier, withNone.tier, 'autofix ON must not change the tier');
    assert.equal(withOff.tier, withNone.tier, 'autofix OFF must not change the tier');
    const secCheck = c => c.name.toLowerCase().includes('security');
    assert.deepEqual(
      withOn.checks.filter(secCheck).map(c => c.passed),
      withNone.checks.filter(secCheck).map(c => c.passed),
      'the security check outcome is identical regardless of autofix state',
    );
  });

  describe('an unreadable scanner (#452)', () => {
    // A 5xx, network error or exhausted rate limit on an alerts API. Unlike
    // null (a definitive "not enabled" from a 403/404) it is not evidence of
    // anything, and the high that should drop the tier may be exactly there.
    const gold = {
      ci: 2, license: 'MIT', open_issues: 5, pushed_at: now, released_at: now,
      communityHealth: 85, commits: 50,
      vulns: { count: 0, max_severity: null },
      codeScanning: { count: 0, max_severity: null },
      secretScanning: { count: 0 },
    };
    const zeroCheck = r => computeHealthTier(r).checks.find(c => c.name === 'Zero critical/high security findings');

    it('fails "Zero critical/high" when any one scanner is unreadable, even with the others clean', () => {
      for (const key of ['vulns', 'codeScanning', 'secretScanning']) {
        const r = { ...gold, [key]: { unreadable: true } };
        assert.equal(zeroCheck(r).passed, false, `${key} unreadable must not pass`);
        assert.notEqual(computeHealthTier(r).tier, 'gold', `${key} unreadable must not hold Gold`);
      }
    });

    it('keeps a not-enabled (null) scanner passing when another scanner read clean', () => {
      // Today's meaning, unchanged: a repo without CodeQL can still be Gold.
      assert.equal(zeroCheck({ ...gold, codeScanning: null }).passed, true);
      assert.equal(computeHealthTier({ ...gold, codeScanning: null }).tier, 'gold');
    });

    it('does not count an unreadable scanner as configured', () => {
      const r = { ...gold, vulns: { unreadable: true }, codeScanning: null, secretScanning: null };
      const configured = computeHealthTier(r).checks.find(c => c.name === 'Security scanning configured');
      assert.equal(configured.passed, false);
    });

    describe('isTierProvisional — an unread scanner can only have withheld Gold', () => {
      const unread = { ...gold, codeScanning: { unreadable: true } };
      const old = new Date(Date.now() - 200 * 86400000).toISOString();

      it('is true only when the repo would otherwise be Gold', async () => {
        const { isTierProvisional } = await import('./report-shared.js');
        assert.equal(isTierProvisional(unread), true);
        assert.equal(isTierProvisional(gold), false, 'nothing unread');
        assert.equal(isTierProvisional({ ...unread, license: 'None' }), false, 'a missing licence holds the tier on its own');
        assert.equal(isTierProvisional({ ...unread, vulns: { count: 1, high: 1, max_severity: 'high' } }), false, 'a read high fails Gold regardless');
      });

      it('honours release_exempt, as computeHealthTier does', async () => {
        const { isTierProvisional } = await import('./report-shared.js');
        assert.equal(isTierProvisional({ ...unread, released_at: old }), false);
        assert.equal(isTierProvisional({ ...unread, released_at: old }, { releaseExempt: true }), true);
      });

      it("reads a weekly record's stored checks rather than re-scoring it with today's clock", async () => {
        const { isTierProvisional } = await import('./report-shared.js');
        // The release was recent when the week was written; it is old now.
        const stored = computeHealthTier({ ...unread }).checks;
        assert.equal(isTierProvisional({ ...unread, released_at: old, computed: { tier: 'silver', checks: stored } }), true);
      });
    });

    it('drops an unreadable Dependabot read out of the Vulnerability Free campaign rather than counting it compliant', () => {
      const c = CAMPAIGN_DEFS.find(x => x.name === 'Vulnerability Free');
      const details = { a: { vulns: { unreadable: true } }, b: { vulns: { count: 0, max_severity: null } } };
      const { total, compliant } = evaluateCampaign(c, [{ name: 'a' }, { name: 'b' }], details);
      assert.equal(total, 1);
      assert.deepEqual(compliant.map(r => r.name), ['b']);
    });
  });

  it('assigns silver when gold criteria fail but silver pass', () => {
    const r = {
      ci: 1, license: 'MIT', open_issues: 15, pushed_at: now,
      communityHealth: 60, vulns: null, commits: 10,
    };
    const { tier } = computeHealthTier(r);
    assert.equal(tier, 'silver');
  });

  it('assigns bronze when only basic activity exists', () => {
    const r = {
      ci: 0, license: 'None', open_issues: 0, pushed_at: sevenMonthsAgo,
      communityHealth: 20, vulns: null, commits: 5,
    };
    const { tier } = computeHealthTier(r);
    assert.equal(tier, 'bronze');
  });

  it('assigns none when repo is completely inactive', () => {
    const r = {
      ci: 0, license: 'None', open_issues: 0, pushed_at: thirteenMonthsAgo,
      communityHealth: null, vulns: null, commits: 0,
    };
    const { tier } = computeHealthTier(r);
    assert.equal(tier, 'none');
  });

  it('returns checks array with name, passed, and required_for', () => {
    const r = {
      ci: 2, license: 'MIT', open_issues: 0, pushed_at: now, released_at: now,
      communityHealth: 90, vulns: { count: 0, max_severity: null }, commits: 10,
    };
    const { checks } = computeHealthTier(r);
    assert.ok(checks.length > 0, 'should have checks');
    for (const c of checks) {
      assert.ok('name' in c, 'check should have name');
      assert.ok('passed' in c, 'check should have passed');
      assert.ok('required_for' in c, 'check should have required_for');
      assert.ok(['gold', 'silver', 'bronze'].includes(c.required_for));
    }
  });

  it('fails gold when community health is below 80 but above 50', () => {
    const r = {
      ci: 2, license: 'MIT', open_issues: 5, pushed_at: now, released_at: now,
      communityHealth: 60, vulns: { count: 0, max_severity: null }, commits: 50,
    };
    const { tier } = computeHealthTier(r);
    assert.equal(tier, 'silver');
  });

  it('fails gold when critical vulnerabilities exist', () => {
    const r = {
      ci: 2, license: 'MIT', open_issues: 5, pushed_at: now, released_at: now,
      communityHealth: 90, vulns: { count: 1, max_severity: 'critical' }, commits: 50,
    };
    const { tier } = computeHealthTier(r);
    assert.equal(tier, 'silver');
  });

  it('fails gold when high vulnerabilities exist', () => {
    const r = {
      ci: 2, license: 'MIT', open_issues: 5, pushed_at: now, released_at: now,
      communityHealth: 90, vulns: { count: 1, max_severity: 'high' }, commits: 50,
    };
    const { tier } = computeHealthTier(r);
    assert.equal(tier, 'silver');
  });

  it('gold allows medium/low vulnerabilities', () => {
    const r = {
      ci: 2, license: 'MIT', open_issues: 5, pushed_at: now, released_at: now,
      communityHealth: 90, vulns: { count: 2, max_severity: 'medium' }, commits: 50,
    };
    const { tier } = computeHealthTier(r);
    assert.equal(tier, 'gold');
  });

  it('fails gold when open bugs >= 10', () => {
    const r = {
      ci: 2, license: 'MIT', open_issues: 25, open_bugs: 10, pushed_at: now, released_at: now,
      communityHealth: 90, vulns: { count: 0, max_severity: null }, commits: 50,
    };
    const { tier } = computeHealthTier(r);
    assert.equal(tier, 'silver');
  });

  it('gold passes with many open issues if few are bugs', () => {
    const r = {
      ci: 2, license: 'MIT', open_issues: 50, open_bugs: 3, pushed_at: now, released_at: now,
      communityHealth: 90, vulns: { count: 0, max_severity: null }, commits: 50,
    };
    const { tier } = computeHealthTier(r);
    assert.equal(tier, 'gold');
  });

  it('falls back to open_issues when open_bugs is not set', () => {
    const r = {
      ci: 2, license: 'MIT', open_issues: 20, pushed_at: now, released_at: now,
      communityHealth: 90, vulns: { count: 0, max_severity: null }, commits: 50,
    };
    const { tier } = computeHealthTier(r);
    assert.equal(tier, 'silver');
  });

  it('fails gold when released_at > 90 days ago', () => {
    const r = {
      ci: 2, license: 'MIT', open_issues: 0, pushed_at: now, released_at: ninetyOneDaysAgo,
      communityHealth: 90, vulns: { count: 0, max_severity: null }, commits: 50,
    };
    const { tier } = computeHealthTier(r);
    assert.equal(tier, 'silver');
  });

  it('fails gold when pushed_at is recent but released_at is missing', () => {
    const r = {
      ci: 2, license: 'MIT', open_issues: 0, pushed_at: now, released_at: null,
      communityHealth: 90, vulns: { count: 0, max_severity: null }, commits: 50,
    };
    const { tier } = computeHealthTier(r);
    assert.equal(tier, 'silver');
  });

  it('fails silver when no license', () => {
    const r = {
      ci: 1, license: 'None', open_issues: 0, pushed_at: now,
      communityHealth: 60, vulns: null, commits: 10,
    };
    const { tier } = computeHealthTier(r);
    assert.equal(tier, 'bronze');
  });

  it('fails silver when community health below 50', () => {
    const r = {
      ci: 1, license: 'MIT', open_issues: 0, pushed_at: now,
      communityHealth: 30, vulns: null, commits: 10,
    };
    const { tier } = computeHealthTier(r);
    assert.equal(tier, 'bronze');
  });

  it('fails silver when pushed_at > 180 days ago', () => {
    const r = {
      ci: 1, license: 'MIT', open_issues: 0, pushed_at: sevenMonthsAgo,
      communityHealth: 60, vulns: null, commits: 10,
    };
    const { tier } = computeHealthTier(r);
    assert.equal(tier, 'bronze');
  });

  it('bronze with commits but old push date within a year', () => {
    const elevenMonthsAgo = new Date(Date.now() - 330 * 86400000).toISOString();
    const r = {
      ci: 0, license: 'None', open_issues: 0, pushed_at: elevenMonthsAgo,
      communityHealth: null, vulns: null, commits: 3,
    };
    const { tier } = computeHealthTier(r);
    assert.equal(tier, 'bronze');
  });

  it('gold requires at least one security scanner configured', () => {
    const r = {
      ci: 2, license: 'MIT', open_issues: 0, pushed_at: now, released_at: now,
      communityHealth: 90, vulns: null, commits: 50,
    };
    const { tier } = computeHealthTier(r);
    assert.equal(tier, 'silver');
  });

  it('gold requires CI workflows >= 2', () => {
    const r = {
      ci: 1, license: 'MIT', open_issues: 0, pushed_at: now, released_at: now,
      communityHealth: 90, vulns: { count: 0, max_severity: null }, commits: 50,
    };
    const { tier } = computeHealthTier(r);
    assert.equal(tier, 'silver');
  });

  it('gold passes security check with only code scanning configured (no dependabot)', () => {
    const r = {
      ci: 2, license: 'MIT', open_issues: 5, pushed_at: now, released_at: now,
      communityHealth: 85, vulns: null, codeScanning: { count: 0, max_severity: null }, secretScanning: null, commits: 50,
    };
    const { tier } = computeHealthTier(r);
    assert.equal(tier, 'gold');
  });

  it('gold passes security check with only secret scanning configured', () => {
    const r = {
      ci: 2, license: 'MIT', open_issues: 5, pushed_at: now, released_at: now,
      communityHealth: 85, vulns: null, codeScanning: null, secretScanning: { count: 0 }, commits: 50,
    };
    const { tier } = computeHealthTier(r);
    assert.equal(tier, 'gold');
  });

  it('gold fails security check when no scanner is configured', () => {
    const r = {
      ci: 2, license: 'MIT', open_issues: 5, pushed_at: now, released_at: now,
      communityHealth: 85, vulns: null, codeScanning: null, secretScanning: null, commits: 50,
    };
    const { tier } = computeHealthTier(r);
    assert.equal(tier, 'silver');
  });

  it('gold fails when code scanning has critical findings', () => {
    const r = {
      ci: 2, license: 'MIT', open_issues: 5, pushed_at: now, released_at: now,
      communityHealth: 85, vulns: null, codeScanning: { count: 1, max_severity: 'critical' }, secretScanning: null, commits: 50,
    };
    const { tier } = computeHealthTier(r);
    assert.equal(tier, 'silver');
  });

  it('gold fails when secret scanning has open alerts', () => {
    const r = {
      ci: 2, license: 'MIT', open_issues: 5, pushed_at: now, released_at: now,
      communityHealth: 85, vulns: null, codeScanning: null, secretScanning: { count: 1 }, commits: 50,
    };
    const { tier } = computeHealthTier(r);
    assert.equal(tier, 'silver');
  });

  it('gold passes release check when releaseExempt option is true', () => {
    const r = {
      ci: 2, license: 'MIT', open_issues: 5, pushed_at: now, released_at: null,
      communityHealth: 85, vulns: { count: 0, max_severity: null }, commits: 50,
    };
    const { tier } = computeHealthTier(r, { releaseExempt: true });
    assert.equal(tier, 'gold');
  });

  it('gold still fails release check when releaseExempt is false (default)', () => {
    const r = {
      ci: 2, license: 'MIT', open_issues: 5, pushed_at: now, released_at: null,
      communityHealth: 85, vulns: { count: 0, max_severity: null }, commits: 50,
    };
    const { tier } = computeHealthTier(r);
    assert.equal(tier, 'silver');
  });
});

describe('CAMPAIGN_DEFS shared definitions', () => {
  it('exposes exactly the five expected campaigns', () => {
    assert.equal(CAMPAIGN_DEFS.length, 5);
    assert.deepEqual(
      CAMPAIGN_DEFS.map(c => c.name),
      ['Community Health', 'Vulnerability Free', 'CI Reliability', 'License Compliance', 'Issue Templates'],
    );
    for (const c of CAMPAIGN_DEFS) {
      assert.equal(typeof c.name, 'string');
      assert.equal(typeof c.description, 'string');
      assert.equal(typeof c.test, 'function');
      // applicable is optional (License + Issue Templates rely on the default).
      if (c.applicable !== undefined) assert.equal(typeof c.applicable, 'function');
    }
  });

  it('MCP get_campaign_status and buildCampaignSection agree on counts for the same fake portfolio', () => {
    // Fake portfolio: a healthy repo, a partially-compliant repo, a non-compliant
    // repo, and an excluded shadow repo (must be filtered identically by both).
    const data = {
      alpha: { communityHealth: 90, vulns: { count: 0, max_severity: null }, ciPassRate: 0.99, license: 'MIT', hasIssueTemplate: true },
      beta:  { communityHealth: 70, vulns: { count: 1, max_severity: 'high' }, ciPassRate: 0.85, license: 'Apache-2.0', hasIssueTemplate: false },
      gamma: { communityHealth: null, vulns: null, ciPassRate: null, license: 'None', hasIssueTemplate: false },
      'my-shadow': { communityHealth: 95, vulns: { count: 0, max_severity: null }, ciPassRate: 1, license: 'MIT', hasIssueTemplate: true },
    };

    // The same computation get_campaign_status serves, not a copy of it.
    const mcpResult = campaignsFor(data).map(({ name, total, compliant }) => ({ name, total, compliant }));

    // Build the dashboard HTML for the same portfolio and parse the per-campaign
    // ratios (rendered as `${count}/${total}` inside campaign-ratio spans).
    const dashRepos = Object.keys(data).map(name => ({
      name, archived: false, fork: false, pushed_at: new Date().toISOString(),
      stars: 1, forks: 0, open_issues: 0,
    }));
    const html = buildCampaignSection(dashRepos, data);
    const ratioMatches = [...html.matchAll(/<h3>([^<]+)<\/h3><span class="campaign-ratio">(\d+)\/(\d+)<\/span>/g)];
    const dashResult = ratioMatches.map(m => ({
      name: m[1], compliant: Number(m[2]), total: Number(m[3]),
    }));

    assert.deepEqual(dashResult, mcpResult,
      'MCP computeCampaigns and dashboard buildCampaignSection must report identical {compliant,total} per campaign');
  });
});

describe('isReleaseExempt', () => {
  it('returns true for a repo listed in release_exempt', () => {
    assert.equal(isReleaseExempt('sound3fy', { release_exempt: 'sound3fy,other-repo' }), true);
  });

  it('returns false for a repo not listed in release_exempt', () => {
    assert.equal(isReleaseExempt('repo-butler', { release_exempt: 'sound3fy' }), false);
  });

  it('returns false when release_exempt is empty string', () => {
    assert.equal(isReleaseExempt('sound3fy', { release_exempt: '' }), false);
  });

  it('returns false when release_exempt key is missing', () => {
    assert.equal(isReleaseExempt('sound3fy', {}), false);
  });

  it('handles whitespace around repo names in comma-separated list', () => {
    assert.equal(isReleaseExempt('sound3fy', { release_exempt: ' sound3fy , other-repo ' }), true);
  });
});

describe('isBugIssue', () => {
  it('returns true for bug label', () => {
    assert.equal(isBugIssue(['bug']), true);
  });

  it('returns true for case-insensitive match', () => {
    assert.equal(isBugIssue(['Bug']), true);
    assert.equal(isBugIssue(['BUG']), true);
  });

  it('returns true for variant bug labels', () => {
    assert.equal(isBugIssue(['defect']), true);
    assert.equal(isBugIssue(['type: bug']), true);
    assert.equal(isBugIssue(['kind/bug']), true);
  });

  it('returns false for feature labels', () => {
    assert.equal(isBugIssue(['enhancement']), false);
    assert.equal(isBugIssue(['feature']), false);
  });

  it('returns false for empty labels', () => {
    assert.equal(isBugIssue([]), false);
  });

  it('returns true when bug is among multiple labels', () => {
    assert.equal(isBugIssue(['priority: high', 'bug', 'frontend']), true);
  });
});

describe('isFeatureIssue', () => {
  it('returns true for enhancement label', () => {
    assert.equal(isFeatureIssue(['enhancement']), true);
  });

  it('returns true for feature-request label', () => {
    assert.equal(isFeatureIssue(['feature-request']), true);
  });

  it('returns false for bug labels', () => {
    assert.equal(isFeatureIssue(['bug']), false);
  });

  it('returns false when both bug and enhancement are present (bug takes precedence)', () => {
    assert.equal(isFeatureIssue(['bug', 'enhancement']), false);
  });

  it('returns false for unlabeled issues', () => {
    assert.equal(isFeatureIssue([]), false);
  });
});

describe('deployedLink (dashboard deployed-page link)', () => {
  it('renders an anchor for a valid https homepage', () => {
    const out = deployedLink('https://demo.example/');
    assert.ok(out.includes('href="https://demo.example/"'), 'href is the normalised URL');
    assert.ok(out.includes('class="site-link"'));
    assert.ok(out.includes('↗'), 'uses the default glyph label');
  });

  it('gives the (icon-only) link an accessible name', () => {
    assert.ok(deployedLink('https://demo.example/').includes('aria-label="Live site"'),
      'icon-only link needs an aria-label for screen readers');
  });

  it('uses a caller-supplied label', () => {
    assert.ok(deployedLink('https://demo.example/', 'live site ↗').includes('>live site ↗</a>'));
  });

  it('returns empty string for an absent or unsafe homepage', () => {
    assert.equal(deployedLink(null), '');
    assert.equal(deployedLink(''), '');
    assert.equal(deployedLink('javascript:alert(1)'), '', 'must not emit a javascript: link');
    assert.equal(deployedLink('/relative'), '');
  });

  it('HTML-escapes the href (defence-in-depth on top of URL normalisation)', () => {
    // A query string with a double-quote would break out of the attribute if
    // not escaped; new URL() percent-encodes it, and escHtml is the backstop.
    const out = deployedLink('https://demo.example/?q="onmouseover');
    assert.ok(!out.includes('"onmouseover'), 'raw quote must not survive into the attribute');
  });
});

describe('buildRepoSnapshot', () => {
  it('produces the full report.js inline shape when given per-repo fetch data', () => {
    const owner = 'octo';
    const r = { name: 'widget', stars: 7, forks: 1, pushed_at: '2026-04-01T00:00:00Z' };
    const meta = { stargazers_count: 7, forks_count: 1, subscribers_count: 3, default_branch: 'main', license: { spdx_id: 'MIT' }, homepage: 'https://widget.example/' };
    const communityProfile = { health_percentage: 85, files: { readme: true, license: true } };
    const releases = [
      { tag_name: 'v1.2.0', published_at: '2026-03-15T00:00:00Z', prerelease: false },
      { tag_name: 'v1.1.0', published_at: '2026-02-01T00:00:00Z', prerelease: false },
    ];
    const openIssues = [
      { number: 10, title: 'Bug: x', labels: [{ name: 'bug' }], reactions: { total_count: 2 }, comments: 1, created_at: '2026-03-01', updated_at: '2026-03-10' },
      { number: 11, title: 'Blocked', labels: [{ name: 'blocked' }], reactions: null, comments: 0, created_at: '2026-03-02', updated_at: '2026-03-11' },
      { number: 12, title: 'Feedback', labels: [{ name: 'awaiting-feedback' }], reactions: { total_count: 0 }, comments: 0, created_at: '2026-03-03', updated_at: '2026-03-12' },
    ];
    const prAuthors = [
      { author: 'alice', count: 3 },
      { author: 'dependabot[bot]', count: 5 },
    ];
    const details = {
      license: 'MIT', ci: 4, vulns: { count: 2, max_severity: 'high' },
      codeScanning: { count: 1, max_severity: 'medium' },
      secretScanning: { count: 0 },
      ciPassRate: 0.92, sbom: { count: 50, packages: [] },
      open_bugs: 1,
    };

    const snap = buildRepoSnapshot({
      owner, repo: r.name, details, meta, communityProfile, releases,
      openIssues, prAuthors, busFactor: 2, timeToCloseMedian: 4.5,
      pushedAt: r.pushed_at, stars: r.stars, forks: r.forks,
    });

    // Construct the expected output inline, mirroring the pre-refactor shape.
    const expected = {
      repository: 'octo/widget',
      meta: { stars: 7, forks: 1, watchers: 3, default_branch: 'main', homepage: 'https://widget.example/' },
      issues: {
        open: [
          { number: 10, title: 'Bug: x', labels: ['bug'], reactions: 2, comments: 1, created_at: '2026-03-01', updated_at: '2026-03-10' },
          { number: 11, title: 'Blocked', labels: ['blocked'], reactions: 0, comments: 0, created_at: '2026-03-02', updated_at: '2026-03-11' },
          { number: 12, title: 'Feedback', labels: ['awaiting-feedback'], reactions: 0, comments: 0, created_at: '2026-03-03', updated_at: '2026-03-12' },
        ],
      },
      releases: [
        { tag: 'v1.2.0', published_at: '2026-03-15T00:00:00Z', prerelease: false },
        { tag: 'v1.1.0', published_at: '2026-02-01T00:00:00Z', prerelease: false },
      ],
      pushed_at: '2026-04-01T00:00:00Z',
      license: 'MIT',
      community_profile: communityProfile,
      dependabot_alerts: { count: 2, max_severity: 'high' },
      code_scanning_alerts: { count: 1, max_severity: 'medium' },
      secret_scanning_alerts: { count: 0 },
      automated_security_fixes: null,
      ci_pass_rate: { pass_rate: 0.92, total_runs: 0, passed: 0, failed: 0 },
      sbom: { count: 50, packages: [] },
      summary: {
        open_issues: 3, open_bugs: 1, blocked_issues: 1, awaiting_feedback: 1,
        recently_merged_prs: 8, human_prs: 3, bot_prs: 5,
        releases: 2, latest_release: 'v1.2.0', ci_workflows: 4,
        bus_factor: 2, time_to_close_median: 4.5,
        automated_security_fixes_active: null,
      },
    };
    assert.deepEqual(snap, expected);
  });

  it('falls back to repo basics when meta is missing (report.js path)', () => {
    const snap = buildRepoSnapshot({
      owner: 'octo', repo: 'widget',
      details: { license: 'Apache-2.0', ci: 1 },
      meta: null, stars: 12, forks: 3, pushedAt: '2026-04-01T00:00:00Z',
    });
    assert.deepEqual(snap.meta, { stars: 12, forks: 3, homepage: null });
    assert.equal(snap.license, 'Apache-2.0');
    assert.equal(snap.pushed_at, '2026-04-01T00:00:00Z');
  });

  it('threads the Dependabot autofix state from details (ADR-012 Phase 3)', () => {
    // enabled + not paused → active true; state object passed through verbatim.
    const on = buildRepoSnapshot({ owner: 'o', repo: 'r', details: { autofix: { enabled: true, paused: false } } });
    assert.deepEqual(on.automated_security_fixes, { enabled: true, paused: false });
    assert.equal(on.summary.automated_security_fixes_active, true);

    // paused → not actively opening PRs → active false.
    const paused = buildRepoSnapshot({ owner: 'o', repo: 'r', details: { autofix: { enabled: true, paused: true } } });
    assert.equal(paused.summary.automated_security_fixes_active, false);

    // off → active false.
    const off = buildRepoSnapshot({ owner: 'o', repo: 'r', details: { autofix: { enabled: false, paused: false } } });
    assert.equal(off.summary.automated_security_fixes_active, false);

    // unreadable/absent → null (unknown), never annotated as false.
    const unknown = buildRepoSnapshot({ owner: 'o', repo: 'r', details: { autofix: null } });
    assert.equal(unknown.automated_security_fixes, null);
    assert.equal(unknown.summary.automated_security_fixes_active, null);
  });

  it('produces the minimal shape used by buildPortfolioAttentionSection', () => {
    const details = {
      vulns: { count: 1, max_severity: 'high' },
      codeScanning: null,
      secretScanning: { count: 0 },
      ciPassRate: 0.5,
    };
    const snap = buildRepoSnapshot({ owner: 'octo', repo: 'widget', details });

    assert.equal(snap.repository, 'octo/widget');
    assert.deepEqual(snap.dependabot_alerts, { count: 1, max_severity: 'high' });
    assert.equal(snap.code_scanning_alerts, null);
    assert.deepEqual(snap.secret_scanning_alerts, { count: 0 });
    assert.equal(snap.ci_pass_rate.pass_rate, 0.5);
    assert.deepEqual(snap.issues, { open: [] });
    // summary defaults are safe — every key present, neutral values.
    assert.equal(snap.summary.open_issues, 0);
    assert.equal(snap.summary.recently_merged_prs, 0);
    assert.equal(snap.summary.releases, 0);
    assert.equal(snap.summary.latest_release, 'none');
    // null, not 0: `ci` is tri-state, and this fixture supplies no count. The
    // neutral value for "we did not look" is unknown — 0 would assert the repo
    // has no CI, which is what demoted repos past PORTFOLIO_DETAIL_LIMIT (whose
    // details object is `{}`) and fed a tier-regression finding for a decline
    // nobody observed.
    assert.equal(snap.summary.ci_workflows, null);

    // The snapshot must be consumable by buildActionItems.
    const items = buildActionItems(snap, []);
    // CI pass rate < 0.8 → priority 5 action; vulns critical=undefined,high=0 → no vuln action.
    // (Action items only fires on critical/high counts present in alert object.)
    assert.ok(items.some(i => i.priority === 5), 'low CI pass rate should trigger action');
  });

  it('falls back to meta.pushed_at when explicit pushedAt is omitted', () => {
    const snap = buildRepoSnapshot({
      owner: 'octo', repo: 'widget',
      meta: { stargazers_count: 1, forks_count: 0, pushed_at: '2026-04-01T00:00:00Z' },
    });
    assert.equal(snap.pushed_at, '2026-04-01T00:00:00Z');
  });

  it('explicit pushedAt wins over meta.pushed_at', () => {
    const snap = buildRepoSnapshot({
      owner: 'octo', repo: 'widget',
      pushedAt: '2026-04-15T00:00:00Z',
      meta: { stargazers_count: 1, forks_count: 0, pushed_at: '2026-04-01T00:00:00Z' },
    });
    assert.equal(snap.pushed_at, '2026-04-15T00:00:00Z');
  });

  it('defaults all optional inputs to neutral values', () => {
    const snap = buildRepoSnapshot({ owner: 'octo', repo: 'empty' });
    assert.equal(snap.repository, 'octo/empty');
    assert.deepEqual(snap.meta, { stars: 0, forks: 0, homepage: null });
    assert.deepEqual(snap.issues, { open: [] });
    assert.deepEqual(snap.releases, []);
    assert.equal(snap.pushed_at, null);
    assert.equal(snap.license, null);
    assert.equal(snap.community_profile, null);
    assert.equal(snap.dependabot_alerts, null);
    assert.equal(snap.code_scanning_alerts, null);
    assert.equal(snap.secret_scanning_alerts, null);
    assert.equal(snap.ci_pass_rate, null);
    assert.equal(snap.sbom, null);
    assert.equal(snap.summary.bus_factor, 0);
    assert.equal(snap.summary.time_to_close_median, null);
    assert.equal(snap.summary.open_bugs, null);
  });

  it('output is consumable by computeHealthTier via the snapshotToTierInput path', async () => {
    // Build a snapshot with strong-gold inputs.
    const recentISO = new Date(Date.now() - 30 * 86400000).toISOString();
    const snap = buildRepoSnapshot({
      owner: 'octo', repo: 'widget',
      details: {
        license: 'MIT', ci: 3, vulns: { count: 0, max_severity: null },
        codeScanning: { count: 0, max_severity: null },
        secretScanning: { count: 0 },
        ciPassRate: 0.99, open_bugs: 1,
      },
      meta: { stargazers_count: 1, forks_count: 0, subscribers_count: 0, default_branch: 'main', license: { spdx_id: 'MIT' } },
      communityProfile: { health_percentage: 90, files: { license: true } },
      releases: [{ tag_name: 'v1', published_at: recentISO, prerelease: false }],
      pushedAt: recentISO,
    });

    // Snapshot must contain every field snapshotToTierInput needs.
    assert.ok(snap.summary, 'has summary');
    assert.ok(snap.community_profile, 'has community_profile');
    assert.ok(snap.releases.length > 0, 'has releases');
    assert.equal(snap.releases[0].published_at, recentISO);
  });
});

describe('colorByThreshold', () => {
  it('returns the colour of the first matching range (typical 3-range case)', async () => {
    const { colorByThreshold } = await import('./report-shared.js');
    const ranges = [
      { lt: 50, color: 'red' },
      { lt: 80, color: 'amber' },
      { lt: Infinity, color: 'green' },
    ];
    assert.equal(colorByThreshold(10, ranges), 'red');
    assert.equal(colorByThreshold(60, ranges), 'amber');
    assert.equal(colorByThreshold(95, ranges), 'green');
  });

  it('falls into the first range for values below the lowest threshold', async () => {
    const { colorByThreshold } = await import('./report-shared.js');
    const ranges = [
      { lt: 50, color: 'red' },
      { lt: 80, color: 'amber' },
      { lt: Infinity, color: 'green' },
    ];
    assert.equal(colorByThreshold(0, ranges), 'red');
    assert.equal(colorByThreshold(-100, ranges), 'red');
  });

  it('falls into the final bucket for values above all thresholds', async () => {
    const { colorByThreshold } = await import('./report-shared.js');
    const ranges = [
      { lt: 50, color: 'red' },
      { lt: 80, color: 'amber' },
      { lt: Infinity, color: 'green' },
    ];
    assert.equal(colorByThreshold(1e9, ranges), 'green');
  });

  it('lt is strictly less-than at boundary values', async () => {
    const { colorByThreshold } = await import('./report-shared.js');
    const ranges = [
      { lt: 50, color: 'red' },
      { lt: 80, color: 'amber' },
      { lt: Infinity, color: 'green' },
    ];
    // 50 is NOT < 50, so it bumps to the next range
    assert.equal(colorByThreshold(50, ranges), 'amber');
    assert.equal(colorByThreshold(80, ranges), 'green');
    // 49.999 IS < 50
    assert.equal(colorByThreshold(49.999, ranges), 'red');
  });

  it('lte is less-than-or-equal at boundary values', async () => {
    const { colorByThreshold } = await import('./report-shared.js');
    const ranges = [
      { lte: 7, color: 'green' },
      { lte: 30, color: 'amber' },
      { lte: Infinity, color: 'red' },
    ];
    assert.equal(colorByThreshold(7, ranges), 'green');
    assert.equal(colorByThreshold(7.5, ranges), 'amber');
    assert.equal(colorByThreshold(30, ranges), 'amber');
    assert.equal(colorByThreshold(31, ranges), 'red');
  });

  it('returns the fallback for null/undefined input', async () => {
    const { colorByThreshold } = await import('./report-shared.js');
    const ranges = [
      { lt: 50, color: 'red' },
      { lt: Infinity, color: 'green' },
    ];
    assert.equal(colorByThreshold(null, ranges), '#6e7681');
    assert.equal(colorByThreshold(undefined, ranges), '#6e7681');
    assert.equal(colorByThreshold(null, ranges, 'grey'), 'grey');
  });

  it('handles a single-range case', async () => {
    const { colorByThreshold } = await import('./report-shared.js');
    const ranges = [{ lt: Infinity, color: 'only' }];
    assert.equal(colorByThreshold(0, ranges), 'only');
    assert.equal(colorByThreshold(1e9, ranges), 'only');
    assert.equal(colorByThreshold(null, ranges), '#6e7681');
  });
});

describe('getLibyearColor delegates to colorByThreshold', () => {
  it('preserves original colour mapping', async () => {
    const { getLibyearColor } = await import('./report-shared.js');
    assert.equal(getLibyearColor(null), '#6e7681');
    assert.equal(getLibyearColor(undefined), '#6e7681');
    assert.equal(getLibyearColor(0), 'var(--color-success)');
    assert.equal(getLibyearColor(4.99), 'var(--color-success)');
    assert.equal(getLibyearColor(5), 'var(--color-warning)');     // boundary: >= GREEN bumps to YELLOW
    assert.equal(getLibyearColor(19.99), 'var(--color-warning)');
    assert.equal(getLibyearColor(20), 'var(--color-danger)');     // boundary: >= YELLOW bumps to RED
    assert.equal(getLibyearColor(100), 'var(--color-danger)');
  });
});

describe('shared report predicates', () => {
  it('autofixActive is tri-state: null stays null, paused or disabled is false', () => {
    assert.equal(autofixActive(null), null);
    assert.equal(autofixActive(undefined), null);
    assert.equal(autofixActive({ enabled: true, paused: false }), true);
    assert.equal(autofixActive({ enabled: true, paused: true }), false);
    assert.equal(autofixActive({ enabled: false, paused: false }), false);
  });

  it('isActionableBug excludes blocked bugs and non-bugs, for string and object labels', () => {
    assert.equal(isActionableBug(['bug']), true);
    assert.equal(isActionableBug([{ name: 'Defect' }]), true);
    assert.equal(isActionableBug(['bug', 'blocked']), false);
    assert.equal(isActionableBug(['enhancement']), false);
  });

  it('evaluateCampaign drops non-applicable repos from the pool and scores the rest', () => {
    const c = CAMPAIGN_DEFS.find(x => x.name === 'CI Reliability');
    const details = { a: { ciPassRate: 0.95 }, b: { ciPassRate: 0.5 }, c: { ciPassRate: null } };
    const res = evaluateCampaign(c, [{ name: 'a' }, { name: 'b' }, { name: 'c' }], details);
    assert.equal(res.total, 2, 'unknown pass rate leaves the pool rather than failing');
    assert.deepEqual(res.compliant.map(r => r.name), ['a']);
    assert.deepEqual(res.nonCompliant.map(r => r.name), ['b']);
    assert.equal(res.percentage, 50);
    assert.equal(evaluateCampaign(c, [], details).percentage, 0);
  });

  it('evaluateCampaign rounds the percentage to the nearest integer', () => {
    const c = CAMPAIGN_DEFS.find(x => x.name === 'CI Reliability');
    const details = { a: { ciPassRate: 0.95 }, b: { ciPassRate: 0.95 }, c: { ciPassRate: 0.5 } };
    assert.equal(evaluateCampaign(c, [{ name: 'a' }, { name: 'b' }, { name: 'c' }], details).percentage, 67);
  });
});
