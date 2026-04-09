# Astro Integration Stream 2: Personal Website Changes

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a portfolio health dashboard page to ismaelmartinez.me.uk that consumes repo-butler snapshot data at build time.

**Architecture:** A new `/{lang}/health` page with pure Astro components, zero JavaScript shipped. Data fetched at build time from `raw.githubusercontent.com`, validated with Zod. The site's existing CSS design system is used throughout. A daily cron rebuild keeps data fresh.

**Tech Stack:** Astro 5.18, TypeScript, Zod (already a dependency via Astro), Vitest.

**Spec:** `docs/superpowers/specs/2026-04-08-astro-dashboard-integration-design.md` (in repo-butler repo)

**Depends on:** Stream 1 being deployed (enriched snapshot with computed tiers). Can be developed against a sample fixture.

**Working directory:** `/Users/ismael.martinez/projects/github/ismaelmartinez.me.uk`

---

## File Map

| File | Action | Responsibility |
|------|--------|----------------|
| `src/data/health.ts` | Create | Fetch and validate portfolio snapshot data at build time |
| `src/components/TierPulse.astro` | Create | Headline tier distribution display |
| `src/components/HealthTable.astro` | Create | Per-repo health metrics table |
| `src/components/HealthCard.astro` | Create | Mobile card view for a single repo |
| `src/components/Sparkline.astro` | Create | Inline SVG sparkline from weekly data |
| `src/components/PortfolioHealthBadge.astro` | Create | Small badge for projects page |
| `src/pages/[lang]/health.astro` | Create | Health dashboard page |
| `src/pages/[lang]/projects.astro` | Modify | Add PortfolioHealthBadge |
| `src/i18n/translations.ts` | Modify | Add health.* translations for all 3 locales |
| `src/layouts/Layout.astro` | Modify | Add Health nav link |
| `src/styles/global.css` | Modify | Add tier colour custom properties |
| `.github/workflows/gh-pages.yml` | Modify | Add daily cron schedule trigger |
| `tests/build/output.test.ts` | Modify | Verify health pages exist in build output |
| `tests/data/health.test.ts` | Create | Unit tests for data fetching and validation |

---

### Task 1: Add tier colour CSS custom properties

**Files:**
- Modify: `src/styles/global.css`

- [ ] **Step 1: Add tier colours to the `:root` block**

In `src/styles/global.css`, add after the existing `--color-border` line (line 11):

```css
  /* Health tier colours */
  --color-tier-gold: #ffd700;
  --color-tier-silver: #c0c0c0;
  --color-tier-bronze: #cd7f32;
  --color-tier-none: #525252;
  --color-success: #22c55e;
  --color-warning: #eab308;
  --color-danger: #ef4444;
```

- [ ] **Step 2: Verify the dev server shows no errors**

Run: `npm run dev` (briefly, then Ctrl+C)
Expected: no CSS errors.

- [ ] **Step 3: Commit**

```bash
git add src/styles/global.css
git commit -m "feat: add tier colour CSS custom properties for health dashboard"
```

---

### Task 2: Add i18n translations for health page

**Files:**
- Modify: `src/i18n/translations.ts`

- [ ] **Step 1: Add English translations**

In the `en:` section of `translations`, add after the last entry:

```typescript
    // Health
    'nav.health': 'Health',
    'health.title': 'Portfolio Health',
    'health.description': 'Health status across all open source repositories, powered by Repo Butler',
    'health.pulse.gold': 'Gold',
    'health.pulse.silver': 'Silver',
    'health.pulse.bronze': 'Bronze',
    'health.pulse.repos': 'repos',
    'health.pulse.active': 'active',
    'health.pulse.dormant': 'dormant/archive',
    'health.table.repo': 'Repo',
    'health.table.tier': 'Tier',
    'health.table.issues': 'Issues',
    'health.table.ci': 'CI%',
    'health.table.vulns': 'Vulns',
    'health.table.nextStep': 'Next Step',
    'health.table.allPass': 'All checks pass',
    'health.table.showAll': 'Show all metrics',
    'health.unavailable': 'Health data is currently unavailable. Visit the',
    'health.unavailable.link': 'standalone dashboard',
    'health.badge.label': 'Portfolio Health',
```

