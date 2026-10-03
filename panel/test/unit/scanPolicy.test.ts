/**
 * What a scan may move on its own (services/scanPolicy.ts): every cell of the table in
 * docs/security.md, both quarantine settings, and the rules that hold under every setting.
 */
import { describe, expect, it } from 'vitest';
import type { FindingKind, ScanOnFinding } from '../../shared/security.js';
import { MAX_AUTO_QUARANTINE, decideFile, planQuarantine, type PolicyFinding } from '../../src/services/scanPolicy.js';

const HASH = 'a'.repeat(64);
let nextId = 1;
const f = (kind: FindingKind, path: string, opts: Partial<PolicyFinding> = {}): PolicyFinding => ({
  id: nextId++,
  kind,
  confidence: kind === 'signature' ? 'confirmed' : 'suspicious',
  path,
  sha256: HASH,
  ...opts,
});
const decide = (mode: ScanOnFinding, ...found: PolicyFinding[]) => decideFile(found[0]!.path, found, mode).action;
const both = (...found: PolicyFinding[]) => [decide('quarantine-confirmed', ...found), decide('quarantine-all', ...found)];

describe('what may be quarantined automatically', () => {
  it('moves nothing at all when the setting is to report', () => {
    expect(decide('report', f('signature', 'wp-content/uploads/x.php'), f('upload-php', 'wp-content/uploads/x.php'))).toBe('report');
  });

  it('uploads, and extra files among WordPress\'s own: confirmed always, anything else on "everything"', () => {
    for (const path of ['wp-content/uploads/2026/09/x.php', 'wp-includes/js/wp-cache.php', 'wp-admin/css/x.php']) {
      const fact = path.startsWith('wp-content/uploads/') ? f('upload-php', path) : f('core-extra', path);
      expect(both(fact, f('signature', path)), path).toEqual(['move', 'move']);
      expect(both(fact), path).toEqual(['report', 'move']);
    }
    expect(both(f('upload-handler', 'wp-content/uploads/.htaccess'))).toEqual(['report', 'move']);
    // An extra file at the top: the check only calls PHP there extra.
    expect(both(f('core-extra', 'wp-configs.php'))).toEqual(['report', 'move']);
  });

  it('an extra file in a wordpress.org plugin: moved when confirmed, only reported otherwise', () => {
    const path = 'wp-content/plugins/akismet/views/x.php';
    expect(both(f('plugin-extra', path), f('signature', path))).toEqual(['move', 'move']);
    expect(both(f('plugin-extra', path))).toEqual(['report', 'report']);
  });

  it("never moves a package's own file that was changed - that is what Reinstall original is for", () => {
    for (const [kind, path] of [
      ['core-modified', 'wp-includes/functions.php'],
      ['plugin-modified', 'wp-content/plugins/akismet/akismet.php'],
    ] as const) {
      expect(both(f(kind, path), f('signature', path)), path).toEqual(['report', 'report']);
    }
  });

  it('never moves what the site needs to run or sets itself up with, even when it is malware', () => {
    for (const path of ['wp-config.php', 'index.php', '.htaccess', '.user.ini', 'wp-content/mu-plugins/loader.php']) {
      expect(both(f('signature', path), f('core-extra', path)), path).toEqual(['report', 'report']);
    }
  });

  it('never moves on a suspicious-code candidate, a link, a file elsewhere, or a file whose hash it does not know', () => {
    expect(both(f('suspicious', 'wp-content/uploads/x.php', { confidence: 'suspicious' }))).toEqual(['report', 'report']);
    expect(both(f('link-outside', 'wp-content/uploads/notes.txt'), f('signature', 'wp-content/uploads/notes.txt'))).toEqual(['report', 'report']);
    expect(both(f('signature', 'wp-content/themes/flavor/functions.php'))).toEqual(['report', 'report']);
    expect(both(f('signature', 'wp-content/plugins/premium/p.php'))).toEqual(['report', 'report']);
    expect(both(f('signature', 'wp-content/uploads/x.php', { sha256: null }), f('upload-php', 'wp-content/uploads/x.php', { sha256: null }))).toEqual([
      'report',
      'report',
    ]);
  });

  it('says why when it only reports', () => {
    expect(decideFile('wp-config.php', [f('signature', 'wp-config.php')], 'quarantine-all')).toMatchObject({ action: 'report', why: expect.stringMatching(/never moved/) });
    expect(decideFile('wp-content/uploads/x.php', [f('upload-php', 'wp-content/uploads/x.php')], 'quarantine-confirmed')).toMatchObject({
      why: 'Nothing about it is certain enough to move it.',
    });
  });

  it(`moves nothing when more than ${MAX_AUTO_QUARANTINE} files would go`, () => {
    const many = Array.from({ length: MAX_AUTO_QUARANTINE + 1 }, (_, i) => f('signature', `wp-content/uploads/${i}.php`));
    expect(planQuarantine(many, 'quarantine-confirmed')).toEqual({ move: [], overLimit: MAX_AUTO_QUARANTINE + 1 });
    const plan = planQuarantine(many.slice(0, MAX_AUTO_QUARANTINE), 'quarantine-confirmed');
    expect(plan.move).toHaveLength(MAX_AUTO_QUARANTINE);
    expect(plan.overLimit).toBe(0);
  });

  it('decides per file, with every finding about it', () => {
    const plan = planQuarantine(
      [f('upload-php', 'wp-content/uploads/a.php'), f('signature', 'wp-content/uploads/a.php'), f('upload-php', 'wp-content/uploads/b.php')],
      'quarantine-confirmed',
    );
    expect(plan.move.map((m) => [m.path, m.findingIds.length, m.reason])).toEqual([['wp-content/uploads/a.php', 2, 'Known malware']]);
  });
});
