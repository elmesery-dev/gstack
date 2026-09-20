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
 const safeKeys = ['PSModulePath','TEMP','TMP','USERPROFILE','HOMEDRIVE','HOMEPATH','WINDIR','SystemDrive','COMSPEC','PATHEXT','APPDATA','LOCALAPPDATA'];
 const safe = Object.fromEntries(safeKeys.filter(key => process.env[key] !== undefined).map(key => [key, process.env[key]]));
 const explicit = prefix + "Import-Module ($PSHOME + '\\Modules\\CimCmdlets\\CimCmdlets.psd1') -ErrorAction Stop; " + command;
 console.log(JSON.stringify({shell:process.env.PROBE_SHELL, powershell:Bun.which('powershell.exe'), modulePath:process.env.PSModulePath}));
 for (const [name, environment, env, text] of [
  ['cim','module-only',{...restricted,PSModulePath:process.env.PSModulePath},command],
  ['cim','inherited',process.env,command],
  ['cim','all-safe',{...restricted,...safe},command],
  ['explicit-cim-module','restricted',restricted,explicit],
 ]) {
  for (const api of ['spawnSync','execFileSync']) {
   const childProbe = api === 'spawnSync' ? probe : `
import { execFileSync } from 'node:child_process';
const input=JSON.parse(await Bun.stdin.text());const started=Date.now();
try {const stdout=execFileSync('powershell.exe',['-NoProfile','-NonInteractive','-Command',input.command],{encoding:'utf8',stdio:['ignore','pipe','pipe'],timeout:input.timeout,windowsHide:true});
 console.log(JSON.stringify({elapsedMs:Date.now()-started,status:0,stdout}));}
catch(error){console.log(JSON.stringify({elapsedMs:Date.now()-started,status:error.status,signal:error.signal,error:{message:error.message,code:error.code},stdout:error.stdout,stderr:error.stderr}));}
`;
   const result = spawnSync(process.execPath, ['-e', childProbe], { input: JSON.stringify({ command:text, timeout:1900 }), env,
    encoding:'utf8',timeout:4900,maxBuffer:128*1024 });
   const record={name,environment,api,timeout:1900,outerStatus:result.status,outerError:result.error?.message,child:result.stdout,stderr:result.stderr};
   records.push(record);console.log(JSON.stringify(record));
  }
 }
} finally {
 target.kill();
 await target.exited;
}
writeFileSync('windows-identity-' + process.env.PROBE_SHELL + '.json', JSON.stringify({ platform: process.platform, bun: Bun.version, records }, null, 2));
