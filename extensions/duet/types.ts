import * as path from "node:path";

export type Side = "A" | "B";
export type ThinkingLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh";
export type HandoffMode = "none" | "summary" | "full" | "custom";
export type PostPlanMode = "review" | "autorun";
export const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh"] as const;
export type DuetPhase = "idle" | "planning" | "plan_approved" | "executing" | "paused" | "completed" | "aborted";
export type PauseReason = "dirty_repo" | "plan_deadlock" | "execution_deadlock" | "schema_failure" | "missing_config" | "replan_needed" | "user_paused";
export type ResumeAction = "planning" | "step" | "run" | "replan";

export interface CheckConfig {
	cmd: string;
	timeoutSec?: number;
}

export interface RepoPolicy {
	requireGit: boolean;
	requireCleanStart: boolean;
	enforceCleanAfterStep: boolean;
	captureDiffCheck: boolean;
	/**
	 * When true, automatically `git add -A && git commit` after each approved step.
	 * Creates clean rollback points and ensures next-step diffs are accurate.
	 * Default: true.
	 */
	commitPerStep: boolean;
}

export interface SideConfig {
	label: string;
	model: string;
	thinking: ThinkingLevel;
}

export type DuetRole = "planner" | "critic" | "implementer" | "reviewer" | "relay";
export type ExecutionMode = "standard" | "relay";

export interface DuetConfig {
	sideA: SideConfig;
	sideB: SideConfig;
	/** Per-role overrides. When set, these take priority over sideA/sideB. */
	planner?: SideConfig;
	critic?: SideConfig;
	implementer?: SideConfig;
	reviewer?: SideConfig;
	/** Execution mode: "standard" (implement→review cycle) or "relay" (implement+review→implement+review). Default: "standard". */
	executionMode: ExecutionMode;
	startImplementer: Side;
	maxPlanRounds: number;
	maxExecutionRounds: number;
	alternateByStep: boolean;
	checks: Record<string, CheckConfig>;
	repo: RepoPolicy;
	/**
	 * When true, the implementer (and reviewer in standard mode, or relay agents)
	 * keep their session across steps instead of starting fresh each time.
	 * This avoids re-reading the codebase on every step transition. Pi's
	 * auto-compaction handles context overflow automatically.
	 * Default: true.
	 */
	persistSessionAcrossSteps: boolean;
}

/** Get the SideConfig for a specific role, falling back to sideA/sideB. */
export function getRoleConfig(config: DuetConfig, role: DuetRole): SideConfig {
	if (role === "planner" && config.planner) return config.planner;
	if (role === "critic" && config.critic) return config.critic;
	if (role === "implementer" && config.implementer) return config.implementer;
	if (role === "reviewer" && config.reviewer) return config.reviewer;
	// Relay uses implementer config as base
	if (role === "relay" && config.implementer) return config.implementer;
	// Legacy fallback: planner/implementer/relay → sideA, critic/reviewer → sideB
	return (role === "planner" || role === "implementer" || role === "relay") ? config.sideA : config.sideB;
}

export interface PlanStep {
	id: string;
	title: string;
	description: string;
	requiredChecks: string[];
	// Optional detail fields — models may include these but controller doesn't require them
	inputs?: string[];
	filesLikelyTouched?: string[];
	acceptanceCriteria?: string[];
	outOfScope?: string[];
}

export interface PlanDraft {
	goal: string;
	steps: PlanStep[];
	// Optional — useful context but not read by controller
	assumptions?: string[];
	testStrategy?: string[];
	rollbackPlan?: string[];
}

export interface PlanReview {
	verdict: "approve" | "changes_requested";
	blockingIssues: string[];
	// Optional
	nonBlocking?: string[];
	missingChecks?: string[];
	confidence?: number;
}

export interface CommandResultRef {
	cmd: string;
	exitCode: number;
}

export interface ImplementationReport {
	stepId: string;
	filesChanged: string[];
	// Optional — nice to have but controller doesn't need them
	diffSummary?: string;
	commandsRun?: CommandResultRef[];
	notes?: string[];
	openRisks?: string[];
}

