/**
 * Postfix / OpenDKIM log parsing.
 *
 * The mail relay is the only place that sees *all* outbound traffic — one queue there
 * serves every site on the server — so its log is what the panel reconstructs the traffic
 * view from. Everything here is pure: `MailService` owns the I/O and the database writes.
 *
 * Two syslog shapes reach us, because the log passes through whatever the image ships:
 *   2026-09-18T05:39:23.781211+00:00 INFO    postfix/smtpd[984]: C17462B13: client=…
 *   Sep 18 05:39:23 mailhost postfix/smtpd[984]: C17462B13: client=…
 * Rather than commit to either, the prefix is whatever precedes `<program>[<pid>]: ` and is
 * parsed for a timestamp opportunistically — an unreadable one just falls back to ingest time.
 */

/** A message postfix accepted: the envelope, before any delivery attempt. */
export interface MailEnvelopeEvent {
  kind: 'envelope';
  ts: number;
  queueId: string;
  /** `client=` host part, e.g. `wp-acme.wpl7_proxy`. */
  clientHost?: string;
  clientIp?: string;
  from?: string;
  sizeBytes?: number;
  nrcpt?: number;
}

/** One delivery attempt for one recipient. */
export interface MailDeliveryEvent {
  kind: 'delivery';
  ts: number;
  queueId: string;
  to: string;
  /** Only present on a rejection, where no separate envelope line will ever be logged. */
  from?: string;
  status: MailStatus;
  relay?: string;
  dsn?: string;
  delayMs?: number;
  detail?: string;
}

/** Postfix refused the message outright; it never got a queue id. */
export interface MailRejectEvent {
  kind: 'reject';
  ts: number;
  clientHost?: string;
  clientIp?: string;
  from?: string;
  to?: string;
  detail?: string;
}

/** OpenDKIM signed (or declined to sign) a queued message. */
export interface MailDkimEvent {
  kind: 'dkim';
  ts: number;
  queueId: string;
  signed: boolean;
  domain?: string;
  selector?: string;
}

export type MailLogEvent = MailEnvelopeEvent | MailDeliveryEvent | MailRejectEvent | MailDkimEvent;

export const MAIL_STATUSES = ['queued', 'sent', 'deferred', 'bounced', 'expired', 'rejected'] as const;
export type MailStatus = (typeof MAIL_STATUSES)[number];

/** `<prefix> <program>[/<subprogram>][<pid>]: <tail>` — the shape both syslog styles share. */
const LINE_RE = /^(.*?)\b([a-z][a-z-]*)(?:\/[a-z][a-z-]*)?\[\d+\]:\s+(.*)$/;
/** Postfix queue ids are hex (or base-36 with long_queue_ids); 6-20 chars covers both. */
const QUEUE_ID_RE = /^([A-Za-z0-9]{6,20}):\s+(.*)$/;

const num = (m: RegExpMatchArray | null): number | undefined => {
  if (!m?.[1]) return undefined;
  const v = Number(m[1]);
  return Number.isFinite(v) ? v : undefined;
};

/**
 * Timestamp from the syslog prefix. Handles RFC3339 and the classic
 * `Mmm DD HH:MM:SS` form, which carries no year — that one is anchored to `now`,
 * stepping back a year when the result would be in the future (a December log read
 * in January).
 */
export function parseSyslogTimestamp(prefix: string, now: number): number | null {
  const iso = /(\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2})?)/.exec(prefix);
  if (iso?.[1]) {
    const ms = Date.parse(iso[1]);
    if (Number.isFinite(ms)) return ms;
  }
  const bsd = /\b([A-Z][a-z]{2})\s+(\d{1,2})\s+(\d{2}):(\d{2}):(\d{2})/.exec(prefix);
  if (bsd) {
    const month = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'].indexOf(bsd[1]!);
    if (month >= 0) {
      const year = new Date(now).getUTCFullYear();
      const at = Date.UTC(year, month, Number(bsd[2]), Number(bsd[3]), Number(bsd[4]), Number(bsd[5]));
      // A day of slack absorbs clock skew between the panel and the mail host.
      return at > now + 24 * 3600_000 ? Date.UTC(year - 1, month, Number(bsd[2]), Number(bsd[3]), Number(bsd[4]), Number(bsd[5])) : at;
    }
  }
  return null;
}

