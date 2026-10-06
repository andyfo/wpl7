// @docs plugins/recipes
import { Link } from 'react-router';
import type { SiteLicenseDto } from '../../../../shared/types';
import { isTerminal, useRunJob, useSiteRecipes } from '../../api/hooks';
import { Button, Card, StatusBadge } from '../ui';
import { JobProgress } from '../JobProgress';
import { timeAgo } from '../../lib/format';

const badgeText = (status: SiteLicenseDto['status']): string =>
  status === 'not-set-up' ? 'not set up' : status === 'unknown' ? 'not checked' : status === 'inactive' ? 'plugin inactive' : status;

/** Where each recipe stands on this site; hidden when no plugin here has one. */
export function SiteRecipesCard({ slug }: { slug: string }) {
  const recipes = useSiteRecipes(slug);
  const run = useRunJob([['wp-recipes', slug], ['wp-status', slug]]);
  const items = recipes.data ?? [];
  if (items.length === 0) return null;
  const busy = run.isPending || (run.job !== null && !isTerminal(run.job.status));
  const apply = (hook: 'afterInstall' | 'verify', recipeId?: string) =>
    run.mutate({ path: `/api/sites/${slug}/wp/recipes/apply`, body: { hook, ...(recipeId ? { recipeId } : {}) } });

  return (
    <Card
      title="Recipes"
      action={
        <div className="flex gap-2">
          <Button small variant="secondary" disabled={busy} onClick={() => apply('verify')}>
            Check
          </Button>
          <Button small disabled={busy} onClick={() => apply('afterInstall')}>
            Activate all
          </Button>
        </div>
      }
    >
      <table className="w-full text-sm">
        <thead>
          <tr className="text-left text-xs uppercase tracking-wide text-neutral-400">
            <th className="pb-2">Plugin</th>
            <th className="pb-2">License</th>
            <th className="pb-2 text-right">Checked</th>
            <th className="pb-2" />
          </tr>
        </thead>
        <tbody>
          {items.map((l) => (
            <tr key={l.recipeId} className="border-t border-neutral-100 align-top">
              <td className="py-2 pr-3">
                <div className="font-medium">{l.name}</div>
                <div className="text-xs text-neutral-500">
                  {l.plugin}
                  {!l.installed && ' · not installed'}
                </div>
              </td>
              <td className="py-2 pr-3">
                <StatusBadge status={badgeText(l.status)} />
                {l.message && <div className="mt-1 text-xs text-neutral-500">{l.message}</div>}
                {l.status === 'active' && l.url && <div className="mt-1 text-xs text-neutral-400">{l.url}</div>}
              </td>
              <td className="py-2 pr-3 text-right text-xs text-neutral-500">{l.checkedAt ? timeAgo(l.checkedAt) : '–'}</td>
              <td className="py-2 text-right">
                {l.ready ? (
                  <Button small variant="ghost" disabled={busy || !l.installed} onClick={() => apply('afterInstall', l.recipeId)}>
                    Activate
                  </Button>
                ) : (
                  // Nothing to activate with yet: the way forward is the recipe's missing value.
                  <Link
                    to="/plugins/recipes"
                    className="inline-flex items-center rounded-lg px-2.5 py-1 text-xs font-medium text-neutral-600 hover:bg-neutral-100"
                  >
                    Set up
                  </Link>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      {run.job && (
        <div className="mt-3">
          <JobProgress job={run.job} logs={run.logs} />
        </div>
      )}
    </Card>
  );
}
