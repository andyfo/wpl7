/**
 * Turning "your mail is not authenticated" into an ordered list of things to do, and
 * working out which of them the panel can do by itself.
 *
 * The delicate part is SPF. A customer domain very often already has a record — Microsoft
 * 365, Google Workspace, a newsletter tool — and replacing it would silently break mail
 * this platform never sent. So SPF is *merged*: our mechanisms are inserted into the record
 * that is already published, everything else is preserved, and the result is shown before
 * anything is written.
 *
 * Everything here is pure. `MailService` does the DNS reads and writes.
 */
// @docs mail/records, mail/setup
import type { MailRecordCheck, MailSetupStep, MailStepAutomation } from '../../shared/types.js';
import { dkimRecordName, dkimRecordValue } from './mailDkim.js';
import { suggestedDmarc } from './mailDns.js';

// ---------------------------------------------------------------------------
// SPF merging

export interface SpfMerge {
  /** The record to publish. Equal to the existing one when nothing needs to change. */
  record: string;
  action: 'create' | 'merge' | 'unchanged' | 'conflict';
  /** What the change does, in one sentence. */
  detail: string;
}

/** `v=spf1 a mx include:x -all` -> ['a', 'mx', 'include:x', '-all'] */
const spfTerms = (record: string): string[] => record.trim().split(/\s+/).slice(1).filter(Boolean);

const isAllTerm = (term: string): boolean => /^[+\-~?]?all$/i.test(term);

/** The mechanism without its qualifier: `-ip4:1.2.3.4` -> `ip4:1.2.3.4`. */
const bareMechanism = (term: string): string =>
  ('+-~?'.includes(term[0] ?? '') ? term.slice(1) : term).toLowerCase();

/**
 * The qualifier decides what a match *means*, so it cannot be ignored when asking whether a
 * mechanism is already covered: `+ip4:x` authorizes that sender, while `-ip4:x` explicitly
 * denies it and `~ip4:x` softfails it. An absent qualifier is `+`.
 */
const qualifierOf = (term: string): string => ('+-~?'.includes(term[0] ?? '') ? term[0]! : '+');

/**
 * Add `mechanisms` to an SPF record without disturbing what is already there.
 *
 * New mechanisms go immediately before the `all` term, because SPF is first-match-wins and
 * anything after `all` is dead. A record with no `all` gets them appended.
 */
export function mergeSpf(existing: string | null, mechanisms: string[]): SpfMerge {
  const wanted = mechanisms.filter(Boolean);

  if (!existing) {
    if (wanted.length === 0) {
      return { record: 'v=spf1 ~all', action: 'create', detail: 'Publishes an SPF record' };
    }
    return {
      record: `v=spf1 ${wanted.join(' ')} ~all`,
      action: 'create',
      detail: `Publishes an SPF record authorizing ${wanted.join(', ')}`,
    };
  }

  const trimmed = existing.trim();
  if (!/^v=spf1(\s|$)/i.test(trimmed)) {
    return { record: trimmed, action: 'conflict', detail: 'The published record is not an SPF record' };
  }

  const terms = spfTerms(trimmed);
  // A mechanism that is present but denied (`-ip4:…`) is not "already handled" - the record
  // is actively rejecting this server. Flipping someone's explicit denial to an
  // authorization is not a merge, so that needs a human rather than a silent rewrite.
  const denied = wanted.filter((m) =>
    terms.some((t) => bareMechanism(t) === bareMechanism(m) && qualifierOf(t) !== '+'),
  );
  if (denied.length > 0) {
    return {
      record: trimmed,
      action: 'conflict',
      detail: `The published record explicitly denies ${denied.join(', ')}; remove that qualifier first if this server should be allowed to send`,
    };
  }
  const missing = wanted.filter((m) => !terms.some((t) => bareMechanism(t) === bareMechanism(m)));
  if (missing.length === 0) {
    return { record: trimmed, action: 'unchanged', detail: 'The published record already authorizes this server' };
  }

  const allIndex = terms.findIndex(isAllTerm);
  const merged = allIndex === -1 ? [...terms, ...missing] : [...terms.slice(0, allIndex), ...missing, ...terms.slice(allIndex)];
  return {
    record: `v=spf1 ${merged.join(' ')}`,
    action: 'merge',
    detail: `Adds ${missing.join(', ')} to the existing record, keeping ${terms.filter((t) => !isAllTerm(t)).length} mechanism(s) already there`,
  };
}

/**
 * DNS-querying mechanisms in a record. Receivers give up at 10 and treat the record as
 * permerror, so a merge that would push it over is worth refusing rather than discovering
 * later; `ip4:`/`ip6:` are free, which is why direct-mode entries are always safe to add.
 */