/** `wp-acme.wpl7_proxy[172.18.0.5]` -> host + ip. */
function parseClient(rest: string): { clientHost?: string; clientIp?: string } {
  const m = /client=([^\s,[]+)(?:\[([^\]]+)\])?/.exec(rest);
  if (!m) return {};
  return { clientHost: m[1], clientIp: m[2] };
}

/**
 * Site slug behind a `client=` value. Site containers are named `wp-<slug>` and postfix
 * logs `<container>.<network>[<ip>]`, so the sending site falls out of the connection
 * itself — it does not depend on the From: header, which a compromised site controls.
 */
export function siteSlugFromClient(clientHost: string | null | undefined): string | null {
  if (!clientHost) return null;
  const first = clientHost.split('.')[0] ?? '';
  return first.startsWith('wp-') && first.length > 3 ? first.slice(3) : null;
}

/** Postfix `status=` word -> our stored status. Unknown words are kept as 'deferred'. */
function toStatus(word: string): MailStatus {
  switch (word) {
    case 'sent':
      return 'sent';
    case 'bounced':
      return 'bounced';
    case 'expired':
      return 'expired';
    case 'deferred':
      return 'deferred';
    default:
      return 'deferred';
  }
}

/**
 * Parse one log line. Returns null for the (many) lines that carry no traffic
 * information: connects, disconnects, TLS handshakes, daemon chatter.
 */
export function parseMailLogLine(line: string, now = Date.now()): MailLogEvent | null {
  const m = LINE_RE.exec(line.trimEnd());
  if (!m) return null;
  const [, prefix = '', program = '', tail = ''] = m;
  const ts = parseSyslogTimestamp(prefix, now) ?? now;

  if (program === 'opendkim') return parseDkimLine(tail, ts);
  if (program !== 'postfix') return null;

  // NOQUEUE covers more than refusals - "lost connection after RSET", "timeout after DATA"
  // and friends share the prefix. Only a line that actually says `reject:` describes a
  // message; treating the rest as rejections invented a blank row per disconnect.
  if (tail.startsWith('NOQUEUE:')) {
    return /\breject(?:_warning)?:/.test(tail) ? parseReject(tail, ts) : null;
  }

  const q = QUEUE_ID_RE.exec(tail);
  if (!q) return null;
  const queueId = q[1]!;
  const rest = q[2]!;

  // `to=` can come from smtp, lmtp, local, error, bounce or virtual — key off the field.
  if (rest.startsWith('to=')) {
    const to = /to=<([^>]*)>/.exec(rest)?.[1];
    const statusWord = /status=([a-z]+)/.exec(rest)?.[1];
    if (to === undefined || !statusWord) return null;
    const delaySec = num(/[\s,]delay=([0-9.]+)/.exec(rest));
    return {
      kind: 'delivery',
      ts,
      queueId,
      to,
      status: toStatus(statusWord),
      relay: /relay=([^,]+)/.exec(rest)?.[1]?.trim(),
      dsn: /dsn=([0-9.]+)/.exec(rest)?.[1],
      delayMs: delaySec !== undefined ? Math.round(delaySec * 1000) : undefined,
      // Everything after `status=<word> ` — the remote's response, parentheses included.
      detail: /status=[a-z]+\s+(.*)$/.exec(rest)?.[1]?.trim(),
    };
  }

  // A rejection after the queue id was assigned (milter or cleanup). Unlike a delivered
  // message, no `qmgr: from=` line will ever follow, so the sender is taken from this line.
  const rejectedBy = /^(?:milter-)?reject:\s*(.*)$/.exec(rest);
  if (rejectedBy) {
    return {
      kind: 'delivery',
      ts,
      queueId,
      to: /to=<([^>]*)>/.exec(rest)?.[1] ?? '',
      from: /from=<([^>]*)>/.exec(rest)?.[1],
      status: 'rejected',
      detail: rejectedBy[1]?.slice(0, 500),
    };
  }

  if (rest.startsWith('client=')) {
    return { kind: 'envelope', ts, queueId, ...parseClient(rest) };
  }

  if (rest.startsWith('from=')) {
    return {
      kind: 'envelope',
      ts,
      queueId,
      from: /from=<([^>]*)>/.exec(rest)?.[1],
      sizeBytes: num(/[\s,]size=(\d+)/.exec(rest)),
      nrcpt: num(/[\s,]nrcpt=(\d+)/.exec(rest)),
    };
  }

  // `removed`, `message-id=`, `resent-message-id=` and friends add nothing we store.
  return null;
}