export interface ReviewReport {
	stepId: string;
	verdict: "approve" | "changes_requested" | "replan_needed";
	blockingIssues: string[];
	// Optional
	nonBlocking?: string[];
	testsVerified?: CommandResultRef[];
	missingCoverage?: string[];
	confidence?: number;
}

export interface EscalationReport {
	stepId: string;
	reason: string;
	category: "underplanned" | "wrong_sequence" | "broader_refactor" | "assumption_invalid" | "other";
	suggestedChanges?: string[];
}

export interface GateEvidence {
	checkId: string;
	cmd: string;
	exitCode: number;
	passed: boolean;
	stdoutPath?: string;
	stderrPath?: string;
	truncatedPreview: string;
}

export interface StepRunSummary {
	stepId?: string;
	stepTitle?: string;
	implementer?: Side;
	reviewer?: Side;
	/** Override role labels in the widget (e.g. "Planner" / "Critic" during planning) */
	roleLabels?: { sideA: string; sideB: string };
	gateResults?: Array<{ id: string; passed: boolean }>;
	lastVerdict?: string;
}

// ---------------------------------------------------------------------------
// Intervention types — durable operator steering for active/inactive children
// ---------------------------------------------------------------------------

/**
 * Concrete identity for the child an intervention targets.
 * `childId` is the join key for loading pending interventions; it does not flip
 * when the active side changes in relay mode.
 */
export interface InterventionTarget {
	/** Stable child identifier: `${side}-${role}` e.g. 'A-implementer', 'B-critic', 'A-relay-a'. */
	childId: string;
	side: Side;
	/** DuetRole or relay sub-role ('relay-a', 'relay-b') at time of targeting. */
	role: string;
	/** steer = for the currently active child; note = queued for the child's next activation. */
	intent: "steer" | "note";
}

export interface InterventionEntry {
	id: string;
	timestamp: string;
	/**
	 * Entry type: 'user' (default, omitted for backward compat) or 'system' (informational events
	 * like resume markers). System entries are never returned by `loadPendingInterventions`.
	 */
	entryType?: "user" | "system";
	target: InterventionTarget;
	content: string;
	/** ISO timestamp when the intervention was incorporated into a prompt. */
	deliveredAt?: string;
	/** Which round consumed this intervention. */
	deliveredInRound?: number;
	/** Which step consumed this intervention. */
	deliveredInStep?: number;
}

/**
 * Snapshot of which child is currently running so the workspace UI and
 * intervention router know how to target steer vs. note intents.
 */
export interface ActiveChildInfo {
	/** Stable child identifier: `${side}-${role}` e.g. 'A-implementer', 'B-relay-a'. */
	childId: string;
	side: Side;
	/** DuetRole or relay sub-role ('relay-a', 'relay-b'). */
	role: string;
	model: string;
	startedAt: string;
	round: number;
	stepIndex?: number;
}

export interface DuetState {
	version: 1;
	phase: DuetPhase;
	runId?: string;
	goal?: string;
	plan?: PlanDraft;
	planSourcePath?: string;
	stepIndex?: number;
	round?: number;
	pausedReason?: PauseReason;
	resumeAction?: ResumeAction;
	activeSummary?: StepRunSummary;
	activity?: string;
	handoffMode?: HandoffMode;
	/** What to do immediately after the initial plan is approved. */
	postPlanMode?: PostPlanMode;
	activeConfig?: DuetConfig;
	/** Currently running child agent — set at child start, cleared on completion or error. */
	activeChild?: ActiveChildInfo;
	updatedAt: string;
}

// ---------------------------------------------------------------------------
// inactiveChildId helper
// ---------------------------------------------------------------------------

