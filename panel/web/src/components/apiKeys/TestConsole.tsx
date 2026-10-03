import { useState } from 'react';
import { Link } from 'react-router';
import type { ApiMethod } from '../../../../shared/apiDocs';
import { curlSnippet } from '../../../../shared/apiDocs';
import { Button, Card, ConfirmDialog, Field, inputClass, Spinner, Toggle } from '../ui';

export interface ConsoleRequest {
  method: ApiMethod;
  path: string;
  body: string;
}

interface ConsoleResponse {
  status: number;
  statusText: string;
  ms: number;
  body: string;
  /** Parsed out of the body when it is JSON, for the job shortcut. */
  jobId: number | null;
}

const METHODS: ApiMethod[] = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'];

/** Anything still holding a `:param` would be sent literally and 404 or worse. */
function placeholdersIn(path: string): string[] {
  return [...path.matchAll(/:([a-zA-Z]+)/g)].map((m) => m[0]);
}

/**
 * Runs a real request against this panel, from the browser.
 *
 * Two ways to authenticate, and the difference matters: **this browser session** is the
 * cookie you are already signed in with, and **API key** sends a Bearer token with the
 * cookie deliberately omitted - so a 401 means the key is wrong rather than the session
 * quietly answering for it. A key request is also the only one that lands in the Activity
 * tab, which makes "paste the key, send one GET" the fastest way to prove a key works.
 *
 * Nothing here is a sandbox: a DELETE deletes. Mutating methods ask first.
 */
