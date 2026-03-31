/**
 * Pure prompt-building functions for the duet extension.
 *
 * Every function here is side-effect free — they build prompt strings
 * from structured inputs. This makes them easy to test and modify
 * independently from orchestration logic.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { runRoot } from "./fs.js";
import type {
	DuetConfig,
	GateEvidence,
	InterventionEntry,
	PlanDraft,
	PlanReview,
	ReviewReport,
} from "./types.js";

// ---------------------------------------------------------------------------
// Shared interfaces re-exported for consumers
// ---------------------------------------------------------------------------

export interface GateRunResult {
	evidence: GateEvidence[];
	gateResults: Array<{ id: string; passed: boolean }>;
	diffNameOnlyPath: string;
	diffPatchPath: string;
	diffCheckPath?: string;
	statusPath: string;
	allPassed: boolean;
	statusPorcelain: string;
}

export interface PlanSummaryReport {
	overview: string;
	stepHighlights: string[];
	risks: string[];
	recommendedNextAction: string;
}

export interface HandoffSummaryReport {
	overview: string;
	decisions: string[];
	constraints: string[];
	openQuestions: string[];
}

export interface PlanningLoopOptions {
	initialReview?: PlanReview;
	startRound?: number;
	maxRounds?: number;
	/** When true, run a planner+critic gap analysis on the raw plan before conversion. */
	preReview?: boolean;
}

// ---------------------------------------------------------------------------
// Role system addenda
// ---------------------------------------------------------------------------

export function roleAddendum(role: "planner" | "critic" | "implementer" | "reviewer" | "relay", config: DuetConfig): string {
	const checkIds = Object.keys(config.checks).join(", ");
	const common = [
		"You are participating in a controller-orchestrated two-agent coding duet.",
		"Use as many tool calls as you need to do thorough work.",
		`Configured check IDs: ${checkIds}.`,
		"",
		"Tool usage reminders:",
		"- The `edit` tool requires `oldText` (exact existing text to find) and `newText` (replacement). Always `read` the file first to get the exact text to match. Do NOT call edit with only a file path.",
		"- Use `write` to create new files or fully overwrite existing ones.",
		"- Use `read` to inspect file contents before editing.",
	];

	if (role === "planner") {
		return [
			...common,
			"",
			"Role: planner.",
			"Explore the codebase to understand the project structure, existing patterns, and conventions.",
			"Produce a concrete, step-by-step implementation plan.",
			"Write the plan JSON to the file path specified in the prompt using the write tool.",
			"On revision rounds, use the edit tool (read the file first, then provide exact oldText and newText) to update only what changed — do not rewrite the whole file.",
			"Each step.requiredChecks must use only configured check IDs.",
			"",
			"Guidelines:",
			"- Follow existing project patterns and conventions you observe in the codebase.",
			"- Keep steps focused and independently verifiable.",
			"- If you see a better approach (library, pattern, architecture) than what the goal implies, note it in the plan description.",
			"- The plan file is the authoritative output. After writing it, briefly summarize your reasoning.",
		].join("\n");
	}

	if (role === "critic") {
		return [
			...common,
			"",
			"Role: plan critic.",
			"Read the plan file, then assess whether it is a reasonable path to the goal.",
			"You may explore the codebase to check feasibility.",
			"",
			"Your default disposition should be to APPROVE. Most plans are good enough to start implementing.",
			"The implementation phase has its own reviewer who catches code-level issues, so the plan does not need to be perfect.",
			"",
			"Only block on issues that would make the plan IMPOSSIBLE or DANGEROUS to implement:",
			"- Steps in fundamentally wrong order (real dependency violations, not theoretical concerns)",
			"- Missing a critical step that cannot be added during implementation",
			"- Plan contradicts how the codebase actually works (wrong files, wrong APIs, wrong architecture)",
			"",
			"Do NOT block on:",
			"- Uncertainty about framework/API behavior (that is discovered during implementation)",
			"- Steps that could be more detailed (the implementer can figure it out)",
			"- Theoretical concerns that have not been verified as real problems",
			"- Style preferences or alternative approaches (mention these as non-blocking suggestions)",
			"",
			"Your goal is not to perfect the plan; it is to either approve it or provide the smallest complete blocker set needed for safe implementation.",
			"If you request changes, list ALL currently known blocking issues in this round.",
			"Do not stop after the first one or two issues, and do not save other known blockers for later rounds.",
			"Prefer the shortest complete blocker list that would make approval likely after the next revision.",
			"Before responding, do a final pass and ask: if the planner fixed only the issues I listed, would I approve? If not, add the missing blockers now.",
			"Include non-blocking suggestions for anything that could improve the plan but should not hold it up.",
			"",
			"End your response with a verdict footer:",
			"Verdict: approve",
			"or",
			"Verdict: changes_requested",
			"Blocking issues:",
			"- only genuinely blocking issues here",
		].join("\n");
	}

	if (role === "implementer") {
		return [
			...common,
			"",
			"Role: implementer.",
			"Implement the code changes described in the current step.",
			"",
			"Guidelines:",
			"- Follow existing project patterns and coding style.",
			"- Run the relevant checks (static analysis, unit tests) to verify your work before finishing.",
			"- If a check fails, investigate: is it caused by your change or was it pre-existing?",
			"  - If your change broke it: fix it.",
			"  - If pre-existing: note it and move on. Do not try to fix unrelated issues.",
			"- Treat reviewer blockers as symptoms, not just a checklist. Look for the underlying root cause and fix the whole defect cluster when it is in scope.",
			"- After fixing an issue, inspect nearby code paths, related branches, helper functions, and duplicated logic for the same bug pattern.",
			"- Before finishing, ask yourself what the reviewer would likely reject next if they independently re-read the code and reran checks. Fix that now if it is in scope.",
			"- If you see a clearly better approach than what the plan describes (better library, simpler pattern), mention it but implement what the plan says unless the improvement is trivial.",
			"- If the step is fundamentally unimplementable as planned (wrong file targets, impossible API, missing prerequisite), explain clearly in your response why the plan needs revision. Do not silently deviate from the plan — the reviewer or controller will handle escalation.",
			"- When done, explain what you changed and why in natural language.",
		].join("\n");
	}

	if (role === "relay") {
		return [
			...common,
			"",
			"Role: relay implementer+reviewer.",
			"You are one of two agents taking turns on this step.",
			"",
			"Your job on each turn:",
			"1. Read the changed files and run tests/checks to understand the current state.",
			"2. If there are MATERIAL defects — bugs, missing required functionality, failing checks, security holes, logic errors — fix them directly.",
			"3. If the step requirements are met and checks pass, APPROVE. This is the expected outcome when prior work is correct.",
			"",
			"Material vs. immaterial changes:",
			"- MATERIAL (fix these): runtime bugs, failing tests, missing step requirements, security issues, broken edge cases, type errors.",
			"- IMMATERIAL (do NOT touch): comment wording, variable naming preferences, code style that passes lint, alternative approaches that aren't clearly better, cosmetic polish.",
			"",
			"Before making ANY change, ask: 'Does this fix a concrete defect, or is it just my preference?' If it is preference, do not make the change.",
			"",
			"Observations — if you notice something outside the current step's scope (a pre-existing issue, a future concern, a style inconsistency), do NOT fix it. Instead, log it as an observation at the end of your response. Observations will be tracked for future steps.",
			"",
			"Observation format (place inside a fenced block after your verdict):",
			"```observations",
			"- [high] path/to/file.tsx: Probable bug — function returns undefined when X is null",
			"- [medium] path/to/other.ts: Missing error handling for API timeout",
			"- [low] path/to/style.css: Stale comment references old theme name",
			"```",
			"Severity guide: high = will likely cause bugs or failures; medium = notable but not urgent; low = nit or cosmetic.",
			"",
			"Guidelines:",
			"- Follow existing project patterns and coding style.",
			"- Run the relevant checks (static analysis, unit tests) to verify your work.",
			"- If a check fails, investigate: your change or pre-existing? Fix yours, note pre-existing.",
			"- Do NOT undo or rewrite the other agent's work unless it is actually broken.",
			"- The step description is your scope boundary. Do not make changes beyond what the step requires.",
			"- When done, explain what you reviewed, what you changed (if anything), and your assessment.",
			"",
			"End your response with a verdict:",
			"Verdict: approve  — the step requirements are met and checks pass. This is the expected outcome when prior work is correct.",
			"Verdict: changes_made  — you found and fixed a concrete defect",
			"",
			"If the step is structurally impossible to complete as planned — wrong sequencing, missing critical prerequisite, assumptions provably wrong given the codebase, or broader refactor required than scoped — you may escalate instead:",
			"Verdict: replan_needed",
			"Escalation reason: <one-line explanation of why the plan needs revision>",
			"Blocking issues:",
			"- specific problems that make this a plan-level issue, not an implementation issue",
			"This is a last resort. Normal code issues should use changes_made. Only escalate when the problem is structural and cannot be resolved within the current step scope.",
		].join("\n");
	}

	// reviewer
	return [
		...common,
		"",
		"Role: reviewer.",
		"Your job is to be a thorough code reviewer — like a senior engineer reviewing a pull request.",
		"You have full tool access: read files, run commands, execute tests. USE THEM.",
		"",
		"What to check:",
		"- Does the code actually work? Read the changed files. Run the tests. Verify the output.",
		"- Are there real bugs — logic errors, off-by-one, null handling, race conditions?",
		"- Does the implementation match the step requirements?",
		"- Does the code follow the project's existing conventions and style?",
		"",
		"What NOT to do:",
		"- Do NOT reject because evidence 'was not provided'. Go get the evidence yourself.",
		"- Do NOT reject for pre-existing issues that were not introduced by this step.",
		"- Do NOT demand things the step description does not require.",
		"- Do NOT act as a compliance auditor checking boxes. Act as an engineer reading code.",
		"- Do NOT nitpick style differences when the code is functionally correct and follows project conventions.",
		"",
		"The step description is your scope boundary. If the step says 'add auth middleware' and the implementer did that correctly, approve it — even if you'd structure the error handling differently.",
		"If all checks pass and the code is correct, approve it.",
		"Reject only for genuine defects that need to be fixed before merging.",
		"Save non-blocking improvement suggestions for a separate section — they should NOT be blocking issues.",
		"Your goal is either approval, or the shortest complete blocker list needed for approval in the next round.",
		"If you request changes, list ALL currently known blocking issues you can identify in this round.",
		"Do not stop after the first issue, and do not intentionally save additional known blockers for later rounds.",
		"Prefer one comprehensive blocking list over several partial reviews.",
		"If multiple defects come from the same underlying issue, prefer one root-cause-oriented blocker over many tiny symptom bullets unless separate fixes are truly required.",
		"Before responding, do a final sweep and ask: if the implementer fixed only the issues I listed, would I approve? If not, add the missing blockers now.",
		"",
		"End your response with a verdict footer:",
		"Verdict: approve",
		"or",
		"Verdict: changes_requested",
		"Blocking issues:",
		"- only real code defects here",
		"",
		"If the step is structurally impossible to complete as planned — wrong sequencing, missing critical prerequisite, assumptions provably wrong given the codebase, or broader refactor required than scoped — you may escalate instead of requesting normal changes:",
		"Verdict: replan_needed",
		"Escalation reason: <one-line explanation of why the plan needs revision>",
		"Blocking issues:",
		"- specific problems that make this a plan-level issue, not an implementation issue",
		"This is a last resort. Normal code issues should use changes_requested. Only escalate when the problem is structural and cannot be resolved by the implementer within the current step scope.",
	].join("\n");
}

