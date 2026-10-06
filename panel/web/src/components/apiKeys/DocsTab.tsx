// @docs integrations/api
import { useMemo, useRef, useState } from 'react';
import {
  API_DOC_GROUPS,
  API_DOC_RECIPES,
  API_ERROR_CODES,
  curlSnippet,
  type ApiDocEndpoint,
  type ApiMethod,
} from '../../../../shared/apiDocs';
import { ACCESS_LABELS, ACCESS_SUMMARIES } from '../../../../shared/access';
import { AccessBadge } from '../AccessPicker';
import { Button, Card, EmptyState, inputClass } from '../ui';
import { TestConsole, type ConsoleRequest } from './TestConsole';

const METHOD_COLORS: Record<ApiMethod, string> = {
  GET: 'bg-sky-100 text-sky-800',
  POST: 'bg-emerald-100 text-emerald-800',
  PUT: 'bg-amber-100 text-amber-800',
  PATCH: 'bg-amber-100 text-amber-800',
  DELETE: 'bg-red-100 text-red-800',
};

function MethodBadge({ method }: { method: ApiMethod }) {
  return (
    <span className={`inline-block w-16 rounded px-1.5 py-0.5 text-center text-[10px] font-bold ${METHOD_COLORS[method]}`}>
      {method}
    </span>
  );
}

function CodeBlock({ children }: { children: string }) {
  return <pre className="overflow-x-auto rounded-lg bg-neutral-100 p-3 text-xs">{children}</pre>;
}

/**
 * The integration guide, the endpoint reference and the console, in that order: read four
 * paragraphs, run one request, then look up the rest. Everything on the page is generated
 * from `shared/apiDocs.ts`, so the reference cannot drift from the routes that exist - a
 * test asserts both directions.
 */
