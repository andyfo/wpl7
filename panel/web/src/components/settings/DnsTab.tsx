import { useState, type ReactNode } from 'react';
import { Link } from 'react-router';
import type { DnsServerDto, DnsStatusDto, DnsTokenCheckDto } from '../../../../shared/types';
import { ApiError } from '../../api/client';
import { useCheckDnsToken, useDns, useRemoveDnsToken, useSaveDnsToken, useSetWildcard } from '../../api/dns';
import { timeAgo } from '../../lib/format';
import { Button, Card, ChecksList, ConfirmDialog, ErrorNote, Field, OutLink, Spinner, Toggle, inputClass } from '../ui';

/**
 * Settings -> DNS: the Cloudflare token, and each server's wildcard certificate - which is issued
 * through that token, so the second card says so, and a switch that cannot be turned on says why.
 * Both act at once, each with its own button - neither is part of the settings form the other
 * tabs save together. Kept short on purpose: docs/dns.md has the long version.
 */
export function DnsTab() {
  const dns = useDns();
  // The saved token's last check - Check, or the save itself - also tells each server's row
  // whether its dev domain is one the token can work in. A token only typed in is not the one
  // those servers use.
  const [savedCheck, setSavedCheck] = useState<DnsTokenCheckDto | null>(null);
  return (
    <div className="space-y-6">
      <CloudflareCard status={dns.data} onSavedCheck={setSavedCheck} />
      <WildcardCard status={dns.data} savedCheck={savedCheck} />
      <ErrorNote error={dns.error} />
    </div>
  );
}

