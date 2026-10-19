// @docs databases/adminer
import { randomBytes } from 'node:crypto';

/** Who asked to open which database: what a ticket carries from the panel to the front door. */
export interface AdminerTicket {
  userId: number;
  /** The panel session it was asked from: signing out of the panel ends Adminer too. */
  panelSid: string;
  siteId: number;
  database: string;
}

const TTL_MS = 60_000;

/**
 * "Open in Adminer" mints a ticket; the new tab spends it at the front door's /open. One use,
 * a minute at most, and in memory only: a panel restart ends them all, as it ends the sessions.
 */
export class AdminerTickets {
  private readonly tickets = new Map<string, AdminerTicket & { expiresAt: number }>();

  constructor(private readonly now: () => number = Date.now) {}

  issue(ticket: AdminerTicket): string {
    this.sweep();
    const id = randomBytes(32).toString('base64url');
    this.tickets.set(id, { ...ticket, expiresAt: this.now() + TTL_MS });
    return id;
  }

  /** The ticket, once: a second try, or one after a minute, gets nothing. */
  take(id: string): AdminerTicket | null {
    const found = this.tickets.get(id);
    this.tickets.delete(id);
    this.sweep();
    if (!found || found.expiresAt <= this.now()) return null;
    const { expiresAt, ...ticket } = found;
    void expiresAt;
    return ticket;
  }

  private sweep(): void {
    const now = this.now();
    for (const [id, t] of this.tickets) if (t.expiresAt <= now) this.tickets.delete(id);
  }
}
