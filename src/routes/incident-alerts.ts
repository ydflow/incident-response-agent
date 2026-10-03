import { Hono, type MiddlewareHandler } from 'hono';
import { z } from 'zod';
import { authMiddleware } from '../middleware/auth.js';
import { getUserById } from '../db.js';
import { hasPermission } from '../permissions.js';
import type { AuthUser } from '../types.js';
import type { Variables } from '../web-context.js';
import {
  ALERT_BODY_LIMIT,
  AlertInputError,
  credentialInput,
  LIVE_INCIDENT_ID,
  normalizeAlerts,
  scopeName,
  type AlertAccess,
} from '../incident-alert-types.js';
import { getIncidentStore, type IncidentStore } from '../incident-store.js';
import {
  getInvestigationStore,
  type InvestigationStore,
} from '../incident-investigation-store.js';
import { InvestigationError } from '../incident-investigation-types.js';
import { investigationHistory } from '../incident-investigation-history.js';
import {
  IncidentConsoleLive,
  consoleLiveQuery,
  consoleSectionQuery,
  consoleRedact,
} from '../incident-console-live.js';

type Env = {
  Variables: Variables & {
    alertAccess: AlertAccess;
    machineAlertToken: boolean;
  };
};
type Options = {
  store?: () => IncidentStore;
  getUser?: (id: string) => AuthUser | undefined;
  sessionAuth?: MiddlewareHandler<Env>;
  investigations?: () => InvestigationStore;
};
const querySchema = z.strictObject({
  limit: z.coerce.number().int().min(1).max(100).default(50),
  offset: z.coerce.number().int().min(0).max(10000).default(0),
  source: scopeName.optional(),
  service: scopeName.optional(),
  environment: scopeName.optional(),
});

// Enforce bytes even for chunked requests or a dishonest Content-Length.
async function readJson(request: Request): Promise<unknown> {
  if (Number(request.headers.get('content-length')) > ALERT_BODY_LIMIT)
    throw new AlertInputError('body_too_large', 413);
  if (
    !/^application\/json(?:\s*;|$)/i.test(
      request.headers.get('content-type') ?? '',
    )
  )
    throw new AlertInputError('json_content_type_required');
  const reader = request.body?.getReader();
  if (!reader) throw new AlertInputError('invalid_json');
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const part = await reader.read();
      if (part.done) break;
      size += part.value.byteLength;
      if (size > ALERT_BODY_LIMIT) {
        await reader.cancel();
        throw new AlertInputError('body_too_large', 413);
      }
      chunks.push(part.value);
    }
    return JSON.parse(
      new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks)),
    );
  } catch (error) {
    if (error instanceof AlertInputError) throw error;
    throw new AlertInputError('invalid_json');
  } finally {
    reader.releaseLock();
  }
}

