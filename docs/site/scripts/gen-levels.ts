/**
 * Writes reference/security-levels.md: what each protection level refuses, limits and switches
 * on (LEVEL_PRESETS and the labels beside it in panel/shared/security.ts), and what each API key
 * level may do (panel/shared/access.ts), with how many endpoints of the API catalog each reaches.
 */
import { ACCESS_LABELS, ACCESS_SUMMARIES, accessLevels, allows } from '../../../panel/shared/access.js';
import { API_DOC_ENDPOINTS } from '../../../panel/shared/apiDocs.js';
import {
  CONTAINER_INFO,
  DENY_RULE_INFO,
  HEADER_INFO,
  LEVEL_PRESETS,
  LIMIT_INFO,
  SECURITY_LEVEL_INFO,
  denyRuleIds,
  describeLimit,
  limitIds,
  securityLevels,
  type ProtectionPolicy,
} from '../../../panel/shared/security.js';
import { report, writePages } from './lib/generated.js';
import { cell, code, table } from './lib/markdown.js';
import { isMain } from './lib/pages.js';

const SCRIPT = 'gen-levels.ts';
const FROM = ['panel/shared/security.ts', 'panel/shared/access.ts', 'panel/shared/apiDocs.ts'];

const levelLabels = securityLevels.map((l) => SECURITY_LEVEL_INFO[l].label);
const onOff = (on: boolean, yes: string, no: string) => (on ? yes : no);

/** One row per thing a level decides: its label, what it is, then each level's value. */
function levelTable(rows: { label: string; description: string; value: (p: ProtectionPolicy) => string }[]): string {
  return table(
    ['', 'What it is', ...levelLabels],
    rows.map((row) => [`**${cell(row.label)}**`, cell(row.description), ...securityLevels.map((l) => row.value(LEVEL_PRESETS[l]))]),
  );
}

const MODE_WORDS: Record<string, string> = { allow: 'Allowed', limit: 'Limited', deny: 'Refused' };

export function generateLevels(): string[] {
  const refused = levelTable([
    ...denyRuleIds.map((id) => ({
      label: DENY_RULE_INFO[id].label,
      description: DENY_RULE_INFO[id].description,
      value: (p: ProtectionPolicy) => onOff(p.rules[id], 'Refused', 'Allowed'),
    })),
    {
      label: 'XML-RPC',
      description: 'Requests to xmlrpc.php.',
      value: (p) => MODE_WORDS[p.xmlrpc] ?? p.xmlrpc,
    },
    {
      label: 'wp-cron.php from outside',
      description: 'Requests to wp-cron.php from the internet. The panel runs WordPress cron itself.',
      value: (p) => MODE_WORDS[p.wpcron] ?? p.wpcron,
    },
  ]);
  const limits = levelTable(
    limitIds.map((id) => ({
      label: LIMIT_INFO[id].label,
      description: LIMIT_INFO[id].description,
      // A limit on XML-RPC applies only where XML-RPC is limited, as effectivePolicy() has it.
      value: (p: ProtectionPolicy) => (id === 'xmlrpc' && p.xmlrpc !== 'limit' ? 'No limit' : describeLimit(p.limits[id])),
    })),
  );
  const headers = levelTable(
    (Object.keys(HEADER_INFO) as (keyof typeof HEADER_INFO)[]).map((key) => ({
      label: HEADER_INFO[key].label,
      description: HEADER_INFO[key].description,
      value: (p: ProtectionPolicy) => onOff(p.headers[key], 'Sent', 'Not sent'),
    })),
  );
  const container = levelTable(
    (Object.keys(CONTAINER_INFO) as (keyof typeof CONTAINER_INFO)[]).map((key) => ({
      label: CONTAINER_INFO[key].label,
      description: CONTAINER_INFO[key].description,
      value: (p: ProtectionPolicy) => onOff(p.container[key], 'On', 'Off'),
    })),
  );

  const reach = accessLevels.map((level) => ({
    level,
    total: API_DOC_ENDPOINTS.filter((e) => !e.open && allows(level, e.level)).length,
    own: API_DOC_ENDPOINTS.filter((e) => !e.open && e.level === level).length,
  }));
  const keys = table(
    ['Level', 'What it may do', 'Endpoints it reaches', 'Endpoints that need exactly it'],
    reach.map(({ level, total, own }) => [`**${ACCESS_LABELS[level]}**`, cell(ACCESS_SUMMARIES[level]), String(total), String(own)]),
  );
  const open = API_DOC_ENDPOINTS.filter((e) => e.open);

  const body = [
    'Two kinds of level decide what gets through. A protection level decides what every visitor may send to a site. A key level decides what an API key or an app connected over MCP may do in the panel.',
    '',
    '## Protection levels',
    '',
    table(
      ['Level', 'In short'],
      securityLevels.map((l) => [`**${SECURITY_LEVEL_INFO[l].label}**`, cell(SECURITY_LEVEL_INFO[l].summary)]),
    ),
    '',
    `The tables show each level as it ships. The fleet default and a site's own settings can change any row on top of its level, except under ${SECURITY_LEVEL_INFO.off.label}, which nothing switches back on.`,
    '',
    '### Refused requests',
    '',
    'A refused request gets a 403, whoever sends it.',
    '',
    refused,
    '',
    '### Rate limits',
    '',
    'Each limit counts per visitor address. The burst is how many requests may arrive at once before the rate applies.',
    '',
    limits,
    '',
    '### Headers',
    '',
    headers,
    '',
    '### Inside the site',
    '',
    container,
    '',
    '## Key levels',
    '',
    'An API key, and an app connected over MCP, has one of three levels. The levels nest: Manage can do everything Read only can, and Full everything Manage can. ' +
      'Someone signed in to the panel always has Full.',
    '',
    keys,
    '',
    `The counts are of the ${API_DOC_ENDPOINTS.length - open.length} endpoints that need a key. ` +
      `${open.length} more answer without one: ${open.map((e) => code(`${e.method} ${e.path}`)).join(', ')}.`,
    '',
    `Each endpoint's level is in the [API reference](/docs/integrations/api-reference/). A request above the key's level is refused with ${code('403')}, and the answer names both levels.`,
    '',
    '## Related',
    '',
    '- [Site protection](/docs/security/site-protection/)',
    '- [Security in WPL7](/docs/security/overview/)',
    '- [The REST API](/docs/integrations/api/)',
    '- [AI apps over MCP](/docs/integrations/mcp/)',
    '- [API reference](/docs/integrations/api-reference/)',
  ].join('\n');

  const changed = writePages(SCRIPT, FROM, [
    {
      path: 'reference/security-levels.md',
      title: 'Protection levels and key levels',
      description: 'What Standard and Strict protection allow, and what each API key level may do.',
      order: 5,
      sources: FROM,
      body,
    },
  ]);
  report(SCRIPT, changed, 1);
  return changed;
}

if (isMain(import.meta.url)) generateLevels();
