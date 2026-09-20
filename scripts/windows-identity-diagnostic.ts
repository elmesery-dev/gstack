import { spawnSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
const target = Bun.spawn([process.execPath, '-e', 'console.log("ready"); setInterval(() => {}, 1000)', '--gstack-design-daemon'], { stdout: 'pipe', stderr: 'pipe' });
const reader = target.stdout.getReader();
await reader.read();
reader.releaseLock();
const restricted = { PATH: process.env.PATH ?? '', ...(process.env.SystemRoot ? { SystemRoot: process.env.SystemRoot } : {}) };
const probe = `
import { spawnSync } from 'node:child_process';
const input = JSON.parse(await Bun.stdin.text());
const started = Date.now();
const result = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', input.command], {
 encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: input.timeout, windowsHide: true,
});
console.log(JSON.stringify({ elapsedMs: Date.now() - started, status: result.status, signal: result.signal,
 error: result.error ? { name: result.error.name, message: result.error.message, code: result.error.code } : null,
 stdout: result.stdout, stderr: result.stderr }));
`;
const prefix = '[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false); ';
const command = prefix + `(Get-CimInstance Win32_Process -Filter 'ProcessId = ${target.pid}' -ErrorAction Stop).CommandLine`;
const records = [];
try {
 for (const [name, commandText, timeout] of [
  ['startup', prefix + "'started'", 1900],
  ['cim-original-budget', command, 1900],
  ['cim-diagnostic-timing-only', command, 10000],
  ['cim-warm-original-budget', command, 1900],
 ]) {
  for (const [environment, env] of [['restricted', restricted], ['inherited', process.env]]) {
   const result = spawnSync(process.execPath, ['-e', probe], { input: JSON.stringify({ command: commandText, timeout }), env,
    encoding: 'utf8', timeout: timeout + 3000, maxBuffer: 128 * 1024 });
   const record = { name, environment, timeout, outerStatus: result.status, outerError: result.error?.message, child: result.stdout, stderr: result.stderr };
   records.push(record);
   console.log(JSON.stringify(record));
  }
 }
} finally {
 target.kill();
 await target.exited;
}
writeFileSync('windows-identity-diagnostic.json', JSON.stringify({ platform: process.platform, bun: Bun.version, records }, null, 2));
