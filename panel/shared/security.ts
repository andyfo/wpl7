/**
 * Security, the parts the API and the web app share: who counts as a trusted proxy, how the
 * rules Traefik runs are named, the protection levels and what they switch on, custom rules,
 * and `effectivePolicy` - the one function that decides what a site actually gets. The rules
 * generator, the API and the pages all go through it, so they cannot disagree about a site.
 */
import { z } from 'zod';
import { WIDEST_PREFIX, parseCidr } from './cidr.js';

// ---------------------------------------------------------------------------
// Trusted proxies

/**
 * The request headers a CDN puts the visitor's own address in, and the only ones the panel
 * reads. Not X-Forwarded-For: Traefik rewrites that header for every peer it does not trust,
 * and trusting a peer there would change what every site behind that server sees. These three
 * pass through untouched, and Traefik's access log keeps them (deploy/docker-compose.yml).
 */
export const PROXY_HEADERS = ['Cf-Connecting-Ip', 'True-Client-Ip', 'Fastly-Client-Ip'] as const;
export type ProxyHeader = (typeof PROXY_HEADERS)[number];

/** Cloudflare, whose ranges the panel keeps current by itself (services/proxyRanges.ts). */
export const CLOUDFLARE = { name: 'cloudflare', label: 'Cloudflare', header: 'Cf-Connecting-Ip' } as const;

export const MAX_CUSTOM_PROXIES = 10;
export const MAX_PROXY_RANGES = 200;

const proxyRangeSchema = z
  .string()
  .trim()
  .max(64)
  .superRefine((value, ctx) => {
    const cidr = parseCidr(value);
    if (!cidr) ctx.addIssue({ code: 'custom', message: `"${value}" is not an IP address or a range like 203.0.113.0/24` });
    else if (cidr.prefix < WIDEST_PREFIX[cidr.family]) {
      ctx.addIssue({ code: 'custom', message: `${value} is too wide; the widest range allowed is /${WIDEST_PREFIX[cidr.family]}` });
    }
  })
  .transform((value) => parseCidr(value)!.text);

/** A proxy of the operator's own: a load balancer, another CDN. */
export const customProxySchema = z
  .object({
    /** Shown on the pages and in the logs. */
    name: z
      .string()
      .trim()
      .min(1, 'Give the proxy a name')
      .max(40)
      .regex(/^[A-Za-z0-9][A-Za-z0-9 ._-]*$/, 'A name is letters, digits, spaces and . _ -')
      .refine((n) => n.toLowerCase() !== CLOUDFLARE.name, 'Cloudflare is built in; switch it on instead'),
    /** The addresses the proxy connects FROM - never the visitors'. */
    ranges: z.array(proxyRangeSchema).min(1, 'List the addresses the proxy connects from').max(MAX_PROXY_RANGES),
    header: z.enum(PROXY_HEADERS),
  })
  .strict();
export type CustomProxy = z.infer<typeof customProxySchema>;

export const trustedProxiesSchema = z
  .object({
    cloudflare: z.boolean(),
    custom: z.array(customProxySchema).max(MAX_CUSTOM_PROXIES),
  })
  .strict()
  .refine(
    (v) => new Set(v.custom.map((p) => p.name.toLowerCase())).size === v.custom.length,
    'Two proxies have the same name',
  );
export type TrustedProxiesSetting = z.infer<typeof trustedProxiesSchema>;

export const DEFAULT_TRUSTED_PROXIES: TrustedProxiesSetting = { cloudflare: true, custom: [] };

// ---------------------------------------------------------------------------
// What Traefik's routers are called

/**
 * Every router and middleware the panel writes for a site is `wpl7sec_<kind>_<slug>`. Neither
 * a kind nor a slug has an underscore in it, so the name splits back apart unambiguously - the
 * access log reports only the router, and the router is how a blocked request is told apart
 * from a served one, and which rule blocked it.
 */