// ---------------------------------------------------------------------------
// Plan file helpers
// ---------------------------------------------------------------------------

/** Relative path to the working plan JSON file (for use in prompts — model writes here). */
export function draftPlanRelPath(runId: string): string {
	return `.pi/duet/runs/${runId}/draft-plan.json`;
}

/** Absolute path to the working plan JSON file (for controller to read from disk). */
export function draftPlanAbsPath(cwd: string, runId: string): string {
	return path.join(cwd, draftPlanRelPath(runId));
}

export function planJsonSchema(config: DuetConfig): string {
	const checkIds = Object.keys(config.checks);
	return JSON.stringify(
		{
			goal: "string",
			steps: [{ id: "step-1", title: "string", description: "string", requiredChecks: checkIds }],
		},
		null,
		2,
	);
}

// ---------------------------------------------------------------------------
// Planning prompts
// ---------------------------------------------------------------------------

export function planPrompt(goal: string, config: DuetConfig, planFile: string, priorReview?: PlanReview, researchContextPath?: string): string {
	const checkIds = Object.keys(config.checks);
	const researchLine = researchContextPath
		? `\n\nIMPORTANT: A deep research phase has already been completed. Read the research context at ${researchContextPath} BEFORE exploring the codebase or writing your plan. It contains codebase analysis, web research, and synthesized technical guidance for this goal.\n`
		: "";

	if (priorReview) {
		return [
			`Goal: ${goal}`,
			researchLine,
			`The current plan is in ${planFile}. Read it, address the critique below, then use edit (with exact oldText/newText) or write to update the file in place.`,
			"Only change what needs to change — do not rewrite the whole file.",
			"",
			"Critique to address:",
			JSON.stringify(priorReview, null, 2),
			"",
			`Allowed requiredChecks values: ${checkIds.join(", ")}`,
		].join("\n");
	}
	return [
		`Goal: ${goal}`,
		researchLine,
		`Explore the codebase, then write your plan as JSON to ${planFile}`,
		"Use the write tool to create the file. Schema:",
		planJsonSchema(config),
		"",
		`Allowed requiredChecks values: ${checkIds.join(", ")}`,
	].join("\n");
}

