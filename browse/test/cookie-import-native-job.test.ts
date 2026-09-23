import { afterAll, describe, expect, test } from 'bun:test';
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, rmdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { randomUUID } from 'node:crypto';
import { Database } from 'bun:sqlite';
import { nativeBrowserPaths } from '../src/cookie-import-native';
import { NATIVE_BROWSER_VERSION_COMMAND } from '../src/cookie-import-native-integrity';
import { createNativeCookieJob, joinNativeCookieJob, NativeCookieJobError, nativeCookieDiagnostic, parseNativeCookieDiagnostic, type NativeCookieJob } from '../src/cookie-import-native-job';
import { nativeCookieEnvironment, NATIVE_COOKIE_NODE_SCRIPT, superviseNativeCookieImport, type NativeCookieMember, type NativeCookieReply, type NativeCookieRequest } from '../src/cookie-import-native-worker';

const root = mkdtempSync(path.join(tmpdir(), 'cookie-job-'));
afterAll(() => rmSync(root, { recursive: true, force: true }));

const request: NativeCookieRequest = {
  nodeExecutable: 'C:\\fixture\\node.exe',
  nodeArchitecture: process.arch,
  playwrightEntry: 'C:\\fixture\\playwright.cjs',
  executablePath: 'C:\\fixture\\msedge.exe',
  userDataDir: 'C:\\fixture\\User Data',
  profile: 'Default',
  domains: ['example.test'],
  deadline: 25_000,
  qualifiedBunVersions: ['1.4.0'],
};

function kernelContract(mode: string) {
  const script = `
    const calls = [];
    globalThis.__nativeCookieFfi = {
      FFIType: { ptr: 'ptr', u64: 'u64', u32: 'u32', i32: 'i32' },
      ptr: buffer => buffer,
      dlopen: (name, signatures) => {
        calls.push(['library', name, Object.keys(signatures)]);
        return { close() { calls.push(['unload']); }, symbols: {
          CreateJobObjectW: (security, name) => { calls.push(['create', security, name.toString('utf16le')]); return 42; },
          OpenJobObjectW: (access, inherit, name) => { calls.push(['open', access, inherit, name.toString('utf16le')]); return 42; },
          SetInformationJobObject: (handle, kind, buffer, length) => { calls.push(['limits', handle, kind, length, buffer.readUInt32LE(16)]); return 1; },
          QueryInformationJobObject: (handle, kind, buffer, length) => { calls.push(['query', handle, kind, length]); buffer.writeUInt32LE(3, 40); return 1; },
          OpenProcess: (access, inherit, pid) => { calls.push(['open-process', access, inherit, pid === process.pid]); return 999; },
          AssignProcessToJobObject: (job, process) => { calls.push(['assign', job, process]); return ${mode === 'join-fail' ? 0 : 1}; },
          TerminateJobObject: (job, code) => { calls.push(['terminate', job, code]); return 1; },
          CloseHandle: handle => { calls.push(['close', handle]); return 1; },
          GetLastError: () => ${mode === 'join-fail' ? 5 : 0},
        } };
      },
    };
    const source = await Bun.file(${JSON.stringify(path.resolve(import.meta.dir, '../src/cookie-import-native-job.ts'))}).text();
    const boundary = "await import('bun:ffi')";
    if (source.split(boundary).length !== 2) throw new Error('FFI adapter boundary changed');
    const javascript = new Bun.Transpiler({ loader: 'ts' }).transformSync(source.replace(boundary, 'globalThis.__nativeCookieFfi'));
    const { createNativeCookieJob, joinNativeCookieJob } = await import('data:text/javascript;base64,' + Buffer.from(javascript).toString('base64'));
    Object.defineProperty(process, 'platform', { value: 'win32' });
    if (${JSON.stringify(mode)} === 'create') {
      const job = await createNativeCookieJob();
      const active = job.activeProcesses();
      job.terminate(); job.close(); job.close();
      console.log(JSON.stringify({ name: job.name, active, calls }));
    } else {
      let error, diagnostic;
      try { await joinNativeCookieJob('Local\\\\gstack-cookie-12345678-1234-1234-1234-123456789abc'); } catch (caught) { error = caught.message; diagnostic = caught.diagnostic; }
      console.log(JSON.stringify({ calls, error, diagnostic }));
    }
  `;
  const result = spawnSync(process.execPath, ['--no-env-file', '--no-install', `--config=${process.platform === 'win32' ? 'NUL' : '/dev/null'}`, '-e', script], {
    env: { TEMP: root, TMP: root, HOME: root, USERPROFILE: root, ...(process.env.SystemRoot ? { SystemRoot: process.env.SystemRoot } : {}) },
    encoding: 'utf8',
    timeout: 10_000,
  });
  expect(result.status).toBe(0);
  expect(result.stderr).toBe('');
  return JSON.parse(result.stdout);
}

