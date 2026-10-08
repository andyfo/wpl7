// @docs panel/appearance
import { useState } from 'react';
import type { ServerSystemInfoDto, SystemVersionDto } from '../../../shared/types';
import {
  COMMUNITY_DETAILS_MAX,
  environmentBlock,
  feedbackText,
  feedbackUrl,
  openInCommunity,
  type FeedbackKind,
} from '../lib/feedback';
import { Button, ExternalLinkIcon, Field, inputClass, Modal, Toggle } from './ui';

const KINDS: { id: FeedbackKind; label: string; hint: string }[] = [
  { id: 'bug', label: 'Something is broken', hint: 'It does not do what it says it does.' },
  { id: 'feature', label: 'Something is missing', hint: 'Describe what you are trying to do, not the fix.' },
  { id: 'question', label: 'A question or an idea', hint: 'Goes to the community, where people can answer it.' },
];

/**
 * Feedback, and the two different journeys it takes.
 *
 * A bug or a feature request is composed here and opened as a GitHub issue under the
 * sender's own account: nothing is posted from the panel, and every character is readable
 * on GitHub before they submit it. A question goes the same way to the community instead -
 * an issue tracker is the wrong place for it and a forum wants no GitHub account: the browser
 * opens the community's new-topic page with it filled in, and the sender signs in, reads it
 * over and posts it there. The panel itself sends nothing either way.
 */
export function FeedbackDialog({
  repoUrl,
  communityUrl,
  version,
  host,
  node,
  onClose,
}: {
  repoUrl: string;
  /** Empty = this install points at no community; the question route is not offered. */
  communityUrl: string;
  version: SystemVersionDto;
  host: ServerSystemInfoDto | null;
  node: string;
  onClose: () => void;
}) {
  const [kind, setKind] = useState<FeedbackKind>('bug');
  const [summary, setSummary] = useState('');
  const [details, setDetails] = useState('');
  const [includeEnv, setIncludeEnv] = useState(true);
  const [copied, setCopied] = useState(false);

  const environment = environmentBlock(version, host, node);
  const draft = {
    kind,
    summary: summary.trim(),
    details,
    environment: includeEnv ? environment : '',
    versionLine: `${version.version} (${version.channel})`,
  };
  const ready = draft.summary !== '' && details.trim() !== '';
  const kinds = KINDS.filter((k) => k.id !== 'question' || communityUrl !== '');

  const copy = () => {
    void navigator.clipboard.writeText(feedbackText(draft));
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  };

  return (
    <Modal title="Send feedback" onClose={onClose}>
      <div className="space-y-4 text-sm">
        <div className="space-y-1.5">
          {kinds.map((k) => (
            <button
              key={k.id}
              type="button"
              onClick={() => setKind(k.id)}
              className={`w-full rounded-lg border px-3 py-2 text-left transition-colors ${
                kind === k.id ? 'border-neutral-400 bg-neutral-50' : 'border-neutral-200 hover:bg-neutral-50'
              }`}
            >
              <span className="font-medium text-neutral-800">{k.label}</span>
              <span className="mt-0.5 block text-xs text-neutral-500">{k.hint}</span>
            </button>
          ))}
        </div>

        <Field label="In one line" width="full">
          <input
            className={inputClass}
            value={summary}
            onChange={(e) => setSummary(e.target.value)}
            placeholder={kind === 'feature' ? 'Backups should…' : 'Creating a site fails when…'}
            maxLength={120}
          />
        </Field>

        <Field
          label={kind === 'bug' ? 'What happened' : kind === 'feature' ? 'The problem' : 'What you want to ask'}
          width="full"
          hint={
            kind === 'bug'
              ? 'What you did, what you expected, and what you got instead. Check any log you paste for passwords, keys and customer domains first.'
              : undefined
          }
        >
          <textarea
            className={`${inputClass} min-h-32 font-normal`}
            value={details}
            onChange={(e) => setDetails(e.target.value)}
            maxLength={kind === 'question' ? COMMUNITY_DETAILS_MAX : undefined}
          />
        </Field>

        <div className="rounded-lg border border-neutral-200 bg-neutral-50 p-3">
          <Toggle checked={includeEnv} onChange={setIncludeEnv} label="Include what this install is" />
          <p className="mt-1.5 text-xs text-neutral-500">
            The build and the machine, and nothing else — no addresses, domains, hostnames or site names.
          </p>
          {includeEnv && (
            <pre className="mt-2 overflow-x-auto rounded bg-surface p-2 text-[11px] leading-relaxed text-neutral-600">
              {environment.replace(/```\n?/g, '')}
            </pre>
          )}
        </div>

        {kind === 'question' ? (
          <p className="text-xs text-neutral-500">
            Nothing is sent from this panel. The button opens{' '}
            <a className="underline" href={communityUrl} target="_blank" rel="noreferrer noopener">
              {communityUrl.replace(/^https:\/\//, '')}
            </a>{' '}
            in a new tab with this filled in. Sign in or join there, then post it — nothing is public until you do.
          </p>
        ) : (
          <p className="text-xs text-neutral-500">
            Nothing is sent from this panel. The button opens a new issue on GitHub with this filled in, under your own
            account — so read it once more first. A security problem should not come this way:{' '}
            <a
              className="underline"
              href={`${repoUrl}/security/advisories/new`}
              target="_blank"
              rel="noreferrer noopener"
            >
              report it privately
            </a>
            .
          </p>
        )}

        <div className="flex flex-wrap justify-end gap-2">
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="secondary" onClick={copy} disabled={!ready}>
            {copied ? 'Copied!' : 'Copy'}
          </Button>
          {kind === 'question' ? (
            <Button
              disabled={!ready}
              onClick={() => {
                openInCommunity(communityUrl, draft);
                onClose();
              }}
            >
              Open in the community <ExternalLinkIcon />
            </Button>
          ) : (
            <Button
              disabled={!ready}
              onClick={() => {
                window.open(feedbackUrl(repoUrl, { ...draft, kind }), '_blank', 'noopener,noreferrer');
                onClose();
              }}
            >
              Open on GitHub <ExternalLinkIcon />
            </Button>
          )}
        </div>
      </div>
    </Modal>
  );
}
