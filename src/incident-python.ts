/** Host-selected interpreter; never supplied by an Agent/tool argument. */
import fs from 'node:fs';
import path from 'node:path';

export function incidentPythonCommand(
  repo: string,
  platform = process.platform,
) {
  const local = path.join(
    repo,
    '.venv',
    platform === 'win32' ? 'Scripts/python.exe' : 'bin/python',
  );
  if (fs.existsSync(local))
    return { executable: local, prefix: [] as string[] };
  return platform === 'win32'
    ? { executable: 'py', prefix: ['-3.13'] }
    : { executable: 'python3', prefix: [] as string[] };
}
