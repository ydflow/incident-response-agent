import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import type { ChildProcess } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import { DATA_DIR } from '../src/config.js';
import {
  registerIncidentApprovalRunner,
  revokeIncidentApprovalRunner,
  listLiveIncidentApprovals,
  decideLiveIncidentApproval,
} from '../src/incident-approval-bridge.js';
import { startIncidentApprovalControl } from '../container/agent-runner/src/incident-approval-control.js';
import { incidentApprovalGateForScope } from '../container/agent-runner/src/incident-approval-gate.js';

describe('signed live approval bridge', () => {
  it('rejects forged commands and BLOCK, then delegates ASK decisions to the live Gate once', async () => {
    const groupFolder = `incident-bridge-test-${randomUUID()}`;
    const ipcDir = path.join(DATA_DIR, 'ipc', groupFolder);
    const instanceId = randomUUID();
    const secret = randomUUID() + randomUUID();
    const gate = incidentApprovalGateForScope(groupFolder, 'test-chat');
    const process = {
      exitCode: null,
      signalCode: null,
      killed: false,
    } as unknown as ChildProcess;
    const stop = startIncidentApprovalControl({
      workspaceIpc: ipcDir,
      groupFolder,
      runnerInstanceId: instanceId,
      signingSecret: secret,
    });
    registerIncidentApprovalRunner({
      instanceId,
      secret,
      groupFolder,
      process,
    });
    try {
      const requested = await gate.requestRemediation({
        action: 'restart_service',
        incident_id: 'INC-001',
        target: 'payment-service',
      });
      const id = requested.approval_id!;
      expect(
        (await listLiveIncidentApprovals()).map((item) => item.id),
      ).toContain(id);
      const forgedId = randomUUID();
      await fs.writeFile(
        path.join(ipcDir, 'incident-approval-commands', `${forgedId}.json`),
        JSON.stringify({
          requestId: forgedId,
          runnerInstanceId: instanceId,
          issuedAt: Date.now(),
          operation: 'allow',
          approvalId: id,
          actor: 'forged',
          signature: 'wrong',
        }),
      );
      await new Promise((resolve) => setTimeout(resolve, 450));
      expect(gate.pendingSnapshot().map((item) => item.id)).toContain(id);
      expect(
        gate.events
          .snapshot()
          .filter((item) => item.event_type === 'ActionExecuted'),
      ).toHaveLength(0);
      expect(
        gate.blockProbe('delete_database', 'payment-service').isError,
      ).toBe(true);
      expect(
        (await listLiveIncidentApprovals()).map((item) => item.request.action),
      ).not.toContain('delete_database');
      expect(
        (await decideLiveIncidentApproval(id, 'web:admin', 'allow')).accepted,
      ).toBe(true);
      expect(
        gate.events
          .snapshot()
          .filter((item) => item.event_type === 'ActionExecuted'),
      ).toHaveLength(1);
      expect(
        (await decideLiveIncidentApproval(id, 'web:admin', 'allow')).accepted,
      ).toBe(false);
      const second = await gate.requestRemediation({
        action: 'rollback_config',
        incident_id: 'INC-001',
        target: 'payment-service',
      });
      expect(
        (
          await decideLiveIncidentApproval(
            second.approval_id!,
            'web:admin',
            'reject',
          )
        ).accepted,
      ).toBe(true);
      expect(
        gate.events
          .snapshot()
          .filter((item) => item.event_type === 'ActionExecuted'),
      ).toHaveLength(1);
    } finally {
      stop();
      revokeIncidentApprovalRunner(instanceId);
      const target = path.resolve(ipcDir);
      const parent = path.resolve(DATA_DIR, 'ipc');
      if (
        !target.startsWith(`${parent}${path.sep}`) ||
        !path.basename(target).startsWith('incident-bridge-test-')
      )
        throw new Error('Unsafe test cleanup path');
      await fs.rm(target, { recursive: true, force: true });
    }
  }, 20_000);
});
