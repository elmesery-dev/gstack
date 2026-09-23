import { createHash, randomBytes } from 'node:crypto';
import { spawnSync, type ChildProcess } from 'node:child_process';
import { accessSync, chmodSync, constants, createReadStream, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { homedir, release } from 'node:os';
import path from 'node:path';
import type { BrowserContext } from 'playwright';

const require = createRequire(import.meta.url);
const repository = path.resolve(import.meta.dir, '../..');
export const DIA_DOWNLOAD = 'https://releases.diabrowser.com/release/Dia-latest.dmg';

export function validateQualificationHost(env: NodeJS.ProcessEnv, platform = process.platform, architecture = process.arch): void {
  if (platform !== 'darwin' || architecture !== 'arm64' || env.CI !== 'true' || env.GITHUB_ACTIONS !== 'true'
    || env.RUNNER_ENVIRONMENT !== 'github-hosted' || env.RUNNER_OS !== 'macOS' || env.RUNNER_ARCH !== 'ARM64'
    || env.GSTACK_DIA_NATIVE_QUALIFY !== '1' || !env.RUNNER_TEMP || !env.GITHUB_RUN_ID || !env.GITHUB_RUN_ATTEMPT) {
    throw new Error('disposable_arm64_macos_ci_required');
  }
}

export function nativeDiaLaunchOptions(executablePath: string, env: Record<string, string>) {
  return {
    executablePath, env, headless: true, timeout: 30_000, serviceWorkers: 'block' as const,
    ignoreDefaultArgs: ['--use-mock-keychain', '--password-store=basic', '--no-first-run'],
    args: ['--disable-sync', '--no-default-browser-check', '--profile-directory=Default'],
    handleSIGINT: false, handleSIGTERM: false, handleSIGHUP: false,
  };
}

export function allowedFixturePage(url: string, origin: string): boolean {
  if (url === 'about:blank') return true;
  try { const page = new URL(url); return !page.username && !page.password && page.origin === origin && new URL(origin).hostname === '127.0.0.1'; }
  catch { return false; }
}

export function browserStartupCategory(value: string): string {
  if (value === 'about:blank') return 'blank';
  try {
    const url = new URL(value);
    if (url.protocol === 'about:') return 'other_about';
    if (url.protocol === 'chrome:' || url.protocol === 'chrome-untrusted:') {
      if (['newtab', 'new-tab-page'].includes(url.hostname)) return 'chromium_new_tab';
      if (['intro', 'welcome', 'first-run', 'signin', 'sync-confirmation', 'profile-picker'].includes(url.hostname)) return 'chromium_onboarding';
      return 'chromium_internal';
    }
    if (url.protocol === 'dia:') return 'dia_internal';
    if (url.protocol === 'chrome-extension:') return 'extension';
    if (['http:', 'https:'].includes(url.protocol)) return ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname) ? 'loopback_web' : 'external_web';
    if (url.protocol === 'file:') return 'file';
    if (url.protocol === 'data:') return 'data';
    return 'other_scheme';
  } catch { return 'invalid'; }
}

