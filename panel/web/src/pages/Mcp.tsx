// @docs integrations/mcp
import { useEffect, useState } from 'react';
import { Link } from 'react-router';
import { useQueryClient } from '@tanstack/react-query';
import { useMcp } from '../api/hooks';
import { api } from '../api/client';
import { Button, Card, ConfirmDialog, CopyField, EmptyState, ErrorNote, Field, Segmented, Toggle, inputClass } from '../components/ui';
import { formatDate, timeAgo } from '../lib/format';
import { mcpServerName } from '../lib/mcpServerName';
import { ACCESS_LABELS, accessLevels, type AccessLevel } from '../../../shared/access';
import type { McpConnectionDto, McpPageDto, McpWindowDto } from '../../../shared/types';

/**
 * Integrations -> MCP: the MCP server that lets AI apps work in the panel (docs/mcp.md). The
 * switch, the address to give an app, the connection window an app signs in through, and the
 * apps connected - each at the access its admin chose, changeable here at any time.
 *
 * The page is at /integrations/mcp because /mcp is the endpoint itself.
 */
export function Mcp() {
  const mcp = useMcp();
  const qc = useQueryClient();
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  const refresh = () => qc.invalidateQueries({ queryKey: ['mcp'] });
  const data = mcp.data;

  const run = async (work: () => Promise<unknown>) => {
    setError(null);
    setBusy(true);
    try {
      await work();
      await refresh();
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="space-y-6">
      <div>
        <h1 className="page-title">MCP</h1>
        <p className="mt-1 text-sm text-neutral-500">
          Let AI apps — Claude, ChatGPT, Cursor, VS Code — work in this panel, at the access you give each one.
        </p>
      </div>
      <ErrorNote error={error} />
      {!data ? (
        <EmptyState>{mcp.error ? 'Could not load MCP.' : 'Loading…'}</EmptyState>
      ) : (
        <>
          <ServerCard
            data={data}
            busy={busy}
            onToggle={(on) => run(() => api('/api/settings', { method: 'PUT', body: { mcpEnabled: on } }))}
          />
          {data.enabled && !data.unavailable && (
            <>
              <ConnectCard
                data={data}
                busy={busy}
                onOpen={() => run(() => api('/api/mcp/connect-window', { method: 'POST' }))}
                onClose={() => run(() => api('/api/mcp/connect-window', { method: 'DELETE' }))}
                onDiscard={() => run(() => api('/api/mcp/connect-window/registration', { method: 'DELETE' }))}
              />
              <SetupCard url={data.url!} />
            </>
          )}
          <ConnectionsCard
            connections={data.connections}
            onAccess={(id, access) => run(() => api(`/api/mcp/connections/${id}`, { method: 'PATCH', body: { access } }))}
            onRevoke={(id) => run(() => api(`/api/mcp/connections/${id}`, { method: 'DELETE' }))}
          />
          <ActivityCard data={data} />
        </>
      )}
    </div>
  );
}

function ServerCard({ data, busy, onToggle }: { data: McpPageDto; busy: boolean; onToggle: (on: boolean) => void }) {
  return (
    <Card title="MCP server">
      <div className="space-y-4">
        <Toggle
          checked={data.enabled}
          onChange={onToggle}
          busy={busy}
          // Switching off always works; switching on needs an address to hand out.
          disabled={!data.enabled && data.unavailable !== null}
          label={
            <span>
              <span className="block font-medium text-neutral-800">Let AI apps connect</span>
              <span className="block text-xs text-neutral-500">
                Off, the MCP address and its sign-in do not exist. Switching it off pauses the connected apps and
                keeps them.
              </span>
            </span>
          }
        />
        {data.unavailable && (
          <div className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-900">
            MCP cannot run on this panel yet. {data.unavailable}. Set <code>PANEL_DOMAIN</code> and serve the panel
            over HTTPS, then switch it on.
          </div>
        )}
        {data.enabled && data.url && !data.unavailable && (
          <div>
            <div className="mb-1 text-sm font-medium text-neutral-700">Server URL</div>
            <CopyField value={data.url} tone="plain" />
            <p className="mt-1 text-xs text-neutral-500">
              The address to give an app. It signs in with the panel, or sends an{' '}
              <Link className="underline" to="/api-keys">
                API key
              </Link>{' '}
              as a Bearer token — at that key&apos;s level.
            </p>
          </div>
        )}
      </div>
    </Card>
  );
}

function ConnectCard({
  data,
  busy,
  onOpen,
  onClose,
  onDiscard,
}: {
  data: McpPageDto;
  busy: boolean;
  onOpen: () => void;
  onClose: () => void;
  onDiscard: () => void;
}) {
  const open = data.window;
  return (
    <Card
      title="Connect an app"
      action={
        open?.byMe ? (
          <Button small variant="secondary" onClick={onClose} disabled={busy}>
            Cancel
          </Button>
        ) : (
          <Button small onClick={onOpen} disabled={busy || (open !== null && !open.byMe)}>
            Connect an app
          </Button>
        )
      }
    >
      {open ? (
        <WindowStatus open={open} busy={busy} onDiscard={onDiscard} />
      ) : (
        <p className="measure text-sm text-neutral-600">
          Press <b>Connect an app</b>, then add the server URL in the app. For the next ten minutes one app may sign
          up here and you may approve it, once. At any other time the panel refuses — so nobody can get an app
          approved by sending you a link.
        </p>
      )}
    </Card>
  );
}

function WindowStatus({ open, busy, onDiscard }: { open: McpWindowDto; busy: boolean; onDiscard: () => void }) {
  const left = useCountdown(open.until);
  if (!open.byMe) {
    return (
      <p className="text-sm text-neutral-600">
        {open.openedBy ?? 'Another admin'} is connecting an app ({left} left). Only they can approve it.
      </p>
    );
  }
  return (
    <div className="space-y-2 text-sm">
      <p className="flex items-center gap-2 font-medium text-neutral-800">
        <span className="inline-block h-2 w-2 animate-pulse rounded-full bg-emerald-500" />
        Open for {left}
      </p>
      {open.registered ? (
        <div className="flex flex-wrap items-start justify-between gap-3">
          <p className="measure text-neutral-600">
            “{open.registered.name}” registered, returning to <b>{open.registered.redirectHosts.join(', ')}</b>. Approve
            it on the page the app opens in your browser. Not the app you are connecting? Discard it: the window stays
            open for the right one.
          </p>
          <Button small variant="secondary" onClick={onDiscard} disabled={busy}>
            Discard
          </Button>
        </div>
      ) : (
        <p className="text-neutral-600">Waiting for an app to sign up. Add the server URL in the app now.</p>
      )}
    </div>
  );
}

function useCountdown(until: number): string {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);
  const seconds = Math.max(0, Math.round((until - now) / 1000));
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;
}