export function DocsTab() {
  const [request, setRequest] = useState<ConsoleRequest>({ method: 'GET', path: '/api/sites', body: '' });
  const [query, setQuery] = useState('');
  const [only, setOnly] = useState('all');
  const consoleRef = useRef<HTMLDivElement>(null);

  const base = location.origin;

  const load = (req: { method: ApiMethod; path: string; body?: unknown }) => {
    setRequest({
      method: req.method,
      path: req.path,
      body: req.body === undefined ? '' : JSON.stringify(req.body, null, 2),
    });
    consoleRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  };

  const groups = useMemo(() => {
    const needle = query.trim().toLowerCase();
    const chosen = only === 'all' ? API_DOC_GROUPS : API_DOC_GROUPS.filter((g) => g.id === only);
    if (!needle) return chosen;
    return chosen
      .map((g) => ({
        ...g,
        endpoints: g.endpoints.filter(
          (e) =>
            e.path.toLowerCase().includes(needle) ||
            e.summary.toLowerCase().includes(needle) ||
            e.method.toLowerCase() === needle,
        ),
      }))
      .filter((g) => g.endpoints.length > 0);
  }, [query, only]);

  return (
    <div className="space-y-6">
      <Card title="Start here">
        <ol className="space-y-4 text-sm text-neutral-600">
          <li>
            <span className="font-medium text-neutral-800">1. Make a key</span> on the Keys tab. The token is shown
            once — store it where your integration reads its secrets.
          </li>
          <li>
            <span className="font-medium text-neutral-800">2. Send it as a Bearer token.</span> No CSRF header, no
            cookie, no login call. Every endpoint below accepts it.
            <div className="mt-2">
              <CodeBlock>{curlSnippet({ method: 'GET', path: '/api/sites', baseUrl: base })}</CodeBlock>
            </div>
          </li>
          <li>
            <span className="font-medium text-neutral-800">3. Anything slow answers 202 with a job.</span> Poll it
            until <code>status</code> is <code>succeeded</code>, <code>failed</code> or <code>canceled</code>;{' '}
            <code>logAfter</code> returns only new log lines and <code>lastSeq</code> is your next cursor.
            <div className="mt-2">
              <CodeBlock>{`# 202 { "job": { "id": 17 } }  +  Location: /api/jobs/17
${curlSnippet({ method: 'GET', path: '/api/jobs/17?logAfter=0', baseUrl: base })}`}</CodeBlock>
            </div>
          </li>
        </ol>
      </Card>

      <Card title="Conventions">
        <div className="grid gap-6 lg:grid-cols-2">
          <ul className="space-y-2 text-sm text-neutral-600">
            <li>
              <span className="font-medium text-neutral-800">JSON in, JSON out.</span> Base URL{' '}
              <code>{base}/api</code>.
            </li>
            <li>
              <span className="font-medium text-neutral-800">Every key has a level</span> — Read only, Manage or
              Full — and every endpoint below names the one it needs; asking for more answers{' '}
              <code>403 forbidden</code>. Keys are not gated by two-factor authentication — that guards the browser
              login only. Revoking a key takes effect on the next request.
            </li>
            <li>
              <span className="font-medium text-neutral-800">One job per site.</span> A second mutation while one runs
              answers <code>409 job_conflict</code>. Jobs also serialize per server; a move occupies both ends.
            </li>
            <li>
              <span className="font-medium text-neutral-800">300 requests a minute</span>, then{' '}
              <code>429 rate_limited</code>. Poll a job about once a second, not in a tight loop.
            </li>
            <li>
              <span className="font-medium text-neutral-800">Errors share one envelope:</span>
              <div className="mt-2">
                <CodeBlock>{`{ "error": { "code": "job_conflict",
            "message": "…", "details": … } }`}</CodeBlock>
              </div>
            </li>
          </ul>
          <div>
            <table className="w-full text-sm">
              <thead>
                <tr className="text-left text-xs uppercase tracking-wide text-neutral-400">
                  <th className="pb-2 pr-3">Code</th>
                  <th className="pb-2 pr-3">HTTP</th>
                  <th className="pb-2">Means</th>
                </tr>
              </thead>
              <tbody>
                {API_ERROR_CODES.map((e) => (
                  <tr key={e.code} className="border-t border-neutral-100 align-top">
                    <td className="py-1.5 pr-3 font-mono text-xs">{e.code}</td>
                    <td className="py-1.5 pr-3 text-xs text-neutral-500">{e.status}</td>
                    <td className="py-1.5 text-xs text-neutral-600">{e.meaning}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      </Card>

      <Card title="Worked sequences">
        <div className="space-y-5">
          {API_DOC_RECIPES.map((recipe) => (
            <div key={recipe.id}>
              <h3 className="text-sm font-semibold text-neutral-800">{recipe.title}</h3>
              <p className="mt-0.5 text-xs text-neutral-500">{recipe.intro}</p>
              <ul className="mt-2 space-y-1.5">
                {recipe.steps.map((step, i) => (
                  <li key={i} className="flex items-start gap-2 text-sm">
                    <MethodBadge method={step.method} />
                    <span className="min-w-0 flex-1">
                      <code className="break-all text-xs">{step.path}</code>
                      <span className="ml-2 text-xs text-neutral-500">{step.comment}</span>
                    </span>
                    <Button small variant="ghost" onClick={() => load(step)}>
                      Load
                    </Button>
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </div>
      </Card>

      <div ref={consoleRef}>
        <TestConsole request={request} onChange={setRequest} />
      </div>

      <Card
        title={<span className="whitespace-nowrap">Every endpoint</span>}
        action={
          <div className="w-56 shrink-0">
            <input
              className={inputClass}
              placeholder="Filter: backup, DELETE, /wp/…"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
            />
          </div>
        }
      >
        <div className="mb-4 flex flex-wrap gap-1.5">
          {[{ id: 'all', title: 'All' }, ...API_DOC_GROUPS].map((g) => (
            <button
              key={g.id}
              type="button"
              onClick={() => setOnly(g.id)}
              className={`rounded-full px-2.5 py-1 text-xs font-medium transition-colors ${
                only === g.id ? 'bg-neutral-900 text-surface' : 'bg-neutral-100 text-neutral-600 hover:bg-neutral-200'
              }`}
            >
              {g.title}
            </button>
          ))}
        </div>
        {groups.length === 0 ? (
          <EmptyState>Nothing matches “{query}”.</EmptyState>
        ) : (
          <div className="space-y-6">
            {groups.map((group) => (
              <div key={group.id}>
                <h3 className="text-sm font-semibold text-neutral-800">{group.title}</h3>
                <p className="mt-0.5 mb-2 text-xs text-neutral-500">{group.intro}</p>
                <div className="divide-y divide-neutral-100">
                  {group.endpoints.map((e) => (
                    <EndpointRow key={`${e.method} ${e.path}`} endpoint={e} onTry={() => load(e)} />
                  ))}
                </div>
              </div>
            ))}
          </div>
        )}
      </Card>
    </div>
  );
}

function EndpointRow({ endpoint, onTry }: { endpoint: ApiDocEndpoint; onTry: () => void }) {
  return (
    <div className="flex items-start gap-3 py-2">
      <MethodBadge method={endpoint.method} />
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-2">
          <code className="break-all text-xs font-medium">{endpoint.path}</code>
          {/* No key needed, so no level either: "no key needed" below says it all. */}
          {!endpoint.open && (
            <AccessBadge
              level={endpoint.level}
              title={endpoint.levelReason ? `${ACCESS_LABELS[endpoint.level]}: ${endpoint.levelReason}` : ACCESS_SUMMARIES[endpoint.level]}
            />
          )}
          {endpoint.job && (
            <span className="rounded bg-sky-100 px-1.5 py-0.5 text-[10px] font-semibold text-sky-800">job</span>
          )}
          {endpoint.danger && (
            <span className="rounded bg-red-100 px-1.5 py-0.5 text-[10px] font-semibold text-red-800">destructive</span>
          )}
          {endpoint.open && (
            <span className="rounded bg-neutral-200 px-1.5 py-0.5 text-[10px] font-semibold text-neutral-700">
              no key needed
            </span>
          )}
        </div>
        <div className="text-xs text-neutral-600">{endpoint.summary}</div>
        {(endpoint.input || endpoint.returns) && (
          <div className="mt-0.5 text-[11px] text-neutral-400">
            {endpoint.input && <span className="mr-3 break-all">in: {endpoint.input}</span>}
            {endpoint.returns && <span className="break-all">out: {endpoint.returns}</span>}
          </div>
        )}
        {endpoint.note && <div className="mt-0.5 text-[11px] text-amber-700">{endpoint.note}</div>}
      </div>
      {!endpoint.note && (
        <Button small variant="ghost" onClick={onTry}>
          Try
        </Button>
      )}
    </div>
  );
}
