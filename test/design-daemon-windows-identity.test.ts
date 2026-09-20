import { expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { pathToFileURL } from 'node:url';

test('Windows daemon identity uses the queried command line and fails closed on missing or failed queries', () => {
  // Keep the native-platform adapter and module mock outside the parent shard.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'design-windows-identity-'));
  try {
    const script = path.join(dir, 'identity.test.ts');
    const stateModule = pathToFileURL(path.resolve(import.meta.dir, '../design/src/daemon-state.ts')).href;
    fs.writeFileSync(script, `
import { expect, mock, test } from 'bun:test';
let commandLine = '"C:\\\\Program Files\\\\bun.exe" daemon.ts --gstack-design-daemon';
let queryFails = false;
const calls = [];
mock.module('child_process', () => ({ execFileSync(command, args, options) {
  calls.push({ command, args, options });
  if (queryFails) throw new Error('query failed');
  return commandLine;
} }));
const { verifyIdentity, readCmdline, CMDLINE_MARKER } = await import(${JSON.stringify(stateModule)});
Object.defineProperty(process, 'platform', { value: 'win32' });
test('actual identity gate consumes the native query and rejects negative controls', () => {
  expect(verifyIdentity(process.pid, CMDLINE_MARKER)).toBe(true);
  expect(calls).toHaveLength(1);
  expect(calls[0].command).toBe('powershell.exe');
  expect(calls[0].args).toContain('-NoProfile');
  expect(calls[0].args).toContain('-NonInteractive');
  expect(calls[0].args.at(-1)).toContain('ProcessId = ' + process.pid);
  expect(calls[0].options.timeout).toBeGreaterThan(0);
  expect(calls[0].options.timeout).toBeLessThanOrEqual(2000);
  expect(verifyIdentity(process.pid, CMDLINE_MARKER, 123)).toBe(true);
  expect(calls.at(-1).options.timeout).toBe(123);
  const boundedCount = calls.length;
  for (const timeout of [0, -1, NaN, Infinity]) expect(readCmdline(process.pid, timeout)).toBe('');
  expect(calls).toHaveLength(boundedCount);
  commandLine = 'unrelated-process.exe';
  expect(verifyIdentity(process.pid, CMDLINE_MARKER)).toBe(false);
  commandLine = '';
  expect(verifyIdentity(process.pid, CMDLINE_MARKER)).toBe(false);
  queryFails = true;
  expect(verifyIdentity(process.pid, CMDLINE_MARKER)).toBe(false);
  const count = calls.length;
  for (const pid of [0, -1, NaN, Infinity, 1.5]) expect(readCmdline(pid)).toBe('');
  expect(calls).toHaveLength(count);
});
`);
    const result = Bun.spawnSync([process.execPath, 'test', script], {
      env: process.env, timeout: 10_000,
    });
    expect(result.exitCode, result.stdout.toString() + result.stderr.toString()).toBe(0);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