/**
 * Derive the inactive child's concrete `childId` from the currently active child.
 *
 * Role pairings:
 * - planning:  planner ↔ critic  (sides are fixed for the planning loop)
 * - standard:  implementer ↔ reviewer  (sides fixed per step via getImplementerForStep)
 * - relay:     A-relay-a ↔ B-relay-b  (sides stable — A is always relay-a, B is relay-b)
 *
 * Returns `undefined` if `state.activeChild` is not set or the role is unrecognised.
 */
export function inactiveChildId(state: DuetState, _config: DuetConfig): string | undefined {
	if (!state.activeChild) return undefined;
	const { side, role } = state.activeChild;
	const other = otherSide(side);

	// Planning
	if (role === "planner") return `${other}-critic`;
	if (role === "critic") return `${other}-planner`;

	// Standard execution
	if (role === "implementer") return `${other}-reviewer`;
	if (role === "reviewer") return `${other}-implementer`;

	// Relay — A is always relay-a, B is always relay-b
	if (role === "relay-a") return "B-relay-b";
	if (role === "relay-b") return "A-relay-a";

	return undefined;
}

export interface ValidationSuccess<T> {
	ok: true;
	value: T;
}

export interface ValidationFailure {
	ok: false;
	error: string;
}

export type ValidationResult<T> = ValidationSuccess<T> | ValidationFailure;
export type Validator<T> = (value: unknown) => ValidationResult<T>;

export const IMPLEMENTER_TOOLS = ["read", "grep", "find", "ls", "edit", "write", "bash"] as const;
export const REVIEWER_TOOLS = ["read", "grep", "find", "ls", "bash"] as const;
export const PLANNING_TOOLS = ["read", "grep", "find", "ls", "edit", "write", "bash"] as const;

export const DEFAULT_CONFIG: DuetConfig = {
	sideA: { label: "Codex", model: "openai/gpt-5-codex", thinking: "off" },
	sideB: { label: "Claude", model: "anthropic/claude-sonnet-4-5", thinking: "off" },
	planner: undefined,
	critic: undefined,
	implementer: undefined,
	reviewer: undefined,
	executionMode: "relay",
	startImplementer: "A",
	maxPlanRounds: 10,
	maxExecutionRounds: 10,
	alternateByStep: true,
	checks: {
		static: { cmd: "npm run lint && npm run typecheck", timeoutSec: 300 },
		unit: { cmd: "npm test -- --maxWorkers=6", timeoutSec: 600 },
	},
	repo: {
		requireGit: true,
		requireCleanStart: false,
		enforceCleanAfterStep: false,
		captureDiffCheck: true,
		commitPerStep: true,
	},
	persistSessionAcrossSteps: true,
};

export function createInitialState(): DuetState {
	return {
		version: 1,
		phase: "idle",
		updatedAt: new Date().toISOString(),
	};
}

function failure(error: string): ValidationFailure {
	return { ok: false, error };
}

function success<T>(value: T): ValidationSuccess<T> {
	return { ok: true, value };
}

function isObject(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isThinkingLevel(value: unknown): value is ThinkingLevel {
	return typeof value === "string" && THINKING_LEVELS.includes(value as ThinkingLevel);
}

function readString(obj: Record<string, unknown>, key: string, label: string): ValidationResult<string> {
	const value = obj[key];
	if (typeof value !== "string" || value.trim().length === 0) {
		return failure(`${label} must be a non-empty string`);
	}
	return success(value.trim());
}

function readOptionalNumber(obj: Record<string, unknown>, key: string, label: string): ValidationResult<number | undefined> {
	const value = obj[key];
	if (value === undefined) return success(undefined);
	if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
		return failure(`${label} must be a positive number`);
	}
	return success(value);
}

function readBoolean(obj: Record<string, unknown>, key: string, label: string, fallback?: boolean): ValidationResult<boolean> {
	const value = obj[key];
	if (value === undefined && fallback !== undefined) return success(fallback);
	if (typeof value !== "boolean") return failure(`${label} must be a boolean`);
	return success(value);
}

