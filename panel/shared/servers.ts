// @docs servers/recover
/**
 * Whether a server's error says it refused the panel's SSH key: it answered, showed the host key the
 * panel pinned, and would not let the panel in. A panel installed again has a new key, which the
 * servers it had do not know until it is added there. Such a server is up, and its sites most likely
 * still run: it is not one to recover sites from (services/recovery.ts).
 */
export function refusesPanelKey(error: string | null | undefined): boolean {
  return /All configured authentication methods failed/i.test(error ?? '');
}
