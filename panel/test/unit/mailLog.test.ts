import { describe, expect, it } from 'vitest';
import {
  parseMailLog,
  parseMailLogLine,
  parsePostqueueJson,
  parseSyslogTimestamp,
  siteSlugFromClient,
} from '../../src/lib/mailLog.js';

/** Verbatim output of boky/postfix (rsyslog, RFC3339 timestamps + a level column). */
const RSYSLOG_SESSION = `
2026-09-18T05:39:23.781211+00:00 INFO    postfix/smtpd[984]: connect from wp-acme.wpl7_proxy[172.22.0.5]
2026-09-18T05:39:23.792921+00:00 INFO    postfix/smtpd[984]: C17462B13: client=wp-acme.wpl7_proxy[172.22.0.5]
2026-09-18T05:39:23.793610+00:00 INFO    postfix/cleanup[989]: C17462B13: message-id=<abc@acme.test>
2026-09-18T05:39:24.121100+00:00 INFO    postfix/qmgr[978]: C17462B13: from=<wordpress@acme.test>, size=443, nrcpt=1 (queue active)
2026-09-18T05:39:24.121261+00:00 INFO    postfix/smtpd[984]: disconnect from wp-acme.wpl7_proxy[172.22.0.5] ehlo=1 mail=1 rcpt=1 data=1 quit=1 commands=5
2026-09-18T05:39:24.161156+00:00 INFO    postfix/smtp[990]: C17462B13: to=<customer@somewhere.test>, relay=mx.somewhere.test[203.0.113.9]:25, delay=0.37, delays=0.33/0.02/0.01/0.01, dsn=2.0.0, status=sent (250 2.0.0 Ok: queued as 5UwqS2)
2026-09-18T05:39:24.161301+00:00 INFO    postfix/qmgr[978]: C17462B13: removed
`.trim();

describe('parseMailLogLine', () => {
  it('reads the envelope, the recipient and the delivery result', () => {
    const events = parseMailLog(RSYSLOG_SESSION);
    expect(events.map((e) => e.kind)).toEqual(['envelope', 'envelope', 'delivery']);

    const [client, from, delivery] = events;
    expect(client).toMatchObject({ queueId: 'C17462B13', clientHost: 'wp-acme.wpl7_proxy', clientIp: '172.22.0.5' });
    expect(from).toMatchObject({ queueId: 'C17462B13', from: 'wordpress@acme.test', sizeBytes: 443, nrcpt: 1 });
    expect(delivery).toMatchObject({
      queueId: 'C17462B13',
      to: 'customer@somewhere.test',
      status: 'sent',
      relay: 'mx.somewhere.test[203.0.113.9]:25',
      dsn: '2.0.0',
      delayMs: 370,
    });
    expect((delivery as { detail?: string }).detail).toBe('(250 2.0.0 Ok: queued as 5UwqS2)');
  });

  it('understands the classic BSD syslog shape too', () => {
    const event = parseMailLogLine(
      'Sep 18 05:39:24 mailhost postfix/qmgr[2531]: 4F9D195432C: from=<a@b.test>, size=344, nrcpt=2 (queue active)',
      Date.UTC(2026, 8, 18, 6, 0, 0),
    );
    expect(event).toMatchObject({ kind: 'envelope', queueId: '4F9D195432C', from: 'a@b.test', nrcpt: 2 });
  });

  it('keeps the failure reason on a deferred delivery', () => {
    const event = parseMailLogLine(
      '2026-09-18T05:40:18+00:00 INFO    postfix/smtp[12]: 963F22B10: to=<nobody@invalid.test>, relay=none, delay=1.2, delays=1/0/0.2/0, dsn=4.4.1, status=deferred (connect to invalid.test[203.0.113.1]:25: Connection refused)',
    );
    expect(event).toMatchObject({ kind: 'delivery', status: 'deferred', dsn: '4.4.1' });
    expect((event as { detail?: string }).detail).toContain('Connection refused');
  });

  it('maps a bounce to a terminal failure', () => {
    const event = parseMailLogLine(
      '2026-09-18T05:40:18+00:00 INFO    postfix/smtp[12]: 4F9D195432C: to=<no@such.test>, relay=mx[1.2.3.4]:25, delay=2, dsn=5.1.1, status=bounced (550 5.1.1 User unknown)',
    );
    expect(event).toMatchObject({ kind: 'delivery', status: 'bounced' });
  });

  it('records a refusal that never reached the queue', () => {
    const event = parseMailLogLine(
      '2026-09-18T05:41:00+00:00 INFO    postfix/smtpd[9]: NOQUEUE: reject: RCPT from unknown[198.51.100.7]: 554 5.7.1 <relay@elsewhere.test>: Relay access denied; from=<spam@bad.test> to=<relay@elsewhere.test> proto=ESMTP',
    );
    expect(event).toMatchObject({
      kind: 'reject',
      clientHost: 'unknown',
      clientIp: '198.51.100.7',
      from: 'spam@bad.test',
      to: 'relay@elsewhere.test',
    });
    expect((event as { detail?: string }).detail).toContain('Relay access denied');
  });

  it('keeps the sender of a message the milter refused', () => {
    // A rejection is the one case where no `qmgr: from=` line ever follows, so the sender
    // has to come off this line or the row shows an empty From.
    const event = parseMailLogLine(
      '2026-09-18T06:04:59+00:00 INFO    postfix/cleanup[958]: 24F9C2B39: milter-reject: END-OF-MESSAGE from wp-acme.wpl7_proxy[172.19.0.5]: 4.7.1 Service unavailable - try again later; from=<wordpress@acme.test> to=<customer@somewhere.test> proto=ESMTP',
    );
    expect(event).toMatchObject({
      kind: 'delivery',
      queueId: '24F9C2B39',
      status: 'rejected',
      from: 'wordpress@acme.test',
      to: 'customer@somewhere.test',
    });
  });

  it('does not invent a message from a NOQUEUE line that is not a rejection', () => {
    // "lost connection" shares the NOQUEUE prefix but describes no message; treating it as
    // a rejection produced a blank traffic row for every disconnect.
    expect(
      parseMailLogLine(
        '2026-09-18T06:04:59+00:00 INFO    postfix/smtpd[953]: NOQUEUE: lost connection after RSET from wp-acme.wpl7_proxy[172.19.0.5]',
      ),
    ).toBeNull();
    expect(
      parseMailLogLine(
        '2026-09-18T06:04:59+00:00 INFO    postfix/smtpd[953]: NOQUEUE: timeout after DATA from unknown[198.51.100.7]',
      ),
    ).toBeNull();
  });

  it('attributes an OpenDKIM signature to the postfix queue id', () => {
    const event = parseMailLogLine(
      'Sep 18 05:39:24 3734fd2ad7fa opendkim[85]: C17462B13: DKIM-Signature field added (s=wpl7, d=acme.test)',
      Date.UTC(2026, 8, 18, 6, 0, 0),
    );
    expect(event).toEqual({
      kind: 'dkim',
      ts: Date.UTC(2026, 8, 18, 5, 39, 24),
      queueId: 'C17462B13',
      signed: true,
      selector: 'wpl7',
      domain: 'acme.test',
    });
  });

  it('records a message OpenDKIM declined to sign', () => {
    const event = parseMailLogLine(
      'Sep 18 05:39:24 host opendkim[85]: 4F9D195432C: no signing table match for \'nobody@unknown.test\'',
      Date.UTC(2026, 8, 18, 6, 0, 0),
    );
    expect(event).toMatchObject({ kind: 'dkim', signed: false });
  });

  it('ignores daemon chatter that carries no traffic information', () => {
    for (const line of [
      '2026-09-18T05:38:57+00:00 INFO    postfix/master[976]: daemon started -- version 3.10.5',
      '2026-09-18T05:39:23+00:00 INFO    postfix/smtpd[984]: connect from wp-acme.wpl7_proxy[172.22.0.5]',
      '2026-09-18T05:39:24+00:00 INFO    postfix/qmgr[978]: C17462B13: removed',
      '2026-09-18T05:39:24+00:00 INFO    postfix/smtpd[9]: warning: hostname x does not resolve',
      '‣ NOTE  Starting: rsyslog, crond, postfix',
      '',
    ]) {
      expect(parseMailLogLine(line), line).toBeNull();
    }
  });
});