function readOptionalStringArray(obj: Record<string, unknown>, key: string): string[] | undefined {
	const value = obj[key];
	if (!Array.isArray(value)) return undefined;
	const out: string[] = [];
	for (const entry of value) {
		if (typeof entry === "string" && entry.trim().length > 0) out.push(entry.trim());
	}
	return out;
}

function readOptionalCommandRefs(obj: Record<string, unknown>, key: string): CommandResultRef[] | undefined {
	const value = obj[key];
	if (!Array.isArray(value)) return undefined;
	const out: CommandResultRef[] = [];
	for (const entry of value) {
		if (isObject(entry) && typeof entry.cmd === "string" && typeof entry.exitCode === "number") {
			out.push({ cmd: entry.cmd, exitCode: entry.exitCode });
		}
	}
	return out;
}

function readStringArray(obj: Record<string, unknown>, key: string, label: string): ValidationResult<string[]> {
	const value = obj[key];
	if (!Array.isArray(value)) return failure(`${label} must be an array of strings`);
	const out: string[] = [];
	for (const entry of value) {
		if (typeof entry !== "string") return failure(`${label} must be an array of strings`);
		const trimmed = entry.trim();
		if (trimmed.length === 0) return failure(`${label} cannot contain empty strings`);
		out.push(trimmed);
	}
	return success(out);
}


function validateSideConfig(value: unknown, label: string): ValidationResult<SideConfig> {
	if (!isObject(value)) return failure(`${label} must be an object`);
	const name = readString(value, "label", `${label}.label`);
	if (!name.ok) return name;
	const model = readString(value, "model", `${label}.model`);
	if (!model.ok) return model;
	const thinkingRaw = value.thinking ?? "off";
	if (!isThinkingLevel(thinkingRaw)) {
		return failure(`${label}.thinking must be one of: ${THINKING_LEVELS.join(", ")}`);
	}
	return success({ label: name.value, model: model.value, thinking: thinkingRaw });
}

