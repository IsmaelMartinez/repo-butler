// CSS styles shared by all report HTML generators.
//
// Theme: "Coorie" — Scotland's cosy answer to Nordic minimalism. A light/dark
// pair, Mistglen (warm misted parchment) and Bothy (warm peat / candlelight),
// driven entirely off CSS custom properties. The base :root is Mistglen; the
// Bothy values apply automatically under prefers-color-scheme: dark, and a
// persisted manual toggle (data-theme on <html>) overrides the OS preference.
//
// Decoration is self-hosted (assets/ copied into reports/ by the REPORT phase):
// a Glencoe photograph behind the hero under a themed overlay, a whisper-faint
// tweed texture on the page, and a glen-hills silhouette above the footer.

const DARK_VARS = `
--bg:#211c18;--surface:#2b2520;--surface-2:#332c25;--border:#3a322b;--sep:#473d33;--hover:#322b24;
--ink:#ece3d4;--ink-strong:#f6efe1;--text:#d9cebc;--muted:#9c9286;--faint:#7d7466;
--link:#c2b1d0;--link-hover:#d6c9e1;--heather:#c2b1d0;--moss:#8fa67f;--whisky:#d6a155;--stone:#9c9286;--loch:#7fa6ba;
--color-success:#8fa67f;--color-warning:#d6a155;--color-danger:#dd7060;--accent-line:#c2b1d0;
--tier-gold-bg:#d2a95c;--tier-gold-ink:#241803;--tier-silver-bg:#c2bdb0;--tier-silver-ink:#22201a;--tier-bronze-bg:#c08a5c;--tier-bronze-ink:#1d1207;--tier-none-bg:#463f34;--tier-none-ink:#cfc6b6;
--tier-gold-text:#d2a95c;--tier-silver-text:#c2bdb0;--tier-bronze-text:#c08a5c;--tier-none-text:#9c9286;
--hm1:#2f3a29;--hm2:#42512f;--hm3:#5a6f3f;--hm4:#8fa67f;
--page-wash:rgba(33,28,24,0.90);
--hills:url("assets/hills-dark.svg");
--hero-overlay:linear-gradient(165deg,rgba(20,16,13,0.55) 0%,rgba(20,16,13,0.86) 100%);
--hero-text-shadow:0 1px 16px rgba(0,0,0,0.5);
--hero-dot-ring:rgba(255,255,255,0.18);
--card-shadow:0 1px 2px rgba(0,0,0,0.3);
`;

