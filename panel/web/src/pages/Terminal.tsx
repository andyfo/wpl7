import { useEffect, useRef, useState } from 'react';
import { useNavigate, useParams } from 'react-router';
import { Terminal as XTerm } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import '@xterm/xterm/css/xterm.css';
import type { ServerDto, TerminalServerMsg } from '../../../shared/types';
import { useMeta, useServers } from '../api/hooks';
import { Button, EmptyState, inputClass, UpDot } from '../components/ui';
import { pickTerminalServer } from './terminalTarget';

type Phase = 'connecting' | 'open' | 'closed';

/** Which server the bare /terminal link opens next time. */
const LAST_SERVER_KEY = 'ceo.terminal.serverId';

const readLastServer = (): number | null => {
  const raw = Number(window.localStorage.getItem(LAST_SERVER_KEY));
  return Number.isInteger(raw) && raw > 0 ? raw : null;
};

/**
 * A root shell on **one server of the fleet**, chosen here.
 *
 * `/terminal` resolves to whichever server was used last (falling back to the default one)
 * and redirects to its canonical URL, so the address bar always names the machine the
 * keystrokes are going to - which for a root shell is not a detail. Switching servers
 * remounts the session rather than reusing the socket: half a torn-down PTY is not a state
 * worth engineering for.
 */
export function Terminal() {
  const { id } = useParams();
  const servers = useServers();
  const meta = useMeta();
  const navigate = useNavigate();
  const routeId = id === undefined ? null : Number(id);
  const list = servers.data ?? [];

  const target = pickTerminalServer(list, {
    remembered: readLastServer(),
    defaultServerId: meta.data?.defaultServerId,
    metaSettled: !meta.isPending,
  });

  useEffect(() => {
    if (routeId !== null || target === null) return;
    void navigate(`/servers/${target}/terminal`, { replace: true });
  }, [routeId, target, navigate]);

  useEffect(() => {
    if (routeId !== null && Number.isFinite(routeId)) window.localStorage.setItem(LAST_SERVER_KEY, String(routeId));
  }, [routeId]);

  if (routeId === null || !Number.isFinite(routeId)) {
    return (
      <div className="space-y-3">
        <h1 className="page-title">Terminal</h1>
        <EmptyState>
          {list.length === 0 && !servers.isPending ? 'No servers registered yet.' : 'Loading servers…'}
        </EmptyState>
      </div>
    );
  }
  // Keyed: a different server is a different session, not a reconfigured one.
  return <Session key={routeId} serverId={routeId} servers={list} />;
}

