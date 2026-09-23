const fs = require('node:fs');
const cp = require('node:child_process');
const { createHash } = require('node:crypto');
const path = require('node:path');

module.exports = ({ observation, playwrightEntry, mode = 'normal-close', inspectCommandLine = false }) => {
  const originalSpawn = cp.spawn;
  let inspected = Promise.resolve();
  cp.spawn = function(command, args, options) {
    const child = originalSpawn.call(this, command, args, options);
    const evidence = {
      command, args, pid: child.pid,
      argsHash: createHash('sha256').update(JSON.stringify(args)).digest('hex'),
      envHash: createHash('sha256').update(JSON.stringify(Object.entries(options.env || {}).sort(([a], [b]) => a.localeCompare(b)))).digest('hex'),
      stderrBytes: 0,
      reasons: [],
      runtime: { node: process.version, bun: process.versions.bun || null, architecture: process.arch },
    };
    const publish = () => fs.writeFileSync(observation, JSON.stringify(evidence));
    publish();
    let tail = '';
    child.stderr?.on('data', chunk => {
      evidence.stderrBytes += chunk.length;
      if (evidence.stderrBytes > 65536) return;
      const text = tail + chunk.toString('utf8');
      const patterns = {
        job_assignment_failed: /AssignProcessToJobObject|failed to (?:assign|create).*job object/i,
        sandbox_failed: /sandbox.*(?:failed|error)|SBOX_FATAL/i,
        profile_locked: /ProcessSingleton|profile.*in use/i,
        default_profile_policy: /remote debugging requires a non-default data directory/i,
        permission_denied: /access is denied|ERROR_ACCESS_DENIED|permission denied/i,
        crashpad_failed: /crashpad.*(?:failed|error)/i,
        missing_dependency: /specified module could not be found|0xc0000135/i,
      };
      for (const [reason, pattern] of Object.entries(patterns)) {
        if (pattern.test(text) && !evidence.reasons.includes(reason)) evidence.reasons.push(reason);
      }
      tail = text.slice(-512);
      publish();
    });
    child.once('exit', (code, signal) => { evidence.exitCode = code; evidence.signal = signal; publish(); });
    child.once('error', error => {
      evidence.spawnError = ['ENOENT', 'EACCES', 'EPERM', 'EINVAL'].includes(error.code) ? error.code : 'spawn_failed';
      publish();
    });
    if (inspectCommandLine && process.platform === 'win32' && Number.isInteger(child.pid)) {
      inspected = new Promise(resolve => {
        const script = fs.readFileSync(path.join(__dirname, 'native-cookie-command-line.ps1'), 'utf8');
        const probe = originalSpawn(path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'), [
          '-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64'),
        ], {
          env: { ...options.env, GSTACK_NATIVE_BROWSER_PID: String(child.pid), GSTACK_NATIVE_OWNER_PID: String(process.pid), GSTACK_NATIVE_BROWSER_IMAGE: command },
          stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true,
        });
        let output = '';
        let stderrBytes = 0;
        const timer = setTimeout(() => probe.kill(), 5_000);
        probe.stdout.on('data', chunk => { output += chunk.toString('utf8'); if (output.length > 16384) probe.kill(); });
        probe.stderr.on('data', chunk => { stderrBytes += chunk.length; });
        probe.once('error', () => { evidence.observedCommandLine = { available: false, reason: 'probe_spawn_failed' }; });
        probe.once('close', code => {
          clearTimeout(timer);
          try {
            const measured = JSON.parse(output);
            const expectedHashes = args.map(arg => createHash('sha256').update(arg).digest('hex'));
            const dataDir = args.find(arg => arg.startsWith('--user-data-dir='))?.slice(16);
            evidence.observedCommandLine = {
              available: measured.available === true,
              parentMatched: measured.parentMatched === true,
              imageMatched: measured.imageMatched === true,
              reason: ['not_windows', 'owned_process_unavailable', 'command_line_probe_failed'].includes(measured.reason) ? measured.reason : undefined,
              commandLineHash: /^[a-f0-9]{64}$/.test(measured.commandLineHash) ? measured.commandLineHash : undefined,
              argumentsMatchRequested: measured.available === true && JSON.stringify(measured.argumentHashes) === JSON.stringify(expectedHashes),
              userDataDirCount: Number.isInteger(measured.userDataDirCount) && measured.userDataDirCount >= 0 && measured.userDataDirCount <= 128 ? measured.userDataDirCount : undefined,
              userDataDirMatchesRequested: typeof dataDir === 'string' && measured.userDataDirHash === createHash('sha256').update(dataDir).digest('hex'),
              pipePresent: measured.pipePresent === true,
              observerJobLimitFlags: Number.isInteger(measured.observerJobLimitFlags) ? measured.observerJobLimitFlags : undefined,
              observerJobQueryError: Number.isInteger(measured.observerJobQueryError) ? measured.observerJobQueryError : undefined,
              exitCode: code, stderrBytes,
            };
          } catch {
            evidence.observedCommandLine = { available: false, reason: 'probe_no_receipt', exitCode: code, stderrBytes };
          }
          publish();
          resolve();
        });
      });
    }
    return child;
  };
  const { chromium } = require(playwrightEntry);
  return { chromium: { async launchPersistentContext(root, options) {
    const context = await chromium.launchPersistentContext(root, options);
    await inspected;
    await context.addCookies([{ name: 'synthetic', value: 'synthetic', domain: 'example.test', path: '/' }]);
    if (mode === 'stalled-close') context.close = () => { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0); };
    return context;
  } } };
};