export function browserPreflightError(error: unknown): string {
  const message = error instanceof Error ? error.message : '';
  const code = (error as { code?: string } | null)?.code;
  if (['MODULE_NOT_FOUND', 'ERR_MODULE_NOT_FOUND'].includes(code ?? '')) return 'module_unavailable';
  if (code === 'ERR_PACKAGE_PATH_NOT_EXPORTED') return 'module_export_unavailable';
  if (['ERR_REQUIRE_ESM', 'ERR_UNKNOWN_FILE_EXTENSION', 'ERR_INVALID_PACKAGE_CONFIG'].includes(code ?? '')) return 'module_format_error';
  if (/\bbrowser_launch_policy_rejected\b/.test(message)) return 'launch_policy_rejected';
  if (message === 'background_browser_ownership_failed') return 'ownership_unconfirmed';
  if (message === 'background_browser_startup_page_rejected') return 'startup_page_rejected';
  if (message === 'background_browser_render_failed') return 'render_mismatch';
  if ((error instanceof Error && error.name === 'TimeoutError') || message === 'native_operation_timed_out') return 'operation_timeout';
  if (code === 'ENOENT' || /Executable doesn't exist|spawn .* ENOENT/.test(message)) return 'executable_unavailable';
  if (['EACCES', 'EPERM'].includes(code ?? '') || /spawn .* EACCES/.test(message)) return 'permission_denied';
  if (code === 'ERR_OUT_OF_RANGE' || (error instanceof Error && error.name === 'RangeError')) return 'invalid_runtime_range';
  if (error instanceof Error && error.name === 'TypeError') return 'runtime_type_error';
  if (/Library not loaded:|dyld(?:\[\d+\])?:|no suitable image found/i.test(message)) return 'dynamic_library_error';
  if (/code signature (?:invalid|not valid)|mapped file has no cdhash|library load disallowed by system policy|CODESIGNING/i.test(message)) return 'code_signing_error';
  if (/ProcessSingleton|SingletonLock|profile.*in use/i.test(message)) return 'browser_profile_unavailable';
  if (/WindowServer|CGSConnection|audit session|bootstrap_check_in/i.test(message)) return 'graphics_or_bootstrap_error';
  if (/Target page, context or browser has been closed|Browser closed|Target closed/.test(message)) return 'target_closed';
  if (/Protocol error/.test(message)) return 'protocol_error';
  return 'unclassified_browser_error';
}

export function playwrightModuleLoadFacts(snapshot: string, error: unknown) {
  const detail = error as { name?: unknown; code?: unknown; message?: unknown } | null;
  const names = ['Error', 'ResolveMessage', 'BuildMessage', 'SyntaxError', 'TypeError', 'RangeError', 'TimeoutError'];
  const codes = ['MODULE_NOT_FOUND', 'ERR_MODULE_NOT_FOUND', 'ERR_PACKAGE_PATH_NOT_EXPORTED', 'ERR_REQUIRE_ESM', 'ERR_UNKNOWN_FILE_EXTENSION',
    'ERR_INVALID_PACKAGE_CONFIG', 'ENOENT', 'EACCES', 'EPERM', 'ERR_OUT_OF_RANGE'];
  const message = typeof detail?.message === 'string' ? detail.message : '';
  const module = ['playwright', 'playwright-core', './lib/bootstrap', './lib/coreBundle']
    .find(name => message.includes("'" + name + "'") || message.includes('"' + name + '"')) ?? 'unclassified';
  const files = Object.fromEntries(['playwright/package.json', 'playwright/index.mjs', 'playwright/index.js', 'playwright-core/package.json',
    'playwright-core/index.mjs', 'playwright-core/index.js', 'playwright-core/lib/bootstrap.js', 'playwright-core/lib/coreBundle.js'].map(name => {
    const file = path.join(snapshot, 'node_modules', name);
    const facts = { exists: false, readable: false, ownedByCurrentUid: false, insideSnapshot: false };
    try {
      const info = lstatSync(file);
      facts.exists = true;
      facts.ownedByCurrentUid = info.uid === process.getuid?.();
      facts.insideSnapshot = realpathSync(file).startsWith(realpathSync(snapshot) + path.sep);
      accessSync(file, constants.R_OK);
      facts.readable = true;
    } catch {}
    return [name, facts];
  }));
  return { errorType: typeof detail?.name === 'string' && names.includes(detail.name) ? detail.name : 'unclassified',
    errorCode: typeof detail?.code === 'string' && codes.includes(detail.code) ? detail.code : 'unclassified', requestedModule: module, files };
}

export function parseKeychainPaths(output: string, allowEmpty = false): string[] {
  const paths = output.split('\n').map(line => line.trim()).filter(Boolean).map(line => {
    const value = JSON.parse(line);
    if (typeof value !== 'string' || !path.isAbsolute(value)) throw new Error('invalid_keychain_snapshot');
    return value;
  });
  if (!paths.length && !allowEmpty) throw new Error('empty_keychain_snapshot');
  return paths;
}

export function parseDefaultKeychain(result: { status: number | null; stdout: string; stderr: string; error?: unknown }): string[] {
  if (!result.error && result.status === 1 && !result.stdout.trim()
    && /^security: SecKeychainCopy(?:DomainDefault user|Default): A default keychain could not be found\.$/.test(result.stderr.trim())) return [];
  if (result.error || result.status !== 0 || (!result.stdout.trim() && result.stderr.trim())) throw new Error('user_default_keychain_unavailable');
  const paths = parseKeychainPaths(result.stdout, true);
  if (paths.length > 1) throw new Error('invalid_default_keychain_snapshot');
  return paths;
}

export function prepareKeychainHome(home: string, uid = process.getuid?.()) {
  if (uid === undefined || realpathSync(home) !== home || !lstatSync(home).isDirectory() || lstatSync(home).uid !== uid) throw new Error('keychain_home_unsafe');
  const directories = ['Library', 'Library/Preferences', 'Library/Keychains'];
  const before = Object.fromEntries(directories.map(name => [name, existsSync(path.join(home, name))]));
  for (const name of directories) {
    const directory = path.join(home, name);
    if (!existsSync(directory)) mkdirSync(directory, { mode: 0o700 });
    const info = lstatSync(directory);
    if (!info.isDirectory() || info.isSymbolicLink() || info.uid !== uid || (info.mode & 0o022) !== 0 || realpathSync(directory) !== directory) throw new Error('keychain_home_unsafe');
  }
  return { before, directoriesReady: true };
}

type KeychainResult = { status: number | null; stdout: string; stderr: string; error?: unknown };
type KeychainExecutor = (args: string[], timeout: number) => KeychainResult;

function keychainCommand(env: Record<string, string>, args: string[], deadline: number, execute?: KeychainExecutor, onDispatch?: () => void): KeychainResult {
  const timeout = Math.floor(deadline - performance.now());
  if (!Number.isFinite(timeout) || timeout < 1) throw new Error('user_keychain_probe_timeout');
  onDispatch?.();
  return execute ? execute(args, timeout) : spawnSync('/usr/bin/security', args, {
    env, encoding: 'utf8', timeout, maxBuffer: 1024 * 1024,
  });
}

function requireOwnedKeychains(paths: string[], allowedRoots: string[]) {
  for (const keychain of paths) {
    const resolved = existsSync(keychain) ? realpathSync(keychain) : path.resolve(keychain);
    if (!allowedRoots.some(root => resolved.startsWith(realpathSync(root) + path.sep))) throw new Error('keychain_outside_owned_home_refused');
  }
}

export function captureUserKeychains(env: Record<string, string>, allowedRoots: string[], milliseconds = 10_000,
  execute?: KeychainExecutor) {
  const deadline = performance.now() + milliseconds;
  const probe = (args: string[]) => keychainCommand(env, args, deadline, execute);
  const search = probe(['list-keychains', '-d', 'user']);
  if (search.error || search.status !== 0 || (!search.stdout.trim() && search.stderr.trim())) throw new Error('user_keychain_search_unavailable');
  const snapshot = { search: parseKeychainPaths(search.stdout, true), default: parseDefaultKeychain(probe(['default-keychain', '-d', 'user'])) };
  requireOwnedKeychains([...snapshot.search, ...snapshot.default], allowedRoots);
  return snapshot;
}

export function observeFixtureKeychain(env: Record<string, string>, allowedRoots: string[], keychain: string, expected: string,
  milliseconds = 10_000, execute?: KeychainExecutor) {
  requireOwnedKeychains([keychain], allowedRoots);
  const info = lstatSync(keychain);
  if (!info.isFile() || info.isSymbolicLink() || info.uid !== process.getuid?.()) throw new Error('fixture_keychain_not_owned');
  const expectedPath = realpathSync(keychain);
  const deadline = performance.now() + milliseconds;
  const result = { searchCount: null as number | null, searchPathMatches: false, defaultCount: null as number | null,
    defaultPathMatches: false, explicitReadAttempted: false, explicitReadSucceeded: false, explicitReadMatches: false };
  try {
    const search = keychainCommand(env, ['list-keychains', '-d', 'user'], deadline, execute);
    if (search.error || search.status !== 0 || (!search.stdout.trim() && search.stderr.trim())) throw new Error('search_unavailable');
    const paths = parseKeychainPaths(search.stdout, true);
    result.searchCount = paths.length;
    requireOwnedKeychains(paths, allowedRoots);
    result.searchPathMatches = paths.length === 1 && realpathSync(paths[0]) === expectedPath;
  } catch {}
  try {
    const paths = parseDefaultKeychain(keychainCommand(env, ['default-keychain', '-d', 'user'], deadline, execute));
    result.defaultCount = paths.length;
    requireOwnedKeychains(paths, allowedRoots);
    result.defaultPathMatches = paths.length === 1 && realpathSync(paths[0]) === expectedPath;
  } catch {}
  try {
    const read = keychainCommand(env, ['find-generic-password', '-s', 'Gstack Native Probe', '-w', keychain], deadline, execute,
      () => { result.explicitReadAttempted = true; });
    result.explicitReadSucceeded = !read.error && read.status === 0;
    result.explicitReadMatches = result.explicitReadSucceeded && read.stdout.trim() === expected;
  } catch {}
  return result;
}

export function fixtureKeychainRestoreCommands(snapshot: { search: string[]; default: string[] }, keychain: string, created: boolean): string[][] {
  if (created && [...snapshot.search, ...snapshot.default].some(original => path.resolve(original) === path.resolve(keychain))) throw new Error('fixture_keychain_not_fresh');
  return [
    ...(snapshot.default.length ? [['default-keychain', '-d', 'user', '-s', ...snapshot.default]] : []),
    ...(created ? [['delete-keychain', keychain]] : []),
    ['list-keychains', '-d', 'user', '-s', ...snapshot.search],
  ];
}

export function observeBrowserLaunches(expected: ReadonlyMap<string, string>) {
  const childProcess = require('node:child_process');
  const original = childProcess.spawn;
  const children: Array<{ process: ChildProcess; executable: string; pid: number }> = [];
  const attempts: Array<Record<string, number | boolean | null>> = [];
  let accepting = true;
  childProcess.spawn = function(command: string, args: string[], options: any) {
    if (!expected.has(command)) return original.call(this, command, args, options);
    const argumentsArray = Array.isArray(args);
    attempts.push({ admissionOpen: accepting, argumentsArray, pipeFlag: argumentsArray && args.includes('--remote-debugging-pipe'),
      profileArgumentCount: argumentsArray ? args.filter(arg => arg.startsWith('--user-data-dir')).length : null,
      expectedProfile: argumentsArray && args.includes('--user-data-dir=' + expected.get(command)),
      detached: options?.detached === true, shellDisabled: options?.shell === undefined || options.shell === false,
      stdioCount: Array.isArray(options?.stdio) ? options.stdio.length : null,
      extraPipeDescriptors: Array.isArray(options?.stdio) && options.stdio[3] === 'pipe' && options.stdio[4] === 'pipe',
      headlessFlag: argumentsArray && args.some(arg => /^--headless(?:=|$)/.test(arg)),
      blankStartupArgument: argumentsArray && args.includes('about:blank'),
      tcpDebuggingFlag: argumentsArray && args.some(arg => /^--remote-debugging-port(?:=|$)/.test(arg)),
      mockKeychainFlag: argumentsArray && args.some(arg => /^--use-mock-keychain(?:=|$)/.test(arg)),
      passwordStoreFlag: argumentsArray && args.some(arg => /^--password-store(?:=|$)/.test(arg)),
      firstRunSuppressed: argumentsArray && args.some(arg => /^--no-first-run(?:=|$)/.test(arg)) });
    if (!accepting || !Array.isArray(args) || !args.includes('--remote-debugging-pipe')
      || args.filter(arg => arg.startsWith('--user-data-dir')).length !== 1 || !args.includes('--user-data-dir=' + expected.get(command))
      || options?.detached !== true || (options.shell !== undefined && options.shell !== false) || !Array.isArray(options?.stdio)
      || options.stdio.length !== 5 || options.stdio[3] !== 'pipe' || options.stdio[4] !== 'pipe'
      || args.some(arg => /^--(?:remote-debugging-port|use-mock-keychain|password-store|no-first-run)(?:=|$)/.test(arg))) {
      throw new Error('browser_launch_policy_rejected');
    }
    const child: ChildProcess = original.call(this, command, args, options);
    if (child.pid) children.push({ process: child, executable: command, pid: child.pid });
    return child;
  };
  return { children, attempts, stop() { accepting = false; }, restore() { childProcess.spawn = original; } };
}

async function sha256(file: string): Promise<string> {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(file)) hash.update(chunk);
  return hash.digest('hex');
}

