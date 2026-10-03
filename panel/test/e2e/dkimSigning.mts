/**
 * The DKIM signing policy (services/mailDkim.ts renderSigningPolicy) against the real signer:
 * the image deploy/docker-compose.yml runs, fed the config, key table, policy and owners this
 * panel renders, and OpenDKIM's own `miltertest` playing the relay - one message per case, with
 * the SASL login and client address postfix would hand it.
 *
 *   cd panel && npx tsx test/e2e/dkimSigning.mts
 *
 * Needs Docker. Runs one throwaway container with no network; it touches nothing else. On a
 * Mac where `docker pull` hangs on the keychain helper, set DOCKER_CONFIG to a config without
 * `credsStore`.
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  DKIM_TRUSTED_HOSTS,
  generateDkimKey,
  renderKeyTable,
  renderOpendkimConf,
  renderSenderLogins,
  renderSigningPolicy,
  type SignerOwner,
} from '../../src/services/mailDkim.js';

const IMAGE = 'instrumentisto/opendkim:latest';
const KEYS = '/etc/opendkim/keys';

/** Domains with a key, and who owns what - the fleet the cases run against. */
const KEYED = ['client-a.test', 'client-b.test', 'parent.test', 'orphan.test'];
const OWNERS: SignerOwner[] = [
  { login: 'site-a@wpl7', domain: 'client-a.test' },
  { login: 'site-b@wpl7', domain: 'client-b.test' },
  // Answers only on a subdomain of a key published at the parent.
  { login: 'site-c@wpl7', domain: 'shop.parent.test' },
  // A key kept after its site was deleted: parked on a login nobody holds.
  { login: 'reserved@wpl7.invalid', domain: 'orphan.test' },
];

interface Case {
  name: string;
  /** Where the message comes from: a site container, or 127.0.0.1 - sendmail in the relay. */
  ip: string;
  login: string | null;
  from: string;
  /** The d= it must be signed with, or null for unsigned. */
  want: string | null;
}

const SITE_IP = '172.20.0.5';
const CASES: Case[] = [
  { name: 'own-domain', ip: SITE_IP, login: 'site-a@wpl7', from: 'wordpress@client-a.test', want: 'client-a.test' },
  { name: 'own-domain-any-case', ip: SITE_IP, login: 'site-a@wpl7', from: 'Shop <Hello@CLIENT-A.test>', want: 'client-a.test' },
  { name: 'another-sites-domain', ip: SITE_IP, login: 'site-a@wpl7', from: 'ceo@client-b.test', want: null },
  { name: 'unauthenticated-site', ip: SITE_IP, login: null, from: 'ceo@client-b.test', want: null },
  { name: 'subdomain-of-another-sites-key', ip: SITE_IP, login: 'site-b@wpl7', from: 'news@promo.client-a.test', want: null },
  { name: 'own-subdomain-parent-key', ip: SITE_IP, login: 'site-c@wpl7', from: 'orders@shop.parent.test', want: 'parent.test' },
  { name: 'below-own-subdomain', ip: SITE_IP, login: 'site-c@wpl7', from: 'x@eu.shop.parent.test', want: 'parent.test' },
  { name: 'parent-it-does-not-own', ip: SITE_IP, login: 'site-c@wpl7', from: 'ceo@parent.test', want: null },
  { name: 'orphaned-key', ip: SITE_IP, login: 'site-a@wpl7', from: 'billing@orphan.test', want: null },
  { name: 'no-key-at-all', ip: SITE_IP, login: 'site-a@wpl7', from: 'a@unkeyed.test', want: null },
  { name: 'panel-through-sendmail', ip: '127.0.0.1', login: null, from: 'alerts@client-a.test', want: 'client-a.test' },
  { name: 'panel-orphaned-key', ip: '127.0.0.1', login: null, from: 'test@orphan.test', want: 'orphan.test' },
];

/** With no owners file - a server between a key sync and the first relay publish. */
const CASES_WITHOUT_OWNERS: Case[] = [
  { name: 'no-owners:site', ip: SITE_IP, login: 'site-a@wpl7', from: 'wordpress@client-a.test', want: null },
  { name: 'no-owners:panel', ip: '127.0.0.1', login: null, from: 'alerts@client-a.test', want: 'client-a.test' },
];

const lua = (s: string) => JSON.stringify(s);