- [ ] **Step 2: Add Spanish translations**

In the `es:` section:

```typescript
    // Health
    'nav.health': 'Salud',
    'health.title': 'Salud del Portfolio',
    'health.description': 'Estado de salud de todos los repositorios de código abierto, con Repo Butler',
    'health.pulse.gold': 'Oro',
    'health.pulse.silver': 'Plata',
    'health.pulse.bronze': 'Bronce',
    'health.pulse.repos': 'repos',
    'health.pulse.active': 'activos',
    'health.pulse.dormant': 'inactivos/archivo',
    'health.table.repo': 'Repo',
    'health.table.tier': 'Nivel',
    'health.table.issues': 'Issues',
    'health.table.ci': 'CI%',
    'health.table.vulns': 'Vulns',
    'health.table.nextStep': 'Siguiente Paso',
    'health.table.allPass': 'Todos los checks pasan',
    'health.table.showAll': 'Mostrar todas las métricas',
    'health.unavailable': 'Los datos de salud no están disponibles. Visita el',
    'health.unavailable.link': 'dashboard independiente',
    'health.badge.label': 'Salud del Portfolio',
```

- [ ] **Step 3: Add Catalan translations**

In the `cat:` section:

```typescript
    // Health
    'nav.health': 'Salut',
    'health.title': 'Salut del Portfolio',
    'health.description': 'Estat de salut de tots els repositoris de codi obert, amb Repo Butler',
    'health.pulse.gold': 'Or',
    'health.pulse.silver': 'Plata',
    'health.pulse.bronze': 'Bronze',
    'health.pulse.repos': 'repos',
    'health.pulse.active': 'actius',
    'health.pulse.dormant': 'inactius/arxiu',
    'health.table.repo': 'Repo',
    'health.table.tier': 'Nivell',
    'health.table.issues': 'Issues',
    'health.table.ci': 'CI%',
    'health.table.vulns': 'Vulns',
    'health.table.nextStep': 'Proper Pas',
    'health.table.allPass': 'Tots els checks passen',
    'health.table.showAll': 'Mostrar totes les mètriques',
    'health.unavailable': 'Les dades de salut no estan disponibles. Visita el',
    'health.unavailable.link': 'dashboard independent',
    'health.badge.label': 'Salut del Portfolio',
```

- [ ] **Step 4: Run i18n tests**

Run: `npx vitest run tests/i18n/translations.test.ts`
Expected: PASS (all keys present across all locales).

- [ ] **Step 5: Commit**

```bash
git add src/i18n/translations.ts
git commit -m "feat: add health dashboard i18n translations for all 3 locales"
```

---

### Task 3: Create data fetching module

**Files:**
- Create: `src/data/health.ts`
- Create: `tests/data/health.test.ts`

- [ ] **Step 1: Write the unit tests**

Create `tests/data/health.test.ts`:

```typescript
import { describe, it, expect, vi } from 'vitest';
import { parsePortfolioSnapshot, type PortfolioHealth } from '../src/data/health';

const validSnapshot = {
  schema_version: 'v1' as const,
  repos: {
    'test-repo': {
      open_issues: 3,
      open_bugs: 1,
      commits_6mo: 50,
      stars: 10,
      license: 'MIT',
      communityHealth: 85,
      ciPassRate: 0.95,
      vulns: { count: 0, max_severity: null },
      codeScanning: null,
      secretScanning: { count: 0 },
      ci: 4,
      released_at: '2026-03-01T00:00:00Z',
      pushed_at: '2026-04-01T00:00:00Z',
      computed: {
        tier: 'gold' as const,
        checks: [{ name: 'Has CI workflows (2+)', passed: true, required_for: 'gold' }],
        next_step: null,
      },
    },
  },
};

describe('parsePortfolioSnapshot', () => {
  it('parses valid snapshot data', () => {
    const result = parsePortfolioSnapshot(validSnapshot);
    expect(result.available).toBe(true);
    expect(result.repos).toHaveLength(1);
    expect(result.repos[0].name).toBe('test-repo');
    expect(result.repos[0].tier).toBe('gold');
    expect(result.goldPct).toBe(100);
  });

  it('returns fallback for null input', () => {
    const result = parsePortfolioSnapshot(null);
    expect(result.available).toBe(false);
    expect(result.repos).toHaveLength(0);
  });

  it('returns fallback for invalid schema_version', () => {
    const result = parsePortfolioSnapshot({ schema_version: 'v99', repos: {} });
    expect(result.available).toBe(false);
  });

  it('returns fallback for missing computed field', () => {
    const snapshot = {
      schema_version: 'v1' as const,
      repos: { 'a': { ...validSnapshot.repos['test-repo'], computed: undefined } },
    };
    const result = parsePortfolioSnapshot(snapshot);
    expect(result.available).toBe(true);
    expect(result.repos[0].tier).toBe('none');
  });

  it('computes tier distribution correctly', () => {
    const snapshot = {
      schema_version: 'v1' as const,
      repos: {
        a: { ...validSnapshot.repos['test-repo'], computed: { tier: 'gold' as const, checks: [], next_step: null } },
        b: { ...validSnapshot.repos['test-repo'], computed: { tier: 'silver' as const, checks: [], next_step: 'Has a license' } },
        c: { ...validSnapshot.repos['test-repo'], computed: { tier: 'gold' as const, checks: [], next_step: null } },
      },
    };
    const result = parsePortfolioSnapshot(snapshot);
    expect(result.tierCounts.gold).toBe(2);
    expect(result.tierCounts.silver).toBe(1);
    expect(result.goldPct).toBe(67);
    expect(result.repos).toHaveLength(3);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/data/health.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Create src/data/health.ts**

```typescript
import { z } from 'zod';

const ComputedSchema = z.object({
  tier: z.enum(['gold', 'silver', 'bronze', 'none']),
  checks: z.array(z.object({
    name: z.string(),
    passed: z.boolean(),
    required_for: z.string(),
  })).optional().default([]),
  next_step: z.string().nullable(),
}).optional();

const RepoHealthSchema = z.object({
  open_issues: z.number().default(0),
  open_bugs: z.number().nullable().default(null),
  commits_6mo: z.number().default(0),
  stars: z.number().default(0),
  license: z.string().nullable().default(null),
  communityHealth: z.number().nullable().default(null),
  ciPassRate: z.number().nullable().default(null),
  vulns: z.object({ count: z.number(), max_severity: z.string().nullable() }).nullable().default(null),
  ci: z.number().default(0),
  pushed_at: z.string().nullable().default(null),
  computed: ComputedSchema,
}).passthrough();

const SnapshotSchema = z.object({
  schema_version: z.literal('v1'),
  repos: z.record(RepoHealthSchema),
}).passthrough();

export interface RepoHealth {
  name: string;
  tier: 'gold' | 'silver' | 'bronze' | 'none';
  nextStep: string | null;
  openIssues: number;
  stars: number;
  ciPassRate: number | null;
  vulns: { count: number; max_severity: string | null } | null;
  license: string | null;
  communityHealth: number | null;
  commits: number;
}

export interface PortfolioHealth {
  available: boolean;
  lastUpdated: string | null;
  repos: RepoHealth[];
  tierCounts: { gold: number; silver: number; bronze: number; none: number };
  goldPct: number;
  totalRepos: number;
}

const FALLBACK: PortfolioHealth = {
  available: false,
  lastUpdated: null,
  repos: [],
  tierCounts: { gold: 0, silver: 0, bronze: 0, none: 0 },
  goldPct: 0,
  totalRepos: 0,
};