async function bounded<T>(operation: Promise<T>, milliseconds: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  try {
    return await Promise.race([operation, new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error('operation_timeout')), milliseconds);
    })]);
  } finally { clearTimeout(timer!); }
}

export async function qualifyDia(isolation: { root: string; originalHome: string; destinationExecutable: string }): Promise<Record<string, any>> {
  validateQualificationHost(process.env);
  if (process.env.GSTACK_DIA_EXPECT_UID && process.getuid?.() !== Number(process.env.GSTACK_DIA_EXPECT_UID)) throw new Error('fresh_account_uid_mismatch');
  if (Bun.version !== '1.4.0' || require('playwright/package.json').version !== '1.62.1') throw new Error('pinned_runtimes_required');
  const runnerTemp = realpathSync(process.env.RUNNER_TEMP!);
  const output = path.join(runnerTemp, 'dia-native-qualification.json');
  if (existsSync(output)) throw new Error('fresh_receipt_path_required');
  const root = realpathSync(isolation.root);
  if (path.dirname(root) !== runnerTemp || !path.basename(root).startsWith('dia-')) throw new Error('fixture_root_unowned');
  const home = path.join(root, 'h');
  if (realpathSync(homedir()) !== home || realpathSync(process.env.HOME!) !== home) throw new Error('fixture_home_not_effective_at_startup');
  const temporary = path.join(root, 't');
  const sourceProfile = path.join(home, 'Library/Application Support/Dia/User Data');
  const destinationProfile = path.join(root, 'd');
  const keychain = path.join(root, 'fixture.keychain-db');
  const mount = path.join(root, 'm');
  const image = path.join(root, 'Dia.dmg');
  const app = path.join(root, 'Dia.app');
  const systemEnvironment = { HOME: realpathSync(isolation.originalHome), PATH: '/usr/bin:/bin:/usr/sbin:/sbin', LANG: 'en_US.UTF-8', TMPDIR: temporary };
  if (systemEnvironment.HOME === home || systemEnvironment.HOME.startsWith(root + path.sep)) throw new Error('original_home_not_preserved');
  const fixtureEnvironment = { ...systemEnvironment, HOME: home };
  const deadline = performance.now() + 9 * 60_000;
  let cleaning = false;
  let cleanupDeadline = 0;
  let stage = 'fixture_preflight';
  let mounted = false;
  let keychainCreated = false;
  let keychainChanged = false;
  let originalSearch: string[] = [];
  let originalDefault: string[] = [];
  let source: BrowserContext | undefined;
  let destination: BrowserContext | undefined;
  let observer: ReturnType<typeof observeBrowserLaunches> | undefined;
  let launchAttempts = 0;
  let server: ReturnType<typeof Bun.serve> | undefined;
  const receipt: Record<string, any> = {
    status: 'incomplete', reason: 'not_run', runId: process.env.GITHUB_RUN_ID, runAttempt: process.env.GITHUB_RUN_ATTEMPT,
    platform: { os: 'darwin', architecture: 'arm64', release: release(), bun: Bun.version, playwright: '1.62.1' },
    isolation: { fixtureHomeAtStartup: true, productionLookupMocked: false, keychainCommandHome: 'original_runner_home' },
    artifact: { url: DIA_DOWNLOAD }, expectedCases: 8,
    cases: Object.fromEntries(['headless_without_account_interaction', 'synthetic_session_created', 'native_encrypted_cookie_persisted',
      'dia_profile_and_domain_discovered', 'native_keychain_decryption_and_verified_import', 'default_storage_preserved',
      'wrong_identity_not_verified', 'explicit_storage_reset'].map(name => [name, 'not_run'])), counts: { pass: 0, fail: 0, skip: 0 },
    coverage: { mockKeychain: false, nativeKeychainRead: false, nativePermissionPrompts: false, accountLogin: false, sync: false, browserProfileImport: false },
    cleanup: { ownedBrowsersStopped: false, keychainRestored: false, mountDetached: false, fixtureRemoved: false },
  };
  const run = (command: string, args: string[], milliseconds = 10_000, env = systemEnvironment) => {
    const remaining = (cleaning ? cleanupDeadline : deadline) - performance.now();
    const timeout = Math.floor(Math.min(milliseconds, remaining));
    if (!Number.isFinite(timeout) || timeout < 1) throw new Error('qualification_budget_exhausted');
    const result = spawnSync(command, args, { env, encoding: 'utf8', timeout, maxBuffer: 1024 * 1024 });
    if (result.error || result.status !== 0) {
      receipt[cleaning ? 'cleanupCommandFailure' : 'commandFailure'] = { command: path.basename(command), operation: args[0], exitCode: result.status,
        timedOut: (result.error as NodeJS.ErrnoException | undefined)?.code === 'ETIMEDOUT' };
      throw new Error('command_failed');
    }
    return { stdout: result.stdout.trim(), stderr: result.stderr.trim() };
  };
  const check = (name: string, passed: boolean) => {
    receipt.cases[name] = passed ? 'passed' : 'failed';
    if (!passed) throw new Error('case_failed');
  };
  const within = <T>(operation: () => Promise<T>, milliseconds: number) => {
    const remaining = deadline - performance.now();
    if (remaining <= 0) throw new Error('qualification_budget_exhausted');
    return bounded(operation(), Math.min(milliseconds, remaining));
  };
  try {
    for (const directory of [home, temporary, mount]) {
      if (!existsSync(directory)) mkdirSync(directory, { mode: 0o700 });
      else if (realpathSync(directory) !== directory || !lstatSync(directory).isDirectory()) throw new Error('fixture_directory_escape');
    }
    if (Buffer.byteLength(path.join(sourceProfile, 'SingletonSocket')) >= 100) throw new Error('fixture_socket_path_too_long');
    if (existsSync(sourceProfile) || existsSync(destinationProfile)) throw new Error('existing_profile_refused');
    for (const relative of ['Library/Application Support/Google/Chrome', 'Library/Application Support/Chromium',
      'Library/Application Support/Arc', 'Library/Application Support/Dia', 'Library/Application Support/Comet',
      'Library/Application Support/BraveSoftware/Brave-Browser', 'Library/Application Support/Microsoft Edge',
      'Library/Safari', 'Library/Cookies']) {
      if (existsSync(path.join(systemEnvironment.HOME, relative))) {
        receipt.preexistingState = relative;
        throw new Error('preexisting_browser_state_refused');
      }
    }
    receipt.keychainHome = prepareKeychainHome(systemEnvironment.HOME);
    const revision = process.env.GSTACK_DIA_SOURCE_REVISION;
    if (revision && !/^[0-9a-f]{40}$/.test(revision)) throw new Error('invalid_source_revision');
    receipt.sourceRevision = revision ?? run('/usr/bin/git', ['-C', repository, 'rev-parse', 'HEAD']).stdout;
    const sourceFiles = ['.github/scripts/qualify-dia-macos.ts', 'browse/src/cookie-import-browser.ts', 'browse/src/cookie-import-operation.ts', 'browse/src/cookie-database.ts', 'browse/src/cookie-auth-verification.ts', 'browse/src/cdp-bridge.ts'];
    receipt.sourceHashes = Object.fromEntries(await within(() => Promise.all(sourceFiles.map(async file => [file, await sha256(path.join(repository, file))])), 10_000));
    stage = 'official_download';
    const downloaded = run('/usr/bin/curl', ['--fail', '--silent', '--show-error', '--location', '--proto', '=https', '--proto-redir', '=https',
      '--connect-timeout', '20', '--max-time', '300', '--output', image, '--write-out', '%{url_effective}', DIA_DOWNLOAD], 310_000);
    if (new URL(downloaded.stdout).origin !== 'https://releases.diabrowser.com') throw new Error('unexpected_download_origin');
    chmodSync(image, 0o600);
    receipt.artifact.sha256 = await within(() => sha256(image), 30_000);
    stage = 'signed_app_staging';
    run('/usr/bin/hdiutil', ['attach', '-readonly', '-nobrowse', '-noautoopen', '-mountpoint', mount, image], 45_000);
    mounted = true;
    const mountedApp = path.join(mount, 'Dia.app');
    if (!lstatSync(mountedApp).isDirectory() || !realpathSync(mountedApp).startsWith(realpathSync(mount) + path.sep)) throw new Error('mounted_app_escape');
    run('/usr/bin/ditto', ['--rsrc', '--extattr', mountedApp, app], 45_000);
    run('/usr/bin/hdiutil', ['detach', mount], 15_000);
    mounted = false;
    if (realpathSync(app) !== app) throw new Error('staged_app_escape');
    run('/usr/bin/codesign', ['--verify', '--deep', '--strict', '--verbose=2', app], 45_000);
    const signature = run('/usr/bin/codesign', ['--display', '--verbose=4', app]).stderr;
    const gatekeeper = run('/usr/sbin/spctl', ['--assess', '--type', 'execute', '--verbose=4', app], 45_000).stderr;
    const authority = signature.match(/^Authority=(Developer ID Application: .+)$/m)?.[1];
    const team = signature.match(/^TeamIdentifier=([A-Z0-9]{10})$/m)?.[1];
    if (!authority || !team || !gatekeeper.includes('accepted') || !gatekeeper.includes('Notarized Developer ID')) throw new Error('signer_or_notarization_unconfirmed');
    const plist = path.join(app, 'Contents/Info.plist');
    const property = (name: string) => run('/usr/bin/plutil', ['-extract', name, 'raw', '-o', '-', plist]).stdout;
    const executableName = property('CFBundleExecutable');
    if (!executableName || path.basename(executableName) !== executableName) throw new Error('invalid_bundle_executable');
    const executable = realpathSync(path.join(app, 'Contents/MacOS', executableName));
    if (!executable.startsWith(realpathSync(app) + path.sep)) throw new Error('bundle_executable_escape');
    const architectures = run('/usr/bin/lipo', ['-archs', executable]).stdout.split(/\s+/);
    if (!architectures.includes('arm64')) throw new Error('dia_arm64_binary_required');
    receipt.artifact = { ...receipt.artifact, version: property('CFBundleShortVersionString'), bundleId: property('CFBundleIdentifier'), authority, team,
      architectures, executableSha256: await within(() => sha256(executable), 10_000), signatureVerified: true, gatekeeperNotarized: true };
    stage = 'temporary_keychain';
    const originalKeychains = captureUserKeychains(systemEnvironment, [systemEnvironment.HOME, root]);
    originalSearch = originalKeychains.search;
    originalDefault = originalKeychains.default;
    const keychainPassword = randomBytes(24).toString('hex');
    const fixtureKey = randomBytes(24).toString('hex');
    keychainChanged = true;
    run('/usr/bin/security', ['create-keychain', '-p', keychainPassword, keychain]);
    keychainCreated = true;
    run('/usr/bin/security', ['set-keychain-settings', '-lut', '600', keychain]);
    run('/usr/bin/security', ['unlock-keychain', '-p', keychainPassword, keychain]);
    run('/usr/bin/security', ['add-generic-password', '-a', 'Dia', '-s', 'Dia Safe Storage', '-w', fixtureKey, '-T', executable, '-T', '/usr/bin/security', keychain]);
    run('/usr/bin/security', ['list-keychains', '-d', 'user', '-s', keychain]);
    run('/usr/bin/security', ['default-keychain', '-d', 'user', '-s', keychain]);
    for (const env of [systemEnvironment, fixtureEnvironment]) {
      const active = parseKeychainPaths(run('/usr/bin/security', ['list-keychains', '-d', 'user'], 10_000, env).stdout);
      if (active.length !== 1 || realpathSync(active[0]) !== realpathSync(keychain)) throw new Error('keychain_search_isolation_failed');
    }
    if (run('/usr/bin/security', ['find-generic-password', '-s', 'Dia Safe Storage', '-w', keychain]).stdout !== fixtureKey) throw new Error('fixture_keychain_read_failed');
    delete process.env.DEBUG;
    delete process.env.PWDEBUG;
    const { chromium } = await import('playwright');
    const destinationExecutable = realpathSync(isolation.destinationExecutable);
    observer = observeBrowserLaunches(new Map([[executable, sourceProfile], [destinationExecutable, destinationProfile]]));
    const token = randomBytes(24).toString('hex');
    const identity = 'Synthetic Dia qualification account';
    server = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch(request) {
      const url = new URL(request.url);
      if (url.pathname === '/seed') return new Response('Synthetic session seeded.', { headers: { 'Content-Type': 'text/html', 'Set-Cookie': `dia_fixture_session=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=3600` } });
      const authenticated = (request.headers.get('cookie') || '').split(';').some(value => value.trim() === `dia_fixture_session=${token}`);
      return new Response(authenticated ? `<div id="fixture-identity">${identity}</div>` : '<form>Not signed in</form>', { status: authenticated ? 200 : 401, headers: { 'Content-Type': 'text/html' } });
    } });
    const origin = `http://127.0.0.1:${server.port}`;
    stage = 'dia_headless_startup_or_onboarding';
    launchAttempts++;
    source = await within(() => chromium.launchPersistentContext(sourceProfile, nativeDiaLaunchOptions(executable, fixtureEnvironment)), 40_000);
    if (observer.children.filter(child => child.executable === executable).length !== 1) throw new Error('source_process_ownership_unconfirmed');
    if (source.pages().some(page => !allowedFixturePage(page.url(), origin))) throw new Error('onboarding_or_external_page');
    await within(() => source!.route('**/*', route => new URL(route.request().url()).origin === origin ? route.continue() : route.abort()), 10_000);
    const sourcePage = source.pages()[0] ?? await within(() => source!.newPage(), 10_000);
    const seed = await within(() => sourcePage.goto(origin + '/seed', { waitUntil: 'domcontentloaded', timeout: 10_000 }), 10_000);
    check('headless_without_account_interaction', seed?.status() === 200 && sourcePage.url() === origin + '/seed'
      && source.pages().every(page => allowedFixturePage(page.url(), origin)));
    receipt.sourceBrowserVersion = source.browser()?.version();
    const sourceCookies = await within(() => source!.cookies(origin), 10_000);
    check('synthetic_session_created', sourceCookies.some(cookie => cookie.name === 'dia_fixture_session' && cookie.value === token));
    await within(() => source!.close(), 10_000);
    source = undefined;
    stage = 'native_profile_persistence';
    const cookieFile = path.join(sourceProfile, 'Default/Cookies');
    if (!existsSync(cookieFile) || !realpathSync(cookieFile).startsWith(root + path.sep)) throw new Error('expected_profile_layout_missing');
    for (const metadata of ['Local State', 'Default/Preferences']) {
      const file = path.join(sourceProfile, metadata);
      if (existsSync(file) && !realpathSync(file).startsWith(root + path.sep)) throw new Error('profile_metadata_escape');
    }
    const { openCookieDatabase } = await import('../../browse/src/cookie-database');
    const database = openCookieDatabase(cookieFile);
    try {
      const rows = database.query('SELECT value, encrypted_value FROM cookies WHERE host_key = ? AND name = ?').all('127.0.0.1', 'dia_fixture_session') as any[];
      check('native_encrypted_cookie_persisted', rows.length === 1 && !rows[0].value && Buffer.from(rows[0].encrypted_value).subarray(0, 3).toString() === 'v10');
    } finally { database.close(); }
    stage = 'production_import';
    const { listProfiles, listDomains } = await import('../../browse/src/cookie-import-browser');
    check('dia_profile_and_domain_discovered', listProfiles('Dia').some(profile => profile.name === 'Default')
      && listDomains('Dia', 'Default').domains.some(entry => entry.domain === '127.0.0.1' && entry.count >= 1));
    launchAttempts++;
    destination = await within(() => chromium.launchPersistentContext(destinationProfile, nativeDiaLaunchOptions(destinationExecutable, fixtureEnvironment)), 40_000);
    if (observer.children.filter(child => child.executable === destinationExecutable).length !== 1) throw new Error('destination_process_ownership_unconfirmed');
    const target = destination.pages()[0] ?? await within(() => destination!.newPage(), 10_000);
    await within(() => target.goto(origin + '/protected', { waitUntil: 'domcontentloaded', timeout: 10_000 }), 10_000);
    await within(() => target.evaluate(() => { localStorage.setItem('fixture-local', 'preserved'); sessionStorage.setItem('fixture-session', 'preserved'); }), 10_000);
    const { runCookieImport } = await import('../../browse/src/cookie-import-operation');
    const tracked: string[] = [];
    const imported = await within(() => runCookieImport({ browser: 'Dia', profile: 'Default', domains: ['127.0.0.1'], verifyAuth: true },
      { page: target, url: target.url() }, domains => tracked.push(...domains), { identitySelector: '#fixture-identity', expectedIdentity: identity }), 30_000);
    check('native_keychain_decryption_and_verified_import', imported.imported >= 1 && imported.failed === 0 && imported.verification.verified && tracked.includes('127.0.0.1'));
    receipt.coverage.nativeKeychainRead = true;
    check('default_storage_preserved', await within(() => target.evaluate(() => localStorage.getItem('fixture-local') === 'preserved' && sessionStorage.getItem('fixture-session') === 'preserved'), 10_000));
    const wrong = await within(() => runCookieImport({ browser: 'Dia', profile: 'Default', domains: ['127.0.0.1'], verifyAuth: true },
      { page: target, url: target.url() }, () => {}, { identitySelector: '#fixture-identity', expectedIdentity: 'Different synthetic account', timeoutMs: 500 }), 15_000);
    check('wrong_identity_not_verified', !wrong.verification.verified && wrong.verification.reason === 'identity_mismatch');
    const reset = await within(() => runCookieImport({ browser: 'Dia', profile: 'Default', domains: ['127.0.0.1'], clearStorage: true, verifyAuth: true },
      { page: target, url: target.url() }, () => {}, { identitySelector: '#fixture-identity', expectedIdentity: identity }), 30_000);
    check('explicit_storage_reset', reset.reset === 'cleared' && reset.verification.verified
      && await within(() => target.evaluate(() => localStorage.getItem('fixture-local') === null && sessionStorage.getItem('fixture-session') === null), 10_000));
    for (const file of sourceFiles) if (await within(() => sha256(path.join(repository, file)), 5_000) !== receipt.sourceHashes[file]) throw new Error('source_changed_during_qualification');
    if (await within(() => sha256(executable), 10_000) !== receipt.artifact.executableSha256) throw new Error('source_app_changed_during_qualification');
    receipt.status = 'passed';
    receipt.reason = 'native_dia_synthetic_profile_verified';
  } catch (error) {
    receipt.reason = stage;
    receipt.failureStage = stage;
    if (error instanceof Error && error.message === 'onboarding_or_external_page') receipt.blocker = 'onboarding_or_unexpected_startup_page';
    if (error instanceof Error && error.message === 'preexisting_browser_state_refused') receipt.blocker = 'preexisting_browser_state_refused';
    const code = (error as { code?: string } | null)?.code;
    if (code && ['keychain_timeout', 'keychain_denied', 'keychain_not_found', 'keychain_error', 'db_read_error', 'db_corrupt', 'target_changed', 'target_mismatch'].includes(code)) receipt.blocker = code;
    receipt.status = Object.values(receipt.cases).includes('failed') ? 'failed' : 'incomplete';
  } finally {
    cleaning = true;
    cleanupDeadline = performance.now() + 45_000;
    observer?.stop();
    for (const context of [source, destination]) if (context) await bounded(context.close().catch(() => {}), 5_000).catch(() => {});
    let stopped = !observer || observer.children.length >= launchAttempts;
    for (const child of observer?.children ?? []) {
      try {
        try { process.kill(-child.pid, 0); process.kill(-child.pid, 'SIGKILL'); }
        catch (error: any) { if (error.code !== 'ESRCH') throw error; }
        const until = Math.min(cleanupDeadline, performance.now() + 5_000);
        while (true) {
          try { process.kill(-child.pid, 0); }
          catch (error: any) { if (error.code === 'ESRCH') break; throw error; }
          if (performance.now() >= until) throw new Error('owned_process_group_still_live');
          await Bun.sleep(50);
        }
      } catch { stopped = false; }
    }
    receipt.cleanup.ownedBrowsersStopped = stopped;
    receipt.observedBrowserRoots = observer?.children.length ?? 0;
    server?.stop(true);
    if (stopped) {
      try {
        if (keychainChanged) {
          let restored = true;
          for (const args of fixtureKeychainRestoreCommands({ search: originalSearch, default: originalDefault }, keychain, keychainCreated)) {
            try { run('/usr/bin/security', args); } catch { restored = false; }
          }
          if (!restored) throw new Error('keychain_restore_failed');
          const restoredSnapshot = captureUserKeychains(systemEnvironment, [systemEnvironment.HOME, root], cleanupDeadline - performance.now());
          if (JSON.stringify(restoredSnapshot.search) !== JSON.stringify(originalSearch)
            || JSON.stringify(restoredSnapshot.default) !== JSON.stringify(originalDefault)) throw new Error('keychain_restore_failed');
        }
        receipt.cleanup.keychainRestored = true;
      } catch {}
    }
    try {
      if (mounted) run('/usr/bin/hdiutil', ['detach', mount], 10_000);
      receipt.cleanup.mountDetached = true;
    } catch {}
    if (stopped && receipt.cleanup.keychainRestored && receipt.cleanup.mountDetached) {
      try {
        if (realpathSync(root) !== root || path.dirname(root) !== runnerTemp) throw new Error('fixture_root_changed');
        rmSync(root, { recursive: true, force: true });
        receipt.cleanup.fixtureRemoved = true;
      } catch {}
    }
    if (Object.values(receipt.cleanup).some(value => value !== true)) { receipt.status = 'failed'; receipt.reason = 'cleanup_incomplete'; }
    receipt.counts = { pass: Object.values(receipt.cases).filter(value => value === 'passed').length,
      fail: Object.values(receipt.cases).filter(value => value === 'failed').length, skip: 0 };
    writeFileSync(output, JSON.stringify(receipt, null, 2) + '\n', { mode: 0o600, flag: 'wx' });
  }
  return receipt;
}