describe('production Windows Job Object API contract', () => {
  test('diagnostics expose only known native stages and numeric Windows errors', () => {
    expect(nativeCookieDiagnostic(new NativeCookieJobError('job_assign', 5), 'job_create')).toEqual({ stage: 'job_assign', win32Error: 5 });
    expect(nativeCookieDiagnostic(new Error('sensitive-sentinel'), 'ffi_open')).toEqual({ stage: 'ffi_open' });
    expect(parseNativeCookieDiagnostic({ stage: 'job_assign', win32Error: 87, message: 'sensitive-sentinel' })).toEqual({ stage: 'job_assign', win32Error: 87 });
    expect(parseNativeCookieDiagnostic({ stage: 'sensitive-sentinel', win32Error: 5 })).toBeUndefined();
    expect(parseNativeCookieDiagnostic({ stage: 'job_assign', win32Error: 'sensitive-sentinel' })).toEqual({ stage: 'job_assign' });
    expect(parseNativeCookieDiagnostic({ stage: 'member_exit', lastStage: 'node_spawned', exitCode: 1, nodeExitCode: 1, signal: 'SIGTERM', memberMode: true, stderrBytes: 50 })).toEqual({ stage: 'member_exit', lastStage: 'node_spawned', exitCode: 1, nodeExitCode: 1, signal: 'SIGTERM', memberMode: true, stderrBytes: 50 });
    expect(parseNativeCookieDiagnostic({ stage: 'member_exit', lastStage: 'sensitive-sentinel', signal: 'sensitive-sentinel', exitCode: 'sensitive-sentinel', memberMode: 'sensitive-sentinel', stderrBytes: -1 })).toEqual({ stage: 'member_exit' });
  });

  test('owner creates a non-inheritable kill-on-close job and queries active members', () => {
    const result = kernelContract('create');
    expect(result.name).toMatch(/^Local\\gstack-cookie-[0-9a-f-]{36}$/);
    expect(result.active).toBe(3);
    expect(result.calls).toContainEqual(['create', null, `${result.name}\0`]);
    expect(result.calls).toContainEqual(['limits', 42, 9, 144, 0x2000]);
    expect(result.calls).toContainEqual(['query', 42, 1, 48]);
    expect(result.calls).toContainEqual(['terminate', 42, 1]);
    expect(result.calls.filter((call: unknown[]) => call[0] === 'close')).toEqual([['close', 42]]);
  });

  test('member assigns its own handle, never a discovered PID', () => {
    const result = kernelContract('join');
    expect(result.error).toBeUndefined();
    expect(result.calls).toContainEqual(['open', 1, 0, 'Local\\gstack-cookie-12345678-1234-1234-1234-123456789abc\0']);
    expect(result.calls).toContainEqual(['open-process', 0x0101, 0, true]);
    expect(result.calls).toContainEqual(['assign', 42, 999]);
    expect(result.calls).toContainEqual(['close', 999]);
    expect(result.calls).toContainEqual(['close', 42]);
  });

  test('failed self-assignment closes its handle and fails without a child launch', () => {
    const result = kernelContract('join-fail');
    expect(result.error).toBe('native_supervision_failed');
    expect(result.diagnostic).toEqual({ stage: 'job_assign', win32Error: 5 });
    expect(result.calls).toContainEqual(['close', 999]);
    expect(result.calls).toContainEqual(['close', 42]);
  });
});

function simulation(options: { reply?: NativeCookieReply; replyAt?: number; exitAt?: number; retainAfterTerminate?: boolean; signal?: AbortSignal; cancelAt?: () => void } = {}) {
  let time = 0;
  let active = 1;
  let terminated = 0;
  let stopped = 0;
  let jobClosed = 0;
  let started = 0;
  let settleReply!: (reply: NativeCookieReply) => void;
  let settleClose!: () => void;
  const member: NativeCookieMember = {
    result: new Promise(resolve => { settleReply = resolve; }),
    closed: new Promise(resolve => { settleClose = resolve; }),
    stop: () => { stopped++; },
  };
  const job: NativeCookieJob = {
    name: 'synthetic-owned-job',
    terminate: () => {
      terminated++;
      if (!options.retainAfterTerminate) { active = 0; settleClose(); }
    },
    activeProcesses: () => active,
    close: () => { jobClosed++; },
  };
  const run = superviseNativeCookieImport(request, {
    createJob: async () => job,
    startMember: actual => { expect(actual.deadline).toBe(25_000); started++; return member; },
    now: () => time,
    sleep: async milliseconds => {
      time += milliseconds;
      if (options.reply && time >= (options.replyAt ?? 20)) settleReply(options.reply);
      if (options.exitAt !== undefined && time >= options.exitAt) { active = 0; settleClose(); }
      options.cancelAt?.();
    },
    signal: options.signal,
  });
  return { run, state: () => ({ time, active, terminated, stopped, jobClosed, started }) };
}