describe('parseSyslogTimestamp', () => {
  it('rolls a year back when a BSD timestamp would otherwise be in the future', () => {
    // A December line read on 2 January must not be dated a year ahead.
    const now = Date.UTC(2027, 0, 2, 12, 0, 0);
    const ts = parseSyslogTimestamp('Dec 28 23:00:00 mailhost ', now);
    expect(new Date(ts!).getUTCFullYear()).toBe(2026);
  });

  it('falls back to null when there is no timestamp to read', () => {
    expect(parseSyslogTimestamp('no date here ', Date.now())).toBeNull();
  });
});

describe('siteSlugFromClient', () => {
  it('takes the site from the connecting container, not from the From: header', () => {
    expect(siteSlugFromClient('wp-acme.wpl7_proxy')).toBe('acme');
    expect(siteSlugFromClient('wp-my-shop.wpl7_proxy')).toBe('my-shop');
  });

  it('returns null for anything that is not a site container', () => {
    expect(siteSlugFromClient('unknown')).toBeNull();
    expect(siteSlugFromClient('localhost')).toBeNull();
    expect(siteSlugFromClient('wp-')).toBeNull();
    expect(siteSlugFromClient(null)).toBeNull();
  });
});

describe('parsePostqueueJson', () => {
  it('reads postfix 3.x JSON queue records', () => {
    const entries = parsePostqueueJson(
      [
        '{"queue_name": "deferred", "queue_id": "963F22B10", "arrival_time": 1789710018, "message_size": 312, "sender": "wordpress@acme.test", "recipients": [{"address": "nobody@invalid.test", "delay_reason": "Connection refused"}]}',
        'Mail queue is empty',
      ].join('\n'),
    );
    expect(entries).toEqual([
      {
        queueId: '963F22B10',
        queueName: 'deferred',
        arrivalTime: 1789710018_000,
        sizeBytes: 312,
        sender: 'wordpress@acme.test',
        recipients: [{ address: 'nobody@invalid.test', reason: 'Connection refused' }],
      },
    ]);
  });

  it('skips unparseable records rather than losing the whole listing', () => {
    const entries = parsePostqueueJson('{"queue_id": "A1", "sender": "a@b.test"}\n{broken\n');
    expect(entries).toHaveLength(1);
    expect(entries[0]!.recipients).toEqual([]);
  });
});