export function parsePortfolioSnapshot(data: unknown): PortfolioHealth {
  if (!data) return FALLBACK;

  const parsed = SnapshotSchema.safeParse(data);
  if (!parsed.success) return FALLBACK;

  const { repos } = parsed.data;
  const tierCounts = { gold: 0, silver: 0, bronze: 0, none: 0 };

  const repoList: RepoHealth[] = Object.entries(repos)
    .map(([name, r]) => {
      const tier = r.computed?.tier ?? 'none';
      tierCounts[tier]++;
      return {
        name,
        tier,
        nextStep: r.computed?.next_step ?? null,
        openIssues: r.open_issues,
        stars: r.stars,
        ciPassRate: r.ciPassRate,
        vulns: r.vulns,
        license: r.license,
        communityHealth: r.communityHealth,
        commits: r.commits_6mo,
      };
    })
    .sort((a, b) => b.commits - a.commits);

  const totalRepos = repoList.length;
  const goldPct = totalRepos > 0 ? Math.round((tierCounts.gold / totalRepos) * 100) : 0;

  return {
    available: true,
    lastUpdated: new Date().toISOString(),
    repos: repoList,
    tierCounts,
    goldPct,
    totalRepos,
  };
}

function currentWeekKey(): string {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() + 4 - (d.getUTCDay() || 7));
  const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
  const weekNo = Math.ceil(((d.getTime() - yearStart.getTime()) / 86400000 + 1) / 7);
  return `${d.getUTCFullYear()}-W${String(weekNo).padStart(2, '0')}`;
}

function previousWeekKey(): string {
  const d = new Date();
  d.setDate(d.getDate() - 7);
  d.setUTCDate(d.getUTCDate() + 4 - (d.getUTCDay() || 7));
  const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
  const weekNo = Math.ceil(((d.getTime() - yearStart.getTime()) / 86400000 + 1) / 7);
  return `${d.getUTCFullYear()}-W${String(weekNo).padStart(2, '0')}`;
}

const BASE_URL = 'https://raw.githubusercontent.com/IsmaelMartinez/repo-butler/repo-butler-data/snapshots/portfolio-weekly';

export async function fetchPortfolioHealth(): Promise<PortfolioHealth> {
  for (const weekKey of [currentWeekKey(), previousWeekKey()]) {
    try {
      const res = await fetch(`${BASE_URL}/${weekKey}.json`);
      if (!res.ok) continue;
      const data = await res.json();
      return parsePortfolioSnapshot(data);
    } catch {
      continue;
    }
  }
  return FALLBACK;
}
```

- [ ] **Step 4: Run tests**

Run: `npx vitest run tests/data/health.test.ts`
Expected: all pass.

- [ ] **Step 5: Commit**

```bash
git add src/data/health.ts tests/data/health.test.ts
git commit -m "feat: add health data fetching module with Zod validation"
```

---

### Task 4: Create Astro components

**Files:**
- Create: `src/components/Sparkline.astro`
- Create: `src/components/TierPulse.astro`
- Create: `src/components/HealthTable.astro`
- Create: `src/components/HealthCard.astro`
- Create: `src/components/PortfolioHealthBadge.astro`

- [ ] **Step 1: Create Sparkline.astro**

```astro
---
interface Props {
  data: number[];
  width?: number;
  height?: number;
}

const { data, width = 80, height = 20 } = Astro.props;
const padding = 2;

function buildPath(values: number[]): string {
  if (!values || values.length === 0) return '';
  const max = Math.max(...values);
  if (max === 0) {
    const y = height - padding;
    return `M0,${y} L${width},${y}`;
  }
  const h = height - padding * 2;
  const step = width / (values.length - 1);
  return values.map((v, i) => {
    const x = Math.round(i * step * 100) / 100;
    const y = Math.round((padding + h - (v / max) * h) * 100) / 100;
    return `${i === 0 ? 'M' : 'L'}${x},${y}`;
  }).join(' ');
}

