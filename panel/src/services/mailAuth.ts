import path from 'node:path';
import type { Config } from '../config.js';

/**
 * Per-site authentication for the outbound relay.
 *
 * Before this, anything that could open a TCP connection to `wpl7-mail` could hand it a
 * message with any `From:` it liked, and the DKIM signer - which decides purely on the
 * sender domain - would sign it with that domain's key. One compromised site could
 * therefore emit mail as any other customer on the fleet, DKIM-valid, SPF-aligned and
 * indistinguishable from the real thing.
 *
 * The fix is the mechanism postfix is built for: every site gets its own SASL login, the
 * panel publishes a map of "this sender domain belongs to that login", and postfix's
 * `reject_known_sender_login_mismatch` refuses any mismatch. Deliberately the *known*
 * variant: a sender domain the fleet knows nothing about (a customer relaying their own
 * off-fleet address) is left alone, so closing the hole cannot break legitimate mail.
 *
 * That holds the envelope sender. The signer decides by the `From:` header, which a site
 * writes as it likes, so it holds that to the same owners itself - its signing policy
 * (services/mailDkim.ts renderSigningPolicy) reads them from the file syncMailAuthTo writes
 * beside the keys.
 */

/**
 * Cyrus realm the logins live in. Fixed rather than the mail hostname: sasldb keys are
 * `user@realm`, so deriving it from a hostname would silently invalidate every credential
 * the day MAIL_HOSTNAME changes.
 */
export const SASL_REALM = 'wpl7';

export const mailLogin = (slug: string): string => `${slug}@${SASL_REALM}`;

/**
 * LEGACY(ceo) - delete in 0.3.0. The realm every login lived in before the rename.
 *
 * A site's credential is three things that have to agree: the entry in sasldb, the `user`
 * line in its own msmtprc, and the owner the relay's sender map names for its domains. Only
 * `site.reconcile` can change the second one, because it means recreating the container -
 * so between the host migration and the last reconcile finishing, sites are still
 * presenting `<slug>@ceo`. Until then both logins exist, with the same password, and the
 * sender map names both as owners; postfix accepts a list there ("the result of table
 * lookup must be either not found or a list of SASL login names separated by comma and/or
 * whitespace"), so each site keeps sending throughout, and a suspended one stays suspended
 * on either login.
 */
export const LEGACY_SASL_REALM = 'ceo';

export const legacyMailLogin = (slug: string): string => `${slug}@${LEGACY_SASL_REALM}`;

/** LEGACY(ceo) - delete in 0.3.0. The pre-rename twin of a site login, or null for anything else. */
export function legacyLoginFor(login: string): string | null {
  const suffix = `@${SASL_REALM}`;
  return login.endsWith(suffix) ? `${login.slice(0, -suffix.length)}@${LEGACY_SASL_REALM}` : null;
}

/**
 * Owner recorded for domains that have DKIM keys but no site on this fleet (a domain kept
 * after its site was deleted, or one added ahead of a migration). No site can authenticate
 * as this login, so those domains are spoof-proof too, while the panel's own test sends -
 * which inject through sendmail inside the container, not through smtpd - still work.
 */
export const RESERVED_LOGIN = 'reserved@wpl7.invalid';

/** Where the relay's authentication state lives on a server, and inside the container. */
export function mailAuthPaths(config: Config) {
  const root = path.join(config.srvRoot, 'mail');
  return {
    /** Bind-mounted read-only at /etc/postfix/policy. */
    policyDir: path.join(root, 'policy'),
    senderLogin: path.join(root, 'policy', 'sender_login'),
    saslBlock: path.join(root, 'policy', 'sasl_block'),
    /** Bind-mounted read-write at /etc/postfix/sasl; saslpasswd2 writes the db here. */
    saslDir: path.join(root, 'sasl'),
    /** Bind-mounted read-only over /etc/sasl2/smtpd.conf. */
    smtpdConf: path.join(root, 'sasl2', 'smtpd.conf'),
    smtpdConfDir: path.join(root, 'sasl2'),
  };
}

/** Where the credential database is mounted; referenced by the saslpasswd2 calls below. */
export const SASLDB_IN_CONTAINER = '/etc/postfix/sasl/sasldb2';

/**
 * Cyrus SASL's config for the `smtpd` application. `sasldb_path` has to be spelled out:
 * the default is /etc/sasldb2, which lives in the image and would be lost - taking every
 * site's ability to send with it - the next time the mail container is recreated.
 * The site containers authenticate with PLAIN (see renderMsmtprc); CRAM-MD5 is advertised
 * as well because sasldb stores passwords recoverably and it costs nothing, but nothing in
 * the stack depends on it.
 */
