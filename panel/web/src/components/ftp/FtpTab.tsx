// @docs sites/ftp-sftp
import { useEffect, useState, type ReactNode } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import type { SiteFtpDto, SiteFtpUserCreatedDto, SiteFtpUserDto } from '../../../../shared/types';
import { ftpPasswordSchema, ftpUsernameSchema } from '../../../../shared/schemas';
import { parseSiteFilePath } from '../../../../shared/siteFilePath';
import { api } from '../../api/client';
import { useSiteFtp } from '../../api/hooks';
import { Button, Card, ConfirmDialog, CopyField, EmptyState, ErrorNote, Field, inputClass, Modal, Spinner } from '../ui';
import { formatDate, timeAgo } from '../../lib/format';
import { ftpOffBanner, siteFtpStatus } from '../../lib/ftpStatus';

/**
 * FTP & SFTP logins for one site: how to connect, and who can.
 *
 * Each login reaches only this site's files, through a file server that has nothing else
 * mounted (services/ftp.ts) - which is why none of this needs a warning about other sites.
 */
export function FtpTab({ slug }: { slug: string }) {
  const ftp = useSiteFtp(slug);
  const qc = useQueryClient();
  const [dialog, setDialog] = useState<
    { kind: 'add' } | { kind: 'edit' | 'password' | 'delete'; id: number } | null
  >(null);
  const [error, setError] = useState<unknown>(null);
  const refresh = () => qc.invalidateQueries({ queryKey: ['site-ftp', slug] });

  if (ftp.isError && !ftp.data) return <ErrorNote error={ftp.error} />;
  if (!ftp.data) return <Spinner />;
  const f = ftp.data;
  // Looked up by id, so a refresh that no longer has the login closes its dialog.
  const target = dialog && dialog.kind !== 'add' ? f.users.find((u) => u.id === dialog.id) : undefined;
  const off = ftpOffBanner(f);

  return (
    <div className="space-y-4">
      <ErrorNote error={error} />
      {ftp.isError && <ErrorNote error={ftp.error} />}
      {off && (
        <div
          className={`rounded-lg border px-3 py-2 text-sm ${
            off.tone === 'red' ? 'border-red-300 bg-red-50 text-red-900' : 'border-amber-300 bg-amber-50 text-amber-900'
          }`}
        >
          {off.text}
        </div>
      )}

      <Card
        title={f.users.length === 0 ? 'Logins' : `${f.users.length} login${f.users.length === 1 ? '' : 's'}`}
        action={
          <Button small onClick={() => { setError(null); setDialog({ kind: 'add' }); }}>
            Add login
          </Button>
        }
      >
        {f.users.length === 0 ? (
          <EmptyState>
            No FTP or SFTP logins. Add one to give a customer or a developer their own access to this site&apos;s
            files - and only this site&apos;s. Nothing listens for FTP on &ldquo;{f.serverName}&rdquo; until one of
            its sites has a login.
          </EmptyState>
        ) : (
          <LoginsTable
            users={f.users}
            onEdit={(id) => setDialog({ kind: 'edit', id })}
            onPassword={(id) => setDialog({ kind: 'password', id })}
            onDelete={(id) => setDialog({ kind: 'delete', id })}
          />
        )}
      </Card>

      <ConnectionCard ftp={f} />

      {dialog?.kind === 'add' && (
        <AddLoginDialog slug={slug} ftp={f} onDone={() => void refresh()} onClose={() => setDialog(null)} />
      )}
      {dialog?.kind === 'edit' && target && (
        <EditLoginDialog slug={slug} user={target} onDone={() => void refresh()} onClose={() => setDialog(null)} />
      )}
      {dialog?.kind === 'password' && target && (
        <PasswordDialog slug={slug} ftp={f} user={target} onDone={() => void refresh()} onClose={() => setDialog(null)} />
      )}
      {dialog?.kind === 'delete' && target && (
        <ConfirmDialog
          title={`Delete login "${target.username}"`}
          message={
            <>
              It cannot sign in again. Any FTP or SFTP session open on this site ends too - the other logins&apos;
              clients reconnect by themselves.
            </>
          }
          confirmLabel="Delete login"
          onConfirm={() => {
            setError(null);
            void api(`/api/sites/${slug}/ftp/users/${target.id}`, { method: 'DELETE' }).then(refresh).catch(setError);
          }}
          onClose={() => setDialog(null)}
        />
      )}
    </div>
  );
}

