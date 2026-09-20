import { spawnSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
const target = Bun.spawn([process.execPath, '-e', 'console.log("ready"); setInterval(() => {}, 1000)', '--gstack-design-daemon'], { stdout: 'pipe', stderr: 'pipe' });
const reader = target.stdout.getReader();
await reader.read();
reader.releaseLock();
const restricted = { PATH: process.env.PATH ?? '', ...(process.env.SystemRoot ? { SystemRoot: process.env.SystemRoot } : {}) };
const probe = `
import { spawnSync, execFileSync } from 'node:child_process';
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
 const modules={PSModulePath:process.env.PSModulePath};
 const cache={PSModuleAnalysisCachePath:process.env.PSModuleAnalysisCachePath};
 const vars={distribution:process.env.POWERSHELL_DISTRIBUTION_CHANNEL,updatecheck:process.env.POWERSHELL_UPDATECHECK,cacheConfigured:!!process.env.PSModuleAnalysisCachePath};
 console.log(JSON.stringify(vars));
 for(const [environment,env] of [
  ['cache-only',{...restricted,...cache}],
  ['modules-and-cache',{...restricted,...modules,...cache}],
  ['modules-cache-localappdata',{...restricted,...modules,...cache,LOCALAPPDATA:process.env.LOCALAPPDATA}],
  ['modules-localappdata-no-cache',{...restricted,...modules,LOCALAPPDATA:process.env.LOCALAPPDATA}],
 ]){
  const result=spawnSync(process.execPath,['-e',probe],{input:JSON.stringify({command,timeout:1900}),env,encoding:'utf8',timeout:4900,maxBuffer:128*1024});
  const record={environment,outerStatus:result.status,child:result.stdout,stderr:result.stderr};records.push(record);console.log(JSON.stringify(record));
 }
} finally {
 target.kill();
 await target.exited;
}
writeFileSync('windows-identity-' + process.env.PROBE_SHELL + '.json', JSON.stringify({ platform: process.platform, bun: Bun.version, records }, null, 2));