// ------------------------------------------------------------------ setup per app

type AppId = 'claude' | 'chatgpt' | 'claude-code' | 'cursor' | 'vscode' | 'other';

const APPS: { id: AppId; label: string }[] = [
  { id: 'claude', label: 'Claude' },
  { id: 'chatgpt', label: 'ChatGPT' },
  { id: 'claude-code', label: 'Claude Code' },
  { id: 'cursor', label: 'Cursor' },
  { id: 'vscode', label: 'VS Code' },
  { id: 'other', label: 'Other' },
];

function Code({ children }: { children: string }) {
  return <pre className="overflow-x-auto rounded-lg bg-neutral-100 p-3 text-xs">{children}</pre>;
}

function SetupCard({ url }: { url: string }) {
  const [app, setApp] = useState<AppId>('claude');
  // What the snippets call this panel in the app.
  const suggested = mcpServerName(url);
  const [typed, setTyped] = useState(suggested);
  const name = typed || suggested;
  const key = 'wpl7_…';
  const steps: Record<AppId, React.ReactNode> = {
    claude: (
      <ol className="list-decimal space-y-1.5 pl-5">
        <li>Press <b>Connect an app</b> above.</li>
        <li>
          In Claude (claude.ai or the desktop app): <b>Settings → Connectors → Add custom connector</b>. Name it{' '}
          <b>{name}</b> and paste the server URL.
        </li>
        <li>Press <b>Connect</b>. Claude opens this panel: check the address it returns to, pick the access, approve.</li>
      </ol>
    ),
    chatgpt: (
      <ol className="list-decimal space-y-1.5 pl-5">
        <li>Press <b>Connect an app</b> above.</li>
        <li>
          In ChatGPT, turn on developer mode under <b>Settings → Connectors → Advanced</b>, then create a connector
          named <b>{name}</b> with the server URL and <b>OAuth</b> as its authentication.
        </li>
        <li>Connect it, and approve it on the page it opens here.</li>
      </ol>
    ),
    'claude-code': (
      <div className="space-y-2">
        <p>Sign in with the panel — press <b>Connect an app</b> first, then run <code>/mcp</code> in Claude Code and choose Authenticate:</p>
        <Code>{`claude mcp add --transport http ${name} ${url}`}</Code>
        <p>Or with an API key, which needs no sign-in:</p>
        <Code>{`claude mcp add --transport http ${name} ${url} \\\n  --header "Authorization: Bearer ${key}"`}</Code>
      </div>
    ),
    cursor: (
      <div className="space-y-2">
        <p>
          In <code>~/.cursor/mcp.json</code>. Press <b>Connect an app</b> first; Cursor asks to sign in when it starts
          the server.
        </p>
        <Code>{JSON.stringify({ mcpServers: { [name]: { url } } }, null, 2)}</Code>
        <p>With an API key instead:</p>
        <Code>{JSON.stringify({ mcpServers: { [name]: { url, headers: { Authorization: `Bearer ${key}` } } } }, null, 2)}</Code>
      </div>
    ),
    vscode: (
      <div className="space-y-2">
        <p>
          In <code>.vscode/mcp.json</code>, or MCP: Add Server. Press <b>Connect an app</b> first; VS Code asks to sign
          in when it starts the server.
        </p>
        <Code>{JSON.stringify({ servers: { [name]: { type: 'http', url } } }, null, 2)}</Code>
        <p>With an API key instead:</p>
        <Code>{JSON.stringify({ servers: { [name]: { type: 'http', url, headers: { Authorization: `Bearer ${key}` } } } }, null, 2)}</Code>
      </div>
    ),
    other: (
      <div className="space-y-2">
        <p>
          Any app that speaks MCP over HTTP: give it the server URL. It either signs in with OAuth — dynamic client
          registration and PKCE, inside a connection window — or sends an API key as{' '}
          <code>Authorization: Bearer {key}</code>.
        </p>
        <p className="text-xs text-neutral-500">The details, and what each tool does, are in docs/mcp.md.</p>
      </div>
    ),
  };
  return (
    <Card title="Setting up an app">
      <div className="space-y-4 text-sm text-neutral-600">
        <Segmented options={APPS} value={app} onChange={setApp} small label="App" />
        {app !== 'other' && (
          <Field
            label="Name in the app"
            width="sm"
            hint="An app can connect to several panels, each under a name of its own. This one is named after its domain."
          >
            <input
              className={`${inputClass} font-mono`}
              value={typed}
              placeholder={suggested}
              spellCheck={false}
              // It goes into a shell command as it is.
              onChange={(e) => setTyped(e.target.value.replace(/[^A-Za-z0-9_-]+/g, '-'))}
            />
          </Field>
        )}
        {steps[app]}
      </div>
    </Card>
  );
}