export const SECURITY_ROUTER_PREFIX = 'wpl7sec';
const KIND_RE = /^[a-z0-9][a-z0-9-]*$/;
const SLUG_RE = /^[a-z0-9][a-z0-9-]{1,30}[a-z0-9]$/;

export function securityName(kind: string, slug: string): string {
  if (!KIND_RE.test(kind)) throw new Error(`Not a security rule kind: "${kind}"`);
  if (!SLUG_RE.test(slug)) throw new Error(`Not a site slug: "${slug}"`);
  return `${SECURITY_ROUTER_PREFIX}_${kind}_${slug}`;
}

/** `wpl7sec_deny-files_my-blog@file` -> {kind: 'deny-files', slug: 'my-blog'}; null for any other name. */
export function parseSecurityName(name: string): { kind: string; slug: string } | null {
  const base = name.split('@')[0] ?? '';
  const parts = base.split('_');
  if (parts.length !== 3 || parts[0] !== SECURITY_ROUTER_PREFIX) return null;
  const [, kind, slug] = parts as [string, string, string];
  return KIND_RE.test(kind) && SLUG_RE.test(slug) ? { kind, slug } : null;
}

/** The fleet-wide routers of `wpl7-blocked.yml`: blocked addresses, one per proxy. */
export const BLOCKED_ROUTER_PREFIX = 'wpl7blk';

// ---------------------------------------------------------------------------
// Protection levels

export const securityLevels = ['off', 'standard', 'strict'] as const;
export type SecurityLevel = (typeof securityLevels)[number];

export const SECURITY_LEVEL_INFO: Record<SecurityLevel, { label: string; summary: string }> = {
  off: { label: 'Off', summary: 'No rules and no limits. The site is served exactly as it would be without Security.' },
  standard: {
    label: 'Standard',
    summary:
      'Refuses requests no visitor makes - secret files, PHP in uploads, scanners - and limits logins and request rates generously.',
  },
  strict: {
    label: 'Strict',
    summary: 'Standard, plus XML-RPC and outside wp-cron refused, tighter limits, more headers, and no plugin installs from wp-admin.',
  },
};

/** Requests refused outright (403), whoever sends them. */
export const denyRuleIds = ['files', 'uploads', 'install', 'scanners', 'enum'] as const;
export type DenyRuleId = (typeof denyRuleIds)[number];

export const DENY_RULE_INFO: Record<DenyRuleId, { label: string; description: string }> = {
  files: {
    label: 'Sensitive files',
    description: '.env and .git, wp-config backups, debug.log and SQL dumps. Nothing a visitor ever asks for, and the first thing a scanner does.',
  },
  uploads: {
    label: 'PHP in uploads',
    description: 'A PHP file under wp-content/uploads is how most break-ins end: an upload that runs. Media never needs to.',
  },
  install: {
    label: 'Install scripts',
    description: 'wp-admin/install.php and setup-config.php, which only an unfinished install needs.',
  },
  scanners: {
    label: 'Scanner user agents',
    description: 'Tools that announce themselves - sqlmap, Nikto, WPScan, Nuclei and the like.',
  },
  enum: {
    label: 'User enumeration',
    description: '/?author=N and the REST users list to anyone not signed in: how login names are harvested for guessing.',
  },
};

export const xmlrpcModes = ['allow', 'limit', 'deny'] as const;
export type XmlrpcMode = (typeof xmlrpcModes)[number];

export const wpcronModes = ['allow', 'deny'] as const;
export type WpcronMode = (typeof wpcronModes)[number];

export const limitIds = ['login', 'xmlrpc', 'requests', 'assets'] as const;
export type LimitId = (typeof limitIds)[number];

export const LIMIT_INFO: Record<LimitId, { label: string; description: string }> = {
  login: {
    label: 'Login attempts',
    description: 'POST requests to wp-login.php, per address. Keep the burst small: Traefik gives a visitor who pauses a few seconds a full burst again.',
  },
  xmlrpc: {
    label: 'XML-RPC',
    description: 'Requests to xmlrpc.php, per address. Jetpack\'s servers are never limited. Keep the burst small, as for logins.',
  },
  requests: { label: 'Requests', description: 'Everything else, per address.' },
  assets: { label: 'Assets', description: 'Stylesheets, scripts, images and fonts under wp-content and wp-includes, per address.' },
};