export function spfLookupCount(record: string): number {
  return spfTerms(record).filter((t) => /^[+\-~?]?(a|mx|include|exists|ptr)(:|\/|$)/i.test(t)).length;
}

/**
 * The SPF mechanisms this fleet needs authorized. Shared by the planner and the writer so a
 * preview and the record actually published can never be computed differently.
 */
export function spfMechanismsFor(mode: 'smarthost' | 'direct', serverIps: string[]): string[] {
  // Only direct delivery has mechanisms the panel can name: with a smarthost the value
  // belongs to the provider, and with no recorded IP there is nothing to authorize.
  return mode === 'direct' ? serverIps.map((ip) => `ip4:${ip}`) : [];
}

// ---------------------------------------------------------------------------
// Step planning

const ready = (plannedValue: string, detail: string): MailStepAutomation => ({ state: 'ready', plannedValue, detail });
const satisfied = (detail: string): MailStepAutomation => ({ state: 'satisfied', plannedValue: null, detail });
const manual = (plannedValue: string | null, detail: string): MailStepAutomation => ({ state: 'manual', plannedValue, detail });

export interface PlanInput {
  domain: string;
  /** 'direct' lists our server IPs in SPF; a smarthost's record comes from the provider. */
  mode: 'smarthost' | 'direct';
  serverIps: string[];
  spf: MailRecordCheck;
  dkim: MailRecordCheck;
  dmarc: MailRecordCheck;
  dkimKey: { selector: string; publicKeyB64: string } | null;
  /** True when the panel holds an API token that can write this zone. */
  dnsManaged: boolean;
}

/**
 * The ordered setup for one sending domain. Order matters: DMARC tells receivers to act on
 * SPF and DKIM failures, so publishing it first — before the other two pass — is how you
 * send your own customer's mail to the spam folder.
 */
export function planDomainSteps(input: PlanInput): MailSetupStep[] {
  const { domain, mode, serverIps, dnsManaged } = input;

  // ----- SPF
  //
  // Only direct delivery has mechanisms the panel can name. With a smarthost the value
  // belongs to the provider, and with no recorded server IP there is nothing to authorize -
  // in both cases `mergeSpf` would happily produce `v=spf1 ~all`, a record that authorizes
  // nobody. Offering that as a value to copy is strictly worse than offering none, so those
  // two cases carry a template (or whatever is already published) instead.
  const canNameSenders = mode === 'direct' && serverIps.length > 0;
  const merge = mergeSpf(input.spf.found, canNameSenders ? spfMechanismsFor(mode, serverIps) : []);
  const spfValue = canNameSenders ? merge.record : (input.spf.found ?? 'v=spf1 include:<your SMTP provider> ~all');
  const overBudget = spfLookupCount(merge.record) > 10;
  const spfAutomation: MailStepAutomation =
    mode === 'smarthost'
      ? manual(
          null,
          'Your SMTP provider publishes the value to use — add it by hand.',
        )
      : !canNameSenders
        ? manual(
            null,
            'This server has no public IP recorded — set it on the Servers page first.',
          )
        : merge.action === 'unchanged'
          ? satisfied(merge.detail)
          : merge.action === 'conflict'
            // `conflict` covers two different problems - a TXT record that is not SPF at
            // all, and a record that explicitly denies this server - and the operator needs
            // to know which, so the merge's own reason is passed through rather than
            // flattened into one message.
            ? manual(null, `${merge.detail}; sort that out first, then publish.`)
            : overBudget
              ? manual(merge.record, 'The merged record would need more than 10 DNS lookups. Consolidate the existing includes first.')
              : dnsManaged
                ? ready(merge.record, merge.detail)
                : manual(merge.record, merge.detail);

  // ----- DKIM
  const dkimName = input.dkimKey ? dkimRecordName(domain, input.dkimKey.selector) : `wpl7._domainkey.${domain}`;
  const dkimValue = input.dkimKey ? dkimRecordValue(input.dkimKey.publicKeyB64) : '';
  const dkimAutomation: MailStepAutomation = !input.dkimKey
    ? dnsManaged
      ? ready('', 'Generates a signing key and publishes its public half')
      : manual(null, 'Generate the key first (Enable DKIM), then publish the record it gives you.')
    : input.dkim.verdict === 'ok'
      ? satisfied('The published key matches the one this server signs with')
      : dnsManaged
        ? ready(dkimValue, input.dkim.verdict === 'missing' ? 'Publishes the signing key' : 'Replaces the published key with the current one')
        : manual(dkimValue, input.dkim.verdict === 'missing' ? 'Publish this value' : 'Replace the published value with this one');

  // ----- DMARC
  const dmarcValue = suggestedDmarc(`dmarc@${domain}`);
  const dmarcAutomation: MailStepAutomation =
    input.dmarc.found !== null
      ? // Overwriting someone's p=reject with our starter p=none would quietly weaken a
        // policy they chose on purpose, so an existing record is never rewritten. But
        // "present" is not "working": a record without a p= tag is ignored by receivers, and
        // calling that done would let the domain report itself ready while DMARC does
        // nothing at all.
        input.dmarc.verdict === 'error'
        ? manual(
            null,
            `A DMARC record is published but receivers will ignore it: ${input.dmarc.detail}. Correct it by hand.`,
          )
        : satisfied('A DMARC record is already published; the panel leaves it alone.')
      : dnsManaged
        ? ready(dmarcValue, 'Publishes a monitoring-only policy (p=none) with a reports address')
        : manual(dmarcValue, 'Publish this value once SPF and DKIM pass');

  return [
    {
      id: 'spf',
      title: 'SPF — say which servers may send',
      why: 'Without it, anyone can forge the domain.',
      record: { type: 'TXT', name: domain, value: spfValue },
      status: input.spf,
      automation: spfAutomation,
    },
    {
      id: 'dkim',
      title: 'DKIM — sign the mail',
      why: 'Survives forwarding, which SPF does not, and is what DMARC checks against.',
      record: { type: 'TXT', name: dkimName, value: dkimValue },
      status: input.dkim,
      automation: dkimAutomation,
    },
    {
      id: 'dmarc',
      title: 'DMARC — tell receivers what to do',
      why: 'Publish it last — it acts on SPF and DKIM failures.',
      record: { type: 'TXT', name: `_dmarc.${domain}`, value: dmarcValue },
      status: input.dmarc,
      automation: dmarcAutomation,
    },
  ];
}