// ------------------------------------------------------------------ the logins

function LoginsTable({
  users,
  onEdit,
  onPassword,
  onDelete,
}: {
  users: SiteFtpUserDto[];
  onEdit: (id: number) => void;
  onPassword: (id: number) => void;
  onDelete: (id: number) => void;
}) {
  return (
    <table className="w-full text-sm">
      <thead>
        <tr className="text-left text-xs uppercase tracking-wide text-neutral-400">
          <th className="pb-2">Username</th>
          <th className="pb-2">Folder</th>
          <th className="pb-2">Expires</th>
          <th className="pb-2">Password set</th>
          <th className="pb-2">Created by</th>
          <th className="pb-2" />
        </tr>
      </thead>
      <tbody>
        {users.map((u) => (
          <tr key={u.id} className="border-t border-neutral-100">
            <td className="py-2.5 pr-3 font-mono text-xs font-medium">{u.username}</td>
            <td className="py-2.5 pr-3 text-xs">
              {u.folder ? <code className="break-all">{u.folder}</code> : <span className="text-neutral-500">whole site</span>}
            </td>
            <td className="py-2.5 pr-3 text-xs">
              {u.expiresAt === null ? (
                <span className="text-neutral-500">never</span>
              ) : u.expired ? (
                <span className="font-medium text-red-700">expired {timeAgo(u.expiresAt)}</span>
              ) : (
                <span title={formatDate(u.expiresAt)}>{formatDate(u.expiresAt)}</span>
              )}
            </td>
            <td className="py-2.5 pr-3 text-xs text-neutral-500">{timeAgo(u.passwordSetAt)}</td>
            <td className="py-2.5 pr-3 text-xs text-neutral-500">{u.createdBy ?? '–'}</td>
            <td className="whitespace-nowrap py-2.5 text-right">
              <Button small variant="ghost" onClick={() => onEdit(u.id)}>Edit</Button>
              <Button small variant="ghost" onClick={() => onPassword(u.id)}>Reset password</Button>
              <Button small variant="ghost" onClick={() => onDelete(u.id)}>Delete</Button>
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

// ------------------------------------------------------------------ connecting

const TONES = {
  ok: 'bg-emerald-100 text-emerald-800',
  busy: 'bg-amber-100 text-amber-800',
  bad: 'bg-red-100 text-red-800',
  idle: 'bg-neutral-200 text-neutral-700',
} as const;

function StatusPill({ f }: { f: SiteFtpDto }) {
  const s = siteFtpStatus(f);
  return (
    <span className={`inline-flex items-center gap-1.5 rounded-full px-2 py-0.5 text-[11px] font-semibold uppercase tracking-wide ${TONES[s.tone]}`}>
      <span className={`h-1.5 w-1.5 rounded-full bg-current ${s.tone === 'busy' ? 'animate-pulse' : ''}`} />
      {s.label}
    </span>
  );
}

function ConnectionCard({ ftp: f }: { ftp: SiteFtpDto }) {
  const s = siteFtpStatus(f);
  const e = f.endpoint;
  return (
    <Card title="How to connect" action={<StatusPill f={f} />}>
      <div className="space-y-4 text-sm">
        {s.detail && <p className={s.tone === 'bad' ? 'text-red-700' : 'text-neutral-600'}>{s.detail}</p>}

        <div className="grid gap-x-4 gap-y-3 sm:grid-cols-[7rem_1fr]">
          <Label>Host</Label>
          <div>
            {e.host ? (
              <div className="max-w-sm">
                <CopyField value={e.host} tone="plain" />
              </div>
            ) : (
              <p className="text-amber-800">
                &ldquo;{f.serverName}&rdquo; has no public IP address set (Servers → {f.serverName} → Edit settings).
              </p>
            )}
            <p className="mt-1 text-xs text-neutral-500">
              The server this site is on. A hostname that points straight at it works too - but not one behind a
              proxy such as Cloudflare&apos;s, which only carries web traffic.
            </p>
          </div>

          <Label>SFTP</Label>
          <div className="space-y-1">
            <p>
              Port <b>{e.sftp.port}</b>
            </p>
            {e.sftp.hostKeys.length > 0 && (
              <div className="text-xs text-neutral-500">
                The first time, the client asks to trust the server&apos;s key. It is one of these:
                <ul className="mt-1 space-y-0.5 font-mono text-neutral-700">
                  {e.sftp.hostKeys.map((k) => (
                    <li key={k.type} className="break-all">
                      {k.type} {k.fingerprint}
                    </li>
                  ))}
                </ul>
              </div>
            )}
          </div>

          <Label>FTP</Label>
          <div className="space-y-1">
            {e.ftp.available ? (
              <>
                <p>
                  Port <b>{e.ftp.port}</b> · explicit FTP over TLS (FTPS) - plain, unencrypted FTP is refused
                </p>
                <p className="text-xs text-neutral-500">
                  Data connections use ports {e.ftp.passivePorts.start}-{e.ftp.passivePorts.end} (passive mode).
                </p>
                {e.ftp.certFingerprint && (
                  <div className="text-xs text-neutral-500">
                    The certificate is the server&apos;s own, so the client asks to trust it once. Its SHA-256:
                    <div className="mt-1 break-all font-mono text-neutral-700">{e.ftp.certFingerprint}</div>
                  </div>
                )}
              </>
            ) : (
              <p className="text-neutral-600">{e.ftp.reason ?? 'Not offered.'} SFTP works as above.</p>
            )}
          </div>
        </div>

        <details className="rounded-lg border border-neutral-200 px-3 py-2 text-xs text-neutral-600">
          <summary className="cursor-pointer font-medium text-neutral-700">Client settings</summary>
          <ul className="mt-2 list-disc space-y-1 pl-4">
            <li>
              <b>FileZilla</b>: File → Site Manager → New site. Protocol <i>SFTP</i>, port {e.sftp.port}
              {e.ftp.available && (
                <>
                  {' '}
                  - or protocol <i>FTP</i> with encryption <i>Require explicit FTP over TLS</i>, port {e.ftp.port}
                </>
              )}
              . Logon type <i>Normal</i>.
            </li>
            <li>
              <b>WinSCP</b>: File protocol <i>SFTP</i>, port {e.sftp.port}
              {e.ftp.available && <> - or <i>FTP</i> with <i>TLS/SSL Explicit encryption</i>, port {e.ftp.port}</>}.
            </li>
            <li>
              <b>Command line</b>: <code>sftp -P {e.sftp.port} username@{e.host ?? 'host'}</code>
            </li>
          </ul>
          <p className="mt-2">
            An upload lands in place only once it is complete, so a dropped connection never leaves half a file
            behind.
          </p>
        </details>
      </div>
    </Card>
  );
}

const Label = ({ children }: { children: ReactNode }) => (
  <div className="pt-1 text-xs font-medium uppercase tracking-wide text-neutral-500">{children}</div>
);

/**
 * Everything a person needs to connect, for handing on. The password is here once: after a
 * login is made or its password reset, and never again.
 */
function Credentials({ ftp: f, username, password }: { ftp: SiteFtpDto; username: string; password: string }) {
  const e = f.endpoint;
  const host = e.host ?? `(the IP address of ${f.serverName})`;
  const all = [
    `Host: ${host}`,
    `SFTP: port ${e.sftp.port}`,
    ...(e.ftp.available ? [`FTP: port ${e.ftp.port}, explicit FTP over TLS (FTPS)`] : []),
    `Username: ${username}`,
    `Password: ${password}`,
    ...(e.sftp.hostKeys.length > 0 ? [`SFTP key fingerprint: ${e.sftp.hostKeys[0]!.fingerprint}`] : []),
  ].join('\n');
  return (
    <div className="space-y-3 text-sm">
      <div className="rounded-lg border-2 border-amber-400 bg-amber-50 p-3 text-amber-900">
        <b>Copy the password now.</b> It is shown only this once; the panel keeps a hash of it, not the password.
      </div>
      <div className="grid gap-x-3 gap-y-2 sm:grid-cols-[6rem_1fr]">
        <Label>Host</Label>
        <CopyField value={host} tone="plain" />
        <Label>Ports</Label>
        <p className="pt-1">
          SFTP {e.sftp.port}
          {e.ftp.available && <> · FTPS {e.ftp.port}</>}
        </p>
        <Label>Username</Label>
        <CopyField value={username} tone="plain" />
        <Label>Password</Label>
        <CopyField value={password} />
      </div>
      <CopyAll text={all} />
    </div>
  );
}

function CopyAll({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    if (!copied) return;
    const t = setTimeout(() => setCopied(false), 1500);
    return () => clearTimeout(t);
  }, [copied]);
  return (
    <Button
      small
      variant="secondary"
      onClick={() => {
        void navigator.clipboard.writeText(text);
        setCopied(true);
      }}
    >
      {copied ? 'Copied!' : 'Copy all connection details'}
    </Button>
  );
}

// ------------------------------------------------------------------ dialogs

/** The site's own name for its first login, then `<slug>-2`, `<slug>-3`… (at most 32 characters). */
function suggestUsername(slug: string, users: SiteFtpUserDto[]): string {
  const taken = new Set(users.map((u) => u.username));
  if (!taken.has(slug)) return slug;
  for (let n = 2; ; n++) {
    const suffix = `-${n}`;
    const name = `${slug.slice(0, 32 - suffix.length)}${suffix}`;
    if (!taken.has(name)) return name;
  }
}

/** A date input's value <-> the end of that day, in the browser's time zone. */
const endOfDay = (date: string): number => new Date(`${date}T23:59:59`).getTime();
const dateInput = (ms: number | null): string => {
  if (ms === null) return '';
  const d = new Date(ms);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};
const today = () => dateInput(Date.now());

function FolderField({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  const parsed = parseSiteFilePath(value.trim());
  return (
    <Field
      label="Folder"
      width="lg"
      hint={
        parsed.ok ? (
          <>
            Keeps the login inside this folder of the site, e.g. <code>wp-content/themes/child</code>. Empty = the whole
            site. A convenience, not a wall: PHP uploaded there can still reach the rest of the site once it runs.
          </>
        ) : (
          <span className="text-red-700">{parsed.problem}</span>
        )
      }
    >
      <input className={inputClass} value={value} placeholder="whole site" onChange={(e) => onChange(e.target.value)} />
    </Field>
  );
}

function ExpiryField({ value, onChange, hint }: { value: string; onChange: (v: string) => void; hint?: string }) {
  return (
    <Field label="Expires" width="sm" hint={hint ?? 'Optional. Access stops at the end of that day, your time.'}>
      <input className={inputClass} type="date" min={today()} value={value} onChange={(e) => onChange(e.target.value)} />
    </Field>
  );
}

function PasswordChoice({
  own,
  setOwn,
  password,
  setPassword,
}: {
  own: boolean;
  setOwn: (v: boolean) => void;
  password: string;
  setPassword: (v: string) => void;
}) {
  const tooShort = own && password.length > 0 && !ftpPasswordSchema.safeParse(password).success;
  return (
    <div className="space-y-2">
      <span className="block text-sm font-medium text-neutral-700">Password</span>
      <label className="flex items-center gap-2 text-sm">
        <input type="radio" checked={!own} onChange={() => setOwn(false)} />
        Generate one (24 characters, shown once)
      </label>
      <label className="flex items-center gap-2 text-sm">
        <input type="radio" checked={own} onChange={() => setOwn(true)} />
        Choose one
      </label>
      {own && (
        <div className="field-control max-w-sm pl-6">
          <input
            className={inputClass}
            type="password"
            autoComplete="new-password"
            aria-label="Password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
          />
          <span className={`mt-1 block text-xs ${tooShort ? 'text-red-700' : 'text-neutral-500'}`}>At least 12 characters.</span>
        </div>
      )}
    </div>
  );
}

function AddLoginDialog({
  slug,
  ftp,
  onDone,
  onClose,
}: {
  slug: string;
  ftp: SiteFtpDto;
  onDone: () => void;
  onClose: () => void;
}) {
  const [username, setUsername] = useState(() => suggestUsername(slug, ftp.users));
  const [own, setOwn] = useState(false);
  const [password, setPassword] = useState('');
  const [folder, setFolder] = useState('');
  const [expires, setExpires] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [created, setCreated] = useState<{ username: string; password: string } | null>(null);

  const nameOk = ftpUsernameSchema.safeParse(username).success;
  const folderOk = parseSiteFilePath(folder.trim()).ok;
  const passwordOk = !own || ftpPasswordSchema.safeParse(password).success;

  const submit = async () => {
    setBusy(true);
    setError(null);
    try {
      const res = await api<SiteFtpUserCreatedDto>(`/api/sites/${slug}/ftp/users`, {
        method: 'POST',
        body: {
          username,
          ...(own ? { password } : {}),
          folder: folder.trim(),
          expiresAt: expires ? endOfDay(expires) : null,
        },
      });
      onDone();
      if (res.password) setCreated({ username: res.user.username, password: res.password });
      else onClose();
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      title={created ? `Login "${created.username}" created` : 'New FTP / SFTP login'}
      onClose={onClose}
      // The password is shown once; only the button may put it away.
      dismissible={!created}
    >
      {created ? (
        <div className="space-y-4">
          <Credentials ftp={ftp} username={created.username} password={created.password} />
          <div className="flex justify-end">
            <Button onClick={onClose}>I have saved it</Button>
          </div>
        </div>
      ) : (
        <form
          className="space-y-4"
          onSubmit={(e) => {
            e.preventDefault();
            if (nameOk && folderOk && passwordOk && !busy) void submit();
          }}
        >
          <Field
            label="Username"
            hint={
              nameOk || username === ''
                ? 'Unique across the whole panel. 3-32 characters: a-z, 0-9 and . _ -'
                : <span className="text-red-700">3-32 characters of a-z, 0-9 and . _ -, starting and ending with a letter or digit.</span>
            }
          >
            <input className={inputClass} value={username} onChange={(e) => setUsername(e.target.value)} autoFocus />
          </Field>
          <PasswordChoice own={own} setOwn={setOwn} password={password} setPassword={setPassword} />
          <FolderField value={folder} onChange={setFolder} />
          <ExpiryField value={expires} onChange={setExpires} />
          <ErrorNote error={error} />
          <div className="flex justify-end gap-2">
            <Button variant="secondary" onClick={onClose}>Cancel</Button>
            <Button type="submit" disabled={!nameOk || !folderOk || !passwordOk || busy}>
              {busy ? 'Creating…' : 'Create login'}
            </Button>
          </div>
        </form>
      )}
    </Modal>
  );
}

function EditLoginDialog({
  slug,
  user,
  onDone,
  onClose,
}: {
  slug: string;
  user: SiteFtpUserDto;
  onDone: () => void;
  onClose: () => void;
}) {
  const [folder, setFolder] = useState(user.folder);
  const initialExpiry = dateInput(user.expiresAt);
  const [expires, setExpires] = useState(initialExpiry);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const folderOk = parseSiteFilePath(folder.trim()).ok;

  const save = async () => {
    // Only what was changed: moving an expired login to another folder must not quietly
    // take its expiry away with it.
    const body = {
      ...(folder.trim() !== user.folder ? { folder: folder.trim() } : {}),
      ...(expires !== initialExpiry ? { expiresAt: expires ? endOfDay(expires) : null } : {}),
    };
    if (Object.keys(body).length === 0) {
      onClose();
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await api(`/api/sites/${slug}/ftp/users/${user.id}`, { method: 'PATCH', body });
      onDone();
      onClose();
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal title={`Edit login "${user.username}"`} onClose={onClose}>
      {/* noValidate: an expired login arrives with a date before `min`, which must not block a folder change. */}
      <form
        noValidate
        className="space-y-4"
        onSubmit={(e) => {
          e.preventDefault();
          if (folderOk && !busy) void save();
        }}
      >
        <FolderField value={folder} onChange={setFolder} />
        <ExpiryField
          value={expires}
          onChange={setExpires}
          hint={
            user.expired
              ? 'It has expired. Pick a new day to let it in again, or clear the date for no expiry.'
              : 'Access stops at the end of that day, your time. Clear it for no expiry.'
          }
        />
        <p className="text-xs text-neutral-500">
          Saving ends any FTP or SFTP session open on this site; clients reconnect by themselves.
        </p>
        <ErrorNote error={error} />
        <div className="flex justify-end gap-2">
          <Button variant="secondary" onClick={onClose}>Cancel</Button>
          <Button type="submit" disabled={!folderOk || busy}>{busy ? 'Saving…' : 'Save'}</Button>
        </div>
      </form>
    </Modal>
  );
}

function PasswordDialog({
  slug,
  ftp,
  user,
  onDone,
  onClose,
}: {
  slug: string;
  ftp: SiteFtpDto;
  user: SiteFtpUserDto;
  onDone: () => void;
  onClose: () => void;
}) {
  const [own, setOwn] = useState(false);
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [generated, setGenerated] = useState<string | null>(null);
  const passwordOk = !own || ftpPasswordSchema.safeParse(password).success;

  const reset = async () => {
    setBusy(true);
    setError(null);
    try {
      const res = await api<SiteFtpUserCreatedDto>(`/api/sites/${slug}/ftp/users/${user.id}/password`, {
        method: 'POST',
        body: own ? { password } : {},
      });
      onDone();
      if (res.password) setGenerated(res.password);
      else onClose();
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal title={`New password for "${user.username}"`} onClose={onClose}>
      {generated ? (
        <div className="space-y-4">
          <Credentials ftp={ftp} username={user.username} password={generated} />
          <div className="flex justify-end">
            <Button onClick={onClose}>I have saved it</Button>
          </div>
        </div>
      ) : (
        <form
          className="space-y-4"
          onSubmit={(e) => {
            e.preventDefault();
            if (passwordOk && !busy) void reset();
          }}
        >
          <PasswordChoice own={own} setOwn={setOwn} password={password} setPassword={setPassword} />
          <p className="text-xs text-neutral-500">
            The old password stops working at once, and any FTP or SFTP session open on this site ends.
          </p>
          <ErrorNote error={error} />
          <div className="flex justify-end gap-2">
            <Button variant="secondary" onClick={onClose}>Cancel</Button>
            <Button type="submit" variant="danger" disabled={!passwordOk || busy}>
              {busy ? 'Setting…' : 'Set new password'}
            </Button>
          </div>
        </form>
      )}
    </Modal>
  );
}
