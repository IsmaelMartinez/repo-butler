#!/usr/bin/env node
// check-skills.js — report whether the repo-butler skills that are actually
// running are current with origin/main. See #350: the registry entries are
// symlinks into a checkout's working tree, so the live skill is whatever that
// checkout happens to be, and nothing used to say so.
//
// The script reports on the checkout it lives in, which — invoked through the
// registry symlink — is by construction the checkout the live skill comes from:
//
//   node ~/.claude/skills/repo-butler/../../scripts/check-skills.js
//
// Usage:
//   node scripts/check-skills.js               # human-readable report
//   node scripts/check-skills.js --headline    # one line, for a skill to render
//   node scripts/check-skills.js --json        # full reading
//   node scripts/check-skills.js --skills-dir DIR
//
// Exit: 0 when there is nothing to report, 1 when there is, 2 on a usage error.
// Reports, never fetches — the same rule the MCP staleness envelope follows.

import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { inspectSkillCheckout } from '../src/skill-staleness.js';

const CHECKOUT = join(dirname(fileURLToPath(import.meta.url)), '..');

function usage(stream = process.stdout) {
  stream.write([
    'Usage: node scripts/check-skills.js [--headline|--json] [--skills-dir DIR]',
    '',
    'Reports whether the installed repo-butler skills are current with origin/main.',
    'Exit 0 when there is nothing to report, 1 when there is.',
    '',
  ].join('\n'));
}

const args = process.argv.slice(2);
// Null rather than a relative path when HOME is unset: a bare `.claude/skills`
// would resolve against whatever directory the caller happened to be in and
// report every skill `absent`, which reads as a finding rather than as "not
// checked". inspectSkillCheckout skips install classification on null.
let skillsDir = process.env.HOME ? join(process.env.HOME, '.claude', 'skills') : null;
let format = 'report';

while (args.length) {
  const arg = args.shift();
  if (arg === '--json') format = 'json';
  else if (arg === '--headline') format = 'headline';
  else if (arg === '--skills-dir') {
    skillsDir = args.shift();
    if (!skillsDir) {
      process.stderr.write('Error: --skills-dir requires an argument\n');
      process.exit(2);
    }
  } else if (arg === '-h' || arg === '--help') {
    usage();
    process.exit(0);
  } else {
    process.stderr.write(`Unknown argument: ${arg}\n`);
    usage(process.stderr);
    process.exit(2);
  }
}

const result = inspectSkillCheckout(CHECKOUT, { skillsDir });

if (format === 'json') {
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
} else if (format === 'headline') {
  process.stdout.write(`${result.headline}\n`);
} else {
  process.stdout.write(`repo-butler skills — ${result.checkout || 'checkout not found'}\n`);
  process.stdout.write(`  ${result.headline}\n`);
  for (const install of result.installs) {
    process.stdout.write(`  ${install.name}: ${install.status}\n`);
  }
  if (result.warnings.length) {
    process.stdout.write('\n');
    for (const warning of result.warnings) process.stdout.write(`  ! ${warning}\n`);
  }
}

process.exit(result.current ? 0 : 1);