function CloudflareCard({
  status,
  onSavedCheck,
}: {
  status: DnsStatusDto | undefined;
  onSavedCheck: (check: DnsTokenCheckDto | null) => void;
}) {
  const save = useSaveDnsToken();
  const remove = useRemoveDnsToken();
  const check = useCheckDnsToken();
  const [replacing, setReplacing] = useState(false);
  const [token, setToken] = useState('');
  const [found, setFound] = useState<DnsTokenCheckDto | null>(null);
  const [notice, setNotice] = useState<ReactNode>(null);
  const [confirmRemove, setConfirmRemove] = useState(false);

  const configured = status?.token.configured ?? false;
  const typing = !configured || replacing;
  const busy = save.isPending || remove.isPending || check.isPending;

  const reset = () => {
    setNotice(null);
    setFound(null);
    save.reset();
    remove.reset();
    check.reset();
  };
  const runCheck = async (candidate?: string) => {
    reset();
    const res = await check.mutateAsync(candidate);
    setFound(res);
    if (candidate === undefined) onSavedCheck(res);
  };
  const runSave = async () => {
    reset();
    const res = await save.mutateAsync(token.trim());
    setFound(res.check ?? null);
    onSavedCheck(res.check ?? null);
    setToken('');
    setReplacing(false);
    setNotice(configured ? 'Saved. Traefik restarts on each server to pick it up.' : 'Saved.');
  };
  const runRemove = async () => {
    reset();
    const res = await remove.mutateAsync();
    onSavedCheck(null);
    setNotice(<>Removed.{rebuildingNote(res.rebuilding ?? [])}</>);
  };

  return (
    <Card title="Cloudflare" id="cloudflare">
      <div className="space-y-4">
        <p className="measure text-sm text-neutral-600">
          Lets the panel create DNS records in your Cloudflare account: for your sites, for mail, and for the wildcard certificate below.
          Without a token, you add the records by hand.
        </p>

        {status && configured && (
          <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
            <span className="text-sm text-neutral-800">
              <span className="text-emerald-600">✓</span> Token saved{status.token.setAt ? ` on ${formatDay(status.token.setAt)}` : ''}
            </span>
            <div className="flex gap-2">
              <Button
                small
                variant="secondary"
                disabled={busy}
                title="Ask Cloudflare what the token can reach"
                onClick={() => void runCheck().catch(() => undefined)}
              >
                {check.isPending && !token ? 'Checking…' : 'Check'}
              </Button>
              {!replacing && (
                <Button small variant="secondary" disabled={busy} onClick={() => (reset(), setReplacing(true))}>
                  Replace
                </Button>
              )}
              <Button small variant="ghost" disabled={busy} onClick={() => setConfirmRemove(true)}>
                Remove
              </Button>
            </div>
          </div>
        )}
        {status && !configured && <p className="text-sm text-neutral-800">No token yet.</p>}
        {status?.token.envDiffers && (
          <p className="measure rounded-lg bg-amber-50 px-3 py-2 text-xs text-amber-900">
            <code>deploy/.env</code> {configured ? 'has a different' : 'still has a'} <code>CF_DNS_API_TOKEN</code>. It is ignored: the panel
            only uses a token saved here.
          </p>
        )}

        {status && typing && (
          <form
            className="space-y-3"
            onSubmit={(e) => {
              e.preventDefault();
              if (token.trim()) void runSave().catch(() => undefined);
            }}
          >
            <Field
              label={configured ? 'New API token' : 'API token'}
              width="lg"
              hint={
                <>
                  Create one under <OutLink href="https://dash.cloudflare.com/profile/api-tokens">Cloudflare → API Tokens</OutLink> with{' '}
                  <b>Zone → Zone → Read</b> and <b>Zone → DNS → Edit</b> for your domains.
                </>
              }
            >
              <input
                className={`${inputClass} font-mono`}
                type="password"
                autoComplete="off"
                spellCheck={false}
                value={token}
                onChange={(e) => setToken(e.target.value)}
                autoFocus={replacing}
              />
            </Field>
            {configured && (
              <p className="measure text-xs text-neutral-500">Saving restarts Traefik on each server, so its sites are down for a few seconds.</p>
            )}
            <div className="flex flex-wrap gap-2">
              <Button type="submit" disabled={!token.trim() || busy}>
                {save.isPending ? 'Saving…' : 'Save token'}
              </Button>
              <Button
                variant="secondary"
                disabled={!token.trim() || busy}
                title="Ask Cloudflare what this token can reach, without saving it"
                onClick={() => void runCheck(token.trim()).catch(() => undefined)}
              >
                {check.isPending && token ? 'Checking…' : 'Check'}
              </Button>
              {replacing && (
                <Button variant="ghost" disabled={busy} onClick={() => (reset(), setReplacing(false), setToken(''))}>
                  Cancel
                </Button>
              )}
            </div>
          </form>
        )}

        {!status && <Spinner />}
        <ErrorNote error={save.error ?? remove.error ?? check.error} />
        {notice && <p className="text-sm text-emerald-700">{notice}</p>}
        {found && <CheckResult check={found} />}
      </div>

      {confirmRemove && (
        <ConfirmDialog
          title="Remove the Cloudflare token?"
          confirmLabel="Remove token"
          message={
            <ul className="list-disc space-y-1 pl-5">
              <li>The panel stops creating DNS records. It tells you which ones to add instead.</li>
              <li>Dev sites on a wildcard certificate get one of their own. Each is rebuilt, so it is down for a few seconds.</li>
              <li>Traefik restarts on each server.</li>
            </ul>
          }
          onConfirm={() => void runRemove().catch(() => undefined)}
          onClose={() => setConfirmRemove(false)}
        />
      )}
    </Card>
  );
}

/** What a token reaches, as Cloudflare answered it. */
function CheckResult({ check }: { check: DnsTokenCheckDto }) {
  if (!check.ok) return <div className="measure rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">{check.error}</div>;
  const more = check.zoneCount - check.zones.length;
  return (
    <div className="measure space-y-3 rounded-lg border border-neutral-200 px-3 py-2.5">
      <p className="text-sm text-neutral-800">
        <span className="text-emerald-600">✓</span> The token works. It sees {plural(check.zoneCount, 'domain')}: {check.zones.join(', ')}
        {more > 0 ? ` and ${more} more` : ''}.
      </p>
      {check.devDomains.length > 0 && (
        <div className="space-y-1.5">
          <div className="text-xs font-medium uppercase tracking-wide text-neutral-400">Dev domains</div>
          <ChecksList
            checks={check.devDomains.map((d) => ({
              name: d.domain,
              ok: d.records === 'readable',
              detail: devDomainDetail(d),
            }))}
          />
        </div>
      )}
    </div>
  );
}

function devDomainDetail(d: DnsTokenCheckDto['devDomains'][number]): string {
  const on = `(${d.servers.join(', ')})`;
  if (d.records === 'readable') return `ready for the wildcard certificate ${on}`;
  if (d.records === 'refused') return `the token can't edit the DNS records of ${d.zone}: give it Zone → DNS → Edit there. ${d.detail ?? ''}`;
  if (d.detail) return `couldn't be looked up. ${d.detail}`;
  return `not under any domain this token can see ${on}`;
}

