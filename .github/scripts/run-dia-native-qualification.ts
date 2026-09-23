import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { accessSync, chmodSync, constants, copyFileSync, createReadStream, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { homedir } from 'node:os';
import path from 'node:path';
import { browserPreflightError, browserStartupCategory, captureUserKeychains, fixtureKeychainRestoreCommands, nativeDiaLaunchOptions, observeBrowserLaunches, observeFixtureKeychain,
  prepareKeychainHome, validateQualificationHost } from './qualify-dia-macos';

const require = createRequire(import.meta.url);
const repository = path.resolve(import.meta.dir, '../..');

export const ARCHIVE_CHECK = `import json, posixpath, sys, tarfile, unicodedata
try:
    with tarfile.open(sys.argv[1], 'r:') as archive:
        members = archive.getmembers()
        if len(members) > 200000 or sum(item.size for item in members) > 2 * 1024**3:
            raise ValueError()
        seen, links = set(), set()
        for item in members:
            name = item.name.rstrip('/')
            if not name or name.startswith('/') or '\\\\' in name or any(ord(char) < 32 for char in name):
                raise ValueError()
            canonical = unicodedata.normalize('NFC', name).casefold()
            if '..' in name.split('/') or posixpath.normpath(name) != name or canonical in seen:
                raise ValueError()
            if not (item.isfile() or item.isdir() or item.issym()):
                raise ValueError()
            seen.add(canonical)
            if item.issym():
                target = posixpath.normpath(posixpath.join(posixpath.dirname(name), item.linkname))
                if item.linkname.startswith('/') or '\\\\' in item.linkname or '..' in item.linkname.split('/') or target == '..' or target.startswith('../'):
                    raise ValueError()
                links.add(canonical)
        for item in members:
            parts = unicodedata.normalize('NFC', item.name.rstrip('/')).casefold().split('/')
            if any('/'.join(parts[:index]) in links for index in range(1, len(parts))):
                raise ValueError()
    print(json.dumps({'valid': True, 'members': len(members)}))
except Exception:
    print(json.dumps({'valid': False, 'reason': 'unsafe_source_archive'}))
    sys.exit(2)
`;

export const PRIVATE_RECEIPT_READ = `import json, os, stat, sys
try:
    file, uid, root = sys.argv[1], int(sys.argv[2]), os.path.realpath(sys.argv[3])
    if os.path.realpath(file) != file or os.path.commonpath([file, root]) != root:
        raise ValueError()
    fd = os.open(file, os.O_RDONLY | os.O_NOFOLLOW)
    try:
        info = os.fstat(fd)
        if not stat.S_ISREG(info.st_mode) or info.st_uid != uid or info.st_mode & 0o022 or info.st_size > 1024**2:
            raise ValueError()
        data = os.read(fd, 1024**2 + 1)
        if len(data) > 1024**2:
            raise ValueError()
        value = json.loads(data)
        if not isinstance(value, dict):
            raise ValueError()
        print(json.dumps(value))
    finally:
        os.close(fd)
except Exception:
    sys.exit(2)
`;

interface FreshAccount {
  work: string; home: string; temporary: string; snapshot: string; bun: string; destinationExecutable: string;
  uid: number; gid: number; account: string; guid: string; groupGuid: string; label: string;
  sourceRevision: string; archiveSha256: string; bunSha256: string; destinationSha256: string;
  configFile: string; environment: Record<string, string>;
}

export function parseDirectoryRecord(output: string): Record<string, string> {
  const result: Record<string, string> = {};
  for (const line of output.trim().split('\n')) {
    const match = line.match(/^([A-Za-z]+):\s+(.+)$/);
    if (!match || Object.hasOwn(result, match[1])) throw new Error('invalid_directory_record');
    result[match[1]] = match[2].trim();
  }
  return result;
}

export function ownsFreshAccount(record: Record<string, string>, account: Pick<FreshAccount, 'guid' | 'uid' | 'gid' | 'home'>): boolean {
  return record.GeneratedUID?.toUpperCase() === account.guid.toUpperCase() && record.UniqueID === String(account.uid)
    && record.PrimaryGroupID === String(account.gid) && record.NFSHomeDirectory === account.home;
}

export function freshLaunchDefinition(account: FreshAccount) {
  return {
    Label: account.label, UserName: account.account, GroupName: account.account, SessionCreate: true,
    RunAtLoad: true, KeepAlive: false, ExitTimeOut: 5, Umask: 63,
    WorkingDirectory: account.snapshot,
    ProgramArguments: [account.bun, '--no-env-file', '--no-install', '--no-macros', '--config=/dev/null',
      path.join(account.snapshot, '.github/scripts/run-dia-native-qualification.ts'), '--fresh-worker', account.configFile],
    EnvironmentVariables: account.environment,
    StandardOutPath: '/dev/null', StandardErrorPath: '/dev/null',
  };
}

export function ownsLaunchService(state: string, account: Pick<FreshAccount, 'label' | 'bun' | 'account'>): boolean {
  return state.trimStart().startsWith('system/' + account.label + ' = {')
    && state.match(/^\s*program = (.+)$/m)?.[1].trim() === account.bun
    && state.match(/^\s*username = (.+)$/m)?.[1].trim() === account.account
    && state.match(/^\s*group = (.+)$/m)?.[1].trim() === account.account;
}

async function digest(file: string) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(file)) hash.update(chunk);
  return hash.digest('hex');
}

