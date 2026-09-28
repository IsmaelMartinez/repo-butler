import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

describe('CSS includes collapsible styles', () => {
  it('has details and summary styling', async () => {
    const { CSS } = await import('./report-styles.js');
    assert.ok(CSS.includes('details'), 'CSS should style details elements');
    assert.ok(CSS.includes('summary'), 'CSS should style summary elements');
  });
});

describe('CSS utility colour classes', () => {
  it('defines .muted, .text-success, .text-warning, .text-danger and .text-sm with the expected values', async () => {
    const { CSS } = await import('./report-styles.js');
    assert.ok(CSS.includes('.muted{color:var(--muted)}'), 'CSS should define .muted');
    assert.ok(CSS.includes('.text-success{color:var(--color-success)}'), 'CSS should define .text-success');
    assert.ok(CSS.includes('.text-warning{color:var(--color-warning)}'), 'CSS should define .text-warning');
    assert.ok(CSS.includes('.text-danger{color:var(--color-danger)}'), 'CSS should define .text-danger');
    assert.ok(CSS.includes('.text-sm{font-size:0.75rem}'), 'CSS should define .text-sm');
  });

  it('defines :root design tokens for success/warning/danger colours', async () => {
    const { CSS } = await import('./report-styles.js');
    assert.ok(CSS.includes('--color-success:#566a4c'), 'CSS should define the moss success token (Mistglen light)');
    assert.ok(CSS.includes('--color-warning:#9a7536'), 'CSS should define the whisky warning token');
    assert.ok(CSS.includes('--color-danger:#9e463c'), 'CSS should define the rust danger token');
    assert.ok(CSS.includes('@media(prefers-color-scheme:dark)'), 'CSS should carry the dark (Bothy) theme');
    assert.ok(CSS.includes('--color-danger:#dd7060'), 'dark theme should redefine danger lighter for legibility');
  });
});

describe('htmlPage shell template', () => {
  it('produces a full HTML document with head, body, CSS, and Chart.js CDN', async () => {
    const { htmlPage, CSS } = await import('./report-styles.js');
    const html = htmlPage({ title: 'Test Title', body: '<h1>Hello</h1>' });
    assert.ok(html.startsWith('<!DOCTYPE html>'), 'starts with DOCTYPE');
    assert.ok(html.endsWith('</body></html>'), 'ends with closing body/html');
    assert.ok(html.includes('<title>Test Title</title>'), 'embeds title verbatim');
    assert.ok(html.includes(CSS), 'embeds shared CSS');
    assert.ok(html.includes('cdn.jsdelivr.net/npm/chart.js'), 'loads Chart.js from CDN');
    // Head must come before body.
    assert.ok(html.indexOf('</head>') < html.indexOf('<body>'), 'head precedes body');
    // Body content is interpolated unescaped.
    assert.ok(html.includes('<h1>Hello</h1>'), 'body interpolated verbatim');
  });

  it('omits the chart-defaults script when no charts are provided', async () => {
    const { htmlPage } = await import('./report-styles.js');
    const html = htmlPage({ title: 'No Charts', body: '<p>plain</p>' });
    assert.ok(!html.includes('Chart.defaults'), 'no defaults block when charts absent');
  });

  it('injects Chart.defaults and per-page chart code before </body>', async () => {
    const { htmlPage } = await import('./report-styles.js');
    const charts = "new Chart(document.getElementById('x'),{});";
    const html = htmlPage({ title: 'Charted', body: '<canvas id="x"></canvas>', charts });
    assert.ok(html.includes("Chart.defaults.color=__gv('--muted')"), 'sets default colour from the theme var');
    assert.ok(html.includes("Chart.defaults.borderColor=__gv('--sep')"), 'sets default grid colour from the theme var');
    assert.ok(html.includes(charts), 'injects per-page chart code verbatim');
    // Defaults must appear once, not twice.
    const matches = html.match(/Chart\.defaults\.color/g) || [];
    assert.equal(matches.length, 1, 'Chart.defaults block appears exactly once');
    // Charts script must be inside body (before </body>).
    assert.ok(html.indexOf(charts) < html.indexOf('</body>'), 'charts script before </body>');
  });
});

describe('Coorie theme (Mistglen light / Bothy dark)', () => {
  it('htmlPage wires the theme toggle, persistence script and color-scheme meta', async () => {
    const { htmlPage } = await import('./report-styles.js');
    const html = htmlPage({ title: 'T', body: '<p>x</p>' });
    assert.ok(html.includes('name="color-scheme" content="light dark"'), 'declares light+dark colour-scheme');
    assert.ok(html.includes("localStorage.getItem('rb-theme')"), 'restores a persisted theme before paint');
    assert.ok(html.includes('class="theme-toggle"'), 'renders the light/dark toggle');
    assert.ok(html.includes('function rbToggleTheme()'), 'includes the toggle handler');
  });

  it('CSS carries the photo hero, tweed texture, glen-hills and spark theming', async () => {
    const { CSS } = await import('./report-styles.js');
    assert.ok(CSS.includes('url("assets/glencoe.jpg")'), 'hero references the self-hosted Glencoe photo');
    assert.ok(CSS.includes('url("assets/fabric.jpg")'), 'page uses the tweed texture');
    assert.ok(CSS.includes('--hills:url("assets/hills-light.svg")'), 'light theme glen-hills');
    assert.ok(CSS.includes('url("assets/hills-dark.svg")'), 'dark theme glen-hills');
    assert.ok(CSS.includes('.spark{color:var(--accent-line)}'), 'sparkline themed via currentColor');
    assert.ok(CSS.includes('background-image:var(--hero-overlay)'), 'hero overlay is theme-driven');
  });

  it('per-repo report links its charts to the runtime theme palette', async () => {
    const { generateRepoReport } = await import('./report-repo.js');
    const snapshot = {
      repository: 'owner/test', meta: { stars: 5, forks: 1, watchers: 2 },
      issues: { open: [] }, releases: [{ tag: 'v1', published_at: new Date().toISOString() }],
      community_profile: { health_percentage: 90, files: { readme: true, license: true } },
      dependabot_alerts: { count: 0, max_severity: null }, code_scanning_alerts: null, secret_scanning_alerts: { count: 0 },
      ci_pass_rate: { pass_rate: 0.98, total_runs: 100, passed: 98, failed: 2 },
      pushed_at: new Date().toISOString(), license: 'MIT', sbom: null,
      summary: { open_issues: 0, open_bugs: 0, blocked_issues: 0, awaiting_feedback: 0, recently_merged_prs: 5, human_prs: 5, bot_prs: 0, releases: 1, latest_release: 'v1', ci_workflows: 4, bus_factor: 2, time_to_close_median: null },
    };
    const trends = { direction: 'stable', weeks: [{ week: 'W1', open_issues: 3, merged_prs: 2 }, { week: 'W2', open_issues: 2, merged_prs: 3 }] };
    const html = generateRepoReport(snapshot, [{ month: 'Jan', count: 5 }], [{ month: 'Jan', opened: 2, closed: 3 }], [{ author: 'dev', count: 5 }], trends, [], null, [], null, null, {});
    assert.ok(html.includes('var __C='), 'defines the runtime chart palette from CSS vars');
    assert.ok(html.includes('borderColor:__C.danger'), 'chart datasets use the themed palette, not fixed hexes');
    assert.ok(!/borderColor:'#[0-9a-f]{6}'/.test(html), 'no hard-coded chart border hexes');
  });
});
