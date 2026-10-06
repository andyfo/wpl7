/**
 * DKIM key material and the OpenDKIM config rendered from it.
 *
 * Keys belong to the panel, not to a server: the private key is stored in the panel
 * database and materialized onto every server's `wpl7-dkim` volume. That is what makes a
 * site move a non-event for mail — the target server can already sign for the domain, so
 * nothing has to be copied or re-published in DNS at cutover.
 *
 * Everything in this module is pure (key generation aside); `MailService` performs the
 * file writes and the container restart.
 */
// @docs mail/overview, mail/records
import crypto from 'node:crypto';

/** Same default selector the rest of the ecosystem uses; visible in the DNS record name. */
export const DEFAULT_DKIM_SELECTOR = 'wpl7';

/** Long enough to be respected by every major receiver, short enough for a single DNS TXT. */
const KEY_BITS = 2048;

export interface DkimKeyMaterial {
  selector: string;
  /** PKCS#1 PEM — the format OpenDKIM (and opendkim-genkey) expects. */
  privateKeyPem: string;
  /** base64 SPKI: the `p=` value of the DNS record. */
  publicKeyB64: string;
}

export function generateDkimKey(selector = DEFAULT_DKIM_SELECTOR): DkimKeyMaterial {
  const { privateKey, publicKey } = crypto.generateKeyPairSync('rsa', {
    modulusLength: KEY_BITS,
    privateKeyEncoding: { type: 'pkcs1', format: 'pem' },
    publicKeyEncoding: { type: 'spki', format: 'der' },
  });
  return {
    selector,
    privateKeyPem: privateKey,
    publicKeyB64: Buffer.from(publicKey).toString('base64'),
  };
}

/** `wpl7._domainkey.example.com` — the name the TXT record is published under. */
export const dkimRecordName = (domain: string, selector: string) => `${selector}._domainkey.${domain}`;

/** The TXT value to publish. */
export const dkimRecordValue = (publicKeyB64: string) => `v=DKIM1; h=sha256; k=rsa; p=${publicKeyB64}`;

/**
 * A 2048-bit key does not fit in one 255-character DNS character-string, so the record has
 * to go out as several concatenated strings. Most providers (Cloudflare included) do the
 * split themselves when handed the long value, but BIND-style zone files need it spelled
 * out, so both forms are offered.
 */
export function dkimRecordChunks(value: string, chunkSize = 255): string[] {
  const chunks: string[] = [];
  for (let i = 0; i < value.length; i += chunkSize) chunks.push(value.slice(i, i + chunkSize));
  return chunks;
}

export const dkimRecordBind = (name: string, value: string): string =>
  `${name}. IN TXT ( ${dkimRecordChunks(value).map((c) => `"${c}"`).join(' ')} )`;

// ---------------------------------------------------------------------------
// OpenDKIM configuration

export interface DkimKeyFile {
  domain: string;
  selector: string;
  /** Absolute path of the key INSIDE the wpl7-dkim container. */
  containerPath: string;
}

/**
 * KeyTable: one line per signing key, `<name> <domain>:<selector>:<key path>`, named after
 * its domain - which is how the signing policy (renderSigningPolicy) both finds a key and asks
 * for it. Read as a plain table (`file:`), so no escaping concerns.
 */
export function renderKeyTable(keys: DkimKeyFile[]): string {
  return keys
    .map((k) => `${k.domain.toLowerCase()} ${k.domain}:${k.selector}:${k.containerPath}`)
    .join('\n')
    .concat(keys.length ? '\n' : '');
}

/** Who may send as which domain, for the signer: one owner a line (renderSenderLogins). */
export interface SignerOwner {
  domain: string;
  /** The SASL login a site's container authenticates to the relay with. */
  login: string;
}

/**
 * SenderLogins: `<login>/<domain>`, one line for every domain each site's login owns - the
 * same owners the relay holds a site's envelope sender to (services/mailAuth.ts
 * renderSenderLogin, pre-rename twins included). The signing policy reads it for each message,
 * so a change needs no restart of the signer.
 */
export function renderSenderLogins(owners: SignerOwner[]): string {
  const lines = [...new Set(owners.map((o) => `${o.login.toLowerCase()}/${o.domain.toLowerCase()}`))].sort();
  return lines.join('\n').concat(lines.length ? '\n' : '');
}