function safeCommand(command: string, args: string[], timeout: number, env: NodeJS.ProcessEnv, cwd?: string) {
  timeout = Math.floor(timeout);
  if (!Number.isFinite(timeout) || timeout < 1) throw new Error('native_operation_timed_out');
  const result = spawnSync(command, args, { env, cwd, encoding: 'utf8', timeout, maxBuffer: 1024 * 1024 });
  if (result.error || result.status !== 0) {
    const elevated = command === '/usr/bin/sudo';
    const errorCode = (result.error as NodeJS.ErrnoException | undefined)?.code;
    throw Object.assign(new Error('native_command_failed'), { diagnostic: {
      command: path.basename(elevated ? args[1] : command), operation: args[elevated ? 2 : 0], exitCode: result.status,
      stdoutBytes: Buffer.byteLength(result.stdout || ''), stderrBytes: Buffer.byteLength(result.stderr || ''),
      spawnError: result.error ? (['ENOENT', 'EACCES', 'EPERM', 'ETIMEDOUT'].includes(errorCode || '') ? errorCode : 'spawn_failed') : undefined,
    } });
  }
  return result.stdout.trim();
}

async function limit<T>(promise: Promise<T>, timeout: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  try {
    return await Promise.race([promise, new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error('native_operation_timed_out')), timeout);
    })]);
  } finally { clearTimeout(timer!); }
}

