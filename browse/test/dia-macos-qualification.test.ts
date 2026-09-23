import { afterAll, describe, expect, test } from 'bun:test';
import { createRequire } from 'node:module';
import { spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { Database } from 'bun:sqlite';
import {
  allowedFixturePage, captureUserKeychains, DIA_DOWNLOAD, nativeDiaLaunchOptions, observeBrowserLaunches,
  parseDefaultKeychain, parseKeychainPaths, validateQualificationHost,
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