export function TestConsole({
  request,
  onChange,
}: {
  request: ConsoleRequest;
  onChange: (req: ConsoleRequest) => void;
}) {
  const [useKey, setUseKey] = useState(false);
  const [token, setToken] = useState('');
  const [busy, setBusy] = useState(false);
  const [response, setResponse] = useState<ConsoleResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [confirming, setConfirming] = useState(false);
  const [copied, setCopied] = useState(false);

  const missing = placeholdersIn(request.path);
  const bodyAllowed = request.method !== 'GET';
  const bodyBroken = bodyAllowed && request.body.trim() !== '' && !isJson(request.body);
  const ready = request.path.startsWith('/api/') && missing.length === 0 && !bodyBroken && (!useKey || !!token.trim());

  const send = async () => {
    setBusy(true);
    setError(null);
    setResponse(null);
    const started = performance.now();
    try {
      const headers: Record<string, string> = {};
      if (useKey) headers.authorization = `Bearer ${token.trim()}`;
      else if (request.method !== 'GET') headers['x-csrf'] = '1';
      let body: string | undefined;
      if (bodyAllowed && request.body.trim()) {
        headers['content-type'] = 'application/json';
        body = request.body;
      }
      const res = await fetch(request.path, {
        method: request.method,
        headers,
        body,
        // A key must stand on its own: sending the cookie too would make every key look
        // valid, which is the one thing this console is used to check.
        credentials: useKey ? 'omit' : 'same-origin',
      });
      const ms = Math.round(performance.now() - started);
      const type = res.headers.get('content-type') ?? '';
      if (type && !/json|text|xml/.test(type)) {
        setResponse({
          status: res.status,
          statusText: res.statusText,
          ms,
          jobId: null,
          body: `${type} · ${res.headers.get('content-length') ?? 'unknown'} bytes — not shown`,
        });
        return;
      }
      const text = await res.text();
      let pretty = text;
      let jobId: number | null = null;
      try {
        const parsed = JSON.parse(text) as { job?: { id?: number } };
        pretty = JSON.stringify(parsed, null, 2);
        jobId = typeof parsed?.job?.id === 'number' ? parsed.job.id : null;
      } catch {
        /* not JSON: show it as it came */
      }
      setResponse({ status: res.status, statusText: res.statusText, ms, body: pretty, jobId });
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  const curl = curlSnippet({
    method: request.method,
    path: request.path,
    baseUrl: location.origin,
    token: useKey ? token.trim() : '',
    body: bodyAllowed ? request.body : '',
  });

  return (
    <Card
      title="Console"
      action={
        <span className="text-xs text-neutral-400">Requests are real — this is your panel, not a sandbox</span>
      }
    >
      <div className="space-y-4">
        <div className="flex flex-wrap items-end gap-2">
          {/* Fixed width on the wrapper, not the control: inputClass is w-full, and two
              width utilities on one element resolve by stylesheet order rather than intent. */}
          <div className="w-28 shrink-0">
            <select
              className={`${inputClass} font-mono`}
              value={request.method}
              onChange={(e) => onChange({ ...request, method: e.target.value as ApiMethod })}
            >
              {METHODS.map((m) => (
                <option key={m} value={m}>
                  {m}
                </option>
              ))}
            </select>
          </div>
          <input
            className={`${inputClass} min-w-[18rem] flex-1 font-mono`}
            value={request.path}
            spellCheck={false}
            onChange={(e) => onChange({ ...request, path: e.target.value })}
            placeholder="/api/sites"
          />
          <Button disabled={!ready || busy} onClick={() => (request.method === 'GET' ? void send() : setConfirming(true))}>
            {busy ? <Spinner /> : 'Send'}
          </Button>
        </div>

        {missing.length > 0 && (
          <p className="text-xs text-amber-700">
            Replace {missing.join(', ')} with a real value before sending.
          </p>
        )}

        {bodyAllowed && (
          <Field
            label="Body (JSON)"
            width="full"
            hint={bodyBroken ? undefined : 'Leave empty for endpoints that take none.'}
          >
            <textarea
              className={`${inputClass} h-32 font-mono text-xs`}
              value={request.body}
              spellCheck={false}
              onChange={(e) => onChange({ ...request, body: e.target.value })}
              placeholder="{ }"
            />
          </Field>
        )}
        {bodyBroken && <p className="text-xs text-red-700">That is not valid JSON.</p>}

        <div className="rounded-lg border border-neutral-200 p-3">
          <Toggle
            checked={useKey}
            onChange={(v) => {
              setUseKey(v);
              setResponse(null);
            }}
            label="Send as an API key instead of this browser session"
          />
          {useKey ? (
            <div className="mt-3">
              <Field
                label="Token"
                width="lg"
                hint="Only kept in this tab, and never sent anywhere but your own panel. Shown once at creation — make a throwaway key if you no longer have it."
              >
                <input
                  className={`${inputClass} font-mono`}
                  type="password"
                  autoComplete="off"
                  spellCheck={false}
                  placeholder="wpl7_…"
                  value={token}
                  onChange={(e) => setToken(e.target.value)}
                />
              </Field>
            </div>
          ) : (
            <p className="mt-2 text-xs text-neutral-500">
              Your session has the same access a key does, so this answers the same way — it just does not show up
              in the Activity tab, which only records key requests.
            </p>
          )}
        </div>

        <div className="flex items-center justify-between gap-3">
          <span className="text-xs text-neutral-500">
            Same call from a terminal{useKey && token.trim() ? '' : ' (fill in a token)'}:
          </span>
          <Button
            small
            variant="secondary"
            onClick={() => {
              void navigator.clipboard.writeText(curl);
              setCopied(true);
              setTimeout(() => setCopied(false), 1500);
            }}
          >
            {copied ? 'Copied!' : 'Copy as curl'}
          </Button>
        </div>
        <pre className="overflow-x-auto rounded-lg bg-neutral-100 p-3 text-xs">{curl}</pre>

        {error && <div className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">{error}</div>}

        {response && (
          <div className="space-y-2">
            <div className="flex flex-wrap items-center gap-3 text-sm">
              <span
                className={`rounded-full px-2 py-0.5 text-[11px] font-semibold ${
                  response.status < 400
                    ? 'bg-emerald-100 text-emerald-800'
                    : response.status === 401 || response.status === 403
                      ? 'bg-amber-100 text-amber-800'
                      : 'bg-red-100 text-red-800'
                }`}
              >
                {response.status} {response.statusText}
              </span>
              <span className="text-xs text-neutral-500">{response.ms} ms</span>
              {response.jobId !== null && (
                <Link className="text-xs underline" to={`/jobs/${response.jobId}`}>
                  Follow job #{response.jobId} →
                </Link>
              )}
            </div>
            <pre className="max-h-80 overflow-auto rounded-lg bg-neutral-100 p-3 text-xs">{response.body}</pre>
          </div>
        )}
      </div>

      {confirming && (
        <ConfirmDialog
          title={`${request.method} ${request.path}`}
          message={
            <>
              This runs for real against this panel — it can create, change or delete things. Send it?
            </>
          }
          confirmLabel="Send"
          onConfirm={() => void send()}
          onClose={() => setConfirming(false)}
        />
      )}
    </Card>
  );
}

function isJson(text: string): boolean {
  try {
    JSON.parse(text);
    return true;
  } catch {
    return false;
  }
}