async function freshWorker(configFile: string) {
  validateQualificationHost(process.env);
  const info = lstatSync(configFile);
  if (!info.isFile() || info.uid !== 0 || (info.mode & 0o022) !== 0 || info.size > 64 * 1024 || realpathSync(configFile) !== configFile) throw new Error('unsafe_fresh_account_configuration');
  const account: FreshAccount = JSON.parse(readFileSync(configFile, 'utf8'));
  if (realpathSync(account.work) !== account.work || path.dirname(account.work) !== '/private/tmp'
    || !path.basename(account.work).startsWith('dia-native-') || configFile !== path.join(account.work, 'account.json')
    || account.temporary !== path.join(account.work, 'tmp') || realpathSync(account.temporary) !== account.temporary
    || lstatSync(account.temporary).uid !== process.getuid?.()) throw new Error('unsafe_fresh_account_output');
  const preflightFile = path.join(account.temporary, 'dia-background-preflight.json');
  const seed = lstatSync(preflightFile);
  if (!seed.isFile() || seed.uid !== process.getuid?.() || realpathSync(preflightFile) !== preflightFile) throw new Error('unsafe_preflight_receipt');
  const receipt: Record<string, any> = { status: 'incomplete', reason: 'fresh_identity_preflight', nativeCasesRun: false,
    preflight: { registeredIdentity: false, foundationHome: false, keychain: false, headlessChromium: false },
    cleanup: { probeBrowsersStopped: false, probeKeychainRestored: false }, sessionCreate: true };
  const env = account.environment;
  let cleaning = false;
  const run = (command: string, args: string[], timeout = 10_000) => {
    try { return safeCommand(command, args, timeout, env, account.snapshot); }
    catch (error) {
      const diagnostic = (error as { diagnostic?: object }).diagnostic ?? { command: path.basename(command), operation: args[0] };
      if (cleaning) (receipt.cleanupCommandFailures ??= []).push(diagnostic);
      else receipt.initialCommandFailure ??= diagnostic;
      throw new Error('native_command_failed');
    }
  };
  let context: any;
  let observer: ReturnType<typeof observeBrowserLaunches> | undefined;
  let launchAttempted = false;
  let keychainCreated = false;
  let keychainChanged = false;
  let snapshot: ReturnType<typeof captureUserKeychains> | undefined;
  const probe = path.join(account.temporary, 'probe');
  const keychain = path.join(probe, 'probe.keychain-db');
  try {
    if (!/^[a-z][a-z0-9]{8,24}$/.test(account.account) || process.getuid?.() !== account.uid || process.geteuid?.() !== account.uid
      || process.getgid?.() !== account.gid || realpathSync(homedir()) !== account.home || realpathSync(account.work) !== account.work) throw new Error('fresh_identity_mismatch');
    for (const directory of [account.home, account.temporary, account.snapshot, path.dirname(account.bun)]) {
      if (!directory.startsWith(account.work + path.sep) || realpathSync(directory) !== directory || lstatSync(directory).uid !== account.uid) throw new Error('fresh_directory_ownership_mismatch');
    }
    const record = parseDirectoryRecord(run('/usr/bin/dscl', ['.', '-read', '/Users/' + account.account, 'UniqueID', 'PrimaryGroupID', 'NFSHomeDirectory', 'GeneratedUID']));
    if (!ownsFreshAccount(record, account)) throw new Error('fresh_registered_identity_mismatch');
    receipt.preflight.registeredIdentity = true;
    const foundationHome = run('/usr/bin/osascript', ['-l', 'JavaScript', '-e', 'ObjC.import("Foundation"); $.NSHomeDirectory().js']);
    if (realpathSync(foundationHome) !== account.home) throw new Error('foundation_home_mismatch');
    receipt.preflight.foundationHome = true;
    receipt.keychainHome = prepareKeychainHome(account.home, account.uid);
    for (const executable of [account.bun, account.destinationExecutable]) {
      accessSync(executable, constants.X_OK);
      if (!path.isAbsolute(executable) || realpathSync(executable) !== executable || !executable.startsWith(account.work + path.sep)) throw new Error('staged_executable_escape');
    }
    if (await digest(account.bun) !== account.bunSha256 || await digest(account.destinationExecutable) !== account.destinationSha256) throw new Error('staged_executable_changed');
    receipt.reason = 'fresh_dependency_install';
    run(account.bun, ['install', '--frozen-lockfile', '--ignore-scripts'], 180_000);
    if (Bun.version !== '1.4.0' || require(path.join(account.snapshot, 'node_modules/playwright/package.json')).version !== '1.62.1') throw new Error('pinned_runtime_mismatch');
    mkdirSync(probe, { mode: 0o700 });
    receipt.reason = 'background_keychain_preflight';
    snapshot = captureUserKeychains(env, [account.home, account.temporary]);
    const password = randomBytes(24).toString('hex');
    const value = randomBytes(24).toString('hex');
    keychainChanged = true;
    run('/usr/bin/security', ['create-keychain', '-p', password, keychain]);
    keychainCreated = true;
    run('/usr/bin/security', ['set-keychain-settings', '-lut', '300', keychain]);
    run('/usr/bin/security', ['unlock-keychain', '-p', password, keychain]);
    run('/usr/bin/security', ['list-keychains', '-d', 'user', '-s', keychain]);
    run('/usr/bin/security', ['default-keychain', '-d', 'user', '-s', keychain]);
    run('/usr/bin/security', ['add-generic-password', '-s', 'Gstack Native Probe', '-a', 'fixture', '-w', value,
      '-T', '/usr/bin/security', keychain]);
    const observed = observeFixtureKeychain(env, [account.home, account.temporary], keychain, value);
    receipt.keychainObservations = { ...observed, preferencesFileExists: existsSync(path.join(account.home, 'Library/Preferences/com.apple.security.plist')) };
    if (!observed.searchPathMatches || !observed.defaultPathMatches || !observed.explicitReadMatches) throw new Error('native_keychain_probe_failed');
    receipt.preflight.keychain = true;
    receipt.browserPreflight = { stage: 'runtime_import', launchReturned: false, ownedRootCount: 0,
      startupPageCount: null, startupPageCategories: [], pageSelected: false, contentSet: false, readbackMatched: false };
    receipt.reason = 'background_browser_runtime_import';
    const { chromium } = await import('playwright');
    const profile = path.join(probe, 'chromium');
    observer = observeBrowserLaunches(new Map([[account.destinationExecutable, profile]]));
    launchAttempted = true;
    receipt.browserPreflight.stage = 'launch';
    receipt.reason = 'background_browser_launch';
    context = await limit(chromium.launchPersistentContext(profile, nativeDiaLaunchOptions(account.destinationExecutable, env)), 40_000);
    receipt.browserPreflight.launchReturned = true;
    receipt.browserPreflight.stage = 'ownership';
    receipt.reason = 'background_browser_ownership';
    receipt.browserPreflight.ownedRootCount = observer.children.length;
    if (observer.children.length !== 1) throw new Error('background_browser_ownership_failed');
    receipt.browserPreflight.stage = 'startup_pages';
    receipt.reason = 'background_browser_startup_pages';
    const pages = context.pages();
    const startupUrls = pages.map((page: any) => page.url());
    receipt.browserPreflight.startupPageCount = pages.length;
    receipt.browserPreflight.startupPageCategories = startupUrls.map(browserStartupCategory);
    if (startupUrls.some((url: string) => url !== 'about:blank')) throw new Error('background_browser_startup_page_rejected');
    receipt.browserPreflight.stage = 'page_selection';
    receipt.reason = 'background_browser_page_selection';
    const page = pages[0] ?? await limit(context.newPage(), 5_000);
    receipt.browserPreflight.pageSelected = true;
    receipt.browserPreflight.stage = 'content_set';
    receipt.reason = 'background_browser_content_set';
    await limit(page.setContent('<div id="fixture">background browser ready</div>'), 5_000);
    receipt.browserPreflight.contentSet = true;
    receipt.browserPreflight.stage = 'readback';
    receipt.reason = 'background_browser_readback';
    receipt.browserPreflight.readbackMatched = await limit(page.locator('#fixture').innerText(), 5_000) === 'background browser ready';
    if (!receipt.browserPreflight.readbackMatched) throw new Error('background_browser_render_failed');
    receipt.browserPreflight.stage = 'completed';
    receipt.preflight.headlessChromium = true;
    receipt.status = 'passed';
    receipt.reason = 'background_session_ready';
  } catch (error) {
    receipt.status = 'incomplete';
    if (error instanceof Error && ['fresh_identity_mismatch', 'fresh_directory_ownership_mismatch', 'fresh_registered_identity_mismatch',
      'foundation_home_mismatch', 'staged_executable_escape', 'staged_executable_changed', 'pinned_runtime_mismatch',
      'user_keychain_search_unavailable', 'user_default_keychain_unavailable', 'keychain_outside_owned_home_refused',
      'keychain_home_unsafe', 'fixture_keychain_not_owned', 'native_keychain_probe_failed'].includes(error.message)) receipt.blocker = error.message;
    if (receipt.browserPreflight) {
      receipt.blocker = browserPreflightError(error);
      receipt.browserPreflight.error = receipt.blocker;
      receipt.browserPreflight.ownedRootCount = observer?.children.length ?? 0;
      receipt.browserPreflight.launchAttempts = observer?.attempts ?? [];
      receipt.browserPreflight.rootStatesBeforeCleanup = (observer?.children ?? []).map(child => ({
        exitCode: Number.isInteger(child.process.exitCode) ? child.process.exitCode : null,
        signal: child.process.signalCode == null ? null
          : ['SIGABRT', 'SIGTRAP', 'SIGSEGV', 'SIGBUS', 'SIGKILL', 'SIGTERM', 'SIGILL'].includes(child.process.signalCode) ? child.process.signalCode : 'other',
      }));
    }
    receipt.initialFailure = { stage: receipt.reason, blocker: receipt.blocker ?? 'native_preflight_failed' };
  } finally {
    cleaning = true;
    if (receipt.browserPreflight && !receipt.browserPreflight.launchAttempts) receipt.browserPreflight.launchAttempts = observer?.attempts ?? [];
    observer?.stop();
    if (context) await limit(context.close().catch(() => {}), 5_000).catch(() => {});
    let stopped = !launchAttempted || observer?.children.length === 1;
    for (const child of observer?.children ?? []) {
      try {
        try { process.kill(-child.pid, 0); process.kill(-child.pid, 'SIGKILL'); } catch (error: any) { if (error.code !== 'ESRCH') throw error; }
        const until = performance.now() + 5_000;
        while (true) {
          try { process.kill(-child.pid, 0); } catch (error: any) { if (error.code === 'ESRCH') break; throw error; }
          if (performance.now() >= until) throw new Error('probe_browser_still_live');
          await Bun.sleep(50);
        }
      } catch { stopped = false; }
    }
    receipt.cleanup.probeBrowsersStopped = stopped;
    if (stopped) {
      try {
        if (keychainChanged && snapshot) {
          let restored = true;
          for (const args of fixtureKeychainRestoreCommands(snapshot, keychain, keychainCreated)) {
            try { run('/usr/bin/security', args); } catch { restored = false; }
          }
          if (!restored || JSON.stringify(captureUserKeychains(env, [account.home, account.temporary])) !== JSON.stringify(snapshot)) throw new Error('probe_keychain_restore_failed');
        }
        receipt.cleanup.probeKeychainRestored = true;
        if (existsSync(probe) && realpathSync(probe) === probe) rmSync(probe, { recursive: true, force: true });
      } catch { receipt.cleanupFailure = 'probe_keychain_restore_failed'; }
    }
    if (!receipt.cleanup.probeBrowsersStopped || !receipt.cleanup.probeKeychainRestored) { receipt.status = 'incomplete'; receipt.reason = 'background_probe_cleanup_incomplete'; }
    const update = path.join(account.temporary, 'preflight-' + randomBytes(8).toString('hex') + '.json');
    writeFileSync(update, JSON.stringify(receipt, null, 2) + '\n', { mode: 0o600, flag: 'wx' });
    renameSync(update, preflightFile);
  }
  if (receipt.status !== 'passed') return 2;
  const result = spawnSync(account.bun, ['--no-env-file', '--no-install', '--no-macros', '--config=/dev/null',
    path.join(account.snapshot, '.github/scripts/qualify-dia-macos.ts')], {
    cwd: account.snapshot, env, stdio: 'ignore', timeout: 660_000, killSignal: 'SIGKILL',
  });
  return !result.error && result.status === 0 ? 0 : 2;
}