/**
 * The signing policy (OpenDKIM `SetupPolicyScript`): which mail gets which signature.
 *
 * The relay holds a site to the sender domains it owns - but only in the envelope, and a
 * signature vouches for the `From:` header, which a site writes as it likes. A table keyed by
 * that header (what this replaces) therefore signed `From: ceo@another-client.com` for any
 * site that wrote it, and every subdomain of a key's domain for anyone - DKIM-valid, DMARC-
 * aligned, indistinguishable from the real thing. So the policy signs a message only for a
 * sender that owns the domain it signs for:
 *
 * - the key is the one of the `From:` domain, or of the nearest domain above it that has one
 *   (a key published once at `example.com` signs `shop.example.com` too: one DNS record per
 *   customer, not one per hostname), as before;
 * - it is used when the site's own SASL login owns the `From:` domain, or a domain between it
 *   and the key's (SenderLogins) - or when the panel sent the message through sendmail inside
 *   the relay, which reaches the signer as 127.0.0.1, where no site can connect from.
 *
 * Anything else goes out unsigned, which a receiver treats as the unauthenticated mail it is.
 * Lua, because the signer runs it for every message with the login the relay authenticated;
 * OpenDKIM's own sender-macro option is not compiled into the image.
 */
export function renderSigningPolicy(keysDir: string): string {
  return `-- Written by the WPL7 panel (services/mailDkim.ts renderSigningPolicy) - edits are overwritten.
-- Signs a message with the key of its From: domain, or of the nearest domain above it that has
-- one, and only when its sender owns that domain: the site's SASL login owns the From: domain or
-- a domain between it and the key's, or the panel sent it through sendmail in the relay.
local from = odkim.get_fromdomain(ctx)
if from == nil or from == "" then
  return nil
end
local queue = odkim.get_mtasymbol(ctx, "i") or "NOQUEUE"

local readable, keys = pcall(odkim.db_open, "file:${keysDir}/KeyTable", true)
if not readable then
  odkim.log(ctx, queue .. ": not signing: the key table cannot be read")
  return nil
end
local listed, owners = pcall(odkim.db_open, "file:${keysDir}/SenderLogins", true)
if not listed then
  owners = nil
end

local login = odkim.get_mtasymbol(ctx, "{auth_authen}")
if login == "" then
  login = nil
end
local ip = odkim.get_clientip(ctx)
local owned = login == nil and (ip == "127.0.0.1" or ip == "::1")

local domain = from
while domain ~= nil do
  if not owned and login ~= nil and owners ~= nil and odkim.db_check(owners, login .. "/" .. domain) == 1 then
    owned = true
  end
  if odkim.db_check(keys, domain) == 1 then
    if owned then
      odkim.sign(ctx, domain)
    else
      odkim.log(ctx, queue .. ": not signing for " .. domain .. ": " .. (login or "an unauthenticated sender") ..
        " does not own " .. from)
    end
    return nil
  end
  domain = string.match(domain, "^[^.]+%.(.+%..+)$")
end
return nil
`;
}

/**
 * Hosts whose mail is signed rather than verified. Every client of this relay is a site
 * container on an internal Docker network that nothing outside the host can reach (the
 * mail container publishes no ports), so "sign everything that gets this far" is the
 * correct policy — the trust boundary is the network, not the sender address.
 */
export const DKIM_TRUSTED_HOSTS = '0.0.0.0/0\n::/0\n';

/**
 * Full `opendkim.conf`, mounted over the image's own. It replaces the file rather than
 * using the image's `conf.d` drop-in mechanism because drop-ins are *appended* to the
 * shipped config on every container start — a restarted container would accumulate a
 * duplicate copy of our settings each time.
 *
 * `UserID root` is deliberate: the private keys are mounted read-only from a root-owned
 * directory on the host, and there is no stable uid to chown them to across image updates.
 */
export function renderOpendkimConf(keysDir: string): string {
  return `# Managed by the WPL7 panel - edits are overwritten on the next DKIM sync.
UserID                  root
BaseDirectory           /run/opendkim
Socket                  inet:8891
Syslog                  Yes
SyslogSuccess           Yes
# Sign only; this milter never sees inbound mail.
Mode                    s
Canonicalization        relaxed/simple
KeyTable                file:${keysDir}/KeyTable
# Who gets signed as what: see renderSigningPolicy. No SigningTable - the policy asks for
# every signature itself.
SetupPolicyScript       ${keysDir}/policy.lua
ExternalIgnoreList      refile:${keysDir}/TrustedHosts
InternalHosts           refile:${keysDir}/TrustedHosts
# Signing an absent From: too stops a header from being added downstream without breaking
# the signature.
OversignHeaders         From
`;
}