export function planReviewPrompt(goal: string, planFile: string, priorReview?: PlanReview): string {
	const lines = [
		`Original goal: ${goal}`,
		"",
	];

	if (priorReview) {
		lines.push(
			"IMPORTANT: This is a revision round. You previously reviewed this plan and requested changes.",
			"The planner has revised the plan to address your feedback.",
			"You MUST re-read the plan file from disk — do NOT rely on your memory of the previous version.",
			"",
			"Your previous blocking issues were:",
		);
		for (const issue of priorReview.blockingIssues) {
			lines.push(`- ${issue}`);
		}
		lines.push(
			"",
			"For each issue above, verify whether the revised plan actually addresses it.",
			"If an issue is resolved, do not raise it again.",
			"Only block on issues that are still present in the current plan or genuinely new problems you discover.",
			"",
		);
	}

	lines.push(
		`The plan is in ${planFile}. Read it and assess whether it is a workable path to the goal.`,
		"You may explore the codebase to check that the plan targets the right files and APIs.",
		"",
		"Remember: your default should be to approve. Only block if the plan is fundamentally broken.",
		"Your goal is either approval, or the smallest complete blocker set needed for safe implementation.",
		"Suggestions and improvements should go as non-blocking feedback, not blocking issues.",
		"If you request changes, include every currently known blocking issue in this round, not just the first one or two you notice.",
		"Before responding, ask: if the planner fixed only the issues I listed, would I approve? If not, add the missing blockers now.",
		"",
		"End with your verdict:",
		"Verdict: approve",
		"or",
		"Verdict: changes_requested",
		"Blocking issues:",
		"- only issues that make implementation impossible",
	);
	return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Replan prompts
// ---------------------------------------------------------------------------

export function replanPrompt(
	goal: string,
	plan: PlanDraft,
	stepIndex: number,
	config: DuetConfig,
	escalationReason: string,
	planFile: string,
	priorReview?: PlanReview,
): string {
	const checkIds = Object.keys(config.checks);
	const completedSteps = plan.steps.slice(0, stepIndex);
	const remainingSteps = plan.steps.slice(stepIndex);

	const lines = [
		`Goal: ${goal}`,
		"",
		"## Original plan overview:",
		JSON.stringify(
			{
				totalSteps: plan.steps.length,
				stepTitles: plan.steps.map((s, i) => `${i + 1}. ${s.title}`),
			},
			null,
			2,
		),
		"",
		"## Completed steps — DO NOT change these, they are already done:",
	];

	if (completedSteps.length > 0) {
		for (const [i, step] of completedSteps.entries()) {
			lines.push(`${i + 1}. [DONE] ${step.title} (${step.id})`);
		}
	} else {
		lines.push("(none — this is the first step)");
	}

	lines.push(
		"",
		"## Why the current step requires replanning (escalation reason):",
		escalationReason,
		"",
		`## Current step ${stepIndex + 1} and remaining steps that need replanning:`,
	);
	for (const [i, step] of remainingSteps.entries()) {
		const num = stepIndex + i + 1;
		lines.push(`${num}. ${step.title} (${step.id})`);
	}

	if (priorReview) {
		lines.push(
			"",
			`The current replan draft is already in ${planFile}. Read it, address the critique below, then use edit (with exact oldText/newText) or write to update the file in place.`,
			"Only change what needs to change — do not rewrite the whole file.",
			"",
			"Critique to address:",
			JSON.stringify(priorReview, null, 2),
		);
	} else {
		lines.push(
			"",
			`Your task: revise the plan from step ${stepIndex + 1} onward to address the escalation reason.`,
			`Write the complete updated plan (including the completed prefix unchanged) as JSON to ${planFile}`,
			"Use the write tool to create the file.",
		);
	}

	lines.push(
		"",
		"Schema:",
		planJsonSchema(config),
		"",
		`Allowed requiredChecks values: ${checkIds.join(", ")}`,
		"",
		`Important: Do NOT change steps 1–${stepIndex} (they are already completed). Only revise step ${stepIndex + 1} onward.`,
	);

	return lines.join("\n");
}

export function replanReviewPrompt(
	goal: string,
	plan: PlanDraft,
	stepIndex: number,
	escalationReason: string,
	planFile: string,
	priorReview?: PlanReview,
): string {
	const completedCount = stepIndex;
	const completedLabel = completedCount > 0
		? `Steps 1–${completedCount} are already completed and must remain unchanged.`
		: "No steps are completed yet; review the replanned suffix as a replacement for the current plan from step 1 onward.";
	const lines = [
		`Original goal: ${goal}`,
		"",
	];

	if (priorReview) {
		lines.push(
			"IMPORTANT: This is a revision round. You previously reviewed this replan and requested changes.",
			"The planner has revised the plan to address your feedback.",
			"You MUST re-read the plan file from disk — do NOT rely on your memory of the previous version.",
			"",
			"Your previous blocking issues were:",
		);
		for (const issue of priorReview.blockingIssues) {
			lines.push(`- ${issue}`);
		}
		lines.push(
			"",
			"For each issue above, verify whether the revised plan actually addresses it.",
			"If an issue is resolved, do not raise it again.",
			"Only block on issues that are still present in the current plan or genuinely new problems you discover.",
			"",
		);
	}

	lines.push(
		"Current plan overview:",
		JSON.stringify(
			{
				totalSteps: plan.steps.length,
				stepTitles: plan.steps.map((s, i) => `${i + 1}. ${s.title}`),
			},
			null,
			2,
		),
		"",
		"This is a targeted replan.",
		completedLabel,
		`The plan is in ${planFile}. Read it and assess whether the revised suffix (steps ${stepIndex + 1} onward) is viable.`,
		"You may explore the codebase to check that the revised steps target the right files and APIs.",
		"",
		"Focus your review on:",
		"- Does the revised plan adequately address the escalation reason?",
		"- Are the revised steps viable given the already-completed work and current repo state?",
		"- Is the sequencing correct for the remaining work?",
		"- Are the completed steps preserved unchanged?",
		"",
		"Escalation reason that triggered the replan:",
		escalationReason,
		"",
		`Completed steps (immutable): ${completedCount} step(s) already done.`,
		"",
		"Remember: your default should be to approve if the revised suffix addresses the escalation.",
		"Only block on issues that would make the revised steps impossible or dangerous to implement.",
		"Your goal is either approval, or the smallest complete blocker set needed for a viable revised plan.",
		"If you request changes, include every currently known blocking issue in this round.",
		"",
		"End with your verdict:",
		"Verdict: approve",
		"or",
		"Verdict: changes_requested",
		"Blocking issues:",
		"- only issues that make the revised plan unworkable",
	);
	return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Import / gap analysis prompts
// ---------------------------------------------------------------------------

export function importPlanPrompt(sourcePath: string, sourceText: string, config: DuetConfig, planFile: string, priorReview?: PlanReview, gapAnalysis?: PlanReview): string {
	const checkIds = Object.keys(config.checks);
	if (priorReview) {
		return [
			`Source plan file: ${sourcePath}`,
			"",
			`The converted plan is in ${planFile}. Read it, address the critique, then use edit (with exact oldText/newText) or write to update it.`,
			"Only change what needs to change.",
			"",
			"Critique to address:",
			JSON.stringify(priorReview, null, 2),
			"",
			`Allowed requiredChecks values: ${checkIds.join(", ")}`,
		].join("\n");
	}
	const lines = [
		`Source plan file: ${sourcePath}`,
		"",
		"Convert this plan document into the duet PlanDraft JSON schema.",
		"Preserve the original intent and sequencing.",
		`Write the result to ${planFile} using the write tool. Schema:`,
		planJsonSchema(config),
		"",
		`Allowed requiredChecks values: ${checkIds.join(", ")}`,
	];
	if (gapAnalysis && gapAnalysis.blockingIssues.length > 0) {
		lines.push(
			"",
			"IMPORTANT: A gap analysis was performed on this plan and found the following blocking issues.",
			"Address these issues while converting the plan — adjust steps, add missing steps, or fix problems as needed:",
			"",
		);
		for (const issue of gapAnalysis.blockingIssues) {
			lines.push(`- ${issue}`);
		}
		if (gapAnalysis.nonBlocking && gapAnalysis.nonBlocking.length > 0) {
			lines.push("", "Non-blocking suggestions (address if easy, otherwise skip):");
			for (const suggestion of gapAnalysis.nonBlocking) {
				lines.push(`- ${suggestion}`);
			}
		}
	}
	lines.push(
		"",
		"Source plan document:",
		sourceText,
	);
	return lines.join("\n");
}

export function gapAnalysisPlannerPrompt(sourcePath: string, sourceText: string): string {
	return [
		`Source plan file: ${sourcePath}`,
		"",
		"You are reviewing an existing plan document BEFORE it is converted into a structured format.",
		"Your job is to identify gaps, ambiguities, missing steps, unclear dependencies, or potential issues",
		"that could cause problems during implementation.",
		"",
		"Explore the codebase to understand the project structure, existing code, dependencies, and conventions.",
		"Then analyze the plan against what you find.",
		"",
		"Focus on:",
		"- Missing implementation steps that the plan assumes but doesn't list",
		"- Unclear or ambiguous requirements that need clarification",
		"- Dependencies between steps that aren't acknowledged",
		"- Technical feasibility issues given the current codebase",
		"- Missing error handling, edge cases, or test coverage",
		"- Steps that are too large and should be broken down",
		"- Steps that reference files, APIs, or patterns that don't exist",
		"",
		"End with your verdict:",
		"Verdict: approve",
		"(if the plan is solid enough to proceed with conversion)",
		"or",
		"Verdict: changes_requested",
		"Blocking issues:",
		"- list each gap or issue that should be addressed before implementation",
		"",
		"Source plan document:",
		sourceText,
	].join("\n");
}

export function gapAnalysisCriticPrompt(sourcePath: string, sourceText: string, plannerAnalysis: string): string {
	return [
		`Source plan file: ${sourcePath}`,
		"",
		"The planner has reviewed this plan document for gaps and issues before conversion.",
		"Your job is to validate and supplement their analysis.",
		"",
		"Explore the codebase yourself to verify the planner's findings and check for anything they missed.",
		"",
		"Planner's gap analysis:",
		plannerAnalysis,
		"",
		"Source plan document:",
		sourceText,
		"",
		"End with your verdict:",
		"Verdict: approve",
		"(if the planner's analysis is thorough and the plan is ready for conversion)",
		"or",
		"Verdict: changes_requested",
		"Blocking issues:",
		"- consolidate all blocking issues (from the planner's analysis + any you found) into a single list",
		"- only include genuinely blocking issues, not nice-to-haves",
	].join("\n");
}

// ---------------------------------------------------------------------------
// Execution prompts
// ---------------------------------------------------------------------------

/**
 * Build a concise summary of what the previous step accomplished.
 * Used when `persistSessionAcrossSteps` is true so the agent knows
 * what changed since its last turn without re-exploring the whole codebase.
 */
export function previousStepContext(plan: PlanDraft, stepIndex: number, cwd: string, runId: string): string | undefined {
	if (stepIndex <= 0) return undefined;
	const prevIndex = stepIndex - 1;
	const prevStep = plan.steps[prevIndex];
	if (!prevStep) return undefined;

	const stepsDir = path.join(runRoot(cwd, runId), "steps", String(prevIndex + 1));
	let changedFiles = "";
	try {
		const iterations = fs.existsSync(stepsDir)
			? fs.readdirSync(stepsDir).filter((d) => d.startsWith("iteration-")).sort()
			: [];
		if (iterations.length > 0) {
			const lastIteration = iterations[iterations.length - 1];
			const diffPath = path.join(stepsDir, lastIteration, "controller", "diff-name-only.txt");
			if (fs.existsSync(diffPath)) {
				changedFiles = fs.readFileSync(diffPath, "utf8").trim();
			}
		}
	} catch { /* ignore */ }

	const lines = [
		`Previous step ${prevIndex + 1} (${prevStep.title}) has been completed and approved.`,
	];
	if (changedFiles) {
		lines.push(
			"Files changed in the previous step:",
			changedFiles,
		);
	}
	lines.push(
		"",
		"Your session has context from prior steps. The repository may have changed since your last turn.",
		"Before making assumptions about file contents, verify the current state of any files you need to modify.",
		"Do NOT re-read files that are unrelated to the current step.",
	);
	return lines.join("\n");
}

export function implementationPrompt(plan: PlanDraft, stepIndex: number, previousReview?: ReviewReport, stepTransitionContext?: string): string {
	const step = plan.steps[stepIndex];
	const planOverview = {
		goal: plan.goal,
		totalSteps: plan.steps.length,
		stepTitles: plan.steps.map((s, i) => `${i + 1}. ${s.title}`),
	};
	const lines = [
		"Plan overview:",
		JSON.stringify(planOverview, null, 2),
		"",
	];
	if (stepTransitionContext) {
		lines.push(stepTransitionContext, "");
	}
	lines.push(
		`Implement step ${stepIndex + 1}: ${step.title}`,
		JSON.stringify(step, null, 2),
		"",
		"Implement this step, then run the relevant checks (static analysis, unit tests) to verify.",
		"If a check fails, determine whether your change caused it or it was pre-existing.",
		"Treat reviewer blockers as symptoms, not just a checklist. Fix the underlying cause and any obviously related occurrences that are in scope for this step.",
		"After addressing an issue, inspect nearby code paths, sibling branches, helper functions, and duplicated logic for the same bug pattern.",
		"Before finishing, ask what the reviewer would likely reject next if they independently re-read the code and reran checks. Fix that now if it is in scope.",
		"When done, explain what you changed, what you tested, and any issues you noticed.",
	);
	if (previousReview) {
		lines.push(
			"",
			"The reviewer found these issues with your previous attempt. Fix them:",
			"Do not limit yourself to the literal bullets below if they point to a broader defect. Fix the root cause and any obviously related occurrences in this step.",
			"Your goal is to return something the reviewer can approve in this round, not merely something that addresses the exact wording of the prior comments.",
		);
		for (const issue of previousReview.blockingIssues) {
			lines.push(`- ${issue}`);
		}
	}
	return lines.join("\n");
}

export function reviewPrompt(
	plan: PlanDraft,
	stepIndex: number,
	implText: string,
	gateResult: GateRunResult,
): string {
	const step = plan.steps[stepIndex];

	let diffPatchContent = "";
	try {
		diffPatchContent = fs.readFileSync(gateResult.diffPatchPath, "utf8").trim();
	} catch { /* file may not exist */ }

	let diffNamesContent = "";
	try {
		diffNamesContent = fs.readFileSync(gateResult.diffNameOnlyPath, "utf8").trim();
	} catch { /* file may not exist */ }

	let statusContent = "";
	try {
		statusContent = fs.readFileSync(gateResult.statusPath, "utf8").trim();
	} catch { /* file may not exist */ }

	const MAX_DIFF_CHARS = 80_000;
	const truncatedDiff = diffPatchContent.length > MAX_DIFF_CHARS
		? `${diffPatchContent.slice(0, MAX_DIFF_CHARS)}\n...[diff truncated at ${MAX_DIFF_CHARS} chars]`
		: diffPatchContent;

	const lines = [
		`Review step ${stepIndex + 1}: ${step.title}`,
		"",
		"Step requirements:",
		JSON.stringify(step, null, 2),
		"",
		"Your job: verify the implementation is correct. Read the changed files. Run tests. Check outputs.",
		"Do your own investigation — do not just rely on what the implementer or gate results say.",
	];
	if (implText.trim()) {
		lines.push(
			"",
			"Implementer's explanation (verify these claims yourself):",
			implText.length > 6000 ? `${implText.slice(0, 6000)}\n...[truncated]` : implText,
		);
	}
	if (gateResult.evidence.length > 0) {
		lines.push("", "Automated gate results:", JSON.stringify(gateResult.evidence, null, 2));
	}
	if (diffNamesContent) {
		lines.push("", "Changed files:", diffNamesContent);
	}
	if (statusContent) {
		lines.push("", "Git status:", statusContent);
	}
	if (truncatedDiff) {
		lines.push("", "Diff:", truncatedDiff);
	}
	lines.push(
		"",
		"Look for: real bugs, logic errors, missed edge cases, broken tests, style violations.",
		"The step description is your scope boundary — do not demand work beyond what the step requires.",
		"If the code works and meets the step requirements, approve it — even if it's not how you'd write it.",
		"Your goal is either approval, or the minimal complete set of fixes needed for approval in the next round.",
		"If you request changes, include ALL currently known blocking defects you can find in this review round.",
		"Do not stop after the first one or two issues, and do not save additional known blockers for later rounds.",
		"If multiple defects come from the same underlying issue, prefer one root-cause-oriented blocker over many tiny symptom bullets unless separate fixes are truly required.",
		"Before responding, do a final sweep and ask: if the implementer fixed only the issues I listed, would I approve? If not, add the missing blockers now.",
		"",
		"End with your verdict:",
		"Verdict: approve",
		"or",
		"Verdict: changes_requested",
		"Blocking issues:",
		"- only real defects that need fixing",
	);
	return lines.join("\n");
}

export function relayPrompt(
	plan: PlanDraft,
	stepIndex: number,
	relayRound: number,
	previousAgentText: string | undefined,
	gateResult: GateRunResult | undefined,
	stepTransitionContext?: string,
	/** Prior observations from earlier steps (high/medium only). */
	priorObservationsContext?: string,
): string {
	const step = plan.steps[stepIndex];
	const planOverview = {
		goal: plan.goal,
		totalSteps: plan.steps.length,
		stepTitles: plan.steps.map((s, i) => `${i + 1}. ${s.title}`),
	};

	const lines = [
		"Plan overview:",
		JSON.stringify(planOverview, null, 2),
		"",
	];
	if (stepTransitionContext) {
		lines.push(stepTransitionContext, "");
	}
	lines.push(
		`Step ${stepIndex + 1}: ${step.title}`,
		JSON.stringify(step, null, 2),
		"",
	);

	if (relayRound === 1) {
		lines.push(
			"You are the first agent to work on this step.",
			"Implement the changes described above, run checks to verify, and fix any issues before handing off.",
			"Be thorough — the next agent will review your work and should find it correct.",
		);
	} else if (relayRound === 2) {
		lines.push(
			`This is relay round ${relayRound}. Another agent has already worked on this step.`,
			"",
			"You are in VERIFICATION MODE. Your default action is to APPROVE.",
			"Focus your review on the DIFF — the changes made in the previous round.",
			"Only make changes if there is a MATERIAL defect: failing check, missing step requirement, logic bug, or security issue.",
			"Style preferences, alternative approaches, comment wording, and optional polish are NOT grounds for changes.",
			"",
			"If all checks pass and the step requirements are met, approve immediately.",
			"Log anything else you notice as observations — do not act on them.",
		);
		if (previousAgentText?.trim()) {
			const trimmed = previousAgentText.length > 6000 ? `${previousAgentText.slice(0, 6000)}\n...[truncated]` : previousAgentText;
			lines.push("", "Previous agent's notes:", trimmed);
		}
	} else {
		lines.push(
			`This is relay round ${relayRound}. Multiple rounds have already been spent on this step.`,
			"",
			"You are in STRICT FIX MODE. Something was genuinely wrong in the previous round.",
			"Fix ONLY the specific error that caused the rejection or check failure. Touch nothing else.",
			"If you cannot identify a concrete defect, APPROVE and move on.",
			"Do not introduce new improvements, refactors, or polish at this stage.",
		);
		if (previousAgentText?.trim()) {
			const trimmed = previousAgentText.length > 6000 ? `${previousAgentText.slice(0, 6000)}\n...[truncated]` : previousAgentText;
			lines.push("", "Previous agent's notes:", trimmed);
		}
	}

	// Inject prior observations from earlier steps so the agent can address them if in scope
	if (priorObservationsContext?.trim()) {
		lines.push("", priorObservationsContext);
	}

	if (gateResult) {
		let diffContent = "";
		try { diffContent = fs.readFileSync(gateResult.diffPatchPath, "utf8").trim(); } catch {}
		let diffNames = "";
		try { diffNames = fs.readFileSync(gateResult.diffNameOnlyPath, "utf8").trim(); } catch {}

		const MAX_DIFF_CHARS = 80_000;
		const truncatedDiff = diffContent.length > MAX_DIFF_CHARS
			? `${diffContent.slice(0, MAX_DIFF_CHARS)}\n...[diff truncated at ${MAX_DIFF_CHARS} chars]`
			: diffContent;

		if (gateResult.evidence.length > 0) {
			lines.push("", "Automated gate results:", JSON.stringify(gateResult.evidence, null, 2));
		}
		if (gateResult.allPassed && relayRound >= 2) {
			lines.push("", "All automated checks PASSED. Unless you find a concrete functional defect the checks missed, APPROVE this step.");
		}
		if (diffNames) {
			lines.push("", "Files changed so far:", diffNames);
		}
		if (truncatedDiff) {
			lines.push("", "Current diff:", truncatedDiff);
		}
	}

	lines.push(
		"",
		"When done, explain what you reviewed, what you changed (if anything), and your assessment.",
		"",
		"End with:",
		"Verdict: approve  — if the step is complete and correct, no more changes needed",
		"Verdict: changes_made  — if you made fixes or improvements",
		"Verdict: replan_needed  — if the step is structurally impossible to complete as planned and needs controller-managed replanning",
	);
	return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Summary / handoff prompts
// ---------------------------------------------------------------------------

export function planSummaryPrompt(plan: PlanDraft): string {
	return [
		"Summarize this approved duet plan for a human reviewer.",
		"Return a JSON object with exactly this shape:",
		JSON.stringify(
			{
				overview: "string",
				stepHighlights: ["string"],
				risks: ["string"],
				recommendedNextAction: "string",
			},
			null,
			2,
		),
		"",
		"Be concise but specific.",
		JSON.stringify(plan, null, 2),
	].join("\n");
}

export function handoffSummaryPrompt(transcript: string): string {
	return [
		"Summarize this parent conversation into a handoff for autonomous child coding agents.",
		"Capture only durable information that matters for follow-on planning or implementation.",
		"Prefer concrete constraints, decisions, and unresolved questions over narration.",
		"Return a JSON object with exactly this shape:",
		JSON.stringify(
			{
				overview: "string",
				decisions: ["string"],
				constraints: ["string"],
				openQuestions: ["string"],
			},
			null,
			2,
		),
		"",
		"Conversation transcript:",
		transcript,
	].join("\n");
}

// ---------------------------------------------------------------------------
// Prompt wrappers (decorators that prepend context to any prompt)
// ---------------------------------------------------------------------------

export function withRunHandoff(prompt: string, handoff: { mode: string; content: string } | undefined): string {
	if (!handoff) return prompt;
	const headings: Record<string, string> = {
		summary: "Parent conversation handoff summary:",
		full: "Parent conversation full context handoff:",
		custom: "Additional context provided by the user:",
	};
	const heading = headings[handoff.mode] ?? "Handoff context:";
	const preamble = handoff.mode === "custom"
		? "Treat this as authoritative reference material. Follow its instructions and use it to validate work."
		: "Use this handoff as background context. If it conflicts with the explicit task below or the current repository state, prioritize the explicit task and repo state.";
	return [
		heading,
		handoff.content.trim(),
		"",
		preamble,
		"",
		prompt,
	].join("\n");
}

export function withOperatorNotes(prompt: string, operatorNotes: string | undefined): string {
	if (!operatorNotes?.trim()) return prompt;
	return [
		"Operator notes for this run:",
		operatorNotes.trim(),
		"",
		"These notes are authoritative user steering for this run. Follow them unless they directly conflict with the repository state or the controller's explicit task.",
		"",
		prompt,
	].join("\n");
}

export function withExecutionResumeContext(prompt: string, resumedExecution: boolean): string {
	if (!resumedExecution) return prompt;
	return [
		"Execution resume notice:",
		"This step is resuming after an interrupted attempt.",
		"The repository may already contain partial or complete work for this step.",
		"Before making new conclusions or edits, inspect the current repository state, changed files, and check results to determine what is already done, what is incomplete, and what still needs fixing.",
		"Treat the current repository state as authoritative over assumptions from prior messages.",
		"Avoid redoing work blindly; verify what already exists first.",
		"",
		prompt,
	].join("\n");
}

export function withPendingInterventions(prompt: string, interventions: InterventionEntry[]): string {
	if (interventions.length === 0) return prompt;
	const lines = ["Operator interventions for this round:"];
	for (const entry of interventions) {
		const prefix = entry.target.intent === "steer" ? "Operator steer" : "Operator note";
		lines.push(`${prefix}: ${entry.content}`);
	}
	lines.push("", prompt);
	return lines.join("\n");
}

export function humanPlanFeedbackReview(note: string): PlanReview {
	return {
		verdict: "changes_requested",
		blockingIssues: [
			`Incorporate this human feedback before approval: ${note}`,
		],
	};
}

// ---------------------------------------------------------------------------
// Plan formatting helpers
// ---------------------------------------------------------------------------

export function formatPlanPreviewLines(plan: PlanDraft, heading = "Plan preview", maxSteps = 6): string[] {
	const lines = [heading, `Goal: ${plan.goal}`, `Steps: ${plan.steps.length}`];
	for (const [index, step] of plan.steps.slice(0, maxSteps).entries()) {
		lines.push(`${index + 1}. ${step.title}`);
	}
	if (plan.steps.length > maxSteps) {
		lines.push(`... ${plan.steps.length - maxSteps} more step(s)`);
	}
	return lines;
}

export function formatPlanDocument(plan: PlanDraft, sourcePath?: string): string {
	const lines: string[] = [];
	lines.push(`# ${plan.goal}`);
	if (sourcePath) lines.push(``, `Source plan file: ${sourcePath}`);
	if (plan.assumptions && plan.assumptions.length > 0) {
		lines.push("", "## Assumptions");
		for (const item of plan.assumptions) lines.push(`- ${item}`);
	}
	lines.push("", "## Steps");
	for (const [index, step] of plan.steps.entries()) {
		lines.push("", `### ${index + 1}. ${step.title} (${step.id})`, step.description);
		if (step.inputs && step.inputs.length > 0) {
			lines.push("", "Inputs:");
			for (const item of step.inputs) lines.push(`- ${item}`);
		}
		if (step.filesLikelyTouched && step.filesLikelyTouched.length > 0) {
			lines.push("", "Files likely touched:");
			for (const item of step.filesLikelyTouched) lines.push(`- ${item}`);
		}
		if (step.acceptanceCriteria && step.acceptanceCriteria.length > 0) {
			lines.push("", "Acceptance criteria:");
			for (const item of step.acceptanceCriteria) lines.push(`- ${item}`);
		}
		lines.push("", `Required checks: ${step.requiredChecks.join(", ") || "none"}`);
		if (step.outOfScope && step.outOfScope.length > 0) {
			lines.push("", "Out of scope:");
			for (const item of step.outOfScope) lines.push(`- ${item}`);
		}
	}
	if (plan.testStrategy && plan.testStrategy.length > 0) {
		lines.push("", "## Test strategy");
		for (const item of plan.testStrategy) lines.push(`- ${item}`);
	}
	if (plan.rollbackPlan && plan.rollbackPlan.length > 0) {
		lines.push("", "## Rollback plan");
		for (const item of plan.rollbackPlan) lines.push(`- ${item}`);
	}
	return `${lines.join("\n")}\n`;
}

// ---------------------------------------------------------------------------
// Plan health check prompt
// ---------------------------------------------------------------------------

export function healthCheckScoutPrompt(plan: PlanDraft): string {
	const stepSummary = plan.steps.map((s, i) => {
		const files = s.filesLikelyTouched?.join(", ") ?? "not specified";
		return `Step ${i + 1} (${s.id}): ${s.title}\n  Files: ${files}\n  Description: ${s.description.slice(0, 200)}`;
	}).join("\n\n");

	return [
		"You are a codebase scout preparing ground truth for a plan health check.",
		"Your job is to explore the codebase and produce a structured report — NOT to review the plan itself.",
		"",
		"## What to explore",
		"",
		"1. **Project structure** — `ls` the top-level directories, identify major modules (backend/frontend/shared/infra).",
		"2. **Build & test setup** — read `package.json`, `build.gradle`, `tsconfig.json`, `pom.xml`, CI config, etc.",
		"   Note what check commands exist and what test framework is used.",
		"3. **For each step in the plan**, verify:",
		"   - Do the files/directories referenced actually exist? List which do and which don't.",
		"   - Are there existing tests in those areas? Name the test files.",
		"   - What patterns/conventions does the existing code follow in those areas?",
		"   - Are there imports, types, or APIs the step depends on? Do they exist?",
		"4. **Existing test coverage** — find test directories, note what's tested and what isn't.",
		"5. **Dependencies between plan areas** — if step N creates something step M uses, note what currently exists vs what's missing.",
		"",
		"## Plan steps to investigate",
		"",
		stepSummary,
		"",
		"## Output format",
		"",
		"Write a thorough report as plain text (NOT JSON). Structure it as:",
		"",
		"### Project Structure",
		"(directory layout, key config files, frameworks)",
		"",
		"### Build & Test Setup",
		"(check commands, test framework, CI setup)",
		"",
		"### Per-Step Findings",
		"#### Step 1: <title>",
		"- Files exist: yes/no (list specific files checked)",
		"- Existing tests: (list test files in the area)",
		"- Existing patterns: (how similar code is structured)",
		"- Dependencies: (what this step needs that exists or doesn't)",
		"",
		"(repeat for each step)",
		"",
		"### Cross-Step Dependencies",
		"(things one step creates that another step needs)",
		"",
		"Be factual. Report what you actually find. Don't speculate or editorialize.",
	].join("\n");
}

export function planHealthCheckPrompt(plan: PlanDraft, scoutReport: string, originalGoal?: string): string {
	const planJson = JSON.stringify(plan, null, 2);
	const goal = originalGoal ?? plan.goal;
	return [
		"You are an adversarial reviewer performing a pre-execution health check on a coding plan.",
		"This plan was already approved by a planner+critic loop. Your job is NOT to re-review the plan structure.",
		"Your job is to simulate what will actually happen when implementing agents try to execute each step,",
		"and find the problems that will cause steps to fail, escalate, or produce wrong results.",
		"",
		"## Original goal",
		"",
		goal,
		"",
		"## Codebase scout report",
		"",
		"A scout agent has already explored the codebase. Use this report as ground truth — do NOT explore the codebase yourself.",
		"",
		scoutReport,
		"",
		"## Your analysis",
		"",
		"Using the scout's findings, walk through each step and check:",
		"",
		"1. **File/API existence** — the scout verified which files exist. Flag steps that reference non-existent files/APIs.",
		"",
		"2. **Per-step check isolation** — after completing ONLY this step (not future steps), will the required checks pass?",
		"   e.g., if step 5 imports a type that step 6 creates, step 5's typecheck will fail.",
		"",
		"3. **Scope clarity** — is the scope clear enough that an agent won't drift into unrelated work?",
		"   Does the step description say what NOT to touch? If a step is 'backend only' or 'frontend only',",
		"   is that constraint stated explicitly?",
		"",
		"4. **Goal coverage** — walk through the original goal sentence by sentence.",
		"   Does every requirement have at least one step that delivers it?",
		"   Are there steps that deliver things the goal never asked for?",
		"",
		"5. **Execution risk** — which steps are most likely to cause an escalation loop?",
		"   Common patterns:",
		"   - Vague descriptions that let agents interpret freely",
		"   - Steps mixing backend + frontend (agent will gravitate to one side)",
		"   - Steps with 'unit' in requiredChecks but no clear test to write or update",
		"   - Steps that modify heavily-tested code without mentioning test updates",
		"",
		"## Response format",
		"",
		"Return valid JSON (no markdown fences) with this structure:",
		"",
		'{ "goalCoverage": { "covered": ["requirement from goal that IS addressed"], "gaps": ["requirement from goal that NO step addresses"] },',
		'  "stepRisks": [ { "stepId": "step-1", "stepTitle": "...", "risk": "low|medium|high",',
		'    "issues": ["specific issue"], "willChecksPass": true|false,',
		'    "checksFailReason": "why checks would fail after only this step, or null" } ],',
		'  "verdict": "healthy|issues_found",',
		'  "summary": "one paragraph overall assessment",',
		'  "criticalIssues": ["issues that WILL cause step failure or escalation"],',
		'  "warnings": ["issues that MIGHT cause problems but are not certain"] }',
		"",
		"Be specific. Reference file paths, step IDs, and exact problems.",
		"Do not invent problems. If the plan is solid, say so.",
		"",
		"## Plan",
		"",
		planJson,
	].join("\n");
}

export interface StepRisk {
	stepId: string;
	stepTitle: string;
	risk: "low" | "medium" | "high";
	issues: string[];
	willChecksPass: boolean;
	checksFailReason: string | null;
}

export interface PlanHealthCheckResult {
	goalCoverage: {
		covered: string[];
		gaps: string[];
	};
	stepRisks: StepRisk[];
	verdict: "healthy" | "issues_found";
	summary: string;
	criticalIssues: string[];
	warnings: string[];
}

function isStringArray(value: unknown): value is string[] {
	return Array.isArray(value) && value.every((item) => typeof item === "string");
}

function cleanStringArray(arr: unknown[]): string[] {
	return arr.filter((item): item is string => typeof item === "string" && item.trim().length > 0).map((item) => item.trim());
}

export function validatePlanHealthCheckResult(value: unknown): { ok: true; value: PlanHealthCheckResult } | { ok: false; error: string } {
	if (typeof value !== "object" || value === null || Array.isArray(value)) {
		return { ok: false, error: "PlanHealthCheckResult must be an object" };
	}
	const obj = value as Record<string, unknown>;
	if (obj.verdict !== "healthy" && obj.verdict !== "issues_found") {
		return { ok: false, error: "verdict must be 'healthy' or 'issues_found'" };
	}
	if (typeof obj.summary !== "string" || obj.summary.trim().length === 0) {
		return { ok: false, error: "summary must be a non-empty string" };
	}
	if (!Array.isArray(obj.criticalIssues)) {
		return { ok: false, error: "criticalIssues must be an array" };
	}
	if (!Array.isArray(obj.warnings)) {
		return { ok: false, error: "warnings must be an array" };
	}

	// Validate goalCoverage
	const gc = obj.goalCoverage;
	if (typeof gc !== "object" || gc === null || Array.isArray(gc)) {
		return { ok: false, error: "goalCoverage must be an object with covered[] and gaps[]" };
	}
	const gcObj = gc as Record<string, unknown>;
	if (!isStringArray(gcObj.covered) || !isStringArray(gcObj.gaps)) {
		return { ok: false, error: "goalCoverage.covered and goalCoverage.gaps must be string arrays" };
	}

	// Validate stepRisks
	if (!Array.isArray(obj.stepRisks)) {
		return { ok: false, error: "stepRisks must be an array" };
	}
	const stepRisks: StepRisk[] = [];
	for (const sr of obj.stepRisks as unknown[]) {
		if (typeof sr !== "object" || sr === null || Array.isArray(sr)) continue;
		const s = sr as Record<string, unknown>;
		if (typeof s.stepId !== "string" || typeof s.stepTitle !== "string") continue;
		const risk = s.risk === "low" || s.risk === "medium" || s.risk === "high" ? s.risk : "medium";
		stepRisks.push({
			stepId: s.stepId,
			stepTitle: String(s.stepTitle),
			risk,
			issues: Array.isArray(s.issues) ? cleanStringArray(s.issues) : [],
			willChecksPass: s.willChecksPass !== false,
			checksFailReason: typeof s.checksFailReason === "string" ? s.checksFailReason.trim() : null,
		});
	}

	return {
		ok: true,
		value: {
			goalCoverage: {
				covered: cleanStringArray(gcObj.covered as unknown[]),
				gaps: cleanStringArray(gcObj.gaps as unknown[]),
			},
			stepRisks,
			verdict: obj.verdict,
			summary: obj.summary.trim(),
			criticalIssues: cleanStringArray(obj.criticalIssues as unknown[]),
			warnings: cleanStringArray(obj.warnings as unknown[]),
		},
	};
}

export function formatPlanHealthCheckText(result: PlanHealthCheckResult, model: string): string {
	const riskEmoji = { low: "🟢", medium: "🟡", high: "🔴" };
	const lines = [
		`# Plan Health Check`,
		`Model: ${model}`,
		`Verdict: ${result.verdict === "healthy" ? "✅ healthy" : "⚠️ issues found"}`,
		"",
		"## Summary",
		"",
		result.summary,
	];

	// Goal coverage
	if (result.goalCoverage.gaps.length > 0) {
		lines.push("", "## Goal Coverage Gaps", "");
		for (const gap of result.goalCoverage.gaps) lines.push(`- ❌ ${gap}`);
	}
	if (result.goalCoverage.covered.length > 0) {
		lines.push("", "## Goal Requirements Covered", "");
		for (const item of result.goalCoverage.covered) lines.push(`- ✅ ${item}`);
	}

	// Per-step risk
	if (result.stepRisks.length > 0) {
		lines.push("", "## Step Risk Assessment", "");
		for (const sr of result.stepRisks) {
			lines.push(`### ${riskEmoji[sr.risk]} ${sr.stepId}: ${sr.stepTitle} — ${sr.risk} risk`);
			if (!sr.willChecksPass && sr.checksFailReason) {
				lines.push(``, `⚠️ **Checks will fail:** ${sr.checksFailReason}`);
			}
			if (sr.issues.length > 0) {
				for (const issue of sr.issues) lines.push(`- ${issue}`);
			} else {
				lines.push("- No issues found");
			}
			lines.push("");
		}
	}

	// Critical issues
	if (result.criticalIssues.length > 0) {
		lines.push("## Critical Issues (will cause failure)", "");
		for (const issue of result.criticalIssues) lines.push(`- 🔴 ${issue}`);
		lines.push("");
	}

	// Warnings
	if (result.warnings.length > 0) {
		lines.push("## Warnings (may cause problems)", "");
		for (const issue of result.warnings) lines.push(`- 🟡 ${issue}`);
		lines.push("");
	}

	return `${lines.join("\n")}\n`;
}

// ---------------------------------------------------------------------------
// Validation helpers for summary reports
// ---------------------------------------------------------------------------

export function validatePlanSummaryReport(value: unknown): { ok: true; value: PlanSummaryReport } | { ok: false; error: string } {
	if (typeof value !== "object" || value === null || Array.isArray(value)) {
		return { ok: false, error: "PlanSummaryReport must be an object" };
	}
	const obj = value as Record<string, unknown>;
	if (typeof obj.overview !== "string" || obj.overview.trim().length === 0) {
		return { ok: false, error: "overview must be a non-empty string" };
	}
	if (!Array.isArray(obj.stepHighlights) || obj.stepHighlights.some((item) => typeof item !== "string" || item.trim().length === 0)) {
		return { ok: false, error: "stepHighlights must be a string array" };
	}
	if (!Array.isArray(obj.risks) || obj.risks.some((item) => typeof item !== "string" || item.trim().length === 0)) {
		return { ok: false, error: "risks must be a string array" };
	}
	if (typeof obj.recommendedNextAction !== "string" || obj.recommendedNextAction.trim().length === 0) {
		return { ok: false, error: "recommendedNextAction must be a non-empty string" };
	}
	return {
		ok: true,
		value: {
			overview: obj.overview.trim(),
			stepHighlights: (obj.stepHighlights as string[]).map((item) => item.trim()),
			risks: (obj.risks as string[]).map((item) => item.trim()),
			recommendedNextAction: obj.recommendedNextAction.trim(),
		},
	};
}

export function validateHandoffSummaryReport(value: unknown): { ok: true; value: HandoffSummaryReport } | { ok: false; error: string } {
	if (typeof value !== "object" || value === null || Array.isArray(value)) {
		return { ok: false, error: "HandoffSummaryReport must be an object" };
	}
	const obj = value as Record<string, unknown>;
	if (typeof obj.overview !== "string" || obj.overview.trim().length === 0) {
		return { ok: false, error: "overview must be a non-empty string" };
	}
	if (!Array.isArray(obj.decisions) || obj.decisions.some((item) => typeof item !== "string" || item.trim().length === 0)) {
		return { ok: false, error: "decisions must be a string array" };
	}
	if (!Array.isArray(obj.constraints) || obj.constraints.some((item) => typeof item !== "string" || item.trim().length === 0)) {
		return { ok: false, error: "constraints must be a string array" };
	}
	if (!Array.isArray(obj.openQuestions) || obj.openQuestions.some((item) => typeof item !== "string" || item.trim().length === 0)) {
		return { ok: false, error: "openQuestions must be a string array" };
	}
	return {
		ok: true,
		value: {
			overview: obj.overview.trim(),
			decisions: (obj.decisions as string[]).map((item) => item.trim()),
			constraints: (obj.constraints as string[]).map((item) => item.trim()),
			openQuestions: (obj.openQuestions as string[]).map((item) => item.trim()),
		},
	};
}

export function formatPlanSummaryText(summary: PlanSummaryReport, model: string): string {
	const lines = [`Summary model: ${model}`, "", "Overview:", summary.overview];
	if (summary.stepHighlights.length > 0) {
		lines.push("", "Step highlights:");
		for (const item of summary.stepHighlights) lines.push(`- ${item}`);
	}
	if (summary.risks.length > 0) {
		lines.push("", "Risks / watch items:");
		for (const item of summary.risks) lines.push(`- ${item}`);
	}
	lines.push("", "Recommended next action:", summary.recommendedNextAction);
	return `${lines.join("\n")}\n`;
}

export function formatHandoffSummaryText(summary: HandoffSummaryReport, model: string, sourceItemCount: number): string {
	const lines = [
		"Parent conversation handoff summary",
		`Summary model: ${model}`,
		`Source items: ${sourceItemCount}`,
		"",
		"Overview:",
		summary.overview,
	];
	if (summary.decisions.length > 0) {
		lines.push("", "Settled decisions:");
		for (const item of summary.decisions) lines.push(`- ${item}`);
	}
	if (summary.constraints.length > 0) {
		lines.push("", "Constraints / must-remember items:");
		for (const item of summary.constraints) lines.push(`- ${item}`);
	}
	if (summary.openQuestions.length > 0) {
		lines.push("", "Open questions:");
		for (const item of summary.openQuestions) lines.push(`- ${item}`);
	}
	return `${lines.join("\n")}\n`;
}

export function shrinkTranscriptForSummary(transcript: string, maxChars = 120_000): string {
	const trimmed = transcript.trim();
	if (trimmed.length <= maxChars) return trimmed;
	const headChars = Math.floor(maxChars * 0.35);
	const tailChars = Math.floor(maxChars * 0.65);
	const head = trimmed.slice(0, headChars).trimEnd();
	const tail = trimmed.slice(-tailChars).trimStart();
	return [
		head,
		"",
		`[transcript truncated for summary; showing first ${head.length} chars and last ${tail.length} chars of ${trimmed.length}]`,
		"",
		tail,
	].join("\n");
}

// ---------------------------------------------------------------------------
// Plan source file loader
// ---------------------------------------------------------------------------

export function loadPlanSourceFile(cwd: string, relativePath: string): { absolutePath: string; sourceText: string } {
	const absolutePath = path.resolve(cwd, relativePath);
	const stat = fs.statSync(absolutePath);
	if (!stat.isFile()) {
		throw new Error(`Selected path is not a file: ${relativePath}`);
	}
	if (stat.size > 150_000) {
		throw new Error(`Plan file is too large to import safely (${stat.size} bytes).`);
	}
	return {
		absolutePath,
		sourceText: fs.readFileSync(absolutePath, "utf8"),
	};
}