export function validateConfig(value: unknown): ValidationResult<DuetConfig> {
	if (!isObject(value)) return failure("Config must be a JSON object");

	const sideA = validateSideConfig(value.sideA ?? DEFAULT_CONFIG.sideA, "sideA");
	if (!sideA.ok) return sideA;
	const sideB = validateSideConfig(value.sideB ?? DEFAULT_CONFIG.sideB, "sideB");
	if (!sideB.ok) return sideB;

	// Optional per-role overrides
	let plannerConfig: SideConfig | undefined;
	let criticConfig: SideConfig | undefined;
	let implementerConfig: SideConfig | undefined;
	let reviewerConfig: SideConfig | undefined;
	if (value.planner) {
		const v = validateSideConfig(value.planner, "planner");
		if (!v.ok) return v;
		plannerConfig = v.value;
	}
	if (value.critic) {
		const v = validateSideConfig(value.critic, "critic");
		if (!v.ok) return v;
		criticConfig = v.value;
	}
	if (value.implementer) {
		const v = validateSideConfig(value.implementer, "implementer");
		if (!v.ok) return v;
		implementerConfig = v.value;
	}
	if (value.reviewer) {
		const v = validateSideConfig(value.reviewer, "reviewer");
		if (!v.ok) return v;
		reviewerConfig = v.value;
	}

	const startImplementerValue = value.startImplementer ?? DEFAULT_CONFIG.startImplementer;
	if (startImplementerValue !== "A" && startImplementerValue !== "B") {
		return failure("startImplementer must be 'A' or 'B'");
	}

	const executionModeValue = (value.executionMode ?? DEFAULT_CONFIG.executionMode) as string;
	if (executionModeValue !== "standard" && executionModeValue !== "relay") {
		return failure("executionMode must be 'standard' or 'relay'");
	}

	const maxPlanRounds = readOptionalNumber(value, "maxPlanRounds", "maxPlanRounds");
	if (!maxPlanRounds.ok) return maxPlanRounds;
	const maxExecutionRounds = readOptionalNumber(value, "maxExecutionRounds", "maxExecutionRounds");
	if (!maxExecutionRounds.ok) return maxExecutionRounds;
	const alternateByStep = readBoolean(value, "alternateByStep", "alternateByStep", DEFAULT_CONFIG.alternateByStep);
	if (!alternateByStep.ok) return alternateByStep;

	const checksValue = value.checks ?? DEFAULT_CONFIG.checks;
	if (!isObject(checksValue)) return failure("checks must be an object");
	const checks: Record<string, CheckConfig> = {};
	for (const [checkId, raw] of Object.entries(checksValue)) {
		if (!isObject(raw)) return failure(`checks.${checkId} must be an object`);
		const cmd = readString(raw, "cmd", `checks.${checkId}.cmd`);
		if (!cmd.ok) return cmd;
		const timeoutSec = readOptionalNumber(raw, "timeoutSec", `checks.${checkId}.timeoutSec`);
		if (!timeoutSec.ok) return timeoutSec;
		checks[checkId] = { cmd: cmd.value, timeoutSec: timeoutSec.value };
	}
	if (Object.keys(checks).length === 0) return failure("At least one check must be configured");

	const repoRaw = isObject(value.repo) ? value.repo : {};
	const requireGit = readBoolean(repoRaw, "requireGit", "repo.requireGit", DEFAULT_CONFIG.repo.requireGit);
	if (!requireGit.ok) return requireGit;
	const requireCleanStart = readBoolean(
		repoRaw,
		"requireCleanStart",
		"repo.requireCleanStart",
		DEFAULT_CONFIG.repo.requireCleanStart,
	);
	if (!requireCleanStart.ok) return requireCleanStart;
	const enforceCleanAfterStep = readBoolean(
		repoRaw,
		"enforceCleanAfterStep",
		"repo.enforceCleanAfterStep",
		DEFAULT_CONFIG.repo.enforceCleanAfterStep,
	);
	if (!enforceCleanAfterStep.ok) return enforceCleanAfterStep;
	const captureDiffCheck = readBoolean(
		repoRaw,
		"captureDiffCheck",
		"repo.captureDiffCheck",
		DEFAULT_CONFIG.repo.captureDiffCheck,
	);
	if (!captureDiffCheck.ok) return captureDiffCheck;
	const commitPerStep = readBoolean(
		repoRaw,
		"commitPerStep",
		"repo.commitPerStep",
		DEFAULT_CONFIG.repo.commitPerStep,
	);
	if (!commitPerStep.ok) return commitPerStep;

	const persistSessionAcrossSteps = readBoolean(value, "persistSessionAcrossSteps", "persistSessionAcrossSteps", DEFAULT_CONFIG.persistSessionAcrossSteps);
	if (!persistSessionAcrossSteps.ok) return persistSessionAcrossSteps;

	return success({
		sideA: sideA.value,
		sideB: sideB.value,
		planner: plannerConfig,
		critic: criticConfig,
		implementer: implementerConfig,
		reviewer: reviewerConfig,
		executionMode: executionModeValue as ExecutionMode,
		startImplementer: startImplementerValue,
		maxPlanRounds: maxPlanRounds.value ?? DEFAULT_CONFIG.maxPlanRounds,
		maxExecutionRounds: maxExecutionRounds.value ?? DEFAULT_CONFIG.maxExecutionRounds,
		alternateByStep: alternateByStep.value,
		checks,
		repo: {
			requireGit: requireGit.value,
			requireCleanStart: requireCleanStart.value,
			enforceCleanAfterStep: enforceCleanAfterStep.value,
			captureDiffCheck: captureDiffCheck.value,
			commitPerStep: commitPerStep.value,
		},
		persistSessionAcrossSteps: persistSessionAcrossSteps.value,
	});
}