describe('owned native-cookie lifecycle', () => {
  test('success is withheld until the entire job is empty and member exits', async () => {
    const run = simulation({ reply: { cookies: [] }, exitAt: 200 });
    expect(await run.run).toEqual({ cookies: [] });
    expect(run.state()).toMatchObject({ time: 200, active: 0, terminated: 0, stopped: 1, jobClosed: 1, started: 1 });
  });

  test('a stuck graceful close is forcibly cleaned after two seconds', async () => {
    const run = simulation({ reply: { cookies: [] } });
    expect(await run.run).toEqual({ cookies: [] });
    expect(run.state()).toMatchObject({ active: 0, terminated: 1, jobClosed: 1, started: 1 });
    expect(run.state().time).toBeLessThan(5_000);
  });

  test('launch/read timeout gets one 25s operation budget and owned cleanup', async () => {
    const run = simulation();
    expect(await run.run).toEqual({ error: 'native_timeout' });
    expect(run.state()).toMatchObject({ active: 0, terminated: 1, jobClosed: 1, started: 1 });
    expect(run.state().time).toBeGreaterThanOrEqual(25_000);
    expect(run.state().time).toBeLessThan(30_000);
  });

  test.each(['failure', 'success', 'rejection'])('a late member %s cannot overwrite the timeout selected before cleanup', async mode => {
    let now = 0;
    let active = 1;
    let resolveReply!: (reply: NativeCookieReply) => void;
    let rejectReply!: (error: Error) => void;
    let resolveClosed!: () => void;
    const reply = new Promise<NativeCookieReply>((resolve, reject) => { resolveReply = resolve; rejectReply = reject; });
    const closed = new Promise<void>(resolve => { resolveClosed = resolve; });
    const result = await superviseNativeCookieImport(request, {
      now: () => now,
      sleep: async milliseconds => { now += milliseconds; },
      createJob: async () => ({
        name: 'synthetic-owned-job', activeProcesses: () => active, close() {},
        terminate() {
          expect(now).toBe(25_000);
          active = 0;
          if (mode === 'rejection') rejectReply(new Error('synthetic late rejection'));
          else resolveReply(mode === 'success' ? { cookies: [] } : { error: 'native_failed', diagnostic: { stage: 'member_exit' } });
          resolveClosed();
        },
      }),
      startMember: () => ({ result: reply, closed, stop() {} }),
    });
    expect(result).toEqual({ error: 'native_timeout' });
    expect(active).toBe(0);
    expect(now).toBeLessThan(30_000);
  });

  test('unconfirmed termination is reported as cleanup failure, never success', async () => {
    const run = simulation({ retainAfterTerminate: true });
    expect(await run.run).toEqual({ error: 'native_cleanup_failed' });
    expect(run.state()).toMatchObject({ time: 30_000, terminated: 1, stopped: 1, jobClosed: 1 });
  });

  test('a process crash cannot strand remaining members', async () => {
    let terminated = 0;
    let active = 1;
    const result = await superviseNativeCookieImport(request, {
      now: () => 0,
      sleep: async () => {},
      createJob: async () => ({ name: 'synthetic', activeProcesses: () => active, terminate: () => { active = 0; terminated++; }, close() {} }),
      startMember: () => ({ result: new Promise(() => {}), closed: Promise.resolve(), stop() {} }),
    });
    expect(result).toEqual({ error: 'native_failed' });
    expect(terminated).toBe(1);
  });

  test('a failed job close still stops its owned member and cannot report success', async () => {
    let stopped = false;
    const result = await superviseNativeCookieImport(request, {
      now: () => 0,
      sleep: async () => {},
      createJob: async () => ({ name: 'synthetic', activeProcesses: () => 0, terminate() {}, close() { throw new Error('sensitive-close-detail'); } }),
      startMember: () => ({ result: Promise.resolve({ cookies: [] }), closed: Promise.resolve(), stop() { stopped = true; } }),
    });
    expect(result).toEqual({ error: 'native_cleanup_failed', diagnostic: { stage: 'job_close' } });
    expect(stopped).toBe(true);
  });

  test('locked-profile errors are classified and never retried', async () => {
    const run = simulation({ reply: { error: 'browser_running' } });
    expect(await run.run).toEqual({ error: 'browser_running' });
    expect(run.state()).toMatchObject({ active: 0, terminated: 1, started: 1 });
  });

  test('loss of the parent channel cancels the operation and cleans the job', async () => {
    const cancellation = new AbortController();
    const run = simulation({ signal: cancellation.signal, cancelAt: () => cancellation.abort() });
    expect(await run.run).toEqual({ error: 'native_failed' });
    expect(run.state()).toMatchObject({ active: 0, terminated: 1, started: 1 });
    expect(run.state().time).toBeLessThan(5_000);
  });

  test('job initialization failure dispatches no child and hides native errors', async () => {
    let started = false;
    const result = await superviseNativeCookieImport(request, {
      createJob: async () => { throw new Error('sensitive-sentinel'); },
      startMember: () => { started = true; throw new Error('unexpected'); },
    });
    expect(result).toEqual({ error: 'native_supervision_failed', diagnostic: { stage: 'job_create' } });
    expect(started).toBe(false);
  });

  test.skipIf(process.platform === 'win32')('non-Windows job API fails before any process is launched', async () => {
    await expect(createNativeCookieJob()).rejects.toThrow('native_supervision_unavailable');
    await expect(joinNativeCookieJob('invalid')).rejects.toThrow('native_supervision_failed');
  });
});