export const CSS = `<style>
:root{
--bg:#f4f2ea;--surface:#fcfaf4;--surface-2:#efece2;--border:#e7e3d6;--sep:#ddd8c9;--hover:#f0ede3;
--ink:#2c2a26;--ink-strong:#23211d;--text:#4b463d;--muted:#8b8579;--faint:#aaa493;
--link:#6f6486;--link-hover:#564c6c;--heather:#6f6486;--moss:#566a4c;--whisky:#9a7536;--stone:#8b8579;--loch:#4c6f7d;
--color-success:#566a4c;--color-warning:#9a7536;--color-danger:#9e463c;--accent-line:#6f6486;
--tier-gold-bg:#c39a4a;--tier-gold-ink:#332408;--tier-silver-bg:#b6b1a4;--tier-silver-ink:#2c2a23;--tier-bronze-bg:#b07a4e;--tier-bronze-ink:#2e1c0d;--tier-none-bg:#ded6c4;--tier-none-ink:#7b7262;
--tier-gold-text:#9c7a2e;--tier-silver-text:#7d7a72;--tier-bronze-text:#9a6a3e;--tier-none-text:#8b8579;
--hm1:#d3d9c4;--hm2:#b0bf95;--hm3:#869c6c;--hm4:#566a4c;
--page-wash:rgba(244,242,234,0.90);
--hills:url("assets/hills-light.svg");
--hero-overlay:linear-gradient(180deg,rgba(247,245,238,0.46) 0%,rgba(247,245,238,0.74) 60%,rgba(247,245,238,0.86) 100%);
--hero-text-shadow:0 1px 2px rgba(255,255,255,0.6),0 2px 16px rgba(255,255,255,0.45);
--hero-dot-ring:rgba(255,255,255,0.6);
--card-shadow:0 1px 2px rgba(47,42,36,0.05);
--tartan:repeating-linear-gradient(90deg,var(--moss) 0 16px,transparent 16px 20px,var(--link) 20px 38px,transparent 38px 42px,var(--whisky) 42px 48px,transparent 48px 66px);
}
@media(prefers-color-scheme:dark){:root:not([data-theme="light"]){${DARK_VARS}}}
:root[data-theme="dark"]{${DARK_VARS}}
*{margin:0;padding:0;box-sizing:border-box}
html{background-color:var(--bg);background-image:linear-gradient(var(--page-wash),var(--page-wash)),url("assets/fabric.jpg");background-size:cover,300px;background-attachment:fixed;color-scheme:light dark}
body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,'Helvetica Neue',Arial,sans-serif;background:transparent;color:var(--ink);padding:2.5rem;max-width:1180px;margin:0 auto;line-height:1.6;-webkit-font-smoothing:antialiased}
h1,h2,.status-headline,.chart-title,.digest-card h3{font-family:'Iowan Old Style','Palatino Linotype',Palatino,Georgia,'Times New Roman',serif}
h1{font-size:2.05rem;margin-bottom:0.2rem;color:var(--ink-strong);font-weight:600;letter-spacing:-0.015em}
h1 .repo-link{color:var(--ink-strong);text-decoration:none}
h1 .repo-link svg{vertical-align:middle;fill:var(--muted)}
h1 .repo-link:hover svg{fill:var(--heather)}
h2{font-size:1.3rem;margin:2.9rem 0 1.1rem;color:var(--ink-strong);font-weight:600;position:relative;padding-bottom:0.7rem;letter-spacing:-0.01em}
h2::after{content:"";position:absolute;left:0;bottom:0;width:52px;height:3px;border-radius:2px;background:var(--tartan)}
.subtitle{color:var(--muted);font-size:0.9rem;margin-bottom:1.9rem}
.subtitle a{color:var(--link)}
.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(200px,1fr));gap:1.2rem;margin-bottom:2rem}
.card{background:var(--surface);border:1px solid var(--border);border-radius:10px;padding:1.3rem;box-shadow:var(--card-shadow)}
.card h3{font-size:0.72rem;color:var(--muted);margin-bottom:0.4rem;text-transform:uppercase;letter-spacing:0.08em;font-weight:600}
.stat{font-size:2.1rem;font-weight:700;color:var(--ink-strong)}
.stat-sm{font-size:1.4rem}
.stat-label{color:var(--muted);font-size:0.8rem}
.chart-container{background:var(--surface);border:1px solid var(--border);border-radius:10px;padding:1.5rem;margin-bottom:1.5rem;box-shadow:var(--card-shadow)}
.chart-title{font-size:1rem;color:var(--ink-strong);margin-bottom:1rem}
.two-col{display:grid;grid-template-columns:1fr 1fr;gap:1.5rem}
.three-col{display:grid;grid-template-columns:1fr 1fr 1fr;gap:1.5rem}
canvas{max-height:300px}
table{width:100%;border-collapse:collapse;font-size:0.88rem}
th{text-align:left;color:var(--muted);padding:0.6rem;border-bottom:1px solid var(--sep);font-weight:600}
td{padding:0.6rem;border-bottom:1px solid var(--border)}
tr:hover{background:var(--hover)}
a{color:var(--link);text-decoration:none}
a:hover{color:var(--link-hover);text-decoration:underline}
.spark{color:var(--accent-line)}
.badge{display:inline-block;padding:0.15rem 0.55rem;border-radius:10px;font-size:0.7rem;font-weight:600}
.badge-active{background:var(--moss);color:#f6f2e8}
.badge-dormant{background:var(--color-danger);color:#f6f2e8}
.badge-archive{background:var(--stone);color:#f6f2e8}
.badge-fork{background:var(--loch);color:#f6f2e8}
.badge-test{background:var(--heather);color:#2a2330}
.tier-badge{display:inline-block;padding:0.15rem 0.55rem;border-radius:10px;font-size:0.7rem;font-weight:700;letter-spacing:0.02em}
.tier-gold{background:var(--tier-gold-bg);color:var(--tier-gold-ink)}
.tier-silver{background:var(--tier-silver-bg);color:var(--tier-silver-ink)}
.tier-bronze{background:var(--tier-bronze-bg);color:var(--tier-bronze-ink)}
.tier-none{background:var(--tier-none-bg);color:var(--tier-none-ink)}
.heatmap{display:grid;gap:2px;grid-auto-rows:12px}
.heatmap-cell{width:12px;height:12px;border-radius:2px}
.heatmap-labels{display:grid;gap:2px;margin-top:4px;font-size:0.6rem;color:var(--muted)}
.heatmap-labels span{text-align:center;white-space:nowrap}
.footer{text-align:center;color:var(--faint);font-size:0.8rem;margin-top:3rem;padding:1rem}
.site-footer{margin-top:5rem;padding:1.6rem 1rem;border-top:1px solid var(--sep);color:var(--muted);font-size:0.85rem;display:flex;flex-direction:column;gap:0.6rem;align-items:center;text-align:center;position:relative}
.site-footer::before{content:"";position:absolute;left:0;right:0;top:-116px;height:116px;background:var(--hills) bottom/100% 116px no-repeat;opacity:0.5;pointer-events:none}
.site-footer-links{display:flex;flex-wrap:wrap;justify-content:center;gap:0.4rem 1.2rem}
.site-footer-links a{color:var(--link)}
.site-footer-meta{color:var(--faint);font-size:0.8rem}
.hero-intro{background:var(--surface);border:1px solid var(--border);border-radius:10px;padding:1.3rem 1.5rem;margin-bottom:1.5rem;color:var(--text);font-size:0.95rem;line-height:1.65}
.hero-intro a{color:var(--link)}
.about-phases{margin:0;padding:0;list-style:none}
.about-phases li{padding:0.45rem 0;border-bottom:1px solid var(--border);font-size:0.9rem;color:var(--text)}
.about-phases li:last-child{border-bottom:none}
.about-phases strong{color:var(--ink-strong);letter-spacing:0.04em}
.muted{color:var(--muted)}
.text-success{color:var(--color-success)}
.text-warning{color:var(--color-warning)}
.text-danger{color:var(--color-danger)}
.text-sm{font-size:0.75rem}
.alert-banner{background:var(--surface);border:1px solid var(--border);border-left:4px solid var(--color-warning);border-radius:0 10px 10px 0;padding:1rem 1.5rem;margin-bottom:1.5rem;color:var(--ink);font-size:0.92rem;box-shadow:var(--card-shadow)}
.alert-banner.alert-critical{border-left-color:var(--color-danger)}
.campaign-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(260px,1fr));gap:1.2rem;margin-bottom:2rem}
.campaign-card{background:var(--surface);border:1px solid var(--border);border-radius:10px;padding:1.3rem;box-shadow:var(--card-shadow)}
.campaign-header{display:flex;justify-content:space-between;align-items:center;margin-bottom:0.3rem}
.campaign-header h3{font-size:0.9rem;color:var(--ink-strong);margin:0}
.campaign-ratio{font-size:0.9rem;font-weight:700;color:var(--muted)}
.campaign-desc{font-size:0.75rem;color:var(--muted);margin-bottom:0.6rem}
.campaign-bar{background:var(--surface-2);border-radius:4px;height:8px;overflow:hidden;margin-bottom:0.4rem}
.campaign-bar-fill{height:100%;border-radius:4px;transition:width 0.3s}
.campaign-pct{font-size:0.75rem;color:var(--muted);margin-bottom:0.5rem}
.campaign-repos{font-size:0.75rem;color:var(--muted)}
.campaign-repos a{margin-right:0.4rem}
.theme-toggle{position:fixed;top:14px;right:16px;z-index:80;width:36px;height:36px;border-radius:50%;background:var(--surface);border:1px solid var(--border);color:var(--ink);font-size:1.05rem;cursor:pointer;box-shadow:0 2px 8px rgba(20,15,10,0.18);line-height:1;display:flex;align-items:center;justify-content:center}
.theme-toggle:hover{border-color:var(--link);color:var(--link)}
@media(max-width:900px){.two-col,.three-col,.campaign-grid{grid-template-columns:1fr}}
@media(max-width:600px){
  body{padding:1.25rem 0.9rem}
  h1{font-size:1.55rem;word-break:break-word}
  h2{font-size:1.15rem;margin:2.1rem 0 0.8rem}
  .subtitle{font-size:0.8rem}
  .stat{font-size:1.8rem}
  .grid{grid-template-columns:repeat(auto-fit,minmax(140px,1fr));gap:0.8rem}
  .card{padding:1rem}
  .chart-container{padding:1rem;overflow-x:auto;-webkit-overflow-scrolling:touch}
  .chart-container table{min-width:480px}
  .heatmap{overflow-x:auto;-webkit-overflow-scrolling:touch;padding-bottom:4px}
  .heatmap-labels{overflow-x:auto}
  canvas{max-height:220px}
  .campaign-card{padding:1rem}
  .alert-banner{padding:0.8rem 1rem;font-size:0.85rem}
}
details{margin-bottom:1.5rem}
details summary{cursor:pointer;color:var(--link);font-size:1rem;font-weight:600;padding:0.5rem 0;user-select:none}
details summary:hover{color:var(--link-hover)}
details[open] summary{margin-bottom:1rem}
/* Calm photo hero — the dashboard's headline (calm & adaptive layout) */
.status-hero{position:relative;overflow:hidden;border:1px solid var(--border);border-radius:16px;padding:2.4rem 2.4rem 2rem;margin-bottom:1.6rem;background-image:var(--hero-overlay),url("assets/glencoe.jpg");background-size:cover;background-position:center 42%;box-shadow:0 10px 30px rgba(20,15,10,0.2)}
.status-hero.status-crit{outline:2px solid var(--color-danger);outline-offset:-2px}
.status-top{display:flex;align-items:center;gap:0.75rem;margin-bottom:0.7rem}
.status-dot{width:11px;height:11px;border-radius:50%;flex:0 0 auto;background:var(--color-success);box-shadow:0 0 0 4px var(--hero-dot-ring)}
.status-warn .status-dot{background:var(--color-warning)}
.status-crit .status-dot{background:var(--color-danger)}
.status-headline{font-size:1.95rem;font-weight:600;color:var(--ink-strong);line-height:1.22;text-shadow:var(--hero-text-shadow)}
.status-line{color:var(--ink);font-size:1rem;font-style:italic;line-height:1.55;margin:0 0 1.2rem;text-shadow:var(--hero-text-shadow)}
.status-tiers{display:flex;flex-wrap:wrap;align-items:center;gap:0.45rem;font-size:0.92rem;color:var(--ink);margin-bottom:0.35rem;text-shadow:var(--hero-text-shadow)}
.status-meta{font-size:0.82rem;color:var(--text);text-shadow:var(--hero-text-shadow)}
.status-sep{color:var(--sep)}
.status-vulns-ok{color:var(--color-success)}
.status-vulns-bad{color:var(--color-danger);font-weight:600}
.status-trend{font-weight:600}
.status-trend.up{color:var(--color-success)}
.status-trend.down{color:var(--color-danger)}
/* "Since the last run" delta strip */
.since-block{margin-bottom:1.6rem}
.since-list{list-style:none;margin:0;padding:0;display:flex;flex-direction:column;gap:0.55rem}
.since-item{display:flex;align-items:center;flex-wrap:wrap;gap:0.5rem;background:var(--surface);border:1px solid var(--border);border-left:3px solid var(--sep);border-radius:9px;padding:0.75rem 1.1rem;font-size:0.9rem}
.since-item.since-up{border-left-color:var(--color-success)}
.since-item.since-down{border-left-color:var(--color-danger)}
.since-repo{font-weight:600;color:var(--ink-strong)}
.since-arrow{color:var(--muted)}
.since-note{color:var(--muted)}
.since-empty{color:var(--muted);font-style:italic;background:var(--surface);border:1px solid var(--border);border-radius:9px;padding:0.95rem 1.25rem;margin:0}
@media(max-width:600px){.status-hero{padding:1.5rem 1.3rem}.status-headline{font-size:1.45rem}}
</style>`;

