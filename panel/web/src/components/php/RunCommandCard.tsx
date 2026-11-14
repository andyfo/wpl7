// @docs sites/php
import { useState } from 'react';
import { useRunJob } from '../../api/hooks';
import { Button, Card, ErrorNote, inputClass } from '../ui';

/**
 * One shell command in a PHP site's folder, as the site's user: `composer install`, a migration.
 * Queued as a job; its output is in the job console.
 */
export function RunCommandCard({ slug, running }: { slug: string; running: boolean }) {
  const run = useRunJob([['site', slug]]);
  const [command, setCommand] = useState('');
  const why = running ? null : 'The site is not running.';
  return (
    <Card title="Run a command">
      <div className="flex items-start gap-2">
        <textarea
          className={`${inputClass} min-h-[2.5rem] flex-1 font-mono text-xs`}
          rows={2}
          value={command}
          placeholder="php artisan migrate --force"
          onChange={(e) => setCommand(e.target.value)}
        />
        <span title={why ?? undefined}>
          <Button
            disabled={command.trim() === '' || !running}
            busy={run.busy('shell')}
            onClick={() => run.mutate({ path: `/api/sites/${slug}/shell`, body: { command }, action: 'shell' })}
          >
            Run
          </Button>
        </span>
      </div>
      <p className="mt-1 text-xs text-neutral-500">{why ?? "Runs in the site's folder as its user. The output is in the job console."}</p>
      <ErrorNote error={run.error} />
    </Card>
  );
}