function validatePlanStep(value: unknown, checkIds: Set<string>, index: number): ValidationResult<PlanStep> {
	if (!isObject(value)) return failure(`steps[${index}] must be an object`);
	const id = readString(value, "id", `steps[${index}].id`);
	if (!id.ok) return id;
	const title = readString(value, "title", `steps[${index}].title`);
	if (!title.ok) return title;
	const description = readString(value, "description", `steps[${index}].description`);
	if (!description.ok) return description;
	const requiredChecks = readStringArray(value, "requiredChecks", `steps[${index}].requiredChecks`);
	if (!requiredChecks.ok) return requiredChecks;
	for (const checkId of requiredChecks.value) {
		if (!checkIds.has(checkId)) {
			return failure(`steps[${index}].requiredChecks contains unknown check id '${checkId}'`);
		}
	}
	return success({
		id: id.value,
		title: title.value,
		description: description.value,
		requiredChecks: requiredChecks.value,
		inputs: readOptionalStringArray(value, "inputs"),
		filesLikelyTouched: readOptionalStringArray(value, "filesLikelyTouched"),
		acceptanceCriteria: readOptionalStringArray(value, "acceptanceCriteria"),
		outOfScope: readOptionalStringArray(value, "outOfScope"),
	});
}

export function createPlanDraftValidator(config: DuetConfig): Validator<PlanDraft> {
	const checkIds = new Set(Object.keys(config.checks));
	return (value: unknown): ValidationResult<PlanDraft> => {
		if (!isObject(value)) return failure("PlanDraft must be an object");
		const goal = readString(value, "goal", "goal");
		if (!goal.ok) return goal;
		const stepsValue = value.steps;
		if (!Array.isArray(stepsValue) || stepsValue.length === 0) return failure("steps must be a non-empty array");
		const steps: PlanStep[] = [];
		for (const [index, stepValue] of stepsValue.entries()) {
			const step = validatePlanStep(stepValue, checkIds, index);
			if (!step.ok) return step;
			steps.push(step.value);
		}
		return success({
			goal: goal.value,
			steps,
			assumptions: readOptionalStringArray(value, "assumptions"),
			testStrategy: readOptionalStringArray(value, "testStrategy"),
			rollbackPlan: readOptionalStringArray(value, "rollbackPlan"),
		});
	};
}

export const validatePlanReview: Validator<PlanReview> = (value: unknown) => {
	if (!isObject(value)) return failure("PlanReview must be an object");
	const verdict = value.verdict;
	if (verdict !== "approve" && verdict !== "changes_requested") return failure("verdict must be approve or changes_requested");
	const blockingIssues = readStringArray(value, "blockingIssues", "blockingIssues");
	if (!blockingIssues.ok) return blockingIssues;
	const confidenceValue = typeof value.confidence === "number" ? value.confidence : undefined;
	return success({
		verdict,
		blockingIssues: blockingIssues.value,
		nonBlocking: readOptionalStringArray(value, "nonBlocking"),
		missingChecks: readOptionalStringArray(value, "missingChecks"),
		confidence: confidenceValue,
	});
};

export const validateImplementationReport: Validator<ImplementationReport> = (value: unknown) => {
	if (!isObject(value)) return failure("ImplementationReport must be an object");
	const stepId = readString(value, "stepId", "stepId");
	if (!stepId.ok) return stepId;
	const filesChanged = readStringArray(value, "filesChanged", "filesChanged");
	if (!filesChanged.ok) return filesChanged;
	const diffSummary = typeof value.diffSummary === "string" ? value.diffSummary : undefined;
	return success({
		stepId: stepId.value,
		filesChanged: filesChanged.value,
		diffSummary,
		commandsRun: readOptionalCommandRefs(value, "commandsRun"),
		notes: readOptionalStringArray(value, "notes"),
		openRisks: readOptionalStringArray(value, "openRisks"),
	});
};

