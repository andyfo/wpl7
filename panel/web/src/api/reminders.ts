import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from './client';
import type { ReminderDto, ReminderOptions, DomainDto } from '../../../shared/reminders';
export function useReminders(siteId?: number, serverId?: number) {
  const params = new URLSearchParams();
  if (siteId) params.set('siteId', String(siteId));
  if (serverId) params.set('serverId', String(serverId));
  return useQuery({
    queryKey: ['reminders', 'list', siteId, serverId],
    queryFn: async () => (await api<{ items: ReminderDto[] }>(`/api/reminders?${params}`)).items,
    refetchInterval: 60_000,
  });
}
export const useReminderSummary = (enabled = true) =>
  useQuery({
    queryKey: ['reminders', 'summary'],
    queryFn: () => api<{ count: number; tone: string; today: string; timezone: string }>('/api/reminders/summary'),
    refetchInterval: 60_000,
    enabled,
  });
export const useReminderOptions = () =>
  useQuery({ queryKey: ['reminders', 'options'], queryFn: () => api<ReminderOptions>('/api/reminders/options') });
export const useDomains = () =>
  useQuery({
    queryKey: ['reminders', 'domains'],
    queryFn: () => api<{ items: DomainDto[]; suggestions: ReminderOptions['suggestions'] }>('/api/domains'),
  });
export function useReminderAction() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: ({ path, method = 'POST', body }: { path: string; method?: string; body?: unknown }) =>
      api<unknown>(path, { method, body }),
    onSuccess: () => client.invalidateQueries({ queryKey: ['reminders'] }),
  });
}
