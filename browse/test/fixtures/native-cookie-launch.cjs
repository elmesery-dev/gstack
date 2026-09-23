const fs = require('node:fs');
const cp = require('node:child_process');
const { createHash } = require('node:crypto');

module.exports = ({ observation, playwrightEntry, mode = 'normal-close' }) => {
  const originalSpawn = cp.spawn;
  cp.spawn = function(command, args, options) {
    const child = originalSpawn.call(this, command, args, options);
    const evidence = {
      command, args, pid: child.pid,
      argsHash: createHash('sha256').update(JSON.stringify(args)).digest('hex'),
      envHash: createHash('sha256').update(JSON.stringify(Object.entries(options.env || {}).sort(([a], [b]) => a.localeCompare(b)))).digest('hex'),
      stderrBytes: 0,
      reasons: [],
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
    return child;
  };
  const { chromium } = require(playwrightEntry);
  return { chromium: { async launchPersistentContext(root, options) {
    const context = await chromium.launchPersistentContext(root, options);
    await context.addCookies([{ name: 'synthetic', value: 'synthetic', domain: 'example.test', path: '/' }]);
    if (mode === 'stalled-close') context.close = () => { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0); };
    return context;
  } } };
};