// Shared site-wide footer block. Rendered on every page so any visitor can
// navigate to the architecture, security model, ADRs, and source repo.
export const SITE_FOOTER = `<footer class="site-footer">
<div class="site-footer-links">
<a href="https://github.com/IsmaelMartinez/repo-butler">GitHub repo</a>
<a href="https://github.com/IsmaelMartinez/repo-butler/blob/main/docs/architecture.md">Architecture</a>
<a href="https://github.com/IsmaelMartinez/repo-butler/blob/main/SECURITY.md">Security</a>
<a href="https://github.com/IsmaelMartinez/repo-butler/tree/main/docs/decisions">ADRs</a>
</div>
<div class="site-footer-meta">Built with zero dependencies, Node 24, on GitHub Actions</div>
</footer>`;

// Inline script that restores a persisted theme choice before first paint, so
// a manual light/dark selection doesn't flash the OS-preferred theme on load.
const THEME_INIT = `<script>(function(){try{var t=localStorage.getItem('rb-theme');if(t)document.documentElement.setAttribute('data-theme',t)}catch(e){}})();</script>`;
// The floating light/dark toggle and its handler (persists to localStorage).
const THEME_TOGGLE = `<button class="theme-toggle" type="button" onclick="rbToggleTheme()" aria-label="Toggle light or dark theme" title="Toggle light / dark">◐</button>`;
const THEME_TOGGLE_JS = `<script>function rbToggleTheme(){var d=document.documentElement,m=window.matchMedia&&window.matchMedia('(prefers-color-scheme: dark)').matches,c=d.getAttribute('data-theme')||(m?'dark':'light'),n=c==='dark'?'light':'dark';d.setAttribute('data-theme',n);try{localStorage.setItem('rb-theme',n)}catch(e){}}</script>`;