export const rateLimitSchema = z
  .object({
    /** Sustained rate. */
    average: z.number().int().min(1).max(100_000),
    /** How many may arrive at once before the rate applies. */
    burst: z.number().int().min(1).max(100_000),
    per: z.enum(['second', 'minute']),
  })
  .strict();
export type RateLimit = z.infer<typeof rateLimitSchema>;

export interface HeaderPolicy {
  /** X-Content-Type-Options: nosniff */
  nosniff: boolean;
  /** X-Frame-Options: SAMEORIGIN */
  frameOptions: boolean;
  /** Strict-Transport-Security, on HTTPS only. */
  hsts: boolean;
  /** Referrer-Policy: strict-origin-when-cross-origin */
  referrerPolicy: boolean;
}

export const HEADER_INFO: Record<keyof HeaderPolicy, { label: string; description: string }> = {
  nosniff: { label: 'X-Content-Type-Options', description: 'nosniff: a browser runs a file as what the server says it is, never as what it looks like.' },
  frameOptions: { label: 'X-Frame-Options', description: 'SAMEORIGIN: other sites cannot show this one in a frame. Embeds of this site elsewhere stop working.' },
  hsts: { label: 'Strict-Transport-Security', description: 'Browsers use HTTPS only, for a year. Hard to undo once sent: only for a site that stays on HTTPS.' },
  referrerPolicy: { label: 'Referrer-Policy', description: 'strict-origin-when-cross-origin: other sites learn which site a visitor came from, not which page.' },
};

export interface ContainerPolicy {
  /** Apache refuses to run PHP in wp-content/uploads, whatever a .htaccess there says. */
  blockPhpInUploads: boolean;
  /** DISALLOW_FILE_EDIT: no theme and plugin editor in wp-admin. */
  disallowFileEdit: boolean;
  /** DISALLOW_FILE_MODS: no installs or updates from wp-admin (the panel's own still work). */
  disallowFileMods: boolean;
}

export const CONTAINER_INFO: Record<keyof ContainerPolicy, { label: string; description: string }> = {
  blockPhpInUploads: {
    label: 'No PHP in uploads',
    description: 'Apache will not run a PHP file under wp-content/uploads. Set outside the site, so its own .htaccess cannot switch it back on.',
  },
  disallowFileEdit: {
    label: 'No file editor',
    description: 'Removes the theme and plugin editor from wp-admin, so a stolen admin login cannot rewrite PHP with it.',
  },
  disallowFileMods: {
    label: 'No installs from wp-admin',
    description: 'Plugins and themes cannot be installed or updated from wp-admin. Updates from the panel keep working.',
  },
};

export interface ProtectionPolicy {
  rules: Record<DenyRuleId, boolean>;
  xmlrpc: XmlrpcMode;
  /** Requests to wp-cron.php from outside; the panel runs WordPress cron itself. */
  wpcron: WpcronMode;
  /** null = no limit. */
  limits: Record<LimitId, RateLimit | null>;
  headers: HeaderPolicy;
  container: ContainerPolicy;
}

const perMinute = (average: number, burst: number): RateLimit => ({ average, burst, per: 'minute' });
const perSecond = (average: number, burst: number): RateLimit => ({ average, burst, per: 'second' });

