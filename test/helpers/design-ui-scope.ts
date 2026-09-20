import type { AskUserQuestionFingerprint } from './claude-pty-runner';
import { isDesignCountFirstReview } from './design-count-review';

export function isDesignUIScopeReview(fp: AskUserQuestionFingerprint): boolean {
  const call = fp.nativeCall;
  if (!call?.answered || call.failed || !Array.isArray(call.unansweredQuestionIndices) ||
      call.unansweredQuestionIndices.length || !call.questions.length ||
      fp.signature !== `${call.sessionId}:${call.toolUseId}`) return false;
  if (call.questions.some(q => q.multiSelect || q.options.length < 2 ||
      new Set(q.options.map(option => option.label)).size !== q.options.length ||
      !q.options.some(option => option.label === call.answers?.[q.question]))) return false;
  if (isDesignCountFirstReview(fp)) return true;
  const workflow = /\b(?:review(?:s|ers?)?|scope|setup|learnings|routing|mockups?|permissions?|codex|claude|outside)\b/i;
  const ui = /\b(?:dashboard|hierarchy|panels?|layout|headers?|buttons?|navigation|notifications?|activity|actions?|spacing|colou?rs?|fonts?|typography|loading|errors?|focus|contrast|keyboard|mobile|responsive|toasts?|modals?|empty)\b/i;
  return call.questions.some(q => {
    if (/^(?:scope|focus|learnings|routing|next steps?|outside(?: design)? voices)$/i.test(q.header.trim())) return false;
    const issue = /^(?:D\d+\s*[—–:-]\s*)?Issue ([1-9]\d*)\s*[:—–-]\s*([^\n]+\?)$/i.exec(q.question.split('\n')[0]!.trim());
    if (!issue || workflow.test(issue[2]!) || !ui.test(issue[2]!) ||
        !q.options.some(option => ui.test(`${option.label} ${option.description ?? ''}`))) return false;
    const context = /^Project\/branch\/task:([^\n]*)/mi.exec(q.question)?.[1] ?? '';
    const namedPlans = context.match(/\b[\w.-]+\.md\b/gi) ?? [];
    if ((namedPlans.length && !namedPlans.some(plan => /^PLAN\.md$/i.test(plan))) ||
        /\b(?:before|prior to)\s+Pass\b/i.test(context)) return false;
    const choice = new RegExp(`^${issue[1]}[A-Z](?:[).:—–-]\\s*|\\s+)\\S`);
    return q.options.every(option => choice.test(option.label) && !workflow.test(option.label));
  });
}