export const validateReviewReport: Validator<ReviewReport> = (value: unknown) => {
	if (!isObject(value)) return failure("ReviewReport must be an object");
	const stepId = readString(value, "stepId", "stepId");
	if (!stepId.ok) return stepId;
	const verdict = value.verdict;
	if (verdict !== "approve" && verdict !== "changes_requested" && verdict !== "replan_needed") {
		return failure("verdict must be approve, changes_requested, or replan_needed");
	}
	const blockingIssues = readStringArray(value, "blockingIssues", "blockingIssues");
	if (!blockingIssues.ok) return blockingIssues;
	const confidenceValue = typeof value.confidence === "number" ? value.confidence : undefined;
	return success({
		stepId: stepId.value,
		verdict,
		blockingIssues: blockingIssues.value,
		nonBlocking: readOptionalStringArray(value, "nonBlocking"),
		testsVerified: readOptionalCommandRefs(value, "testsVerified"),
		missingCoverage: readOptionalStringArray(value, "missingCoverage"),
		confidence: confidenceValue,
	});
};

export const validateEscalationReport: Validator<EscalationReport> = (value: unknown) => {
	if (!isObject(value)) return failure("EscalationReport must be an object");
	const stepId = readString(value, "stepId", "stepId");
	if (!stepId.ok) return stepId;
	const reason = readString(value, "reason", "reason");
	if (!reason.ok) return reason;
	const VALID_CATEGORIES = ["underplanned", "wrong_sequence", "broader_refactor", "assumption_invalid", "other"] as const;
	const category = value.category;
	if (!VALID_CATEGORIES.includes(category as (typeof VALID_CATEGORIES)[number])) {
		return failure(`category must be one of: ${VALID_CATEGORIES.join(", ")}`);
	}
	return success({
		stepId: stepId.value,
		reason: reason.value,
		category: category as EscalationReport["category"],
		suggestedChanges: readOptionalStringArray(value, "suggestedChanges"),
	});
};

// ---------------------------------------------------------------------------
// Natural-language verdict footer parser
// ---------------------------------------------------------------------------

/**
 * Parse a verdict footer from natural language text.
 * Looks for "Verdict: approve|changes_requested|replan_needed" and optional "Blocking issues:" and "Escalation reason:" lines.
 * Returns null if no verdict line is found.
 */
