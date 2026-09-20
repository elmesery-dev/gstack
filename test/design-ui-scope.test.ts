import { expect, test } from 'bun:test';
import { nativePlanCallFingerprint } from './helpers/claude-pty-runner';
import { isDesignUIScopeReview } from './helpers/design-ui-scope';
import type { NativePlanQuestionCall } from './helpers/plan-count-transcript';
import captured from './fixtures/plan-design-ui-scope.json';
import { E2E_TOUCHFILES } from './helpers/touchfiles-data';

const calls = captured.calls as NativePlanQuestionCall[];
const fingerprint = (call: NativePlanQuestionCall) => nativePlanCallFingerprint(call, 0, true);

test('the captured untagged dashboard decision proves UI review, but its setup questions do not', () => {
  expect(calls.map(call => isDesignUIScopeReview(fingerprint(call)))).toEqual([false, false, false, true]);
  expect(calls[3]!.questions[0]!.question).not.toContain('<gstack-qid:');
});

test('native ownership and complete offered answers are required for UI evidence', () => {
  for (const mutate of [
    (call: NativePlanQuestionCall) => { call.answered = false; },
    (call: NativePlanQuestionCall) => { call.failed = true; },
    (call: NativePlanQuestionCall) => { call.unansweredQuestionIndices = [0]; },
    (call: NativePlanQuestionCall) => { call.answers = {}; },
    (call: NativePlanQuestionCall) => { call.answers = { [call.questions[0]!.question]: 'Unrelated answer' }; },
    (call: NativePlanQuestionCall) => { call.questions[0]!.multiSelect = true; },
    (call: NativePlanQuestionCall) => { call.questions[0]!.options = call.questions[0]!.options.slice(0, 1); },
  ]) {
    const call = structuredClone(calls[3]!);
    mutate(call);
    expect(isDesignUIScopeReview(fingerprint(call))).toBe(false);
  }
  expect(isDesignUIScopeReview({ ...fingerprint(calls[3]!), signature: 'another-session:another-call' })).toBe(false);
});

test('issue-like framing cannot promote setup, examples, another plan, or mismatched choices', () => {
  for (const mutate of [
    (q: NativePlanQuestionCall['questions'][number]) => { q.header = 'Outside voices'; },
    (q: NativePlanQuestionCall['questions'][number]) => { q.question = 'Example:\n' + q.question; },
    (q: NativePlanQuestionCall['questions'][number]) => { q.question = q.question.replace('PLAN.md', 'OTHER.md'); },
    (q: NativePlanQuestionCall['questions'][number]) => { q.question = q.question.replace('Pass 1', 'before Pass 1'); },
    (q: NativePlanQuestionCall['questions'][number]) => { q.question = q.question.replace("Which panel is primary, and what's the order?", 'Which review scope should cover the panels?'); },
    (q: NativePlanQuestionCall['questions'][number]) => { q.options[1]!.label = '2B: Another issue'; },
    (q: NativePlanQuestionCall['questions'][number]) => { q.options[1]!.label = '1B: Run outside reviewers'; },
    (q: NativePlanQuestionCall['questions'][number]) => { q.options[1]!.label = q.options[0]!.label; },
  ]) {
    const call = structuredClone(calls[3]!);
    const q = call.questions[0]!;
    mutate(q);
    call.answers = { [q.question]: q.options[0]!.label };
    expect(isDesignUIScopeReview(fingerprint(call))).toBe(false);
  }
});

test('the UI gate owns its classifier, captured evidence, and regression tests', () => {
  for (const file of ['test/helpers/design-ui-scope.ts', 'test/design-ui-scope.test.ts', 'test/fixtures/plan-design-ui-scope.json']) {
    expect(Object.entries(E2E_TOUCHFILES).filter(([, files]) => files.includes(file)).map(([owner]) => owner))
      .toEqual(['plan-design-with-ui-scope']);
  }
});
