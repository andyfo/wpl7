import { describe, expect, it } from 'vitest';
import {
  LEVEL_PRESETS,
  countOverrides,
  customRulesSchema,
  effectivePolicy,
  hasOverrides,
  regexProblem,
  securityOverridesSchema,
  withRuleIds,
  type CustomRule,
  type FleetSecurity,
  type SecurityOverrides,
} from '../../shared/security.js';
import { makeWorld } from '../helpers.js';

const fleet = (level: FleetSecurity['level'] = 'standard', overrides: SecurityOverrides = {}): FleetSecurity => ({ level, overrides });
const site = (level: FleetSecurity['level'] | null = null, overrides: SecurityOverrides = {}, customRules: CustomRule[] = []) => ({
  level,
  overrides,
  customRules,
});

describe('effectivePolicy', () => {
  it('gives a site that follows the default the fleet level and the fleet changes', () => {
    const p = effectivePolicy(fleet('standard', { limits: { login: { average: 5, burst: 5, per: 'minute' } } }), site());
    expect(p.level).toBe('standard');
    expect(p.levelFrom).toBe('fleet');
    expect(p.limits.login).toEqual({ average: 5, burst: 5, per: 'minute' });
    expect(p.sources['limits.login']).toBe('fleet');
    // Everything else as the level has it, and says so by saying nothing.
    expect(p.limits.requests).toEqual(LEVEL_PRESETS.standard.limits.requests);
    expect(p.sources['limits.requests']).toBeUndefined();
  });

  it("puts the site's own changes on top of the fleet's", () => {
    const p = effectivePolicy(
      fleet('standard', { rules: { enum: false }, headers: { hsts: true } }),
      site(null, { rules: { enum: true }, limits: { login: null } }),
    );
    expect(p.rules.enum).toBe(true);
    expect(p.sources['rules.enum']).toBe('site');
    expect(p.headers.hsts).toBe(true);
    expect(p.sources['headers.hsts']).toBe('fleet');
    expect(p.limits.login).toBeNull();
  });

  it('ignores the fleet changes for a site that chose its own level', () => {
    const p = effectivePolicy(fleet('standard', { rules: { files: false } }), site('strict'));
    expect(p.level).toBe('strict');
    expect(p.levelFrom).toBe('site');
    expect(p.rules.files).toBe(true);
    expect(p.xmlrpc).toBe('deny');
    expect(p.container.disallowFileMods).toBe(true);
  });

  it('keeps Off off, whatever is changed on top of it', () => {
    for (const p of [
      effectivePolicy(fleet('off', { rules: { files: true } }), site(null, { limits: { login: { average: 1, burst: 1, per: 'minute' } } })),
      effectivePolicy(fleet('strict'), site('off', { rules: { uploads: true }, container: { blockPhpInUploads: true } })),
    ]) {
      expect(p.level).toBe('off');
      expect(Object.values(p.rules).some(Boolean)).toBe(false);
      expect(Object.values(p.limits).some(Boolean)).toBe(false);
      expect(Object.values(p.container).some(Boolean)).toBe(false);
    }
  });

  it('has no XML-RPC limit unless XML-RPC is limited', () => {
    expect(effectivePolicy(fleet('standard'), site(null, { xmlrpc: 'deny' })).limits.xmlrpc).toBeNull();
    expect(effectivePolicy(fleet('standard'), site(null, { xmlrpc: 'allow' })).limits.xmlrpc).toBeNull();
    expect(effectivePolicy(fleet('strict'), site(null)).limits.xmlrpc).toBeNull();
    expect(effectivePolicy(fleet('standard'), site(null)).limits.xmlrpc).toEqual(LEVEL_PRESETS.standard.limits.xmlrpc);
  });

  it('never changes the presets it starts from', () => {
    const before = JSON.stringify(LEVEL_PRESETS);
    effectivePolicy(fleet('standard', { limits: { login: null }, rules: { files: false } }), site(null, { headers: { hsts: true } }));
    expect(JSON.stringify(LEVEL_PRESETS)).toBe(before);
  });

  it('matches the levels the plan describes', () => {
    expect(LEVEL_PRESETS.standard.limits).toEqual({
      login: { average: 20, burst: 2, per: 'minute' },
      xmlrpc: { average: 30, burst: 2, per: 'minute' },
      requests: { average: 50, burst: 500, per: 'second' },
      assets: { average: 200, burst: 4000, per: 'second' },
    });
    expect(LEVEL_PRESETS.strict.limits.login).toEqual({ average: 6, burst: 2, per: 'minute' });
    expect(LEVEL_PRESETS.standard.wpcron).toBe('allow');
    expect(LEVEL_PRESETS.strict.wpcron).toBe('deny');
    expect(LEVEL_PRESETS.standard.headers).toEqual({ nosniff: true, frameOptions: false, hsts: false, referrerPolicy: false });
  });
});

