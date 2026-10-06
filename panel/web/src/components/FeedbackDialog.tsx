// @docs panel/appearance
import { useState } from 'react';
import type { ServerSystemInfoDto, SystemVersionDto } from '../../../shared/types';
import { api } from '../api/client';
import { environmentBlock, feedbackText, feedbackUrl, type FeedbackKind } from '../lib/feedback';
import { Button, ErrorNote, ExternalLinkIcon, Field, inputClass, Modal, Toggle } from './ui';

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
 * on GitHub before they submit it. A question has nowhere like that to go - an issue tracker
 * is the wrong place and a forum wants no GitHub account - so that one is posted on by the
 * panel to the community (POST /api/feedback), which the dialog says plainly, with the
 * environment block shown in full either way.
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
  const [sending, setSending] = useState(false);
  const [sent, setSent] = useState(false);
  const [sendError, setSendError] = useState<unknown>(null);

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

  const sendToCommunity = async () => {
    setSending(true);
    setSendError(null);
    try {
      await api('/api/feedback', {
        method: 'POST',
        body: { summary: draft.summary, details: draft.details, environment: draft.environment },
      });
      setSent(true);
    } catch (err) {
      setSendError(err);
    } finally {
      setSending(false);
    }
  };

  if (sent) {
    return (
      <Modal title="Sent" onClose={onClose}>
        <div className="space-y-4 text-sm text-neutral-700">
          <p>
            Your question is waiting at{' '}
            <a className="underline" href={communityUrl} target="_blank" rel="noreferrer noopener">
              {communityUrl.replace(/^https:\/\//, '')} <ExternalLinkIcon />
            </a>
            . Read it over there and post it when you are happy with it — it is not public yet, and answers happen
            there rather than in the panel.
          </p>
          <div className="flex justify-end">
            <Button onClick={onClose}>Close</Button>
          </div>
        </div>
      </Modal>
    );
  }

  return (
    <Modal title="Send feedback" onClose={onClose}>
      <div className="space-y-4 text-sm">
        <div className="space-y-1.5">
          {kinds.map((k) => (
            <button
              key={k.id}
              type="button"
              onClick={() => {
                setKind(k.id);
                setSendError(null);
              }}
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
            This one is sent by the panel to{' '}
            <a className="underline" href={communityUrl} target="_blank" rel="noreferrer noopener">
              {communityUrl.replace(/^https:\/\//, '')}
            </a>
            , where you can read it over and post it yourself — nothing is public until you do. Exactly what is above
            is what goes, and nothing else.
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

        <ErrorNote error={sendError} />

        <div className="flex flex-wrap justify-end gap-2">
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="secondary" onClick={copy} disabled={!ready}>
            {copied ? 'Copied!' : 'Copy'}
          </Button>
          {kind === 'question' ? (
            <Button disabled={!ready || sending} onClick={() => void sendToCommunity()}>
              {sending ? 'Sending…' : 'Send to community'}
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
