import type { ServerSystemInfoDto, SystemVersionDto } from '../../../shared/types';

/**
 * Feedback goes to GitHub or to the community, never through the panel.
 *
 * There is no endpoint behind the feedback dialog and there is not going to be one: a panel
 * that quietly posted what an operator typed to a server they do not run would contradict
 * the one promise this project makes about their data. So the form composes an issue or a
 * forum topic, hands it to the browser, and every character of it is readable before it is
 * published.
 */

export type FeedbackKind = 'bug' | 'feature' | 'question';

/**
 * The kinds that become a GitHub issue. A question is not one of them: it opens in the
 * project's community instead (`openInCommunity`), which is why `feedbackUrl` will not take it.
 */
export type IssueKind = Exclude<FeedbackKind, 'question'>;

export interface FeedbackDraft {
  kind: FeedbackKind;
  /** One line. Becomes the issue title. */
  summary: string;
  details: string;
  /**
   * The build-and-machine block, or empty when the operator switched it off. Composed by
   * `environmentBlock` so that what is sent is exactly what the dialog showed.
   */
  environment: string;
  /** "0.2.0 (stable)" - the bug form asks for this in a field of its own. */
  versionLine: string;
}

/**
 * GitHub answers an over-long URL with 414 rather than opening the form, and the encoded
 * length is not the typed length - a paragraph of non-ASCII triples. So the URL is measured
 * after encoding and the prose is shortened until it fits, well below any limit a browser
 * or proxy imposes on the way.
 */
const MAX_URL = 6000;

/** What is cut is marked, so an issue never silently arrives missing its second half. */
const CUT = '\n\n*(cut short to fit in a link - the rest is in the sender’s clipboard)*';

/** The issue body: what was typed, then the build block when it was left switched on. */
const body = (details: string, environment: string): string =>
  environment ? `${details.trim()}\n\n${environment}` : details.trim();

/**
 * Where this feedback should be typed up.
 *
 * Issue forms prefill from the query string by field id, and only their text fields do:
 * bug.yml's "how this install gets its panel" dropdown ignores a parameter, so that fact
 * travels in the environment block instead.
 */
export function feedbackUrl(repoUrl: string, draft: FeedbackDraft & { kind: IssueKind }): string {
  const base = repoUrl.replace(/\/+$/, '');
  const template = draft.kind === 'bug' ? 'bug.yml' : 'feature.yml';
  // bug.yml calls its first textarea "what"; feature.yml calls its own "problem".
  const field = draft.kind === 'bug' ? 'what' : 'problem';
  const compose = (details: string): string => {
    const params = new URLSearchParams({ template, title: draft.summary, [field]: body(details, draft.environment) });
    if (draft.kind === 'bug') params.set('version', draft.versionLine);
    return `${base}/issues/new?${params.toString()}`;
  };

  let keep = draft.details.length;
  let url = compose(draft.details);
  while (url.length > MAX_URL && keep > 0) {
    keep = Math.max(0, Math.floor(keep * 0.8) - 1);
    url = compose(draft.details.slice(0, keep) + CUT);
  }
  return url;
}

/**
 * The same thing as plain text, for the clipboard.
 *
 * Not a nicety: the GitHub mobile app is reported to drop every query parameter and land on
 * the template chooser, a fork may not carry these issue forms at all, and a question that
 * the community refuses is a question the sender still wants. Either way what they wrote is
 * theirs to paste.
 */
export function feedbackText(draft: FeedbackDraft): string {
  return `${draft.summary}\n\n${body(draft.details, draft.environment)}\n`;
}

/**
 * What this install is, in three lines an issue can be triaged from.
 *
 * Deliberately nothing that identifies the operator or their customers: no address, no
 * hostname, no domain, no site. The panel knows all four and none of them helps anybody
 * read a bug report - so the toggle in the dialog is a toggle over facts that are safe
 * whichever way it is left.
 */
export function environmentBlock(version: SystemVersionDto, host: ServerSystemInfoDto | null, node: string): string {
  const build = [
    `WPL7 ${version.version} (${version.channel} channel, ${version.source === 'image' ? 'released image' : 'built from a checkout'})`,
    version.gitSha === 'unknown' ? null : `commit ${version.gitSha.slice(0, 7)}`,
  ]
    .filter(Boolean)
    .join(' · ');
  const machine = [host?.os, [host?.kernel, host?.arch].filter(Boolean).join(' ') || null, host?.dockerVersion]
    .filter(Boolean)
    .join(' · ');
  return ['```', build, machine || 'machine unknown', `Node ${node}`, '```'].join('\n');
}

/** The community's own limits; it cuts anything longer without saying so. */
export const COMMUNITY_DETAILS_MAX = 8000;

/**
 * Open the community's new-topic page in a new tab, filled in with this question.
 *
 * A form POST rather than a link: a question with a pasted log runs past the 8 KB a web
 * server takes in an address, and a POST has no such limit. The page shows the text in an
 * editable form and lets the sender sign in or join on the spot; nothing is saved there until
 * they press Post. Submitted by the browser, so the panel never sees the request.
 */
export function openInCommunity(communityUrl: string, draft: FeedbackDraft): void {
  const form = document.createElement('form');
  form.method = 'POST';
  form.action = `${communityUrl.replace(/\/+$/, '')}/feedback/`;
  form.target = '_blank';
  form.rel = 'noopener noreferrer';
  form.acceptCharset = 'UTF-8';
  // The community puts the environment in a code block of its own, so it gets the lines
  // without the Markdown fences GitHub needs.
  const environment = draft.environment.replace(/^```\n?|\n?```$/g, '');
  const fields = { summary: draft.summary, details: draft.details, environment };
  for (const [name, value] of Object.entries(fields)) {
    const input = document.createElement('input');
    input.type = 'hidden';
    input.name = name;
    input.value = value;
    form.appendChild(input);
  }
  document.body.appendChild(form);
  try {
    form.submit();
  } finally {
    form.remove();
  }
}
