import { useEffect, useRef } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type {
  AdminAddressDto,
  BlockedRequestDto,
  FindingDto,
  FirewallOverviewDto,
  JobDto,
  NeverBlockDto,
  QuarantineItemDto,
  ScanDto,
  SecurityBlockDto,
  SecurityBlockListDto,
  SecurityCheckDto,
  SecurityDetectionDto,
  SecurityOverviewDto,
  SiteScanDto,
  SiteSecurityDto,
} from '../../../shared/types';
import type { CustomRule, FindingStatus, ScanOnFinding, SecurityLevel, SecurityOverrides } from '../../../shared/security';
import { api } from './client';

/** Everything under Security, invalidated together: one change shows everywhere at once. */
const ALL = ['security'];

export const useSecurityOverview = () =>
  useQuery({
    queryKey: ['security', 'overview'],
    queryFn: () => api<SecurityOverviewDto>('/api/security/overview'),
    refetchInterval: 30_000,
  });

export function useSiteSecurity(slug: string) {
  const qc = useQueryClient();
  const query = useQuery({
    queryKey: ['security', 'site', slug],
    queryFn: () => api<SiteSecurityDto>(`/api/sites/${slug}/security`),
    // A scan under way changes the page as it goes; otherwise a minute is plenty.
    refetchInterval: (q) => (q.state.data?.scan.active ? 5000 : 60_000),
  });
  // The findings, the quarantine and the earlier scans are queries of their own, which do not
  // poll: fetched again whenever this one sees a scan move on - started, finished, its files
  // moved to quarantine - and not only after a button here.
  const scan = query.data?.scan;
  const moved = scan ? [scan.active?.jobId, scan.last?.id, scan.last?.status, scan.openFindings, scan.quarantined].join('|') : null;
  const seen = useRef<{ slug: string; moved: string } | null>(null);
  useEffect(() => {
    if (moved === null) return;
    const before = seen.current;
    seen.current = { slug, moved };
    if (before?.slug !== slug || before.moved === moved) return;
    for (const key of ['findings', 'quarantine', 'scan']) void qc.invalidateQueries({ queryKey: ['security', key, slug] });
  }, [qc, slug, moved]);
  return query;
}

export const useSiteBlocked = (slug: string) =>
  useQuery({
    queryKey: ['security', 'blocked', slug],
    queryFn: () => api<{ items: BlockedRequestDto[]; counts7d: Record<string, number> }>(`/api/sites/${slug}/security/blocked?limit=100`),
    refetchInterval: 60_000,
  });

export const useSiteScanHistory = (slug: string) =>
  useQuery({
    queryKey: ['security', 'scan', slug],
    queryFn: () => api<{ scan: SiteScanDto; history: ScanDto[] }>(`/api/sites/${slug}/security/scan`),
  });

export const useFindings = (slug: string, status: FindingStatus | 'all') =>
  useQuery({
    queryKey: ['security', 'findings', slug, status],
    queryFn: () => api<{ items: FindingDto[]; counts: Record<FindingStatus, number> }>(`/api/sites/${slug}/security/findings?status=${status}`),
  });

export const useQuarantine = (slug: string) =>
  useQuery({
    queryKey: ['security', 'quarantine', slug],
    queryFn: () => api<{ items: QuarantineItemDto[] }>(`/api/sites/${slug}/security/quarantine`).then((r) => r.items),
  });

export const useBlocks = (state: 'active' | 'history', q: string) =>
  useQuery({
    queryKey: ['security', 'blocks', state, q],
    queryFn: () => api<SecurityBlockListDto>(`/api/security/blocks?state=${state}&limit=200${q ? `&q=${encodeURIComponent(q)}` : ''}`),
    refetchInterval: 30_000,
  });

export const useNeverBlock = () =>
  useQuery({
    queryKey: ['security', 'never-block'],
    queryFn: () => api<{ items: NeverBlockDto[]; admins: AdminAddressDto[] }>('/api/security/never-block'),
  });

