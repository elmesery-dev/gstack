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
 const baseline={...restricted,PSModulePath:process.env.PSModulePath};
 const groups={
  program:['ProgramFiles','ProgramFiles(x86)','ProgramW6432','CommonProgramFiles','CommonProgramFiles(x86)','CommonProgramW6432','ProgramData','ALLUSERSPROFILE'],
  identity:['USERNAME','USERDOMAIN','USERDOMAIN_ROAMINGPROFILE','LOGONSERVER','SESSIONNAME','USERPROFILE','HOMEDRIVE','HOMEPATH','APPDATA','LOCALAPPDATA'],
  system:['OS','PROCESSOR_ARCHITECTURE','PROCESSOR_IDENTIFIER','PROCESSOR_LEVEL','PROCESSOR_REVISION','NUMBER_OF_PROCESSORS','WINDIR','SystemDrive','COMSPEC','PATHEXT','TEMP','TMP'],
  powershell:Object.keys(process.env).filter(k=>/^(PS|POWERSHELL)/i.test(k)&&k.toLowerCase()!=='psmodulepath'),
 };
 const add=keys=>Object.fromEntries(keys.filter(k=>process.env[k]!==undefined).map(k=>[k,process.env[k]]));
 const variants=[['builtin-module-path',{...restricted,PSModulePath:process.env.SystemRoot+'\\System32\\WindowsPowerShell\\v1.0\\Modules'}],
  ...Object.entries(groups).map(([name,keys])=>[name,{...baseline,...add(keys)}]),
  ['all-groups',{...baseline,...add(Object.values(groups).flat())}],
  ...Object.entries(groups).map(([name,keys])=>['inherited-without-'+name,Object.fromEntries(Object.entries(process.env).filter(([key])=>!keys.some(k=>k.toLowerCase()===key.toLowerCase())))])];
 for(const [environment,env] of variants){
  const result=spawnSync(process.execPath,['-e',probe],{input:JSON.stringify({command,timeout:1900}),env,encoding:'utf8',timeout:4900,maxBuffer:128*1024});
  const record={environment,groupKeys:groups[environment],outerStatus:result.status,child:result.stdout,stderr:result.stderr};records.push(record);console.log(JSON.stringify(record));
 }
} finally {
 target.kill();
 await target.exited;
}
writeFileSync('windows-identity-' + process.env.PROBE_SHELL + '.json', JSON.stringify({ platform: process.platform, bun: Bun.version, records }, null, 2));
