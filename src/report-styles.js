// CSS styles shared by all report HTML generators.

export const CSS = `<style>
*{margin:0;padding:0;box-sizing:border-box}
body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,monospace;background:#0d1117;color:#e6edf3;padding:2rem;max-width:1400px;margin:0 auto}
h1{font-size:1.8rem;margin-bottom:0.3rem;color:#f0f6fc}
h1 .repo-link{color:#f0f6fc;text-decoration:none}
h1 .repo-link svg{vertical-align:middle;fill:#8b949e}
h1 .repo-link:hover svg{fill:#e6edf3}
h2{font-size:1.2rem;margin:2.5rem 0 1rem;color:#7ee787;border-bottom:1px solid #21262d;padding-bottom:0.5rem}
.subtitle{color:#8b949e;font-size:0.9rem;margin-bottom:2rem}
.subtitle a{color:#58a6ff}
.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(200px,1fr));gap:1.2rem;margin-bottom:2rem}
.card{background:#161b22;border:1px solid #21262d;border-radius:8px;padding:1.2rem}
.card h3{font-size:0.8rem;color:#8b949e;margin-bottom:0.3rem;text-transform:uppercase;letter-spacing:0.05em}
.stat{font-size:2.2rem;font-weight:700;color:#f0f6fc}
.stat-sm{font-size:1.4rem}
.stat-label{color:#8b949e;font-size:0.8rem}
.chart-container{background:#161b22;border:1px solid #21262d;border-radius:8px;padding:1.5rem;margin-bottom:1.5rem}
.chart-title{font-size:0.95rem;color:#e6edf3;margin-bottom:1rem}
.two-col{display:grid;grid-template-columns:1fr 1fr;gap:1.5rem}
.three-col{display:grid;grid-template-columns:1fr 1fr 1fr;gap:1.5rem}
canvas{max-height:300px}
table{width:100%;border-collapse:collapse;font-size:0.85rem}
th{text-align:left;color:#8b949e;padding:0.6rem;border-bottom:1px solid #21262d}
td{padding:0.6rem;border-bottom:1px solid #21262d}
tr:hover{background:#1c2128}
a{color:#58a6ff;text-decoration:none}
.badge{display:inline-block;padding:0.15rem 0.5rem;border-radius:12px;font-size:0.7rem;font-weight:600}
.badge-active{background:#238636;color:#f0f6fc}
.badge-dormant{background:#da3633;color:#f0f6fc}
.badge-archive{background:#6e7681;color:#f0f6fc}
.badge-fork{background:#1f6feb;color:#f0f6fc}
.badge-test{background:#8957e5;color:#f0f6fc}
.tier-badge{display:inline-block;padding:0.15rem 0.5rem;border-radius:12px;font-size:0.7rem;font-weight:600}
.tier-gold{background:#ffd700;color:#1a1a00}.tier-silver{background:#c0c0c0;color:#1a1a1a}.tier-bronze{background:#cd7f32;color:#1a0a00}.tier-none{background:#30363d;color:#8b949e}
.heatmap{display:grid;gap:2px;grid-auto-rows:12px}
.heatmap-cell{width:12px;height:12px;border-radius:2px}
.heatmap-labels{display:grid;gap:2px;margin-top:4px;font-size:0.6rem;color:#8b949e}
.heatmap-labels span{text-align:center;white-space:nowrap}
.footer{text-align:center;color:#6e7681;font-size:0.8rem;margin-top:3rem;padding:1rem}
.alert-banner{background:#161b22;border-left:4px solid #d29922;border-radius:0 8px 8px 0;padding:1rem 1.5rem;margin-bottom:1.5rem;color:#e6edf3;font-size:0.9rem}
.alert-banner.alert-critical{border-color:#f85149}
.campaign-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(260px,1fr));gap:1.2rem;margin-bottom:2rem}
.campaign-card{background:#161b22;border:1px solid #21262d;border-radius:8px;padding:1.2rem}
.campaign-header{display:flex;justify-content:space-between;align-items:center;margin-bottom:0.3rem}
.campaign-header h3{font-size:0.9rem;color:#f0f6fc;margin:0}
.campaign-ratio{font-size:0.9rem;font-weight:700;color:#8b949e}
.campaign-desc{font-size:0.75rem;color:#8b949e;margin-bottom:0.6rem}
.campaign-bar{background:#21262d;border-radius:4px;height:8px;overflow:hidden;margin-bottom:0.4rem}
.campaign-bar-fill{height:100%;border-radius:4px;transition:width 0.3s}
.campaign-pct{font-size:0.75rem;color:#8b949e;margin-bottom:0.5rem}
.campaign-repos{font-size:0.75rem;color:#8b949e}
.campaign-repos a{margin-right:0.4rem}
@media(max-width:900px){.two-col,.three-col,.campaign-grid{grid-template-columns:1fr}}
details{margin-bottom:1.5rem}
details summary{cursor:pointer;color:#58a6ff;font-size:1rem;font-weight:600;padding:0.5rem 0;user-select:none}
details summary:hover{color:#79c0ff}
details[open] summary{margin-bottom:1rem}
</style>`;