export const useFirewall = () =>
  useQuery({ queryKey: ['security', 'firewall'], queryFn: () => api<FirewallOverviewDto>('/api/security/firewall'), refetchInterval: 30_000 });

export const useDetection = () =>
  useQuery({ queryKey: ['security', 'detection'], queryFn: () => api<SecurityDetectionDto>('/api/security/detection'), refetchInterval: 30_000 });

export const checkAddress = (address: string) => api<SecurityCheckDto>(`/api/security/check?address=${encodeURIComponent(address)}`);

/** A change under Security, then everything under Security fetched again. */
function useSecurityMutation<TArgs, TResult>(fn: (args: TArgs) => Promise<TResult>) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: fn,
    onSettled: () => qc.invalidateQueries({ queryKey: ALL }),
  });
}

export interface SiteSecurityPatch {
  level?: SecurityLevel | null;
  overrides?: SecurityOverrides;
  customRules?: (Omit<CustomRule, 'id'> & { id?: string })[];
}

export const useUpdateSiteSecurity = (slug: string) =>
  useSecurityMutation((patch: SiteSecurityPatch) => api<SiteSecurityDto>(`/api/sites/${slug}/security`, { method: 'PUT', body: patch }));

export const useScanNow = (slug: string) =>
  useSecurityMutation(() => api<{ job: JobDto }>(`/api/sites/${slug}/security/scan`, { method: 'POST' }));

export const useScanSettings = (slug: string) =>
  useSecurityMutation((body: { enabled?: boolean | null; onFinding?: ScanOnFinding | null }) =>
    api<SiteScanDto>(`/api/sites/${slug}/security/scan/settings`, { method: 'PUT', body }),
  );

export const useFindingAction = (slug: string) =>
  useSecurityMutation(({ id, action }: { id: number; action: 'ignore' | 'unignore' | 'resolve' | 'reinstall' | 'put-back' | 'quarantine' }) =>
    api<unknown>(`/api/sites/${slug}/security/findings/${id}/${action}`, { method: 'POST' }),
  );

export const useQuarantineAction = (slug: string) =>
  useSecurityMutation(({ id, action }: { id: number; action: 'restore' | 'delete' }) =>
    action === 'restore'
      ? api<QuarantineItemDto>(`/api/sites/${slug}/security/quarantine/${id}/restore`, { method: 'POST' })
      : api<QuarantineItemDto>(`/api/sites/${slug}/security/quarantine/${id}`, { method: 'DELETE' }),
  );

export const useScanAll = () =>
  useSecurityMutation((slugs?: string[]) => api<{ queued: string[]; already: string[] }>('/api/security/scans', { method: 'POST', body: slugs ? { slugs } : {} }));

export const useSecuritySync = () => useSecurityMutation(() => api<SecurityOverviewDto>('/api/security/sync', { method: 'POST' }));

export const useBlockAddress = () =>
  useSecurityMutation((body: { address: string; minutes?: number | null; note?: string; siteSlug?: string }) =>
    api<SecurityBlockDto>('/api/security/blocks', { method: 'POST', body }),
  );

export const useUnblock = () => useSecurityMutation((id: number) => api<SecurityBlockDto>(`/api/security/blocks/${id}`, { method: 'DELETE' }));

export const useAddNeverBlock = () =>
  useSecurityMutation((body: { address: string; note?: string }) => api<NeverBlockDto>('/api/security/never-block', { method: 'POST', body }));

export const useRemoveNeverBlock = () =>
  useSecurityMutation((id: number) => api<void>(`/api/security/never-block/${id}`, { method: 'DELETE' }));

export const useFirewallSync = () => useSecurityMutation(() => api<FirewallOverviewDto>('/api/security/firewall/sync', { method: 'POST' }));

/** The fleet settings Security keeps in Settings (PUT /api/settings), with the Settings page refreshed too. */
export function useSaveSecuritySettings() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (patch: Record<string, unknown>) => api<unknown>('/api/settings', { method: 'PUT', body: patch }),
    onSettled: () => Promise.all([qc.invalidateQueries({ queryKey: ALL }), qc.invalidateQueries({ queryKey: ['settings'] })]),
  });
}
