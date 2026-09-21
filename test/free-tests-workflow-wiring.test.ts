/**
 * Static tripwire for .github/workflows/free-tests.yml — the Linux free-suite
 * lane. Pins the three properties that made the lane worth having:
 *
 *   1. It invokes the CANONICAL runner (bun run test:free), not a raw
 *      `bun test <dirs>` glob — the runner owns TEST_ROOTS and strict-output
 *      classification, so a truncated run can't report green.
 *   2. It is SECRETLESS: free tests make no API calls, and keeping keys out
 *      means fork PRs get real signal here. Any `secrets.` reference is a
 *      regression.
 *   3. It triggers on `pull_request` (never `pull_request_target`, which
 *      would hand a fork PR the base repo's context).
 *
 * Same wiring-tripwire class as test/hermetic-wiring.test.ts.
 */

import { describe, test, expect } from 'bun:test';
import * as fs from 'fs';
import * as path from 'path';

const WORKFLOW = path.resolve(import.meta.dir, '..', '.github', 'workflows', 'free-tests.yml');

describe('free-tests workflow wiring', () => {
  const source = fs.readFileSync(WORKFLOW, 'utf-8');

  test('workflow exists and invokes the canonical runner', () => {
    expect(source).toContain('bun run test:free');
    expect(source).not.toMatch(/run:\s*bun test\s/);
  });

  test('secretless: no secrets reach the free lane', () => {
    expect(source).not.toContain('secrets.');
    expect(source).not.toContain('ANTHROPIC_API_KEY');
    expect(source).not.toContain('OPENAI_API_KEY');
  });

  test('pull_request trigger, never pull_request_target', () => {
    expect(source).toContain('pull_request:');
    expect(source).not.toContain('pull_request_target');
  });

  test('the isolated matrix consumes one plan and the required aggregate verifies all receipts', () => {
    const workflow = Bun.YAML.parse(source) as any;
    const planner = workflow.jobs['free-plan'];
    const suite = workflow.jobs['free-suite'];
    const aggregate = workflow.jobs['free-tests'];
    expect(planner.steps.find((step: any) => step.id === 'plan').run).toContain('--ci-plan');
    expect(suite.needs).toBe('free-plan');
    expect(suite.strategy.matrix).toBe('${{ fromJSON(needs.free-plan.outputs.matrix) }}');
    expect(suite.strategy['fail-fast']).toBe(false);
    expect(suite.strategy['max-parallel']).toBe(20);
    expect(suite.steps.find((step: any) => step.name === 'Run free suite').run).toContain('--ci-run');
    expect(suite.steps.find((step: any) => step.name === 'Upload strict shard result').if).toBe('always()');
    expect(aggregate.if).toBe('always()');
    expect(aggregate.needs).toContain('free-suite');
    expect(aggregate.steps.some((step: any) => step.run?.includes('--ci-verify'))).toBe(true);
    expect(source).not.toContain('--quick');
  });

  test('flake telemetry stays wired: retry flag, single-writer ledger, unconditional artifact', () => {
    // WS1: a timing flake must not red the required lane, but every
    // flaky-pass must be recorded and uploaded — a green run is exactly when
    // the evidence matters. Removing any of these silently returns flakes to
    // either merge-blocking (flag off) or invisibility (ledger/artifact off).
    expect(source).toMatch(/GSTACK_FREE_RETRY_FLAKY:\s*"1"/);
    expect(source).toMatch(/GSTACK_FLAKE_LEDGER:\s*\$\{\{ runner\.temp \}\}\/flake-ledger\.jsonl/);
    expect(source).toContain('name: flake-ledger');
    expect(source).toMatch(/name: Upload flake ledger\s*\n\s*if: always\(\)/);
  });

  test('least-privilege token: contents read-only, credentials not persisted', () => {
    // The job executes PR-controlled code (install lifecycle scripts + the
    // suite itself). A default-grant GITHUB_TOKEN persisted into .git/config
    // by checkout would hand that code whatever the repo default allows.
    expect(source).toMatch(/permissions:\s*\n\s*contents:\s*read/);
    expect(source).toMatch(/persist-credentials:\s*false/);
  });
});
