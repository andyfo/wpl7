import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { DnsStatusDto, DnsTokenCheckDto } from '../../../shared/types';
import { api } from './client';

/** A change that rebuilds dev sites says which ones. */
export type DnsChange = DnsStatusDto & { rebuilding?: string[]; busy?: string[]; check?: DnsTokenCheckDto };

/**
 * Settings -> DNS. Polled quickly while a server has not been looked at yet - right after a
 * token change, Traefik's copy is being put in place on each server - and slowly otherwise.
 */
export const useDns = () =>
  useQuery({
    queryKey: ['dns'],
    queryFn: () => api<DnsStatusDto>('/api/dns'),
    refetchInterval: (q) => (q.state.data?.servers.some((s) => s.traefik.state === 'unknown') ? 3000 : 30_000),
  });

function useDnsChange<TVars>(request: (vars: TVars) => Promise<DnsChange>) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: request,
    onSuccess: (data) => {
      qc.setQueryData(['dns'], data);
      // Whether records can be published (Mail -> Setup guide, the New Site and go-live forms)
      // follows the token; the servers' own pages show their wildcard certificate.
      void qc.invalidateQueries({ queryKey: ['meta'] });
      void qc.invalidateQueries({ queryKey: ['mail-setup'] });
      void qc.invalidateQueries({ queryKey: ['mail-domains'] });
      void qc.invalidateQueries({ queryKey: ['servers'] });
    },
  });
}

export const useSaveDnsToken = () =>
  useDnsChange((token: string) => api<DnsChange>('/api/dns/token', { method: 'PUT', body: { token } }));

export const useRemoveDnsToken = () => useDnsChange(() => api<DnsChange>('/api/dns/token', { method: 'DELETE' }));

export const useSetWildcard = () =>
  useDnsChange(({ serverId, on }: { serverId: number; on: boolean }) =>
    api<DnsChange>(`/api/dns/servers/${serverId}/wildcard`, { method: 'PUT', body: { on } }),
  );

/** What a token reaches: the one typed in, or the stored one. Never stores anything. */
export const useCheckDnsToken = () =>
  useMutation({
    mutationFn: (token?: string) => api<DnsTokenCheckDto>('/api/dns/check', { method: 'POST', body: token ? { token } : {} }),
  });