function alive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch { return false; }
}

function safeNativeEnvelope(output: string): object {
  try {
    const parsed = JSON.parse(output);
    if (Array.isArray(parsed.cookies)) return { cookiesRead: parsed.cookies.length };
    const errors = ['native_timeout', 'native_failed', 'native_cleanup_failed', 'native_supervision_failed', 'browser_running', 'native_profile_unsupported'];
    return { error: errors.includes(parsed.error) ? parsed.error : 'unexpected_reply', diagnostic: parseNativeCookieDiagnostic(parsed.diagnostic) };
  } catch {
    return { error: 'no_complete_reply' };
  }
}

function safeLaunchEvidence(file: string): object {
  try {
    const observed = JSON.parse(readFileSync(file, 'utf8'));
    return {
      spawned: Number.isInteger(observed.pid), pipe: observed.args?.includes('--remote-debugging-pipe'),
      argsHash: observed.argsHash, envHash: observed.envHash,
      reasons: observed.reasons, stderrBytes: observed.stderrBytes,
      exitCode: observed.exitCode, signal: observed.signal, spawnError: observed.spawnError,
      runtime: observed.runtime, observedCommandLine: observed.observedCommandLine,
    };
  } catch {
    return { spawned: false };
  }
}

function nativeSupervisor(input: NativeCookieRequest, env: NodeJS.ProcessEnv) {
  const child = spawn(process.execPath, ['--no-env-file', '--no-install', '--no-macros', '--config=NUL', path.resolve(import.meta.dir, '../src/cookie-import-native-worker.ts')], { env, stdio: ['pipe', 'pipe', 'ignore'], windowsHide: true });
  let output = '';
  child.stdout.on('data', chunk => { output += chunk; });
  const timer = setTimeout(() => child.kill(), 30_000);
  const done = new Promise<NativeCookieReply>((resolve, reject) => {
    child.once('error', reject);
    child.once('close', () => {
      clearTimeout(timer);
      try { resolve(JSON.parse(output)); } catch { reject(new Error('Native supervisor did not return a complete receipt')); }
    });
  });
  void done.catch(() => {});
  child.stdin.on('error', () => {});
  child.stdin.write(JSON.stringify({ ...input, deadline: Date.now() + 25_000, qualifiedBunVersions: [Bun.version] }) + '\n');
  return { child, done, envelope: () => safeNativeEnvelope(output) };
}

