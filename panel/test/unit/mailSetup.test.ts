import { describe, expect, it } from 'vitest';
import { mergeSpf, planDomainSteps, RDNS_GUIDES, spfLookupCount, type PlanInput } from '../../src/services/mailSetup.js';
import type { MailRecordCheck } from '../../shared/types.js';

const check = (verdict: MailRecordCheck['verdict'], found: string | null = null): MailRecordCheck => ({
  verdict,
  found,
  detail: '',
});

describe('mergeSpf', () => {
  it('creates a record when the domain has none', () => {
    const merged = mergeSpf(null, ['ip4:203.0.113.9']);
    expect(merged).toMatchObject({ record: 'v=spf1 ip4:203.0.113.9 ~all', action: 'create' });
  });

  it('keeps an existing provider include and adds ours before the all term', () => {
    // The case that matters: a customer on Microsoft 365 whose mail must keep working.
    const merged = mergeSpf('v=spf1 include:spf.protection.outlook.com -all', ['ip4:203.0.113.9']);
    expect(merged.action).toBe('merge');
    expect(merged.record).toBe('v=spf1 include:spf.protection.outlook.com ip4:203.0.113.9 -all');
  });

  it('appends when the record has no all term', () => {
    const merged = mergeSpf('v=spf1 include:example.test', ['ip4:203.0.113.9']);
    expect(merged.record).toBe('v=spf1 include:example.test ip4:203.0.113.9');
  });

  it('adds every missing server on a fleet, in order, and only the missing ones', () => {
    const merged = mergeSpf('v=spf1 ip4:203.0.113.9 ~all', ['ip4:203.0.113.9', 'ip4:198.51.100.4']);
    expect(merged.record).toBe('v=spf1 ip4:203.0.113.9 ip4:198.51.100.4 ~all');
  });

  it('leaves a record that already authorizes us completely alone', () => {
    const existing = 'v=spf1 mx ip4:203.0.113.9 include:other.test ~all';
    const merged = mergeSpf(existing, ['ip4:203.0.113.9']);
    expect(merged).toMatchObject({ action: 'unchanged', record: existing });
  });

  it('treats a qualified mechanism as already present', () => {
    // `+ip4:x` and `ip4:x` authorize the same thing; adding both would be noise.
    const merged = mergeSpf('v=spf1 +ip4:203.0.113.9 -all', ['ip4:203.0.113.9']);
    expect(merged.action).toBe('unchanged');
  });

  it('treats an explicit denial as a conflict, not as already authorized', () => {
    // `-ip4:x` actively rejects this server. Stripping the qualifier made it look identical
    // to `ip4:x`, so the step reported "already authorized" while SPF was failing - and
    // silently flipping someone's deliberate denial to an authorization is not a merge.
    const merged = mergeSpf('v=spf1 -ip4:203.0.113.9 -all', ['ip4:203.0.113.9']);
    expect(merged.action).toBe('conflict');
    expect(merged.record).toBe('v=spf1 -ip4:203.0.113.9 -all');
    expect(merged.detail).toMatch(/explicitly denies ip4:203\.0\.113\.9/);
  });

  it('treats softfail and neutral qualifiers as conflicts too', () => {
    for (const qualifier of ['~', '?']) {
      const merged = mergeSpf(`v=spf1 ${qualifier}ip4:203.0.113.9 -all`, ['ip4:203.0.113.9']);
      expect(merged.action, qualifier).toBe('conflict');
    }
  });

  it('refuses to touch a TXT record that is not SPF', () => {
    const merged = mergeSpf('google-site-verification=abc123', ['ip4:203.0.113.9']);
    expect(merged.action).toBe('conflict');
    expect(merged.record).toBe('google-site-verification=abc123');
  });

  it('preserves redirect= and exp= terms it does not understand', () => {
    const merged = mergeSpf('v=spf1 redirect=_spf.example.test', ['ip4:203.0.113.9']);
    expect(merged.record).toContain('redirect=_spf.example.test');
    expect(merged.record).toContain('ip4:203.0.113.9');
  });
});