function miltertestScript(cases: Case[]): string {
  const calls = cases
    .map((c) => `run(${lua(c.name)}, ${lua(c.ip)}, ${c.login ? lua(c.login) : 'nil'}, ${lua(c.from)}, ${c.want ? lua(c.want) : 'nil'})`)
    .join('\n');
  return `failures = 0
local function step(conn, what, rc)
  if rc ~= nil then error(what .. " failed") end
  local reply = mt.getreply(conn)
  if reply == SMFIR_TEMPFAIL or reply == SMFIR_REJECT then error(what .. ": the signer refused the message") end
  return reply
end
function run(name, ip, login, from, want)
  local conn = mt.connect("inet:8891@127.0.0.1", 40, 0.25)
  if conn == nil then error("cannot connect to the signer") end
  step(conn, name .. " connect", mt.conninfo(conn, ip == "127.0.0.1" and "localhost" or "site.internal", ip))
  if login ~= nil then
    mt.macro(conn, SMFIC_MAIL, "i", "Q" .. name, "{auth_authen}", login)
  else
    mt.macro(conn, SMFIC_MAIL, "i", "Q" .. name)
  end
  step(conn, name .. " mail", mt.mailfrom(conn, "envelope@client-a.test"))
  step(conn, name .. " from", mt.header(conn, "From", from))
  step(conn, name .. " subject", mt.header(conn, "Subject", "signing policy"))
  local got = "unsigned"
  -- A message the signer will not sign is let through as soon as it knows: ACCEPT at the end
  -- of the headers, which the relay delivers as it is. Anything else goes on to the body.
  if step(conn, name .. " eoh", mt.eoh(conn)) ~= SMFIR_ACCEPT then
    step(conn, name .. " body", mt.bodystring(conn, "hello\\r\\n"))
    step(conn, name .. " eom", mt.eom(conn))
    if mt.eom_check(conn, MT_HDRINSERT, "DKIM-Signature") or mt.eom_check(conn, MT_HDRADD, "DKIM-Signature") then
      got = "signed d=" .. (string.match(mt.getheader(conn, "DKIM-Signature", 0), "d=([^;%s]+)") or "?")
    end
  end
  local expected = want and ("signed d=" .. want) or "unsigned"
  if got == expected then
    mt.echo("ok    " .. name .. ": " .. got)
  else
    mt.echo("FAIL  " .. name .. ": " .. got .. ", wanted " .. expected)
    failures = failures + 1
  end
  mt.disconnect(conn)
end
${calls}
if failures > 0 then error(failures .. " case(s) failed") end
`;
}

function fixture(withOwners: boolean, cases: Case[]): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wpl7-dkim-'));
  const keys = path.join(dir, 'keys');
  fs.mkdirSync(keys);
  for (const domain of KEYED) {
    fs.mkdirSync(path.join(keys, domain));
    fs.writeFileSync(path.join(keys, domain, 'wpl7.private'), generateDkimKey().privateKeyPem, { mode: 0o600 });
  }
  const keyFiles = KEYED.map((domain) => ({ domain, selector: 'wpl7', containerPath: `${KEYS}/${domain}/wpl7.private` }));
  fs.writeFileSync(path.join(keys, 'KeyTable'), renderKeyTable(keyFiles));
  fs.writeFileSync(path.join(keys, 'policy.lua'), renderSigningPolicy(KEYS));
  fs.writeFileSync(path.join(keys, 'TrustedHosts'), DKIM_TRUSTED_HOSTS);
  if (withOwners) fs.writeFileSync(path.join(keys, 'SenderLogins'), renderSenderLogins(OWNERS));
  fs.writeFileSync(path.join(keys, 'cases.lua'), miltertestScript(cases));
  fs.writeFileSync(path.join(dir, 'opendkim.conf'), renderOpendkimConf(KEYS));
  return dir;
}

function runPhase(title: string, withOwners: boolean, cases: Case[]): boolean {
  const dir = fixture(withOwners, cases);
  console.log(`\n${title}`);
  try {
    const out = execFileSync(
      'docker',
      [
        'run', '--rm', '--network', 'none', '--platform', 'linux/amd64',
        '-v', `${path.join(dir, 'keys')}:${KEYS}:ro`,
        '-v', `${path.join(dir, 'opendkim.conf')}:/etc/opendkim/opendkim.conf:ro`,
        '--entrypoint', 'sh', IMAGE, '-c',
        'mkdir -p /run/opendkim && opendkim -x /etc/opendkim/opendkim.conf -f & sleep 3; miltertest -s /etc/opendkim/keys/cases.lua',
      ],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 180_000 },
    );
    process.stdout.write(out);
    return true;
  } catch (err) {
    const e = err as { stdout?: string; stderr?: string };
    process.stdout.write(e.stdout ?? '');
    process.stderr.write(e.stderr ?? String(err));
    return false;
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

const ok = [
  runPhase('Signing policy, every owner published:', true, CASES),
  runPhase('Signing policy, before the owners are published:', false, CASES_WITHOUT_OWNERS),
].every(Boolean);
console.log(ok ? '\nAll cases passed.' : '\nSome cases failed.');
process.exit(ok ? 0 : 1);
