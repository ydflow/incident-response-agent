/** Untrusted alert DTOs. Never extend the four-field Incident/Fixture schema. */
import { createHash } from 'node:crypto';
import { z } from 'zod';

export const ALERT_BODY_LIMIT = 256 * 1024;
export const AGGREGATION_WINDOW_MS = 15 * 60 * 1000;
export const LIVE_INCIDENT_ID =
  /^LIVE-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
export const scopeName = z
  .string()
  .trim()
  .min(1)
  .max(100)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/);
const instant = z.iso.datetime({ offset: true });
const labels = z
  .record(z.string().min(1).max(100), z.string().max(2048))
  .refine((value) => Object.keys(value).length <= 64);
const webhook = z.strictObject({
  source: scopeName,
  external_id: z.string().trim().max(128).default(''),
  service: scopeName,
  environment: scopeName,
  severity: z.string().trim().max(64),
  alert_type: z.string().trim().max(64).default('PROBLEM'),
  fingerprint: scopeName.optional(),
  starts_at: instant,
  ends_at: instant.nullish(),
  status: z.enum(['firing', 'resolved']),
  summary: z.string().trim().min(1).max(2048),
  description: z.string().max(4096).default(''),
  labels: labels.default({}),
});
const amItem = z.object({
  status: z.enum(['firing', 'resolved']),
  labels,
  annotations: labels.default({}),
  startsAt: instant,
  endsAt: instant.optional(),
  fingerprint: scopeName.optional(),
  generatorURL: z.string().max(2048).optional(),
});
// Official transport metadata is accepted, never fetched or treated as evidence.
const alertmanager = z.strictObject({
  version: z.literal('4'),
  receiver: z.string().max(200),
  status: z.enum(['firing', 'resolved']),
  alerts: z.array(amItem).min(1).max(50),
  groupKey: z.string().max(2048),
  groupLabels: labels.default({}),
  commonLabels: labels.default({}),
  commonAnnotations: labels.default({}),
  externalURL: z.string().max(2048).optional(),
  truncatedAlerts: z.number().int().min(0).default(0),
});
export const scopePair = z.strictObject({
  service: scopeName,
  environment: scopeName,
});
export const credentialInput = z.strictObject({
  owner_user_id: z.string().min(1).max(128),
  source: scopeName,
  scopes: z.array(scopePair).min(1).max(32),
  expires_at: instant,
});
export type AlertPriority = 'P0' | 'P1' | 'P2' | 'P3';
export type AlertScope = z.infer<typeof scopePair>;
export type CredentialInput = z.infer<typeof credentialInput>;
export type AlertAccess = {
  all: boolean;
  grants: Array<AlertScope & { source: string; source_scope: string }>;
};
export type NormalizedAlert = {
  source: string;
  external_id: string;
  service: string;
  environment: string;
  severity: AlertPriority | null;
  severity_raw: string;
  severity_mapping_status: 'known' | 'unknown';
  alert_type: 'PROBLEM' | 'BUSINESS' | 'EVENT' | 'HOST' | 'UNKNOWN';
  alert_type_raw: string;
  fingerprint: string;
  starts_at: string;
  ends_at: string | null;
  status: 'firing' | 'resolved';
  source_summary: { summary: string; description: string };
};
export class AlertInputError extends Error {
  constructor(
    readonly code: string,
    readonly status: 400 | 403 | 409 | 413 = 400,
  ) {
    super(code);
  }
}
export const digest = (value: string): string =>
  createHash('sha256').update(value).digest('hex');
export const sourceScope = (owner: string, source: string): string =>
  digest(JSON.stringify([owner, source]));