describe('native Windows process qualification', () => {
  test.skipIf(process.platform !== 'win32' || process.env.GSTACK_COOKIE_NATIVE_DEFAULT_FIXTURE !== '1')('an exclusively created default Edge profile persists v20 and reimports it through the owned Node worker', async () => {
    if (process.env.GITHUB_ACTIONS !== 'true' || process.env.CI !== 'true') throw new Error('Default-profile qualification requires a disposable GitHub Actions Windows runner');
    const node = Bun.which('node');
    const mapping = nativeBrowserPaths('Edge', process.env);
    const edge = mapping.executables.find(existsSync);
    if (!node || !edge) throw new Error('Native qualification requires Node and installed Microsoft Edge');
    const fixture = mkdtempSync(path.join(root, 'default-edge-'));
    const playwrightEntry = path.join(fixture, 'seed-playwright.cjs');
    const require = createRequire(import.meta.url);
    const marker = path.join(mapping.userDataDir, '.gstack-owned-fixture');
    const nonce = randomUUID();
    let owned = false;
    const createdParents: string[] = [];
    let supervisor: ReturnType<typeof nativeSupervisor> | undefined;
    try {
      if (existsSync(mapping.userDataDir)) throw new Error('Refusing an existing Edge default data directory; qualification needs a fresh disposable runner');
      let parent = process.env.LOCALAPPDATA!;
      if (realpathSync(parent).toLowerCase() !== path.resolve(parent).toLowerCase()) throw new Error('Refusing a redirected local-data root');
      for (const segment of ['Microsoft', 'Edge']) {
        parent = path.join(parent, segment);
        if (!existsSync(parent)) { mkdirSync(parent); createdParents.push(parent); }
        if (realpathSync(parent).toLowerCase() !== path.resolve(parent).toLowerCase()) throw new Error('Refusing a redirected default-profile parent');
      }
      mkdirSync(mapping.userDataDir);
      owned = true;
      writeFileSync(marker, nonce, { flag: 'wx', mode: 0o600 });
      writeFileSync(playwrightEntry, `
        const { chromium } = require(${JSON.stringify(require.resolve('playwright'))});
        exports.chromium = { async launchPersistentContext(root, options) {
          const context = await chromium.launchPersistentContext(root, options);
          await context.addCookies([{ name: 'synthetic-native-qualification', value: 'synthetic-only', domain: 'example.test', path: '/', secure: true, httpOnly: true, expires: Math.floor(Date.now() / 1000) + 3600 }]);
          return context;
        } };
      `);
      const input = { ...request, nodeExecutable: node, executablePath: edge, userDataDir: mapping.userDataDir, playwrightEntry };
      const env = nativeCookieEnvironment(process.env);
      supervisor = nativeSupervisor(input, env);
      const seeded = await supervisor.done;
      expect(seeded).toMatchObject({ cookies: expect.any(Array) });
      expect((seeded as { cookies: unknown[] }).cookies).toHaveLength(1);
      const database = new Database(path.join(mapping.userDataDir, 'Default', 'Network', 'Cookies'), { readonly: true });
      try {
        const row = database.query("SELECT hex(substr(encrypted_value, 1, 3)) AS prefix FROM cookies WHERE name = 'synthetic-native-qualification' AND host_key = 'example.test'").get() as { prefix: string } | null;
        expect(row?.prefix).toBe('763230');
      } finally {
        database.close();
      }
      supervisor = nativeSupervisor({ ...input, playwrightEntry: require.resolve('playwright') }, env);
      const imported = await supervisor.done;
      expect(imported).toMatchObject({ cookies: [{ name: 'synthetic-native-qualification', value: 'synthetic-only', domain: 'example.test' }] });
    } finally {
      supervisor?.child.kill();
      await supervisor?.done.catch(() => {});
      if (owned) {
        if (realpathSync(mapping.userDataDir).toLowerCase() !== path.resolve(mapping.userDataDir).toLowerCase() || readFileSync(marker, 'utf8') !== nonce) throw new Error('Default fixture ownership changed; refusing cleanup');
        rmSync(mapping.userDataDir, { recursive: true, force: true });
      }
      for (const parent of createdParents.reverse()) rmdirSync(parent);
    }
  }, 65_000);

  test.skipIf(process.platform !== 'win32')('a locked real Edge profile leaves its existing owner alive', async () => {
    const node = Bun.which('node');
    const edge = nativeBrowserPaths('Edge', process.env).executables.find(existsSync);
    if (!node || !edge) throw new Error('Native qualification requires Node and installed Microsoft Edge');
    const fixture = mkdtempSync(path.join(root, 'locked-edge-'));
    const marker = path.join(fixture, 'owner-ready.json');
    const playwrightEntry = path.join(fixture, 'held-playwright.cjs');
    const require = createRequire(import.meta.url);
    writeFileSync(playwrightEntry, `
      const cp = require('node:child_process');
      const spawn = cp.spawn;
      let pid;
      cp.spawn = function(command, args, options) { const child = spawn.call(this, command, args, options); pid = child.pid; return child; };
      const { chromium } = require(${JSON.stringify(require.resolve('playwright'))});
      exports.chromium = { async launchPersistentContext(root, options) {
        const context = await chromium.launchPersistentContext(root, options);
        require('node:fs').writeFileSync(${JSON.stringify(marker)}, JSON.stringify({ pid }));
        context.cookies = () => new Promise(() => {});
        return context;
      } };
    `);
    const env = { SystemRoot: process.env.SystemRoot!, TEMP: fixture, TMP: fixture, USERPROFILE: fixture, LOCALAPPDATA: fixture, APPDATA: fixture, PATH: path.dirname(node) };
    const input = { ...request, nodeExecutable: node, executablePath: edge, userDataDir: path.join(fixture, 'User Data'), playwrightEntry };
    const owner = nativeSupervisor(input, env);
    let contender: ReturnType<typeof nativeSupervisor> | undefined;
    try {
      const readyBy = Date.now() + 10_000;
      while (!existsSync(marker) && Date.now() < readyBy) await Bun.sleep(20);
      expect({ ready: existsSync(marker), reply: owner.envelope() }).toMatchObject({ ready: true });
      const { pid } = JSON.parse(readFileSync(marker, 'utf8'));
      contender = nativeSupervisor({ ...input, playwrightEntry: require.resolve('playwright') }, env);
      expect(await contender.done).toMatchObject({ error: 'browser_running' });
      expect(alive(pid)).toBe(true);
    } finally {
      contender?.child.kill();
      owner.child.kill();
      await contender?.done.catch(() => {});
      await owner.done.catch(() => {});
    }
  }, 35_000);

  for (const mode of ['normal-close', 'stalled-close']) {
    test.skipIf(process.platform !== 'win32')(`real Edge synthetic profile: ${mode} returns only after the owned browser exits`, async () => {
      const node = Bun.which('node');
      const edge = nativeBrowserPaths('Edge', process.env).executables.find(existsSync);
      if (!node || !edge) throw new Error('Native qualification requires Node and installed Microsoft Edge');
      const fixture = mkdtempSync(path.join(root, 'edge-'));
      const observation = path.join(fixture, 'browser.json');
      const playwrightEntry = path.join(fixture, 'observed-playwright.cjs');
      const require = createRequire(import.meta.url);
      writeFileSync(playwrightEntry, `module.exports = require(${JSON.stringify(path.resolve(import.meta.dir, 'fixtures/native-cookie-launch.cjs'))})(${JSON.stringify({ observation, playwrightEntry: require.resolve('playwright'), mode })});`);
      const environment = { SystemRoot: process.env.SystemRoot!, TEMP: fixture, TMP: fixture, USERPROFILE: fixture, LOCALAPPDATA: fixture, APPDATA: fixture, PATH: path.dirname(node) };
      const supervisor = spawn(process.execPath, ['--no-env-file', '--no-install', '--no-macros', '--config=NUL', path.resolve(import.meta.dir, '../src/cookie-import-native-worker.ts')], { env: environment, stdio: ['pipe', 'pipe', 'ignore'], windowsHide: true });
      const closed = new Promise<void>(resolve => supervisor.once('close', () => resolve()));
      let output = '';
      supervisor.stdout.on('data', chunk => { output += chunk; });
      const started = Date.now();
      const deadline = setTimeout(() => supervisor.kill(), 30_000);
      supervisor.stdin.write(JSON.stringify({ ...request, nodeExecutable: node, playwrightEntry, executablePath: edge, userDataDir: path.join(fixture, 'User Data'), deadline: started + 25_000, qualifiedBunVersions: [Bun.version] }) + '\n');
      try {
        await closed;
        const result = JSON.parse(output);
        expect({ result, launch: safeLaunchEvidence(observation) }).toMatchObject({ result: { cookies: expect.any(Array) } });
        expect(result.cookies).toHaveLength(1);
        expect(result.cookies[0].domain).toBe('example.test');
        const browser = JSON.parse(readFileSync(observation, 'utf8'));
        expect(browser.command).toBe(edge);
        expect(browser.args).toContain('--remote-debugging-pipe');
        expect(browser.args.some((arg: string) => arg.startsWith('--remote-debugging-port'))).toBe(false);
        expect(alive(browser.pid)).toBe(false);
        expect(Date.now() - started).toBeLessThan(30_000);
      } finally {
        clearTimeout(deadline);
        supervisor.kill();
        await closed;
      }
    }, 35_000);
  }

  for (const mode of ['timeout', 'owner-exit', 'worker-crash']) {
    test.skipIf(process.platform !== 'win32')(`${mode} kills owned descendants and preserves an unrelated process`, async () => {
      const node = Bun.which('node');
      if (!node) throw new Error('Node is required for Windows qualification');
      const fixture = mkdtempSync(path.join(root, 'native-'));
      const pids = path.join(fixture, 'owned.json');
      const playwrightEntry = path.join(fixture, 'playwright.cjs');
      writeFileSync(playwrightEntry, `module.exports = require(${JSON.stringify(path.resolve(import.meta.dir, 'fixtures/native-cookie-process.cjs'))})(${JSON.stringify({ pidsFile: pids, mode })});`);
      const environment = { SystemRoot: process.env.SystemRoot!, TEMP: fixture, TMP: fixture, USERPROFILE: fixture, LOCALAPPDATA: fixture, APPDATA: fixture, PATH: path.dirname(node) };
      const sibling = spawn(node, ['-e', 'setInterval(() => {}, 1000)'], { env: environment, stdio: 'ignore', windowsHide: true });
      const supervisor = spawn(process.execPath, ['--no-env-file', '--no-install', '--no-macros', '--config=NUL', path.resolve(import.meta.dir, '../src/cookie-import-native-worker.ts')], { env: environment, stdio: ['pipe', 'pipe', 'ignore'], windowsHide: true });
      const closed = new Promise<void>(resolve => supervisor.once('close', () => resolve()));
      let output = '';
      supervisor.stdout.on('data', chunk => { output += chunk; });
      const started = Date.now();
      supervisor.stdin.write(JSON.stringify({ ...request, nodeExecutable: node, playwrightEntry, userDataDir: fixture, deadline: started + (mode === 'timeout' ? 3_000 : 25_000), qualifiedBunVersions: [Bun.version] }) + '\n');
      try {
        while (!existsSync(pids) && Date.now() - started < 2_500) await Bun.sleep(20);
        expect({ ready: existsSync(pids), reply: safeNativeEnvelope(output) }).toMatchObject({ ready: true });
        const owned = JSON.parse(readFileSync(pids, 'utf8')) as number[];
        if (mode === 'owner-exit') supervisor.kill();
        await closed;
        const cleanupDeadline = Date.now() + 5_000;
        while (owned.some(alive) && Date.now() < cleanupDeadline) await Bun.sleep(20);
        expect(owned.some(alive)).toBe(false);
        expect(alive(sibling.pid!)).toBe(true);
        if (mode === 'timeout') {
          expect(JSON.parse(output)).toEqual({ error: 'native_timeout' });
          expect(Date.now() - started).toBeLessThan(8_000);
        }
        if (mode === 'worker-crash') expect(JSON.parse(output)).toMatchObject({ error: 'native_failed' });
      } finally {
        supervisor.kill();
        sibling.kill();
        await closed;
      }
    }, 15_000);
  }
});

