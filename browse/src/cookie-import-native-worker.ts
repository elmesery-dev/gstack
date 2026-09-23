import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { createNativeCookieJob, joinNativeCookieJob, nativeCookieDiagnostic, parseNativeCookieDiagnostic, type NativeCookieDiagnostic, type NativeCookieJob } from './cookie-import-native-job';
import type { PlaywrightCookie } from './cookie-import-browser';

export interface NativeCookieRequest {
  nodeExecutable: string;
  nodeArchitecture: string;
  playwrightEntry: string;
  executablePath: string;
  userDataDir: string;
  profile: string;
  domains: string[];
  deadline: number;
  qualifiedBunVersions: string[];
}

export type NativeCookieReply =
  | { cookies: PlaywrightCookie[] }
  | { error: 'native_timeout' | 'native_failed' | 'native_cleanup_failed' | 'native_supervision_failed' | 'browser_running' | 'native_profile_unsupported'; diagnostic?: NativeCookieDiagnostic };

export interface NativeCookieMember {
  result: Promise<NativeCookieReply>;
  closed: Promise<void>;
  stop(): void;
}

const MAX_REPLY_BYTES = 8 * 1024 * 1024;

export function nativeCookieEnvironment(env: NodeJS.ProcessEnv): Record<string, string> {
  const allowed = new Set(['systemroot', 'windir', 'temp', 'tmp', 'userprofile', 'localappdata', 'appdata', 'programfiles', 'programfiles(x86)', 'programdata', 'path', 'pathext']);
  return Object.fromEntries(Object.entries(env).filter(([key, value]) => allowed.has(key.toLowerCase()) && typeof value === 'string')) as Record<string, string>;
}

export const NATIVE_COOKIE_NODE_SCRIPT = String.raw`
const fs = require('node:fs');
let stage = 'node_input';
(async () => {
  const request = JSON.parse(fs.readFileSync(0, 'utf8'));
  stage = 'node_load';
  const { chromium } = require(request.playwrightEntry);
  let context;
  try {
    const remaining = request.deadline - Date.now();
    if (remaining <= 0) throw new Error('native_timeout');
    stage = 'browser_launch';
    context = await chromium.launchPersistentContext(request.userDataDir, {
      executablePath: request.executablePath,
      args: ['--profile-directory=' + request.profile],
      headless: true,
      timeout: remaining,
      handleSIGINT: false,
      handleSIGTERM: false,
      handleSIGHUP: false,
      env: process.env,
    });
    stage = 'cookie_read';
    const selected = new Set(request.domains.map(domain => domain.toLowerCase().replace(/^\./, '').replace(/\.$/, '')));
    const cookies = (await context.cookies()).filter(cookie => selected.has(cookie.domain.toLowerCase().replace(/^\./, '').replace(/\.$/, '')));
    await new Promise(resolve => process.stdout.write(JSON.stringify({ cookies }) + '\n', resolve));
  } catch (error) {
    const message = error instanceof Error ? error.message : '';
    const code = /ProcessSingleton|profile.*in use|user data directory is already in use|opening in existing browser session/i.test(message)
      ? 'browser_running'
      : /remote debugging requires a non-default data directory/i.test(message)
        ? 'native_profile_unsupported'
        : /Timeout|native_timeout/.test(message) ? 'native_timeout' : 'native_failed';
    await new Promise(resolve => process.stdout.write(JSON.stringify({ error: code, diagnostic: { stage } }) + '\n', resolve));
  } finally {
    stage = 'browser_close';
    await context?.close().catch(() => {});
  }
})().catch(() => { process.stdout.write(JSON.stringify({ error: 'native_failed', diagnostic: { stage } }) + '\n'); process.exitCode = 1; });
`;

export async function superviseNativeCookieImport(
  request: NativeCookieRequest,
  dependencies: {
    createJob?: () => Promise<NativeCookieJob>;
    startMember?: (request: NativeCookieRequest, jobName: string) => NativeCookieMember;
    now?: () => number;
    sleep?: (milliseconds: number) => Promise<void>;
    signal?: AbortSignal;
  } = {},
): Promise<NativeCookieReply> {
  const now = dependencies.now ?? Date.now;
  const sleep = dependencies.sleep ?? (milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds)));
  const deadline = Math.min(request.deadline, now() + 25_000);
  let job: NativeCookieJob | undefined;
  let member: NativeCookieMember | undefined;
  let reply: NativeCookieReply | undefined;
  let closed = false;
  try {
    job = await (dependencies.createJob ?? createNativeCookieJob)();
    if (now() >= deadline || dependencies.signal?.aborted) return { error: 'native_timeout' };
    member = (dependencies.startMember ?? startMember)({ ...request, deadline }, job.name);
    void member.result.then(value => { reply = value; }, () => { reply = { error: 'native_failed' }; });
    void member.closed.then(() => { closed = true; }, () => { closed = true; });
    while (!reply && !closed && now() < deadline && !dependencies.signal?.aborted) await sleep(Math.min(20, deadline - now()));
    reply ??= { error: now() >= deadline ? 'native_timeout' : 'native_failed' };
    const cleanupDeadline = now() + 5_000;
    const graceDeadline = now() + ('cookies' in reply ? 2_000 : 0);
    while ((!closed || job.activeProcesses() !== 0) && now() < graceDeadline) await sleep(20);
    if (job.activeProcesses() !== 0) job.terminate();
    while ((!closed || job.activeProcesses() !== 0) && now() < cleanupDeadline) await sleep(20);
    if (!closed || job.activeProcesses() !== 0) return { error: 'native_cleanup_failed' };
    return reply;
  } catch (error) {
    return { error: job ? 'native_cleanup_failed' : 'native_supervision_failed', diagnostic: nativeCookieDiagnostic(error, job ? 'job_query' : 'job_create') };
  } finally {
    let diagnostic: NativeCookieDiagnostic | undefined;
    try { job?.close(); } catch (error) { diagnostic = nativeCookieDiagnostic(error, 'job_close'); }
    try { member?.stop(); } catch (error) { diagnostic ??= nativeCookieDiagnostic(error, 'member_exit'); }
    if (diagnostic) return { error: 'native_cleanup_failed', diagnostic };
  }
}

