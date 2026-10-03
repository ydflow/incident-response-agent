import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { expect, test } from 'vitest';
import { incidentPythonCommand } from '../src/incident-python.js';

test('host interpreter supports Windows, POSIX and a repository virtual environment', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'incident-python-'));
  try {
    expect(incidentPythonCommand(root, 'win32')).toEqual({
      executable: 'py',
      prefix: ['-3.13'],
    });
    expect(incidentPythonCommand(root, 'linux')).toEqual({
      executable: 'python3',
      prefix: [],
    });
    const executable = path.join(root, '.venv', 'Scripts', 'python.exe');
    fs.mkdirSync(path.dirname(executable), { recursive: true });
    fs.writeFileSync(executable, 'test placeholder, not executed');
    expect(incidentPythonCommand(root, 'win32')).toEqual({
      executable,
      prefix: [],
    });
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