export const LEVEL_PRESETS: Record<SecurityLevel, ProtectionPolicy> = {
  off: {
    rules: { files: false, uploads: false, install: false, scanners: false, enum: false },
    xmlrpc: 'allow',
    wpcron: 'allow',
    limits: { login: null, xmlrpc: null, requests: null, assets: null },
    headers: { nosniff: false, frameOptions: false, hsts: false, referrerPolicy: false },
    container: { blockPhpInUploads: false, disallowFileEdit: false, disallowFileMods: false },
  },
  standard: {
    rules: { files: true, uploads: true, install: true, scanners: true, enum: true },
    xmlrpc: 'limit',
    wpcron: 'allow',
    // Generous on purpose: a limit is felt by every visitor behind one office NAT, and the
    // attack detection is what deals with the address that keeps at it. Except the bursts of
    // logins and XML-RPC: Traefik forgets a visitor who pauses for 1 + 1/rate seconds and starts
    // them on a full burst again (traefik#13957), so there a burst is what a patient guesser
    // gets every few seconds. Two still lets a double-clicked button through. When Traefik
    // fixes it: docs/internal/watchlist.md.
    limits: {
      login: perMinute(20, 2),
      xmlrpc: perMinute(30, 2),
      requests: perSecond(50, 500),
      assets: perSecond(200, 4000),
    },
    headers: { nosniff: true, frameOptions: false, hsts: false, referrerPolicy: false },
    container: { blockPhpInUploads: true, disallowFileEdit: true, disallowFileMods: false },
  },
  strict: {
    rules: { files: true, uploads: true, install: true, scanners: true, enum: true },
    xmlrpc: 'deny',
    wpcron: 'deny',
    limits: {
      login: perMinute(6, 2),
      xmlrpc: null,
      requests: perSecond(10, 100),
      assets: perSecond(100, 1000),
    },
    headers: { nosniff: true, frameOptions: true, hsts: true, referrerPolicy: true },
    container: { blockPhpInUploads: true, disallowFileEdit: true, disallowFileMods: true },
  },
};

/** What a fleet default or a site changes on top of its level. Every part optional. */
export const securityOverridesSchema = z
  .object({
    rules: z.object(Object.fromEntries(denyRuleIds.map((id) => [id, z.boolean()])) as Record<DenyRuleId, z.ZodBoolean>).partial().strict().optional(),
    xmlrpc: z.enum(xmlrpcModes).optional(),
    wpcron: z.enum(wpcronModes).optional(),
    limits: z
      .object(Object.fromEntries(limitIds.map((id) => [id, rateLimitSchema.nullable()])) as Record<LimitId, z.ZodNullable<typeof rateLimitSchema>>)
      .partial()
      .strict()
      .optional(),
    headers: z
      .object({ nosniff: z.boolean(), frameOptions: z.boolean(), hsts: z.boolean(), referrerPolicy: z.boolean() })
      .partial()
      .strict()
      .optional(),
    container: z
      .object({ blockPhpInUploads: z.boolean(), disallowFileEdit: z.boolean(), disallowFileMods: z.boolean() })
      .partial()
      .strict()
      .optional(),
  })
  .strict();
export type SecurityOverrides = z.infer<typeof securityOverridesSchema>;

/** Whether an override object changes anything at all (`{}` and `{rules: {}}` do not). */
export function hasOverrides(o: SecurityOverrides | null | undefined): boolean {
  if (!o) return false;
  return Object.values(o).some((v) => v !== undefined && (typeof v !== 'object' || v === null || Object.keys(v).length > 0));
}

/** How many rules, limits, headers and settings an override object changes. */
export function countOverrides(o: SecurityOverrides | null | undefined): number {
  if (!o) return 0;
  return Object.values(o).reduce<number>(
    (n, v) => n + (v === undefined ? 0 : typeof v === 'object' && v !== null ? Object.values(v).filter((x) => x !== undefined).length : 1),
    0,
  );
}

// ---------------------------------------------------------------------------
// Custom rules

export const customRuleFields = ['path', 'userAgent', 'method', 'query', 'address'] as const;
export type CustomRuleField = (typeof customRuleFields)[number];
export const customRuleOps = ['is', 'startsWith', 'contains', 'matches', 'present'] as const;
export type CustomRuleOp = (typeof customRuleOps)[number];

export const MAX_CUSTOM_RULES = 30;
export const MAX_RULE_CONDITIONS = 8;
export const HTTP_METHODS = ['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'] as const;