export { THEME_INIT, THEME_TOGGLE, THEME_TOGGLE_JS };

// Full HTML page shell shared by the portfolio and per-repo reports.
//
// Contract: `body` and `charts` are NOT escaped — callers ensure any
// user-controlled data is already escaped (escHtml) or sanitised. `title` is
// interpolated as-is for the same reason.
//
// Charts render to canvas and cannot read CSS custom properties, so the
// chart-defaults block reads the resolved theme variables once via
// getComputedStyle and applies them to Chart.defaults, keeping axes/grid/labels
// in step with whichever theme is active at load.
export function htmlPage({ title, body, charts }) {
  const chartsBlock = charts
    ? `<script>
var __cs=getComputedStyle(document.documentElement),__gv=function(n){return __cs.getPropertyValue(n).trim()};
Chart.defaults.color=__gv('--muted');Chart.defaults.borderColor=__gv('--sep');Chart.defaults.font.family="-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif";
var __C={danger:__gv('--color-danger'),success:__gv('--color-success'),warning:__gv('--color-warning'),heather:__gv('--link'),line:__gv('--accent-line')};
${charts}
</script>`
    : '';
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="color-scheme" content="light dark">
<title>${title}</title>
${THEME_INIT}
<script src="https://cdn.jsdelivr.net/npm/chart.js@4.4.8/dist/chart.umd.min.js"></script>
${CSS}
</head>
<body>
${THEME_TOGGLE}
${body}
${SITE_FOOTER}
${THEME_TOGGLE_JS}
${chartsBlock}</body></html>`;
}
