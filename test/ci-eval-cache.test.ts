import { expect, test } from 'bun:test';
import { readFileSync, writeFileSync, mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';

const workflow = (name: string) => Bun.YAML.parse(readFileSync(resolve(import.meta.dir, '../.github/workflows', name), 'utf8')) as any;
const paid = workflow('evals.yml');
const periodic = workflow('evals-periodic.yml');

test('only PR runs select the fast profile; manual and scheduled coverage stays fresh and full', () => {
  expect(paid.env.EVALS_PROFILE).toBe("${{ github.event_name == 'pull_request' && 'pr' || 'full' }}");
  expect(paid.env.EVALS_FRESH).toBe("${{ github.event_name == 'workflow_dispatch' && '1' || '' }}");
  expect(periodic.env).toMatchObject({ EVALS_PROFILE: 'full', EVALS_FRESH: '1', EVALS_CACHE_PURPOSE: 'periodic' });
  expect(periodic.on.schedule.length).toBeGreaterThan(0);
  expect(periodic.on).toHaveProperty('workflow_dispatch');
  for (const tier of ['gate', 'periodic']) {
    const plans = periodic.jobs['plan-slices'].steps.filter((s: any) => s.run?.includes(`--tier ${tier} --emit-plan`));
    expect(plans).toHaveLength(1);
    expect(plans[0].env.EVALS_ALL).toBe('1');
  }
});

test('receipt transport restores only this repository and PR with no broad fallback key', () => {
  const steps = paid.jobs['eval-slices'].steps;
  const restore = steps.filter((s: any) => s.uses?.startsWith('actions/cache/restore@'));
  const save = steps.filter((s: any) => s.uses?.startsWith('actions/cache/save@'));
  expect(restore).toHaveLength(1);
  expect(save).toHaveLength(1);
  expect(restore[0].if).toBe("github.event_name == 'pull_request'");
  expect(restore[0].with['restore-keys']).toBe('eval-input-v1-${{ github.repository_id }}-pr-${{ github.event.pull_request.number }}-');
  expect(save[0].with.key).toBe(restore[0].with.key);
  expect(save[0].with.key).toContain('${{ github.run_id }}-${{ github.run_attempt }}-${{ matrix.slice }}');
  expect(save[0].with.path).toBe('/tmp/gstack-eval-input-cache');
  expect(save[0].if).toContain("steps.receipts.outputs.present == 'true'");
  expect(paid.jobs['eval-slices'].permissions).toEqual({ contents: 'read', packages: 'read' });
  expect(JSON.stringify(periodic)).not.toContain('actions/cache/');
});

test('the judge binds cache receipts to the PR and installed runtime, not the commit cache key', () => {
  const runtime = paid.jobs['build-image'].steps.find((s: any) => s.id === 'runtime');
  expect(runtime.run).toContain('docker manifest inspect "$EVAL_IMAGE"');
  expect(runtime.run).toContain('sha256sum /tmp/eval-runtime-manifest.json');
  const run = paid.jobs['eval-slices'].steps.find((s: any) => s.run?.includes('--plan /tmp/paid-plan/manifest.json'));
  expect(run.env).toMatchObject({
    EVALS_CACHE_DIR: '/tmp/gstack-eval-input-cache',
    EVALS_CACHE_REPOSITORY: '${{ github.repository }}',
    EVALS_CACHE_PR: '${{ github.event.pull_request.number }}',
    EVALS_CACHE_RUNTIME_ID: '${{ needs.build-image.outputs.runtime-id }}',
  });
});

test.skipIf(!Bun.which('jq') || !Bun.which('bash'))('only a new passing producer can publish the next cache snapshot', () => {
  const directory = mkdtempSync(join(tmpdir(), 'ci-cache-producer-'));
  const receipts = join(directory, 'receipts');
  const output = join(directory, 'output');
  mkdirSync(receipts);
  const step = paid.jobs['eval-slices'].steps.find((s: any) => s.id === 'receipts');
  const script = step.run.replaceAll('/tmp/gstack-eval-input-cache', receipts);
  const run = () => {
    writeFileSync(output, '');
    const result = spawnSync('bash', ['-e', '-c', script], {
      env: { ...process.env, GITHUB_OUTPUT: output, GITHUB_RUN_ID: '42', GITHUB_RUN_ATTEMPT: '2' },
      encoding: 'utf8', timeout: 5000,
    });
    expect(result.status, result.stderr).toBe(0);
    return readFileSync(output, 'utf8');
  };
  try {
    expect(run()).toBe('');
    writeFileSync(join(receipts, 'old.json'), JSON.stringify({ proof: { source: { runId: '41/1' } } }));
    writeFileSync(join(receipts, 'corrupt.json'), '{');
    expect(run()).toBe('');
    writeFileSync(join(receipts, 'prior-attempt.json'), JSON.stringify({ proof: { source: { runId: '42/1' } } }));
    expect(run()).toBe('');
    writeFileSync(join(receipts, 'fresh.json'), JSON.stringify({ proof: { source: { runId: '42/2' } } }));
    expect(run()).toBe('present=true\n');
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test.skipIf(!Bun.which('jq'))('the actual comment separates reused evidence, retry outcomes and deferred coverage', () => {
  const comment = paid.jobs['slices-comment'].steps.find((s: any) => s.name === 'Post PR comment').run as string;
  const evaluate = (filter: string, value: unknown) => {
    const result = spawnSync('jq', ['-r', filter], { input: JSON.stringify(value), encoding: 'utf8', timeout: 5000 });
    expect(result.status, result.stderr).toBe(0);
    return result.stdout.trim();
  };
  const stats = comment.match(/STATS=\$\(jq -r '([^']+)'/)![1]!;
  expect(evaluate(stats, { tests: [
    { name: 'retry', passed: false }, { name: 'retry', passed: true },
    { name: 'exhausted', passed: false }, { name: 'exhausted', passed: false },
    { name: 'regressed', passed: true }, { name: 'regressed', passed: false },
    { name: 'reused', passed: true, execution: 'reused' },
  ], flaky_retries: ['retry', 'exhausted', 'regressed'].map(name => ({ name, attempts: 2 })) })).toBe('4 2 2 3 3 1');
  expect(comment).toContain("printf ' | ⚠ %s cases with multiple attempts'");
  expect(comment).not.toMatch(/flaky pass\(es\)|passed only on retry|not blocking/);
  const coverage = comment.match(/COVERAGE=\$\(jq -r '([^']+)'/)![1]!;
  const text = evaluate(coverage, { profile: 'pr', selection: { e2e: ['probe'], judges: ['judge'] },
    prCoverage: { mode: 'pr', deferred: [{ id: 'broad' }], deferredPromptFiles: ['health/SKILL.md'] } });
  expect(text).toContain('selected behaviors: 1, judges: 1');
  expect(text).toContain('1 behaviors and 1 changed prompt files');
  expect(text).toContain('receive no PR-pass credit');
  expect(comment).not.toContain('diff-selected gate census');
});