function parseReject(tail: string, ts: number): MailRejectEvent {
  // A refusal names the peer positionally (`reject: RCPT from host[ip]:`) rather than with
  // the `client=` field a queued message gets, so both forms have to be understood or the
  // rejected mail would lose its sending site.
  const positional = /\bfrom\s+([^\s[]+)\[([^\]]+)\]/.exec(tail);
  const client = parseClient(tail);
  return {
    kind: 'reject',
    ts,
    clientHost: client.clientHost ?? positional?.[1],
    clientIp: client.clientIp ?? positional?.[2],
    from: /from=<([^>]*)>/.exec(tail)?.[1],
    to: /to=<([^>]*)>/.exec(tail)?.[1],
    // `NOQUEUE: reject: RCPT from host[ip]: 554 5.7.1 <…>: Relay access denied; from=…`
    detail: /reject:\s*(.*?)(?:;\s*from=|$)/.exec(tail)?.[1]?.slice(0, 500),
  };
}

/**
 * OpenDKIM speaks about the same queue id postfix uses, which is what lets a signature be
 * attributed to a specific message even though it is logged by a different container.
 */
function parseDkimLine(tail: string, ts: number): MailDkimEvent | null {
  const q = QUEUE_ID_RE.exec(tail);
  if (!q) return null;
  const queueId = q[1]!;
  const rest = q[2]!;
  if (rest.includes('DKIM-Signature field added')) {
    return {
      kind: 'dkim',
      ts,
      queueId,
      signed: true,
      // Anchored on `(` or whitespace so the `s=`/`d=` of some other word cannot match.
      selector: /[(\s]s=([^,\s)]+)/.exec(rest)?.[1],
      domain: /[(\s]d=([^,\s)]+)/.exec(rest)?.[1],
    };
  }
  // "no signing table match", "key retrieval failed", "message not signed" …
  if (/no signing (?:table |subdomain )?match|not signing|message not signed|key .*failed/i.test(rest)) {
    return { kind: 'dkim', ts, queueId, signed: false };
  }
  return null;
}

/** Parse a whole log chunk, dropping lines that carry nothing. */
export function parseMailLog(chunk: string, now = Date.now()): MailLogEvent[] {
  const out: MailLogEvent[] = [];
  for (const line of chunk.split('\n')) {
    if (!line) continue;
    const event = parseMailLogLine(line, now);
    if (event) out.push(event);
  }
  return out;
}

// ---------------------------------------------------------------------------
// postqueue

export interface QueueEntry {
  queueId: string;
  queueName: string;
  arrivalTime: number;
  sizeBytes: number;
  sender: string;
  recipients: { address: string; reason: string | null }[];
}

/**
 * `postqueue -j` emits one JSON object per message (postfix >= 3.1). Unparseable lines are
 * skipped rather than failing the whole listing: a queue view is diagnostics, and half of
 * it beats an error page.
 */
export function parsePostqueueJson(stdout: string): QueueEntry[] {
  const out: QueueEntry[] = [];
  for (const line of stdout.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed.startsWith('{')) continue;
    try {
      const row = JSON.parse(trimmed) as {
        queue_id?: string;
        queue_name?: string;
        arrival_time?: number;
        message_size?: number;
        sender?: string;
        recipients?: { address?: string; delay_reason?: string }[];
      };
      if (!row.queue_id) continue;
      out.push({
        queueId: row.queue_id,
        queueName: row.queue_name ?? 'unknown',
        // postfix reports seconds; the rest of the panel works in milliseconds.
        arrivalTime: (row.arrival_time ?? 0) * 1000,
        sizeBytes: row.message_size ?? 0,
        sender: row.sender ?? '',
        recipients: (row.recipients ?? []).map((r) => ({
          address: r.address ?? '',
          reason: r.delay_reason ?? null,
        })),
      });
    } catch {
      /* not a queue record */
    }
  }
  return out;
}
