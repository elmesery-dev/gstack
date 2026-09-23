import { afterAll, describe, expect, spyOn, test } from 'bun:test';
import { createRequire } from 'node:module';
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, linkSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { Database } from 'bun:sqlite';
import {
  allowedFixturePage, assertDiaSocketPath, assertOwnedDiaProfile, browserPreflightError, browserStartupCategory, captureUserKeychains, createOwnedDiaProfile, DIA_DOWNLOAD, fixtureKeychainRestoreCommands, nativeDiaLaunchOptions, observeBrowserLaunches,
  observeDiaKeychainEnvironments, observeFixtureKeychain, parseDefaultKeychain, parseKeychainPaths, playwrightModuleLoadFacts, prepareKeychainHome,
  qualifyDia, readFreshAccountConfiguration, removeOwnedDiaProfile, validateQualificationHost, writePrivateReceipt,
} from '../../.github/scripts/qualify-dia-macos';
import { ARCHIVE_CHECK, FRESH_WORK_PREFIX, PRIVATE_RECEIPT_READ, classifyParentDomain, classifyUserDomain, freshLaunchDefinition, freshQualificationPassed,
  inspectParentDomain, inspectUidProcesses, inspectUserDomain,
  ownedUserDomainTarget, ownsFreshAccount, ownsLaunchService, parseDirectoryIds, parseDirectoryRecord, passiveUserDomainState,
  runFreshAccountQualification, uidProcessFacts } from '../../.github/scripts/run-dia-native-qualification';

const require = createRequire(import.meta.url);
const root = mkdtempSync(path.join(tmpdir(), 'dia-qualification-test-'));
const script = path.resolve(import.meta.dir, '../../.github/scripts/qualify-dia-macos.ts');
const nativeEnvironment = {
  CI: 'true', GITHUB_ACTIONS: 'true', RUNNER_ENVIRONMENT: 'github-hosted', RUNNER_OS: 'macOS', RUNNER_ARCH: 'ARM64',
  GSTACK_DIA_NATIVE_QUALIFY: '1', RUNNER_TEMP: root, GITHUB_RUN_ID: 'fixture-run', GITHUB_RUN_ATTEMPT: '1',
};

afterAll(() => rmSync(root, { recursive: true, force: true }));

