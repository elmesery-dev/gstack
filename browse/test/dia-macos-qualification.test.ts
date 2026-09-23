import { afterAll, describe, expect, spyOn, test } from 'bun:test';
import { createRequire } from 'node:module';
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { Database } from 'bun:sqlite';
import {
  allowedFixturePage, browserPreflightError, browserStartupCategory, captureUserKeychains, DIA_DOWNLOAD, fixtureKeychainRestoreCommands, nativeDiaLaunchOptions, observeBrowserLaunches,
  observeFixtureKeychain, parseDefaultKeychain, parseKeychainPaths, playwrightModuleLoadFacts, prepareKeychainHome, validateQualificationHost,
} from '../../.github/scripts/qualify-dia-macos';
import { ARCHIVE_CHECK, PRIVATE_RECEIPT_READ, freshLaunchDefinition, ownsFreshAccount, ownsLaunchService, parseDirectoryRecord } from '../../.github/scripts/run-dia-native-qualification';

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
    const profile = path.join(home, 'Library/Application Support/Dia/User Data/Default');
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
