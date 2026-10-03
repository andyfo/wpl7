/**
 * Traefik's router selection, for the rules this panel writes - enough of it to ask "what
 * answers this request" in a unit test, without a Traefik.
 *
 * It parses the v3 rule syntax the generator emits (matchers with backtick arguments, `&&`,
 * `||`, `!` and parentheses), evaluates it the way Traefik does, and picks the matching router
 * with the highest priority - a site's label router having its rule's length, as in Traefik.
 * Go's RE2 and JavaScript read the patterns used here the same way; a leading `(?i)` becomes
 * the `i` flag. The real Traefik is exercised by the verification in docs/security.md.
 */
import { CidrSet } from '../shared/cidr.js';
import type { DynamicConfig, TraefikMiddleware, TraefikRouter } from '../src/services/securityConfig.js';

export interface SimRequest {
  host: string;
  path: string;
  /** `?a=1&b=2` or ''. */
  query?: string;
  method?: string;
  headers?: Record<string, string>;
  /** The peer address Traefik sees. */
  peer?: string;
}

type Node =
  | { op: 'and' | 'or'; left: Node; right: Node }
  | { op: 'not'; inner: Node }
  | { op: 'call'; name: string; args: string[] };

function parse(rule: string): Node {
  let i = 0;
  const ws = () => {
    while (i < rule.length && /\s/.test(rule[i]!)) i++;
  };
  const expect = (s: string) => {
    ws();
    if (!rule.startsWith(s, i)) throw new Error(`Expected "${s}" at ${i} in ${rule}`);
    i += s.length;
  };
  const primary = (): Node => {
    ws();
    if (rule[i] === '!') {
      i++;
      return { op: 'not', inner: primary() };
    }
    if (rule[i] === '(') {
      i++;
      const inner = or();
      expect(')');
      return inner;
    }
    const m = /^[A-Za-z]+/.exec(rule.slice(i));
    if (!m) throw new Error(`Expected a matcher at ${i} in ${rule}`);
    i += m[0].length;
    expect('(');
    const args: string[] = [];
    for (;;) {
      ws();
      if (rule[i] !== '`') throw new Error(`Expected a backtick argument at ${i} in ${rule}`);
      const end = rule.indexOf('`', i + 1);
      if (end === -1) throw new Error(`Unterminated argument in ${rule}`);
      args.push(rule.slice(i + 1, end));
      i = end + 1;
      ws();
      if (rule[i] === ',') {
        i++;
        continue;
      }
      break;
    }
    expect(')');
    return { op: 'call', name: m[0], args };
  };
  const and = (): Node => {
    let left = primary();
    for (;;) {
      ws();
      if (!rule.startsWith('&&', i)) return left;
      i += 2;
      left = { op: 'and', left, right: primary() };
    }
  };
  const or = (): Node => {
    let left = and();
    for (;;) {
      ws();
      if (!rule.startsWith('||', i)) return left;
      i += 2;
      left = { op: 'or', left, right: and() };
    }
  };
  const tree = or();
  ws();
  if (i !== rule.length) throw new Error(`Trailing input at ${i} in ${rule}`);
  return tree;
}

/** A Go RE2 pattern as a JavaScript RegExp. */
export function goRegex(pattern: string): RegExp {
  return pattern.startsWith('(?i)') ? new RegExp(pattern.slice(4), 'i') : new RegExp(pattern);
}

function header(req: SimRequest, name: string): string | undefined {
  const entry = Object.entries(req.headers ?? {}).find(([k]) => k.toLowerCase() === name.toLowerCase());
  return entry?.[1];
}

function queryValues(req: SimRequest, key: string): string[] {
  const params = new URLSearchParams((req.query ?? '').replace(/^\?/, ''));
  return params.getAll(key);
}

function evaluate(node: Node, req: SimRequest): boolean {
  switch (node.op) {
    case 'and':
      return evaluate(node.left, req) && evaluate(node.right, req);
    case 'or':
      return evaluate(node.left, req) || evaluate(node.right, req);
    case 'not':
      return !evaluate(node.inner, req);
    case 'call': {
      const [a = '', b = ''] = node.args;
      switch (node.name) {
        case 'Host':
          return req.host.toLowerCase() === a.toLowerCase();
        case 'Path':
          return req.path === a;
        case 'PathPrefix':
          return req.path.startsWith(a);
        case 'PathRegexp':
          return goRegex(a).test(req.path);
        case 'Method':
          return (req.method ?? 'GET') === a;
        case 'Header':
          return header(req, a) === b;
        case 'HeaderRegexp': {
          const value = header(req, a);
          return value !== undefined && goRegex(b).test(value);
        }
        case 'Query':
          return queryValues(req, a).includes(b);
        case 'QueryRegexp':
          return queryValues(req, a).some((v) => goRegex(b).test(v));
        case 'ClientIP':
          return new CidrSet([a]).has(req.peer ?? '198.51.100.200');
        default:
          throw new Error(`The simulator does not know ${node.name}()`);
      }
    }
  }
}

export function ruleMatches(rule: string, req: SimRequest): boolean {
  return evaluate(parse(rule), req);
}

export interface SimOutcome {
  /** The router that answered, without a provider; `wp-<slug>` for the site's own. */
  router: string;
  /** What its middlewares make of the request. */
  answer: 'refused' | 'limited' | 'served';
  middlewares: string[];
  /** The limit that applies, and whose header it counts by. */
  limit?: { average: number; burst: number; period: string; by: string };
}

/**
 * Which router answers: the matching one with the highest priority. `labelHosts` adds the
 * site's own label router - the fallback - with the priority Traefik would give it.
 */
export function route(config: DynamicConfig | null, req: SimRequest, labelHosts: string[], slug: string): SimOutcome {
  const labelRule = labelHosts.map((h) => `Host(\`${h}\`)`).join(' || ');
  const candidates: [string, TraefikRouter][] = [
    ...Object.entries(config?.http.routers ?? {}),
    [`wp-${slug}`, { rule: labelRule, priority: labelRule.length, entryPoints: [], service: `wp-${slug}@docker` }],
  ];
  candidates.sort((x, y) => y[1].priority - x[1].priority);
  const found = candidates.find(([, r]) => ruleMatches(r.rule, req));
  if (!found) throw new Error(`Nothing routes ${req.host}${req.path}`);
  const [name, router] = found;
  const mws = router.middlewares ?? [];
  const defs = mws.map((m) => config?.http.middlewares[m]) as (TraefikMiddleware | undefined)[];
  if (defs.some((d) => d && 'ipAllowList' in d)) return { router: name, answer: 'refused', middlewares: mws };
  const limit = defs.find((d): d is Extract<TraefikMiddleware, { rateLimit: unknown }> => !!d && 'rateLimit' in d);
  if (limit) {
    return {
      router: name,
      answer: 'limited',
      middlewares: mws,
      limit: {
        average: limit.rateLimit.average,
        burst: limit.rateLimit.burst,
        period: limit.rateLimit.period,
        by: limit.rateLimit.sourceCriterion?.requestHeaderName ?? 'peer',
      },
    };
  }
  return { router: name, answer: 'served', middlewares: mws };
}
