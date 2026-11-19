/**
 * php.net and GitHub as the PHP release reader sees them (services/phpUpstream.ts): answers in
 * the shapes they are published in, and a scripted fetch to serve them.
 */
export const release = (version: string, date: string, security = true) => ({
  announcement: true,
  tags: security ? ['security'] : [],
  date,
  source: [{ filename: `php-${version}.tar.gz`, name: `PHP ${version} (tar.gz)`, sha256: 'x', date }],
  version,
});

/** As `releases/active.php` answers. */
export const ACTIVE = {
  '8': {
    '8.3': release('8.3.36', '21 Oct 2026'),
    '8.4': release('8.4.27', '21 Oct 2026'),
    '8.5': release('8.5.12', '21 Oct 2026'),
  },
};

/** As `pre-release-builds.php?format=json` answers, with the keys of other shapes it also has. */
export const CANDIDATES = {
  '8.2.27': { active: true, release: { type: 'RC', number: 0, date: '05 Dec 2024', enabled: false }, dev_version: '8.2.27-dev' },
  '8.4.28': { active: true, release: { type: 'RC', number: 1, date: '05 November 2026', version: '8.4.28RC1' }, dev_version: '8.4.28-dev' },
  '8.5.13': { active: true, release: { type: 'RC', number: 2, date: '12 November 2026', version: '8.5.13RC2' }, dev_version: '8.5.13-dev' },
  '8.3.36': { active: true, release: { type: 'RC', number: 1, date: '08 October 2026', version: '8.3.36RC1' }, dev_version: '8.3.36-dev' },
  reported: ['8.2.27-dev', '8.4.28-dev'],
  releases: { '8.4.28': { version: '8.4.28RC1' } },
};

export const entry = (id: string, title: string, published: string, content: string) => `
  <entry xmlns="http://www.w3.org/2005/Atom" xml:base="entries/${id}.xml">
  <title>${title}</title>
  <id>https://www.php.net/archive/2026.php#${id}</id>
  <published>${published}</published>
  <updated>${published}</updated>
  <link href="https://www.php.net/index.php#${id}" rel="alternate" type="text/html"/>
  <link href="https://www.php.net/archive/2026.php#${id}" rel="via" type="text/html"/>
  <category term="frontpage" label="PHP.net frontpage news"/>
  <content type="xhtml"><div xmlns="http://www.w3.org/1999/xhtml">${content}</div></content>
  </entry>`;

/** php.net's news, in the shape of its `feed.atom`. */
export function feed(...entries: string[]): string {
  return `<?xml version="1.0" encoding="utf-8"?>
<feed xmlns="http://www.w3.org/2005/Atom" xmlns:php="http://php.net/ns/news">
  <title>PHP.net news &amp; announcements</title>
  ${entries.join('\n')}
</feed>`;
}

export const NOTICE = entry(
  '2026-10-20-1',
  'Upcoming Critical PHP Security Release',
  '2026-10-20T20:32:00+00:00',
  '<p>The PHP security team would like to give advance notice of an upcoming <a href="https://www.php.net/supported-versions.php">security release</a>. It is scheduled for <b>Wednesday, 21 October 2026 at 14:00 UTC</b>. It addresses two critical vulnerabilities, both rated CVSS v4.0 9.2.</p>',
);
export const RC = entry('2026-11-12-1', 'PHP 8.6.0RC7 available for testing', '2026-11-12T13:55:02+00:00', '<p>The PHP team is pleased to announce RC7.</p>');
export const ADVISORY = entry(
  '2026-10-21-2',
  'Security advisory: Critical remote code execution vulnerabilities, update now',
  '2026-10-21T00:35:26+00:00',
  '<p>PHP 8.5.12, 8.4.27, 8.3.36 and 8.2.35 fix two critical vulnerabilities.</p>',
);

const advisory = (id: string, severity: string, summary: string, patched: string[]) => ({
  ghsa_id: id,
  cve_id: `CVE-2026-${id.slice(5, 9)}`,
  severity,
  summary,
  html_url: `https://github.com/php/php-src/security/advisories/${id}`,
  vulnerabilities: patched.map((v) => ({ package: { ecosystem: 'php', name: 'php-src' }, patched_versions: v, vulnerable_version_range: `< ${v}` })),
});

export const ADVISORIES = [
  advisory('GHSA-w8hw-w9fx-j79w', 'critical', 'RCE via OOM corruption', ['8.2.35', '8.3.36', '8.4.27', '8.5.12']),
  advisory('GHSA-6wmf-4rv5-p3rp', 'critical', 'RCE via stale global state', ['8.2.35', '8.3.36', '8.4.27', '8.5.12']),
  advisory('GHSA-7875-c8px-7q5f', 'medium', 'Out-of-bounds read in the HTTP stream wrapper', ['8.3.35, 8.4.26']),
];

export type Answer = { status: number; body?: unknown; headers?: Record<string, string> };

/** php.net and GitHub, scripted by URL; every request is recorded with its headers. */
export function phpNet(answers: Record<string, Answer | (() => Answer)>) {
  const calls: { url: string; headers: Record<string, string> }[] = [];
  const fetch = (async (url: string, init: { headers: Record<string, string> }) => {
    calls.push({ url, headers: init.headers });
    const found = answers[url];
    const answer = typeof found === 'function' ? found() : found;
    if (!answer) return new Response('', { status: 503 });
    const body = answer.body === undefined ? '' : typeof answer.body === 'string' ? answer.body : JSON.stringify(answer.body);
    return new Response(answer.status === 304 ? null : body, { status: answer.status, headers: answer.headers });
  }) as unknown as typeof globalThis.fetch;
  return { fetch, calls };
}