function WildcardCard({ status, savedCheck }: { status: DnsStatusDto | undefined; savedCheck: DnsTokenCheckDto | null }) {
  const setWildcard = useSetWildcard();
  const [confirmOff, setConfirmOff] = useState<DnsServerDto | null>(null);
  const [pending, setPending] = useState<number | null>(null);
  const [notice, setNotice] = useState<ReactNode>(null);
  /** The last switch the panel refused, and why: shown on that server's row. */
  const [refused, setRefused] = useState<{ serverId: number; reason: string } | null>(null);
  const configured = status?.token.configured ?? false;

  const change = async (server: DnsServerDto, on: boolean) => {
    setNotice(null);
    setRefused(null);
    setPending(server.id);
    try {
      const res = await setWildcard.mutateAsync({ serverId: server.id, on });
      setNotice(
        on ? (
          `On for ${server.name}. New dev sites use it; existing ones keep their own certificate.`
        ) : (
          <>
            Off for {server.name}.{rebuildingNote(res.rebuilding ?? [])}
          </>
        ),
      );
    } catch (err) {
      setRefused({ serverId: server.id, reason: refusalOf(err) });
    } finally {
      setPending(null);
    }
  };

  return (
    <Card title="Wildcard certificate" id="wildcard">
      <div className="space-y-4">
        <p className="measure text-sm text-neutral-600">
          One certificate for every dev site on a server, so new dev sites have HTTPS right away. It is issued through a DNS check in Cloudflare,
          which is why it needs the token above.
        </p>
        {status ? (
          // Below md the dev domain and the status fold into the first cell: a table scrolled
          // sideways would hide why a switch is off.
          <table className="w-full text-sm">
              <thead>
                <tr className="text-left text-xs uppercase tracking-wide text-neutral-400">
                  <th className="pb-2 pr-3">Server</th>
                  <th className="hidden pb-2 pr-3 md:table-cell">Dev domain</th>
                  <th className="pb-2 pr-3">Wildcard</th>
                  <th className="hidden pb-2 md:table-cell">Status</th>
                </tr>
              </thead>
              <tbody>
                {status.servers.map((server) => {
                  const on = server.dnsProvider !== '';
                  const row = rowView(server, configured, savedCheck?.devDomains.find((d) => d.domain === server.devDomain));
                  const reason = refused?.serverId === server.id ? refused.reason : null;
                  const domain = server.devDomain ? `*.${server.devDomain}` : '–';
                  const line = (
                    <span className={TONES[reason ? 'error' : row.tone]} title={reason ? undefined : row.hint}>
                      {reason ?? row.text}
                    </span>
                  );
                  return (
                    <tr key={server.id} className="border-t border-neutral-100 align-top">
                      <td className="py-2 pr-3">
                        <Link className="font-medium underline decoration-neutral-300" to={`/servers/${server.id}`}>
                          {server.name}
                        </Link>
                        <div className="font-mono text-xs text-neutral-500 md:hidden">{domain}</div>
                        <div className="mt-0.5 text-xs md:hidden">{line}</div>
                      </td>
                      <td className="hidden py-2 pr-3 font-mono text-xs text-neutral-600 md:table-cell">{domain}</td>
                      <td className="py-2 pr-3">
                        {/* On the wrapper: a disabled button shows no tooltip of its own in every browser. */}
                        <span title={!on && row.blocked ? row.blocked : undefined} className="inline-block">
                          <Toggle
                            checked={on}
                            busy={pending === server.id}
                            disabled={(!on && row.blocked !== null) || server.status === 'provisioning' || pending !== null}
                            onChange={(next) => (next ? void change(server, true) : setConfirmOff(server))}
                            label={<span className="sr-only">Wildcard certificate on {server.name}</span>}
                          />
                        </span>
                      </td>
                      <td className="hidden py-2 text-xs md:table-cell">{line}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
        ) : (
          <Spinner />
        )}
        {notice && <p className="text-sm text-emerald-700">{notice}</p>}
      </div>

      {confirmOff && (
        <ConfirmDialog
          title={`Turn off the wildcard certificate on ${confirmOff.name}?`}
          confirmLabel="Turn off"
          message={<p>Its dev sites get a certificate of their own. Each is rebuilt, so it is down for a few seconds.</p>}
          onConfirm={() => void change(confirmOff, false)}
          onClose={() => setConfirmOff(null)}
        />
      )}
    </Card>
  );
}

const TONES = { ok: 'text-emerald-700', warn: 'text-amber-700', error: 'text-red-700', muted: 'text-neutral-500' } as const;

/**
 * A server's row, in a few words: what stands between it and a wildcard certificate, if anything,
 * and - when its switch cannot be turned on - why, as the panel would refuse it
 * (services/wildcardSites.ts). `hint` is the longer version, on hover; `reach` is what the saved
 * token's last check found for the server's dev domain.
 */
function rowView(
  server: DnsServerDto,
  configured: boolean,
  reach: DnsTokenCheckDto['devDomains'][number] | undefined,
): { blocked: string | null; text: string; tone: keyof typeof TONES; hint?: string } {
  const t = server.traefik;
  if (server.status === 'provisioning') return { blocked: 'This server is still being set up.', text: 'Being set up', tone: 'muted' };
  const update =
    server.id === 1 ? 'It was set up before this feature: update the panel under Settings → Updates.' : 'It was set up before this feature: use Update on its page.';
  const outdated = t.state === 'ok' && (t.mode === 'none' || (t.mode === 'env' && !t.envToken));
  // A Traefik on another provider reads that provider's credentials, not the panel's token.
  const cloudflare = t.mode !== 'other';
  const blocked = outdated ? `Update this server first. ${update}` : cloudflare && !configured ? 'Add a Cloudflare token above first.' : null;
  if (server.dnsProvider !== '' && !server.wildcardProvider) return { blocked, text: 'Waiting for a Cloudflare token', tone: 'warn' };
  if (t.state === 'unknown') return { blocked, text: server.status === 'unreachable' ? 'Unreachable' : 'Checking…', tone: 'muted' };
  if (t.state === 'error') return { blocked, text: 'Couldn’t give it the token. Retrying every minute.', tone: 'error', hint: t.message ?? undefined };
  if (t.mode === 'stopped') return { blocked, text: 'Traefik isn’t running', tone: 'error' };
  if (outdated) return { blocked, text: 'Update this server first', tone: 'warn', hint: update };
  if (cloudflare && !configured) return { blocked, text: 'Needs a Cloudflare token', tone: 'muted' };
  if (cloudflare && reach && reach.records !== 'readable') return { blocked, text: reachProblem(reach), tone: 'warn', hint: reach.detail ?? undefined };
  switch (t.mode) {
    case 'file':
      return { blocked, text: 'Has the token', tone: 'ok', hint: t.restartedAt ? `Traefik restarted ${timeAgo(t.restartedAt)} to read it` : undefined };
    case 'env':
      return { blocked, text: 'Update this server to use the token here', tone: 'warn', hint: 'Until then it uses the token in its own deploy/.env.' };
    case 'other':
      return { blocked, text: `Uses ${t.provider}`, tone: 'muted', hint: 'With the credentials in its own deploy/.env.' };
    default:
      return { blocked, text: 'Checking…', tone: 'muted' };
  }
}

/** What the saved token's check found wrong with a dev domain: what the panel would refuse it for. */
function reachProblem(d: DnsTokenCheckDto['devDomains'][number]): string {
  if (d.records === 'refused') return `The token can't edit the DNS records of ${d.zone}`;
  if (d.detail) return `Couldn't look up ${d.domain} in Cloudflare`;
  return `${d.domain} isn't under any domain the token can see`;
}

/** Why the panel refused a switch, without the server name the row already shows. */
function refusalOf(err: unknown): string {
  const reason = err instanceof ApiError ? (err.details as { reason?: unknown } | undefined)?.reason : undefined;
  if (typeof reason === 'string') return reason;
  return err instanceof Error ? err.message : String(err);
}

function rebuildingNote(slugs: string[]): ReactNode {
  if (slugs.length === 0) return null;
  return (
    <>
      {' '}
      Rebuilding {plural(slugs.length, 'dev site')} with {slugs.length === 1 ? 'a certificate of its own' : 'certificates of their own'} -{' '}
      <Link className="underline" to="/jobs">
        see Jobs
      </Link>
      .
    </>
  );
}

const formatDay = (ts: number) => new Date(ts).toLocaleDateString(undefined, { dateStyle: 'medium' });

const plural = (n: number, one: string) => `${n} ${one}${n === 1 ? '' : 's'}`;
