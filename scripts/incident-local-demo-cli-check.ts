/** Exercise exactly the documented operator CLI in our own child processes. */
import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { once } from 'node:events';
import { randomBytes, randomUUID } from 'node:crypto';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';

export async function checkLocalDemoCli() {
  const loader = fileURLToPath(import.meta.resolve('tsx/cli'));
  const cli = fileURLToPath(
    new URL('./incident-local-demo.ts', import.meta.url),
  );
  const env = {
    ...process.env,
    FAULT_DEMO_PORT: '0',
    FAULT_DEMO_SOURCE_ID: 'cli-pool-local',
    FAULT_DEMO_SERVICE: 'payment-service',
    FAULT_DEMO_ENVIRONMENT: 'local',
    FAULT_DEMO_READ_TOKEN: randomBytes(32).toString('hex'),
    FAULT_DEMO_CONTROL_TOKEN: randomBytes(32).toString('hex'),
    FAULT_DEMO_INSTANCE_ID: '',
  };
  const owned = spawn(
    process.execPath,
    [loader, cli, 'serve', '--ttl-seconds', '60'],
    { env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] },
  );
  // Drain bounded service diagnostics without publishing raw child output.
  owned.stderr.resume();
  try {
    const ready = await new Promise<{ port: number; instance_id: string }>(
      (resolve, reject) => {
        let buffered = '';
        const timer = setTimeout(() => {
          cleanup();
          reject(new Error('cli_start_timeout'));
        }, 10000);
        const cleanup = () => {
          clearTimeout(timer);
          owned.stdout.removeListener('data', data);
          owned.removeListener('exit', exited);
          owned.removeListener('error', failed);
        };
        const data = (chunk: Buffer) => {
          buffered += chunk.toString();
          if (buffered.length > 4096) {
            cleanup();
            reject(new Error('invalid_cli_start_response'));
            return;
          }
          if (buffered.includes('\n')) {
            cleanup();
            try {
              resolve(JSON.parse(buffered.split('\n')[0]));
            } catch {
              reject(new Error('invalid_cli_start_response'));
            }
          }
        };
        const exited = () => {
          cleanup();
          reject(new Error('cli_service_exited'));
        };
        const failed = () => {
          cleanup();
          reject(new Error('cli_spawn_failed'));
        };
        owned.stdout.on('data', data);
        owned.once('exit', exited);
        owned.once('error', failed);
      },
    );
    assert.ok(
      Number.isInteger(ready.port) && ready.port > 0 && ready.port <= 65535,
    );
    env.FAULT_DEMO_PORT = String(ready.port);
    env.FAULT_DEMO_INSTANCE_ID = ready.instance_id;
    const invoke = async (args: string[], expectedExit = 0) => {
      try {
        const result = await promisify(execFile)(
          process.execPath,
          [loader, cli, ...args],
          { env, windowsHide: true, timeout: 10000, maxBuffer: 8192 },
        );
        assert.equal(expectedExit, 0);
        return JSON.parse(result.stdout.trim());
      } catch (error) {
        const failure = error as { code?: number; stdout?: string };
        if (
          expectedExit !== 0 &&
          failure.code === expectedExit &&
          failure.stdout
        )
          return JSON.parse(failure.stdout.trim());
        throw new Error('cli_command_failed');
      }
    };
    const id = `LIVE-${randomUUID()}`;
    assert.equal(
      (await invoke(['query', '--incident-id', id, '--kind', 'logs'])).status,
      'empty',
    );
    await invoke(['fault']);
    assert.ok(
      (await invoke(['load', '--requests', '6', '--concurrency', '4']))
        .resource_failures > 0,
    );
    assert.ok(
      (
        await invoke(['query', '--incident-id', id, '--kind', 'logs'])
      ).messages.includes('pool_timeout'),
    );
    assert.equal(
      (await invoke(['query', '--incident-id', id, '--kind', 'metrics']))
        .latest_sample.pool_capacity,
      1,
    );
    assert.equal(
      (await invoke(['query', '--incident-id', id, '--kind', 'trace'], 1))
        .error,
      'unsupported',
    );
    await invoke(['recover']);
    const recovered = await invoke([
      'load',
      '--requests',
      '6',
      '--concurrency',
      '4',
    ]);
    assert.equal(recovered.success, 6);
    assert.equal(recovered.resource_failures, 0);
    assert.equal(
      (await invoke(['query', '--incident-id', id, '--kind', 'metrics']))
        .latest_sample.pool_capacity,
      8,
    );
    const exited = once(owned, 'exit');
    owned.kill('SIGTERM');
    await exited;
    assert.equal(
      (await invoke(['query', '--incident-id', id, '--kind', 'metrics'], 1))
        .error,
      'unavailable',
    );
    return {
      operator_cli: 'PASS',
      cli_fault_requests: 6,
      cli_recovery_successes: 6,
    };
  } finally {
    if (owned.exitCode === null && owned.signalCode === null) {
      const exited = once(owned, 'exit');
      owned.kill('SIGTERM');
      await exited;
    }
  }
}