describe('overrides', () => {
  it('accept single rules and limits, and nothing unknown', () => {
    expect(securityOverridesSchema.safeParse({ rules: { files: false }, limits: { login: null } }).success).toBe(true);
    expect(securityOverridesSchema.safeParse({ rules: { nope: true } }).success).toBe(false);
    expect(securityOverridesSchema.safeParse({ limits: { login: { average: 0, burst: 1, per: 'minute' } } }).success).toBe(false);
    expect(securityOverridesSchema.safeParse({ extra: 1 }).success).toBe(false);
  });

  it('know an empty change from a real one', () => {
    expect(hasOverrides({})).toBe(false);
    expect(hasOverrides({ rules: {} })).toBe(false);
    expect(hasOverrides({ rules: { files: false } })).toBe(true);
    expect(hasOverrides({ limits: { login: null } })).toBe(true);
  });

  it('count what a change changes, a limit taken away included', () => {
    expect(countOverrides({})).toBe(0);
    expect(countOverrides({ rules: {} })).toBe(0);
    expect(countOverrides({ rules: { files: false, enum: false }, xmlrpc: 'deny', limits: { login: null }, headers: { hsts: true } })).toBe(5);
  });
});

describe('custom rules', () => {
  const rule = (conditions: unknown[], extra: Record<string, unknown> = {}) => ({ action: 'block', conditions, ...extra });

  it('take the conditions each field supports', () => {
    const ok = customRulesSchema.safeParse([
      rule([{ field: 'path', op: 'startsWith', value: '/private/' }]),
      rule([
        { field: 'userAgent', op: 'contains', value: 'BadBot' },
        { field: 'method', op: 'is', value: 'POST' },
      ], { match: 'any' }),
      rule([{ field: 'query', name: 'action', op: 'is', value: 'revslider_show_image' }]),
      rule([{ field: 'query', name: 'debug', op: 'present' }]),
      rule([{ field: 'address', op: 'is', value: '198.51.100.0/24', negate: true }], { action: 'allow' }),
      rule([{ field: 'path', op: 'matches', value: '(?i)^/old-[0-9]+/' }]),
    ]);
    expect(ok.success, JSON.stringify(ok.error?.issues)).toBe(true);
  });

  it('refuse what Traefik could not read or would read differently', () => {
    for (const conditions of [
      [{ field: 'path', op: 'is', value: 'no-slash' }],
      [{ field: 'path', op: 'contains', value: 'a`b' }],
      [{ field: 'userAgent', op: 'contains', value: '{{ .Env }}' }],
      [{ field: 'path', op: 'contains', value: 'line\nbreak' }],
      [{ field: 'method', op: 'is', value: 'TRACE' }],
      [{ field: 'method', op: 'contains', value: 'GET' }],
      [{ field: 'query', op: 'is', value: 'x' }],
      [{ field: 'path', name: 'x', op: 'is', value: '/x' }],
      [{ field: 'address', op: 'is', value: '10.0.0.0/4' }],
      [{ field: 'address', op: 'is', value: 'example.com' }],
      [{ field: 'path', op: 'matches', value: '^/(?=admin)' }],
      [{ field: 'path', op: 'matches', value: '([a-z]+)\\1' }],
      [{ field: 'path', op: 'matches', value: '[unclosed' }],
      [{ field: 'path', op: 'is', value: '' }],
      [],
    ]) {
      expect(customRulesSchema.safeParse([rule(conditions)]).success, JSON.stringify(conditions)).toBe(false);
    }
  });

  it('keep ids unique and give one to a rule that has none', () => {
    expect(customRulesSchema.safeParse([rule([{ field: 'method', op: 'is', value: 'GET' }], { id: 'a1' }), rule([{ field: 'method', op: 'is', value: 'GET' }], { id: 'a1' })]).success).toBe(false);
    const parsed = customRulesSchema.parse([
      rule([{ field: 'method', op: 'is', value: 'GET' }], { id: 'keep' }),
      rule([{ field: 'method', op: 'is', value: 'PUT' }]),
      rule([{ field: 'method', op: 'is', value: 'PUT' }]),
    ]);
    const ids = ['keep', 'keep', 'fresh1', 'fresh2'];
    const withIds = withRuleIds(parsed, () => ids.shift()!);
    expect(withIds.map((r) => r.id)).toEqual(['keep', 'fresh1', 'fresh2']);
  });

  it('allow at most thirty rules of eight conditions', () => {
    const one = { field: 'method', op: 'is', value: 'GET' };
    expect(customRulesSchema.safeParse(Array.from({ length: 31 }, () => rule([one]))).success).toBe(false);
    expect(customRulesSchema.safeParse([rule(Array.from({ length: 9 }, () => one))]).success).toBe(false);
  });

  it('check regular expressions the way RE2 would see them', () => {
    expect(regexProblem('(?i)^/wp-admin')).toBeNull();
    expect(regexProblem('(?<!x)y')).toMatch(/Lookaround/);
  });
});

describe('seeded defaults', () => {
  it('protect every site at Standard, block automatically and scan daily', async () => {
    const w = await makeWorld();
    const s = w.deps.settings.getAll();
    expect(s.securityLevel).toBe('standard');
    expect(s.securityAutoBlock).toBe('on');
    expect(s.securityEnforcement).toBe(true);
    expect(s.securityBypassPrivate).toBe(true);
    expect(s.securityRules.login).toEqual({ enabled: true, threshold: 20, windowMin: 10 });
    expect(s.scanEnabled).toBe(true);
    expect(s.scanIntervalHours).toBe(24);
    expect(s.scanOnFinding).toBe('report');
    expect(s.securityTrustedProxies).toEqual({ cloudflare: true, custom: [] });
  });
});
