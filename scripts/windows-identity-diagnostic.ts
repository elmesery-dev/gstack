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
 const groups = {
  temp: ['TEMP', 'TMP'],
  profile: ['USERPROFILE', 'HOMEDRIVE', 'HOMEPATH'],
  system: ['WINDIR', 'SystemDrive', 'COMSPEC', 'PATHEXT'],
  modules: ['PSModulePath'],
  appdata: ['APPDATA', 'LOCALAPPDATA'],
 };
 const add = keys => Object.fromEntries(keys.filter(key => process.env[key] !== undefined).map(key => [key, process.env[key]]));
 const all = Object.values(groups).flat();
 const variants = [['restricted', restricted], ...Object.entries(groups).map(([name, keys]) => [name, {...restricted, ...add(keys)}]),
  ['all-safe', {...restricted, ...add(all)}], ...Object.entries(groups).map(([name, keys]) => ['all-except-' + name, {...restricted, ...add(all.filter(key => !keys.includes(key)))}])];
 for (const [environment, env] of variants) {
  const result = spawnSync(process.execPath, ['-e', probe], { input: JSON.stringify({ command, timeout: 1900 }), env,
   encoding: 'utf8', timeout: 4900, maxBuffer: 128 * 1024 });
  const record = { environment, keys: Object.keys(env), timeout: 1900, outerStatus: result.status, outerError: result.error?.message, child: result.stdout, stderr: result.stderr };
  records.push(record);
  console.log(JSON.stringify(record));
 }
} finally {
 target.kill();
 await target.exited;
}
writeFileSync('windows-identity-diagnostic.json', JSON.stringify({ platform: process.platform, bun: Bun.version, records }, null, 2));