/** Redact values too: excluding secret keys alone cannot protect free text. */
export function sanitizeAlertText(text: string): string {
  return text
    .replace(/\b(?:Bearer|Basic)\s+[^\s,;"']+/gi, '[REDACTED]')
    .replace(/\b(?:sk-|sk_|ghp_|github_pat_)[A-Za-z0-9_-]+/g, '[REDACTED]')
    .replace(
      /\b((?:(?:access|refresh|auth|client|db)[_-])?(?:password|passwd|secret|token)|api[_-]?key|authorization|cookie)["']?\s*[:=]\s*(?:"[^"]*"|'[^']*'|[^\s,;}]+)/gi,
      '$1=[REDACTED]',
    )
    .replace(/https?:\/\/[^\s"'<>]+/gi, '[URL REDACTED]')
    .replace(
      /[A-Za-z0-9._%+-]{1,64}@[A-Za-z0-9.-]{1,253}\.[A-Za-z]{2,63}/g,
      '[EMAIL REDACTED]',
    );
}
const severityAliases: Record<string, AlertPriority> = {
  p0: 'P0',
  sev0: 'P0',
  '0': 'P0',
  emergency: 'P0',
  blocker: 'P0',
  p1: 'P1',
  sev1: 'P1',
  '1': 'P1',
  critical: 'P1',
  fatal: 'P1',
  high: 'P1',
  page: 'P1',
  p2: 'P2',
  sev2: 'P2',
  '2': 'P2',
  warning: 'P2',
  warn: 'P2',
  medium: 'P2',
  p3: 'P3',
  sev3: 'P3',
  '3': 'P3',
  info: 'P3',
  informational: 'P3',
  low: 'P3',
};
function normalize(
  input: z.infer<typeof webhook>,
  now: number,
): NormalizedAlert {
  const started = Date.parse(input.starts_at);
  const ended =
    input.ends_at && !input.ends_at.startsWith('0001-01-01')
      ? Date.parse(input.ends_at)
      : null;
  if (
    !Number.isFinite(started) ||
    started > now + 300_000 ||
    (ended !== null && (!Number.isFinite(ended) || ended < started)) ||
    (input.status === 'resolved' && (ended === null || ended > now + 300_000))
  ) {
    throw new AlertInputError('invalid_alert_time');
  }
  const raw = sanitizeAlertText(input.severity);
  const severity = Object.hasOwn(severityAliases, input.severity.toLowerCase())
    ? severityAliases[input.severity.toLowerCase()]
    : null;
  const type = input.alert_type.toUpperCase();
  const alertType = ['PROBLEM', 'BUSINESS', 'EVENT', 'HOST'].includes(type)
    ? (type as NormalizedAlert['alert_type'])
    : 'UNKNOWN';
  const summary = sanitizeAlertText(input.summary);
  const description = sanitizeAlertText(input.description);
  const sanitizedExternalId = sanitizeAlertText(input.external_id);
  // Redaction placeholders must not collapse distinct source identities.
  const externalId =
    sanitizedExternalId === input.external_id
      ? sanitizedExternalId
      : `sha256:${digest(input.external_id)}`;
  // Total JSON summary <= 2048 bytes, including escaping/multibyte characters.
  const source_summary = { summary: '', description: '' };
  for (const field of ['summary', 'description'] as const) {
    for (const character of field === 'summary' ? summary : description) {
      source_summary[field] += character;
      if (Buffer.byteLength(JSON.stringify(source_summary)) > 2048) {
        source_summary[field] = source_summary[field].slice(
          0,
          -character.length,
        );
        break;
      }
    }
  }
  return {
    source: input.source,
    external_id: externalId,
    service: input.service,
    environment: input.environment,
    severity,
    severity_raw: raw,
    severity_mapping_status: severity ? 'known' : 'unknown',
    alert_type: alertType,
    alert_type_raw: sanitizeAlertText(input.alert_type),
    fingerprint:
      input.fingerprint ??
      digest(
        JSON.stringify([
          input.source,
          input.service,
          input.environment,
          alertType,
          summary,
        ]),
      ),
    starts_at: new Date(started).toISOString(),
    ends_at: ended === null ? null : new Date(ended).toISOString(),
    status: input.status,
    source_summary,
  };
}
export function normalizeAlerts(
  kind: 'webhook' | 'alertmanager',
  body: unknown,
  now = Date.now(),
): { alerts: NormalizedAlert[]; truncated_alerts: number } {
  if (kind === 'webhook') {
    const parsed = webhook.safeParse(body);
    if (!parsed.success) throw new AlertInputError('invalid_webhook');
    return { alerts: [normalize(parsed.data, now)], truncated_alerts: 0 };
  }
  const parsed = alertmanager.safeParse(body);
  if (!parsed.success) throw new AlertInputError('invalid_alertmanager');
  const alerts = parsed.data.alerts.map((item) => {
    const candidate = webhook.safeParse({
      source: 'alertmanager',
      external_id: item.labels.external_id ?? item.fingerprint ?? '',
      service: item.labels.service,
      environment: item.labels.environment,
      severity: item.labels.severity ?? item.labels.priority ?? '',
      alert_type: item.labels.alert_type ?? 'PROBLEM',
      fingerprint: item.fingerprint,
      starts_at: item.startsAt,
      ends_at: item.endsAt,
      status: item.status,
      summary:
        item.annotations.summary ??
        item.labels.alertname ??
        'Alertmanager alert',
      description: item.annotations.description ?? '',
    });
    if (!candidate.success)
      throw new AlertInputError('invalid_alertmanager_item');
    return normalize(candidate.data, now);
  });
  return { alerts, truncated_alerts: parsed.data.truncatedAlerts };
}
export function assertAlertScope(
  alert: NormalizedAlert,
  access: AlertAccess,
): void {
  if (
    !access.all &&
    !access.grants.some(
      (grant) =>
        grant.source === alert.source &&
        grant.service === alert.service &&
        grant.environment === alert.environment,
    )
  ) {
    throw new AlertInputError('alert_scope_denied', 403);
  }
}
