import { describe, expect, test } from 'vitest';
import { normalizeAlerts } from '../src/incident-alert-types.js';
const now = Date.now();
const body = {
  source: 'demo',
  service: 'orders',
  environment: 'local',
  severity: 'critical',
  starts_at: new Date(now - 1000).toISOString(),
  status: 'firing',
  summary: 'Pool exhausted',
};
const amItem = {
  status: 'firing',
  labels: {
    service: 'orders',
    environment: 'local',
    severity: 'warning',
    alertname: 'PoolExhausted',
  },
  annotations: { summary: 'Pool exhausted' },
  startsAt: body.starts_at,
  endsAt: '0001-01-01T00:00:00Z',
  fingerprint: 'abcd',
};
const am = {
  version: '4',
  receiver: 'incident',
  status: 'firing',
  alerts: [amItem],
  groupKey: '{}:{}',
};
describe('untrusted alert normalization', () => {
  test('redacted external identities stay distinct and stable without retaining their secrets', () => {
    const first = normalizeAlerts(
      'webhook',
      { ...body, external_id: 'token=first-private' },
      now,
    ).alerts[0];
    const second = normalizeAlerts(
      'webhook',
      { ...body, external_id: 'token=second-private' },
      now,
    ).alerts[0];
    expect(first.external_id).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(first.external_id).not.toBe(second.external_id);
    expect(JSON.stringify([first, second])).not.toContain('private');
    expect(
      normalizeAlerts(
        'webhook',
        { ...body, external_id: 'token=first-private' },
        now,
      ).alerts[0].external_id,
    ).toBe(first.external_id);
  });
  test.each([
    ['P0', 'P0'],
    ['critical', 'P1'],
    ['sev1', 'P1'],
    ['HIGH', 'P1'],
    ['warning', 'P2'],
    ['info', 'P3'],
    ['weird', null],
    ['', null],
    ['__proto__', null],
  ])('maps %s to %s explicitly', (input, expected) => {
    const alert = normalizeAlerts('webhook', { ...body, severity: input }, now)
      .alerts[0];
    expect(alert.severity).toBe(expected);
    expect(alert.severity_mapping_status).toBe(expected ? 'known' : 'unknown');
    expect(alert.severity_raw).toBe(input);
    expect(alert).not.toHaveProperty('risk');
  });
  test.each([
    { environment: '' },
    { service: '../data' },
    { starts_at: 'bad' },
    { starts_at: new Date(now + 600000).toISOString() },
    { status: 'unknown' },
    { status: 'resolved' },
    { status: 'resolved', ends_at: new Date(now - 2000).toISOString() },
    { extra: 'unexpected' },
    { summary: '' },
  ])('rejects invalid input %j', (change) => {
    expect(() =>
      normalizeAlerts('webhook', { ...body, ...change }, now),
    ).toThrow();
  });
  test('does not retain arbitrary labels/URLs and redacts credentials and personal text before storage', () => {
    const alert = normalizeAlerts(
      'webhook',
      {
        ...body,
        summary:
          'pool token=private-value Bearer abcdef sk-demo-secret user@example.com https://host/a?secret=123',
        description:
          'password="my-secret" {"access_token":"json-secret","client_secret":"client-credential"}',
        labels: { secret: 'discard-me' },
        alert_type: 'new-type',
      },
      now,
    ).alerts[0];
    const text = JSON.stringify(alert);
    for (const secret of [
      'private-value',
      'abcdef',
      'sk-demo-secret',
      'user@example.com',
      'my-secret',
      'json-secret',
      'client-credential',
      'discard-me',
      'https://host',
    ])
      expect(text).not.toContain(secret);
    expect(alert.alert_type).toBe('UNKNOWN');
    expect(alert.alert_type_raw).toBe('new-type');
  });
  test('summary serialized bytes stay bounded with multibyte text', () => {
    const alert = normalizeAlerts(
      'webhook',
      { ...body, summary: '连接池'.repeat(600), description: 'x'.repeat(4000) },
      now,
    ).alerts[0];
    expect(
      Buffer.byteLength(JSON.stringify(alert.source_summary)),
    ).toBeLessThanOrEqual(2048);
  });
  test('UTC canonicalization deduplicates equivalent timezone spellings', () => {
    expect(
      normalizeAlerts(
        'webhook',
        { ...body, starts_at: '2026-10-02T09:00:00+08:00' },
        Date.parse('2026-10-02T02:00Z'),
      ).alerts[0].starts_at,
    ).toBe('2026-10-02T01:00:00.000Z');
  });
  test('Alertmanager v4 maps individual status, zero end, unknown priority and reported truncation', () => {
    const result = normalizeAlerts(
      'alertmanager',
      {
        ...am,
        truncatedAlerts: 5,
        alerts: [
          amItem,
          {
            ...amItem,
            fingerprint: 'abcd2',
            status: 'resolved',
            endsAt: new Date(now).toISOString(),
            labels: { ...amItem.labels, severity: 'unknown' },
          },
        ],
      },
      now,
    );
    expect(result.truncated_alerts).toBe(5);
    expect(result.alerts[0]).toMatchObject({
      source: 'alertmanager',
      status: 'firing',
      ends_at: null,
      severity: 'P2',
    });
    expect(result.alerts[1]).toMatchObject({
      status: 'resolved',
      severity: null,
      severity_mapping_status: 'unknown',
    });
  });
  test.each([
    { version: '3' },
    { alerts: [] },
    { alerts: [{ ...amItem, labels: { service: 'orders' } }] },
    { alerts: [{ ...amItem, status: 'resolved' }] },
  ])('rejects incompatible AM input %j', (change) => {
    expect(() =>
      normalizeAlerts('alertmanager', { ...am, ...change }, now),
    ).toThrow();
  });
});