export function createIncidentAlertRoutes(options: Options = {}) {
  const routes = new Hono<Env>();
  const store = options.store ?? getIncidentStore;
  const getUser = options.getUser ?? getUserById;
  const sessionAuth = options.sessionAuth ?? authMiddleware;
  const investigations = options.investigations ?? getInvestigationStore;
  routes.onError((error, c) => {
    if (error instanceof AlertInputError)
      return c.json({ error: error.code }, error.status);
    if (error instanceof InvestigationError)
      return c.json(
        { error: error.code },
        error.code === 'investigation_already_active'
          ? 409
          : [
                'run_not_found',
                'run_incident_mismatch',
                'incident_not_found',
                'reference_not_found',
              ].includes(error.code)
            ? 404
            : 503,
      );
    // Never echo input, credentials or raw SQLite exceptions.
    return c.json({ error: 'alert_store_unavailable' }, 503);
  });
  routes.use('*', async (c, next) => {
    c.header('Cache-Control', 'no-store');
    const authorization = c.req.header('authorization');
    if (authorization !== undefined) {
      const token = /^Bearer ([0-9a-f]{64})$/.exec(authorization)?.[1];
      const credential = token ? store().resolveCredential(token) : null;
      const user = credential ? getUser(credential.owner_user_id) : undefined;
      if (!credential || !user) return c.json({ error: 'Unauthorized' }, 401);
      if (
        user.status !== 'active' ||
        user.must_change_password ||
        !hasPermission(user, 'ingest_alerts')
      )
        return c.json({ error: 'alert_permission_denied' }, 403);
      // This bearer is understood only by this route family. Other APIs retain
      // their existing Cookie auth and cannot acquire admin powers from it.
      c.set('user', {
        id: user.id,
        username: user.username,
        role: user.role,
        status: user.status,
        display_name: user.display_name,
        permissions: user.permissions,
        must_change_password: user.must_change_password,
      });
      c.set('machineAlertToken', true);
      c.set('alertAccess', store().accessForCredential(credential));
      await next();
      return;
    }
    c.set('machineAlertToken', false);
    return sessionAuth(c, next);
  });
  routes.use('*', async (c, next) => {
    const user = c.get('user');
    if (!hasPermission(user, 'ingest_alerts'))
      return c.json({ error: 'alert_permission_denied' }, 403);
    if (!c.get('machineAlertToken'))
      c.set(
        'alertAccess',
        store().accessForUser(user.id, user.role === 'admin'),
      );
    await next();
  });
  routes.use('/credentials/*', async (c, next) => {
    if (c.get('machineAlertToken') || c.get('user').role !== 'admin')
      return c.json({ error: 'admin_session_required' }, 403);
    await next();
  });
  // Also match the collection without a trailing slash.
  routes.use('/credentials', async (c, next) => {
    if (c.get('machineAlertToken') || c.get('user').role !== 'admin')
      return c.json({ error: 'admin_session_required' }, 403);
    await next();
  });
  routes.post('/credentials', async (c) => {
    const parsed = credentialInput.safeParse(await readJson(c.req.raw));
    if (!parsed.success) throw new AlertInputError('invalid_credential');
    const user = getUser(parsed.data.owner_user_id);
    if (
      !user ||
      user.status !== 'active' ||
      user.must_change_password ||
      !hasPermission(user, 'ingest_alerts')
    )
      throw new AlertInputError('invalid_credential_owner');
    // Clear token is returned exactly once and never written into the database.
    return c.json(store().issueCredential(parsed.data), 201);
  });
  routes.post('/credentials/:id/revoke', (c) => {
    const id = z.uuid().safeParse(c.req.param('id'));
    if (!id.success) throw new AlertInputError('invalid_credential_id');
    return store().revokeCredential(id.data)
      ? c.json({ revoked: true })
      : c.json({ error: 'not_found' }, 404);
  });
  const consoleReader = () =>
    new IncidentConsoleLive(store(), investigations());
  routes.get('/console/incidents', (c) => {
    const q = consoleLiveQuery.safeParse(c.req.query());
    if (!q.success) throw new AlertInputError('invalid_console_query');
    return c.json(consoleReader().list(c.get('alertAccess'), q.data));
  });
  routes.get('/console/incidents/:id', (c) => {
    const q = consoleLiveQuery.safeParse(c.req.query());
    if (!q.success || !LIVE_INCIDENT_ID.test(c.req.param('id')))
      throw new AlertInputError('invalid_console_query');
    return c.json(
      consoleReader().detail(c.get('alertAccess'), c.req.param('id'), q.data),
    );
  });
  routes.get('/console/incidents/:id/runs/:run', (c) => {
    const q = consoleSectionQuery.safeParse(c.req.query()),
      id = c.req.param('id'),
      run = c.req.param('run');
    if (
      !q.success ||
      !LIVE_INCIDENT_ID.test(id) ||
      !/^RUN-[0-9a-f-]{36}$/.test(run)
    )
      throw new AlertInputError('invalid_console_query');
    return c.json(
      consoleReader().section(c.get('alertAccess'), id, run, q.data),
    );
  });
  routes.post('/webhook', async (c) => {
    const normalized = normalizeAlerts('webhook', await readJson(c.req.raw));
    const receipt = store().ingest(
      c.get('user').id,
      c.get('alertAccess'),
      'webhook',
      normalized.alerts,
      0,
      c.req.header('idempotency-key'),
    );
    return c.json(receipt, receipt.duplicate ? 200 : 201);
  });
  routes.post('/alertmanager', async (c) => {
    const normalized = normalizeAlerts(
      'alertmanager',
      await readJson(c.req.raw),
    );
    const receipt = store().ingest(
      c.get('user').id,
      c.get('alertAccess'),
      'alertmanager',
      normalized.alerts,
      normalized.truncated_alerts,
      c.req.header('idempotency-key'),
    );
    return c.json(receipt, receipt.duplicate ? 200 : 201);
  });
  routes.get('/', (c) => {
    const query = querySchema.safeParse(c.req.query());
    if (!query.success) throw new AlertInputError('invalid_query');
    return c.json({
      alerts: store().listAlerts(c.get('alertAccess'), query.data),
      limit: query.data.limit,
      offset: query.data.offset,
    });
  });
  routes.get('/incidents', (c) => {
    const query = querySchema.safeParse(c.req.query());
    if (!query.success) throw new AlertInputError('invalid_query');
    return c.json({
      incidents: store().listIncidents(c.get('alertAccess'), query.data),
      limit: query.data.limit,
      offset: query.data.offset,
    });
  });
  routes.get('/incidents/:id', (c) => {
    const id = c.req.param('id');
    if (!LIVE_INCIDENT_ID.test(id))
      throw new AlertInputError('invalid_live_incident_id');
    const result = store().getIncident(c.get('alertAccess'), id);
    return result ? c.json(result) : c.json({ error: 'not_found' }, 404);
  });
  routes.get('/incidents/:id/investigations', (c) => {
    const id = c.req.param('id');
    if (!LIVE_INCIDENT_ID.test(id))
      throw new AlertInputError('invalid_live_incident_id');
    if (!store().getIncident(c.get('alertAccess'), id))
      return c.json({ error: 'not_found' }, 404);
    return c.json(consoleRedact({ investigations: investigations().list(id) }));
  });
  routes.get('/incidents/:id/investigations/:run', (c) => {
    const id = c.req.param('id'),
      run = c.req.param('run');
    if (!LIVE_INCIDENT_ID.test(id) || !/^RUN-[0-9a-f-]{36}$/.test(run))
      throw new AlertInputError('invalid_investigation_id');
    if (!store().getIncident(c.get('alertAccess'), id))
      return c.json({ error: 'not_found' }, 404);
    return c.json(
      consoleRedact(investigationHistory(investigations(), id, run)),
    );
  });
  routes.post('/incidents/:id/investigations', (c) => {
    if (c.get('machineAlertToken') || c.get('user').role !== 'admin')
      return c.json({ error: 'investigation_recheck_admin_only' }, 403);
    const id = c.req.param('id');
    if (!LIVE_INCIDENT_ID.test(id))
      throw new AlertInputError('invalid_live_incident_id');
    if (!store().getIncident(c.get('alertAccess'), id))
      return c.json({ error: 'not_found' }, 404);
    return c.json({ investigation: investigations().enqueue(id, true) }, 201);
  });
  return routes;
}
export default createIncidentAlertRoutes();
