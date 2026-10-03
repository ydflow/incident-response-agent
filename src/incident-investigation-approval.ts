/** Host-only proposal binding. Decisions record intent; no executor is exposed. */
import { createHash, randomUUID } from 'node:crypto';
import { InvestigationStore } from './incident-investigation-store.js';
import {
  boundedJson,
  fail,
  proposalSchema,
  type Lease,
} from './incident-investigation-types.js';

export class BoundInvestigationApprovals {
  private readonly instance = randomUUID();
  private readonly handles = new Map<
    string,
    { lease: Lease; request: string; expires: number }
  >();
  constructor(private readonly store: InvestigationStore) {}
  request(
    lease: Lease,
    proposal: unknown,
    ttlMs = 60000,
    now = Date.now(),
  ): string {
    return this.store.db
      .transaction(() => {
        const { job, run } = this.store.assertLease(lease, now),
          parsed = proposalSchema.parse(proposal);
        if (
          parsed.target !== this.store.snapshot(job.incident_id).service ||
          ttlMs < 1 ||
          ttlMs > 60000
        )
          fail('approval_scope');
        const expires = Math.min(
          now + ttlMs,
          run.deadline_at,
          job.lease_expires_at!,
        );
        const request = boundedJson({
          incident_id: job.incident_id,
          run_id: lease.run_id,
          ...parsed,
          expires_at: expires,
        });
        const id = randomUUID(),
          hash = createHash('sha256').update(request).digest('hex');
        this.store.db
          .prepare(
            "INSERT INTO incident_investigation_approvals VALUES(?,?,?,?,?,?,?,'pending',?,NULL)",
          )
          .run(
            id,
            lease.run_id,
            lease.token,
            this.instance,
            hash,
            request,
            expires,
            now,
          );
        this.handles.set(id, { lease: { ...lease }, request, expires });
        return id;
      })
      .immediate();
  }
  /** This object is held by trusted host code only, never supplied to the model. */
  decide(
    id: string,
    decision: 'approved' | 'rejected',
    proposal: unknown,
    now = Date.now(),
  ): { state: string; execution_authorized: false } {
    return this.store.db
      .transaction(() => {
        const handle = this.handles.get(id);
        if (!handle) fail('approval_live_handle_missing');
        this.store.assertLease(handle.lease, now);
        const row = this.store.db
          .prepare(
            'SELECT * FROM incident_investigation_approvals WHERE approval_id=?',
          )
          .get(id) as any;
        if (
          !row ||
          row.state !== 'pending' ||
          row.runner_instance !== this.instance ||
          row.lease_token !== handle.lease.token
        )
          fail('approval_binding');
        if (now >= handle.expires) {
          this.handles.delete(id);
          fail('approval_expired');
        }
        const parsed = proposalSchema.parse(proposal),
          record = JSON.parse(handle.request);
        if (
          boundedJson({ ...record, ...parsed }) !== handle.request ||
          createHash('sha256').update(row.request_json).digest('hex') !==
            row.request_hash ||
          row.request_json !== handle.request
        )
          fail('approval_parameters_changed');
        if (!['approved', 'rejected'].includes(decision))
          fail('approval_decision');
        this.store.db
          .prepare(
            'UPDATE incident_investigation_approvals SET state=?,decided_at=? WHERE approval_id=?',
          )
          .run(decision, now, id);
        this.handles.delete(id);
        return { state: decision, execution_authorized: false as const };
      })
      .immediate();
  }
}