export async function runFreshAccountQualification() {
  validateQualificationHost(process.env);
  if (process.getuid?.() === 0 || Bun.version !== '1.4.0') throw new Error('run_as_unprivileged_pinned_ci_runner');
  const outputRoot = realpathSync(process.env.RUNNER_TEMP!);
  const output = path.join(outputRoot, 'dia-native-qualification.json');
  if (existsSync(output)) throw new Error('fresh_output_required');
  const work = realpathSync(mkdtempSync('/private/tmp/dia-native-'));
  const home = path.join(work, 'home');
  const temporary = path.join(work, 'tmp');
  const snapshot = path.join(work, 'repo');
  const bin = path.join(work, 'bin');
  const browserDirectory = path.join(work, 'browser');
  const archive = path.join(work, 'source.tar');
  const suffix = randomBytes(6).toString('hex');
  const accountName = 'gsdia' + suffix;
  const label = 'ai.gstack.dia.' + suffix;
  const deadline = performance.now() + 16 * 60_000;
  const hostEnv = { HOME: homedir(), PATH: '/usr/bin:/bin:/usr/sbin:/sbin', LANG: 'en_US.UTF-8' };
  let cleanupDeadline = 0;
  const run = (command: string, args: string[], timeout = 10_000) => {
    const remaining = (cleanupDeadline || deadline) - performance.now();
    if (remaining <= 0) throw new Error('fresh_launcher_deadline');
    return safeCommand(command, args, Math.min(timeout, remaining), hostEnv);
  };
  const rootCommand = (command: string, args: string[], timeout = 10_000) => run('/usr/bin/sudo', ['-n', command, ...args], timeout);
  let account: FreshAccount | undefined;
  let userCreated = false;
  let groupCreated = false;
  let serviceAttempted = false;
  let stage = 'fresh_launcher_preflight';
  const receipt: Record<string, any> = { status: 'incomplete', reason: stage, runId: process.env.GITHUB_RUN_ID, runAttempt: process.env.GITHUB_RUN_ATTEMPT,
    counts: { pass: 0, fail: 0, skip: 0 }, launcher: { sessionCreate: true, aquaLogin: false },
    launcherCleanup: { serviceStopped: false, userProcessesStopped: false, accountRemoved: false, groupRemoved: false, stagingRemoved: false } };
  let workerExit: number | undefined;
  let pythonExecutable: string | undefined;
  try {
    rootCommand('/usr/bin/true', []);
    for (const directory of [home, temporary, snapshot, bin, browserDirectory]) mkdirSync(directory, { mode: 0o700 });
    writeFileSync(path.join(temporary, 'dia-background-preflight.json'), JSON.stringify({ status: 'incomplete', reason: 'fresh_worker_not_started',
      nativeCasesRun: false, preflight: { registeredIdentity: false, foundationHome: false, keychain: false, headlessChromium: false } }) + '\n', { mode: 0o600, flag: 'wx' });
    const sourceRevision = run('/usr/bin/git', ['-C', repository, 'rev-parse', 'HEAD']);
    if (!/^[0-9a-f]{40}$/.test(sourceRevision)) throw new Error('invalid_source_revision');
    const python = Bun.which('python3');
    if (!python) throw new Error('archive_validator_unavailable');
    pythonExecutable = realpathSync(python);
    stage = 'source_archive_preflight';
    run('/usr/bin/git', ['-C', repository, 'archive', '--format=tar', '--output', archive, 'HEAD'], 30_000);
    const archiveResult = JSON.parse(run(pythonExecutable, ['-I', '-c', ARCHIVE_CHECK, archive], 30_000));
    if (archiveResult.valid !== true) throw new Error('unsafe_source_archive');
    run('/usr/bin/tar', ['--no-same-owner', '--no-same-permissions', '-xf', archive, '-C', snapshot], 30_000);
    const sourceBun = realpathSync(process.execPath);
    const bun = path.join(bin, 'bun');
    copyFileSync(sourceBun, bun);
    chmodSync(bun, 0o755);
    const { chromium } = await import('playwright');
    if (require('playwright/package.json').version !== '1.62.1') throw new Error('pinned_playwright_required');
    const originalExecutable = realpathSync(chromium.executablePath());
    let bundle = path.dirname(originalExecutable);
    while (!bundle.endsWith('.app')) {
      const parent = path.dirname(bundle);
      if (parent === bundle) throw new Error('destination_app_bundle_missing');
      bundle = parent;
    }
    const copiedBundle = path.join(browserDirectory, path.basename(bundle));
    run('/usr/bin/ditto', ['--rsrc', '--extattr', bundle, copiedBundle], 45_000);
    const destinationExecutable = realpathSync(path.join(copiedBundle, path.relative(bundle, originalExecutable)));
    if (!destinationExecutable.startsWith(browserDirectory + path.sep)) throw new Error('destination_bundle_escape');
    const used = new Set([...run('/usr/bin/dscl', ['.', '-list', '/Users', 'UniqueID']).matchAll(/\s(\d+)$/gm),
      ...run('/usr/bin/dscl', ['.', '-list', '/Groups', 'PrimaryGroupID']).matchAll(/\s(\d+)$/gm)].map(match => Number(match[1])));
    for (const uid of run('/bin/ps', ['-axo', 'uid=']).split(/\s+/).filter(Boolean)) used.add(Number(uid));
    let uid = 20_000;
    while (used.has(uid) && uid < 60_000) uid++;
    if (uid >= 60_000) throw new Error('fresh_uid_unavailable');
    const configFile = path.join(work, 'account.json');
    const metadata = Object.fromEntries(['CI', 'GITHUB_ACTIONS', 'RUNNER_ENVIRONMENT', 'RUNNER_OS', 'RUNNER_ARCH', 'GITHUB_RUN_ID',
      'GITHUB_RUN_ATTEMPT', 'GSTACK_DIA_NATIVE_QUALIFY'].map(name => [name, process.env[name]!]));
    account = { work, home, temporary, snapshot, bun, destinationExecutable, uid, gid: uid, account: accountName,
      guid: randomUUID().toUpperCase(), groupGuid: randomUUID().toUpperCase(), label, sourceRevision,
      archiveSha256: await digest(archive), bunSha256: await digest(bun), destinationSha256: await digest(originalExecutable), configFile,
      environment: { ...metadata, HOME: home, TMPDIR: temporary, RUNNER_TEMP: temporary, PATH: bin + ':/usr/bin:/bin:/usr/sbin:/sbin', LANG: 'en_US.UTF-8',
        GSTACK_DIA_EXPECT_UID: String(uid), GSTACK_DIA_SOURCE_REVISION: sourceRevision, GSTACK_DIA_DESTINATION_EXECUTABLE: destinationExecutable } };
    stage = 'fresh_account_creation';
    rootCommand('/usr/bin/dscl', ['.', '-create', '/Groups/' + accountName]);
    groupCreated = true;
    for (const [name, value] of [['GeneratedUID', account.groupGuid], ['PrimaryGroupID', String(uid)], ['RealName', 'gstack native fixture group']]) {
      rootCommand('/usr/bin/dscl', ['.', '-create', '/Groups/' + accountName, name, value]);
    }
    rootCommand('/usr/bin/dscl', ['.', '-create', '/Users/' + accountName]);
    userCreated = true;
    for (const [name, value] of [['GeneratedUID', account.guid], ['UniqueID', String(uid)], ['PrimaryGroupID', String(uid)],
      ['NFSHomeDirectory', home], ['UserShell', '/usr/bin/false'], ['RealName', 'gstack native fixture'], ['IsHidden', '1'], ['Password', '*']]) {
      rootCommand('/usr/bin/dscl', ['.', '-create', '/Users/' + accountName, name, value]);
    }
    if (!ownsFreshAccount(parseDirectoryRecord(run('/usr/bin/dscl', ['.', '-read', '/Users/' + accountName, 'UniqueID', 'PrimaryGroupID', 'NFSHomeDirectory', 'GeneratedUID'])), account)) throw new Error('fresh_account_not_registered');
    for (const directory of [home, temporary, snapshot, bin, browserDirectory]) rootCommand('/usr/sbin/chown', ['-R', '-P', `${uid}:${uid}`, directory], 30_000);
    writeFileSync(configFile, JSON.stringify(account), { mode: 0o644, flag: 'wx' });
    const json = path.join(work, 'service.json');
    const plist = path.join(work, label + '.plist');
    writeFileSync(json, JSON.stringify(freshLaunchDefinition(account)), { mode: 0o600, flag: 'wx' });
    run('/usr/bin/plutil', ['-convert', 'xml1', '-o', plist, json]);
    rootCommand('/usr/sbin/chown', ['root:wheel', configFile, plist, work]);
    rootCommand('/bin/chmod', ['644', configFile, plist]);
    rootCommand('/bin/chmod', ['755', work]);
    stage = 'background_session_bootstrap';
    serviceAttempted = true;
    rootCommand('/bin/launchctl', ['bootstrap', 'system', plist]);
    stage = 'background_session_probe';
    while (performance.now() < deadline) {
      const state = rootCommand('/bin/launchctl', ['print', 'system/' + label]);
      const exit = state.match(/^\s*last exit code = (\d+)\s*$/m);
      const running = /^\s*pid = \d+\s*$/m.test(state);
      if (!running && exit) { workerExit = Number(exit[1]); break; }
      await Bun.sleep(500);
    }
    if (workerExit === undefined) throw new Error('background_session_timeout');
    receipt.reason = workerExit === 0 ? 'fresh_account_qualification_completed' : 'fresh_account_preflight_or_qualification_failed';
  } catch (error) {
    receipt.reason = stage;
    receipt.failureStage = stage;
    if ((error as { diagnostic?: object }).diagnostic) receipt.commandFailure = (error as { diagnostic: object }).diagnostic;
  } finally {
    cleanupDeadline = performance.now() + 60_000;
    if (serviceAttempted && account) {
      try {
        if (!ownsLaunchService(rootCommand('/bin/launchctl', ['print', 'system/' + label]), account)) throw new Error('service_identity_changed');
        rootCommand('/bin/launchctl', ['bootout', 'system/' + label], 10_000);
        receipt.launcherCleanup.serviceStopped = true;
      } catch {}
    } else receipt.launcherCleanup.serviceStopped = true;
    let owned = false;
    if (account && userCreated) {
      try { owned = ownsFreshAccount(parseDirectoryRecord(run('/usr/bin/dscl', ['.', '-read', '/Users/' + accountName, 'UniqueID', 'PrimaryGroupID', 'NFSHomeDirectory', 'GeneratedUID'])), account); } catch {}
    }
    if (owned && account) {
      try {
        const active = () => run('/bin/ps', ['-axo', 'uid=']).split(/\s+/).some(value => value === String(account!.uid));
        if (active()) {
          try { rootCommand('/usr/bin/pkill', ['-KILL', '-u', String(account.uid)]); } catch {}
          const until = Math.min(cleanupDeadline, performance.now() + 10_000);
          while (active() && performance.now() < until) await Bun.sleep(100);
        }
        receipt.launcherCleanup.userProcessesStopped = !active();
      } catch {}
      if (receipt.launcherCleanup.userProcessesStopped) {
        for (const [name, filename] of [['backgroundPreflight', 'dia-background-preflight.json'], ['qualification', 'dia-native-qualification.json']]) {
          const file = path.join(temporary, filename);
          try {
            if (!pythonExecutable) throw new Error('receipt_reader_unavailable');
            const text = rootCommand(pythonExecutable, ['-I', '-c', PRIVATE_RECEIPT_READ, file, String(account.uid), work]);
            if (text.length > 1024 * 1024) throw new Error('oversized_receipt');
            receipt[name] = JSON.parse(text);
          } catch {}
        }
        try {
          if (!receipt.launcherCleanup.serviceStopped) throw new Error('service_still_loaded');
          const record = parseDirectoryRecord(run('/usr/bin/dscl', ['.', '-read', '/Users/' + accountName, 'UniqueID', 'PrimaryGroupID', 'NFSHomeDirectory', 'GeneratedUID']));
          if (!ownsFreshAccount(record, account)) throw new Error('account_identity_changed');
          rootCommand('/usr/bin/dscl', ['.', '-delete', '/Users/' + accountName]);
          receipt.launcherCleanup.accountRemoved = true;
        } catch {}
      }
    } else if (!userCreated) {
      receipt.launcherCleanup.userProcessesStopped = true;
      receipt.launcherCleanup.accountRemoved = true;
    }
    if (account && groupCreated && receipt.launcherCleanup.accountRemoved) {
      try {
        const group = parseDirectoryRecord(run('/usr/bin/dscl', ['.', '-read', '/Groups/' + accountName, 'GeneratedUID', 'PrimaryGroupID']));
        if (group.GeneratedUID?.toUpperCase() !== account.groupGuid || group.PrimaryGroupID !== String(account.gid)) throw new Error('group_identity_changed');
        rootCommand('/usr/bin/dscl', ['.', '-delete', '/Groups/' + accountName]);
        receipt.launcherCleanup.groupRemoved = true;
      } catch {}
    } else if (!groupCreated) receipt.launcherCleanup.groupRemoved = true;
    const mountSafe = !serviceAttempted || (receipt.qualification ? receipt.qualification.cleanup?.mountDetached === true
      : receipt.backgroundPreflight?.status === 'incomplete');
    if (receipt.launcherCleanup.serviceStopped && receipt.launcherCleanup.userProcessesStopped && receipt.launcherCleanup.accountRemoved
      && receipt.launcherCleanup.groupRemoved && mountSafe && (workerExit !== undefined || !serviceAttempted)) {
      try {
        const owner = lstatSync(work).uid;
        if (realpathSync(work) !== work || path.dirname(work) !== '/private/tmp' || !path.basename(work).startsWith('dia-native-')
          || (owner !== 0 && owner !== process.getuid?.())) throw new Error('staging_identity_changed');
        rootCommand('/bin/rm', ['-rf', '--', work], 20_000);
        receipt.launcherCleanup.stagingRemoved = true;
      } catch {}
    }
    if (receipt.qualification) receipt.counts = receipt.qualification.counts;
    if (account) receipt.launcher = { ...receipt.launcher, uid: account.uid, gid: account.gid, accountGuid: account.guid, groupGuid: account.groupGuid, serviceLabel: account.label,
      sourceRevision: account.sourceRevision, archiveSha256: account.archiveSha256, bunSha256: account.bunSha256, destinationSha256: account.destinationSha256 };
    const clean = Object.values(receipt.launcherCleanup).every(value => value === true);
    receipt.status = workerExit === 0 && receipt.backgroundPreflight?.status === 'passed' && receipt.qualification?.status === 'passed' && clean ? 'passed' : 'incomplete';
    if (!clean) receipt.recovery = 'Discard this disposable runner. Do not reuse its account, session, profile, or Keychain.';
    if (receipt.backgroundPreflight?.status !== 'passed' && receipt.backgroundPreflight) receipt.reason = receipt.backgroundPreflight.reason;
    writeFileSync(output, JSON.stringify(receipt, null, 2) + '\n', { mode: 0o600, flag: 'wx' });
  }
  return receipt;
}

if (import.meta.main) {
  try {
    if (process.argv[2] === '--fresh-worker') process.exitCode = await freshWorker(process.argv[3]);
    else {
      const receipt = await runFreshAccountQualification();
      console.log(JSON.stringify({ status: receipt.status, reason: receipt.reason, counts: receipt.counts, artifact: 'dia-native-qualification.json' }));
      process.exitCode = receipt.status === 'passed' ? 0 : 2;
    }
  } catch {
    console.log(JSON.stringify({ status: 'incomplete', reason: 'fresh_account_launcher_preflight_failed', counts: { pass: 0, fail: 0, skip: 0 } }));
    process.exitCode = 2;
  }
}