describe('Dia macOS CI qualification safety', () => {
  test('admission accepts only the explicitly enabled disposable ARM64 Mac combination', () => {
    expect(() => validateQualificationHost(nativeEnvironment, 'darwin', 'arm64')).not.toThrow();
    for (const [platform, architecture] of [['linux', 'arm64'], ['win32', 'arm64'], ['darwin', 'x64']]) {
      expect(() => validateQualificationHost(nativeEnvironment, platform as any, architecture as any)).toThrow('disposable_arm64_macos_ci_required');
    }
    expect(readdirSync(root)).toEqual([]);
  });

  for (const name of Object.keys(nativeEnvironment)) {
    test(`requires admission field ${name} before any native work`, () => {
      const env: NodeJS.ProcessEnv = { ...nativeEnvironment };
      delete env[name];
      expect(() => validateQualificationHost(env, 'darwin', 'arm64')).toThrow('disposable_arm64_macos_ci_required');
      expect(readdirSync(root)).toEqual([]);
    });
  }

  test('rejects a self-hosted machine even when the OS and opt-in match', () => {
    expect(() => validateQualificationHost({ ...nativeEnvironment, RUNNER_ENVIRONMENT: 'self-hosted' }, 'darwin', 'arm64'))
      .toThrow('disposable_arm64_macos_ci_required');
  });

  test('the actual launcher refuses an unapproved environment without staging files', () => {
    const nativeTemp = mkdtempSync(path.join(root, 'runner-temp-'));
    const result = spawnSync(process.execPath, ['--no-env-file', '--no-install', '--no-macros', `--config=${process.platform === 'win32' ? 'NUL' : '/dev/null'}`, script], {
      cwd: root, env: { PATH: path.dirname(process.execPath), HOME: root, RUNNER_TEMP: nativeTemp,
        ...(process.env.SystemRoot ? { SystemRoot: process.env.SystemRoot } : {}) },
      encoding: 'utf8', timeout: 10_000,
    });
    expect(result.status).toBe(2);
    expect(result.stderr).toBe('');
    expect(JSON.parse(result.stdout)).toEqual({ status: 'incomplete', reason: 'qualification_preflight_failed', counts: { pass: 0, fail: 0, skip: 0 } });
    expect(readdirSync(nativeTemp)).toEqual([]);
  });

  test('a fresh fixture-HOME child uses unmodified production Dia profile and domain discovery', () => {
    const home = realpathSync(mkdtempSync(path.join(root, 'fixture-home-')));
    const ownership = createOwnedDiaProfile(home);
    const profile = path.join(ownership.profile, 'Default');
    mkdirSync(profile, { recursive: true });
    const database = new Database(path.join(profile, 'Cookies'));
    database.run('CREATE TABLE cookies (host_key TEXT, has_expires INTEGER, expires_utc INTEGER)');
    database.query('INSERT INTO cookies VALUES (?, ?, ?)').run('.fixture.test', 0, 0);
    database.close();
    const production = pathToFileURL(path.resolve(import.meta.dir, '../src/cookie-import-browser.ts')).href;
    const result = spawnSync(process.execPath, ['--no-env-file', '--no-install', '--no-macros', `--config=${process.platform === 'win32' ? 'NUL' : '/dev/null'}`, '-e', `
      import { homedir } from 'node:os';
      const { listProfiles, listDomains } = await import(${JSON.stringify(production)});
      console.log(JSON.stringify({ homeAtStartup: homedir() === process.env.HOME,
        profiles: listProfiles('Dia').map(profile => profile.name), domains: listDomains('Dia', 'Default').domains }));
    `], {
      cwd: root, env: { PATH: path.dirname(process.execPath), HOME: home, USERPROFILE: home,
        ...(process.env.SystemRoot ? { SystemRoot: process.env.SystemRoot } : {}) },
      encoding: 'utf8', timeout: 10_000,
    });
    expect(result.status).toBe(0);
    expect(result.stderr).toBe('');
    expect(JSON.parse(result.stdout)).toEqual({ homeAtStartup: true, profiles: ['Default'], domains: [{ domain: '.fixture.test', count: 1 }] });
    expect(() => assertOwnedDiaProfile(ownership)).not.toThrow();
    removeOwnedDiaProfile(ownership, true);
    expect(existsSync(home)).toBe(true);
  });

  for (const precreate of [false, true]) {
    test(`late-installed real Playwright loads only with its dependency directory present at startup (${precreate})`, () => {
      const fixture = realpathSync(mkdtempSync(path.join(root, 'late-playwright-')));
      const home = path.join(fixture, 'home');
      const scripts = path.join(fixture, '.github/scripts');
      const modules = path.join(fixture, 'node_modules');
      mkdirSync(home);
      mkdirSync(scripts, { recursive: true });
      if (precreate) mkdirSync(modules, { mode: 0o700 });
      writeFileSync(path.join(fixture, 'package.json'), JSON.stringify({ type: 'module', dependencies: { playwright: '1.62.1' } }));
      const sourceModules = path.resolve(import.meta.dir, '../../node_modules');
      const worker = path.join(scripts, 'worker.ts');
      writeFileSync(worker, `
        import { cpSync, mkdirSync } from 'node:fs';
        import { createRequire } from 'node:module';
        const require = createRequire(import.meta.url);
        mkdirSync(${JSON.stringify(modules)}, { recursive: true });
        for (const name of ['playwright', 'playwright-core']) cpSync(${JSON.stringify(sourceModules)} + '/' + name, ${JSON.stringify(modules)} + '/' + name, { recursive: true });
        const version = require(${JSON.stringify(path.join(modules, 'playwright/package.json'))}).version;
        try {
          const loaded = await import('playwright');
          console.log(JSON.stringify({ version, loaded: !!loaded.chromium }));
        } catch (error) {
          console.log(JSON.stringify({ version, type: error.name, code: error.code }));
          process.exitCode = 2;
        }
      `);
      const result = spawnSync(process.execPath, ['--no-env-file', '--no-install', '--no-macros',
        `--config=${process.platform === 'win32' ? 'NUL' : '/dev/null'}`, worker], {
        cwd: fixture, env: { HOME: home, PATH: path.dirname(process.execPath) }, encoding: 'utf8', timeout: 30_000,
      });
      expect(result.stderr).toBe('');
      expect(result.status).toBe(precreate ? 0 : 2);
      expect(JSON.parse(result.stdout)).toEqual(precreate ? { version: '1.62.1', loaded: true }
        : { version: '1.62.1', type: 'ResolveMessage', code: 'ERR_MODULE_NOT_FOUND' });
    });
  }

  test('the download is the published HTTPS Dia release endpoint', () => {
    expect(DIA_DOWNLOAD).toBe('https://releases.diabrowser.com/release/Dia-latest.dmg');
  });

  test('the exact nested macOS account and qualifier socket layout stays below the unchanged limit', () => {
    const sourceProfile = path.posix.join(FRESH_WORK_PREFIX + 'XXXXXX', 'tmp', 'dia-XXXXXX', 'h', 'Library/Application Support/Dia/User Data');
    expect(Buffer.byteLength(sourceProfile + '/SingletonSocket')).toBe(97);
    expect(() => assertDiaSocketPath(sourceProfile)).not.toThrow();
    const oldProfile = '/private/tmp/dia-native-XXXXXX/tmp/dia-XXXXXX/h/Library/Application Support/Dia/User Data';
    expect(Buffer.byteLength(oldProfile + '/SingletonSocket')).toBe(105);
    expect(() => assertDiaSocketPath(oldProfile)).toThrow('fixture_socket_path_too_long');
    const atLimit = '/' + 'x'.repeat(100 - Buffer.byteLength('//SingletonSocket'));
    expect(Buffer.byteLength(atLimit + '/SingletonSocket')).toBe(100);
    expect(() => assertDiaSocketPath(atLimit)).toThrow('fixture_socket_path_too_long');
  });

  test('the registered-home source profile fits the socket bound without a shadow HOME', () => {
    const profile = path.posix.join(FRESH_WORK_PREFIX + 'XXXXXX', 'home', 'Library/Application Support/Dia/User Data');
    expect(Buffer.byteLength(profile + '/SingletonSocket')).toBe(85);
    expect(() => assertDiaSocketPath(profile)).not.toThrow();
    const implementation = qualifyDia.toString();
    expect(implementation).toContain('readFreshAccountConfiguration');
    expect(implementation).toContain('const home = account.home');
    expect(implementation).not.toMatch(/fixtureEnvironment|systemEnvironment|isolation\.originalHome/);
    expect(implementation).toContain('removeOwnedDiaProfile');
  });

  test('profile ownership is exclusive and cleanup preserves the account home and sibling state', () => {
    const home = realpathSync(mkdtempSync(path.join(root, 'owned-profile-home-')));
    prepareKeychainHome(home);
    const preserved = path.join(home, 'Library/Keychains/fixture-state');
    writeFileSync(preserved, 'preserved fixture state');
    const ownership = createOwnedDiaProfile(home);
    const sibling = path.join(path.dirname(ownership.profile), 'sibling-state');
    writeFileSync(sibling, 'preserved sibling state');
    expect(() => assertOwnedDiaProfile(ownership)).not.toThrow();
    expect(() => createOwnedDiaProfile(home)).toThrow();
    expect(() => removeOwnedDiaProfile(ownership, false)).toThrow('owned_browsers_not_stopped');
    expect(existsSync(ownership.profile)).toBe(true);
    removeOwnedDiaProfile(ownership, true);
    expect(existsSync(ownership.profile)).toBe(false);
    expect(existsSync(home)).toBe(true);
    expect(readFileSync(preserved, 'utf8')).toBe('preserved fixture state');
    expect(readFileSync(sibling, 'utf8')).toBe('preserved sibling state');
  });

  for (const change of ['nonce', 'inode', 'marker_symlink', 'profile_symlink', 'uid', 'home_escape', 'marker_permissions', 'marker_hardlink']) {
    test(`profile cleanup refuses changed ${change} ownership without deleting the directory`, () => {
      const home = realpathSync(mkdtempSync(path.join(root, 'profile-refusal-')));
      const ownership = createOwnedDiaProfile(home);
      const profile = ownership.profile;
      const marker = path.join(profile, '.gstack-dia-owner');
      if (change === 'nonce') writeFileSync(marker, (ownership.nonce[0] === '0' ? '1' : '0') + ownership.nonce.slice(1));
      if (change === 'inode') {
        renameSync(profile, profile + '.original');
        mkdirSync(profile, { mode: 0o700 });
        writeFileSync(marker, ownership.nonce, { mode: 0o600 });
      }
      if (change === 'marker_symlink') { renameSync(marker, marker + '.original'); symlinkSync(marker + '.original', marker); }
      if (change === 'profile_symlink') { renameSync(profile, profile + '.original'); symlinkSync(profile + '.original', profile, 'dir'); }
      if (change === 'uid') ownership.uid = process.getuid!() + 1;
      if (change === 'home_escape') ownership.profile = home;
      if (change === 'marker_permissions') chmodSync(marker, 0o644);
      if (change === 'marker_hardlink') linkSync(marker, path.join(home, 'marker-link'));
      expect(() => removeOwnedDiaProfile(ownership, true)).toThrow();
      expect(existsSync(profile)).toBe(true);
      expect(existsSync(home)).toBe(true);
    });
  }

  test('source profile creation refuses existing profiles and linked ancestors without writing through them', () => {
    const home = realpathSync(mkdtempSync(path.join(root, 'existing-profile-')));
    const profile = path.join(home, 'Library/Application Support/Dia/User Data');
    mkdirSync(profile, { recursive: true });
    writeFileSync(path.join(profile, 'existing-state'), 'untouched');
    expect(() => createOwnedDiaProfile(home)).toThrow();
    expect(readdirSync(profile)).toEqual(['existing-state']);
    const linkedHome = realpathSync(mkdtempSync(path.join(root, 'linked-profile-home-')));
    const elsewhere = realpathSync(mkdtempSync(path.join(root, 'linked-profile-target-')));
    symlinkSync(elsewhere, path.join(linkedHome, 'Library'), 'dir');
    expect(() => createOwnedDiaProfile(linkedHome)).toThrow('unsafe_profile_ancestor');
    expect(readdirSync(elsewhere)).toEqual([]);
  });

  test('the qualifier rejects an arbitrary caller-supplied home as fresh account authority', () => {
    const fake = path.join(root, 'account.json');
    writeFileSync(fake, JSON.stringify({ home: root, uid: process.getuid?.() }));
    expect(() => readFreshAccountConfiguration(fake)).toThrow('unsafe_fresh_account_configuration');
    expect(() => readFreshAccountConfiguration('account.json')).toThrow('unsafe_fresh_account_configuration');
  });

  test('headless source launch removes mock Keychain and first-run suppression defaults', () => {
    const env = { HOME: '/fixture/home', PATH: '/usr/bin:/bin' };
    const options = nativeDiaLaunchOptions('/fixture/Dia.app/Contents/MacOS/Dia', env);
    expect(options.headless).toBe(true);
    expect(options.timeout).toBe(30_000);
    expect(options.ignoreDefaultArgs).toEqual(['--use-mock-keychain', '--password-store=basic', '--no-first-run']);
    expect(options.args).toEqual(['--disable-sync', '--no-default-browser-check', '--profile-directory=Default']);
    expect(options.env).toBe(env);
    expect(options.serviceWorkers).toBe('block');
    expect(options.args.some(arg => /onboarding|skip-login|remote-debugging-port/.test(arg))).toBe(false);
  });

  test('startup admits only blank pages or the exact synthetic loopback origin', () => {
    const origin = 'http://127.0.0.1:8123';
    expect(allowedFixturePage('about:blank', origin)).toBe(true);
    expect(allowedFixturePage(origin + '/seed', origin)).toBe(true);
    for (const url of ['https://www.diabrowser.com/login', 'dia://onboarding', 'chrome://welcome', 'http://localhost:8123/seed',
      'http://127.0.0.1:8124/seed', 'javascript:alert(1)', 'about:config', 'invalid']) expect(allowedFixturePage(url, origin)).toBe(false);
    const authenticated = new URL(origin);
    authenticated.username = 'fixture-user';
    authenticated.password = 'fixture';
    expect(allowedFixturePage(authenticated.href, origin)).toBe(false);
  });

  test('startup diagnostics classify pages without exposing URLs or broadening admission', () => {
    const pages = [
      ['about:blank', 'blank'], ['about:blank#synthetic-private-value', 'other_about'],
      ['chrome://newtab/?token=synthetic-private-value', 'chromium_new_tab'],
      ['chrome://new-tab-page/', 'chromium_new_tab'], ['chrome://intro/', 'chromium_onboarding'],
      ['chrome://welcome/', 'chromium_onboarding'], ['chrome://settings/', 'chromium_internal'],
      ['dia://onboarding', 'dia_internal'], ['chrome-extension://fixture/path', 'extension'],
      ['https://fixture.invalid/login?token=synthetic-private-value', 'external_web'],
      ['http://127.0.0.1:8123' + '/fixture', 'loopback_web'], ['file:///synthetic-private-value', 'file'],
      ['data:text/html,synthetic-private-value', 'data'], ['invalid synthetic-private-value', 'invalid'],
    ];
    const categories = pages.map(([url]) => browserStartupCategory(url));
    expect(categories).toEqual(pages.map(([, category]) => category));
    expect(JSON.stringify(categories)).not.toContain('synthetic-private-value');
    expect(JSON.stringify(categories)).not.toContain('fixture.invalid');
    for (const [url] of pages.slice(1, 10)) expect(allowedFixturePage(url, 'http://127.0.0.1:8123')).toBe(false);
  });

  for (const [error, category] of [
    [new Error('browserType.launchPersistentContext: browser_launch_policy_rejected synthetic-private-value'), 'launch_policy_rejected'],
    [new Error('background_browser_ownership_failed'), 'ownership_unconfirmed'],
    [new Error('background_browser_startup_page_rejected'), 'startup_page_rejected'],
    [new Error('background_browser_render_failed'), 'render_mismatch'],
    [Object.assign(new Error('synthetic-private-value'), { name: 'TimeoutError' }), 'operation_timeout'],
    [new Error('native_operation_timed_out'), 'operation_timeout'],
    [Object.assign(new Error('synthetic-private-value'), { code: 'ENOENT' }), 'executable_unavailable'],
    [Object.assign(new Error('synthetic-private-value'), { code: 'EACCES' }), 'permission_denied'],
    [{ name: 'ResolveMessage', code: 'ERR_MODULE_NOT_FOUND', message: 'synthetic-private-value' }, 'module_unavailable'],
    [Object.assign(new Error('synthetic-private-value'), { code: 'MODULE_NOT_FOUND' }), 'module_unavailable'],
    [Object.assign(new Error('synthetic-private-value'), { code: 'ERR_PACKAGE_PATH_NOT_EXPORTED' }), 'module_export_unavailable'],
    [Object.assign(new Error('synthetic-private-value'), { code: 'ERR_REQUIRE_ESM' }), 'module_format_error'],
    [new RangeError('synthetic-private-value'), 'invalid_runtime_range'],
    [new TypeError('synthetic-private-value'), 'runtime_type_error'],
    [new Error('dyld[123]: Library not loaded: synthetic-private-value'), 'dynamic_library_error'],
    [new Error('code signature invalid: synthetic-private-value'), 'code_signing_error'],
    [new Error('ProcessSingleton synthetic-private-value'), 'browser_profile_unavailable'],
    [new Error('bootstrap_check_in failed synthetic-private-value'), 'graphics_or_bootstrap_error'],
    [new Error('Target page, context or browser has been closed synthetic-private-value'), 'target_closed'],
    [new Error('Protocol error: synthetic-private-value'), 'protocol_error'],
    [new Error('synthetic-private-value'), 'unclassified_browser_error'],
    [{ code: 'synthetic-private-value', message: 'synthetic-private-value' }, 'unclassified_browser_error'],
  ] as const) {
    test(`browser diagnostics return only the allowlisted ${category} category`, () => {
      expect(browserPreflightError(error)).toBe(category);
      expect(browserPreflightError(error)).not.toContain('synthetic-private-value');
    });
  }

  test('module-load facts retain only known error identifiers and known dependency filenames', () => {
    const snapshot = realpathSync(mkdtempSync(path.join(root, 'module-facts-')));
    const packageDirectory = path.join(snapshot, 'node_modules/playwright');
    mkdirSync(packageDirectory, { recursive: true });
    writeFileSync(path.join(packageDirectory, 'package.json'), '{}', { mode: 0o600 });
    const facts = playwrightModuleLoadFacts(snapshot, { name: 'ResolveMessage', code: 'ERR_MODULE_NOT_FOUND',
      message: "Cannot find package 'playwright' imported from /synthetic-private-value/worker.ts" });
    expect(facts.errorType).toBe('ResolveMessage');
    expect(facts.errorCode).toBe('ERR_MODULE_NOT_FOUND');
    expect(facts.requestedModule).toBe('playwright');
    expect(facts.files['playwright/package.json']).toEqual({ exists: true, readable: true, ownedByCurrentUid: true, insideSnapshot: true });
    expect(facts.files['playwright-core/lib/coreBundle.js'].exists).toBe(false);
    expect(JSON.stringify(facts)).not.toContain('synthetic-private-value');
    expect(JSON.stringify(facts)).not.toContain(snapshot);
    const unknown = playwrightModuleLoadFacts(snapshot, { name: 'synthetic-private-value', code: 'synthetic-private-value', message: "Cannot find package 'synthetic-private-value'" });
    expect(unknown.errorType).toBe('unclassified');
    expect(unknown.errorCode).toBe('unclassified');
    expect(unknown.requestedModule).toBe('unclassified');
    expect(JSON.stringify(unknown)).not.toContain('synthetic-private-value');
  });

  test('Keychain snapshots preserve exact quoted paths without shell parsing', () => {
    expect(parseKeychainPaths('    "/Users/runner/Library/Keychains/login.keychain-db"\n    "/tmp/fixture keychain.keychain-db"\n'))
      .toEqual(['/Users/runner/Library/Keychains/login.keychain-db', '/tmp/fixture keychain.keychain-db']);
    for (const output of ['', 'not-json', '"relative-path"', '42', '"/valid/path"\ninvalid']) {
      expect(() => parseKeychainPaths(output)).toThrow();
    }
  });

  test('fresh users can have an empty user search list and no default Keychain', () => {
    const calls: string[][] = [];
    const snapshot = captureUserKeychains({ HOME: root }, [root], 1000, (args, timeout) => {
      calls.push(args);
      expect(timeout).toBeGreaterThan(0);
      expect(timeout).toBeLessThanOrEqual(1000);
      return args[0] === 'list-keychains' ? { status: 0, stdout: '', stderr: '' }
        : { status: 1, stdout: '', stderr: 'security: SecKeychainCopyDomainDefault user: A default keychain could not be found.\n' };
    });
    expect(snapshot).toEqual({ search: [], default: [] });
    expect(calls).toEqual([['list-keychains', '-d', 'user'], ['default-keychain', '-d', 'user']]);
  });

  test('computed Keychain timeouts reach real spawnSync as bounded integer milliseconds', () => {
    let reads = 0;
    const times = [0.125, 0.5, 5.75];
    const clock = spyOn(performance, 'now').mockImplementation(() => times[Math.min(reads++, times.length - 1)]);
    const timeouts: number[] = [];
    const calls: string[][] = [];
    try {
      const snapshot = captureUserKeychains({ HOME: root }, [root], 10_000, (args, timeout) => {
        const result = spawnSync(process.execPath, ['--no-env-file', '--no-install', '--no-macros',
          `--config=${process.platform === 'win32' ? 'NUL' : '/dev/null'}`, '-e', 'process.exit(0)'], {
          cwd: root, env: { HOME: root, PATH: path.dirname(process.execPath) }, encoding: 'utf8', timeout,
        });
        expect(result.status).toBe(0);
        expect(result.error).toBeUndefined();
        timeouts.push(timeout);
        calls.push(args);
        return result;
      });
      expect(snapshot).toEqual({ search: [], default: [] });
      expect(timeouts).toEqual([9999, 9994]);
      expect(calls).toEqual([['list-keychains', '-d', 'user'], ['default-keychain', '-d', 'user']]);
    } finally {
      clock.mockRestore();
    }
  });

  test('an expired or sub-millisecond Keychain budget never becomes an unbounded subprocess', () => {
    const clock = spyOn(performance, 'now').mockReturnValue(100);
    let commands = 0;
    try {
      for (const budget of [0.75, 0, -1, NaN, Infinity]) {
        expect(() => captureUserKeychains({ HOME: root }, [root], budget, () => {
          commands++;
          return { status: 0, stdout: '', stderr: '' };
        })).toThrow('user_keychain_probe_timeout');
      }
      expect(commands).toBe(0);
    } finally {
      clock.mockRestore();
    }
  });

  test('permission, securityd, and transport errors are never mistaken for no default Keychain', () => {
    for (const result of [
      { status: 1, stdout: '', stderr: 'security: SecKeychainCopyDefault: User interaction is not allowed.' },
      { status: 1, stdout: '', stderr: 'security: SecKeychainCopyDomainDefault system: A default keychain could not be found.' },
      { status: 1, stdout: '', stderr: 'synthetic-private-error' },
      { status: 0, stdout: '', stderr: 'synthetic-private-error' },
      { status: 1, stdout: 'unexpected-data', stderr: 'security: SecKeychainCopyDefault: A default keychain could not be found.' },
      { status: null, stdout: '', stderr: '', error: new Error('synthetic-private-error') },
    ]) expect(() => parseDefaultKeychain(result)).toThrow('user_default_keychain_unavailable');
    expect(parseDefaultKeychain({ status: 0, stdout: '', stderr: '' })).toEqual([]);
    expect(parseDefaultKeychain({ status: 1, stdout: '', stderr: 'security: SecKeychainCopyDefault: A default keychain could not be found.' })).toEqual([]);
  });

  test('the snapshot boundary rejects System Keychain fallback and paths outside the owned home', () => {
    for (const file of ['/Library/Keychains/System.keychain', '/System/Library/Keychains/SystemRootCertificates.keychain', '/unowned/keychain']) {
      expect(() => captureUserKeychains({ HOME: root }, [root], 1000, args => ({ status: 0,
        stdout: args[0] === 'list-keychains' ? JSON.stringify(file) : '', stderr: '' })))
        .toThrow('keychain_outside_owned_home_refused');
    }
  });

  test('a fresh Keychain home gains only owned standard directories, not a fabricated preference file', () => {
    const home = realpathSync(mkdtempSync(path.join(root, 'keychain-home-')));
    expect(prepareKeychainHome(home)).toEqual({ before: { Library: false, 'Library/Preferences': false, 'Library/Keychains': false }, directoriesReady: true });
    for (const directory of ['Library', 'Library/Preferences', 'Library/Keychains']) {
      expect(lstatSync(path.join(home, directory)).uid).toBe(process.getuid!());
      expect(lstatSync(path.join(home, directory)).isDirectory()).toBe(true);
    }
    const preferences = path.join(home, 'Library/Preferences/com.apple.security.plist');
    expect(existsSync(preferences)).toBe(false);
    expect(existsSync(path.join(home, 'Library/Safari'))).toBe(false);
    writeFileSync(preferences, 'opaque fixture preferences', { mode: 0o600 });
    expect(prepareKeychainHome(home).before).toEqual({ Library: true, 'Library/Preferences': true, 'Library/Keychains': true });
    expect(readFileSync(preferences, 'utf8')).toBe('opaque fixture preferences');
  });

  test('home preparation rejects a linked or unowned home without writing through it', () => {
    const home = realpathSync(mkdtempSync(path.join(root, 'linked-home-')));
    const elsewhere = realpathSync(mkdtempSync(path.join(root, 'other-home-')));
    symlinkSync(elsewhere, path.join(home, 'Library'), 'dir');
    expect(() => prepareKeychainHome(home)).toThrow('keychain_home_unsafe');
    expect(readdirSync(elsewhere)).toEqual([]);
    expect(() => prepareKeychainHome(elsewhere, process.getuid!() + 1)).toThrow('keychain_home_unsafe');
    expect(readdirSync(elsewhere)).toEqual([]);
  });

  for (const mismatch of ['search-empty', 'default-empty', 'search-path', 'default-path', 'search-error', 'default-error', 'read-mismatch', 'read-error']) {
    test(`Keychain diagnostics observe the explicit read independently of ${mismatch}`, () => {
      const directory = realpathSync(mkdtempSync(path.join(root, 'keychain-facts-')));
      const keychain = path.join(directory, 'fixture.keychain-db');
      const other = path.join(directory, 'other.keychain-db');
      writeFileSync(keychain, 'opaque synthetic keychain', { mode: 0o600 });
      writeFileSync(other, 'other synthetic keychain', { mode: 0o600 });
      const expected = 'synthetic-private-equality-value';
      const calls: string[][] = [];
      const facts = observeFixtureKeychain({ HOME: directory }, [directory], keychain, expected, 1000, (args, timeout) => {
        expect(Number.isInteger(timeout)).toBe(true);
        expect(timeout).toBeGreaterThan(0);
        calls.push(args);
        if (args[0] === 'list-keychains') return mismatch === 'search-error'
          ? { status: 1, stdout: '', stderr: 'synthetic-private-error' }
          : { status: 0, stdout: mismatch === 'search-empty' ? '' : JSON.stringify(mismatch === 'search-path' ? other : keychain), stderr: '' };
        if (args[0] === 'default-keychain') return mismatch === 'default-error'
          ? { status: 1, stdout: '', stderr: 'synthetic-private-error' }
          : mismatch === 'default-empty'
            ? { status: 1, stdout: '', stderr: 'security: SecKeychainCopyDomainDefault user: A default keychain could not be found.' }
            : { status: 0, stdout: JSON.stringify(mismatch === 'default-path' ? other : keychain), stderr: '' };
        if (mismatch === 'read-error') return { status: 1, stdout: '', stderr: 'synthetic-private-error' };
        return { status: 0, stdout: mismatch === 'read-mismatch' ? 'other synthetic value' : expected + '\n', stderr: '' };
      });
      expect(calls).toEqual([['list-keychains', '-d', 'user'], ['default-keychain', '-d', 'user'],
        ['find-generic-password', '-s', 'Gstack Native Probe', '-w', keychain]]);
      expect(facts.searchCount).toBe(mismatch === 'search-error' ? null : mismatch === 'search-empty' ? 0 : 1);
      expect(facts.searchPathMatches).toBe(!mismatch.startsWith('search-'));
      expect(facts.defaultCount).toBe(mismatch === 'default-error' ? null : mismatch === 'default-empty' ? 0 : 1);
      expect(facts.defaultPathMatches).toBe(!mismatch.startsWith('default-'));
      expect(facts.explicitReadAttempted).toBe(true);
      expect(facts.explicitReadSucceeded).toBe(mismatch !== 'read-error');
      expect(facts.explicitReadMatches).toBe(!mismatch.startsWith('read-'));
      expect(JSON.stringify(facts)).not.toContain(expected);
      expect(JSON.stringify(facts)).not.toContain('synthetic-private-error');
      expect(JSON.stringify(facts)).not.toContain(keychain);
    });
  }

  test('Dia Keychain diagnostics distinguish both HOME environments without configuring the shadow home', () => {
    const directory = realpathSync(mkdtempSync(path.join(root, 'dual-keychain-')));
    const registered = path.join(directory, 'registered');
    const shadow = path.join(directory, 'shadow');
    mkdirSync(registered);
    mkdirSync(shadow);
    prepareKeychainHome(registered);
    writeFileSync(path.join(registered, 'Library/Preferences/com.apple.security.plist'), 'opaque private fixture preference');
    const keychain = path.join(directory, 'fixture.keychain-db');
    writeFileSync(keychain, 'opaque synthetic keychain', { mode: 0o600 });
    const expected = 'synthetic-private-dual-home-value';
    const environments = { keychainHome: { HOME: registered }, profileHome: { HOME: shadow } };
    const calls: Array<{ home: string; args: string[] }> = [];
    const observed = observeDiaKeychainEnvironments(environments, [directory], keychain, expected, 20_000, (env, args, timeout) => {
      expect(Number.isInteger(timeout)).toBe(true);
      expect(timeout).toBeGreaterThan(0);
      expect(timeout).toBeLessThanOrEqual(10_000);
      calls.push({ home: env.HOME, args });
      if (args[0] === 'list-keychains') return { status: 0, stdout: env.HOME === registered ? JSON.stringify(keychain) : '', stderr: '' };
      if (args[0] === 'default-keychain') return env.HOME === registered
        ? { status: 0, stdout: JSON.stringify(keychain), stderr: '' }
        : { status: 1, stdout: '', stderr: 'security: SecKeychainCopyDomainDefault user: A default keychain could not be found.' };
      expect(args.slice(0, 4)).toEqual(['find-generic-password', '-s', 'Dia Safe Storage', '-w']);
      return { status: 0, stdout: expected, stderr: '' };
    });
    expect(observed.firstFailure).toEqual({ environment: 'profileHome', check: 'search_path' });
    expect(observed.environments.keychainHome).toMatchObject({ searchCount: 1, searchPathMatches: true, defaultCount: 1, defaultPathMatches: true,
      explicitReadMatches: true, lookupReadAttempted: true, lookupReadMatches: true, preferencesDirectoryExists: true, preferencesFileExists: true });
    expect(observed.environments.profileHome).toMatchObject({ searchCount: 0, searchPathMatches: false, defaultCount: 0, defaultPathMatches: false,
      explicitReadMatches: true, lookupReadAttempted: false, preferencesDirectoryExists: false, preferencesFileExists: false });
    expect(calls).toHaveLength(7);
    expect(calls.filter(call => call.home === shadow)).toHaveLength(3);
    expect(calls.some(call => call.args[0] === 'default-keychain' && call.args.includes('-s'))).toBe(false);
    expect(existsSync(path.join(shadow, 'Library'))).toBe(false);
    const serialized = JSON.stringify(observed);
    for (const privateValue of [expected, registered, shadow, keychain, 'opaque private']) expect(serialized).not.toContain(privateValue);
  });

  for (const failure of ['search', 'default', 'explicit_read']) {
    test(`Dia diagnostic refuses unqualified lookup when the owned ${failure} proof fails`, () => {
      const directory = realpathSync(mkdtempSync(path.join(root, 'guarded-keychain-')));
      const keychain = path.join(directory, 'fixture.keychain-db');
      writeFileSync(keychain, 'opaque synthetic keychain', { mode: 0o600 });
      let implicitCalls = 0;
      const result = observeFixtureKeychain({ HOME: directory }, [directory], keychain, 'expected-private-value', 1000, args => {
        if (args[0] === 'list-keychains') return { status: 0, stdout: failure === 'search' ? '' : JSON.stringify(keychain), stderr: '' };
        if (args[0] === 'default-keychain') return { status: 0, stdout: failure === 'default' ? '' : JSON.stringify(keychain), stderr: '' };
        if (args.length === 4) implicitCalls++;
        return { status: 0, stdout: failure === 'explicit_read' ? 'wrong-private-value' : 'expected-private-value', stderr: '' };
      }, 'Dia Safe Storage');
      expect(result.explicitReadAttempted).toBe(true);
      expect(result.lookupReadAttempted).toBe(false);
      expect(implicitCalls).toBe(0);
    });
  }

  test('both Keychain environments remain observable while the first original validation failure is retained', () => {
    const directory = realpathSync(mkdtempSync(path.join(root, 'keychain-failures-')));
    const keychain = path.join(directory, 'fixture.keychain-db');
    writeFileSync(keychain, 'opaque synthetic keychain', { mode: 0o600 });
    const environments = { keychainHome: { HOME: directory }, profileHome: { HOME: directory, MARKER: 'shadow' } };
    for (const keychainSearchFails of [true, false]) {
      const homesObserved = new Set<Record<string, string>>();
      const observed = observeDiaKeychainEnvironments(environments, [directory], keychain, 'expected-private-value', 20_000, (env, args) => {
        homesObserved.add(env);
        if (args[0] === 'list-keychains') return { status: 0,
          stdout: env === environments.profileHome || keychainSearchFails ? '' : JSON.stringify(keychain), stderr: '' };
        if (args[0] === 'default-keychain') return { status: 1, stdout: '', stderr: 'private-default-error' };
        return { status: 0, stdout: 'wrong-private-value', stderr: '' };
      });
      expect(homesObserved.size).toBe(2);
      expect(observed.firstFailure).toEqual({ environment: keychainSearchFails ? 'keychainHome' : 'profileHome', check: 'search_path' });
      expect(observed.environments.keychainHome).toMatchObject({ defaultCount: null, explicitReadAttempted: true, explicitReadMatches: false });
      expect(observed.environments.profileHome).toMatchObject({ defaultCount: null, explicitReadAttempted: true, explicitReadMatches: false });
      expect(JSON.stringify(observed)).not.toContain('private-default-error');
      expect(JSON.stringify(observed)).not.toContain('wrong-private-value');
    }
  });

  test('Dia environment validation preserves successful and explicit-read-only outcomes', () => {
    const directory = realpathSync(mkdtempSync(path.join(root, 'keychain-outcomes-')));
    const keychain = path.join(directory, 'fixture.keychain-db');
    writeFileSync(keychain, 'opaque synthetic keychain', { mode: 0o600 });
    const environments = { keychainHome: { HOME: directory }, profileHome: { HOME: directory } };
    for (const readMismatch of [false, true]) {
      const observed = observeDiaKeychainEnvironments(environments, [directory], keychain, 'expected-private-value', 20_000, (env, args) => {
        if (args[0] === 'list-keychains' || args[0] === 'default-keychain') return { status: 0, stdout: JSON.stringify(keychain), stderr: '' };
        return { status: 0, stdout: readMismatch && env === environments.keychainHome ? 'wrong-private-value' : 'expected-private-value', stderr: '' };
      });
      if (readMismatch) expect(observed.firstFailure).toEqual({ environment: 'keychainHome', check: 'explicit_read' });
      else expect(observed.firstFailure).toBeUndefined();
      expect(observed.environments.profileHome).toMatchObject({ searchPathMatches: true, defaultPathMatches: true, explicitReadMatches: true,
        lookupReadAttempted: true, lookupReadMatches: true });
    }
  });

  test('an exhausted dual-environment diagnostic budget launches no Keychain commands', () => {
    const directory = realpathSync(mkdtempSync(path.join(root, 'keychain-budget-')));
    const keychain = path.join(directory, 'fixture.keychain-db');
    writeFileSync(keychain, 'opaque synthetic keychain', { mode: 0o600 });
    let calls = 0;
    const observed = observeDiaKeychainEnvironments({ keychainHome: { HOME: directory }, profileHome: { HOME: directory } },
      [directory], keychain, 'expected-private-value', 0, () => { calls++; throw new Error('must_not_spawn'); });
    expect(calls).toBe(0);
    expect(observed.environments.keychainHome).toMatchObject({ searchCount: null, defaultCount: null, explicitReadAttempted: false, lookupReadAttempted: false });
    expect(observed.environments.profileHome).toMatchObject({ searchCount: null, defaultCount: null, explicitReadAttempted: false, lookupReadAttempted: false });
    expect(observed.firstFailure).toEqual({ environment: 'keychainHome', check: 'search_path' });
  });

  test('an originally absent default is restored by deleting only the created fixture, never by a null default setter', () => {
    expect(fixtureKeychainRestoreCommands({ search: [], default: [] }, '/owned/fixture.keychain-db', true)).toEqual([
      ['delete-keychain', '/owned/fixture.keychain-db'], ['list-keychains', '-d', 'user', '-s'],
    ]);
    expect(fixtureKeychainRestoreCommands({ search: [], default: [] }, '/owned/fixture.keychain-db', false)).toEqual([
      ['list-keychains', '-d', 'user', '-s'],
    ]);
  });

  test('an existing default is restored before deleting the fixture, and preexisting fixture references are refused', () => {
    const before = { search: ['/owned/prior.keychain-db', '/owned/other.keychain-db'], default: ['/owned/prior.keychain-db'] };
    expect(fixtureKeychainRestoreCommands(before, '/owned/fixture.keychain-db', true)).toEqual([
      ['default-keychain', '-d', 'user', '-s', '/owned/prior.keychain-db'],
      ['delete-keychain', '/owned/fixture.keychain-db'],
      ['list-keychains', '-d', 'user', '-s', '/owned/prior.keychain-db', '/owned/other.keychain-db'],
    ]);
    expect(() => fixtureKeychainRestoreCommands(before, '/owned/prior.keychain-db', true)).toThrow('fixture_keychain_not_fresh');
  });

  test('fresh account cleanup requires the same GUID, UID, private group, and registered home', () => {
    const identity = { guid: 'A38AC39B-5960-4F0C-B02F-C32A4F625B33', uid: 23456, gid: 23456, home: '/private/tmp/fixture/home' };
    const record = parseDirectoryRecord(`GeneratedUID: ${identity.guid}\nUniqueID: ${identity.uid}\nPrimaryGroupID: ${identity.gid}\nNFSHomeDirectory: ${identity.home}\n`);
    expect(ownsFreshAccount(record, identity)).toBe(true);
    for (const key of ['GeneratedUID', 'UniqueID', 'PrimaryGroupID', 'NFSHomeDirectory']) {
      expect(ownsFreshAccount({ ...record, [key]: 'different' }, identity)).toBe(false);
    }
    expect(() => parseDirectoryRecord('UniqueID: 23456\nUniqueID: 501')).toThrow('invalid_directory_record');
  });

  test('user-domain absence requires an explicit matching-domain response, not an arbitrary command failure', () => {
    for (const status of [64, 113]) {
      const absent = classifyUserDomain(23456, { status, stdout: '', stderr: 'Bad request.\nCould not find domain for user uid: 23456\n' });
      expect(absent.state).toBe('absent');
      expect(absent.uid).toBe(23456);
    }
    for (const result of [
      { status: 1, stdout: '', stderr: 'sudo: a password is required' },
      { status: 113, stdout: '', stderr: 'Could not find domain for user uid: 23457' },
      { status: 113, stdout: '', stderr: 'Could not find domain for user gui: 23456' },
      { status: 113, stdout: '', stderr: 'synthetic-private-error' },
      { status: null, stdout: '', stderr: '', error: new Error('synthetic-private-error') },
    ]) expect(classifyUserDomain(23456, result).state).toBe('unavailable');
    expect(() => classifyUserDomain(0, { status: 0, stdout: '', stderr: '' })).toThrow('invalid_fresh_user_domain');
  });

  test('user-domain inspection records only safe state facts and notices an unexpected GUI domain', () => {
    const present = classifyUserDomain(23456, { status: 0, stdout: 'user/23456 = {\n type = user\n synthetic-private-value\n}', stderr: '' });
    expect(present).toMatchObject({ uid: 23456, state: 'present', hasGuiDomain: false, exitCode: 0 });
    expect(JSON.stringify(present)).not.toContain('synthetic-private-value');
    expect(classifyUserDomain(23456, { status: 0, stdout: 'user/23456 = {\n subdomains = { gui/23456 }\n}', stderr: '' }).hasGuiDomain).toBe(true);
    expect(classifyUserDomain(23456, { status: 0, stdout: 'user/23456 = {\n session = Aqua\n}', stderr: '' }).hasGuiDomain).toBe(true);
    expect(classifyUserDomain(23456, { status: 0, stdout: 'user/501 = { }', stderr: '' }).state).toBe('unavailable');
  });

  test('domain structure retains counts and creator correlation, never arbitrary labels or environment values', () => {
    const stdout = `user/23456 = {
\ttype = user
\thandle = 23456
\tactive count = 3
\ton-demand count = 0
\tservice count = 2
\tactive service count = 1
\texternal activation count = 0
\tin-progress bootstraps = 0
\tpended requests = 0
\tcreator = launchctl.4567
\tcreator euid = 0
\tenvironment = {
\t\tsynthetic-private-variable => synthetic-private-value
\t\tservice count = 999
\t}
\tservices = {
\t\t234 0 synthetic-private-service
\t\t0 0 synthetic-private-job
\t}
\tsubdomains = {
\t\tsynthetic-private-child
\t}
\tunmanaged processes = {
\t}
\tendpoints = {}
}`;
    const observation = classifyUserDomain(23456, { status: 0, stdout, stderr: '' }, 4567);
    expect(observation.structure).toMatchObject({ complete: true, type: 'user', handleMatchesUid: true, creator: 'launchctl', creatorIsProbe: true,
      counts: { 'service count': 2, 'active service count': 1, 'creator euid': 0, 'in-progress bootstraps': 0 },
      sectionNonemptyLines: { services: 2, subdomains: 1, 'unmanaged processes': 0, endpoints: 0, jobs: null } });
    expect(JSON.stringify(observation)).not.toContain('synthetic-private');
    expect(JSON.stringify(observation)).not.toContain('4567');
    expect(classifyUserDomain(23456, { status: 0, stdout, stderr: '' }, 4568).structure?.creatorIsProbe).toBe(false);
    expect(classifyUserDomain(23456, { status: 0, stdout, stderr: '' }).structure?.creatorIsProbe).toBeNull();
    expect(classifyUserDomain(23456, { status: 0, stdout: stdout.replace('launchctl.4567', 'synthetic-private-creator.4567'), stderr: '' }, 4567).structure?.creator).toBe('other');
  });

  test('missing, malformed, duplicate, and incomplete domain facts never become empty-baseline evidence', () => {
    const minimal = 'user/23456 = {\n\ttype = user\n\thandle = 23456\n}';
    const observation = classifyUserDomain(23456, { status: 0, stdout: minimal, stderr: '' });
    expect(observation.structure?.counts['service count']).toBeNull();
    expect(observation.structure?.sectionNonemptyLines.services).toBeNull();
    expect(observation.structure?.creatorIsProbe).toBeNull();
    for (const stdout of [minimal.slice(0, -1), minimal.replace('\thandle', '\ttype = user\n\thandle'),
      minimal.replace('\thandle = 23456', '\tservices = {\n\t\tsynthetic-private-service')]) {
      expect(classifyUserDomain(23456, { status: 0, stdout, stderr: '' }).structure?.complete).toBe(false);
    }
    for (const value of ['-1', 'NaN', '1.5', '9007199254740992', 'synthetic-private-value']) {
      const stdout = minimal.replace('\thandle', '\tservice count = ' + value + '\n\thandle');
      expect(classifyUserDomain(23456, { status: 0, stdout, stderr: '' }).structure?.counts['service count']).toBeNull();
    }
  });

  test('known bracketed creator syntax is matched exactly while unsupported spellings remain unknown', () => {
    const fixture = (creator: string) => classifyUserDomain(23456, { status: 0,
      stdout: `user/23456 = {\n\ttype = user\n\tcreator = ${creator}\n}`, stderr: '' }, 4567);
    expect(fixture('launchctl[4567]').structure?.creatorIsProbe).toBe(true);
    expect(fixture('launchctl[4568]').structure?.creatorIsProbe).toBe(false);
    for (const creator of ['launchctl(4567)', 'launchctl[4567] extra', 'other[4567]', 'launchctl[0]', 'launchctl[4567)']) {
      expect(fixture(creator).structure?.creatorIsProbe).toBeNull();
      expect(fixture(creator).structure?.creator).toBe('other');
    }
  });

  test('parent-domain observation extracts only candidate UID membership from complete subdomains', () => {
    for (const [header, target, gui] of [
      ['system', 'user/23456', 'gui/23456'],
      ['com.apple.xpc.launchd.domain.system', 'com.apple.xpc.launchd.domain.user.23456', 'com.apple.xpc.launchd.user.domain.23456.100007.Aqua'],
    ]) {
      const stdout = `${header} = {\n\ttype = system\n\tsubdomains = {\n\t\t${target}\n\t\t${gui}\n\t\tpid/15\n\t}\n}`;
      expect(classifyParentDomain(23456, { status: 0, stdout, stderr: '' })).toMatchObject({ state: 'present', parseStage: 'parsed',
        subdomainCount: 3, matchingUserDomains: 1, matchingGuiDomains: 1, unrecognizedEntries: 0 });
    }
    const stdout = `system = {
\ttype = system
\tenvironment = {
\t\tsynthetic-private-name => user/23456
\t\tsubdomains = {
\t\t\tuser/23456
\t\t}
\t}
\tsubdomains = {
\t\tuser/234560
\t\tgui/501
\t\tpid/123
\t\tsession/100007
\t\tcom.apple.xpc.launchd.domain.pid.synthetic-private-process.23456
\t}
\tservices = {
\t\tsynthetic-private-service-user/23456
\t}
}`;
    const observation = classifyParentDomain(23456, { status: 0, stdout, stderr: '' });
    expect(observation).toMatchObject({ state: 'absent', parseStage: 'parsed', subdomainCount: 5, matchingUserDomains: 0 });
    expect(JSON.stringify(observation)).not.toContain('synthetic-private');
    expect(JSON.stringify(observation)).not.toContain('234560');
  });

  test('parent-domain absence refuses incomplete, missing, duplicate, nested-only, or unknown subdomain output', () => {
    const empty = 'system = {\n\ttype = system\n\tsubdomains = {}\n}';
    expect(classifyParentDomain(23456, { status: 0, stdout: empty, stderr: '' }).state).toBe('absent');
    for (const stdout of [empty.slice(0, -1), empty.replace('system = {', 'user/23456 = {'),
      empty.replace('\tsubdomains = {}\n', ''), empty.replace('\tsubdomains = {}', '\tsubdomains = {}\n\tsubdomains = {}'),
      empty.replace('type = system', 'type = user'),
      empty.replace('\tsubdomains = {}', '\tenvironment = {\n\t\tsubdomains = {}\n\t}'),
      empty.replace('subdomains = {}', 'subdomains = {\n\t\tunknown-private-domain\n\t}'),
      empty.replace('subdomains = {}', 'subdomains = {\n\t\tuser/23456\n\t\tunknown-private-domain\n\t}')]) {
      const observation = classifyParentDomain(23456, { status: 0, stdout, stderr: '' });
      expect(observation.state).toBe('unavailable');
      expect(JSON.stringify(observation)).not.toContain('private-domain');
    }
    expect(classifyParentDomain(23456, { status: 1, stdout: empty, stderr: 'synthetic-private-error' }).state).toBe('unavailable');
    expect(classifyParentDomain(23456, { status: 0, stdout: empty, stderr: '', error: new Error('synthetic-private-error') }).state).toBe('unavailable');
    expect(classifyParentDomain(23456, { status: 0, stdout: empty + ' '.repeat(1024 * 1024), stderr: '' }).parseStage).toBe('oversized');
  });

  test('the registered parent observer queries only the existing system domain under its original bounds', () => {
    const env = { HOME: root, PATH: '/usr/bin:/bin' };
    const observation = inspectParentDomain(23456, performance.now() + 10_000, env,
      ((command: string, args: string[], options: any) => {
        expect(command).toBe('/usr/bin/sudo');
        expect(args).toEqual(['-n', '/bin/launchctl', 'print', 'system']);
        expect(options.env).toBe(env);
        expect(options.maxBuffer).toBe(1024 * 1024);
        expect(Number.isInteger(options.timeout)).toBe(true);
        expect(options.timeout).toBeGreaterThan(0);
        expect(options.timeout).toBeLessThanOrEqual(3_000);
        return { status: 0, stdout: 'system = {\n\ttype = system\n\tsubdomains = {}\n}', stderr: '' };
      }) as typeof spawnSync);
    expect(observation.state).toBe('absent');
    const never = (() => { throw new Error('must_not_spawn'); }) as typeof spawnSync;
    expect(() => inspectParentDomain(501, performance.now() + 10_000, {}, never)).toThrow('invalid_fresh_user_domain');
    for (const deadline of [0, NaN, Infinity]) expect(() => inspectParentDomain(23456, deadline, {}, never)).toThrow('fresh_launcher_deadline');
  });

  test('the registered UID observer filters numeric global ps rows without resolving an unregistered account', () => {
    const env = { HOME: root, PATH: '/usr/bin:/bin' };
    const observation = inspectUidProcesses(23456, performance.now() + 10_000, env,
      ((command: string, args: string[], options: any) => {
        expect(command).toBe('/bin/ps');
        expect(args).toEqual(['-axo', 'uid=,pid=,ppid=,state=,ucomm=']);
        expect(options.env).toBe(env);
        expect(options.maxBuffer).toBe(128 * 1024);
        expect(Number.isInteger(options.timeout)).toBe(true);
        expect(options.timeout).toBeGreaterThan(0);
        expect(options.timeout).toBeLessThanOrEqual(2_000);
        return { status: 0, stdout: '501 300 1 S synthetic-private-name\n23456 400 1 S distnoted\n', stderr: '' };
      }) as typeof spawnSync);
    expect(observation).toMatchObject({ available: true, count: 1, processes: [{ pid: 400, ppid: 1, state: 'S', basename: 'distnoted' }] });
    expect(JSON.stringify(observation)).not.toContain('synthetic-private');
    expect(inspectUidProcesses(23456, performance.now() + 10_000, {}, (() => ({ status: 0,
      stdout: '501 300 1 S synthetic-private-name\n', stderr: '' })) as typeof spawnSync)).toMatchObject({ available: true, count: 0, processes: [] });
    for (const result of [
      { status: 1, stdout: '', stderr: '' }, { status: 0, stdout: '', stderr: '' },
      { status: 0, stdout: 'truncated-private-row', stderr: '' },
      { status: null, stdout: null, stderr: null, error: new Error('synthetic-private-error') },
    ]) expect(inspectUidProcesses(23456, performance.now() + 10_000, {}, (() => result) as typeof spawnSync)).toEqual({ available: false });
  });

  test('numeric UID process filtering runs through the real global process table', () => {
    const observation = inspectUidProcesses(23456, performance.now() + 10_000, { HOME: root, PATH: '/usr/bin:/bin' });
    expect(observation.available).toBe(true);
    expect('count' in observation).toBe(true);
  });

  test('the registered domain probe binds its creator check to the shell exec PID and bounds the query', () => {
    const env = { PATH: '/usr/bin:/bin', HOME: root };
    let called = false;
    const observation = inspectUserDomain(23456, performance.now() + 10_000, env, ((command: string, args: string[], options: any) => {
      called = true;
      expect(command).toBe('/usr/bin/sudo');
      expect(args).toEqual(['-n', '/bin/sh', '-c', 'printf "GSTACK_DIA_DOMAIN_PROBE_PID=%s\\n" "$$"; exec /bin/launchctl print "$1"',
        'gstack-dia-domain-probe', 'user/23456']);
      expect(options.env).toBe(env);
      expect(options.timeout).toBeGreaterThan(0);
      expect(options.timeout).toBeLessThanOrEqual(3_000);
      expect(Number.isInteger(options.timeout)).toBe(true);
      expect(options.maxBuffer).toBe(1024 * 1024);
      return { status: 0, stdout: 'GSTACK_DIA_DOMAIN_PROBE_PID=4567\nuser/23456 = {\n\ttype = user\n\tcreator = launchctl.4567\n}', stderr: '' };
    }) as typeof spawnSync);
    expect(called).toBe(true);
    expect(observation.state).toBe('present');
    expect(observation.structure?.creatorIsProbe).toBe(true);
    expect(JSON.stringify(observation)).not.toContain('GSTACK_DIA_DOMAIN_PROBE_PID');
  });

  test('domain probe failures preserve unknown state instead of manufacturing absence or creator ownership', () => {
    for (const result of [
      { status: 0, stdout: 'user/23456 = {\n\ttype = user\n}', stderr: '' },
      { status: 0, stdout: 'GSTACK_DIA_DOMAIN_PROBE_PID=9007199254740992\nuser/23456 = {\n\ttype = user\n}', stderr: '' },
      { status: 113, stdout: '', stderr: 'Could not find domain for user uid: 23456' },
      { status: null, stdout: null, stderr: null, error: new Error('synthetic-private-error') },
    ]) {
      const observation = inspectUserDomain(23456, performance.now() + 10_000, {}, (() => result) as typeof spawnSync);
      expect(observation.state).toBe('unavailable');
      expect(observation.structure).toBeUndefined();
      expect(JSON.stringify(observation)).not.toContain('synthetic-private');
    }
    expect(inspectUserDomain(23456, performance.now() + 10_000, {}, (() => ({ status: 113,
      stdout: 'GSTACK_DIA_DOMAIN_PROBE_PID=4567\n', stderr: 'Could not find domain for user uid: 23456' })) as typeof spawnSync).state).toBe('absent');
    const never = (() => { throw new Error('must_not_spawn'); }) as typeof spawnSync;
    expect(() => inspectUserDomain(0, performance.now() + 10_000, {}, never)).toThrow('invalid_fresh_user_domain');
    for (const deadline of [0, NaN, Infinity]) expect(() => inspectUserDomain(23456, deadline, {}, never)).toThrow('fresh_launcher_deadline');
  });

  test('the domain probe PID protocol survives real shell exec without logging the PID or child output', () => {
    const fixture = path.join(root, 'domain-probe.cjs');
    writeFileSync(fixture, 'process.stdout.write("user/23456 = {\\n\\ttype = user\\n\\tcreator = launchctl." + process.pid + "\\n}");');
    const observation = inspectUserDomain(23456, performance.now() + 10_000, { PATH: '/usr/bin:/bin', HOME: root },
      ((_command: string, args: string[], options: any) => spawnSync('/bin/sh', ['-c',
        args[3].replace('/bin/launchctl print "$1"', '"$1" "$2"'), args[4], process.execPath, fixture],
      { ...options, timeout: 3_000 })) as typeof spawnSync);
    expect(observation.state).toBe('present');
    expect(observation.structure?.creatorIsProbe).toBe(true);
    expect(observation.structure?.complete).toBe(true);
    expect(JSON.stringify(observation)).not.toContain('GSTACK_DIA_DOMAIN_PROBE_PID');
  });

  test('user-domain teardown is bound to the new account and its pre-creation absence proof', () => {
    const account = { guid: 'A38AC39B-5960-4F0C-B02F-C32A4F625B33', uid: 23456, gid: 23456, home: '/private/tmp/dn-fixture/home' };
    const record = { GeneratedUID: account.guid, UniqueID: '23456', PrimaryGroupID: '23456', NFSHomeDirectory: account.home };
    const proof = classifyParentDomain(23456, { status: 0, stdout: 'system = {\n\ttype = system\n\tsubdomains = {}\n}', stderr: '' });
    const current = classifyParentDomain(23456, { status: 0, stdout: 'system = {\n\ttype = system\n\tsubdomains = {\n\t\tuser/23456\n\t}\n}', stderr: '' });
    expect(ownedUserDomainTarget(record, account, proof, current, 501)).toBe('user/23456');
    expect(ownedUserDomainTarget(record, account, proof, proof, 501)).toBeNull();
    for (const key of ['GeneratedUID', 'UniqueID', 'PrimaryGroupID', 'NFSHomeDirectory']) {
      expect(() => ownedUserDomainTarget({ ...record, [key]: 'changed' }, account, proof, current, 501)).toThrow('fresh_user_domain_ownership_unconfirmed');
    }
    expect(() => ownedUserDomainTarget(record, account, undefined, current, 501)).toThrow('fresh_user_domain_ownership_unconfirmed');
    expect(() => ownedUserDomainTarget(record, account, { ...proof, state: 'present' }, current, 501)).toThrow('fresh_user_domain_ownership_unconfirmed');
    expect(() => ownedUserDomainTarget(record, account, { ...proof, uid: 23457 }, current, 501)).toThrow('fresh_user_domain_ownership_unconfirmed');
    expect(() => ownedUserDomainTarget(record, account, proof, current, 23456)).toThrow('fresh_user_domain_ownership_unconfirmed');
    expect(() => ownedUserDomainTarget(record, account, proof, current, NaN)).toThrow('fresh_user_domain_ownership_unconfirmed');
    for (const changed of [{ ...current, matchingGuiDomains: 1 }, { ...current, uid: 23457 }, { ...current, state: 'unavailable' as const },
      { ...current, duplicateEntries: 1 }, { ...current, matchingUserDomains: 2 }, { ...current, parseStage: 'missing_subdomains' },
      { ...current, unrecognizedEntries: 1 }]) {
      expect(() => ownedUserDomainTarget(record, account, proof, changed, 501)).toThrow('fresh_user_domain_ownership_unconfirmed');
    }
  });

  test('duplicated native subdomain entries and equivalent aliases never authorize teardown or absence', () => {
    for (const entries of [
      ['user/23456', 'user/23456'], ['user/23456', 'com.apple.xpc.launchd.domain.user.23456'],
      ['user/23456', 'gui/23456', 'gui/23456'], ['user/501', 'user/501'],
      ['user/23456', 'pid/22', 'com.apple.xpc.launchd.domain.pid.synthetic-private-process.22'],
    ]) {
      const observation = classifyParentDomain(23456, { status: 0,
        stdout: 'system = {\n\ttype = system\n\tsubdomains = {\n' + entries.map(entry => '\t\t' + entry).join('\n') + '\n\t}\n}', stderr: '' });
      expect(observation.duplicateEntries).toBe(1);
      expect(observation.parseStage).toBe('duplicate_subdomain');
      expect(observation.state).toBe('unavailable');
      expect(passiveUserDomainState(observation, 23456)).toBe('unavailable');
    }
  });

  test('passive absence and presence require consistent complete facts with no GUI association', () => {
    const absent = classifyParentDomain(23456, { status: 0, stdout: 'system = {\n\ttype = system\n\tsubdomains = {}\n}', stderr: '' });
    expect(passiveUserDomainState(absent, 23456)).toBe('absent');
    for (const changed of [undefined, { ...absent, uid: 23457 }, { ...absent, matchingUserDomains: 1 },
      { ...absent, matchingGuiDomains: 1 }, { ...absent, exitCode: 1 }, { ...absent, duplicateEntries: 1 },
      { ...absent, unrecognizedEntries: 1 }, { ...absent, state: 'present' as const }]) {
      expect(passiveUserDomainState(changed, 23456)).toBe('unavailable');
    }
    const gui = classifyParentDomain(23456, { status: 0,
      stdout: 'system = {\n\ttype = system\n\tsubdomains = {\n\t\tuser/23456\n\t\tgui/23456\n\t}\n}', stderr: '' });
    expect(passiveUserDomainState(gui, 23456)).toBe('unavailable');
    const oldTargetObservation = classifyUserDomain(23456, { status: 113, stdout: '', stderr: 'Could not find domain for user uid: 23456' });
    expect(passiveUserDomainState(oldTargetObservation as any, 23456)).toBe('unavailable');
  });

  test('directory UID inventory retains occupied candidate IDs and refuses malformed or empty listings', () => {
    expect([...parseDirectoryIds('root 0\nfixture 20000\nnobody -2\nother fixture 20001  \n')]).toEqual([0, 20000, -2, 20001]);
    for (const value of ['', 'malformed', 'root 0\nfixture unknown\n', 'root 0\nfixture 9007199254740992\n']) {
      expect(() => parseDirectoryIds(value)).toThrow();
    }
  });

  test('normal qualification never invokes the materializing target-domain diagnostic', () => {
    const implementation = runFreshAccountQualification.toString();
    expect(implementation).toContain('inspectParentDomain');
    expect(implementation).toContain('passiveUserDomainState');
    expect(implementation).not.toMatch(/inspectUserDomain|probeUserDomain|classifyUserDomain/);
    expect(implementation).not.toMatch(/['"]print['"],\s*['"](?:user|gui)\//);
  });

  test('launchd receives a one-shot fresh-user security session without an Aqua or auto-login workaround', () => {
    const account: any = { label: 'ai.gstack.dia.fixture', account: 'gsdiafixture', bun: '/private/tmp/fixture/bin/bun',
      snapshot: '/private/tmp/fixture/repo', configFile: '/private/tmp/fixture/account.json', environment: { HOME: '/private/tmp/fixture/home', CI: 'true' } };
    const definition = freshLaunchDefinition(account);
    expect(definition.UserName).toBe(account.account);
    expect(definition.GroupName).toBe(account.account);
    expect(definition.SessionCreate).toBe(true);
    expect(definition.RunAtLoad).toBe(true);
    expect(definition.KeepAlive).toBe(false);
    expect(definition.Umask).toBe(63);
    expect(definition.ProgramArguments[0]).toBe(account.bun);
    expect(definition.ProgramArguments).toContain('--fresh-worker');
    expect(definition.StandardOutPath).toBe('/dev/null');
    expect(definition.StandardErrorPath).toBe('/dev/null');
    expect(JSON.stringify(definition)).not.toMatch(/Aqua|autoLogin|LoginWindow|GITHUB_TOKEN/);
  });

  test('service cleanup binds the exact system label, executable, user, and private group', () => {
    const owner = { label: 'ai.gstack.dia.fixture', bun: '/private/tmp/fixture/bin/bun', account: 'gsdiafixture' };
    const state = `system/${owner.label} = {\n program = ${owner.bun}\n username = ${owner.account}\n group = ${owner.account}\n}`;
    expect(ownsLaunchService(state, owner)).toBe(true);
    for (const replacement of [state.replace('system/', 'gui/501/'), state.replace(owner.label, 'unrelated'),
      state.replace(owner.bun, '/unrelated/bun'), state.replace('username = gsdiafixture', 'username = runner'),
      state.replace('group = gsdiafixture', 'group = staff')]) expect(ownsLaunchService(replacement, owner)).toBe(false);
  });

  test('the fresh-account launcher refuses this non-authorized invocation without privileged work', () => {
    const launcher = path.resolve(import.meta.dir, '../../.github/scripts/run-dia-native-qualification.ts');
    const result = spawnSync(process.execPath, ['--no-env-file', '--no-install', '--no-macros', `--config=${process.platform === 'win32' ? 'NUL' : '/dev/null'}`, launcher], {
      cwd: root, env: { HOME: root, PATH: path.dirname(process.execPath) }, encoding: 'utf8', timeout: 10_000,
    });
    expect(result.status).toBe(2);
    expect(result.stderr).toBe('');
    expect(JSON.parse(result.stdout).reason).toBe('fresh_account_launcher_preflight_failed');
  });

  for (const shape of ['normal', 'safe-link', 'traversal', 'absolute', 'escape-link', 'symlink-parent', 'symlink-dotdot', 'hardlink', 'case-collision', 'unicode-collision', 'device']) {
    test(`archive preflight classifies ${shape} before extraction`, () => {
      const python = Bun.which('python3');
      if (!python) throw new Error('Python 3 is required for archive boundary tests');
      const archive = path.join(root, shape + '.tar');
      const create = spawnSync(python, ['-I', '-c', `
import io, sys, tarfile
shape, file = sys.argv[1:]
with tarfile.open(file, 'w') as out:
    def entry(name, kind=tarfile.REGTYPE, link=''):
        item = tarfile.TarInfo(name); item.type = kind; item.linkname = link
        if kind == tarfile.REGTYPE:
            item.size = 1; out.addfile(item, io.BytesIO(b'x'))
        else: out.addfile(item)
    if shape == 'normal': entry('src/file.ts')
    elif shape == 'safe-link': entry('target'); entry('link', tarfile.SYMTYPE, 'target')
    elif shape == 'traversal': entry('../outside')
    elif shape == 'absolute': entry('/outside')
    elif shape == 'escape-link': entry('link', tarfile.SYMTYPE, '../outside')
    elif shape == 'symlink-parent': entry('link', tarfile.SYMTYPE, 'target'); entry('link/child')
    elif shape == 'symlink-dotdot': entry('b', tarfile.SYMTYPE, '.'); entry('a/link', tarfile.SYMTYPE, '../b/..')
    elif shape == 'hardlink': entry('target'); entry('link', tarfile.LNKTYPE, 'target')
    elif shape == 'case-collision': entry('File'); entry('file')
    elif shape == 'unicode-collision': entry('Caf' + chr(233)); entry('Cafe' + chr(769))
    elif shape == 'device': entry('device', tarfile.CHRTYPE)
`, shape, archive], { encoding: 'utf8', timeout: 10_000 });
      expect(create.status).toBe(0);
      const checked = spawnSync(python, ['-I', '-c', ARCHIVE_CHECK, archive], { encoding: 'utf8', timeout: 10_000 });
      expect(checked.status).toBe(['normal', 'safe-link'].includes(shape) ? 0 : 2);
      expect(JSON.parse(checked.stdout).valid).toBe(['normal', 'safe-link'].includes(shape));
      expect(checked.stderr).toBe('');
    });
  }

  test('receipt collection rejects symlinks and an unrelated owner without printing content', () => {
    const python = Bun.which('python3');
    if (!python) throw new Error('Python 3 is required for receipt boundary tests');
    const directory = realpathSync(mkdtempSync(path.join(root, 'receipts-')));
    const file = path.join(directory, 'receipt.json');
    writeFileSync(file, JSON.stringify({ status: 'incomplete', reason: 'synthetic_fixture' }), { mode: 0o600 });
    chmodSync(file, 0o600);
    const uid = process.getuid!();
    const read = (selected: string, owner: number) => spawnSync(python, ['-I', '-c', PRIVATE_RECEIPT_READ, selected, String(owner), directory], {
      encoding: 'utf8', timeout: 10_000,
    });
    const valid = read(file, uid);
    expect(valid.status).toBe(0);
    expect(JSON.parse(valid.stdout).status).toBe('incomplete');
    const wrong = read(file, uid + 1);
    expect(wrong.status).toBe(2);
    expect(wrong.stdout).toBe('');
    const link = path.join(directory, 'linked.json');
    symlinkSync(file, link);
    const linked = read(link, uid);
    expect(linked.status).toBe(2);
    expect(linked.stdout).toBe('');
  });

  test('receipt collection rejects linked ancestors and incomplete JSON without disclosing content', () => {
    const python = Bun.which('python3');
    if (!python) throw new Error('Python 3 is required for receipt boundary tests');
    const directory = realpathSync(mkdtempSync(path.join(root, 'receipt-ancestors-')));
    const nested = path.join(directory, 'nested');
    mkdirSync(nested, { mode: 0o700 });
    const file = path.join(nested, 'receipt.json');
    writePrivateReceipt(file, { status: 'incomplete' });
    const linked = path.join(directory, 'linked');
    symlinkSync(nested, linked, 'dir');
    const read = (selected: string) => spawnSync(python, ['-I', '-c', PRIVATE_RECEIPT_READ, selected, String(process.getuid!()), directory], {
      encoding: 'utf8', timeout: 3_000,
    });
    expect(read(file).status).toBe(0);
    const rejected = read(path.join(linked, 'receipt.json'));
    expect(rejected.status).toBe(2);
    expect(rejected.stdout).toBe('');
    writeFileSync(file, '{"synthetic-private-value":');
    const partial = read(file);
    expect(partial.status).toBe(2);
    expect(partial.stdout).toBe('');
  });

  test('receipt publication is private, atomic, and refuses unintended overwrites or symlink targets', () => {
    const directory = realpathSync(mkdtempSync(path.join(root, 'atomic-receipt-')));
    const file = path.join(directory, 'receipt.json');
    writePrivateReceipt(file, { status: 'incomplete', phase: 'first' });
    expect(lstatSync(file).mode & 0o777).toBe(0o600);
    expect(() => writePrivateReceipt(file, { status: 'passed' })).toThrow();
    expect(JSON.parse(readFileSync(file, 'utf8')).phase).toBe('first');
    writePrivateReceipt(file, { status: 'incomplete', phase: 'second' }, true);
    expect(JSON.parse(readFileSync(file, 'utf8')).phase).toBe('second');
    const link = path.join(directory, 'linked.json');
    symlinkSync(file, link);
    expect(() => writePrivateReceipt(link, { status: 'passed' }, true)).toThrow('unsafe_receipt_replacement');
    expect(JSON.parse(readFileSync(file, 'utf8')).phase).toBe('second');
    expect(readdirSync(directory).some(name => name.startsWith('.dia-receipt-'))).toBe(false);
  });

  test('an atomic owner-checked diagnostic receipt is readable while its producer is still alive', async () => {
    const python = Bun.which('python3');
    if (!python) throw new Error('Python 3 is required for receipt boundary tests');
    const directory = realpathSync(mkdtempSync(path.join(root, 'live-receipt-')));
    const file = path.join(directory, 'receipt.json');
    const module = pathToFileURL(path.resolve(import.meta.dir, '../../.github/scripts/qualify-dia-macos.ts')).href;
    const child = Bun.spawn([process.execPath, '--no-env-file', '--no-install', '--no-macros', '--config=/dev/null', '-e', `
      const { writePrivateReceipt } = await import(${JSON.stringify(module)});
      writePrivateReceipt(${JSON.stringify(file)}, { status: 'incomplete', reason: 'worker_diagnostic', cleanup: { complete: false } });
      console.log('ready');
      setInterval(() => {}, 1000);
    `], { cwd: directory, env: { HOME: directory, PATH: path.dirname(process.execPath) }, stdout: 'pipe', stderr: 'pipe' });
    try {
      const reader = child.stdout.getReader();
      expect(new TextDecoder().decode((await reader.read()).value)).toContain('ready');
      reader.releaseLock();
      expect(child.exitCode).toBeNull();
      const result = spawnSync(python, ['-I', '-c', PRIVATE_RECEIPT_READ, file, String(process.getuid!()), directory], {
        encoding: 'utf8', timeout: 3_000,
      });
      expect(result.status).toBe(0);
      expect(JSON.parse(result.stdout)).toEqual({ status: 'incomplete', reason: 'worker_diagnostic', cleanup: { complete: false } });
      expect(child.exitCode).toBeNull();
    } finally {
      child.kill();
      await child.exited;
    }
  });

  test('UID process diagnostics preserve zombie/service/browser distinctions without argv or arbitrary names', () => {
    const facts = uidProcessFacts('20000 301 1 Ss cfprefsd\n20000 302 1 Z bun\n20000 303 301 R Google Chrome for Testing\n20000 304 1 S synthetic-private-value\n501 999 1 S security\n', 20000);
    expect(facts).toEqual({ available: true, count: 4, zombies: 1, live: 3, truncated: false, processes: [
      { pid: 301, ppid: 1, state: 'S', basename: 'cfprefsd' }, { pid: 302, ppid: 1, state: 'Z', basename: 'bun' },
      { pid: 303, ppid: 301, state: 'R', basename: 'Google Chrome for Testing' }, { pid: 304, ppid: 1, state: 'S', basename: 'other' },
    ] });
    expect(JSON.stringify(facts)).not.toContain('synthetic-private-value');
    expect(JSON.stringify(facts)).not.toContain('999');
    expect(uidProcessFacts('20000 401 1 S cfprefsd\n', 20000).processes[0].pid).toBe(401);
    expect(uidProcessFacts('20000 402 1 Z+ bun\n', 20000)).toMatchObject({ count: 1, zombies: 1, live: 0 });
    expect(() => uidProcessFacts('malformed synthetic-private-value', 20000)).toThrow('invalid_uid_process_snapshot');
    expect(uidProcessFacts(Array.from({ length: 80 }, (_, index) => `20000 ${1000 + index} 1 S bun`).join('\n'), 20000))
      .toMatchObject({ count: 80, truncated: true });
    expect(uidProcessFacts(Array.from({ length: 80 }, (_, index) => `20000 ${1000 + index} 1 S bun`).join('\n'), 20000).processes).toHaveLength(64);
  });

  test('captured passing inner receipts cannot qualify a run with incomplete cleanup', () => {
    const cleanup = { serviceStopped: true, userDomainStopped: true, userProcessesStopped: true, accountRemoved: true, groupRemoved: true, stagingRemoved: true };
    expect(freshQualificationPassed(0, 'passed', 'passed', cleanup)).toBe(true);
    for (const key of Object.keys(cleanup)) expect(freshQualificationPassed(0, 'passed', 'passed', { ...cleanup, [key]: false })).toBe(false);
    expect(freshQualificationPassed(0, 'passed', 'passed', {})).toBe(false);
    expect(freshQualificationPassed(2, 'passed', 'passed', cleanup)).toBe(false);
    expect(freshQualificationPassed(0, 'incomplete', 'passed', cleanup)).toBe(false);
  });

  test('the registered spawn observer records the actual owned child and closes launch admission', async () => {
    const profile = path.join(root, 'profile');
    const childProcess = require('node:child_process');
    const original = childProcess.spawn;
    const observer = observeBrowserLaunches(new Map([[process.execPath, profile]]));
    const args = ['--no-env-file', '--no-install', '-e', 'process.exit(0)', '--', '--remote-debugging-pipe', '--user-data-dir=' + profile];
    const options = { cwd: root, detached: true, shell: false, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe', 'pipe', 'pipe'],
      env: { PATH: path.dirname(process.execPath), HOME: root, ...(process.env.SystemRoot ? { SystemRoot: process.env.SystemRoot } : {}) } };
    try {
      const child = childProcess.spawn(process.execPath, args, options);
      const code = await new Promise(resolve => child.once('close', resolve));
      expect(code).toBe(0);
      expect(observer.children).toHaveLength(1);
      expect(observer.children[0].process).toBe(child);
      expect(observer.children[0].pid).toBe(child.pid);
      observer.stop();
      expect(() => childProcess.spawn(process.execPath, args, options)).toThrow('browser_launch_policy_rejected');
      expect(observer.children).toHaveLength(1);
    } finally {
      observer.restore();
    }
    expect(childProcess.spawn).toBe(original);
  });

  test('the pinned Playwright launch is captured with the observer installed after importing Playwright', async () => {
    const { chromium } = await import('playwright');
    expect(require('playwright/package.json').version).toBe('1.62.1');
    const executable = realpathSync(chromium.executablePath());
    const profile = path.join(root, 'playwright-profile');
    const observer = observeBrowserLaunches(new Map([[executable, profile]]));
    let context: Awaited<ReturnType<typeof chromium.launchPersistentContext>> | undefined;
    try {
      context = await chromium.launchPersistentContext(profile, nativeDiaLaunchOptions(executable, {
        HOME: root, PATH: path.dirname(process.execPath),
        ...(process.env.SystemRoot ? { SystemRoot: process.env.SystemRoot } : {}),
      }));
      expect(observer.children).toHaveLength(1);
      expect(observer.children[0].executable).toBe(executable);
      expect(observer.children[0].pid).toBeGreaterThan(1);
      expect(observer.attempts).toHaveLength(1);
      expect(observer.attempts[0]).toEqual({ admissionOpen: true, argumentsArray: true, pipeFlag: true, profileArgumentCount: 1,
        expectedProfile: true, detached: true, shellDisabled: true, stdioCount: 5, extraPipeDescriptors: true,
        headlessFlag: true, blankStartupArgument: true, tcpDebuggingFlag: false, mockKeychainFlag: false,
        passwordStoreFlag: false, firstRunSuppressed: false });
      expect(JSON.stringify(observer.attempts)).not.toContain(executable);
      expect(JSON.stringify(observer.attempts)).not.toContain(profile);
      const page = context.pages()[0] ?? await context.newPage();
      await page.setContent('<div id="fixture">isolated browser smoke</div>');
      expect(await page.locator('#fixture').innerText()).toBe('isolated browser smoke');
      await context.close();
      context = undefined;
      expect(observer.children[0].process.exitCode !== null || observer.children[0].process.signalCode !== null).toBe(true);
    } finally {
      observer.stop();
      await context?.close();
      observer.restore();
    }
  }, 40_000);

  for (const forbidden of ['--remote-debugging-port=9222', '--use-mock-keychain', '--password-store=basic', '--no-first-run']) {
    test(`the actual spawn callback rejects ${forbidden} before process creation`, () => {
      const profile = path.join(root, 'profile');
      const childProcess = require('node:child_process');
      const observer = observeBrowserLaunches(new Map([[process.execPath, profile]]));
      try {
        expect(() => childProcess.spawn(process.execPath, ['--remote-debugging-pipe', '--user-data-dir=' + profile, forbidden],
          { detached: true, shell: false, stdio: ['ignore', 'pipe', 'pipe', 'pipe', 'pipe'] })).toThrow('browser_launch_policy_rejected');
        expect(observer.children).toHaveLength(0);
      } finally { observer.restore(); }
    });
  }

  test('the spawn callback rejects an unowned profile, shell expansion, and a shared process group', () => {
    const profile = path.join(root, 'profile');
    const childProcess = require('node:child_process');
    const observer = observeBrowserLaunches(new Map([[process.execPath, profile]]));
    try {
      for (const [selected, detached, shell] of [[path.join(root, 'other'), true, false], [profile, false, false], [profile, true, true]]) {
        expect(() => childProcess.spawn(process.execPath, ['--remote-debugging-pipe', '--user-data-dir=' + selected], { detached, shell, stdio: ['ignore', 'pipe', 'pipe', 'pipe', 'pipe'] }))
          .toThrow('browser_launch_policy_rejected');
      }
      expect(() => childProcess.spawn(process.execPath, ['--remote-debugging-pipe', '--user-data-dir=' + profile, '--user-data-dir=' + path.join(root, 'other')],
        { detached: true, shell: false, stdio: ['ignore', 'pipe', 'pipe', 'pipe', 'pipe'] })).toThrow('browser_launch_policy_rejected');
      expect(() => childProcess.spawn(process.execPath, ['--remote-debugging-pipe', '--user-data-dir=' + profile],
        { detached: true, shell: false, stdio: 'inherit' })).toThrow('browser_launch_policy_rejected');
      expect(observer.children).toHaveLength(0);
    } finally { observer.restore(); }
  });
});