// ---------------------------------------------------------------------------
// Reverse DNS

/**
 * Reverse DNS lives in the *IP owner's* zone, not the domain's, so it is set wherever the
 * server was rented and cannot be reached with a DNS provider token. Automating it would
 * need a second credential per hosting provider (Hetzner Cloud, DigitalOcean, …), which
 * the panel deliberately does not ask for — it is a handful of clicks, once per server,
 * and the token would carry far more power than writing a PTR.
 */
export const RDNS_GUIDES: { id: string; name: string; steps: string[] }[] = [
  {
    id: 'hetzner-cloud',
    name: 'Hetzner Cloud',
    steps: [
      'Open console.hetzner.cloud and pick the project, then the server.',
      'Go to the Networking tab.',
      'Next to the IPv4 address, open the ⋮ menu and choose "Edit reverse DNS".',
      'Enter the mail hostname shown above and save. It takes effect within a minute.',
      'Repeat for the IPv6 address if the server has one and you send over IPv6.',
    ],
  },
  {
    id: 'hetzner-robot',
    name: 'Hetzner (dedicated / Robot)',
    steps: [
      'Open robot.hetzner.com and go to Servers → your server → IPs.',
      'Click the edit icon next to the IP.',
      'Enter the mail hostname shown above in the reverse DNS field and save.',
    ],
  },
  {
    id: 'digitalocean',
    name: 'DigitalOcean',
    steps: [
      'DigitalOcean derives the PTR from the Droplet name.',
      'Open the Droplet, click its name at the top, and rename it to the mail hostname shown above.',
      'The PTR follows within a few minutes.',
    ],
  },
  {
    id: 'vultr',
    name: 'Vultr',
    steps: [
      'Open the instance, then the Settings → IPv4 tab.',
      'Click the pencil next to the reverse DNS entry.',
      'Enter the mail hostname shown above and save.',
    ],
  },
  {
    id: 'linode',
    name: 'Akamai / Linode',
    steps: [
      'Make sure the mail hostname already resolves to this IP — Linode rejects the request otherwise.',
      'Open the Linode → Network tab → the ⋮ menu on the IP address → "Edit RDNS".',
      'Enter the mail hostname shown above and save.',
    ],
  },
  {
    id: 'other',
    name: 'Another provider',
    steps: [
      'Look for "reverse DNS", "rDNS" or "PTR" in the control panel for the IP address.',
      'If there is no such field, open a support ticket with the IP and the mail hostname shown above.',
      'Some providers derive the PTR from the instance name instead — rename it to the mail hostname.',
    ],
  },
];
