/**
 * /plan-design-review with UI scope (gate, paid, real-PTY).
 *
 * Counterpart to the existing no-UI early-exit test. When the input plan
 * DOES describe UI changes, /plan-design-review must NOT early-exit and
 * must reach a real skill numbered-option AskUserQuestion (its first design-rating
 * question), with the captured evidence NOT echoing the early-exit phrase.
 *
 * Why: today we only test the negative path (no-UI → early-exit). A
 * regression that flips the UI-detection logic — making EVERY plan early-
 * exit — would pass the no-UI test (vacuously) and ship undetected. This
 * test is the positive coverage.
 *
 */

import { test } from 'bun:test';
import { PTY_MS } from './helpers/eval-budgets';
import { describeE2ETier } from './helpers/e2e-gate';
import * as fs from 'node:fs';
import * as path from 'path';
import {
  runPlanSkillCounting,
  designStep0Boundary,
  nativePlanCallFingerprint,
} from './helpers/claude-pty-runner';
import { isDesignCountSetup, isDesignCompletionHandoff, pickDesignCountQuestion } from './helpers/design-count-review';
import { isDesignArtifactGeneration } from './helpers/design-artifact-question';
import { isDesignUIScopeReview } from './helpers/design-ui-scope';

const describeE2E = describeE2ETier('gate');

const ROOT = path.resolve(import.meta.dir, '..');
const FIXTURE = path.join(ROOT, 'test', 'fixtures', 'plans', 'ui-heavy-feature.md');

describeE2E('/plan-design-review with UI scope (gate)', () => {
  test(
    'reaches a real skill AskUserQuestion (or plan_ready) without echoing the no-UI early-exit phrase',
    async () => {
      const observation = await runPlanSkillCounting({
        skillName: 'plan-design-review',
        slashCommand: '/plan-design-review PLAN.md',
        followUpPrompt: fs.readFileSync(FIXTURE, 'utf8'),
        isLastStep0AUQ: designStep0Boundary,
        isFirstReviewAUQ: isDesignUIScopeReview,
        isReviewAUQ: isDesignUIScopeReview,
        isSetupAUQ: isDesignCountSetup,
        isCompletionHandoffAUQ: isDesignCompletionHandoff,
        isArtifactGenerationAUQ: isDesignArtifactGeneration,
        pickAUQ: pickDesignCountQuestion,
        reviewCountCeiling: 1,
        timeoutMs: 600_000,
      });
      const designQuestionObserved = observation.fingerprints.some(fp =>
        !fp.preReview && !fp.administrative && fp.nativeCall &&
        isDesignUIScopeReview(nativePlanCallFingerprint(fp.nativeCall, fp.observedAtMs, fp.preReview)));
      if ((observation.outcome !== 'ceiling_reached' && observation.outcome !== 'plan_ready') ||
          observation.reviewCount < 1 || !designQuestionObserved) {
        throw new Error(
          `plan-design-review with UI scope FAILED: outcome=${observation.outcome}\n` +
            `step0=${observation.step0Count} review=${observation.reviewCount}\n` +
            `${observation.summary}\n--- questions ---\n${JSON.stringify(observation.fingerprints, null, 2)}\n` +
            `--- evidence ---\n${observation.evidence}`,
        );
      }
      const NO_UI_PHRASE = /no\s+UI\s+scope|isn'?t\s+applicable/i;
      if (NO_UI_PHRASE.test(observation.evidence)) {
        throw new Error(
          `plan-design-review early-exited despite UI-heavy fixture.\n` +
            `--- evidence (last 3KB) ---\n${observation.evidence}`,
        );
      }
    },
    PTY_MS,
  );
});