export function renderSmtpdConf(): string {
  return `# Managed by the WPL7 panel - edits are overwritten on the next mail sync.
pwcheck_method: auxprop
auxprop_plugin: sasldb
sasldb_path: ${SASLDB_IN_CONTAINER}
mech_list: PLAIN LOGIN CRAM-MD5
`;
}

export interface SenderOwner {
  domain: string;
  login: string;
}

/**
 * `smtpd_sender_login_maps`: which login owns which sender domain. The `@domain` form
 * matches every address at that domain, which is what WordPress produces
 * (`wordpress@<site domain>`) without the panel having to enumerate local parts.
 */
export function renderSenderLogin(owners: SenderOwner[]): string {
  const seen = new Set<string>();
  const lines: string[] = [];
  for (const { domain, login } of [...owners].sort((a, b) => a.domain.localeCompare(b.domain))) {
    const key = domain.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    // LEGACY(ceo) - delete in 0.3.0: a site that has not been reconciled since the rename
    // still authenticates under the old realm (see legacyMailLogin).
    const legacy = legacyLoginFor(login);
    lines.push(`@${key}\t${legacy ? `${login},${legacy}` : login}`);
  }
  return lines.join('\n').concat(lines.length ? '\n' : '');
}

export interface SaslBlockEntry {
  login: string;
  reason: string;
}

/**
 * `check_sasl_access`: logins the relay currently refuses. This is the abuse guard's lever
 * - rejecting at the relay stops a spam run at the first message rather than letting the
 * queue fill and the server's IP get listed while somebody reads a dashboard.
 */
export function renderSaslBlock(entries: SaslBlockEntry[]): string {
  const lines = [...entries]
    .flatMap((e) => {
      // LEGACY(ceo) - delete in 0.3.0. Suspending a site has to cover the login it is still
      // presenting as well as the one it will present after its reconcile.
      const legacy = legacyLoginFor(e.login);
      return legacy ? [e, { ...e, login: legacy }] : [e];
    })
    .sort((a, b) => a.login.localeCompare(b.login))
    .map((e) => `${e.login}\tREJECT ${sanitizeReason(e.reason)}`);
  return lines.join('\n').concat(lines.length ? '\n' : '');
}

/** Postfix access maps are line-oriented; a newline in the reason would forge a new entry. */
function sanitizeReason(reason: string): string {
  const clean = reason.replace(/[\r\n\t]+/g, ' ').trim();
  return clean.slice(0, 200) || 'Outbound mail suspended by the panel';
}

/**
 * The site's msmtp configuration, bind-mounted over /etc/msmtprc.
 *
 * `auth plain` names the mechanism instead of letting msmtp choose: with `auth on` it
 * refuses every method it considers insecure on an unencrypted connection and gives up with
 * "cannot use a secure authentication method" - which is correct for mail crossing the
 * internet, and wrong here. The only route to `mail` is the site's own internal Docker
 * network: not reachable from outside the host, and already carrying this site's database
 * password in the clear. Terminating TLS on it would add a certificate for the panel to
 * rotate and protect nothing.
 *
 * `password === null` = a site that has no relay credential yet (one created before per-site
 * mail authentication existed, until it is reconciled). The file is still written, because
 * this path is a bind mount: Docker answers a MISSING source by creating a directory there,
 * and the container then refuses to start at all. Mail cannot work either way; with the
 * file present, only the mail is broken.
 */
export function renderMsmtprc(login: string, password: string | null): string {
  const credential =
    password === null
      ? `# No relay credential has been minted for this site yet, so mail cannot authenticate.
# Reconcile the site from the panel to mint one and rewrite this file.`
      : `user ${login}
password ${password}`;
  return `# Managed by the WPL7 panel - edits are overwritten when the site is reconciled.
# PHP mail() -> msmtp -> wpl7-mail (postfix). The credential below is this site's own: the
# relay will not accept mail from it claiming to be another site's domain.
defaults
syslog on
timeout 15

account default
host mail
port 587
tls off
auth plain
${credential}
`;
}

/** Shell-safe single-quoting for the saslpasswd2 pipeline (no stdin on the docker exec API). */
export function sqSingle(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

/** `alpha@wpl7: userPassword` -> `alpha@wpl7`. */
export function parseSaslUsers(listing: string): string[] {
  const out: string[] = [];
  for (const line of listing.split('\n')) {
    const m = /^([^:\s]+@[^:\s]+):/.exec(line.trim());
    if (m?.[1]) out.push(m[1]);
  }
  return [...new Set(out)];
}
