import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const PKG_ROOT = resolve(__dirname, '..');
const SKILLS_DIR = join(PKG_ROOT, 'skills');
const MANIFEST = JSON.parse(readFileSync(join(PKG_ROOT, 'package.json'), 'utf8'));
const INSTALLER_REL = MANIFEST.bin['kugelaudio-skills'];
// Resolved from the manifest, not hardcoded: a `bin` pointing at a path that
// does not exist breaks `npx kugelaudio-skills` for every user, and the #1910
// restructure rewrote this to `tools/scripts/` without moving the directory.
const INSTALLER = resolve(PKG_ROOT, INSTALLER_REL);
// The canonical copies live in the monorepo's packages/private, which the public
// mirror of this package and its npm tarball do not have.
const PRIVATE_DIR = resolve(PKG_ROOT, '..', '..', 'private');
const CANONICAL_DIR = join(PRIVATE_DIR, 'tools', 'agent-skills');
const SYNC = 'packages/private/tools/agent-skills/sync.sh';

const skillDirs = (root: string) =>
  readdirSync(root, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && existsSync(join(root, entry.name, 'SKILL.md')))
    .map((entry) => entry.name)
    .sort();

const skillNames = () =>
  readdirSync(SKILLS_DIR, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name);

const run = (...args: string[]) =>
  execFileSync(process.execPath, [INSTALLER, ...args], { encoding: 'utf8' });

describe('bundled agent skills', () => {
  it('gives every skill frontmatter whose name matches its directory', () => {
    for (const name of skillNames()) {
      const text = readFileSync(join(SKILLS_DIR, name, 'SKILL.md'), 'utf8');
      expect(text.startsWith('---\n')).toBe(true);
      const frontmatter = text.split('---')[1];
      expect(frontmatter).toContain(`name: ${name}`);
      expect(frontmatter).toContain('description:');
    }
  });

  it.skipIf(!existsSync(PRIVATE_DIR))('ships exactly the canonical skills, unchanged', () => {
    expect(existsSync(CANONICAL_DIR), `no canonical skills at ${CANONICAL_DIR}`).toBe(true);
    expect(
      skillNames().sort(),
      `the bundled skills differ from the canonical ones; run ${SYNC}`,
    ).toEqual(skillDirs(CANONICAL_DIR));
    for (const name of skillNames()) {
      expect(
        readFileSync(join(SKILLS_DIR, name, 'SKILL.md'), 'utf8'),
        `${name} is out of sync; run ${SYNC}`,
      ).toBe(readFileSync(join(CANONICAL_DIR, name, 'SKILL.md'), 'utf8'));
    }
  });
});

describe('kugelaudio-skills installer', () => {
  it('has a bin path that exists and is shipped in the tarball', () => {
    expect(existsSync(INSTALLER), `bin points at missing ${INSTALLER_REL}`).toBe(true);
    const shipped = INSTALLER_REL.replace(/^\.\//, '');
    expect(MANIFEST.files, `files must include ${shipped} or the bin is absent`).toContain(
      shipped,
    );
  });

  it('copies skills into the destination', () => {
    const dest = mkdtempSync(join(tmpdir(), 'ka-skills-'));
    run('install', '--dest', dest);
    for (const name of skillNames()) {
      expect(existsSync(join(dest, name, 'SKILL.md'))).toBe(true);
    }
  });

  it('does not overwrite an existing skill without --force', () => {
    const dest = mkdtempSync(join(tmpdir(), 'ka-skills-'));
    run('install', '--dest', dest);
    const target = join(dest, 'kugelaudio-tts', 'SKILL.md');
    writeFileSync(target, 'edited by the user');

    run('install', '--dest', dest);
    expect(readFileSync(target, 'utf8')).toBe('edited by the user');

    run('install', '--dest', dest, '--force');
    expect(readFileSync(target, 'utf8')).not.toBe('edited by the user');
  });

  it('rejects unknown arguments instead of silently ignoring them', () => {
    expect(() => run('install', '--nope')).toThrow();
  });
});