describe('native Windows launch diagnostics', () => {
  test.skipIf(process.platform !== 'win32')('the qualification version command reads the explicit executable environment variable', () => {
    const node = Bun.which('node');
    if (!node) throw new Error('Node is required for version metadata verification');
    const powershell = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
    const env = { ...nativeCookieEnvironment(process.env), GSTACK_QUALIFY_BROWSER_EXE: node };
    const old = spawnSync(powershell, ['-NoProfile', '-NonInteractive', '-Command', NATIVE_BROWSER_VERSION_COMMAND.replace('$env:GSTACK_QUALIFY_BROWSER_EXE', '$env.GSTACK_QUALIFY_BROWSER_EXE')], {
      env, encoding: 'utf8', timeout: 10_000, windowsHide: true,
    });
    expect(old.status).not.toBe(0);
    expect(old.stdout.trim()).toBe('');
    const result = spawnSync(powershell, ['-NoProfile', '-NonInteractive', '-Command', NATIVE_BROWSER_VERSION_COMMAND], {
      env, encoding: 'utf8', timeout: 10_000, windowsHide: true,
    });
    expect(result.status).toBe(0);
    expect(result.stderr).toBe('');
    expect(result.stdout.trim()).toMatch(/^\d+(?:\.\d+){2,3}$/);
  });

  test('the synthetic launch observer records safe reasons without raw stderr or environment values', () => {
    const node = Bun.which('node');
    if (!node) throw new Error('Node is required for launch diagnostics');
    const fixture = mkdtempSync(path.join(root, 'launch-observer-'));
    const observation = path.join(fixture, 'launch.json');
    const playwrightEntry = path.join(fixture, 'fake-playwright.cjs');
    writeFileSync(playwrightEntry, `
      exports.chromium = { async launchPersistentContext() {
        const child = require('node:child_process').spawn('synthetic-browser.exe', ['--remote-debugging-pipe'], { env: { SYNTHETIC: 'sensitive-sentinel' } });
        child.stderr.write('AssignProcessToJobObject ERROR_ACCESS_DENIED sensitive-sentinel');
        child.emit('exit', 5, null);
        return { addCookies: async () => {} };
      } };
    `);
    const script = `
      const cp = require('node:child_process');
      const child = new (require('node:events').EventEmitter)();
      child.pid = 12345;
      child.stderr = new (require('node:stream').PassThrough)();
      cp.spawn = () => child;
      const api = require(${JSON.stringify(path.resolve(import.meta.dir, 'fixtures/native-cookie-launch.cjs'))})(${JSON.stringify({ observation, playwrightEntry })});
      api.chromium.launchPersistentContext('synthetic-profile', {}).then(() => console.log('observed'));
    `;
    const result = spawnSync(node, ['-e', script], {
      env: { PATH: path.dirname(node), TEMP: fixture, TMP: fixture, HOME: fixture, USERPROFILE: fixture, ...(process.env.SystemRoot ? { SystemRoot: process.env.SystemRoot } : {}) },
      encoding: 'utf8', timeout: 10_000,
    });
    expect(result.status).toBe(0);
    expect(result.stdout.trim()).toBe('observed');
    expect(result.stderr).toBe('');
    const observed = JSON.parse(readFileSync(observation, 'utf8'));
    expect(observed).toMatchObject({ exitCode: 5, reasons: ['job_assignment_failed', 'permission_denied'] });
    expect(observed.argsHash).toMatch(/^[a-f0-9]{64}$/);
    expect(observed.envHash).toMatch(/^[a-f0-9]{64}$/);
    expect(observed.runtime.node).toMatch(/^v\d+\.\d+\.\d+/);
    expect(observed.runtime.bun).toBeNull();
    expect(JSON.stringify(observed)).not.toContain('sensitive-sentinel');
  });

  test.skipIf(process.platform !== 'win32' || process.env.GITHUB_ACTIONS !== 'true')('compares contained and direct Node Edge launch with identical argv and environment', async () => {
    const node = Bun.which('node');
    const edge = nativeBrowserPaths('Edge', process.env).executables.find(existsSync);
    if (!node || !edge) throw new Error('Native launch comparison requires Node and installed Microsoft Edge');
    const fixture = mkdtempSync(path.join(root, 'edge-comparison-'));
    const userDataDir = path.join(fixture, 'User Data');
    const observation = path.join(fixture, 'launch.json');
    const playwrightEntry = path.join(fixture, 'observed-playwright.cjs');
    const require = createRequire(import.meta.url);
    writeFileSync(playwrightEntry, `module.exports = require(${JSON.stringify(path.resolve(import.meta.dir, 'fixtures/native-cookie-launch.cjs'))})(${JSON.stringify({ observation, playwrightEntry: require.resolve('playwright'), inspectCommandLine: true })});`);
    const environment = nativeCookieEnvironment({ SystemRoot: process.env.SystemRoot!, TEMP: fixture, TMP: fixture, USERPROFILE: fixture, LOCALAPPDATA: fixture, APPDATA: fixture, PATH: path.dirname(node) });
    const input = { ...request, nodeExecutable: node, executablePath: edge, userDataDir, playwrightEntry };
    const supervisor = nativeSupervisor(input, environment);
    const contained = await supervisor.done;
    const containedLaunch = safeLaunchEvidence(observation);
    if ('error' in contained && contained.error === 'native_cleanup_failed') throw new Error('Contained cleanup was not confirmed; direct comparison refused');
    if (existsSync(userDataDir)) {
      if (realpathSync(userDataDir).toLowerCase() !== path.resolve(userDataDir).toLowerCase()) throw new Error('Synthetic profile ownership changed; comparison refused');
      rmSync(userDataDir, { recursive: true, force: true });
    }
    const containedObservation = existsSync(observation) ? JSON.parse(readFileSync(observation, 'utf8')) : null;
    rmSync(observation, { force: true });
    const direct = spawnSync(node, ['--input-type=commonjs', '-e', NATIVE_COOKIE_NODE_SCRIPT], {
      env: environment, input: JSON.stringify({ ...input, deadline: Date.now() + 25_000 }),
      encoding: 'utf8', timeout: 30_000, windowsHide: true,
    });
    const directObservation = existsSync(observation) ? JSON.parse(readFileSync(observation, 'utf8')) : null;
    console.log(JSON.stringify({
      nativeEdgeLaunchComparison: {
        contained: 'error' in contained ? contained : { cookiesRead: contained.cookies.length },
        containedLaunch, direct: safeNativeEnvelope(direct.stdout || ''), directStatus: direct.status,
        directLaunch: safeLaunchEvidence(observation),
        argvEqual: containedObservation?.argsHash === directObservation?.argsHash,
        environmentEqual: containedObservation?.envHash === directObservation?.envHash,
        observedCommandLinesEqual: containedObservation?.observedCommandLine?.available === true && directObservation?.observedCommandLine?.available === true
          ? containedObservation.observedCommandLine.commandLineHash === directObservation.observedCommandLine.commandLineHash : null,
      },
    }));
    expect(direct.error).toBeUndefined();
    expect(direct.status).toBe(0);
    expect(JSON.parse(direct.stdout)).toMatchObject({ cookies: expect.any(Array) });
    expect(directObservation).not.toBeNull();
    expect(alive(directObservation.pid)).toBe(false);
    expect(containedObservation?.argsHash).toBe(directObservation.argsHash);
    expect(containedObservation?.envHash).toBe(directObservation.envHash);
    expect(containedObservation?.observedCommandLine).toMatchObject({ available: true });
    expect(directObservation.observedCommandLine).toMatchObject({ available: true });
  }, 65_000);
});