const path = buildPath(data);
---

{data && data.length > 0 && (
  <svg width={width} height={height} viewBox={`0 0 ${width} ${height}`} xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
    <path d={path} fill="none" stroke="var(--color-accent)" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" />
  </svg>
)}
```

- [ ] **Step 2: Create TierPulse.astro**

```astro
---
import type { PortfolioHealth } from '../data/health';

interface Props {
  health: PortfolioHealth;
  t: (key: string) => string;
}

const { health, t } = Astro.props;

const tierEntries = (['gold', 'silver', 'bronze', 'none'] as const)
  .filter(tier => health.tierCounts[tier] > 0)
  .map(tier => ({ tier, count: health.tierCounts[tier], label: t(`health.pulse.${tier}`) }));

const goldColor = health.goldPct >= 80 ? 'var(--color-success)' : health.goldPct >= 50 ? 'var(--color-warning)' : 'var(--color-danger)';
---

<div class="tier-pulse card">
  <div class="pulse-headline" style={`color: ${goldColor}`}>{health.goldPct}% {t('health.pulse.gold')}</div>
  <div class="pulse-badges">
    {tierEntries.map(({ tier, count, label }) => (
      <span class={`tier-badge tier-${tier}`}>{count} {label}</span>
    ))}
  </div>
  <div class="pulse-summary">{health.totalRepos} {t('health.pulse.repos')}</div>
</div>