function Session({ serverId, servers }: { serverId: number; servers: ServerDto[] }) {
  const navigate = useNavigate();
  const server = servers.find((s) => s.id === serverId);
  const mountRef = useRef<HTMLDivElement>(null);
  const [phase, setPhase] = useState<Phase>('connecting');
  const [note, setNote] = useState<string>('Connecting…');
  // Bumped by the Reconnect button; never automatically - sshd sits behind
  // `ufw limit 22/tcp`, which a reconnect loop would trip within seconds.
  const [generation, setGeneration] = useState(0);

  useEffect(() => {
    const el = mountRef.current;
    if (!el || !Number.isFinite(serverId)) return;

    setPhase('connecting');
    setNote('Connecting…');

    const term = new XTerm({
      cursorBlink: true,
      fontSize: 13,
      fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace',
      theme: { background: '#0a0a0a' }, // tailwind neutral-950, matches the log viewers
      scrollback: 5000,
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(el);
    fit.fit();

    const proto = window.location.protocol === 'https:' ? 'wss' : 'ws';
    const ws = new WebSocket(
      `${proto}://${window.location.host}/api/servers/${serverId}/terminal?cols=${term.cols}&rows=${term.rows}`,
    );
    ws.binaryType = 'arraybuffer';
    const encoder = new TextEncoder();
    let sawServerMessage = false;

    ws.onmessage = (event: MessageEvent) => {
      sawServerMessage = true;
      if (typeof event.data !== 'string') {
        term.write(new Uint8Array(event.data as ArrayBuffer));
        return;
      }
      let msg: TerminalServerMsg;
      try {
        msg = JSON.parse(event.data) as TerminalServerMsg;
      } catch {
        return;
      }
      if (msg.t === 'status') {
        setNote(msg.message);
        term.writeln(`\x1b[90m${msg.message}\x1b[0m`);
      } else if (msg.t === 'ready') {
        setPhase('open');
        setNote(`root@${server?.name ?? `#${serverId}`}`);
        term.focus();
      } else if (msg.t === 'exit') {
        setNote(msg.code === null || msg.code === 0 ? 'Shell exited' : `Shell exited (code ${msg.code})`);
      } else if (msg.t === 'error') {
        setNote(msg.message);
        term.writeln(`\r\n\x1b[31m${msg.message}\x1b[0m`);
      }
    };
    ws.onclose = () => {
      setPhase('closed');
      if (!sawServerMessage) {
        // Rejected before the handshake (401/403/429) - the browser can't read
        // the HTTP response, so give the likely causes instead.
        setNote('Connection failed — are you still signed in?');
      }
    };

    const dataSub = term.onData((data) => {
      if (ws.readyState === WebSocket.OPEN) ws.send(encoder.encode(data));
    });
    const resizeSub = term.onResize(({ cols, rows }) => {
      if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ t: 'resize', cols, rows }));
    });
    const observer = new ResizeObserver(() => fit.fit());
    observer.observe(el);

    return () => {
      observer.disconnect();
      dataSub.dispose();
      resizeSub.dispose();
      ws.close();
      term.dispose();
    };
    // Reconnect by design only via `generation`; server rename must not re-open the shell.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [serverId, generation]);

  return (
    <div className="flex h-[calc(100vh-7rem)] min-h-[320px] flex-col space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="min-w-0">
          <h1 className="page-title">Terminal</h1>
          <div className="flex items-center gap-1.5 text-xs text-neutral-500">
            <UpDot up={server === undefined ? null : server.status === 'ok'} />
            <span>
              {server === undefined
                ? `server #${serverId}`
                : server.kind === 'local'
                  ? `this machine · ${server.publicIp || 'no public IP'}`
                  : `root@${server.sshHost ?? server.publicIp}:${server.sshPort}`}
            </span>
            <span>·</span>
            <span className={phase === 'open' ? 'text-emerald-600' : phase === 'closed' ? 'text-red-600' : ''}>
              {note}
            </span>
          </div>
        </div>
        <div className="flex items-center gap-2">
          <label className="whitespace-nowrap text-xs text-neutral-500" htmlFor="terminal-server">
            Connect to
          </label>
          <select
            id="terminal-server"
            className={`${inputClass} w-auto`}
            value={serverId}
            onChange={(e) => void navigate(`/servers/${e.target.value}/terminal`)}
          >
            {servers.length === 0 && <option value={serverId}>server #{serverId}</option>}
            {servers.map((s) => (
              <option key={s.id} value={s.id}>
                {serverLabel(s)}
              </option>
            ))}
          </select>
          {phase === 'closed' && <Button onClick={() => setGeneration((g) => g + 1)}>Reconnect</Button>}
        </div>
      </div>
      <div className="min-h-0 flex-1 overflow-hidden rounded-xl bg-neutral-950 p-2">
        <div ref={mountRef} className="h-full w-full" />
      </div>
    </div>
  );
}

/**
 * Server 1 runs the panel and usually hosts sites as well, so it is named for both roles
 * rather than being listed apart - the picker is one flat list of machines.
 */
function serverLabel(s: ServerDto): string {
  const parts = [s.kind === 'local' ? 'panel host' : 'hosting server'];
  parts.push(`${s.sitesCount} site${s.sitesCount === 1 ? '' : 's'}`);
  if (s.status !== 'ok') parts.push(s.status);
  return `${s.name} — ${parts.join(', ')}`;
}