/** Which operators each field takes. */
export const FIELD_OPS: Record<CustomRuleField, readonly CustomRuleOp[]> = {
  path: ['is', 'startsWith', 'contains', 'matches'],
  userAgent: ['is', 'startsWith', 'contains', 'matches'],
  method: ['is'],
  query: ['is', 'startsWith', 'contains', 'matches', 'present'],
  address: ['is'],
};

/**
 * Why a value cannot go into a rule; null when it can. Traefik reads its rule files through
 * Go's template engine, so `{{` would be a template; a rule quotes values in backticks, so a
 * backtick would end one early. Neither has a place in a path or a user agent anyway.
 */
export function ruleValueProblem(value: string): string | null {
  if (value.includes('`')) return 'A backtick (`) cannot be used in a rule';
  if (value.includes('{{') || value.includes('}}')) return '"{{" and "}}" cannot be used in a rule';
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f]/.test(value)) return 'A rule cannot contain control characters or line breaks';
  return null;
}

/**
 * A regular expression Traefik (Go's RE2) will take, as far as can be told from here: it has
 * to compile, and it may not use what RE2 does not have - lookaround and backreferences. A
 * leading `(?i)` (case-insensitive) is RE2's own and fine.
 */
export function regexProblem(pattern: string): string | null {
  const body = pattern.replace(/^\(\?i\)/, '');
  if (/\(\?[=!]|\(\?<[=!]|\\[1-9]|\(\?>/.test(body)) return 'Lookaround and backreferences are not supported';
  try {
    new RegExp(body);
  } catch (err) {
    return `Not a valid regular expression: ${err instanceof Error ? err.message : String(err)}`;
  }
  return null;
}

export const customConditionSchema = z
  .object({
    field: z.enum(customRuleFields),
    op: z.enum(customRuleOps),
    value: z.string().max(200).default(''),
    /** `query` only: the parameter's name. */
    name: z
      .string()
      .regex(/^[A-Za-z0-9_.\-[\]]{1,60}$/, 'A parameter name is letters, digits and _ . - [ ]')
      .optional(),
    negate: z.boolean().default(false),
  })
  .strict()
  .superRefine((c, ctx) => {
    const issue = (message: string, path = 'value') => ctx.addIssue({ code: 'custom', message, path: [path] });
    if (!FIELD_OPS[c.field].includes(c.op)) return issue(`"${c.op}" does not apply to ${c.field}`, 'op');
    if (c.field === 'query' && !c.name) return issue('Name the query parameter', 'name');
    if (c.field !== 'query' && c.name !== undefined) return issue('Only a query condition has a name', 'name');
    if (c.op === 'present') return;
    if (c.value === '') return issue('Enter a value');
    const unsafe = ruleValueProblem(c.value);
    if (unsafe) return issue(unsafe);
    if (c.op === 'matches') {
      const problem = regexProblem(c.value);
      if (problem) return issue(problem);
    }
    if (c.field === 'path' && (c.op === 'is' || c.op === 'startsWith') && !c.value.startsWith('/')) {
      return issue('A path starts with /');
    }
    if (c.field === 'method' && !(HTTP_METHODS as readonly string[]).includes(c.value)) {
      return issue(`A method is one of ${HTTP_METHODS.join(', ')}`);
    }
    if (c.field === 'address') {
      const cidr = parseCidr(c.value);
      if (!cidr) return issue(`"${c.value}" is not an IP address or a range`);
      if (cidr.prefix < WIDEST_PREFIX[cidr.family]) return issue(`The widest range allowed is /${WIDEST_PREFIX[cidr.family]}`);
    }
  });
export type CustomCondition = z.infer<typeof customConditionSchema>;

export const customRuleSchema = z
  .object({
    /** Short and stable: it is in the router's name, so a rule's hits are counted across edits. */
    id: z.string().regex(/^[a-z0-9]{1,12}$/, 'A rule id is 1-12 letters and digits').optional(),
    action: z.enum(['block', 'allow']),
    /** `all`: every condition must hold. `any`: one is enough. */
    match: z.enum(['all', 'any']).default('all'),
    conditions: z.array(customConditionSchema).min(1, 'A rule needs a condition').max(MAX_RULE_CONDITIONS),
    note: z.string().max(200).default(''),
    enabled: z.boolean().default(true),
  })
  .strict();
export type CustomRuleInput = z.input<typeof customRuleSchema>;
export type CustomRule = Omit<z.infer<typeof customRuleSchema>, 'id'> & { id: string };

export const customRulesSchema = z
  .array(customRuleSchema)
  .max(MAX_CUSTOM_RULES, `A site has at most ${MAX_CUSTOM_RULES} custom rules`)
  .refine((rules) => {
    const ids = rules.map((r) => r.id).filter((id): id is string => id !== undefined);
    return new Set(ids).size === ids.length;
  }, 'Two rules have the same id');

/** Give every rule an id, keeping the ones it has. */
export function withRuleIds(rules: z.infer<typeof customRulesSchema>, random: () => string = randomRuleId): CustomRule[] {
  const taken = new Set(rules.map((r) => r.id).filter(Boolean));
  return rules.map((rule) => {
    if (rule.id) return rule as CustomRule;
    let id = random();
    while (taken.has(id)) id = random();
    taken.add(id);
    return { ...rule, id };
  });
}

function randomRuleId(): string {
  return Math.random().toString(36).slice(2, 8).padEnd(6, '0');
}

// ---------------------------------------------------------------------------
// What a site gets

/** Where a value came from: the level's own, the fleet default's overrides, or the site's. */
export type PolicySource = 'level' | 'fleet' | 'site';

export interface EffectivePolicy extends ProtectionPolicy {
  level: SecurityLevel;
  /** `site` when the site chose its level, `fleet` when it follows the default. */
  levelFrom: 'fleet' | 'site';
  customRules: CustomRule[];
  /** Keyed `rules.files`, `xmlrpc`, `limits.login`, `headers.hsts`, `container.disallowFileMods`. */
  sources: Record<string, PolicySource>;
}

export interface FleetSecurity {
  level: SecurityLevel;
  overrides: SecurityOverrides;
}

export interface SiteSecurityInput {
  /** null = follow the fleet default. */
  level: SecurityLevel | null;
  overrides: SecurityOverrides;
  customRules: CustomRule[];
}

function applyOverrides(policy: ProtectionPolicy, sources: Record<string, PolicySource>, o: SecurityOverrides, from: PolicySource): void {
  for (const [id, on] of Object.entries(o.rules ?? {})) {
    if (on === undefined) continue;
    policy.rules[id as DenyRuleId] = on;
    sources[`rules.${id}`] = from;
  }
  if (o.xmlrpc !== undefined) {
    policy.xmlrpc = o.xmlrpc;
    sources.xmlrpc = from;
  }
  if (o.wpcron !== undefined) {
    policy.wpcron = o.wpcron;
    sources.wpcron = from;
  }
  for (const [id, limit] of Object.entries(o.limits ?? {})) {
    if (limit === undefined) continue;
    policy.limits[id as LimitId] = limit === null ? null : { ...limit };
    sources[`limits.${id}`] = from;
  }
  for (const [key, on] of Object.entries(o.headers ?? {})) {
    if (on === undefined) continue;
    policy.headers[key as keyof HeaderPolicy] = on;
    sources[`headers.${key}`] = from;
  }
  for (const [key, on] of Object.entries(o.container ?? {})) {
    if (on === undefined) continue;
    policy.container[key as keyof ContainerPolicy] = on;
    sources[`container.${key}`] = from;
  }
}

function clonePolicy(p: ProtectionPolicy): ProtectionPolicy {
  return JSON.parse(JSON.stringify(p)) as ProtectionPolicy;
}

/**
 * The one answer to "what does this site get". A site that chose a level gets that level and
 * its own changes; a site that follows the default gets the fleet's level, the fleet's changes,
 * then its own. Off is off: no change can switch a rule on under it, so Off stays the one
 * switch that is guaranteed to take everything away.
 */
export function effectivePolicy(fleet: FleetSecurity, site: SiteSecurityInput): EffectivePolicy {
  const levelFrom = site.level === null ? 'fleet' : 'site';
  const level = site.level ?? fleet.level;
  const policy = clonePolicy(LEVEL_PRESETS[level]);
  const sources: Record<string, PolicySource> = {};
  if (level !== 'off') {
    if (levelFrom === 'fleet') applyOverrides(policy, sources, fleet.overrides, 'fleet');
    applyOverrides(policy, sources, site.overrides, 'site');
  }
  // A limit on XML-RPC means nothing unless XML-RPC is limited; a denied one has no limit.
  if (policy.xmlrpc !== 'limit') policy.limits.xmlrpc = null;
  return { level, levelFrom, ...policy, customRules: site.customRules, sources };
}

/** "20 a minute", "50 a second". */
export function describeLimit(limit: RateLimit | null): string {
  if (!limit) return 'No limit';
  return `${limit.average.toLocaleString('en')} a ${limit.per}, bursts of ${limit.burst.toLocaleString('en')}`;
}

// ---------------------------------------------------------------------------
// Attack detection and blocked addresses

export const autoBlockModes = ['off', 'observe', 'on'] as const;
export type AutoBlockMode = (typeof autoBlockModes)[number];

export const detectionRuleIds = ['login', 'xmlrpc', 'probing', 'deadUrls', 'flooding'] as const;
export type DetectionRuleId = (typeof detectionRuleIds)[number];

export const detectionRuleSchema = z
  .object({
    enabled: z.boolean(),
    threshold: z.number().int().min(2).max(100_000),
    windowMin: z.number().int().min(1).max(1440),
  })
  .strict();
export type DetectionRule = z.infer<typeof detectionRuleSchema>;

export const detectionRulesSchema = z
  .object(Object.fromEntries(detectionRuleIds.map((id) => [id, detectionRuleSchema])) as Record<DetectionRuleId, typeof detectionRuleSchema>)
  .strict();
export type DetectionRules = z.infer<typeof detectionRulesSchema>;

export const DEFAULT_DETECTION_RULES: DetectionRules = {
  login: { enabled: true, threshold: 20, windowMin: 10 },
  xmlrpc: { enabled: true, threshold: 60, windowMin: 10 },
  probing: { enabled: true, threshold: 12, windowMin: 10 },
  deadUrls: { enabled: true, threshold: 60, windowMin: 5 },
  flooding: { enabled: true, threshold: 300, windowMin: 10 },
};

export const DETECTION_RULE_INFO: Record<DetectionRuleId, { label: string; counts: string; unit: string }> = {
  login: {
    label: 'Login guessing',
    counts: 'Failed or refused logins: POST wp-login.php answered 200, 401, 403 or 429.',
    unit: 'attempts',
  },
  xmlrpc: { label: 'XML-RPC', counts: 'POST requests to xmlrpc.php - one request can carry hundreds of password guesses.', unit: 'requests' },
  probing: {
    label: 'Probing',
    counts: 'Distinct paths only an attacker asks for (4 points each, like /.env or /wp-config.php.bak) and requests a rule refused (1 point).',
    unit: 'points',
  },
  deadUrls: { label: 'Dead URLs', counts: 'Distinct pages answered 404 - someone guessing at what exists.', unit: 'paths' },
  flooding: { label: 'Flooding', counts: 'Requests blocked by a rate limit (429).', unit: 'requests' },
};

/** How a rule reads on the pages: `files` is "Sensitive files", `block-x7` "Custom rule x7". */
export function blockedRuleLabel(rule: string): string {
  const labels: Record<string, string> = {
    files: 'Sensitive files',
    uploads: 'PHP in uploads',
    install: 'Install scripts',
    scanners: 'Scanner user agents',
    enum: 'User enumeration',
    xmlrpc: 'XML-RPC',
    wpcron: 'wp-cron.php from outside',
    'limit-login': 'Login limit',
    'limit-xmlrpc': 'XML-RPC limit',
    'limit-assets': 'Asset limit',
    'limit-requests': 'Request limit',
    'blocked-address': 'Blocked address',
  };
  if (labels[rule]) return labels[rule];
  if (rule.startsWith('block-')) return `Custom rule ${rule.slice('block-'.length)}`;
  return rule;
}

/** Where a block came from. */
export const blockSources = ['detector', 'manual', 'api'] as const;
export type BlockSource = (typeof blockSources)[number];

/** Why a block is no longer in force. */
export const blockEndReasons = ['expired', 'lifted', 'observed'] as const;
export type BlockEndReason = (typeof blockEndReasons)[number];

// ---------------------------------------------------------------------------
// Malware scans

export const scanOnFindingModes = ['report', 'quarantine-confirmed', 'quarantine-all'] as const;
export type ScanOnFinding = (typeof scanOnFindingModes)[number];

export const SCAN_ON_FINDING_INFO: Record<ScanOnFinding, { label: string; description: string }> = {
  report: { label: 'Report and alert', description: 'Nothing is moved. New serious findings are emailed to the alert address.' },
  'quarantine-confirmed': {
    label: 'Quarantine confirmed malware',
    description: 'Files that match a known-malware hash or signature are moved out of the site where that is safe; the rest is reported.',
  },
  'quarantine-all': {
    label: 'Quarantine everything it may',
    description:
      "Also moves what does not belong, malware or not: code in uploads, and files among WordPress's own that it never shipped. Changed files of WordPress or a plugin are never moved - reinstall those.",
  },
};

/** How sure a finding is. Suspicious code is what premium plugins look like too: it never alerts and is never moved. */
export const findingConfidences = ['confirmed', 'suspicious'] as const;
export type FindingConfidence = (typeof findingConfidences)[number];

export const findingSeverities = ['high', 'medium', 'low'] as const;
export type FindingSeverity = (typeof findingSeverities)[number];

export const findingStatuses = ['open', 'ignored', 'resolved', 'quarantined'] as const;
export type FindingStatus = (typeof findingStatuses)[number];

export const scanOutcomes = ['running', 'clean', 'findings', 'incomplete', 'failed', 'superseded'] as const;
export type ScanOutcome = (typeof scanOutcomes)[number];

/** The kinds of finding, what each means, and how bad it is. */
export const findingKinds = [
  'core-modified',
  'core-missing',
  'core-extra',
  'plugin-modified',
  'plugin-missing',
  'plugin-extra',
  'upload-php',
  'upload-handler',
  'link-outside',
  'panel-modified',
  'signature',
  'suspicious',
] as const;
export type FindingKind = (typeof findingKinds)[number];

export const FINDING_KIND_INFO: Record<FindingKind, { label: string; severity: FindingSeverity }> = {
  'core-modified': { label: 'WordPress file changed', severity: 'high' },
  'core-missing': { label: 'WordPress file missing', severity: 'low' },
  'core-extra': { label: 'Unknown file among WordPress\'s own', severity: 'high' },
  'plugin-modified': { label: 'Plugin file changed', severity: 'medium' },
  'plugin-missing': { label: 'Plugin file missing', severity: 'low' },
  'plugin-extra': { label: 'Unknown file in a plugin', severity: 'medium' },
  'upload-php': { label: 'PHP in uploads', severity: 'high' },
  'upload-handler': { label: 'Handler trick in uploads', severity: 'high' },
  'link-outside': { label: 'Link leaving the site', severity: 'medium' },
  'panel-modified': { label: 'WPL7 file changed', severity: 'high' },
  signature: { label: 'Known malware', severity: 'high' },
  suspicious: { label: 'Suspicious code', severity: 'low' },
};