describe('spfLookupCount', () => {
  it('counts only the mechanisms that cost a DNS query', () => {
    expect(spfLookupCount('v=spf1 ip4:1.2.3.4 ip6:::1 -all')).toBe(0);
    expect(spfLookupCount('v=spf1 a mx include:x.test exists:y.test ptr ~all')).toBe(5);
    expect(spfLookupCount('v=spf1 a:mail.test/24 ~all')).toBe(1);
  });
});

function input(overrides: Partial<PlanInput> = {}): PlanInput {
  return {
    domain: 'acme.test',
    mode: 'direct',
    serverIps: ['203.0.113.9'],
    spf: check('missing'),
    dkim: check('missing'),
    dmarc: check('missing'),
    dkimKey: null,
    dnsManaged: false,
    ...overrides,
  };
}

describe('planDomainSteps', () => {
  it('orders the steps so DMARC comes after what it enforces', () => {
    // A p=reject published before SPF and DKIM pass filters the customer's own mail.
    expect(planDomainSteps(input()).map((s) => s.id)).toEqual(['spf', 'dkim', 'dmarc']);
  });

  it('offers to publish everything when the panel can write the zone', () => {
    const steps = planDomainSteps(input({ dnsManaged: true }));
    expect(steps.map((s) => s.automation.state)).toEqual(['ready', 'ready', 'ready']);
    expect(steps[0]!.automation.plannedValue).toBe('v=spf1 ip4:203.0.113.9 ~all');
  });

  it('falls back to copy-paste values when there is no DNS token', () => {
    const steps = planDomainSteps(input({ dnsManaged: false }));
    expect(steps.every((s) => s.automation.state === 'manual')).toBe(true);
    // The value is still offered - manual must not mean "work it out yourself".
    expect(steps[0]!.automation.plannedValue).toBe('v=spf1 ip4:203.0.113.9 ~all');
    expect(steps[2]!.automation.plannedValue).toContain('v=DMARC1');
  });

  it('never proposes an SPF record for a smarthost, whose value only the provider knows', () => {
    const steps = planDomainSteps(input({ mode: 'smarthost', dnsManaged: true }));
    expect(steps[0]!.automation.state).toBe('manual');
    expect(steps[0]!.automation.detail).toMatch(/provider/i);
    // Never offer `v=spf1 ~all` as something to copy - it authorizes nobody, so pasting it
    // is strictly worse than having no record at all.
    expect(steps[0]!.record.value).not.toBe('v=spf1 ~all');
    expect(steps[0]!.record.value).toContain('<your SMTP provider>');
  });

  it('shows a smarthost domain the record it already publishes, not a template over the top', () => {
    const published = 'v=spf1 include:mailgun.org ~all';
    const steps = planDomainSteps(input({ mode: 'smarthost', spf: check('ok', published) }));
    expect(steps[0]!.record.value).toBe(published);
  });

  it('asks for the server IP rather than suggesting an SPF record that authorizes nobody', () => {
    const steps = planDomainSteps(input({ dnsManaged: true, serverIps: [] }));
    expect(steps[0]!.automation.state).toBe('manual');
    expect(steps[0]!.automation.detail).toMatch(/no public IP recorded/);
    expect(steps[0]!.record.value).not.toBe('v=spf1 ~all');
  });

  it('leaves an existing DMARC policy alone rather than weakening it', () => {
    // Overwriting p=reject with our starter p=none would quietly undo a deliberate choice.
    const steps = planDomainSteps(
      input({ dnsManaged: true, dmarc: check('ok', 'v=DMARC1; p=reject; rua=mailto:d@acme.test') }),
    );
    const dmarc = steps.find((s) => s.id === 'dmarc')!;
    expect(dmarc.automation.state).toBe('satisfied');
    expect(dmarc.automation.plannedValue).toBeNull();
  });

  it('does not call a denied server "done", and offers a way out', () => {
    const steps = planDomainSteps(
      input({ dnsManaged: true, spf: check('error', 'v=spf1 -ip4:203.0.113.9 -all') }),
    );
    expect(steps[0]!.automation.state).toBe('manual');
    expect(steps[0]!.automation.detail).toMatch(/denies/);
  });

  it('does not call a DMARC record with no policy tag done', () => {
    // Receivers ignore a record without p=, so "published" is not "working". Marking it
    // satisfied let the whole domain report ready while DMARC did nothing.
    const broken = check('error', 'v=DMARC1; rua=mailto:d@acme.test');
    broken.detail = 'DMARC record has no p= policy tag and will be ignored';
    const steps = planDomainSteps(input({ dnsManaged: true, dmarc: broken }));
    const dmarc = steps.find((s) => s.id === 'dmarc')!;
    expect(dmarc.automation.state).toBe('manual');
    expect(dmarc.automation.detail).toMatch(/no p= policy tag/);
    // Still never overwritten - it is someone's record, however broken.
    expect(dmarc.automation.plannedValue).toBeNull();
  });

  it('accepts a weak but usable DMARC policy as done', () => {
    const steps = planDomainSteps(input({ dnsManaged: true, dmarc: check('warn', 'v=DMARC1; p=none') }));
    expect(steps.find((s) => s.id === 'dmarc')!.automation.state).toBe('satisfied');
  });

  it('reports an SPF record that already authorizes the fleet as done', () => {
    const steps = planDomainSteps(input({ dnsManaged: true, spf: check('ok', 'v=spf1 ip4:203.0.113.9 ~all') }));
    expect(steps[0]!.automation.state).toBe('satisfied');
  });

  it('refuses an SPF merge that would blow the 10-lookup limit', () => {
    const crowded = `v=spf1 ${Array.from({ length: 11 }, (_, i) => `include:i${i}.test`).join(' ')} ~all`;
    const steps = planDomainSteps(input({ dnsManaged: true, spf: check('warn', crowded) }));
    expect(steps[0]!.automation.state).toBe('manual');
    expect(steps[0]!.automation.detail).toMatch(/10 DNS lookups/);
  });

  it('plans to generate the key when DKIM has none yet', () => {
    const steps = planDomainSteps(input({ dnsManaged: true }));
    const dkim = steps.find((s) => s.id === 'dkim')!;
    expect(dkim.automation.state).toBe('ready');
    expect(dkim.automation.detail).toMatch(/generates a signing key/i);
    expect(dkim.record.name).toBe('wpl7._domainkey.acme.test');
  });

  it('plans to replace a stale published key', () => {
    const steps = planDomainSteps(
      input({ dnsManaged: true, dkimKey: { selector: 'wpl7', publicKeyB64: 'AAAB' }, dkim: check('error', 'v=DKIM1; p=OLD') }),
    );
    const dkim = steps.find((s) => s.id === 'dkim')!;
    expect(dkim.automation.state).toBe('ready');
    expect(dkim.automation.plannedValue).toBe('v=DKIM1; h=sha256; k=rsa; p=AAAB');
  });

  it('explains why each step matters, so the guide is not a wall of record values', () => {
    for (const step of planDomainSteps(input())) {
      expect(step.why.length).toBeGreaterThan(20);
      expect(step.title).toContain('—');
    }
  });
});

describe('RDNS_GUIDES', () => {
  it('covers the providers this platform is actually deployed on, plus a fallback', () => {
    const ids = RDNS_GUIDES.map((g) => g.id);
    expect(ids).toContain('hetzner-cloud');
    expect(ids).toContain('other');
    expect(RDNS_GUIDES.every((g) => g.steps.length >= 2)).toBe(true);
  });
});