if (import.meta.main) {
  try {
    if (process.argv[2] === '--isolated-worker') {
      const receipt = await qualifyDia({ root: process.argv[3], originalHome: process.argv[4], destinationExecutable: process.argv[5] });
      console.log(JSON.stringify({ status: receipt.status, reason: receipt.reason, counts: receipt.counts, artifact: 'dia-native-qualification.json' }));
      process.exitCode = receipt.status === 'passed' ? 0 : 2;
    } else {
      validateQualificationHost(process.env);
      if (Bun.version !== '1.4.0' || require('playwright/package.json').version !== '1.62.1') throw new Error('pinned_runtimes_required');
      const originalHome = realpathSync(homedir());
      const originalHomeEnvironment = process.env.HOME;
      const { chromium } = await import('playwright');
      const destinationExecutable = realpathSync(process.env.GSTACK_DIA_DESTINATION_EXECUTABLE || chromium.executablePath());
      const runnerTemp = realpathSync(process.env.RUNNER_TEMP!);
      const output = path.join(runnerTemp, 'dia-native-qualification.json');
      if (existsSync(output)) throw new Error('fresh_receipt_path_required');
      const root = realpathSync(mkdtempSync(path.join(runnerTemp, 'dia-')));
      chmodSync(root, 0o700);
      const home = path.join(root, 'h');
      const temporary = path.join(root, 't');
      mkdirSync(home, { mode: 0o700 });
      mkdirSync(temporary, { mode: 0o700 });
      const metadata = Object.fromEntries(['CI', 'GITHUB_ACTIONS', 'RUNNER_ENVIRONMENT', 'RUNNER_OS', 'RUNNER_ARCH', 'RUNNER_TEMP',
        'GITHUB_RUN_ID', 'GITHUB_RUN_ATTEMPT', 'GSTACK_DIA_NATIVE_QUALIFY', 'GSTACK_DIA_EXPECT_UID', 'GSTACK_DIA_SOURCE_REVISION']
        .filter(name => process.env[name] !== undefined).map(name => [name, process.env[name]!]));
      const child = spawnSync(process.execPath, ['--no-env-file', '--no-install', '--no-macros', '--config=/dev/null', import.meta.path,
        '--isolated-worker', root, originalHome, destinationExecutable], {
        cwd: repository, env: { ...metadata, HOME: home, TMPDIR: temporary, PATH: '/usr/bin:/bin:/usr/sbin:/sbin', LANG: 'en_US.UTF-8' },
        encoding: 'utf8', timeout: 630_000, killSignal: 'SIGKILL', maxBuffer: 1024 * 1024,
      });
      if (realpathSync(homedir()) !== originalHome || process.env.HOME !== originalHomeEnvironment
        || child.error || ![0, 2].includes(child.status ?? -1) || !existsSync(output)) {
        let receipt: Record<string, any> = { counts: { pass: 0, fail: 0, skip: 0 }, cleanup: { confirmed: false } };
        if (existsSync(output)) {
          if (!lstatSync(output).isFile() || realpathSync(output) !== output || lstatSync(output).size > 1024 * 1024) throw new Error('invalid_worker_receipt');
          try { receipt = JSON.parse(readFileSync(output, 'utf8')); } catch {}
        }
        receipt.status = 'incomplete';
        receipt.reason = 'qualification_worker_did_not_complete';
        receipt.runId = process.env.GITHUB_RUN_ID;
        receipt.runAttempt = process.env.GITHUB_RUN_ATTEMPT;
        receipt.supervisor = { completed: false, exitCode: child.status };
        receipt.recovery = 'Discard this disposable runner; do not reuse its Keychain or staged profile.';
        writeFileSync(output, JSON.stringify(receipt, null, 2) + '\n', { mode: 0o600, flag: existsSync(output) ? 'w' : 'wx' });
        console.log(JSON.stringify({ status: 'incomplete', reason: 'qualification_worker_did_not_complete', artifact: 'dia-native-qualification.json' }));
        process.exitCode = 2;
      } else {
        const summary = JSON.parse(child.stdout);
        console.log(JSON.stringify({ status: summary.status, reason: summary.reason, counts: summary.counts, artifact: 'dia-native-qualification.json' }));
        process.exitCode = child.status === 0 && summary.status === 'passed' && summary.counts?.pass === 8 && summary.counts?.fail === 0 && summary.counts?.skip === 0 ? 0 : 2;
      }
    }
  } catch {
    console.log(JSON.stringify({ status: 'incomplete', reason: 'qualification_preflight_failed', counts: { pass: 0, fail: 0, skip: 0 } }));
    process.exitCode = 2;
  }
}
