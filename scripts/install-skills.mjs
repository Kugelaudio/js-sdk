#!/usr/bin/env node
/**
 * Install the agent skills bundled with this package into an agent's skills
 * directory, so coding agents pick up KugelAudio guidance automatically.
 *
 *   npx kugelaudio-skills install            -> ./.claude/skills/<name>/
 *   npx kugelaudio-skills install --global   -> ~/.claude/skills/<name>/
 *   npx kugelaudio-skills install --dest DIR -> DIR/<name>/
 *   npx kugelaudio-skills list
 */
import { cpSync, existsSync, mkdirSync, readdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const SKILLS_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'skills');

function fail(message) {
  console.error(`kugelaudio-skills: ${message}`);
  process.exit(1);
}

function bundledSkills() {
  if (!existsSync(SKILLS_DIR)) {
    fail(`no skills directory in this package (looked in ${SKILLS_DIR}). Reinstall kugelaudio.`);
  }
  const names = readdirSync(SKILLS_DIR, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name);
  if (names.length === 0) fail(`no skills found in ${SKILLS_DIR}.`);
  return names;
}

function parseArgs(argv) {
  const args = { command: 'install', dest: null, global: false, force: false };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === 'install' || arg === 'list') args.command = arg;
    else if (arg === '--global' || arg === '-g') args.global = true;
    else if (arg === '--force' || arg === '-f') args.force = true;
    else if (arg === '--dest') {
      args.dest = argv[++i];
      if (!args.dest) fail('--dest needs a directory.');
    } else if (arg === '--help' || arg === '-h') args.command = 'help';
    else fail(`unknown argument '${arg}'. Try --help.`);
  }
  return args;
}

const args = parseArgs(process.argv.slice(2));
const skills = bundledSkills();

if (args.command === 'help') {
  console.log(
    'Usage: kugelaudio-skills install [--global] [--dest DIR] [--force]\n' +
      '       kugelaudio-skills list\n\n' +
      'Copies the bundled agent skills into .claude/skills/ (or --dest).',
  );
  process.exit(0);
}

if (args.command === 'list') {
  console.log(skills.join('\n'));
  process.exit(0);
}

const destRoot = args.dest
  ? resolve(args.dest)
  : args.global
    ? join(homedir(), '.claude', 'skills')
    : resolve('.claude', 'skills');

// A skills directory that didn't exist when the agent started isn't being
// watched yet, so a brand-new one needs a restart before the skill appears.
const destRootExisted = existsSync(destRoot);
mkdirSync(destRoot, { recursive: true });

let installed = 0;
for (const name of skills) {
  const target = join(destRoot, name);
  if (existsSync(target) && !args.force) {
    console.log(`skipped ${name} — already at ${target} (use --force to overwrite)`);
    continue;
  }
  cpSync(join(SKILLS_DIR, name), target, { recursive: true });
  console.log(`installed ${name} -> ${target}`);
  installed++;
}

if (installed > 0) {
  console.log(
    destRootExisted
      ? '\nClaude Code picks up skills added to a watched skills directory without a restart.'
      : `\nCreated ${destRoot}. If the skill doesn't show up, restart Claude Code once so it watches the new directory.`,
  );
}
