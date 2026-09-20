import { describe, expect, test } from 'bun:test';
import { capturePlanCountQuestion, nativePlanCallFingerprint } from './helpers/claude-pty-runner';
import { pickDesignCountOutsideVoices } from './helpers/design-count-outside';
import { isDesignCountFirstReview } from './helpers/design-count-review';
import type { NativePlanQuestionCall } from './helpers/plan-count-transcript';

const packet: NativePlanQuestionCall = {
  "sessionId": "52868766-97d8-4406-8230-4f263be36546",
  "toolUseId": "toolu_013ghrvY7M8hMrMHox3tnJLn",
  "questions": [
    {
      "question": "D3 (Step 0D) — I've rated this plan 5/10 on design completeness. The three biggest gaps are: (1) the 5 identified implementation gaps describe the problem but not the solution, (2) no explicit state coverage table, (3) no user journey emotional arc. I'll skip mockups and review all 7 dimensions as you requested. Any specific areas to prioritize, or cover all 7 equally? <gstack-qid:plan-design-focus>",
      "header": "Focus areas",
      "multiSelect": false,
      "options": [
        {
          "label": "Cover all 7 equally (Recommended)",
          "description": "Standard review: all 7 design dimensions get full treatment. Takes longer but produces a complete plan."
        },
        {
          "label": "Focus on the 5 identified gaps first",
          "description": "Prioritize Pass 5 (Design System Alignment) to close the gap descriptions into actionable specs, then cover remaining passes more quickly."
        },
        {
          "label": "Prioritize accessibility and states",
          "description": "Focus on Pass 2 (Interaction States) and Pass 6 (Responsive/A11y), since the form has sensitive UX requirements (ARIA, contrast, keyboard)."
        }
      ]
    },
    {
      "question": "D4 — Want outside design voices before the detailed review? Codex evaluates against OpenAI's design hard rules + litmus checks; a Claude subagent does an independent completeness review. (Requires Codex CLI to be installed.) <gstack-qid:outside-voices-design>",
      "header": "Outside voices",
      "multiSelect": false,
      "options": [
        {
          "label": "Yes, run outside design voices",
          "description": "Launches Codex design critique + Claude subagent completeness review in parallel before the 7 passes. Adds 1–2 minutes."
        },
        {
          "label": "No, proceed without (Recommended)",
          "description": "Skip outside voices and go straight to the 7 review passes. Faster; sufficient for most plans."
        }
      ]
    }
  ],
  "answered": false,
  "failed": false
};

function screen(index: number, call = packet) {
  const q = call.questions[index]!;
  return '← ☐ Focus areas ☐ Outside voices ✔ Submit →\n│ ' + q.question + '\n' +
    q.options.map((option, i) => (i === 0 ? '❯' : '') + `${i + 1}. ${option.label}`).join('\n') +
    '\nEnter to select · Tab/Arrow keys to navigate · Esc to cancel\n';
}

describe('Design count fixture outside-review choice', () => {
  test('the captured focus tab stays unchanged and only its outside-review tab declines', () => {
    const seen = new Set<string>();
    const focus = capturePlanCountQuestion(screen(0), seen, 0, true, packet)!;
    expect(pickDesignCountOutsideVoices(focus, focus)).toBeNull();
    const outside = capturePlanCountQuestion(screen(1), seen, 1, true, packet)!;
    expect(pickDesignCountOutsideVoices(outside, outside)).toBe(2);
    expect(capturePlanCountQuestion(screen(1), seen, 2, true, packet)).toBeNull();
    expect(pickDesignCountOutsideVoices(nativePlanCallFingerprint(packet, 0, true), focus)).toBeNull();
  });

  test('the current opt-in question remains recognizable when native metadata arrives after the answer', () => {
    const fp = capturePlanCountQuestion(screen(1), new Set(), 0, true)!;
    expect(fp.nativeCall).toBeUndefined();
    expect(pickDesignCountOutsideVoices(fp, fp), fp.promptSnippet).toBe(2);
    const focus = capturePlanCountQuestion(screen(0), new Set(), 0, true)!;
    expect(pickDesignCountOutsideVoices(focus, focus)).toBeNull();
  });

  test('single questions and reversed choices still select only the explicit No action', () => {
    for (const reverse of [false, true]) {
      const call = structuredClone(packet);
      call.questions = [call.questions[1]!];
      if (reverse) call.questions[0]!.options.reverse();
      const fp = nativePlanCallFingerprint(call, 0, true);
      expect(pickDesignCountOutsideVoices(fp, fp)).toBe(reverse ? 1 : 2);
    }
  });

  test('pending packet metadata without the matching active question cannot steer a choice', () => {
    const fp = nativePlanCallFingerprint(packet, 0, true);
    expect(pickDesignCountOutsideVoices(fp, fp)).toBeNull();
    const outside = capturePlanCountQuestion(screen(1), new Set(), 0, true, packet)!;
    expect(pickDesignCountOutsideVoices(outside, { ...outside, signature: 'unrelated' })).toBeNull();
    for (const mutate of [
      (call: NativePlanQuestionCall) => { call.answered = true; },
      (call: NativePlanQuestionCall) => { call.failed = true; },
      (call: NativePlanQuestionCall) => { call.questions[1]!.multiSelect = true; },
      (call: NativePlanQuestionCall) => { call.questions[1]!.question = 'Should the product ask customers to use outside design voices?'; },
      (call: NativePlanQuestionCall) => { call.questions[1]!.question = call.questions[1]!.question.replace('outside-voices-design', 'design-review-finding'); },
      (call: NativePlanQuestionCall) => { call.questions[1]!.options[1]!.label = 'No, leave the design defect unfixed'; },
      (call: NativePlanQuestionCall) => { call.questions[1]!.options.push({ label: 'Change the design now' }); },
    ]) {
      const call = structuredClone(packet);
      mutate(call);
      expect(pickDesignCountOutsideVoices(outside, { ...outside, nativeCall: call })).toBeNull();
    }
  });

  test('the binary outside-voices variant still selects only its explicit opt-out', () => {
    for (const id of ['outside-voices-design', 'plan-design-review-outside-voices']) {
      const call = structuredClone(packet);
      call.questions = [call.questions[1]!];
      const q = call.questions[0]!;
      q.question = `D3 — Want outside voices before the detailed review? <gstack-qid:${id}>`;
      q.options[0]!.label = 'Yes, run outside voices (recommended)';
      const native = nativePlanCallFingerprint(call, 0, true);
      expect(pickDesignCountOutsideVoices(native, native)).toBe(2);
      const visible = capturePlanCountQuestion(screen(0, call), new Set(), 0, true)!;
      expect(pickDesignCountOutsideVoices(visible, visible)).toBe(2);
      q.options[1]!.label = 'No, leave the design defect unfixed';
      const product = nativePlanCallFingerprint(call, 0, true);
      expect(pickDesignCountOutsideVoices(product, product)).toBeNull();
    }
  });

  test('an outside-review opt-in with a design-review-prefixed ID cannot start a finding', () => {
    const call = structuredClone(packet);
    call.questions = [call.questions[1]!];
    const q = call.questions[0]!;
    q.question = 'D3 — Want outside voices before the detailed review?\n' +
      'Project/branch/task: main branch; design review of PLAN.md before the 7 passes. ' +
      '<gstack-qid:plan-design-review-outside-voices>';
    call.answered = true;
    call.unansweredQuestionIndices = [];
    call.answers = { [q.question]: q.options[0]!.label };
    expect(isDesignCountFirstReview(nativePlanCallFingerprint(call, 0, true))).toBe(false);
  });
});
