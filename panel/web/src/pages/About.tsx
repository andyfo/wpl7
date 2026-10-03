import { useState, type ReactNode } from 'react';
import { Link } from 'react-router';
import { useQueryClient } from '@tanstack/react-query';
import { api } from '../api/client';
import { useAbout, useSystemVersion } from '../api/hooks';
import type { SystemAboutDto, SystemVersionDto } from '../../../shared/types';
import { Button, Card, ErrorNote, Modal, OutLink, Spinner } from '../components/ui';
import { FeedbackDialog } from '../components/FeedbackDialog';
import { Wordmark } from '../components/Wordmark';
import { formatBytes, formatDate, formatUptime } from '../lib/format';

/**
 * The colophon: what this is, what it is running, and where to say something about it.
 *
 * Reached from the version in the header, which is the one thing on every page a reader
 * already looks at to answer "what am I actually running". It is also where the licence
 * notice lives - the AGPL asks an interactive program to say who wrote it, under what terms
 * and where its source is, and this is the page where that is the point rather than noise.
 */
export function About() {
  const about = useAbout();
  const version = useSystemVersion();
  const qc = useQueryClient();
  const [checking, setChecking] = useState(false);
  const [checkError, setCheckError] = useState<unknown>(null);
  const [feedbackOpen, setFeedbackOpen] = useState(false);
  const [disclaimerOpen, setDisclaimerOpen] = useState(false);

  const checkNow = async () => {
    setChecking(true);
    setCheckError(null);
    try {
      await api('/api/system/update/check', { method: 'POST' });
      await qc.invalidateQueries({ queryKey: ['system-version'] });
      // The header reads its "update available" out of /api/meta, not out of this answer.
      await qc.invalidateQueries({ queryKey: ['meta'] });
    } catch (err) {
      setCheckError(err);
    } finally {
      setChecking(false);
    }
  };

  const v = version.data;
  const a = about.data;

  return (
    <div className="mx-auto max-w-5xl space-y-9 py-4">
      {/*
        No card behind this: the wordmark is the page, and a panel surface around it would
        make it one more row of facts. The layer-7 reading of the name is carried by the one
        link in the paragraph below - anyone who wants it has it, nobody has to read a
        paragraph about the OSI model.
      */}
      <header className="text-center">
        <Wordmark as="h1" className="about-wordmark" />
        <p className="about-tagline">Your own WordPress powerhouse</p>
        <div className="mx-auto mt-7 max-w-2xl">
          <p className="text-sm leading-relaxed text-neutral-600">
            WPL7 turns your server into your own WordPress hosting platform. Easily install
            WordPress preconfigured with your stack, with each site running in its own container
            and your choice of PHP version. Automatic TLS certificates, email, backups, monitoring
            and a REST API are built in. Manage everything from one panel. Your infrastructure,
            your data, your hosting.
          </p>
          <p className="mt-4 text-sm leading-relaxed text-neutral-600">
            The name WPL7 nods to{' '}
            <a
              className="underline decoration-neutral-300 underline-offset-2 hover:text-neutral-900"
              href="https://www.cloudflare.com/learning/ddos/what-is-layer-7/"
              target="_blank"
              rel="noreferrer noopener"
            >
              Layer 7
            </a>
            , the application layer where web requests happen.
          </p>
          <p className="mt-6 text-xs text-neutral-400">
            © 2026 Ondřej Forda · AGPL-3.0 ·{' '}
            <button type="button" className="underline hover:text-neutral-600" onClick={() => setDisclaimerOpen(true)}>
              no warranty / read disclaimer
            </button>
          </p>
        </div>
      </header>

      <div className="about-grid grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        <Card title="Version">{v ? <VersionFacts version={v} /> : <Loading />}</Card>
        <Card title="Machine">{a ? <MachineFacts host={a.host} /> : <Loading />}</Card>
        <Card title="Network">{a ? <NetworkFacts about={a} /> : <Loading />}</Card>
      </div>

      <div className="space-y-4">
        <div className="flex flex-wrap items-center justify-center gap-2">
          <Button onClick={() => setFeedbackOpen(true)} disabled={!a || !v}>
            Send feedback
          </Button>
          <Button variant="secondary" onClick={() => void checkNow()} disabled={checking || !v}>
            {checking ? 'Checking…' : 'Check for updates'}
          </Button>
        </div>
        {a && (
          <div className="flex flex-wrap items-center justify-center gap-x-4 gap-y-2 text-sm text-neutral-500">
            <OutLink href={a.repoUrl}>{a.repoUrl.replace(/^https:\/\//, '')}</OutLink>
            <span className="text-neutral-300">·</span>
            <OutLink href={`${a.repoUrl}/issues`}>Issues</OutLink>
            <span className="text-neutral-300">·</span>
            {a.communityUrl && (
              <>
                <OutLink href={a.communityUrl}>Community support</OutLink>
                <span className="text-neutral-300">·</span>
              </>
            )}
            <OutLink href={`${a.repoUrl}/security/advisories/new`}>Report a security problem</OutLink>
            <span className="text-neutral-300">·</span>
            <OutLink href={`${a.repoUrl}/blob/main/LICENSE`}>Licence</OutLink>
          </div>
        )}
        <div className="mx-auto max-w-lg">
          <ErrorNote error={checkError} />
        </div>
      </div>

      {disclaimerOpen && <Disclaimer onClose={() => setDisclaimerOpen(false)} />}

      {feedbackOpen && a && v && (
        <FeedbackDialog
          repoUrl={a.repoUrl}
          communityUrl={a.communityUrl}
          version={v}
          host={a.host.reachable ? a.host : null}
          node={a.node}
          onClose={() => setFeedbackOpen(false)}
        />
      )}
    </div>
  );
}

/**
 * The warranty disclaimer the © line links to.
 *
 * Kept out of that line deliberately: the AGPL's own notice is one clause long, and a
 * paragraph of it under the wordmark would be the loudest thing on the page.
 */
function Disclaimer({ onClose }: { onClose: () => void }) {
  return (
    <Modal title="Disclaimer" onClose={onClose}>
      <p className="text-sm leading-relaxed text-neutral-700">
        WPL7 is provided “as is” and “as available.” To the fullest extent permitted by law, the author and
        contributors disclaim all express and implied warranties, including merchantability, fitness for a particular
        purpose and non-infringement. They accept no liability for bugs, security vulnerabilities, downtime, data loss,
        financial loss or any other damage arising from using—or being unable to use—the software, even if advised of
        the possibility. You use WPL7 at your own risk and are responsible for your backups, security and
        configuration.
      </p>
      <div className="mt-5 flex justify-end">
        <Button variant="secondary" onClick={onClose}>
          Close
        </Button>
      </div>
    </Modal>
  );
}

/** What this build is, and whether there is a newer one. Settings owns the button that applies it. */
function VersionFacts({ version }: { version: SystemVersionDto }) {
  return (
    <>
      <dl className="about-facts text-sm">
        <Fact label="Version">{version.version}</Fact>
        {version.gitSha !== 'unknown' && <Fact label="Commit">{version.gitSha.slice(0, 7)}</Fact>}
        <Fact label="Channel">{version.channel}</Fact>
        <Fact label="Checked">{version.checkedAt ? formatDate(version.checkedAt) : 'never'}</Fact>
        {/*
          Three states, not two: GitHub answers 403 rather than an error when an anonymous
          caller runs out of its 60 requests an hour, and a panel that folded that into "up
          to date" would stop offering updates and never say why.
        */}
        <Fact label="Updates">
          {version.error ? (
            <span className="text-amber-700">could not check</span>
          ) : version.updateAvailable && version.latest ? (
            <Link to="/settings#updates" className="font-medium text-emerald-700 hover:underline">
              {version.latest.version} available
            </Link>
          ) : version.latest ? (
            'up to date'
          ) : (
            'no release found'
          )}
        </Fact>
      </dl>
      {version.error && <p className="mt-3 text-xs text-amber-700">{version.error}</p>}
    </>
  );
}

/** The box the panel runs on - server 1 is that box, read exactly as the server page reads it. */
function MachineFacts({ host }: { host: SystemAboutDto['host'] }) {
  // Every fact here comes from files a Linux host has and nothing else does. A panel run
  // straight on macOS in development is the honest case for this: it answered, and there
  // was nothing to read - which is worth one sentence rather than six dashes.
  const reportedNothing = [host.os, host.kernel, host.cpuModel, host.cpus, host.memTotalBytes, host.uptimeSeconds].every(
    (value) => value === null,
  );
  if (!host.reachable) {
    return (
      <p className="text-sm text-neutral-600">
        This machine could not be asked what it is.
        {host.error && <span className="mt-1 block break-words text-xs text-red-700">{host.error}</span>}
      </p>
    );
  }
  if (reportedNothing) {
    return (
      <p className="text-sm text-neutral-600">
        It answered but reported none of itself — no <code>/proc</code> or <code>/etc/os-release</code> to read, which a
        Linux host always has.
      </p>
    );
  }
  return (
    <dl className="about-facts text-sm">
      <Fact label="System">{host.os ?? '–'}</Fact>
      <Fact label="Kernel">{[host.kernel, host.arch].filter(Boolean).join(' · ') || '–'}</Fact>
      <Fact label="CPU">
        {[host.cpus === null ? null : `${host.cpus} core${host.cpus === 1 ? '' : 's'}`, host.cpuModel]
          .filter(Boolean)
          .join(' · ') || '–'}
      </Fact>
      <Fact label="Memory">{host.memTotalBytes === null ? '–' : formatBytes(host.memTotalBytes)}</Fact>
      <Fact label="Uptime">{formatUptime(host.uptimeSeconds)}</Fact>
      <Fact label="Docker">{host.dockerVersion?.replace(/^Docker version /, '') ?? '–'}</Fact>
    </dl>
  );
}

/** Where this install answers, and the process answering there. */
function NetworkFacts({ about }: { about: SystemAboutDto }) {
  return (
    <dl className="about-facts text-sm">
      <Fact label="Address">{about.publicIp ?? <Unset>not known</Unset>}</Fact>
      {/* A PTR is unset on most hosts and only mail minds; Mail → Setup is where it is a verdict. */}
      <Fact label="Reverse DNS">{about.reverseDns ?? <Unset>none published</Unset>}</Fact>
      <Fact label="Panel domain">{about.panelDomain || <Unset>none</Unset>}</Fact>
      <Fact label="Node">{about.node}</Fact>
      <Fact label="Panel up">{formatUptime(about.panelUptimeSeconds)}</Fact>
    </dl>
  );
}

/**
 * Label left, value right, hairline between. In a card a third of the page wide that is what
 * keeps the row full: a value hugging a left-aligned label leaves the rest of the card empty.
 */
function Fact({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-4 border-b border-neutral-100 py-2 last:border-0">
      <dt className="shrink-0 text-neutral-500">{label}</dt>
      <dd className="min-w-0 break-words text-right text-neutral-900">{children}</dd>
    </div>
  );
}

const Unset = ({ children }: { children: ReactNode }) => <span className="text-neutral-400">{children}</span>;

function Loading() {
  return (
    <div className="flex justify-center py-6">
      <Spinner />
    </div>
  );
}