export function parseVerdictFooter(
	text: string,
): { verdict: "approve" | "changes_requested" | "replan_needed"; blockingIssues: string[]; escalationReason?: string } | null {
	const lines = text.split("\n");
	let verdict: "approve" | "changes_requested" | "replan_needed" | null = null;
	const blockingIssues: string[] = [];
	let escalationReason: string | undefined;
	let inBlockingSection = false;

	for (const line of lines) {
		const trimmed = line.trim();

		// Match verdict line: "Verdict: approve" or "## Verdict: changes_requested" or "Verdict: replan_needed"
		const verdictMatch = trimmed.match(/^(?:##\s*)?verdict\s*:\s*(approve|changes_requested|replan_needed)\s*$/i);
		if (verdictMatch) {
			verdict = verdictMatch[1].toLowerCase() as "approve" | "changes_requested" | "replan_needed";
			inBlockingSection = false;
			continue;
		}

		// Match escalation reason line: "Escalation reason: <text>"
		const escalationMatch = trimmed.match(/^(?:##\s*)?escalation\s+reason\s*:\s*(.+)$/i);
		if (escalationMatch) {
			escalationReason = escalationMatch[1].trim();
			inBlockingSection = false;
			continue;
		}

		// Match blocking issues header
		if (/^(?:##\s*)?blocking\s+issues\s*:/i.test(trimmed)) {
			inBlockingSection = true;
			continue;
		}

		// Any other section header stops bullet collection
		if (/^(?:##\s*)?(?:non[- ]?blocking|notes|summary|verdict|escalation)/i.test(trimmed) && inBlockingSection) {
			inBlockingSection = false;
			continue;
		}

		// Collect bullets in blocking section
		if (inBlockingSection) {
			const bullet = trimmed.match(/^[-*]\s+(.+)/);
			if (bullet) {
				const issueText = bullet[1].trim();
				if (!/^none$|^n\/a$/i.test(issueText)) {
					blockingIssues.push(issueText);
				}
			} else if (trimmed === "") {
				inBlockingSection = false;
			}
		}
	}

	if (!verdict) return null;
	return { verdict, blockingIssues, ...(escalationReason !== undefined ? { escalationReason } : {}) };
}

export function otherSide(side: Side): Side {
	return side === "A" ? "B" : "A";
}

export function getImplementerForStep(config: DuetConfig, stepIndex: number): Side {
	if (!config.alternateByStep) return config.startImplementer;
	return stepIndex % 2 === 0 ? config.startImplementer : otherSide(config.startImplementer);
}

export function getSideConfig(config: DuetConfig, side: Side): SideConfig {
	return side === "A" ? config.sideA : config.sideB;
}

function compactStatusRoleLabel(label: string, fallback: string): string {
	const trimmed = label.trim();
	if (!trimmed) return fallback;
	const words = trimmed.split(/\s+/).filter(Boolean);
	if (words.length >= 2) {
		return words.map((word) => word[0]?.toLowerCase() ?? "").join("").slice(0, 4) || fallback;
	}
	return trimmed.toLowerCase().slice(0, 4) || fallback;
}

export function formatStatus(state: DuetState): string {
	const parts = [`duet:${state.phase}`];
	if (state.stepIndex !== undefined) parts.push(`step:${state.stepIndex + 1}`);
	if (state.round !== undefined) parts.push(`round:${state.round}`);
	if (state.activeSummary?.implementer) {
		const aLabel = state.activeSummary.roleLabels ? compactStatusRoleLabel(state.activeSummary.roleLabels.sideA, "impl") : "impl";
		parts.push(`${aLabel}:${state.activeSummary.implementer}`);
	}
	if (state.activeSummary?.reviewer) {
		const bLabel = state.activeSummary.roleLabels ? compactStatusRoleLabel(state.activeSummary.roleLabels.sideB, "rev") : "rev";
		parts.push(`${bLabel}:${state.activeSummary.reviewer}`);
	}
	if (state.activity && (state.phase === "planning" || state.phase === "executing")) parts.push(state.activity);
	if (state.pausedReason) parts.push(`paused:${state.pausedReason}`);
	return parts.join(" • ");
}

export function formatWidgetLines(state: DuetState): string[] {
	const lines: string[] = [];
	lines.push(`Phase: ${state.phase}`);
	if (state.goal) lines.push(`Goal: ${state.goal}`);
	if (state.planSourcePath) lines.push(`Plan file: ${state.planSourcePath}`);
	if (state.activeConfig) {
		lines.push(
			`Models: A=${state.activeConfig.sideA.model} (${state.activeConfig.sideA.thinking}) | B=${state.activeConfig.sideB.model} (${state.activeConfig.sideB.thinking})`,
		);
	}
	if (state.handoffMode) lines.push(`Handoff: ${state.handoffMode}`);
	if (state.activeSummary?.stepTitle) lines.push(`Step: ${state.activeSummary.stepTitle}`);
	if (state.activeSummary?.implementer && state.activeSummary?.reviewer) {
		const labels = state.activeSummary.roleLabels ?? { sideA: "Implementer", sideB: "Reviewer" };
		lines.push(`${labels.sideA}: ${state.activeSummary.implementer} | ${labels.sideB}: ${state.activeSummary.reviewer}`);
	}
	if (state.round !== undefined) lines.push(`Round: ${state.round}`);
	if (state.activeSummary?.lastVerdict) lines.push(`Last verdict: ${state.activeSummary.lastVerdict}`);
	if (state.activeSummary?.gateResults?.length) {
		lines.push("Checks:");
		for (const gate of state.activeSummary.gateResults) {
			lines.push(`- ${gate.id}: ${gate.passed ? "passed" : "failed"}`);
		}
	}
	if (state.pausedReason) lines.push(`Paused: ${state.pausedReason}`);
	return lines;
}

export function getConfigPath(cwd: string): string {
	return path.join(cwd, ".pi", "duet", "config.json");
}