<style>
  .tier-pulse {
    text-align: center;
    padding: var(--space-xl);
  }

  .pulse-headline {
    font-size: 2.5rem;
    font-weight: 700;
    margin-bottom: var(--space-sm);
  }

  .pulse-badges {
    display: flex;
    justify-content: center;
    gap: var(--space-sm);
    margin-bottom: var(--space-sm);
    flex-wrap: wrap;
  }

  .tier-badge {
    display: inline-block;
    padding: 0.15rem 0.6rem;
    border-radius: 12px;
    font-size: 0.75rem;
    font-weight: 600;
  }

  .tier-gold { background: var(--color-tier-gold); color: #1a1a00; }
  .tier-silver { background: var(--color-tier-silver); color: #1a1a1a; }
  .tier-bronze { background: var(--color-tier-bronze); color: #1a0a00; }
  .tier-none { background: var(--color-border); color: var(--color-text-muted); }

  .pulse-summary {
    color: var(--color-text-muted);
    font-size: 0.875rem;
  }
</style>
```

- [ ] **Step 3: Create HealthCard.astro (mobile card)**

```astro
---
import type { RepoHealth } from '../data/health';

interface Props {
  repo: RepoHealth;
  t: (key: string) => string;
}

const { repo, t } = Astro.props;
---

<article class="health-card card">
  <div class="card-header">
    <a href={`https://github.com/IsmaelMartinez/${repo.name}`} target="_blank" rel="noopener noreferrer" class="repo-name">{repo.name}</a>
    <span class={`tier-badge tier-${repo.tier}`}>{t(`health.pulse.${repo.tier}`)}</span>
  </div>
  {repo.nextStep && (
    <p class="next-step">{repo.nextStep}</p>
  )}
  {!repo.nextStep && (
    <p class="all-pass">{t('health.table.allPass')}</p>
  )}
</article>

<style>
  .health-card {
    padding: var(--space-md);
  }

  .card-header {
    display: flex;
    justify-content: space-between;
    align-items: center;
    gap: var(--space-sm);
  }

  .repo-name {
    font-weight: 600;
    font-size: 0.95rem;
  }

  .tier-badge {
    display: inline-block;
    padding: 0.15rem 0.6rem;
    border-radius: 12px;
    font-size: 0.7rem;
    font-weight: 600;
    white-space: nowrap;
  }

  .tier-gold { background: var(--color-tier-gold); color: #1a1a00; }
  .tier-silver { background: var(--color-tier-silver); color: #1a1a1a; }
  .tier-bronze { background: var(--color-tier-bronze); color: #1a0a00; }
  .tier-none { background: var(--color-border); color: var(--color-text-muted); }

  .next-step {
    color: var(--color-text-muted);
    font-size: 0.8rem;
    margin-top: var(--space-xs);
  }

  .all-pass {
    color: var(--color-success);
    font-size: 0.8rem;
    margin-top: var(--space-xs);
  }
</style>
```

- [ ] **Step 4: Create HealthTable.astro (desktop table)**

```astro
---
import type { RepoHealth } from '../data/health';
import HealthCard from './HealthCard.astro';

interface Props {
  repos: RepoHealth[];
  t: (key: string) => string;
}

const { repos, t } = Astro.props;

function ciColor(rate: number | null): string {
  if (rate == null) return 'var(--color-text-muted)';
  return rate >= 0.9 ? 'var(--color-success)' : rate >= 0.7 ? 'var(--color-warning)' : 'var(--color-danger)';
}

function vulnColor(vulns: { count: number; max_severity: string | null } | null): string {
  if (!vulns) return 'var(--color-text-muted)';
  if (vulns.count === 0) return 'var(--color-success)';
  return vulns.max_severity === 'critical' || vulns.max_severity === 'high' ? 'var(--color-danger)' : 'var(--color-warning)';
}
---

<!-- Mobile: card layout -->
<div class="health-cards">
  {repos.map(repo => (
    <HealthCard repo={repo} t={t} />
  ))}
</div>

<!-- Desktop: table layout -->
<div class="health-table-wrap">
  <table class="health-table">
    <thead>
      <tr>
        <th>{t('health.table.repo')}</th>
        <th>{t('health.table.tier')}</th>
        <th>{t('health.table.issues')}</th>
        <th>{t('health.table.ci')}</th>
        <th>{t('health.table.vulns')}</th>
        <th>{t('health.table.nextStep')}</th>
      </tr>
    </thead>
    <tbody>
      {repos.map(repo => (
        <tr>
          <td>
            <a href={`https://github.com/IsmaelMartinez/${repo.name}`} target="_blank" rel="noopener noreferrer">{repo.name}</a>
          </td>
          <td><span class={`tier-badge tier-${repo.tier}`}>{t(`health.pulse.${repo.tier}`)}</span></td>
          <td>{repo.openIssues}</td>
          <td style={`color: ${ciColor(repo.ciPassRate)}`}>{repo.ciPassRate != null ? `${Math.round(repo.ciPassRate * 100)}%` : '—'}</td>
          <td style={`color: ${vulnColor(repo.vulns)}`}>{repo.vulns ? repo.vulns.count : 'n/a'}</td>
          <td class="next-step-cell">{repo.nextStep ?? t('health.table.allPass')}</td>
        </tr>
      ))}
    </tbody>
  </table>
</div>

<style>
  .health-cards {
    display: grid;
    grid-template-columns: 1fr;
    gap: var(--space-md);
  }

  .health-table-wrap {
    display: none;
  }

  @media (min-width: 768px) {
    .health-cards {
      display: none;
    }

    .health-table-wrap {
      display: block;
      background: var(--color-bg-secondary);
      border: 1px solid var(--color-border);
      border-radius: 8px;
      overflow-x: auto;
    }
  }

  .health-table {
    width: 100%;
    border-collapse: collapse;
    font-size: 0.85rem;
  }

  .health-table th {
    text-align: left;
    color: var(--color-text-muted);
    padding: 0.6rem 0.8rem;
    border-bottom: 1px solid var(--color-border);
    font-weight: 600;
    font-size: 0.75rem;
    text-transform: uppercase;
    letter-spacing: 0.05em;
  }

  .health-table td {
    padding: 0.6rem 0.8rem;
    border-bottom: 1px solid var(--color-border);
  }

  .health-table tr:hover {
    background: var(--color-bg);
  }

  .health-table a {
    font-weight: 500;
  }

  .tier-badge {
    display: inline-block;
    padding: 0.15rem 0.6rem;
    border-radius: 12px;
    font-size: 0.7rem;
    font-weight: 600;
  }

  .tier-gold { background: var(--color-tier-gold); color: #1a1a00; }
  .tier-silver { background: var(--color-tier-silver); color: #1a1a1a; }
  .tier-bronze { background: var(--color-tier-bronze); color: #1a0a00; }
  .tier-none { background: var(--color-border); color: var(--color-text-muted); }

  .next-step-cell {
    color: var(--color-text-muted);
    font-size: 0.8rem;
  }
</style>
```

- [ ] **Step 5: Create PortfolioHealthBadge.astro**

```astro
---
import type { PortfolioHealth } from '../data/health';
import { getLocalizedPath } from '../i18n/translations';

interface Props {
  health: PortfolioHealth;
  lang: 'en' | 'es' | 'cat';
  t: (key: string) => string;
}

const { health, lang, t } = Astro.props;
---

{health.available && (
  <a href={getLocalizedPath('/health', lang)} class="health-badge">
    <span class="badge-label">{t('health.badge.label')}</span>
    <span class="badge-value">{health.totalRepos} repos · {health.goldPct}% {t('health.pulse.gold')}</span>
  </a>
)}

<style>
  .health-badge {
    display: inline-flex;
    align-items: center;
    gap: var(--space-sm);
    padding: var(--space-xs) var(--space-md);
    background: var(--color-bg-secondary);
    border: 1px solid var(--color-border);
    border-radius: 20px;
    font-size: 0.8rem;
    transition: border-color 0.2s ease;
    text-decoration: none;
  }

  .health-badge:hover {
    border-color: var(--color-accent);
  }

  .badge-label {
    color: var(--color-text-muted);
  }

  .badge-value {
    color: var(--color-tier-gold);
    font-weight: 600;
  }
</style>
```

- [ ] **Step 6: Commit**

```bash
git add src/components/Sparkline.astro src/components/TierPulse.astro src/components/HealthTable.astro src/components/HealthCard.astro src/components/PortfolioHealthBadge.astro
git commit -m "feat: add health dashboard Astro components"
```

---

### Task 5: Create the health page

**Files:**
- Create: `src/pages/[lang]/health.astro`

- [ ] **Step 1: Create the page**

```astro
---
import Layout from '../../layouts/Layout.astro';
import TierPulse from '../../components/TierPulse.astro';
import HealthTable from '../../components/HealthTable.astro';
import { useTranslations, locales } from '../../i18n/translations';
import type { Locale } from '../../i18n/translations';
import { fetchPortfolioHealth } from '../../data/health';

export function getStaticPaths() {
  return locales.map(lang => ({ params: { lang } }));
}

const lang = Astro.params.lang as Locale;
const t = useTranslations(lang);
const health = await fetchPortfolioHealth();
---

<Layout title={t('health.title')} description={t('health.description')} lang={lang}>
  <section class="section">
    <div class="container">
      <header class="page-header">
        <h1 class="page-title">{t('health.title')}</h1>
        <p class="page-description">{t('health.description')}</p>
      </header>

      {health.available ? (
        <>
          <TierPulse health={health} t={t} />
          <HealthTable repos={health.repos} t={t} />
        </>
      ) : (
        <div class="unavailable card">
          <p>{t('health.unavailable')} <a href="https://ismaelmartinez.github.io/repo-butler/" target="_blank" rel="noopener noreferrer">{t('health.unavailable.link')}</a>.</p>
        </div>
      )}
    </div>
  </section>
</Layout>

<style>
  .page-header {
    margin-bottom: var(--space-2xl);
  }

  .page-title {
    font-size: 2rem;
    font-weight: 700;
    margin-bottom: var(--space-md);
  }

  .page-description {
    font-size: 1.125rem;
    color: var(--color-text-muted);
    max-width: 600px;
  }

  .unavailable {
    text-align: center;
    padding: var(--space-2xl);
    color: var(--color-text-muted);
  }
</style>
```

- [ ] **Step 2: Build the site**

Run: `npm run build`
Expected: build succeeds, `dist/en/health/index.html` exists.

- [ ] **Step 3: Commit**

```bash
git add src/pages/\[lang\]/health.astro
git commit -m "feat: add health dashboard page"
```

---

### Task 6: Add nav link and projects page badge

**Files:**
- Modify: `src/layouts/Layout.astro:102-103`
- Modify: `src/pages/[lang]/projects.astro`

- [ ] **Step 1: Add Health nav link**

In `src/layouts/Layout.astro`, after the Projects nav link (line 102), add:

```html
<li><a href={getLocalizedPath('/health', lang)} aria-current={currentPath === '/health' ? 'page' : undefined}>{t('nav.health')}</a></li>
```

- [ ] **Step 2: Add PortfolioHealthBadge to projects page**

In `src/pages/[lang]/projects.astro`, add the import and badge:

```astro
---
import Layout from '../../layouts/Layout.astro';
import ProjectCard from '../../components/ProjectCard.astro';
import PortfolioHealthBadge from '../../components/PortfolioHealthBadge.astro';
import { useTranslations, locales } from '../../i18n/translations';
import type { Locale } from '../../i18n/translations';
import { projects } from '../../data/projects';
import { fetchPortfolioHealth } from '../../data/health';

export function getStaticPaths() {
  return locales.map(lang => ({ params: { lang } }));
}

const lang = Astro.params.lang as Locale;
const t = useTranslations(lang);
const health = await fetchPortfolioHealth();
---

<Layout title="Projects" lang={lang}>
  <section class="section">
    <div class="container">
      <header class="page-header">
        <h1 class="page-title">{t('section.projects')}</h1>
        <p class="page-description">{t('section.projects.description')}</p>
        <div class="badge-row">
          <PortfolioHealthBadge health={health} lang={lang} t={t} />
        </div>
      </header>
      <div class="grid grid-2">
        {projects.map(project => (
          <ProjectCard project={project} lang={lang} />
        ))}
      </div>
    </div>
  </section>
</Layout>
```

Add the `.badge-row` style:

```css
.badge-row {
  margin-top: var(--space-md);
}
```

- [ ] **Step 3: Build and verify**

Run: `npm run build`
Expected: build succeeds, nav shows Health link, projects page has the badge.

- [ ] **Step 4: Commit**

```bash
git add src/layouts/Layout.astro src/pages/\[lang\]/projects.astro
git commit -m "feat: add Health nav link and portfolio badge on projects page"
```

---

### Task 7: Add build output tests and daily cron

**Files:**
- Modify: `tests/build/output.test.ts`
- Modify: `.github/workflows/gh-pages.yml`

- [ ] **Step 1: Add health page build test**

In `tests/build/output.test.ts`, in the `pages` array inside the `locale pages exist` describe block (line 14), add `'health/index.html'`:

```typescript
const pages = ['index.html', 'about/index.html', 'connect/index.html', 'projects/index.html', 'writing/index.html', 'uses/index.html', 'tags/index.html', 'health/index.html'];
```

- [ ] **Step 2: Add daily cron to gh-pages.yml**

In `.github/workflows/gh-pages.yml`, add the schedule trigger:

```yaml
on:
  schedule:
    - cron: '0 3 * * *'
  workflow_run:
    workflows: ["CI"]
    types:
      - completed
    branches:
      - main
```

- [ ] **Step 3: Run build and tests**

Run: `npm run build && npx vitest run`
Expected: all tests pass including the new health page existence check.

- [ ] **Step 4: Commit**

```bash
git add tests/build/output.test.ts .github/workflows/gh-pages.yml
git commit -m "feat: add health page build test and daily cron rebuild"
```