// ------------------------------------------------------------------ connected apps

function ConnectionsCard({
  connections,
  onAccess,
  onRevoke,
}: {
  connections: McpConnectionDto[];
  onAccess: (id: number, access: AccessLevel) => void;
  onRevoke: (id: number) => void;
}) {
  const [revoking, setRevoking] = useState<McpConnectionDto | null>(null);
  return (
    <Card title="Connected apps">
      {connections.length === 0 ? (
        <EmptyState>No apps connected by sign-in. Apps using an API key are on the API keys page.</EmptyState>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="text-left text-xs uppercase tracking-wide text-neutral-400">
                <th className="pb-2 pr-3">App</th>
                <th className="pb-2 pr-3">Approved by</th>
                <th className="pb-2 pr-3">Access</th>
                <th className="pb-2 pr-3">Connected</th>
                <th className="pb-2 pr-3">Last used</th>
                <th className="pb-2" />
              </tr>
            </thead>
            <tbody>
              {connections.map((c) => (
                <tr key={c.id} className="border-t border-neutral-100 align-middle">
                  <td className="py-2.5 pr-3">
                    <div className="font-medium">“{c.app}”</div>
                    <div className="text-xs text-neutral-500">returns to {c.redirectHost}</div>
                  </td>
                  <td className="py-2.5 pr-3 text-xs">{c.approvedBy.username}</td>
                  <td className="py-2.5 pr-3">
                    <select
                      className={`${inputClass} w-32 py-1 text-xs`}
                      aria-label={`Access of ${c.app}`}
                      value={c.access}
                      onChange={(e) => onAccess(c.id, e.target.value as AccessLevel)}
                    >
                      {accessLevels.map((level) => (
                        <option key={level} value={level}>
                          {ACCESS_LABELS[level]}
                        </option>
                      ))}
                    </select>
                  </td>
                  <td className="py-2.5 pr-3 text-xs text-neutral-500">{formatDate(c.createdAt)}</td>
                  <td className="py-2.5 pr-3 text-xs text-neutral-500">{c.lastUsedAt ? timeAgo(c.lastUsedAt) : 'never'}</td>
                  <td className="py-2.5 text-right">
                    <Button small variant="ghost" onClick={() => setRevoking(c)}>
                      Revoke
                    </Button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {revoking && (
        <ConfirmDialog
          title="Revoke connection"
          message={`“${revoking.app}” stops working at once. To connect it again, it has to sign in and be approved again.`}
          confirmLabel="Revoke"
          onConfirm={() => onRevoke(revoking.id)}
          onClose={() => setRevoking(null)}
        />
      )}
    </Card>
  );
}

function ActivityCard({ data }: { data: McpPageDto }) {
  return (
    <Card
      title="Recent calls"
      action={
        <Link className="text-xs text-neutral-500 hover:underline" to="/api-keys">
          All API activity →
        </Link>
      }
    >
      {data.activity.length === 0 ? (
        <EmptyState>Nothing yet: what the apps do through MCP shows up here.</EmptyState>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="text-left text-xs uppercase tracking-wide text-neutral-400">
                <th className="pb-2 pr-3">When</th>
                <th className="pb-2 pr-3">Who</th>
                <th className="pb-2 pr-3">Tool</th>
                <th className="pb-2 pr-3">Request</th>
                <th className="pb-2 text-right">Status</th>
              </tr>
            </thead>
            <tbody>
              {data.activity.map((e) => (
                <tr key={e.id} className="border-t border-neutral-100">
                  <td className="py-2 pr-3 text-xs whitespace-nowrap text-neutral-500">{timeAgo(e.ts)}</td>
                  <td className="py-2 pr-3 text-xs">{e.keyName || `${e.keyPrefix}…`}</td>
                  <td className="py-2 pr-3 font-mono text-[11px] text-neutral-500">{e.tool ?? '–'}</td>
                  <td className="py-2 pr-3 font-mono text-[11px] break-all">
                    {e.method} {e.path}
                    {e.jobId !== null && (
                      <Link className="ml-2 font-sans text-neutral-500 underline" to={`/jobs/${e.jobId}`}>
                        job #{e.jobId}
                      </Link>
                    )}
                  </td>
                  <td className={`py-2 text-right text-xs ${e.status >= 400 ? 'text-red-700' : 'text-neutral-600'}`}>
                    {e.status}
                    {e.errorCode ? ` ${e.errorCode}` : ''}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Card>
  );
}