function startMember(request: NativeCookieRequest, jobName: string): NativeCookieMember {
  const child = spawn(process.execPath, ['--no-env-file', '--no-install', '--no-macros', '--config=NUL', import.meta.path, '--member'], {
    env: nativeCookieEnvironment(process.env),
    stdio: ['pipe', 'pipe', 'ignore'],
    windowsHide: true,
  });
  const closed = new Promise<void>(resolve => child.once('close', () => resolve()));
  const result = new Promise<NativeCookieReply>(resolve => {
    let output = '';
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', chunk => {
      output += chunk;
      if (Buffer.byteLength(output) > MAX_REPLY_BYTES) {
        resolve({ error: 'native_failed' });
        child.stdout.destroy();
      } else if (output.includes('\n')) {
        try {
          const parsed = JSON.parse(output.slice(0, output.indexOf('\n')));
          const errors = ['native_timeout', 'native_failed', 'native_cleanup_failed', 'native_supervision_failed', 'browser_running', 'native_profile_unsupported'];
          const diagnostic = parseNativeCookieDiagnostic(parsed.diagnostic);
          resolve(Array.isArray(parsed.cookies) ? { cookies: parsed.cookies } : { error: errors.includes(parsed.error) ? parsed.error : 'native_failed', ...(diagnostic ? { diagnostic } : {}) });
        } catch {
          resolve({ error: 'native_failed' });
        }
      }
    });
    child.once('error', () => resolve({ error: 'native_failed', diagnostic: { stage: 'member_start' } }));
    child.once('close', () => resolve({ error: 'native_failed', diagnostic: { stage: 'member_exit' } }));
    child.stdin.on('error', () => resolve({ error: 'native_failed', diagnostic: { stage: 'member_input' } }));
    child.stdin.end(JSON.stringify({ request, jobName }));
  });
  return { result, closed, stop: () => { if (child.exitCode === null && child.signalCode === null) child.kill(); } };
}

let mainStage: NativeCookieDiagnostic['stage'] = 'supervisor_input';

async function main(): Promise<void> {
  if (process.argv[2] === '--member') {
    mainStage = 'member_input';
    const input = JSON.parse(await Bun.stdin.text());
    await joinNativeCookieJob(input.jobName);
    mainStage = 'node_start';
    const child = spawn(input.request.nodeExecutable, ['--input-type=commonjs', '-e', NATIVE_COOKIE_NODE_SCRIPT], {
      env: nativeCookieEnvironment(process.env),
      stdio: ['pipe', 'inherit', 'ignore'],
      windowsHide: true,
    });
    child.stdin.on('error', () => {});
    child.stdin.end(JSON.stringify(input.request));
    child.once('error', () => process.stdout.write(JSON.stringify({ error: 'native_failed', diagnostic: { stage: 'node_start' } }) + '\n', () => process.exit(1)));
    child.once('close', code => process.exit(code ?? 1));
    return;
  }
  const cancellation = new AbortController();
  const lines = createInterface({ input: process.stdin });
  lines.once('close', () => cancellation.abort());
  const input = await new Promise<NativeCookieRequest>((resolve, reject) => {
    lines.once('line', line => {
      try { resolve(JSON.parse(line)); } catch { reject(new Error('native_supervision_failed')); }
    });
    lines.once('close', () => reject(new Error('native_supervision_failed')));
  });
  mainStage = 'runtime_check';
  if (input.nodeArchitecture !== process.arch || !Array.isArray(input.qualifiedBunVersions) || !input.qualifiedBunVersions.includes(Bun.version)) {
    throw new Error('native_supervision_failed');
  }
  const result = await superviseNativeCookieImport(input, { signal: cancellation.signal });
  process.stdout.write(JSON.stringify(result) + '\n', () => process.exit(0));
}

if (import.meta.main) {
  void main().catch(error => {
    process.stdout.write(JSON.stringify({ error: 'native_supervision_failed', diagnostic: nativeCookieDiagnostic(error, mainStage) }) + '\n', () => process.exit(1));
  });
}
