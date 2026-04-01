import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { Key, matchesKey, Markdown, type Component, type MarkdownTheme } from "@mariozechner/pi-tui";
import { BorderedLoader, getMarkdownTheme, type ExtensionAPI, type ExtensionContext } from "@mariozechner/pi-coding-agent";
import {
	acquireRunLock,
	appendIntervention,
	appendSystemIntervention,
	artifactPreview,
	continuousSessionDir,
	deleteRunRoot,
	ensureDir,
	escalationDir,
	generateRunId,
	isRunLockedByOther,
	loadConfig,
	loadInterventions,
	loadLatestRunState,
	loadPendingInterventions,
	helperSessionDir,
	markInterventionDelivered,
	planningRoleSessionDir,
	planningRoundDir,
	readJson,
	releaseRunLock,
	replanRoundDir,
	replanSessionDir,
	roleSessionDir,
	runRoot,
	runsRoot,
	saveConfig,
	stepIterationDir,
	writeJson,
	writeRunStateSnapshot,
	writeText,
} from "./fs.js";
import { pickFileInRepo } from "./file-picker.js";
import { pickModelChoice, pickThinkingLevel } from "./model-picker.js";
import { getScopedModelChoices } from "./models.js";
import { runSide, type RunSideEvent, type RunSideOptions, type RunSideResult } from "./runner.js";
import {
	createInitialState,
	createPlanDraftValidator,
	DEFAULT_CONFIG,
	type ActiveChildInfo,
	type EscalationReport,
	formatStatus,
	formatWidgetLines,
	getImplementerForStep,
	getRoleConfig,
	IMPLEMENTER_TOOLS,
	inactiveChildId,
	type InterventionEntry,
	otherSide,
	PLANNING_TOOLS,
	type DuetConfig,
	type DuetRole,
	type DuetState,
	type ExecutionMode,
	type GateEvidence,
	type HandoffMode,
	type PostPlanMode,
	type SideConfig,
	type ImplementationReport,
	parseVerdictFooter,
	type ThinkingLevel,
	type PauseReason,
	type PlanDraft,
	type PlanReview,
	type ResumeAction,
	REVIEWER_TOOLS,
	type ReviewReport,
	validateConfig,
	validateEscalationReport,
	validateImplementationReport,
	validatePlanReview,
	validateReviewReport,
} from "./types.js";
import { DuetWorkspaceUI } from "./workspace-ui.js";
import { loadAllRuns, RunListComponent, type RunAction } from "./run-list-ui.js";
import {
	type GateRunResult,
	type PlanSummaryReport,
	type HandoffSummaryReport,
	type PlanningLoopOptions,
	roleAddendum,
	draftPlanRelPath,
	draftPlanAbsPath,
	planJsonSchema,
	planPrompt,
	planReviewPrompt,
	replanPrompt,
	replanReviewPrompt,
	importPlanPrompt,
	gapAnalysisPlannerPrompt,
	gapAnalysisCriticPrompt,
	previousStepContext,
	implementationPrompt,
	reviewPrompt,
	relayPrompt,
	planSummaryPrompt,
	handoffSummaryPrompt,
	withRunHandoff,
	withOperatorNotes,
	withExecutionResumeContext,
	withPendingInterventions as withPendingInterventionsHelper,
	humanPlanFeedbackReview,
	formatPlanPreviewLines,
	formatPlanDocument,
	formatPlanSummaryText,
	formatHandoffSummaryText,
	shrinkTranscriptForSummary,
	validatePlanSummaryReport,
	validateHandoffSummaryReport,
	healthCheckScoutPrompt,
	planHealthCheckPrompt,
	formatPlanHealthCheckText,
	validatePlanHealthCheckResult,
	loadPlanSourceFile,
} from "./prompts.js";
import {
	type ExecResult,
	type GitSnapshot,
	execShell,
	writeBoundedArtifact,
	getGitSnapshot,
	ensureRepoReady,
	runControllerGates,
	commitApprovedStep,
} from "./gates.js";
import {
	extractCostFromMessages,
	appendCostEntry,
	loadRunCostSummary,
	formatCostOneLiner,
	formatCostReport,
} from "./cost.js";
import { generateRunReport, formatRunReportMarkdown } from "./run-report.js";
import {
	type RunHandoff,
	flattenStructuredContent,
	serializeSessionBranchForHandoff,
	saveRunHandoff,
	loadRunHandoff,
	loadRunOperatorNotes,
	appendRunOperatorNote,
} from "./handoff.js";
import { hasWebResearchTools, runDeepResearch } from "./deep-research.js";
import {
	parseObservationsFromText,
	appendObservations,
	loadObservations,
	loadStepObservations,
	formatObservationsReport,
	formatObservationsOneLiner,
	observationsContextForStep,
} from "./observations.js";

type DuetCommandContext = ExtensionContext & { waitForIdle(): Promise<void> };
















async function promptForOperatorNote(ctx: ExtensionContext, runId: string): Promise<string | undefined> {
	if (!ctx.hasUI) return undefined;
	const existing = loadRunOperatorNotes(ctx.cwd, runId);
	const note = await ctx.ui.editor(
		"Duet: add operator note for this run",
		existing
			? `${existing.trimEnd()}\n\n## New operator note\n\n`
			: "## New operator note\n\n",
	);
	if (note === undefined) return undefined;
	const marker = "## New operator note";
	const markerIndex = note.lastIndexOf(marker);
	const extracted = markerIndex >= 0 ? note.slice(markerIndex + marker.length).trim() : note.trim();
	return extracted.length > 0 ? extracted : undefined;
}

function scoreSummaryModel(modelKey: string): number {
	const text = modelKey.toLowerCase();
	let score = 0;
	if (text.includes("haiku")) score += 200;
	if (text.includes("mini")) score += 180;
	if (text.includes("nano")) score += 140;
	if (text.includes("flash")) score += 100;
	if (text.includes("small")) score += 80;
	return score;
}

type DeadlockChoice = "approve" | "continue" | "abort";

/**
 * When a planning or execution loop exhausts its max rounds, prompt the user
 * instead of silently pausing.
 */
async function promptDeadlock(
	ctx: ExtensionContext,
	kind: "planning" | "execution",
	roundsUsed: number,
): Promise<{ choice: DeadlockChoice; extraRounds: number }> {
	if (!ctx.hasUI) return { choice: "abort", extraRounds: 0 };

	const label = kind === "planning" ? "Plan not approved" : "Step not approved";

	const options = [
		"Approve anyway and proceed",
		"Continue for 2 more rounds",
		"Abort",
	];

	const selected = await ctx.ui.select(`${label} after ${roundsUsed} rounds`, options);

	if (!selected || selected === "Abort") return { choice: "abort", extraRounds: 0 };
	if (selected.startsWith("Approve")) return { choice: "approve", extraRounds: 0 };
	return { choice: "continue", extraRounds: 2 };
}

/**
 * When a panel run errors (API failure, timeout, etc.), ask the user
 * whether to retry the round or abort the whole run.
 */
const AUTO_RETRY_DELAYS_SEC = [10, 30, 90] as const;

async function promptPanelError(ctx: ExtensionContext, errorMessage: string): Promise<"retry" | "switch_model" | "abort"> {
	if (!ctx.hasUI) return "abort";
	const truncated = errorMessage.length > 120 ? `${errorMessage.slice(0, 120)}...` : errorMessage;
	const selected = await ctx.ui.select(`Error: ${truncated}`, [
		"Retry now",
		"Switch model and retry",
		"Abort",
	]);
	if (!selected || selected === "Abort") return "abort";
	if (selected.startsWith("Switch model")) return "switch_model";
	return "retry";
}

async function sleepWithAbort(ms: number, signal?: AbortSignal): Promise<boolean> {
	if (signal?.aborted) return false;
	return await new Promise<boolean>((resolve) => {
		const timer = setTimeout(() => {
			cleanup();
			resolve(true);
		}, ms);
		const onAbort = () => {
			clearTimeout(timer);
			cleanup();
			resolve(false);
		};
		const cleanup = () => signal?.removeEventListener("abort", onAbort);
		signal?.addEventListener("abort", onAbort, { once: true });
	});
}

async function maybeAutoRetryChildError(
	ctx: ExtensionContext,
	message: string,
	attemptsUsed: number,
	contextLabel: string,
	signal?: AbortSignal,
	onStatus?: (label: string) => void,
): Promise<{ retry: boolean; attemptsUsed: number }> {
	if (attemptsUsed >= AUTO_RETRY_DELAYS_SEC.length) {
		return { retry: false, attemptsUsed };
	}
	const delaySec = AUTO_RETRY_DELAYS_SEC[attemptsUsed]!;
	const short = message.length > 140 ? `${message.slice(0, 140)}...` : message;
	onStatus?.(`Retrying in ${delaySec}s (${attemptsUsed + 1}/${AUTO_RETRY_DELAYS_SEC.length})...`);
	if (ctx.hasUI) {
		ctx.ui.notify(
			`${contextLabel} failed: ${short} Auto-retrying in ${delaySec}s (${attemptsUsed + 1}/${AUTO_RETRY_DELAYS_SEC.length}).`,
			"warning",
		);
	}
	const completed = await sleepWithAbort(delaySec * 1000, signal);
	if (!completed) return { retry: false, attemptsUsed };
	return { retry: true, attemptsUsed: attemptsUsed + 1 };
}

type EscalationChoice = "add_guidance" | "replan" | "continue" | "pause";

/**
 * When an agent signals a replan_needed escalation, prompt the user for how to proceed.
 * Displays the escalation reason in the select title.
 * Falls back to 'pause' when there is no UI.
 */
async function promptEscalation(
	ctx: ExtensionContext,
	stepIndex: number,
	stepTitle: string,
	escalationReason: string,
): Promise<EscalationChoice> {
	if (!ctx.hasUI) return "pause";

	const truncatedReason =
		escalationReason.length > 200 ? `${escalationReason.slice(0, 200)}...` : escalationReason;

	const options = [
		"Add operator guidance and retry this step",
		"Replan from this step onward",
		"Continue execution anyway",
		"Pause for manual inspection",
	];

	const selected = await ctx.ui.select(
		`Escalation at step ${stepIndex + 1}: ${stepTitle} — ${truncatedReason}`,
		options,
	);

	if (!selected || selected === "Pause for manual inspection") return "pause";
	if (selected.startsWith("Add operator guidance")) return "add_guidance";
	if (selected.startsWith("Replan")) return "replan";
	return "continue";
}

async function captureOperatorNoteForRun(ctx: ExtensionContext, runId: string): Promise<boolean> {
	const note = await promptForOperatorNote(ctx, runId);
	if (note) {
		appendRunOperatorNote(ctx.cwd, runId, note);
		if (ctx.hasUI) ctx.ui.notify("Added operator note to this run. Replaying current round with updated guidance.", "info");
		return true;
	}
	if (ctx.hasUI) ctx.ui.notify("No operator note added. Replaying current round unchanged.", "info");
	return false;
}



function updateUi(ctx: ExtensionContext, state: DuetState): void {
	if (!ctx.hasUI) return;
	const shouldShow = state.phase !== "idle" && state.phase !== "aborted" && state.phase !== "completed";
	ctx.ui.setStatus("duet", shouldShow ? formatStatus(state) : undefined);
	ctx.ui.setWidget("duet", undefined);
}

/**
 * Module-level pure helper: prepend pending interventions to a prompt so the agent
 * sees operator steer/notes at the start of its turn.
 *
 * Defined at module scope so `runRelayStep` (which is also module-level) can use it.
 */

function emitStatusText(ctx: ExtensionContext, state: DuetState): void {
	if (ctx.hasUI) {
		ctx.ui.notify(formatStatus(state), "info");
		return;
	}
	console.log(formatWidgetLines(state).join("\n"));
}

function restoreState(ctx: ExtensionContext): DuetState {
	let restored = createInitialState();
	for (const entry of ctx.sessionManager.getEntries()) {
		const customEntry = entry as { type: string; customType?: string; data?: unknown };
		if (customEntry.type === "custom" && customEntry.customType === "duet-state" && customEntry.data) {
			restored = customEntry.data as DuetState;
		}
	}
	// If the session log has no duet state (new session after crash/restart),
	// check disk for a recent non-idle run that may be resumable.
	// Skip runs that are actively locked by another process (parallel session).
	if (restored.phase === "idle") {
		const diskState = loadLatestRunState(ctx.cwd);
		if (diskState && diskState.phase !== "idle" && diskState.phase !== "completed") {
			const lockedByOther = diskState.runId ? isRunLockedByOther(ctx.cwd, diskState.runId) : false;
			if (!lockedByOther) {
				restored = diskState;
			}
		}
	}
	if (restored.activeConfig) {
		const validated = validateConfig(restored.activeConfig);
		if (validated.ok) restored.activeConfig = validated.value;
	}
	return restored;
}

function persistState(pi: ExtensionAPI, cwd: string, state: DuetState): void {
	state.updatedAt = new Date().toISOString();
	pi.appendEntry("duet-state", state);
	writeRunStateSnapshot(cwd, state);
}

function pauseState(
	pi: ExtensionAPI,
	cwd: string,
	state: DuetState,
	reason: PauseReason,
	resumeAction: ResumeAction | undefined,
): DuetState {
	const next: DuetState = {
		...state,
		phase: "paused",
		pausedReason: reason,
		resumeAction,
		activity: undefined,
		updatedAt: new Date().toISOString(),
	};
	persistState(pi, cwd, next);
	return next;
}






// (runWithPanel removed — workspace UI hooks are now inlined per-runSide call)

// ---------------------------------------------------------------------------
// Relay step orchestrator — runs an entire relay step sequentially with
// workspace UI hooks for live streaming display
// ---------------------------------------------------------------------------

/** Read the previous relay agent's final text from disk, if any. */
function loadPreviousRelayAssistantText(cwd: string, runId: string, stepIndex: number, round: number): string | undefined {
	if (round <= 1) return undefined;
	const previousRound = round - 1;
	const previousAgentDir = previousRound % 2 === 1 ? "agent-a" : "agent-b";
	const assistantPath = path.join(stepIterationDir(cwd, runId, stepIndex, previousRound), previousAgentDir, "assistant.txt");
	if (!fs.existsSync(assistantPath)) return undefined;
	try {
		const text = fs.readFileSync(assistantPath, "utf8").trim();
		return text.length > 0 ? text : undefined;
	} catch {
		return undefined;
	}
}

type RelayStepOutcome = "completed" | "deadlock" | "aborted" | "error" | "escalate";

interface RelayStepResult {
	outcome: RelayStepOutcome;
	finalRound: number;
	gateResult?: GateRunResult;
	errorMessage?: string;
	escalationReason?: string;
}

/**
 * Optional workspace UI hooks for streaming display during relay agent turns.
 * When provided, each runSide call feeds events into the workspace widget for
 * live display. No-ops when workspace is null (no-UI path).
 */
interface RelayWorkspaceHooks {
	setActiveChild(info: ActiveChildInfo | undefined): void;
	feedEvent(event: RunSideEvent): void;
	setPhaseLabel(label: string): void;
	showCheckProgress(checkId: string, status: "running" | "passed" | "failed"): void;
}

/**
 * Orchestrate an entire relay step sequentially with workspace UI hooks.
 *
 * The same sequential path runs whether or not there is a UI — when `workspaceHooks`
 * is provided the workspace widget receives streaming events; when it is undefined
 * (no-UI path) the calls are simply no-ops.
 *
 * `externalSignal` — if provided, aborting it also aborts the child process.
 */
async function runRelayStep(
	ctx: ExtensionContext,
	pi: ExtensionAPI,
	plan: PlanDraft,
	stepIndex: number,
	config: DuetConfig,
	runId: string,
	startRound: number,
	maxRounds: number,
	handoff: RunHandoff | undefined,
	resumedExecution: boolean,
	onActivityChange?: (activity: string | undefined, round: number) => void,
	externalSignal?: AbortSignal,
	getPendingForChild?: (cwd: string, runId: string, childId: string) => InterventionEntry[],
	workspaceHooks?: RelayWorkspaceHooks,
): Promise<RelayStepResult> {
	// Use the provided helper or fall back to disk-only lookup
	const getInterventions = getPendingForChild
		?? ((cwd: string, rid: string, childId: string) => loadPendingInterventions(cwd, rid, childId));
	const step = plan.steps[stepIndex];

	// Two agent configs that alternate: round 1 → A, round 2 → B, etc.
	const agentConfigs = [
		{ role: "A" as const, config: getRoleConfig(config, "implementer"), label: "Agent A" },
		{ role: "B" as const, config: getRoleConfig(config, "reviewer"), label: "Agent B" },
	];

	// Build step transition context for the first round of a persistent-session step
	const stepTransition = config.persistSessionAcrossSteps && stepIndex > 0 && startRound === 1
		? previousStepContext(plan, stepIndex, ctx.cwd, runId)
		: undefined;

	/** Build the relayPrompt + operator notes + handoff wrapper for an agent round. */
	function buildRelayPrompt(round: number, previousAgentText: string | undefined, lastGates: GateRunResult | undefined): string {
		const operatorNotes = loadRunOperatorNotes(ctx.cwd, runId);
		const resumedRound = resumedExecution && round === startRound;
		// Only inject step transition context on the very first round of this step
		const transitionCtx = round === startRound ? stepTransition : undefined;
		// Feed high/medium observations from earlier steps so agents can address them if in scope
		const obsContext = observationsContextForStep(ctx.cwd, runId, stepIndex);
		return withOperatorNotes(
			withRunHandoff(withExecutionResumeContext(relayPrompt(plan, stepIndex, round, previousAgentText, lastGates, transitionCtx, obsContext), resumedRound), handoff),
			operatorNotes,
		);
	}

	/** Validate / extract relay verdict from a parsed result or raw text. */
	const validateRelayVerdict = (
		value: unknown,
	): { ok: true; value: { verdict: "approve" | "changes_made" | "replan_needed" } } | { ok: false; error: string } => {
		if (typeof value !== "object" || value === null || !("verdict" in (value as Record<string, unknown>))) {
			return { ok: false, error: "Missing verdict" };
		}
		const verdict = (value as Record<string, unknown>).verdict;
		if (verdict !== "approve" && verdict !== "changes_made" && verdict !== "replan_needed") {
			return { ok: false, error: "verdict must be approve, changes_made, or replan_needed" };
		}
		return { ok: true, value: { verdict } };
	};

	const extractRelayVerdict = (text: string): { verdict: string } | null => {
		const footer = parseVerdictFooter(text);
		if (footer) return { verdict: footer.verdict };
		const lines = text.split("\n");
		for (let i = lines.length - 1; i >= 0; i--) {
			const line = lines[i].trim().toLowerCase();
			if (line.startsWith("verdict:")) {
				const v = line.slice("verdict:".length).trim();
				if (v === "approve" || v === "changes_made" || v === "replan_needed") return { verdict: v };
			}
		}
		return null;
	};

	/** Extract escalation reason from agent's final text. */
	const extractRelayEscalationReason = (text: string): string => {
		const footer = parseVerdictFooter(text);
		if (footer?.escalationReason) return footer.escalationReason;
		if (footer?.blockingIssues && footer.blockingIssues.length > 0) return footer.blockingIssues.join("; ");
		const trimmed = text.trim();
		return trimmed.slice(0, 500) || "Step requires replanning";
	};

	// Single sequential path — workspace hooks are no-ops when workspaceHooks is undefined.
	let currentRound = startRound;
	try {
		let previousAgentText: string | undefined = loadPreviousRelayAssistantText(ctx.cwd, runId, stepIndex, startRound);
		let lastGates: GateRunResult | undefined;

		for (let round = startRound; round <= maxRounds; round++) {
			currentRound = round;
			const agent = agentConfigs[(round - 1) % 2];
			const roundDir = stepIterationDir(ctx.cwd, runId, stepIndex, round);

			// Controller snapshot gates before each round > 1
			if (round > 1) {
				onActivityChange?.("controller snapshot", round);
				workspaceHooks?.setPhaseLabel("Running checks...");
				lastGates = await runControllerGates(pi, roundDir, step, config, "snapshot", (checkId, status) => {
					workspaceHooks?.showCheckProgress(checkId, status);
				});
			}

			onActivityChange?.(`${agent.label} turn`, round);
			const relayRole = agent.role === "A" ? "relay-a" : "relay-b";
			const relayChildId = agent.role === "A" ? "A-relay-a" : "B-relay-b";
			const relayInterventions = getInterventions(ctx.cwd, runId, relayChildId);

			// Before runSide: activate child in workspace
			const activeChildInfo: ActiveChildInfo = {
				childId: relayChildId,
				side: agent.role,
				role: relayRole,
				model: agent.config.model,
				startedAt: new Date().toISOString(),
				round,
				stepIndex,
			};
			workspaceHooks?.setActiveChild(activeChildInfo);

			const relaySessionDir = config.persistSessionAcrossSteps
				? continuousSessionDir(ctx.cwd, runId, relayRole)
				: roleSessionDir(ctx.cwd, runId, stepIndex, relayRole);
			const result = await runSide({
				cwd: ctx.cwd,
				model: agent.config.model,
				thinkingLevel: agent.config.thinking,
				tools: IMPLEMENTER_TOOLS,
				prompt: withPendingInterventionsHelper(buildRelayPrompt(round, previousAgentText, lastGates), relayInterventions),
				roleSystemAddendum: roleAddendum("relay", config),
				artifactsDir: path.join(roundDir, agent.role === "A" ? "agent-a" : "agent-b"),
				sessionDir: relaySessionDir,
				schemaName: "RelayVerdict",
				validate: validateRelayVerdict,
				extractFromText: extractRelayVerdict,
				onEvent: (event) => { workspaceHooks?.feedEvent(event); },
				signal: externalSignal,
			});

			// After runSide: record cost, mark interventions delivered, clear active child
			try {
				const costEntry = extractCostFromMessages(result.messages, stepIndex, relayRole, round, agent.config.model);
				if (costEntry.totalTokens > 0) appendCostEntry(ctx.cwd, runId, costEntry);
			} catch { /* cost tracking is best-effort */ }
			for (const entry of relayInterventions) {
				markInterventionDelivered(ctx.cwd, runId, entry.id, round, stepIndex);
			}
			notifyDeliveredInterventions(ctx, relayInterventions, round);
			workspaceHooks?.setActiveChild(undefined);

			previousAgentText = result.finalAssistantText;
			writeJson(path.join(roundDir, "relay-result.json"), result.parsed);

			// Extract and persist any observations the agent logged
			try {
				const obs = parseObservationsFromText(result.finalAssistantText, stepIndex, round, relayRole);
				if (obs.length > 0) appendObservations(ctx.cwd, runId, obs);
			} catch { /* observation parsing is best-effort */ }

			const verdict = (result.parsed as { verdict: string }).verdict;
			if (verdict === "replan_needed") {
				const escalationReason = extractRelayEscalationReason(result.finalAssistantText);
				return { outcome: "escalate", finalRound: round, escalationReason };
			}
			if (verdict === "approve") {
				onActivityChange?.("final checks", round);
				workspaceHooks?.setPhaseLabel("Final checks...");
				const finalGates = await runControllerGates(pi, roundDir, step, config, "full", (checkId, status) => {
					workspaceHooks?.showCheckProgress(checkId, status);
				});
				if (finalGates.allPassed) {
					return { outcome: "completed", finalRound: round, gateResult: finalGates };
				}
				previousAgentText = `Previous agent approved but gate checks failed:\n${JSON.stringify(finalGates.evidence, null, 2)}\n\nFix the failing checks.`;
			}
		}

		return { outcome: "deadlock", finalRound: maxRounds };
	} catch (error) {
		workspaceHooks?.setActiveChild(undefined);
		if (externalSignal?.aborted) {
			return { outcome: "aborted", finalRound: currentRound };
		}
		const message = error instanceof Error ? error.message : String(error);
		return { outcome: "error", finalRound: currentRound, errorMessage: message };
	}
}

function notifyDeliveredInterventions(
	ctx: ExtensionContext,
	entries: InterventionEntry[],
	round: number,
): void {
	if (!ctx.hasUI || entries.length === 0) return;
	const childId = entries[0]?.target.childId;
	if (!childId) return;

	let steerCount = 0;
	let noteCount = 0;
	for (const entry of entries) {
		if (entry.target.intent === "steer") steerCount++;
		else noteCount++;
	}

	let summary = "";
	if (steerCount > 0 && noteCount > 0) {
		summary = `${entries.length} queued intervention${entries.length === 1 ? "" : "s"} (${steerCount} steer, ${noteCount} note${noteCount === 1 ? "" : "s"})`;
	} else if (steerCount > 0) {
		summary = steerCount === 1 ? "steer" : `${steerCount} queued steers`;
	} else {
		summary = noteCount === 1 ? "note" : `${noteCount} queued notes`;
	}

	ctx.ui.notify(`Delivered ${summary} to ${childId} for round ${round}.`, "info");
}

export default function duetExtension(pi: ExtensionAPI): void {
	let state = createInitialState();
	let draftPlanPreview: PlanDraft | undefined;
	let draftPlanLabel: string | undefined;
	let latestPlanSummaryText: string | undefined;
	let latestHealthCheckText: string | undefined;

	// ---------------------------------------------------------------------------
	// Background orchestration state — shared across command handlers
	// ---------------------------------------------------------------------------
	let orchestrationRunning = false;
	let orchestrationAbort: AbortController | null = null;
	const steeringQueue: InterventionEntry[] = [];
	let latestCtx: ExtensionContext | null = null;
	/** Last known active-child ID — used to route steers typed between overlay sessions. */
	let lastKnownActiveChildId: string | undefined = undefined;
	let workspace: DuetWorkspaceUI | null = null;

	// ---------------------------------------------------------------------------
	// Intervention helpers
	// ---------------------------------------------------------------------------

	/**
	 * Drain interventions for `childId` from the in-memory steering queue.
	 * Returns the matched entries (in insertion order) and removes them from the queue.
	 */
	function drainInterventionsFor(childId: string): InterventionEntry[] {
		const matched: InterventionEntry[] = [];
		for (let i = steeringQueue.length - 1; i >= 0; i--) {
			if (steeringQueue[i].target.childId === childId) {
				matched.unshift(steeringQueue.splice(i, 1)[0]);
			}
		}
		return matched;
	}

	/**
	 * Collect all pending (undelivered) interventions for `childId` from both the
	 * in-memory queue AND the on-disk log (for resume coherence across restarts).
	 * Items already in the queue are NOT double-counted from disk.
	 */
	function getPendingInterventionsFor(cwd: string, runId: string, childId: string): InterventionEntry[] {
		const fromQueue = drainInterventionsFor(childId);
		const queueIds = new Set(fromQueue.map((e) => e.id));
		const fromDisk = loadPendingInterventions(cwd, runId, childId).filter((e) => !queueIds.has(e.id));
		return [...fromQueue, ...fromDisk];
	}

	/**
	 * Count pending interventions in the steering queue per childId.
	 * Used by the workspace widget to show queued-note counts.
	 */
	function countPendingByChildId(): Record<string, number> {
		const counts: Record<string, number> = {};
		for (const entry of steeringQueue) {
			counts[entry.target.childId] = (counts[entry.target.childId] ?? 0) + 1;
		}
		return counts;
	}

	/**
	 * Prepend pending interventions to a prompt so the agent sees operator steer/notes
	 * at the start of its turn.  Delegates to the module-level pure helper.
	 */
	function withPendingInterventions(prompt: string, interventions: InterventionEntry[]): string {
		return withPendingInterventionsHelper(prompt, interventions);
	}

	/**
	 * Record cost from a runSide result. Call after every runSide invocation.
	 */
	function recordCost(
		runId: string,
		messages: import("@mariozechner/pi-ai").Message[],
		phase: "planning" | number,
		role: string,
		round: number,
		model: string,
	): void {
		try {
			const cwd = latestCtx?.cwd ?? "";
			const entry = extractCostFromMessages(messages, phase, role, round, model);
			if (entry.totalTokens > 0) {
				appendCostEntry(cwd, runId, entry);
				// Update workspace cost display
				const summary = loadRunCostSummary(cwd, runId);
				workspace?.setCostLine(formatCostOneLiner(summary));
			}
		} catch { /* cost tracking is best-effort */ }
	}

	function syncPlanWidgets(_ctx: ExtensionContext): void {
		const visiblePlan = state.plan ?? draftPlanPreview;
		if (visiblePlan) {
			workspace?.setPlanInfo({
				goal: visiblePlan.goal,
				steps: visiblePlan.steps.map((s) => ({ title: s.title, id: s.id })),
				summaryText: latestPlanSummaryText ?? undefined,
				stepIndex: state.stepIndex,
				phase: state.phase,
				round: state.round,
			});
		} else {
			workspace?.setPlanInfo(undefined);
		}
	}

	function clearPlanTransientUi(ctx: ExtensionContext): void {
		draftPlanPreview = undefined;
		draftPlanLabel = undefined;
		latestPlanSummaryText = undefined;
		workspace?.setPlanInfo(undefined);
		syncPlanWidgets(ctx);
	}

	function setState(ctx: ExtensionContext, next: DuetState): void {
		const prevActiveChild = state.activeChild;
		state = next;
		persistState(pi, ctx.cwd, state);
		// Sync workspace active-child display
		if (next.activeChild?.childId) {
			lastKnownActiveChildId = next.activeChild.childId;
			workspace?.setActiveChild(next.activeChild);
		} else if (!next.activeChild && prevActiveChild) {
			workspace?.setActiveChild(undefined);
		}
		updateUi(ctx, state);
		// Workspace manages its own status bar + widget (overrides updateUi's status bar)
		workspace?.update(next, countPendingByChildId());
		if (state.phase === "aborted" || state.phase === "completed" || state.phase === "idle") {
			clearPlanTransientUi(ctx);
		} else {
			syncPlanWidgets(ctx);
		}
	}

	function getBaseConfig(ctx: ExtensionContext): DuetConfig {
		return loadConfig(ctx.cwd) ?? DEFAULT_CONFIG;
	}

	function getActiveConfig(ctx: ExtensionContext): DuetConfig {
		if (state.activeConfig) {
			const validated = validateConfig(state.activeConfig);
			if (validated.ok) return validated.value;
		}
		return getBaseConfig(ctx);
	}


	function getCurrentApprovedPlan(ctx: ExtensionContext): { plan: PlanDraft; sourcePath?: string; runId?: string } | undefined {
		if (state.plan) {
			return { plan: state.plan, sourcePath: state.planSourcePath, runId: state.runId };
		}
		const runsDir = path.join(ctx.cwd, ".pi", "duet", "runs");
		if (!fs.existsSync(runsDir)) return undefined;
		const runIds = fs
			.readdirSync(runsDir, { withFileTypes: true })
			.filter((entry) => entry.isDirectory())
			.map((entry) => entry.name)
			.sort()
			.reverse();
		for (const runId of runIds) {
			const root = runRoot(ctx.cwd, runId);
			const planPath = path.join(root, "plan.json");
			if (!fs.existsSync(planPath)) continue;
			const sourcePathFile = path.join(root, "source-plan-path.txt");
			return {
				plan: JSON.parse(fs.readFileSync(planPath, "utf8")) as PlanDraft,
				sourcePath: fs.existsSync(sourcePathFile) ? fs.readFileSync(sourcePathFile, "utf8").trim() || undefined : undefined,
				runId,
			};
		}
		return undefined;
	}

	function getCurrentPlanConfig(ctx: ExtensionContext, runId?: string): DuetConfig {
		if (runId) {
			const snapshotPath = path.join(runRoot(ctx.cwd, runId), "config.snapshot.json");
			if (fs.existsSync(snapshotPath)) {
				const raw = JSON.parse(fs.readFileSync(snapshotPath, "utf8")) as unknown;
				const validated = validateConfig(raw);
				if (validated.ok) return validated.value;
			}
		}
		if (state.activeConfig) {
			const validated = validateConfig(state.activeConfig);
			if (validated.ok) return validated.value;
		}
		return getBaseConfig(ctx);
	}

	type RunCloseoutChoice = "compact" | "keep" | "delete";

	interface FinalStepArtifactSummary {
		finalDirName?: string;
		finalDirRel?: string;
		verdict: string;
		changedFiles: string[];
		checks: Array<{ id: string; passed: boolean }>;
	}

	async function promptForSuccessfulRunCloseout(ctx: ExtensionContext, runId: string): Promise<RunCloseoutChoice> {
		if (!ctx.hasUI) return "keep";
		const selected = await ctx.ui.select(`Duet run completed (${runId.slice(0, 19)})`, [
			"Compact and keep summary",
			"Keep full artifacts",
			"Delete run entirely",
		]);
		if (!selected || selected === "Compact and keep summary") return "compact";
		if (selected === "Delete run entirely") return "delete";
		return "keep";
	}

	function readJsonIfExists<T>(filePath: string): T | undefined {
		if (!fs.existsSync(filePath)) return undefined;
		try {
			return JSON.parse(fs.readFileSync(filePath, "utf8")) as T;
		} catch {
			return undefined;
		}
	}

	function getFinalStepArtifactSummary(cwd: string, runId: string, stepIndex: number): FinalStepArtifactSummary {
		const stepDir = path.join(runRoot(cwd, runId), "steps", String(stepIndex + 1));
		if (!fs.existsSync(stepDir)) {
			return { verdict: "unknown", changedFiles: [], checks: [] };
		}

		const iterationDirs = fs.readdirSync(stepDir, { withFileTypes: true })
			.filter((entry) => entry.isDirectory() && entry.name.startsWith("iteration-"))
			.map((entry) => entry.name)
			.sort((a, b) => Number(a.slice("iteration-".length)) - Number(b.slice("iteration-".length)));

		let finalDirName = iterationDirs[iterationDirs.length - 1];
		let verdict = "unknown";
		for (let i = iterationDirs.length - 1; i >= 0; i--) {
			const dirName = iterationDirs[i]!;
			const iterDir = path.join(stepDir, dirName);
			if (fs.existsSync(path.join(iterDir, "approved.json"))) {
				finalDirName = dirName;
				verdict = "approve";
				break;
			}
			if (fs.existsSync(path.join(iterDir, "force-approved.json"))) {
				finalDirName = dirName;
				verdict = "force_approved";
				break;
			}
		}

		if (!finalDirName) {
			return { verdict, changedFiles: [], checks: [] };
		}

		const finalDir = path.join(stepDir, finalDirName);
		const diffNamesPath = path.join(finalDir, "controller", "diff-name-only.txt");
		const changedFiles = fs.existsSync(diffNamesPath)
			? fs.readFileSync(diffNamesPath, "utf8").split("\n").map((line) => line.trim()).filter(Boolean)
			: [];
		const gateEvidence = readJsonIfExists<Array<{ checkId: string; passed: boolean }>>(path.join(finalDir, "controller", "gate-evidence.json")) ?? [];
		const checks = gateEvidence.map((item) => ({ id: item.checkId, passed: item.passed }));
		return {
			finalDirName,
			finalDirRel: path.relative(cwd, finalDir),
			verdict,
			changedFiles,
			checks,
		};
	}

	function buildCompletedRunSummary(ctx: ExtensionContext, runId: string, plan: PlanDraft, config: DuetConfig): string {
		const root = runRoot(ctx.cwd, runId);
		const savedState = readJsonIfExists<DuetState>(path.join(root, "state.json"));
		const operatorNotes = loadRunOperatorNotes(ctx.cwd, runId);
		const lines: string[] = [
			`# Duet run summary`,
			"",
			`Run ID: ${runId}`,
			`Phase: ${savedState?.phase ?? state.phase}`,
			`Updated: ${savedState?.updatedAt ?? state.updatedAt}`,
			`Goal: ${plan.goal}`,
			`Execution mode: ${config.executionMode}`,
			`Total steps: ${plan.steps.length}`,
		];
		if (savedState?.planSourcePath) lines.push(`Source plan file: ${savedState.planSourcePath}`);
		if (savedState?.handoffMode) lines.push(`Handoff mode: ${savedState.handoffMode}`);
		lines.push("", "## Final plan", `- plan.json`, "", "## Step outcomes");
		for (const [index, step] of plan.steps.entries()) {
			const summary = getFinalStepArtifactSummary(ctx.cwd, runId, index);
			lines.push("", `### ${index + 1}. ${step.title} (${step.id})`);
			lines.push(`- Verdict: ${summary.verdict}`);
			if (summary.finalDirRel) lines.push(`- Final artifacts: ${summary.finalDirRel}`);
			if (summary.changedFiles.length > 0) {
				lines.push(`- Changed files (${summary.changedFiles.length}):`);
				for (const file of summary.changedFiles.slice(0, 20)) lines.push(`  - ${file}`);
				if (summary.changedFiles.length > 20) lines.push(`  - ...and ${summary.changedFiles.length - 20} more`);
			}
			if (summary.checks.length > 0) {
				lines.push(`- Checks:`);
				for (const check of summary.checks) lines.push(`  - ${check.id}: ${check.passed ? "passed" : "failed"}`);
			}
		}
		lines.push("", "## Preserved artifacts", "- config.snapshot.json", "- state.json", "- plan.json", "- final step artifact directories", "- escalation directories", "- operator-notes.md (if present)", "- interventions.jsonl (if present)", "- interventions.1.jsonl (if rotated)");
		if (operatorNotes) {
			lines.push("", "## Operator notes preserved", operatorNotes.length > 4000 ? `${operatorNotes.slice(0, 4000)}\n...[truncated]` : operatorNotes);
		}
		return `${lines.join("\n")}\n`;
	}

	function buildParentSessionDuetSummary(ctx: ExtensionContext, runId: string, plan: PlanDraft, config: DuetConfig, closeoutMode: RunCloseoutChoice): string {
		const changedFiles = new Set<string>();
		const checkLines: string[] = [];
		for (const [index, step] of plan.steps.entries()) {
			const summary = getFinalStepArtifactSummary(ctx.cwd, runId, index);
			for (const file of summary.changedFiles) changedFiles.add(file);
			if (summary.checks.length > 0) {
				const rendered = summary.checks.map((check) => `${check.id}:${check.passed ? "pass" : "fail"}`).join(", ");
				checkLines.push(`${index + 1}. ${step.title}: ${rendered}`);
			}
		}
		const lines = [
			`Duet completed: ${plan.goal}`,
			`Run ID: ${runId}`,
			`Execution mode: ${config.executionMode}`,
			`Steps completed: ${plan.steps.length}/${plan.steps.length}`,
			`Artifact closeout: ${closeoutMode === "compact" ? "compacted to summary" : closeoutMode === "keep" ? "kept full artifacts" : "deleted run artifacts"}`,
		];
		if (changedFiles.size > 0) {
			lines.push(`Changed files (${changedFiles.size}): ${Array.from(changedFiles).slice(0, 12).join(", ")}${changedFiles.size > 12 ? ", ..." : ""}`);
		}
		if (checkLines.length > 0) {
			lines.push("Final checks by step:");
			for (const line of checkLines.slice(0, 8)) lines.push(`- ${line}`);
			if (checkLines.length > 8) lines.push(`- ...and ${checkLines.length - 8} more steps`);
		}
		lines.push(`Plan path: .pi/duet/runs/${runId}/plan.json`);
		if (closeoutMode === "compact") {
			lines.push(`Summary path: .pi/duet/runs/${runId}/run-summary.md`);
		} else if (closeoutMode === "keep") {
			lines.push(`Artifacts path: .pi/duet/runs/${runId}/`);
		}
		// Append cost summary
		const costSummary = loadRunCostSummary(ctx.cwd, runId);
		const costLine = formatCostOneLiner(costSummary);
		if (costLine) {
			lines.push(`Cost: ${costLine}`);
		}
		return lines.join("\n");
	}

	function removePathIfExists(targetPath: string): void {
		if (!fs.existsSync(targetPath)) return;
		fs.rmSync(targetPath, { recursive: true, force: true });
	}

	function compactCompletedRunArtifacts(ctx: ExtensionContext, runId: string, plan: PlanDraft, config: DuetConfig): void {
		const root = runRoot(ctx.cwd, runId);
		writeText(path.join(root, "run-summary.md"), buildCompletedRunSummary(ctx, runId, plan, config));
		writeJson(path.join(root, "closeout.json"), {
			mode: "compact",
			compactedAt: new Date().toISOString(),
			preserved: [
				"config.snapshot.json",
				"state.json",
				"plan.json",
				"run-summary.md",
				"run-report.md",
				"cost.json",
				"closeout.json",
				"operator-notes.md",
				"interventions.jsonl",
				"interventions.1.jsonl (if rotated)",
				"steps/*/iteration-* (final only)",
				"steps/*/escalation-*",
			],
		});

		for (const name of [
			"planning",
			"sessions",
			"handoff-summary",
			"plan-summary",
			"draft-plan.json",
			"source-plan.md",
			"source-plan-path.txt",
			"handoff.txt",
			"handoff.json",
			"handoff-source.txt",
		]) {
			removePathIfExists(path.join(root, name));
		}

		for (const [index] of plan.steps.entries()) {
			const stepDir = path.join(root, "steps", String(index + 1));
			if (!fs.existsSync(stepDir)) continue;
			const finalSummary = getFinalStepArtifactSummary(ctx.cwd, runId, index);
			const keepNames = new Set<string>();
			if (finalSummary.finalDirName) keepNames.add(finalSummary.finalDirName);
			for (const entry of fs.readdirSync(stepDir, { withFileTypes: true })) {
				if (entry.name.startsWith("escalation-")) continue;
				if (keepNames.has(entry.name)) continue;
				removePathIfExists(path.join(stepDir, entry.name));
			}
		}
	}

	async function finalizeSuccessfulRunCloseout(ctx: ExtensionContext, config: DuetConfig, plan: PlanDraft): Promise<void> {
		const runId = state.runId;
		if (!runId) return;

		// Generate observability report before compaction (needs full artifacts)
		try {
			const report = generateRunReport(ctx.cwd, runId, plan, config, state);
			const reportMd = formatRunReportMarkdown(report);
			writeText(path.join(runRoot(ctx.cwd, runId), "run-report.md"), reportMd);
		} catch { /* report generation is best-effort */ }

		const choice = await promptForSuccessfulRunCloseout(ctx, runId);
		const sessionSummary = buildParentSessionDuetSummary(ctx, runId, plan, config, choice);
		if (choice === "keep") {
			if (ctx.hasUI) ctx.ui.notify("Kept full duet artifacts.", "info");
		} else if (choice === "delete") {
			removePathIfExists(runRoot(ctx.cwd, runId));
			if (ctx.hasUI) ctx.ui.notify("Deleted completed duet run artifacts.", "warning");
		} else {
			compactCompletedRunArtifacts(ctx, runId, plan, config);
			if (ctx.hasUI) ctx.ui.notify("Compacted completed duet run artifacts and kept a summary.", "info");
		}
		pi.sendMessage({
			customType: "duet-summary",
			content: sessionSummary,
			display: true,
			details: { runId, phase: "completed", closeoutMode: choice },
		});
	}

	type StaleCleanupAction = "compact_completed" | "archive_incomplete" | "delete";

	interface StaleRunCandidate {
		runId: string;
		state: DuetState;
		action: StaleCleanupAction;
		ageDays: number;
		reason: string;
	}

	function getRunAgeDays(updatedAt: string | undefined): number {
		if (!updatedAt) return Number.POSITIVE_INFINITY;
		const ms = Date.parse(updatedAt);
		if (!Number.isFinite(ms)) return Number.POSITIVE_INFINITY;
		return Math.max(0, (Date.now() - ms) / (24 * 60 * 60 * 1000));
	}

	function getStaleRunCandidates(cwd: string, activeRunId?: string): StaleRunCandidate[] {
		const root = runsRoot(cwd);
		if (!fs.existsSync(root)) return [];
		const candidates: StaleRunCandidate[] = [];
		for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
			if (!entry.isDirectory()) continue;
			const runId = entry.name;
			if (activeRunId && runId === activeRunId) continue;
			const savedState = readJsonIfExists<DuetState>(path.join(root, runId, "state.json"));
			if (!savedState) continue;
			const ageDays = getRunAgeDays(savedState.updatedAt);
			const hasCloseout = fs.existsSync(path.join(root, runId, "closeout.json"));
			const hasPlan = !!savedState.plan || fs.existsSync(path.join(root, runId, "plan.json"));
			if (savedState.phase === "completed") {
				if (!hasCloseout && ageDays >= 1) {
					candidates.push({ runId, state: savedState, action: "compact_completed", ageDays, reason: "completed run with full artifacts" });
				}
				continue;
			}
			if (savedState.phase === "aborted" && !hasPlan && ageDays >= 3) {
				candidates.push({ runId, state: savedState, action: "delete", ageDays, reason: "aborted planning-only run with no reusable plan" });
				continue;
			}
			const staleIncomplete = ageDays >= 7 && (
				(savedState.phase === "paused") ||
				(savedState.phase === "aborted" && hasPlan) ||
				savedState.pausedReason === "replan_needed"
			);
			if (staleIncomplete) {
				candidates.push({ runId, state: savedState, action: "archive_incomplete", ageDays, reason: savedState.pausedReason === "replan_needed" ? "stale replan-needed run" : "stale paused/aborted run with progress" });
			}
		}
		return candidates.sort((a, b) => a.runId.localeCompare(b.runId));
	}

	function buildIncompleteRunSummary(ctx: ExtensionContext, runId: string, savedState: DuetState, config: DuetConfig): string {
		const plan = savedState.plan ?? readJsonIfExists<PlanDraft>(path.join(runRoot(ctx.cwd, runId), "plan.json"));
		const operatorNotes = loadRunOperatorNotes(ctx.cwd, runId);
		const lines: string[] = [
			"# Duet stale run summary",
			"",
			`Run ID: ${runId}`,
			`Phase: ${savedState.phase}`,
			`Updated: ${savedState.updatedAt}`,
			`Resume action: ${savedState.resumeAction ?? "none"}`,
			`Paused reason: ${savedState.pausedReason ?? "none"}`,
			`Execution mode: ${config.executionMode}`,
		];
		if (plan) {
			lines.push(`Goal: ${plan.goal}`, `Total steps: ${plan.steps.length}`);
		}
		if (savedState.stepIndex !== undefined && plan?.steps[savedState.stepIndex]) {
			const step = plan.steps[savedState.stepIndex];
			lines.push("", "## Current step when archived", `- ${savedState.stepIndex + 1}. ${step.title} (${step.id})`, `- Last recorded round: ${savedState.round ?? "unknown"}`);
		}
		lines.push("", "## Preserved artifacts", "- config.snapshot.json", "- state.json", "- plan.json (if present)", "- latest relevant step directory", "- escalation directories", "- operator-notes.md (if present)", "- interventions.jsonl (if present)", "- interventions.1.jsonl (if rotated)", "- stale-summary.md", "- closeout.json");
		if (operatorNotes) {
			lines.push("", "## Operator notes preserved", operatorNotes.length > 4000 ? `${operatorNotes.slice(0, 4000)}\n...[truncated]` : operatorNotes);
		}
		return `${lines.join("\n")}\n`;
	}

	function latestIterationDirName(stepDir: string): string | undefined {
		if (!fs.existsSync(stepDir)) return undefined;
		const names = fs.readdirSync(stepDir, { withFileTypes: true })
			.filter((entry) => entry.isDirectory() && entry.name.startsWith("iteration-"))
			.map((entry) => entry.name)
			.sort((a, b) => Number(a.slice("iteration-".length)) - Number(b.slice("iteration-".length)));
		return names[names.length - 1];
	}

	function archiveIncompleteRunArtifacts(ctx: ExtensionContext, runId: string, savedState: DuetState): void {
		const root = runRoot(ctx.cwd, runId);
		const config = getCurrentPlanConfig(ctx, runId);
		writeText(path.join(root, "stale-summary.md"), buildIncompleteRunSummary(ctx, runId, savedState, config));
		writeJson(path.join(root, "closeout.json"), {
			mode: "stale-archive",
			compactedAt: new Date().toISOString(),
			phase: savedState.phase,
			pausedReason: savedState.pausedReason,
		});
		for (const name of [
			"planning",
			"sessions",
			"handoff-summary",
			"plan-summary",
			"draft-plan.json",
			"source-plan.md",
			"source-plan-path.txt",
			"handoff.txt",
			"handoff.json",
			"handoff-source.txt",
		]) {
			removePathIfExists(path.join(root, name));
		}
		const stepsRoot = path.join(root, "steps");
		if (!fs.existsSync(stepsRoot)) return;
		const keepStep = savedState.stepIndex !== undefined ? String(savedState.stepIndex + 1) : undefined;
		for (const entry of fs.readdirSync(stepsRoot, { withFileTypes: true })) {
			if (!entry.isDirectory()) continue;
			const stepDir = path.join(stepsRoot, entry.name);
			if (entry.name !== keepStep) {
				removePathIfExists(stepDir);
				continue;
			}
			const latest = latestIterationDirName(stepDir);
			for (const child of fs.readdirSync(stepDir, { withFileTypes: true })) {
				if (child.name.startsWith("escalation-")) continue;
				if (latest && child.isDirectory() && child.name === latest) continue;
				removePathIfExists(path.join(stepDir, child.name));
			}
		}
	}

	async function maybeOfferStaleRunCleanup(ctx: DuetCommandContext): Promise<void> {
		if (!ctx.hasUI) return;
		const candidates = getStaleRunCandidates(ctx.cwd, state.runId);
		if (candidates.length === 0) return;
		const selected = await ctx.ui.select(`Found ${candidates.length} stale duet run${candidates.length === 1 ? "" : "s"}`, [
			"Apply recommended cleanup",
			"Review each run",
			"Skip for now",
		]);
		if (!selected || selected === "Skip for now") return;
		if (selected === "Apply recommended cleanup") {
			let compacted = 0;
			let archived = 0;
			let deleted = 0;
			for (const candidate of candidates) {
				if (candidate.action === "compact_completed") {
					const plan = candidate.state.plan ?? readJsonIfExists<PlanDraft>(path.join(runRoot(ctx.cwd, candidate.runId), "plan.json"));
					if (!plan) continue;
					compactCompletedRunArtifacts(ctx, candidate.runId, plan, getCurrentPlanConfig(ctx, candidate.runId));
					compacted++;
				} else if (candidate.action === "archive_incomplete") {
					archiveIncompleteRunArtifacts(ctx, candidate.runId, candidate.state);
					archived++;
				} else {
					removePathIfExists(runRoot(ctx.cwd, candidate.runId));
					deleted++;
				}
			}
			ctx.ui.notify(`Stale duet cleanup complete: compacted ${compacted}, archived ${archived}, deleted ${deleted}.`, "info");
			return;
		}
		for (const candidate of candidates) {
			const summary = `${candidate.runId} • ${candidate.state.phase} • ${candidate.ageDays.toFixed(1)}d old • ${candidate.reason}`;
			const options = [
				candidate.action === "compact_completed"
					? "Compact this completed run"
					: candidate.action === "archive_incomplete"
						? "Archive this stale run"
						: "Delete this stale run",
				"Keep for now",
				"Stop reviewing",
			];
			const choice = await ctx.ui.select(summary, options);
			if (!choice || choice === "Stop reviewing") return;
			if (choice === "Keep for now") continue;
			if (candidate.action === "compact_completed") {
				const plan = candidate.state.plan ?? readJsonIfExists<PlanDraft>(path.join(runRoot(ctx.cwd, candidate.runId), "plan.json"));
				if (plan) compactCompletedRunArtifacts(ctx, candidate.runId, plan, getCurrentPlanConfig(ctx, candidate.runId));
			} else if (candidate.action === "archive_incomplete") {
				archiveIncompleteRunArtifacts(ctx, candidate.runId, candidate.state);
			} else {
				removePathIfExists(runRoot(ctx.cwd, candidate.runId));
			}
		}
	}

	async function pickRoleModel(
		ctx: ExtensionContext,
		role: string,
		choices: Awaited<ReturnType<typeof getScopedModelChoices>>,
		currentKey: string | undefined,
		defaultConfig: SideConfig,
	): Promise<{ model: typeof choices[0]; thinking: ThinkingLevel } | undefined> {
		const model = await pickModelChoice(ctx, `Duet ${role}: model`, choices, currentKey, undefined, defaultConfig.model);
		if (!model) return undefined;
		const thinking = await pickThinkingLevel(ctx, `Duet ${role}: thinking (${model.key})`, model, defaultConfig.thinking);
		if (!thinking) return undefined;
		return { model, thinking };
	}

	function makeSideConfig(pick: { model: { model: { name?: string }; label: string; key: string }; thinking: ThinkingLevel }): SideConfig {
		return { label: pick.model.model.name || pick.model.label, model: pick.model.key, thinking: pick.thinking };
	}

	async function switchRoleModelForRetry(
		ctx: ExtensionContext,
		config: DuetConfig,
		failedRole: string | undefined,
	): Promise<DuetConfig | undefined> {
		if (!ctx.hasUI || !failedRole) return undefined;
		const logicalRole = failedRole === "relay-a"
			? "implementer"
			: failedRole === "relay-b"
				? "reviewer"
				: failedRole;
		if (logicalRole !== "planner" && logicalRole !== "critic" && logicalRole !== "implementer" && logicalRole !== "reviewer") {
			ctx.ui.notify(`Cannot switch model for role '${failedRole}'.`, "warning");
			return undefined;
		}
		const choices = await getScopedModelChoices(ctx);
		const current = getRoleConfig(config, logicalRole as DuetRole);
		const picked = await pickRoleModel(ctx, logicalRole, choices, current.model, current);
		if (!picked) return undefined;
		const next: DuetConfig = {
			...config,
			[logicalRole]: makeSideConfig(picked),
		};
		setState(ctx, { ...state, activeConfig: next, updatedAt: new Date().toISOString() });
		ctx.ui.notify(`Switched ${logicalRole} to ${picked.model.key}. Retrying round.`, "info");
		return next;
	}

	async function promptForRunConfig(ctx: ExtensionContext, base: DuetConfig): Promise<DuetConfig | undefined> {
		if (!ctx.hasUI) return base;

		const choices = await getScopedModelChoices(ctx);
		if (choices.length === 0) {
			ctx.ui.notify("No available models found for duet.", "warning");
			return undefined;
		}

		const currentKey = ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : undefined;

		// --- Planner ---
		const plannerDefault = getRoleConfig(base, "planner");
		const plannerPick = await pickRoleModel(ctx, "Planner", choices, currentKey, plannerDefault);
		if (!plannerPick) { ctx.ui.notify("Cancelled duet start.", "info"); return undefined; }

		// --- Critic ---
		const criticDefault = getRoleConfig(base, "critic");
		const criticPick = await pickRoleModel(ctx, "Critic", choices, currentKey, criticDefault);
		if (!criticPick) { ctx.ui.notify("Cancelled duet start.", "info"); return undefined; }

		// --- Implementer (offer "same as Planner" shortcut) ---
		const implDefault = getRoleConfig(base, "implementer");
		const implSameAsPlanner = implDefault.model === plannerDefault.model && implDefault.thinking === plannerDefault.thinking;
		let implementerPick: { model: typeof choices[0]; thinking: ThinkingLevel };
		const implOptions = ["Same as Planner", "Pick different model"];
		const implChoice = await ctx.ui.select("Duet Implementer", implSameAsPlanner ? implOptions : [...implOptions].reverse());
		if (!implChoice) { ctx.ui.notify("Cancelled duet start.", "info"); return undefined; }
		if (implChoice === "Same as Planner") {
			implementerPick = plannerPick;
		} else {
			const pick = await pickRoleModel(ctx, "Implementer", choices, currentKey, implDefault);
			if (!pick) { ctx.ui.notify("Cancelled duet start.", "info"); return undefined; }
			implementerPick = pick;
		}

		// --- Reviewer (offer "same as Critic" shortcut) ---
		const revDefault = getRoleConfig(base, "reviewer");
		const revSameAsCritic = revDefault.model === criticDefault.model && revDefault.thinking === criticDefault.thinking;
		let reviewerPick: { model: typeof choices[0]; thinking: ThinkingLevel };
		const revOptions = ["Same as Critic", "Pick different model"];
		const revChoice = await ctx.ui.select("Duet Reviewer", revSameAsCritic ? revOptions : [...revOptions].reverse());
		if (!revChoice) { ctx.ui.notify("Cancelled duet start.", "info"); return undefined; }
		if (revChoice === "Same as Critic") {
			reviewerPick = criticPick;
		} else {
			const pick = await pickRoleModel(ctx, "Reviewer", choices, currentKey, revDefault);
			if (!pick) { ctx.ui.notify("Cancelled duet start.", "info"); return undefined; }
			reviewerPick = pick;
		}

		// --- Execution mode ---
		const modeOptions = base.executionMode === "relay"
			? ["Relay (implement+review per agent)", "Standard (separate implement → review)"]
			: ["Standard (separate implement → review)", "Relay (implement+review per agent)"];
		const modeChoice = await ctx.ui.select("Duet: execution mode", modeOptions);
		if (!modeChoice) { ctx.ui.notify("Cancelled duet start.", "info"); return undefined; }
		const executionMode: ExecutionMode = modeChoice.startsWith("Relay") ? "relay" : "standard";

		const plannerSide = makeSideConfig(plannerPick);
		const criticSide = makeSideConfig(criticPick);
		const implementerSide = makeSideConfig(implementerPick);
		const reviewerSide = makeSideConfig(reviewerPick);

		const nextConfig: DuetConfig = {
			...base,
			// Keep sideA/sideB in sync for backward compat
			sideA: plannerSide,
			sideB: criticSide,
			planner: plannerSide,
			critic: criticSide,
			implementer: implementerSide,
			reviewer: reviewerSide,
			executionMode,
		};

		try {
			saveConfig(ctx.cwd, nextConfig);
		} catch (error) {
			ctx.ui.notify(`Warning: failed to remember duet defaults: ${error instanceof Error ? error.message : String(error)}`, "warning");
		}

		return nextConfig;
	}

	function recommendedSummaryModel(config: DuetConfig, availableKeys: string[]): string {
		const allModels = [
			getRoleConfig(config, "planner").model,
			getRoleConfig(config, "critic").model,
			getRoleConfig(config, "implementer").model,
			getRoleConfig(config, "reviewer").model,
		];
		const preferredConfigured = [...new Set(allModels)]
			.filter((model) => scoreSummaryModel(model) > 0 && availableKeys.includes(model))
			.sort((a, b) => scoreSummaryModel(b) - scoreSummaryModel(a));
		if (preferredConfigured.length > 0) return preferredConfigured[0];

		const scoredChoices = availableKeys
			.map((key) => ({ key, score: scoreSummaryModel(key) }))
			.filter((choice) => choice.score > 0)
			.sort((a, b) => b.score - a.score);
		if (scoredChoices.length > 0) return scoredChoices[0].key;

		return getRoleConfig(config, "critic").model || getRoleConfig(config, "planner").model;
	}

	async function pickSummaryModel(ctx: ExtensionContext, config: DuetConfig): Promise<string | undefined> {
		const choices = await getScopedModelChoices(ctx);
		const recommended = recommendedSummaryModel(config, choices.map((choice) => choice.key));
		if (!ctx.hasUI || choices.length === 0) return recommended;

		const currentKey = ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : undefined;
		const selected = await pickModelChoice(ctx, "Duet summary: model", choices, currentKey, undefined, recommended);
		return selected?.key;
	}

	async function runSideWithLoader<T>(
		ctx: ExtensionContext,
		label: string,
		options: RunSideOptions<T>,
	): Promise<RunSideResult<T> | undefined> {
		if (!ctx.hasUI) return runSide(options);

		const result = await ctx.ui.custom<RunSideResult<T> | { __error: string } | undefined>((tui, theme, _kb, done) => {
			const loader = new BorderedLoader(tui, theme, label);
			loader.onAbort = () => done(undefined);

			void runSide({ ...options, signal: loader.signal })
				.then(done)
				.catch((error) => done({ __error: error instanceof Error ? error.message : String(error) }));

			return loader;
		});

		if (!result) return undefined;
		if ("__error" in result) throw new Error(result.__error);
		return result;
	}

	async function promptForRunHandoffMode(ctx: ExtensionContext): Promise<HandoffMode | undefined> {
		if (!ctx.hasUI) return "none";
		const options = [
			"No handoff",
			"Include summary of current conversation",
			"Include all current conversation context (large / expensive)",
			"Provide custom context (paste a plan, instructions, etc.)",
			"Cancel",
		];
		const selected = await ctx.ui.select("Duet: handoff to child agents", options);
		if (!selected || selected === "Cancel") return undefined;
		if (selected === "No handoff") return "none";
		if (selected === "Include summary of current conversation") return "summary";
		if (selected.startsWith("Provide custom context")) return "custom";
		return "full";
	}

	async function promptForPostPlanMode(ctx: ExtensionContext): Promise<PostPlanMode | undefined> {
		if (!ctx.hasUI) return "autorun";
		const options = [
			"Pause after plan approval so I can review it",
			"Autorun after plan approval (walk away)",
			"Cancel",
		];
		const selected = await ctx.ui.select("Duet: after plan approval", options);
		if (!selected || selected === "Cancel") return undefined;
		return selected.startsWith("Pause") ? "review" : "autorun";
	}

	async function reviewGeneratedHandoffSummary(ctx: ExtensionContext, initialText: string): Promise<string | undefined> {
		if (!ctx.hasUI) return initialText;
		const edited = await ctx.ui.editor(
			"Duet: review/edit handoff summary before continuing",
			initialText,
		);
		if (edited === undefined) return undefined;
		const trimmed = edited.trim();
		return trimmed ? `${trimmed}\n` : "";
	}

	async function prepareRunHandoff(ctx: DuetCommandContext, config: DuetConfig, runId: string): Promise<HandoffMode | undefined> {
		const mode = await promptForRunHandoffMode(ctx);
		if (!mode) {
			if (ctx.hasUI) ctx.ui.notify("Cancelled duet start.", "info");
			return undefined;
		}
		if (mode === "none") return mode;

		ensureDir(runRoot(ctx.cwd, runId));

		if (mode === "custom") {
			if (!ctx.hasUI) return "none";
			const customText = await ctx.ui.editor(
				"Duet: provide custom context for child agents",
				"",
			);
			if (customText === undefined) {
				ctx.ui.notify("Cancelled duet start.", "info");
				return undefined;
			}
			const trimmed = customText.trim();
			if (!trimmed) {
				ctx.ui.notify("Empty custom context — continuing without handoff.", "info");
				return "none";
			}
			saveRunHandoff(ctx.cwd, runId, {
				mode: "custom",
				content: `${trimmed}\n`,
				sourceItemCount: 1,
			});
			ctx.ui.notify(`Custom context attached (${trimmed.length} chars).`, "info");
			return "custom";
		}

		const source = serializeSessionBranchForHandoff(ctx);
		if (!source.text.trim()) {
			if (ctx.hasUI) ctx.ui.notify("No current conversation context found to hand off. Continuing without handoff.", "info");
			return "none";
		}

		if (mode === "full") {
			saveRunHandoff(ctx.cwd, runId, {
				mode,
				content: `${source.text.trim()}\n`,
				sourceItemCount: source.sourceItemCount,
			}, source.text);
			if (ctx.hasUI) ctx.ui.notify(`Prepared full-context handoff from ${source.sourceItemCount} item(s).`, "info");
			return mode;
		}

		await ctx.waitForIdle();
		const model = await pickSummaryModel(ctx, config);
		if (!model) {
			if (ctx.hasUI) ctx.ui.notify("Cancelled duet start.", "info");
			return undefined;
		}
		const handoffDir = path.join(runRoot(ctx.cwd, runId), "handoff-summary");
		const summarySourceText = shrinkTranscriptForSummary(source.text);
		const result = await runSideWithLoader(
			ctx,
			`Preparing handoff summary with ${model}...`,
			{
				cwd: ctx.cwd,
				model,
				thinkingLevel: "off",
				tools: PLANNING_TOOLS,
				prompt: handoffSummaryPrompt(summarySourceText),
				roleSystemAddendum: [
					"You are creating a concise conversation handoff for child coding agents.",
					"Return only valid JSON.",
					"Do not include markdown fences.",
				].join("\n"),
				artifactsDir: handoffDir,
				sessionDir: helperSessionDir(ctx.cwd, runId, "handoff-summary"),
				schemaName: "HandoffSummaryReport",
				validate: validateHandoffSummaryReport,
			},
		);
		if (!result) {
			if (ctx.hasUI) ctx.ui.notify("Cancelled duet start.", "info");
			return undefined;
		}
		const generatedContent = formatHandoffSummaryText(result.parsed, model, source.sourceItemCount);
		const content = await reviewGeneratedHandoffSummary(ctx, generatedContent);
		if (content === undefined) {
			if (ctx.hasUI) ctx.ui.notify("Cancelled duet start.", "info");
			return undefined;
		}
		if (!content.trim()) {
			if (ctx.hasUI) ctx.ui.notify("Empty handoff summary — continuing without handoff.", "info");
			return "none";
		}
		saveRunHandoff(ctx.cwd, runId, {
			mode,
			content,
			sourceItemCount: source.sourceItemCount,
			summaryModel: model,
		}, source.text);
		if (ctx.hasUI) ctx.ui.notify(`Prepared summary handoff with ${model}. Review applied.`, "info");
		return mode;
	}

	async function showPlanForReview(ctx: ExtensionContext, plan: PlanDraft, sourcePath?: string): Promise<void> {
		const text = formatPlanDocument(plan, sourcePath ?? state.planSourcePath);
		if (!ctx.hasUI) {
			console.log(text);
			return;
		}
		await ctx.ui.custom<void>((tui, theme, _keybindings, done) => {
			let scrollOffset = 0;
			let renderedLines: string[] = [];
			let lastWidth = 0;
			let lastHeight = 0;

			const mdTheme = getMarkdownTheme();
			const md = new Markdown(text, 2, 1, mdTheme);

			const viewer: Component = {
				handleInput(data: string) {
					const pageSize = Math.max(1, lastHeight - 4);
					if (matchesKey(data, Key.down) || data === "j") {
						scrollOffset = Math.min(scrollOffset + 1, Math.max(0, renderedLines.length - pageSize));
					} else if (matchesKey(data, Key.up) || data === "k") {
						scrollOffset = Math.max(0, scrollOffset - 1);
					} else if (matchesKey(data, Key.pageDown) || data === " ") {
						scrollOffset = Math.min(scrollOffset + pageSize, Math.max(0, renderedLines.length - pageSize));
					} else if (matchesKey(data, Key.pageUp)) {
						scrollOffset = Math.max(0, scrollOffset - pageSize);
					} else if (matchesKey(data, Key.home) || data === "g") {
						scrollOffset = 0;
					} else if (matchesKey(data, Key.end) || data === "G") {
						scrollOffset = Math.max(0, renderedLines.length - pageSize);
					} else if (matchesKey(data, Key.escape) || data === "q") {
						done();
						return;
					}
					viewer.invalidate?.();
				},
				render(width: number): string[] {
					const height = tui.terminal.rows;
					lastWidth = width;
					lastHeight = height;

					// Render markdown content at full width
					renderedLines = md.render(width - 2);

					const viewportHeight = Math.max(1, height - 3); // reserve header + footer
					const maxScroll = Math.max(0, renderedLines.length - viewportHeight);
					scrollOffset = Math.min(scrollOffset, maxScroll);

					const visible = renderedLines.slice(scrollOffset, scrollOffset + viewportHeight);

					// Pad to fill viewport
					while (visible.length < viewportHeight) {
						visible.push("");
					}

					const totalLines = renderedLines.length;
					const pct = totalLines <= viewportHeight ? 100 : Math.round(((scrollOffset + viewportHeight) / totalLines) * 100);
					const header = theme.fg("accent", `── Duet Plan Review ── (${plan.steps.length} steps) `);
					const footer = theme.fg("dim", `  ↑/↓/j/k scroll • PgUp/PgDn page • g/G top/bottom • q/Esc close   ${pct}%  (${scrollOffset + 1}-${Math.min(scrollOffset + viewportHeight, totalLines)}/${totalLines} lines)`);

					return [header, ...visible, footer];
				},
				invalidate() {
					// Force re-render by clearing cached state
					lastWidth = 0;
				},
			};
			return viewer;
		});
	}

	async function summarizePlanForReview(ctx: DuetCommandContext, config: DuetConfig, plan: PlanDraft): Promise<void> {
		await ctx.waitForIdle();
		const runId = state.runId ?? generateRunId();
		if (!state.runId) {
			state = { ...state, runId };
		}
		const model = await pickSummaryModel(ctx, config);
		if (!model) {
			if (ctx.hasUI) ctx.ui.notify("Plan summary cancelled.", "info");
			return;
		}
		const summaryDir = path.join(runRoot(ctx.cwd, runId), "plan-summary", new Date().toISOString().replace(/[:.]/g, "-"));
		const result = await runSideWithLoader(
			ctx,
			`Summarizing plan with ${model}...`,
			{
				cwd: ctx.cwd,
				model,
				tools: PLANNING_TOOLS,
				prompt: planSummaryPrompt(plan),
				roleSystemAddendum: [
					"You are a concise plan summarizer.",
					"Return only valid JSON.",
					"Do not include markdown fences.",
				].join("\n"),
				artifactsDir: summaryDir,
				sessionDir: helperSessionDir(ctx.cwd, runId, "plan-summary"),
				schemaName: "PlanSummaryReport",
				validate: validatePlanSummaryReport,
			},
		);
		if (!result) {
			if (ctx.hasUI) ctx.ui.notify("Plan summary cancelled.", "info");
			return;
		}
		latestPlanSummaryText = formatPlanSummaryText(result.parsed, model);
		writeText(path.join(summaryDir, "summary.txt"), latestPlanSummaryText);
		syncPlanWidgets(ctx);
		if (!ctx.hasUI) {
			console.log(latestPlanSummaryText);
			return;
		}
		await ctx.ui.editor(`Duet plan summary (${model})`, latestPlanSummaryText);
	}

	function recommendedHealthCheckModel(config: DuetConfig, availableKeys: string[]): string {
		// Prefer the reviewer/critic model — this is reviewer-tier work
		const preferred = [
			getRoleConfig(config, "reviewer").model,
			getRoleConfig(config, "critic").model,
			getRoleConfig(config, "planner").model,
		].filter(Boolean) as string[];

		for (const model of preferred) {
			if (availableKeys.includes(model)) return model;
		}

		// Fallback: prefer opus/strong models
		const text = availableKeys.map((k) => k.toLowerCase());
		for (let i = 0; i < availableKeys.length; i++) {
			if (text[i].includes("opus")) return availableKeys[i];
		}
		for (let i = 0; i < availableKeys.length; i++) {
			if (text[i].includes("gpt-5") || text[i].includes("sonnet")) return availableKeys[i];
		}

		return availableKeys[0] ?? getRoleConfig(config, "critic").model;
	}

	async function pickHealthCheckModel(ctx: ExtensionContext, config: DuetConfig): Promise<string | undefined> {
		const choices = await getScopedModelChoices(ctx);
		const recommended = recommendedHealthCheckModel(config, choices.map((c) => c.key));
		if (!ctx.hasUI || choices.length === 0) return recommended;

		const currentKey = ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : undefined;
		const selected = await pickModelChoice(ctx, "Health check: model (recommend strong model)", choices, currentKey, undefined, recommended);
		return selected?.key;
	}

	function recommendedScoutModel(config: DuetConfig, availableKeys: string[]): string {
		// Reuse the summary model scorer — cheap/fast models for exploration
		const text = availableKeys.map((k) => k.toLowerCase());
		for (let i = 0; i < availableKeys.length; i++) {
			if (text[i].includes("haiku")) return availableKeys[i];
		}
		for (let i = 0; i < availableKeys.length; i++) {
			if (text[i].includes("mini")) return availableKeys[i];
		}
		for (let i = 0; i < availableKeys.length; i++) {
			if (text[i].includes("flash")) return availableKeys[i];
		}
		return availableKeys[0] ?? getRoleConfig(config, "implementer").model;
	}

	async function pickHealthCheckScoutModel(ctx: ExtensionContext, config: DuetConfig): Promise<string | undefined> {
		const choices = await getScopedModelChoices(ctx);
		const recommended = recommendedScoutModel(config, choices.map((c) => c.key));
		if (!ctx.hasUI || choices.length === 0) return recommended;

		const currentKey = ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : undefined;
		const selected = await pickModelChoice(ctx, "Health check scout: model (recommend cheap/fast model)", choices, currentKey, undefined, recommended);
		return selected?.key;
	}

	async function runPlanHealthCheck(ctx: DuetCommandContext, config: DuetConfig, plan: PlanDraft): Promise<void> {
		await ctx.waitForIdle();
		const runId = state.runId ?? generateRunId();
		if (!state.runId) {
			state = { ...state, runId };
		}

		const healthCheckDir = path.join(runRoot(ctx.cwd, runId), "health-check");
		ensureDir(healthCheckDir);
		const originalGoal = state.goal ?? plan.goal;

		// --- Phase 1: Scout (cheap model explores codebase with tools) ---
		const scoutModel = await pickHealthCheckScoutModel(ctx, config);
		if (!scoutModel) {
			if (ctx.hasUI) ctx.ui.notify("Health check cancelled.", "info");
			return;
		}

		// --- Pick reviewer model before starting (so user sets both upfront) ---
		const reviewerModel = await pickHealthCheckModel(ctx, config);
		if (!reviewerModel) {
			if (ctx.hasUI) ctx.ui.notify("Health check cancelled.", "info");
			return;
		}

		if (ctx.hasUI) {
			ctx.ui.notify(`Health check: scout (${scoutModel}) explores codebase, then reviewer (${reviewerModel}) analyzes.`, "info");
		}

		const scoutDir = path.join(healthCheckDir, "scout");
		ensureDir(scoutDir);

		// Run scout with progress visible in the loader
		const scoutResult = await runSideWithProgress(
			ctx,
			"Health check scout",
			{
				cwd: ctx.cwd,
				model: scoutModel,
				thinkingLevel: "low",
				tools: PLANNING_TOOLS,
				prompt: healthCheckScoutPrompt(plan),
				roleSystemAddendum: [
					"You are a codebase scout. Explore the codebase thoroughly using tools.",
					"Read files, list directories, check what exists. Be factual and comprehensive.",
					"Write your findings as plain text (not JSON).",
				].join("\n"),
				artifactsDir: scoutDir,
				sessionDir: helperSessionDir(ctx.cwd, runId, "health-check-scout"),
				schemaName: "ScoutReport",
				validate: (v: unknown) => {
					// Scout outputs plain text, not JSON — accept the raw text
					if (typeof v === "string" && v.trim().length > 0) return { ok: true as const, value: v };
					return { ok: false as const, error: "empty scout report" };
				},
				extractFromText: (text: string) => text.trim() || null,
			},
		);

		if (!scoutResult) {
			if (ctx.hasUI) ctx.ui.notify("Health check cancelled during scout phase.", "info");
			return;
		}

		const scoutReport = scoutResult.finalAssistantText;
		writeText(path.join(scoutDir, "scout-report.txt"), scoutReport);
		if (ctx.hasUI) ctx.ui.notify(`Scout complete (${scoutReport.length} chars). Starting reviewer...`, "info");

		// --- Phase 2: Reviewer (strong model, NO tools, pure reasoning) ---
		const reviewerDir = path.join(healthCheckDir, "reviewer");
		ensureDir(reviewerDir);

		const result = await runSideWithProgress(
			ctx,
			"Health check reviewer",
			{
				cwd: ctx.cwd,
				model: reviewerModel,
				thinkingLevel: "high",
				tools: [],
				prompt: planHealthCheckPrompt(plan, scoutReport, originalGoal),
				roleSystemAddendum: [
					"You are an adversarial plan reviewer for a coding duet system.",
					"A scout agent already explored the codebase — use its report as ground truth.",
					"Do NOT request tool calls. Reason over the scout report and the plan.",
					"Return only valid JSON. Do not include markdown fences.",
				].join("\n"),
				artifactsDir: reviewerDir,
				sessionDir: helperSessionDir(ctx.cwd, runId, "health-check-reviewer"),
				schemaName: "PlanHealthCheckResult",
				validate: validatePlanHealthCheckResult,
			},
		);

		if (!result) {
			if (ctx.hasUI) ctx.ui.notify("Health check cancelled during review phase.", "info");
			return;
		}
		const healthCheckText = formatPlanHealthCheckText(result.parsed, reviewerModel);
		writeText(path.join(healthCheckDir, "health-check.txt"), healthCheckText);
		latestHealthCheckText = healthCheckText;
		if (!ctx.hasUI) {
			console.log(healthCheckText);
			return;
		}
		await ctx.ui.editor(`Duet plan health check (scout: ${scoutModel}, reviewer: ${reviewerModel})`, healthCheckText);
	}

	/** Like runSideWithLoader but shows live progress (tool calls, thinking, output) */
	async function runSideWithProgress<T>(
		ctx: ExtensionContext,
		phaseLabel: string,
		options: RunSideOptions<T>,
	): Promise<RunSideResult<T> | undefined> {
		if (!ctx.hasUI) return runSide(options);

		const result = await ctx.ui.custom<RunSideResult<T> | { __error: string } | undefined>((tui, theme, _kb, done) => {
			let toolCount = 0;
			let lastToolName = "";
			let thinkingChars = 0;
			let outputChars = 0;
			let elapsed = 0;
			let aborted = false;
			let requestInvalidate: (() => void) | undefined;
			const abortController = new AbortController();

			const onEvent = (event: RunSideEvent) => {
				if (event.toolCount !== undefined) toolCount = event.toolCount;
				if (event.toolName && event.type === "tool_start") lastToolName = event.toolName;
				if (event.thinkingLength !== undefined) thinkingChars = event.thinkingLength;
				if (event.textLength !== undefined) outputChars = event.textLength;
				if (event.elapsed !== undefined) elapsed = event.elapsed;
				requestInvalidate?.();
			};

			void runSide({ ...options, onEvent, signal: abortController.signal })
				.then((r) => { clearInterval(tickInterval); done(r); })
				.catch((error) => { clearInterval(tickInterval); done({ __error: error instanceof Error ? error.message : String(error) }); });

			const component: import("@mariozechner/pi-tui").Component = {
				handleInput(data: string) {
					if (data === "\x1b" || data === "\x03") { // Escape or Ctrl+C
						aborted = true;
						clearInterval(tickInterval);
						abortController.abort();
						done(undefined);
					}
				},
				render(width: number): string[] {
					const border = theme.fg("border", "─".repeat(width));
					const elapsedSec = Math.floor(elapsed / 1000);
					const spinner = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"][Math.floor(Date.now() / 80) % 10];

					const statusParts = [
						theme.fg("accent", ` ${spinner} ${phaseLabel}`),
						theme.fg("dim", `${options.model}`),
					];
					if (toolCount > 0) {
						statusParts.push(theme.fg("accent", `${toolCount} tool calls`));
						if (lastToolName) statusParts.push(theme.fg("dim", `last: ${lastToolName}`));
					}
					if (thinkingChars > 0) statusParts.push(theme.fg("dim", `thinking: ${(thinkingChars / 1000).toFixed(0)}k chars`));
					if (outputChars > 0) statusParts.push(theme.fg("dim", `output: ${(outputChars / 1000).toFixed(1)}k chars`));
					statusParts.push(theme.fg("dim", `${elapsedSec}s`));

					const status = statusParts.join(theme.fg("dim", "  ·  "));
					const hint = theme.fg("dim", " escape/ctrl+c cancel");

					return [border, status, "", hint, border];
				},
				invalidate() {
					// no-op — actual invalidation is triggered externally
				},
			};

			// Use tui.invalidate() for external re-render triggers (events + tick)
			requestInvalidate = () => { tui.invalidate(); };

			// Force re-render every second for elapsed time + spinner
			const tickInterval = setInterval(() => {
				if (!aborted) tui.invalidate();
			}, 500);

			return component;
		});

		if (!result) return undefined;
		if ("__error" in result) throw new Error(result.__error);
		return result;
	}

	async function importPlanFileLoop(
		ctx: ExtensionContext,
		sourcePath: string,
		config: DuetConfig,
		runId?: string,
		explicitHandoffMode?: HandoffMode,
		options?: PlanningLoopOptions,
	): Promise<boolean> {
		clearPlanTransientUi(ctx);
		const actualRunId = runId ?? generateRunId();
		ensureDir(runRoot(ctx.cwd, actualRunId));
		writeJson(path.join(runRoot(ctx.cwd, actualRunId), "config.snapshot.json"), config);

		const { absolutePath, sourceText } = loadPlanSourceFile(ctx.cwd, sourcePath);
		const handoff = loadRunHandoff(ctx.cwd, actualRunId);
		const resolvedHandoffMode = explicitHandoffMode ?? handoff?.mode ?? "none";
		writeText(path.join(runRoot(ctx.cwd, actualRunId), "source-plan-path.txt"), `${sourcePath}\n`);
		writeText(path.join(runRoot(ctx.cwd, actualRunId), "source-plan.md"), sourceText);

		try {
			let nextState: DuetState = {
				...state,
				phase: "planning",
				runId: actualRunId,
				goal: `Import plan from ${sourcePath}`,
				activity: undefined,
				plan: undefined,
				planSourcePath: sourcePath,
				stepIndex: undefined,
				round: 0,
				pausedReason: undefined,
				resumeAction: "planning",
				activeSummary: {
					stepTitle: path.basename(sourcePath),
					implementer: "A",
					reviewer: "B",
					roleLabels: { sideA: "Planner", sideB: "Critic" },
				},
				handoffMode: resolvedHandoffMode,
				activeConfig: config,
				updatedAt: new Date().toISOString(),
			};
			setState(ctx, nextState);

			const repoCheck = await ensureRepoReady(pi, ctx, config, nextState, "planning");
			if (!repoCheck.ok) {
				state = repoCheck.state;
				return false;
			}

			// Optional pre-review: run planner + critic gap analysis on the raw plan
			let gapReview: PlanReview | undefined;
			if (options?.preReview) {
				const gapDir = path.join(runRoot(ctx.cwd, actualRunId), "gap-analysis");
				ensureDir(gapDir);
				writeText(path.join(gapDir, "source-plan.md"), sourceText);

				const pCfg = getRoleConfig(config, "planner");
				const cCfg = getRoleConfig(config, "critic");

				// Planner gap analysis
				setState(ctx, {
					...nextState,
					round: 0,
					activeSummary: {
						stepTitle: `Gap analysis: ${path.basename(sourcePath)}`,
						implementer: "A",
						reviewer: "B",
						roleLabels: { sideA: "Planner (gap analysis)", sideB: "Critic (gap analysis)" },
					},
					updatedAt: new Date().toISOString(),
				});
				setState(ctx, { ...state, activeChild: { childId: "A-planner-gap", side: "A", role: "planner", model: pCfg.model, startedAt: new Date().toISOString(), round: 0 } });

				const plannerGapResult = await runSide({
					cwd: ctx.cwd,
					model: pCfg.model,
					thinkingLevel: pCfg.thinking,
					tools: PLANNING_TOOLS,
					prompt: gapAnalysisPlannerPrompt(sourcePath, sourceText),
					roleSystemAddendum: roleAddendum("planner", config),
					artifactsDir: path.join(gapDir, "planner"),
					sessionDir: path.join(gapDir, "planner-session"),
					schemaName: "PlanReview",
					validate: validatePlanReview,
					extractFromText: (text) => {
						const footer = parseVerdictFooter(text);
						return footer ? { verdict: footer.verdict, blockingIssues: footer.blockingIssues } : null;
					},
					onEvent: (e) => { workspace?.feedEvent(e); },
					signal: orchestrationAbort?.signal,
				});
				setState(ctx, { ...state, activeChild: undefined });

				const plannerAnalysisText = plannerGapResult.finalAssistantText || JSON.stringify(plannerGapResult.parsed, null, 2);
				writeText(path.join(gapDir, "planner-analysis.md"), plannerAnalysisText);
				writeJson(path.join(gapDir, "planner-review.json"), plannerGapResult.parsed);

				// Critic gap analysis (validates + supplements planner findings)
				setState(ctx, { ...state, activeChild: { childId: "B-critic-gap", side: "B", role: "critic", model: cCfg.model, startedAt: new Date().toISOString(), round: 0 } });

				const criticGapResult = await runSide({
					cwd: ctx.cwd,
					model: cCfg.model,
					thinkingLevel: cCfg.thinking,
					tools: PLANNING_TOOLS,
					prompt: gapAnalysisCriticPrompt(sourcePath, sourceText, plannerAnalysisText),
					roleSystemAddendum: roleAddendum("critic", config),
					artifactsDir: path.join(gapDir, "critic"),
					sessionDir: path.join(gapDir, "critic-session"),
					schemaName: "PlanReview",
					validate: validatePlanReview,
					extractFromText: (text) => {
						const footer = parseVerdictFooter(text);
						return footer ? { verdict: footer.verdict, blockingIssues: footer.blockingIssues } : null;
					},
					onEvent: (e) => { workspace?.feedEvent(e); },
					signal: orchestrationAbort?.signal,
				});
				setState(ctx, { ...state, activeChild: undefined });

				writeJson(path.join(gapDir, "critic-review.json"), criticGapResult.parsed);

				// Use the critic's consolidated review as gap analysis result
				gapReview = criticGapResult.parsed;

				if (gapReview.verdict === "approve" && gapReview.blockingIssues.length === 0) {
					if (ctx.hasUI) ctx.ui.notify("Gap analysis complete — no blocking issues found. Proceeding with plan conversion.", "info");
				} else {
					const issueCount = gapReview.blockingIssues.length;
					if (ctx.hasUI) ctx.ui.notify(`Gap analysis found ${issueCount} blocking issue${issueCount === 1 ? "" : "s"}. The planner will address these during conversion.`, "warning");
				}
			}

			let priorReview: PlanReview | undefined = options?.initialReview;
			let lastDraft: PlanDraft | undefined;
			const startRound = Math.max(1, options?.startRound ?? 1);
			let maxRounds = Math.max(options?.maxRounds ?? config.maxPlanRounds, startRound);
			let autoRetryAttempts = 0;
			for (let round = startRound; round <= maxRounds; round++) {
				nextState = {
					...state,
					phase: "planning",
					round,
					activeSummary: {
						stepTitle: `Importing ${path.basename(sourcePath)}`,
						implementer: "A",
						reviewer: "B",
						roleLabels: { sideA: "Planner", sideB: "Critic" },
						lastVerdict: priorReview?.verdict,
					},
					updatedAt: new Date().toISOString(),
				};
				setState(ctx, nextState);

				const roundDir = planningRoundDir(ctx.cwd, actualRunId, round);
				writeText(path.join(roundDir, "source-plan.md"), sourceText);
				writeText(path.join(roundDir, "source-plan-path.txt"), `${absolutePath}\n`);
				const operatorNotes = loadRunOperatorNotes(ctx.cwd, actualRunId);

				const planFileRel = draftPlanRelPath(actualRunId);
				const planFileAbs = draftPlanAbsPath(ctx.cwd, actualRunId);
				const pCfg = getRoleConfig(config, "planner");
				const cCfg = getRoleConfig(config, "critic");
				const plannerInterventions = getPendingInterventionsFor(ctx.cwd, actualRunId, "A-planner");
				const plannerRawPrompt = withOperatorNotes(withRunHandoff(importPlanPrompt(sourcePath, sourceText, config, planFileRel, priorReview, round === 1 ? gapReview : undefined), handoff), operatorNotes);
				const criticRawPrompt = withOperatorNotes(withRunHandoff(planReviewPrompt(`Imported plan from ${sourcePath}`, planFileRel, priorReview), handoff), operatorNotes);

				// Run planner then critic sequentially with workspace UI hooks
				try {
				setState(ctx, { ...state, activeChild: { childId: "A-planner", side: "A", role: "planner", model: pCfg.model, startedAt: new Date().toISOString(), round } });
				const draftResult = await runSide({
					cwd: ctx.cwd,
					model: pCfg.model,
					thinkingLevel: pCfg.thinking,
					tools: PLANNING_TOOLS,
					prompt: withPendingInterventions(plannerRawPrompt, plannerInterventions),
					roleSystemAddendum: roleAddendum("planner", config),
					artifactsDir: path.join(roundDir, "side-a"),
					sessionDir: planningRoleSessionDir(ctx.cwd, actualRunId, "planner"),
					schemaName: "PlanDraft",
					validate: createPlanDraftValidator(config),
					resultFile: planFileAbs,
					onEvent: (e) => { workspace?.feedEvent(e); },
					signal: orchestrationAbort?.signal,
				});
				recordCost(actualRunId, draftResult.messages, "planning", "planner", round, pCfg.model);
				for (const entry of plannerInterventions) {
					markInterventionDelivered(ctx.cwd, actualRunId, entry.id, round, -1);
				}
				notifyDeliveredInterventions(ctx, plannerInterventions, round);
				setState(ctx, { ...state, activeChild: undefined });

				const criticInterventions = getPendingInterventionsFor(ctx.cwd, actualRunId, "B-critic");
				setState(ctx, { ...state, activeChild: { childId: "B-critic", side: "B", role: "critic", model: cCfg.model, startedAt: new Date().toISOString(), round } });
				const reviewResult = await runSide({
					cwd: ctx.cwd,
					model: cCfg.model,
					thinkingLevel: cCfg.thinking,
					tools: PLANNING_TOOLS,
					prompt: withPendingInterventions(criticRawPrompt, criticInterventions),
					roleSystemAddendum: roleAddendum("critic", config),
					artifactsDir: path.join(roundDir, "side-b"),
					sessionDir: planningRoleSessionDir(ctx.cwd, actualRunId, "critic"),
					schemaName: "PlanReview",
					validate: validatePlanReview,
					extractFromText: (text) => {
						const footer = parseVerdictFooter(text);
						return footer ? { verdict: footer.verdict, blockingIssues: footer.blockingIssues } : null;
					},
					onEvent: (e) => { workspace?.feedEvent(e); },
					signal: orchestrationAbort?.signal,
				});
				recordCost(actualRunId, reviewResult.messages, "planning", "critic", round, cCfg.model);
				for (const entry of criticInterventions) {
					markInterventionDelivered(ctx.cwd, actualRunId, entry.id, round, -1);
				}
				notifyDeliveredInterventions(ctx, criticInterventions, round);
				setState(ctx, { ...state, activeChild: undefined });

				autoRetryAttempts = 0;
				lastDraft = draftResult.parsed;
				draftPlanPreview = draftResult.parsed;
				draftPlanLabel = `Imported plan draft • round ${round}`;
				syncPlanWidgets(ctx);

				writeJson(path.join(roundDir, "plan.json"), draftResult.parsed);
				writeJson(path.join(roundDir, "review.json"), reviewResult.parsed);

				setState(ctx, {
					...state,
					phase: "planning",
					round,
					activeSummary: {
						stepTitle: `Imported ${path.basename(sourcePath)}`,
						implementer: "A",
						reviewer: "B",
						roleLabels: { sideA: "Planner", sideB: "Critic" },
						lastVerdict: reviewResult.parsed.verdict,
					},
					updatedAt: new Date().toISOString(),
				});

				if (reviewResult.parsed.verdict === "approve" && reviewResult.parsed.blockingIssues.length === 0) {
					writeJson(path.join(runRoot(ctx.cwd, actualRunId), "plan.json"), draftResult.parsed);
					draftPlanPreview = undefined;
					draftPlanLabel = undefined;
					setState(ctx, {
						...state,
						phase: "plan_approved",
						goal: draftResult.parsed.goal,
						planSourcePath: sourcePath,
						round,
						plan: draftResult.parsed,
						stepIndex: 0,
						pausedReason: undefined,
						resumeAction: state.postPlanMode === "review" ? undefined : "run",
						activeSummary: {
							stepTitle: `Plan approved from ${path.basename(sourcePath)}`,
							implementer: "A",
							reviewer: "B",
							roleLabels: { sideA: "Planner", sideB: "Critic" },
							lastVerdict: reviewResult.parsed.verdict,
						},
						activeConfig: config,
						updatedAt: new Date().toISOString(),
					});
					if (ctx.hasUI) ctx.ui.notify(`Imported and approved plan from ${sourcePath}.`, "info");
					return true;
				}

				priorReview = reviewResult.parsed;

				// At the end of max rounds, ask user what to do
				if (round === maxRounds) {
					const { choice, extraRounds } = await promptDeadlock(ctx, "planning", round);
					if (choice === "approve" && lastDraft) {
						writeJson(path.join(runRoot(ctx.cwd, actualRunId), "plan.json"), lastDraft);
						draftPlanPreview = undefined;
						draftPlanLabel = undefined;
						setState(ctx, {
							...state,
							phase: "plan_approved",
							goal: lastDraft.goal,
							planSourcePath: sourcePath,
							round,
							plan: lastDraft,
							stepIndex: 0,
							pausedReason: undefined,
							resumeAction: state.postPlanMode === "review" ? undefined : "run",
							activeSummary: {
								stepTitle: `Plan force-approved from ${path.basename(sourcePath)}`,
								implementer: "A",
								reviewer: "B",
								roleLabels: { sideA: "Planner", sideB: "Critic" },
								lastVerdict: "force_approved",
							},
							activeConfig: config,
							updatedAt: new Date().toISOString(),
						});
						if (ctx.hasUI) ctx.ui.notify("Plan force-approved.", "info");
						return true;
					} else if (choice === "continue") {
						maxRounds += extraRounds;
					}
					// "abort" falls through to deadlock pause below
				}
				} catch (error) {
				const failedRole = state.activeChild?.role;
				setState(ctx, { ...state, activeChild: undefined });
				if (orchestrationAbort?.signal.aborted) {
					state = { ...state, phase: "aborted", updatedAt: new Date().toISOString() };
					setState(ctx, state);
					return false;
				}
				const message = error instanceof Error ? error.message : String(error);
				const auto = await maybeAutoRetryChildError(ctx, message, autoRetryAttempts, "Planning round", orchestrationAbort?.signal, (label) => workspace?.setPhaseLabel(label));
				autoRetryAttempts = auto.attemptsUsed;
				if (auto.retry) { round--; maxRounds++; continue; }
				const action = await promptPanelError(ctx, message);
				if (action === "switch_model") {
					const updated = await switchRoleModelForRetry(ctx, config, failedRole);
					if (updated) config = updated;
					autoRetryAttempts = 0;
					round--; maxRounds++; continue;
				}
				if (action === "retry") { autoRetryAttempts = 0; round--; maxRounds++; continue; }
				state = { ...state, phase: "aborted", updatedAt: new Date().toISOString() };
				setState(ctx, state);
				return false;
				}
			}

			state = pauseState(pi, ctx.cwd, state, "plan_deadlock", "planning");
			updateUi(ctx, state);
			if (ctx.hasUI) ctx.ui.notify("Imported plan did not reach approval and is now paused.", "warning");
			return false;
		} catch (error) {
			state = pauseState(pi, ctx.cwd, state, "schema_failure", "planning");
			updateUi(ctx, state);
			const message = error instanceof Error ? error.message : String(error);
			if (ctx.hasUI) ctx.ui.notify(`Plan import failed: ${message}`, "error");
			else console.error(`Plan import failed: ${message}`);
			return false;
		}
	}

	async function promptForPostPlanAction(ctx: DuetCommandContext, config: DuetConfig, plan: PlanDraft): Promise<void> {
		if (!ctx.hasUI) return;
		let currentPlan = plan;

		// Load cached health check from disk if available
		if (!latestHealthCheckText && state.runId) {
			const cachedPath = path.join(runRoot(ctx.cwd, state.runId), "health-check", "health-check.txt");
			try {
				if (fs.existsSync(cachedPath)) {
					latestHealthCheckText = fs.readFileSync(cachedPath, "utf8");
				}
			} catch { /* ignore */ }
		}

		while (true) {
			// Check if the plan file on disk was edited externally
			const runId = state.runId;
			if (runId) {
				const planFilePath = draftPlanAbsPath(ctx.cwd, runId);
				if (fs.existsSync(planFilePath)) {
					try {
						const diskPlan = JSON.parse(fs.readFileSync(planFilePath, "utf8")) as PlanDraft;
						if (JSON.stringify(diskPlan) !== JSON.stringify(currentPlan) && diskPlan.steps?.length > 0) {
							const useEdited = await ctx.ui.select(
								"The plan file has been edited externally. Use the updated version?",
								["Yes — use the edited plan", "No — keep the current plan"],
							);
							if (useEdited?.startsWith("Yes")) {
								currentPlan = diskPlan;
								setState(ctx, { ...state, plan: currentPlan });
								ctx.ui.notify(`Plan updated from disk (${currentPlan.steps.length} steps).`, "info");
							}
						}
					} catch { /* ignore parse errors */ }
				}
			}

			const nextIndex = Math.min(state.stepIndex ?? 0, Math.max(currentPlan.steps.length - 1, 0));
			const nextStep = currentPlan.steps[nextIndex];
			const planPath = runId ? draftPlanRelPath(runId) : undefined;
			const options = [
				"Review full plan",
				"Copy plan to clipboard",
				...(planPath ? [`Edit plan file (${planPath})`] : []),
				"Summarize plan with a small model",
				"Run plan health check (blindspots, scope creep, missing tests)",
				...(latestHealthCheckText ? ["View last health check"] : []),
				"Add human feedback and run 2 more planning rounds",
				nextStep ? `Implement next step (${nextIndex + 1}. ${nextStep.title})` : "Implement next step",
				"Run the full plan",
				"Stop here",
			];
			const selected = await ctx.ui.select("Duet: review or continue", options);
			if (!selected || selected === "Stop here") return;
			if (selected === "Review full plan") {
				await showPlanForReview(ctx, currentPlan);
				continue;
			}
			if (selected === "Copy plan to clipboard") {
				const text = formatPlanDocument(currentPlan, state.planSourcePath);
				try {
					const { execSync } = await import("node:child_process");
					execSync("pbcopy", { input: text, timeout: 5000 });
					ctx.ui.notify(`Plan copied to clipboard (${currentPlan.steps.length} steps, ${text.length} chars).`, "info");
				} catch {
					// Fallback for non-macOS or if pbcopy fails
					try {
						const { execSync: exec2 } = await import("node:child_process");
						exec2("xclip -selection clipboard", { input: text, timeout: 5000 });
						ctx.ui.notify(`Plan copied to clipboard (${currentPlan.steps.length} steps, ${text.length} chars).`, "info");
					} catch {
						ctx.ui.notify("Could not copy to clipboard (pbcopy/xclip not available). Use 'Edit plan file' to access the text.", "warning");
					}
				}
				continue;
			}
			if (selected.startsWith("Run plan health check")) {
				try {
					await runPlanHealthCheck(ctx, config, currentPlan);
				} catch (error) {
					const message = error instanceof Error ? error.message : String(error);
					ctx.ui.notify(`Plan health check failed: ${message}`, "error");
				}
				continue;
			}
			if (selected === "View last health check" && latestHealthCheckText) {
				await ctx.ui.editor("Duet plan health check (cached)", latestHealthCheckText);
				continue;
			}
			if (selected.startsWith("Edit plan file") && runId) {
				const planFilePath = draftPlanAbsPath(ctx.cwd, runId);
				// Write current plan to disk if it doesn't exist or is stale
				const planJson = JSON.stringify(currentPlan, null, 2);
				writeText(planFilePath, planJson);
				ctx.ui.notify(`Plan written to ${draftPlanRelPath(runId)}\nEdit it in your editor, then come back here and select "Review full plan" to pick up changes.`, "info");
				continue;
			}
			if (selected === "Summarize plan with a small model") {
				try {
					await summarizePlanForReview(ctx, config, currentPlan);
				} catch (error) {
					const message = error instanceof Error ? error.message : String(error);
					ctx.ui.notify(`Plan summary failed: ${message}`, "error");
				}
				continue;
			}
			if (selected === "Add human feedback and run 2 more planning rounds") {
				if (!state.runId) {
					ctx.ui.notify("Cannot revise plan — missing run id.", "error");
					continue;
				}
				const note = await promptForOperatorNote(ctx, state.runId);
				if (!note) {
					ctx.ui.notify("No human feedback added. Keeping the current approved plan.", "info");
					continue;
				}
				appendRunOperatorNote(ctx.cwd, state.runId, note);
				ctx.ui.notify("Added human feedback. Running 2 more planning rounds.", "info");
				const startRound = (state.round ?? 0) + 1;
				const planningOptions: PlanningLoopOptions = {
					initialReview: humanPlanFeedbackReview(note),
					startRound,
					maxRounds: startRound + 1,
				};
				const approved = state.planSourcePath
					? await importPlanFileLoop(ctx, state.planSourcePath, config, state.runId, undefined, planningOptions)
					: state.goal
						? await runPlanningLoop(ctx, state.goal, config, state.runId, undefined, planningOptions)
						: false;
				if (!approved) return;
				if (state.plan) {
					currentPlan = state.plan;
				}
				continue;
			}
			if (selected === "Run the full plan") {
				await runAllSteps(ctx, config, currentPlan, nextIndex);
				return;
			}
			if (nextStep) {
				if (config.executionMode === "relay") {
					await executeStepRelay(ctx, config, currentPlan, nextIndex);
				} else {
					await executeStepLoop(ctx, config, currentPlan, nextIndex);
				}
				return;
			}
		}
	}

	async function resumeRun(ctx: DuetCommandContext): Promise<void> {
		const config = getActiveConfig(ctx);
		const runId = state.runId;

		// Resume coherence: log a system event and notify about pending interventions
		if (runId) {
			appendSystemIntervention(ctx.cwd, runId, `run resumed at ${new Date().toISOString()}`);

			// Load all pending (undelivered) user interventions from disk and report them
			const allEntries = loadInterventions(ctx.cwd, runId);
			const pending = allEntries.filter(
				(e) => !e.deliveredAt && e.entryType !== "system",
			);
			if (pending.length > 0 && ctx.hasUI) {
				const grouped: Record<string, number> = {};
				for (const entry of pending) {
					const id = entry.target.childId;
					grouped[id] = (grouped[id] ?? 0) + 1;
				}
				const summary = Object.entries(grouped)
					.map(([id, count]) => `${id}: ${count}`)
					.join(", ");
				ctx.ui.notify(
					`Resuming with ${pending.length} pending intervention${pending.length === 1 ? "" : "s"}: ${summary}`,
					"info",
				);
			}

			// Refresh workspace pending counts (includes any queued notes from paused state)
			workspace?.update(state, countPendingByChildId());
		}

		if (
			state.phase === "plan_approved" &&
			state.plan &&
			state.postPlanMode === "review" &&
			state.resumeAction === undefined
		) {
			await promptForPostPlanAction(ctx, config, state.plan);
			return;
		}

		if (state.resumeAction === "planning" && state.planSourcePath) {
			await importPlanFileLoop(ctx, state.planSourcePath, config, runId);
		} else if (state.resumeAction === "planning" && state.goal) {
			await runPlanningLoop(ctx, state.goal, config, runId);
		} else if (state.resumeAction === "replan" && state.plan && state.stepIndex !== undefined) {
			// Process crashed mid-replan — resume the run from the current step with the latest plan
			await runAllSteps(ctx, config, state.plan, state.stepIndex);
		} else if (state.resumeAction === "step" && state.plan && state.stepIndex !== undefined) {
			if (config.executionMode === "relay") {
				await executeStepRelay(ctx, config, state.plan, state.stepIndex);
			} else {
				await executeStepLoop(ctx, config, state.plan, state.stepIndex);
			}
		} else if (state.resumeAction === "run" && state.plan) {
			await runAllSteps(ctx, config, state.plan, state.stepIndex ?? 0);
		} else if (state.plan) {
			// plan_approved but no explicit resume action — run from current step
			await runAllSteps(ctx, config, state.plan, state.stepIndex ?? 0);
		} else {
			if (ctx.hasUI) ctx.ui.notify("Cannot resume — state is not recoverable.", "error");
		}
	}

	/**
	 * Determine the concrete `childId` of the child agent that will activate next when
	 * the run resumes from a paused state.  Returns `undefined` when the next child
	 * cannot be derived (e.g. plan not yet approved, unknown phase).
	 *
	 * Used to pre-queue operator interventions while the run is paused.
	 */
	function determineNextChildId(config: DuetConfig): string | undefined {
		// Last known active child is the most reliable signal (e.g. crashed mid-run)
		if (lastKnownActiveChildId) return lastKnownActiveChildId;

		const stepIndex = state.stepIndex;
		const resumeAction = state.resumeAction;

		// Planning or replan will always start with the planner
		if (resumeAction === "planning" || resumeAction === "replan") {
			return "A-planner";
		}

		if (stepIndex === undefined) return undefined;

		if (resumeAction === "step" || resumeAction === "run") {
			if (config.executionMode === "relay") {
				// Relay: determine from the round that was in progress
				const round = state.round ?? 1;
				const agentIndex = (round - 1) % 2;
				return agentIndex === 0 ? "A-relay-a" : "B-relay-b";
			}
			// Standard: implementer runs first
			const implementerSide = getImplementerForStep(config, stepIndex);
			return `${implementerSide}-implementer`;
		}

		return undefined;
	}

	// ---------------------------------------------------------------------------
	// Background orchestration launcher
	// ---------------------------------------------------------------------------

	/**
	 * Fire-and-forget orchestration: planning + execution in a detached async context.
	 *
	 * The command handler returns immediately after calling `void launchOrchestration(...)`.
	 * The parent session stays interactive for steering input during the run.
	 */
	async function launchOrchestration(
		ctx: DuetCommandContext,
		config: DuetConfig,
		runId: string,
		mode: "goal" | "file",
		goalOrPath: string,
		handoffMode: HandoffMode,
		postPlanMode: PostPlanMode,
		options?: { preReview?: boolean },
	): Promise<void> {
		orchestrationRunning = true;
		orchestrationAbort = new AbortController();
		acquireRunLock(ctx.cwd, runId);
		setState(ctx, {
			...state,
			runId,
			handoffMode,
			postPlanMode,
			activeConfig: config,
			updatedAt: new Date().toISOString(),
		});
		if (ctx.hasUI) {
			ctx.ui.notify(`Duet started (run ${runId.slice(0, 19)}). Type in the input bar to steer the active agent. Use >> prefix to queue a note for the other agent. Ctrl+Shift+C or /duet-pause to save & stop.`, "info");
		}

		try {
			// Phase 1: planning
			let approved: boolean;
			if (mode === "file") {
				approved = await importPlanFileLoop(ctx, goalOrPath, config, runId, handoffMode, options?.preReview ? { preReview: true } : undefined);
			} else {
				approved = await runPlanningLoop(ctx, goalOrPath, config, runId, handoffMode);
			}

			// Phase 2: execution or post-plan review (if planning approved)
			if (approved && state.plan && !orchestrationAbort.signal.aborted) {
				if (postPlanMode === "review") {
					await promptForPostPlanAction(ctx, config, state.plan);
				} else {
					// Note: runAllSteps calls finalizeSuccessfulRunCloseout on completion,
					// which already sends a duet-summary message to the parent session.
					await runAllSteps(ctx, config, state.plan, state.stepIndex ?? 0);
				}
			}
		} catch (error) {
			if (orchestrationAbort?.signal.aborted) {
				setState(ctx, { ...state, phase: "aborted", activity: undefined, updatedAt: new Date().toISOString() });
				if (ctx.hasUI) ctx.ui.notify("Duet run aborted.", "warning");
			} else {
				const message = error instanceof Error ? error.message : String(error);
				setState(ctx, { ...state, phase: "aborted", activity: undefined, updatedAt: new Date().toISOString() });
				if (ctx.hasUI) ctx.ui.notify(`Duet error: ${message}`, "error");
				else console.error(`Duet error: ${message}`);
			}
		} finally {
			orchestrationRunning = false;
			orchestrationAbort = null;
			if (state.runId) releaseRunLock(ctx.cwd, state.runId);
			workspace?.setActiveChild(undefined);
			setState(ctx, { ...state, activeChild: undefined });
		}
	}

	async function runOneShot(ctx: DuetCommandContext): Promise<void> {
		if (!ctx.hasUI) {
			console.log("/duet is interactive-only.");
			return;
		}

		// ---------------------------------------------------------------
		// Case 1: Orchestration is actively running in THIS session
		// ---------------------------------------------------------------
		if (orchestrationRunning) {
			const runLabel = state.goal
				? `"${state.goal.length > 50 ? state.goal.slice(0, 47) + "..." : state.goal}"`
				: state.runId?.slice(0, 19) ?? "current run";
			const phaseLabel = state.phase === "executing" && state.stepIndex !== undefined && state.plan
				? `executing step ${state.stepIndex + 1}/${state.plan.steps.length}`
				: state.phase;
			const title = `Duet: ${runLabel} (${phaseLabel})`;
			const options = [
				"Show status",
				"Pause run (save state & stop)",
				"Abort run (discard progress marker)",
				"Cancel",
			];
			const choice = await ctx.ui.select(title, options);
			if (!choice || choice === "Cancel") return;
			if (choice.startsWith("Show status")) {
				emitStatusText(ctx, state);
				return;
			}
			if (choice.startsWith("Pause")) {
				orchestrationAbort?.abort();
				state = pauseState(pi, ctx.cwd, state, "user_paused", state.resumeAction ?? (state.phase === "planning" ? "planning" : "step"));
				if (state.runId) releaseRunLock(ctx.cwd, state.runId);
				orchestrationRunning = false;
				orchestrationAbort = null;
				workspace?.setActiveChild(undefined);
				ctx.ui.notify("Duet paused. Use /duet to resume later.", "info");
				return;
			}
			if (choice.startsWith("Abort")) {
				orchestrationAbort?.abort();
				setState(ctx, { ...state, phase: "aborted", activity: undefined, updatedAt: new Date().toISOString() });
				ctx.ui.notify("Duet run aborted.", "warning");
				return;
			}
			return;
		}

		// ---------------------------------------------------------------
		// Case 2: No orchestration running — show the unified hub
		// ---------------------------------------------------------------

		// Offer cleanup for stale historical runs before showing the hub.
		await maybeOfferStaleRunCleanup(ctx);

		// Collect all resumable runs from disk (paused, aborted with progress,
		// or active phases from crashed sessions). Skip runs locked by other processes.
		interface ResumableRun {
			diskState: DuetState;
			label: string;
			locked: boolean;
		}
		const resumableRuns: ResumableRun[] = [];
		const allRuns = loadAllRuns(ctx.cwd);
		for (const run of allRuns) {
			const s = run.state;
			// Skip completed/idle
			if (s.phase === "idle" || s.phase === "completed") continue;
			// Aborted without a plan = nothing to resume
			if (s.phase === "aborted" && !run.hasPlan) continue;
			const locked = s.runId ? isRunLockedByOther(ctx.cwd, s.runId) : false;
			// Build a human-readable label
			const goal = s.goal
				? (s.goal.length > 45 ? s.goal.slice(0, 42) + "..." : s.goal)
				: s.planSourcePath ?? run.runId.slice(0, 19);
			const stepInfo = s.plan && s.stepIndex !== undefined
				? ` step ${s.stepIndex + 1}/${s.plan.steps.length}`
				: s.plan ? ` ${s.plan.steps.length} steps` : "";
			const phaseLabel = s.phase;
			const lockedTag = locked ? " (running in another session)" : "";
			const label = `${phaseLabel}${stepInfo} — ${goal}${lockedTag}`;
			resumableRuns.push({ diskState: s, label, locked });
		}

		// Also check in-memory state (session-log restored, not yet on disk as a run)
		const hasInMemoryResumable = !orchestrationRunning
			&& state.phase !== "idle" && state.phase !== "completed" && state.phase !== "aborted"
			&& state.runId
			&& !resumableRuns.some((r) => r.diskState.runId === state.runId);
		if (hasInMemoryResumable) {
			const goal = state.goal
				? (state.goal.length > 45 ? state.goal.slice(0, 42) + "..." : state.goal)
				: state.runId?.slice(0, 19) ?? "unknown";
			const stepInfo = state.plan && state.stepIndex !== undefined
				? ` step ${state.stepIndex + 1}/${state.plan.steps.length}`
				: "";
			const label = `${state.phase}${stepInfo} — ${goal}`;
			resumableRuns.unshift({ diskState: state, label, locked: false });
		}

		// Build the hub menu
		const options: string[] = [];
		const resumableUnlocked = resumableRuns.filter((r) => !r.locked);
		const resumableLocked = resumableRuns.filter((r) => r.locked);

		// Resumable runs (unlocked) at the top
		for (const r of resumableUnlocked) {
			options.push(`Resume: ${r.label}`);
		}

		// "Start new" options
		options.push("Plan a new task");
		if (hasWebResearchTools(() => pi.getAllTools())) {
			options.push("Plan a new task (deep research)");
		}
		options.push("Implement from an existing plan file");

		// Locked runs (informational)
		for (const r of resumableLocked) {
			options.push(`${r.label}`);
		}

		// Browse all + Cancel
		if (allRuns.length > 0) {
			options.push("Browse all runs (/duet-runs)");
		}
		options.push("Cancel");

		const title = resumableUnlocked.length > 0 ? "Duet" : "Duet: start a run";
		const choice = await ctx.ui.select(title, options);
		if (!choice || choice === "Cancel") return;

		// Handle locked run selection (informational only)
		if (resumableLocked.some((r) => choice === r.label)) {
			ctx.ui.notify("That run is active in another session. Open a new terminal for a parallel run, or wait for it to finish.", "info");
			return;
		}

		// Handle browse all runs
		if (choice.startsWith("Browse all runs")) {
			// Show the runs UI inline (same logic as /duet-runs handler)
			await showRunsList(ctx);
			return;
		}

		// Handle resume
		if (choice.startsWith("Resume:")) {
			const match = resumableUnlocked.find((r) => choice === `Resume: ${r.label}`);
			if (match) {
				const ds = match.diskState;
				state = {
					...ds,
					phase: ds.phase === "aborted" ? "executing" : ds.phase === "paused" ? (ds.resumeAction === "planning" ? "planning" : "executing") : ds.phase,
				};
				persistState(pi, ctx.cwd, state);
				updateUi(ctx, state);
				const config = getCurrentPlanConfig(ctx, ds.runId);
				void launchOrchestrationResume(ctx, config);
				return;
			}
		}

		// Handle start new task
		if (choice === "Plan a new task" || choice === "Plan a new task (deep research)" || choice === "Implement from an existing plan file") {
			const config = await promptForRunConfig(ctx, getBaseConfig(ctx));
			if (!config) return;

			if (choice === "Plan a new task" || choice === "Plan a new task (deep research)") {
				const goal = await ctx.ui.input("Duet goal", "Describe what the duet should plan");
				if (!goal?.trim()) {
					ctx.ui.notify("Cancelled duet start.", "info");
					return;
				}
				const runId = generateRunId();

				// Deep research phase — runs before the planner+critic loop
				if (choice === "Plan a new task (deep research)") {
					ctx.ui.notify("Starting deep research pipeline…", "info");
					try {
						const researchResult = await runDeepResearch(ctx.cwd, runId, goal.trim(), {
							onPhase: (phase) => ctx.ui.setStatus("duet", `duet:deep-research • ${phase}`),
							onProgress: (msg) => {
								ctx.ui.notify(msg, "info");
							},
							signal: orchestrationAbort?.signal,
						});
						ctx.ui.notify(
							`✓ Deep research complete in ${researchResult.elapsed}s — context saved to ${researchResult.contextRelPath}`,
							"success",
						);
					} catch (e: any) {
						if (e.message === "Cancelled") {
							ctx.ui.notify("Deep research cancelled.", "info");
							return;
						}
						ctx.ui.notify(`Deep research failed: ${e.message}`, "error");
						const proceed = await ctx.ui.confirm("Continue?", "Continue with standard planning (no research context)?");
						if (!proceed) return;
					}
				}

				const handoffMode = await prepareRunHandoff(ctx, config, runId);
				if (!handoffMode) return;
				const postPlanMode = await promptForPostPlanMode(ctx);
				if (!postPlanMode) {
					ctx.ui.notify("Cancelled duet start.", "info");
					return;
				}
				void launchOrchestration(ctx, config, runId, "goal", goal.trim(), handoffMode, postPlanMode);
				return;
			}

			// Implement from plan file
			const selectedFile = await pickFileInRepo(ctx, "Duet: select a plan file", ctx.cwd);
			if (!selectedFile) {
				ctx.ui.notify("Cancelled duet start.", "info");
				return;
			}
			const preReviewYes = "Yes — planner + critic analyze the plan for gaps first";
			const preReviewNo = "No — convert and start immediately";
			const preReviewChoice = await ctx.ui.select("Review plan for gaps before conversion?", [
				preReviewYes,
				preReviewNo,
			]);
			if (!preReviewChoice) {
				ctx.ui.notify("Cancelled duet start.", "info");
				return;
			}
			const preReview = preReviewChoice === preReviewYes;
			const runId = generateRunId();
			const handoffMode = await prepareRunHandoff(ctx, config, runId);
			if (!handoffMode) return;
			const postPlanMode = await promptForPostPlanMode(ctx);
			if (!postPlanMode) {
				ctx.ui.notify("Cancelled duet start.", "info");
				return;
			}
			void launchOrchestration(ctx, config, runId, "file", selectedFile, handoffMode, postPlanMode, { preReview });
			return;
		}
	}

	/**
	 * Resume a paused/aborted run as background orchestration.
	 * Called from `runOneShot` when the user chooses to resume.
	 */
	async function launchOrchestrationResume(ctx: DuetCommandContext, config: DuetConfig): Promise<void> {
		orchestrationRunning = true;
		orchestrationAbort = new AbortController();
		if (state.runId) acquireRunLock(ctx.cwd, state.runId);
		if (ctx.hasUI) {
			ctx.ui.notify("Resuming duet run. Type in the input bar to steer the active agent. Ctrl+Shift+C or /duet-pause to save & stop.", "info");
		}
		try {
			const phaseBeforeResume = state.phase;
			await resumeRun(ctx);

			// resumeRun may complete the run via different paths:
			// - runAllSteps → calls finalizeSuccessfulRunCloseout (sends duet-summary)
			// - executeStepLoop/executeStepRelay for last step → sets "completed" but
			//   does NOT call finalizeSuccessfulRunCloseout
			// Only call closeout if the run just completed and it hasn't been done already.
			if (
				state.phase === "completed" &&
				phaseBeforeResume !== "completed" &&
				state.plan &&
				state.runId &&
				!fs.existsSync(path.join(runRoot(ctx.cwd, state.runId), "closeout.json"))
			) {
				await finalizeSuccessfulRunCloseout(ctx, config, state.plan);
			}
		} catch (error) {
			if (orchestrationAbort?.signal.aborted) {
				setState(ctx, { ...state, phase: "aborted", activity: undefined, updatedAt: new Date().toISOString() });
				if (ctx.hasUI) ctx.ui.notify("Duet run aborted.", "warning");
			} else {
				const message = error instanceof Error ? error.message : String(error);
				setState(ctx, { ...state, phase: "aborted", activity: undefined, updatedAt: new Date().toISOString() });
				if (ctx.hasUI) ctx.ui.notify(`Duet resume error: ${message}`, "error");
			}
		} finally {
			orchestrationRunning = false;
			orchestrationAbort = null;
			if (state.runId) releaseRunLock(ctx.cwd, state.runId);
			workspace?.setActiveChild(undefined);
			setState(ctx, { ...state, activeChild: undefined });
		}
	}

	async function runPlanningLoop(
		ctx: ExtensionContext,
		goal: string,
		config: DuetConfig,
		runId?: string,
		explicitHandoffMode?: HandoffMode,
		options?: PlanningLoopOptions,
	): Promise<boolean> {
		clearPlanTransientUi(ctx);
		const actualRunId = runId ?? generateRunId();
		ensureDir(runRoot(ctx.cwd, actualRunId));
		writeJson(path.join(runRoot(ctx.cwd, actualRunId), "config.snapshot.json"), config);
		const handoff = loadRunHandoff(ctx.cwd, actualRunId);
		const resolvedHandoffMode = explicitHandoffMode ?? handoff?.mode ?? "none";

		try {
			let nextState: DuetState = {
				...state,
				phase: "planning",
				runId: actualRunId,
				goal,
				activity: undefined,
				plan: undefined,
				planSourcePath: undefined,
				stepIndex: undefined,
				round: 0,
				pausedReason: undefined,
				resumeAction: "planning",
				activeSummary: undefined,
				handoffMode: resolvedHandoffMode,
				activeConfig: config,
				updatedAt: new Date().toISOString(),
			};
			setState(ctx, nextState);

			const repoCheck = await ensureRepoReady(pi, ctx, config, nextState, "planning");
			if (!repoCheck.ok) {
				state = repoCheck.state;
				return false;
			}

			let priorReview: PlanReview | undefined = options?.initialReview;
			let lastDraft: PlanDraft | undefined;
			const startRound = Math.max(1, options?.startRound ?? 1);
			let maxRounds = Math.max(options?.maxRounds ?? config.maxPlanRounds, startRound);
			let autoRetryAttempts = 0;
			for (let round = startRound; round <= maxRounds; round++) {
				nextState = {
					...state,
					phase: "planning",
					round,
					activeSummary: { implementer: "A", reviewer: "B", roleLabels: { sideA: "Planner", sideB: "Critic" }, lastVerdict: priorReview?.verdict },
					updatedAt: new Date().toISOString(),
				};
				setState(ctx, nextState);

				const roundDir = planningRoundDir(ctx.cwd, actualRunId, round);
				const operatorNotes = loadRunOperatorNotes(ctx.cwd, actualRunId);

				const planFileRel = draftPlanRelPath(actualRunId);
				const planFileAbs = draftPlanAbsPath(ctx.cwd, actualRunId);
				const pCfg = getRoleConfig(config, "planner");
				const cCfg = getRoleConfig(config, "critic");
				const plannerInterventions = getPendingInterventionsFor(ctx.cwd, actualRunId, "A-planner");
				// Check if deep research context exists for this run
				const researchContextAbs = path.join(runRoot(ctx.cwd, actualRunId), "research-context.md");
				const researchContextRel = fs.existsSync(researchContextAbs) ? path.relative(ctx.cwd, researchContextAbs) : undefined;
				const plannerRawPrompt = withOperatorNotes(withRunHandoff(planPrompt(goal, config, planFileRel, priorReview, researchContextRel), handoff), operatorNotes);
				const criticRawPrompt = withOperatorNotes(withRunHandoff(planReviewPrompt(goal, planFileRel, priorReview), handoff), operatorNotes);

				// Run planner then critic sequentially with workspace UI hooks
				try {
				setState(ctx, { ...state, activeChild: { childId: "A-planner", side: "A", role: "planner", model: pCfg.model, startedAt: new Date().toISOString(), round } });
				const draftResult = await runSide({
					cwd: ctx.cwd,
					model: pCfg.model,
					thinkingLevel: pCfg.thinking,
					tools: PLANNING_TOOLS,
					prompt: withPendingInterventions(plannerRawPrompt, plannerInterventions),
					roleSystemAddendum: roleAddendum("planner", config),
					artifactsDir: path.join(roundDir, "side-a"),
					sessionDir: planningRoleSessionDir(ctx.cwd, actualRunId, "planner"),
					schemaName: "PlanDraft",
					validate: createPlanDraftValidator(config),
					resultFile: planFileAbs,
					onEvent: (e) => { workspace?.feedEvent(e); },
					signal: orchestrationAbort?.signal,
				});
				recordCost(actualRunId, draftResult.messages, "planning", "planner", round, pCfg.model);
				for (const entry of plannerInterventions) {
					markInterventionDelivered(ctx.cwd, actualRunId, entry.id, round, -1);
				}
				notifyDeliveredInterventions(ctx, plannerInterventions, round);
				setState(ctx, { ...state, activeChild: undefined });

				const criticInterventions = getPendingInterventionsFor(ctx.cwd, actualRunId, "B-critic");
				setState(ctx, { ...state, activeChild: { childId: "B-critic", side: "B", role: "critic", model: cCfg.model, startedAt: new Date().toISOString(), round } });
				const reviewResult = await runSide({
					cwd: ctx.cwd,
					model: cCfg.model,
					thinkingLevel: cCfg.thinking,
					tools: PLANNING_TOOLS,
					prompt: withPendingInterventions(criticRawPrompt, criticInterventions),
					roleSystemAddendum: roleAddendum("critic", config),
					artifactsDir: path.join(roundDir, "side-b"),
					sessionDir: planningRoleSessionDir(ctx.cwd, actualRunId, "critic"),
					schemaName: "PlanReview",
					validate: validatePlanReview,
					extractFromText: (text) => {
						const footer = parseVerdictFooter(text);
						return footer ? { verdict: footer.verdict, blockingIssues: footer.blockingIssues } : null;
					},
					onEvent: (e) => { workspace?.feedEvent(e); },
					signal: orchestrationAbort?.signal,
				});
				recordCost(actualRunId, reviewResult.messages, "planning", "critic", round, cCfg.model);
				for (const entry of criticInterventions) {
					markInterventionDelivered(ctx.cwd, actualRunId, entry.id, round, -1);
				}
				notifyDeliveredInterventions(ctx, criticInterventions, round);
				setState(ctx, { ...state, activeChild: undefined });

				autoRetryAttempts = 0;
				lastDraft = draftResult.parsed;
				draftPlanPreview = draftResult.parsed;
				draftPlanLabel = `Plan draft • round ${round}`;
				syncPlanWidgets(ctx);

				writeJson(path.join(roundDir, "plan.json"), draftResult.parsed);
				writeJson(path.join(roundDir, "review.json"), reviewResult.parsed);

				setState(ctx, {
					...state,
					phase: "planning",
					round,
					activeSummary: {
						stepTitle: "Planning",
						implementer: "A",
						reviewer: "B",
						roleLabels: { sideA: "Planner", sideB: "Critic" },
						lastVerdict: reviewResult.parsed.verdict,
					},
					updatedAt: new Date().toISOString(),
				});

				if (reviewResult.parsed.verdict === "approve" && reviewResult.parsed.blockingIssues.length === 0) {
					writeJson(path.join(runRoot(ctx.cwd, actualRunId), "plan.json"), draftResult.parsed);
					draftPlanPreview = undefined;
					draftPlanLabel = undefined;
					setState(ctx, {
						...state,
						phase: "plan_approved",
						round,
						plan: draftResult.parsed,
						stepIndex: 0,
						pausedReason: undefined,
						resumeAction: state.postPlanMode === "review" ? undefined : "run",
						activeSummary: {
							stepTitle: "Plan approved",
							implementer: "A",
							reviewer: "B",
							roleLabels: { sideA: "Planner", sideB: "Critic" },
							lastVerdict: reviewResult.parsed.verdict,
						},
						activeConfig: config,
						updatedAt: new Date().toISOString(),
					});
					if (ctx.hasUI) ctx.ui.notify("Plan approved.", "info");
					return true;
				}

				priorReview = reviewResult.parsed;

				// At the end of max rounds, ask user what to do
				if (round === maxRounds) {
					const { choice, extraRounds } = await promptDeadlock(ctx, "planning", round);
					if (choice === "approve" && lastDraft) {
						writeJson(path.join(runRoot(ctx.cwd, actualRunId), "plan.json"), lastDraft);
						draftPlanPreview = undefined;
						draftPlanLabel = undefined;
						setState(ctx, {
							...state,
							phase: "plan_approved",
							round,
							plan: lastDraft,
							stepIndex: 0,
							pausedReason: undefined,
							resumeAction: state.postPlanMode === "review" ? undefined : "run",
							activeSummary: {
								stepTitle: "Plan force-approved",
								implementer: "A",
								reviewer: "B",
								roleLabels: { sideA: "Planner", sideB: "Critic" },
								lastVerdict: "force_approved",
							},
							activeConfig: config,
							updatedAt: new Date().toISOString(),
						});
						if (ctx.hasUI) ctx.ui.notify("Plan force-approved.", "info");
						return true;
					} else if (choice === "continue") {
						maxRounds += extraRounds;
					}
				}
				} catch (error) {
					const failedRole = state.activeChild?.role;
					setState(ctx, { ...state, activeChild: undefined });
					if (orchestrationAbort?.signal.aborted) {
						state = { ...state, phase: "aborted", updatedAt: new Date().toISOString() };
						setState(ctx, state);
						return false;
					}
					const msg = error instanceof Error ? error.message : String(error);
					const auto = await maybeAutoRetryChildError(ctx, msg, autoRetryAttempts, "Planning round", orchestrationAbort?.signal, (label) => workspace?.setPhaseLabel(label));
					autoRetryAttempts = auto.attemptsUsed;
					if (auto.retry) { round--; maxRounds++; continue; }
					const action = await promptPanelError(ctx, msg);
					if (action === "switch_model") {
						const updated = await switchRoleModelForRetry(ctx, config, failedRole);
						if (updated) config = updated;
						autoRetryAttempts = 0;
						round--; maxRounds++; continue;
					}
					if (action === "retry") { autoRetryAttempts = 0; round--; maxRounds++; continue; }
					state = { ...state, phase: "aborted", updatedAt: new Date().toISOString() };
					setState(ctx, state);
					return false;
				}
			}

			state = pauseState(pi, ctx.cwd, state, "plan_deadlock", "planning");
			updateUi(ctx, state);
			if (ctx.hasUI) ctx.ui.notify("Planning reached max rounds and is now paused.", "warning");
			return false;
		} catch (error) {
			state = pauseState(pi, ctx.cwd, state, "schema_failure", "planning");
			updateUi(ctx, state);
			const message = error instanceof Error ? error.message : String(error);
			if (ctx.hasUI) ctx.ui.notify(`Planning failed: ${message}`, "error");
			else console.error(`Planning failed: ${message}`);
			return false;
		}
	}

	/**
	 * Orchestrate a targeted replan starting from stepIndex.
	 * Saves the escalation report, runs a planner+critic loop, merges the approved
	 * suffix with the completed prefix, and updates state with the new plan.
	 * Returns { ok: true, plan } on success or { ok: false } on failure/abort.
	 */
	async function replanFromCurrentStep(
		ctx: ExtensionContext,
		config: DuetConfig,
		plan: PlanDraft,
		stepIndex: number,
		escalationReason: string,
		runId: string,
	): Promise<{ ok: true; plan: PlanDraft } | { ok: false }> {

		// Determine escalation index (how many prior escalations for this step)
		const stepDirBase = path.join(runRoot(ctx.cwd, runId), "steps", String(stepIndex + 1));
		let escalationIndex = 0;
		if (fs.existsSync(stepDirBase)) {
			try {
				const entries = fs.readdirSync(stepDirBase);
				escalationIndex = entries.filter((e) => e.startsWith("escalation-")).length;
			} catch {
				// ignore
			}
		}

		// Save escalation report
		const escalDir = escalationDir(ctx.cwd, runId, stepIndex, escalationIndex);
		ensureDir(escalDir);
		const step = plan.steps[stepIndex];
		const escalReport: EscalationReport = {
			stepId: step.id,
			reason: escalationReason,
			category: "other",
		};
		const validatedEscalation = validateEscalationReport(escalReport);
		if (!validatedEscalation.ok) {
			throw new Error(`Internal error: generated invalid escalation report: ${validatedEscalation.error}`);
		}
		writeJson(path.join(escalDir, "escalation-report.json"), validatedEscalation.value);
		writeText(path.join(escalDir, "escalation-reason.txt"), escalationReason);

		const handoff = loadRunHandoff(ctx.cwd, runId);
		const planFileRel = draftPlanRelPath(runId);
		const planFileAbs = draftPlanAbsPath(ctx.cwd, runId);
		const pCfg = getRoleConfig(config, "planner");
		const cCfg = getRoleConfig(config, "critic");

		let priorReview: PlanReview | undefined;
		let lastDraft: PlanDraft | undefined;
		let maxRounds = config.maxPlanRounds;
		let autoRetryAttempts = 0;

		for (let round = 1; round <= maxRounds; round++) {
			const roundDir = replanRoundDir(ctx.cwd, runId, stepIndex, round);
			ensureDir(roundDir);
			const operatorNotes = loadRunOperatorNotes(ctx.cwd, runId);

			const replannerInterventions = getPendingInterventionsFor(ctx.cwd, runId, "A-planner");
			const replannerRawPrompt = withOperatorNotes(
				withRunHandoff(
					replanPrompt(plan.goal, plan, stepIndex, config, escalationReason, planFileRel, priorReview),
					handoff,
				),
				operatorNotes,
			);
			const replanCriticRawPrompt = withOperatorNotes(
				withRunHandoff(
					replanReviewPrompt(plan.goal, plan, stepIndex, escalationReason, planFileRel, priorReview),
					handoff,
				),
				operatorNotes,
			);
			// Run planner then critic sequentially with workspace UI hooks
			try {
			setState(ctx, { ...state, activeChild: { childId: "A-planner", side: "A", role: "planner", model: pCfg.model, startedAt: new Date().toISOString(), round } });
			const draftResult = await runSide({
				cwd: ctx.cwd,
				model: pCfg.model,
				thinkingLevel: pCfg.thinking,
				tools: PLANNING_TOOLS,
				prompt: withPendingInterventions(replannerRawPrompt, replannerInterventions),
				roleSystemAddendum: roleAddendum("planner", config),
				artifactsDir: path.join(roundDir, "side-a"),
				sessionDir: replanSessionDir(ctx.cwd, runId, stepIndex, "planner"),
				schemaName: "PlanDraft",
				validate: createPlanDraftValidator(config),
				resultFile: planFileAbs,
				onEvent: (e) => { workspace?.feedEvent(e); },
				signal: orchestrationAbort?.signal,
			});
			for (const entry of replannerInterventions) {
				markInterventionDelivered(ctx.cwd, runId, entry.id, round, stepIndex);
			}
			notifyDeliveredInterventions(ctx, replannerInterventions, round);
			setState(ctx, { ...state, activeChild: undefined });

			const replanCriticInterventions = getPendingInterventionsFor(ctx.cwd, runId, "B-critic");
			setState(ctx, { ...state, activeChild: { childId: "B-critic", side: "B", role: "critic", model: cCfg.model, startedAt: new Date().toISOString(), round } });
			const reviewResult = await runSide({
				cwd: ctx.cwd,
				model: cCfg.model,
				thinkingLevel: cCfg.thinking,
				tools: PLANNING_TOOLS,
				prompt: withPendingInterventions(replanCriticRawPrompt, replanCriticInterventions),
				roleSystemAddendum: roleAddendum("critic", config),
				artifactsDir: path.join(roundDir, "side-b"),
				sessionDir: replanSessionDir(ctx.cwd, runId, stepIndex, "critic"),
				schemaName: "PlanReview",
				validate: validatePlanReview,
				extractFromText: (text) => {
					const footer = parseVerdictFooter(text);
					return footer ? { verdict: footer.verdict, blockingIssues: footer.blockingIssues } : null;
				},
				onEvent: (e) => { workspace?.feedEvent(e); },
				signal: orchestrationAbort?.signal,
			});
			for (const entry of replanCriticInterventions) {
				markInterventionDelivered(ctx.cwd, runId, entry.id, round, stepIndex);
			}
			notifyDeliveredInterventions(ctx, replanCriticInterventions, round);
			setState(ctx, { ...state, activeChild: undefined });

			autoRetryAttempts = 0;
			lastDraft = draftResult.parsed;
			writeJson(path.join(roundDir, "plan.json"), draftResult.parsed);
			writeJson(path.join(roundDir, "review.json"), reviewResult.parsed);

			if (reviewResult.parsed.verdict === "approve" && reviewResult.parsed.blockingIssues.length === 0) {
				// Merge: preserve completed prefix from original plan, take replanned suffix
				const completedPrefix = plan.steps.slice(0, stepIndex);
				const replanSuffix = draftResult.parsed.steps.slice(stepIndex);
				const mergedPlan: PlanDraft = {
					...draftResult.parsed,
					steps: [...completedPrefix, ...replanSuffix],
				};

				// Write approved replan to runRoot/plan.json (overwriting the original)
				writeJson(path.join(runRoot(ctx.cwd, runId), "plan.json"), mergedPlan);
				writeJson(path.join(escalDir, "replan-approved.json"), mergedPlan);

				// Update state with new plan, preserving completed stepIndex and runId
				setState(ctx, {
					...state,
					plan: mergedPlan,
					stepIndex,
					resumeAction: "step",
					pausedReason: undefined,
					updatedAt: new Date().toISOString(),
				});

				return { ok: true, plan: mergedPlan };
			}

			priorReview = reviewResult.parsed;

			// At the end of max rounds, ask the user what to do
			if (round === maxRounds) {
				const { choice, extraRounds } = await promptDeadlock(ctx, "planning", round);
				if (choice === "approve" && lastDraft) {
					const completedPrefix = plan.steps.slice(0, stepIndex);
					const replanSuffix = lastDraft.steps.slice(stepIndex);
					const mergedPlan: PlanDraft = {
						...lastDraft,
						steps: [...completedPrefix, ...replanSuffix],
					};
					writeJson(path.join(runRoot(ctx.cwd, runId), "plan.json"), mergedPlan);
					writeJson(path.join(escalDir, "replan-force-approved.json"), mergedPlan);
					setState(ctx, {
						...state,
						plan: mergedPlan,
						stepIndex,
						resumeAction: "step",
						pausedReason: undefined,
						updatedAt: new Date().toISOString(),
					});
					return { ok: true, plan: mergedPlan };
				} else if (choice === "continue") {
					maxRounds += extraRounds;
				} else {
					// abort
					return { ok: false };
				}
			}
			} catch (error) {
				const failedRole = state.activeChild?.role;
				setState(ctx, { ...state, activeChild: undefined });
				if (orchestrationAbort?.signal.aborted) return { ok: false };
				const errMsg = error instanceof Error ? error.message : String(error);
				const auto = await maybeAutoRetryChildError(ctx, errMsg, autoRetryAttempts, "Replan round", orchestrationAbort?.signal, (label) => workspace?.setPhaseLabel(label));
				autoRetryAttempts = auto.attemptsUsed;
				if (auto.retry) { round--; continue; }
				const action = await promptPanelError(ctx, errMsg);
				if (action === "switch_model") {
					const updated = await switchRoleModelForRetry(ctx, config, failedRole);
					if (updated) config = updated;
					autoRetryAttempts = 0;
					round--; continue;
				}
				if (action === "retry") { autoRetryAttempts = 0; round--; continue; }
				return { ok: false };
			}
		}

		return { ok: false };
	}

	function isExecutionResume(runId: string, stepIndex: number): boolean {
		return state.resumeAction === "step" &&
			state.runId === runId &&
			state.stepIndex === stepIndex &&
			typeof state.round === "number" &&
			Number.isFinite(state.round) &&
			state.round >= 1;
	}

	function getExecutionResumeRound(runId: string, stepIndex: number): number {
		if (!isExecutionResume(runId, stepIndex)) return 1;
		return state.round!;
	}

	function loadPriorReviewForExecution(cwd: string, runId: string, stepIndex: number, round: number): ReviewReport | undefined {
		if (round <= 1) return undefined;
		const reviewPath = path.join(stepIterationDir(cwd, runId, stepIndex, round - 1), "review-report.json");
		if (!fs.existsSync(reviewPath)) return undefined;
		try {
			const raw = JSON.parse(fs.readFileSync(reviewPath, "utf8")) as unknown;
			const validated = validateReviewReport(raw);
			return validated.ok ? validated.value : undefined;
		} catch {
			return undefined;
		}
	}

	async function executeStepLoop(ctx: ExtensionContext, config: DuetConfig, plan: PlanDraft, stepIndex: number): Promise<boolean> {
		const runId = state.runId ?? generateRunId();
		if (!state.runId) {
			state = { ...state, runId };
		}
		const handoff = loadRunHandoff(ctx.cwd, runId);
		const step = plan.steps[stepIndex];
		const resumedExecution = isExecutionResume(runId, stepIndex);
		const startIteration = getExecutionResumeRound(runId, stepIndex);
		let priorReview: ReviewReport | undefined = loadPriorReviewForExecution(ctx.cwd, runId, stepIndex, startIteration);
		let maxIterations = Math.max(config.maxExecutionRounds, startIteration);
		let autoRetryAttempts = 0;

		try {
			const repoCheck = await ensureRepoReady(pi, ctx, config, state, "step");
			if (!repoCheck.ok) {
				state = repoCheck.state;
				return false;
			}

			for (let iteration = startIteration; iteration <= maxIterations; iteration++) {
				const implementer = getImplementerForStep(config, stepIndex);
				const reviewer = otherSide(implementer);
				const stepState: DuetState = {
					...state,
					phase: "executing",
					runId,
					activity: undefined,
					plan,
					stepIndex,
					round: iteration,
					pausedReason: undefined,
					resumeAction: "step",
					handoffMode: handoff?.mode ?? state.handoffMode ?? "none",
					activeSummary: {
						stepId: step.id,
						stepTitle: step.title,
						implementer,
						reviewer,
					},
					updatedAt: new Date().toISOString(),
				};
				setState(ctx, stepState);

				const iterationDir = stepIterationDir(ctx.cwd, runId, stepIndex, iteration);
				const operatorNotes = loadRunOperatorNotes(ctx.cwd, runId);
				const resumedIteration = resumedExecution && iteration === startIteration;
				const implConfig = getRoleConfig(config, "implementer");
				const revConfig = getRoleConfig(config, "reviewer");
				let gates: GateRunResult | undefined;

				const implSide = getImplementerForStep(config, stepIndex);
				const implChildId = `${implSide}-implementer`;
				const revSide = otherSide(implSide);
				const revChildId = `${revSide}-reviewer`;
				const implInterventions = getPendingInterventionsFor(ctx.cwd, runId, implChildId);
				// Build step transition context when continuing from a prior step
				const stepTransition = config.persistSessionAcrossSteps && stepIndex > 0 && iteration === startIteration
					? previousStepContext(plan, stepIndex, ctx.cwd, runId)
					: undefined;
				const implRawPrompt = withOperatorNotes(withRunHandoff(withExecutionResumeContext(implementationPrompt(plan, stepIndex, priorReview, stepTransition), resumedIteration), handoff), operatorNotes);
				const implSessionDir = config.persistSessionAcrossSteps
					? continuousSessionDir(ctx.cwd, runId, "implementer")
					: roleSessionDir(ctx.cwd, runId, stepIndex, "implementer");
				const revSessionDir = config.persistSessionAcrossSteps
					? continuousSessionDir(ctx.cwd, runId, "reviewer")
					: roleSessionDir(ctx.cwd, runId, stepIndex, "reviewer");

				// Run implementer then reviewer sequentially with workspace UI hooks
				try {
				setState(ctx, { ...state, activeChild: { childId: implChildId, side: implSide, role: "implementer", model: implConfig.model, startedAt: new Date().toISOString(), round: iteration } });
				const implementerResult = await runSide({
					cwd: ctx.cwd,
					model: implConfig.model,
					thinkingLevel: implConfig.thinking,
					tools: IMPLEMENTER_TOOLS,
					prompt: withPendingInterventions(implRawPrompt, implInterventions),
					roleSystemAddendum: roleAddendum("implementer", config),
					artifactsDir: path.join(iterationDir, "implementer"),
					schemaName: "ImplementationReport",
					validate: validateImplementationReport,
					extractFromText: () => ({ stepId: step.id, filesChanged: [] }),
					sessionDir: implSessionDir,
					onEvent: (e) => { workspace?.feedEvent(e); },
					signal: orchestrationAbort?.signal,
				});
				recordCost(runId, implementerResult.messages, stepIndex, "implementer", iteration, implConfig.model);
				for (const entry of implInterventions) {
					markInterventionDelivered(ctx.cwd, runId, entry.id, iteration, stepIndex);
				}
				notifyDeliveredInterventions(ctx, implInterventions, iteration);
				setState(ctx, { ...state, activeChild: undefined });

				// Between sides: run controller gates, show progress in workspace
				workspace?.setPhaseLabel("Running checks...");
				gates = await runControllerGates(pi, iterationDir, step, config, "full", (checkId, status) => {
					workspace?.showCheckProgress(checkId, status);
				});

				// Run reviewer with access to implementer text and gate results
				const revInterventions = getPendingInterventionsFor(ctx.cwd, runId, revChildId);
				const revRawPrompt = withOperatorNotes(withRunHandoff(withExecutionResumeContext(reviewPrompt(plan, stepIndex, implementerResult.finalAssistantText, gates), resumedIteration), handoff), operatorNotes);
				setState(ctx, { ...state, activeChild: { childId: revChildId, side: revSide, role: "reviewer", model: revConfig.model, startedAt: new Date().toISOString(), round: iteration } });
				const reviewResult = await runSide({
					cwd: ctx.cwd,
					model: revConfig.model,
					thinkingLevel: revConfig.thinking,
					tools: REVIEWER_TOOLS,
					prompt: withPendingInterventions(revRawPrompt, revInterventions),
					roleSystemAddendum: roleAddendum("reviewer", config),
					artifactsDir: path.join(iterationDir, "reviewer"),
					schemaName: "ReviewReport",
					validate: validateReviewReport,
					extractFromText: (text) => {
						const footer = parseVerdictFooter(text);
						return footer ? { stepId: step.id, verdict: footer.verdict, blockingIssues: footer.blockingIssues } : null;
					},
					sessionDir: revSessionDir,
					onEvent: (e) => { workspace?.feedEvent(e); },
					signal: orchestrationAbort?.signal,
				});
				recordCost(runId, reviewResult.messages, stepIndex, "reviewer", iteration, revConfig.model);
				for (const entry of revInterventions) {
					markInterventionDelivered(ctx.cwd, runId, entry.id, iteration, stepIndex);
				}
				notifyDeliveredInterventions(ctx, revInterventions, iteration);
				setState(ctx, { ...state, activeChild: undefined });

				autoRetryAttempts = 0;
				writeJson(path.join(iterationDir, "implementer-report.json"), implementerResult.parsed);
				writeJson(path.join(iterationDir, "review-report.json"), reviewResult.parsed);

				const approved =
					reviewResult.parsed.verdict === "approve" &&
					reviewResult.parsed.blockingIssues.length === 0 &&
					(gates?.allPassed ?? false);
				const nextStepIndex = approved ? stepIndex + 1 : stepIndex;
				const nextPhase = approved && nextStepIndex >= plan.steps.length ? "completed" : approved ? "plan_approved" : "executing";

				setState(ctx, {
					...state,
					phase: nextPhase,
					runId,
					plan,
					stepIndex: nextStepIndex,
					round: iteration,
					resumeAction: approved ? (nextPhase === "completed" ? undefined : "run") : "step",
					activeSummary: {
						stepId: step.id,
						stepTitle: step.title,
						implementer,
						reviewer,
						gateResults: gates?.gateResults,
						lastVerdict: reviewResult.parsed.verdict,
					},
					updatedAt: new Date().toISOString(),
				});

				if (approved) {
					writeJson(path.join(iterationDir, "approved.json"), {
						stepId: step.id,
						iteration,
						implementer,
						reviewer,
						gates: gates?.evidence,
						review: reviewResult.parsed,
					});
					// Auto-commit approved step
					if (config.repo.commitPerStep) {
						const commitResult = await commitApprovedStep(pi, stepIndex, step.title, runId);
						if (commitResult.committed && ctx.hasUI) {
							ctx.ui.notify(`Step ${stepIndex + 1} approved and committed.`, "info");
						} else if (ctx.hasUI) {
							ctx.ui.notify(`Step ${stepIndex + 1} approved.`, "info");
						}
					} else if (ctx.hasUI) {
						ctx.ui.notify(`Step ${stepIndex + 1} approved.`, "info");
					}
					return true;
				}

				// Handle replan_needed verdict from the reviewer
				if (reviewResult.parsed.verdict === "replan_needed") {
					const escalationReason =
						reviewResult.parsed.blockingIssues.length > 0
							? reviewResult.parsed.blockingIssues.join("; ")
							: reviewResult.finalAssistantText.trim() || "Step requires replanning";

					// Save escalation report to the iteration dir
					const escalReport: EscalationReport = {
						stepId: step.id,
						reason: escalationReason,
						category: "other",
					};
					const validatedEscalation = validateEscalationReport(escalReport);
					if (!validatedEscalation.ok) {
						throw new Error(`Internal error: generated invalid escalation report: ${validatedEscalation.error}`);
					}
					writeJson(path.join(iterationDir, "escalation-report.json"), validatedEscalation.value);

					const choice = await promptEscalation(ctx, stepIndex, step.title, escalationReason);

					if (choice === "add_guidance") {
						await captureOperatorNoteForRun(ctx, runId);
						iteration--;
						maxIterations++;
						continue;
					}

					if (choice === "replan") {
						// Persist resumeAction = "replan" before starting so crash recovery works
						state = { ...state, resumeAction: "replan" };
						persistState(pi, ctx.cwd, state);

						const result = await replanFromCurrentStep(
							ctx,
							config,
							plan,
							stepIndex,
							escalationReason,
							runId,
						);
						if (result.ok) {
							// Return false so runAllSteps can pick up the new plan from state
							return false;
						}
						// Replan was cancelled or failed — pause
						state = pauseState(pi, ctx.cwd, state, "replan_needed", "step");
						updateUi(ctx, state);
						if (ctx.hasUI) {
							ctx.ui.notify("Replan was cancelled. Paused for manual inspection.", "warning");
						}
						return false;
					}

					if (choice === "continue") {
						// Treat as changes_requested and retry the implementation loop
						priorReview = { ...reviewResult.parsed, verdict: "changes_requested" };
						continue;
					}

					// choice === "pause"
					state = pauseState(pi, ctx.cwd, state, "replan_needed", "step");
					updateUi(ctx, state);
					if (ctx.hasUI) {
						ctx.ui.notify(`Step ${stepIndex + 1} paused for manual inspection.`, "warning");
					}
					return false;
				}

				priorReview = reviewResult.parsed;

				// At the end of max iterations, ask user what to do
				if (iteration === maxIterations) {
					const { choice, extraRounds } = await promptDeadlock(ctx, "execution", iteration);
					if (choice === "approve") {
						writeJson(path.join(iterationDir, "force-approved.json"), {
							stepId: step.id,
							iteration,
							implementer,
							reviewer,
							gates: gates?.evidence,
							review: reviewResult.parsed,
						});
						const nextStepIndex2 = stepIndex + 1;
						const nextPhase2 = nextStepIndex2 >= plan.steps.length ? "completed" : "plan_approved";
						setState(ctx, {
							...state,
							phase: nextPhase2,
							runId,
							plan,
							stepIndex: nextStepIndex2,
							round: iteration,
							resumeAction: nextPhase2 === "completed" ? undefined : "run",
							activeSummary: {
								stepId: step.id,
								stepTitle: step.title,
								implementer,
								reviewer,
								gateResults: gates?.gateResults,
								lastVerdict: "force_approved",
							},
							updatedAt: new Date().toISOString(),
						});
						if (ctx.hasUI) ctx.ui.notify(`Step ${stepIndex + 1} force-approved.`, "info");
						return true;
					} else if (choice === "continue") {
						maxIterations += extraRounds;
					}
				}
				} catch (error) {
					const failedRole = state.activeChild?.role;
					setState(ctx, { ...state, activeChild: undefined });
					if (orchestrationAbort?.signal.aborted) {
						state = { ...state, phase: "aborted", updatedAt: new Date().toISOString() };
						setState(ctx, state);
						return false;
					}
					const errMsg = error instanceof Error ? error.message : String(error);
					const auto = await maybeAutoRetryChildError(ctx, errMsg, autoRetryAttempts, `Step ${stepIndex + 1}`, orchestrationAbort?.signal, (label) => workspace?.setPhaseLabel(label));
					autoRetryAttempts = auto.attemptsUsed;
					if (auto.retry) { iteration--; maxIterations++; continue; }
					const action = await promptPanelError(ctx, errMsg);
					if (action === "switch_model") {
						const updated = await switchRoleModelForRetry(ctx, config, failedRole);
						if (updated) config = updated;
						autoRetryAttempts = 0;
						iteration--; maxIterations++; continue;
					}
					if (action === "retry") { autoRetryAttempts = 0; iteration--; maxIterations++; continue; }
					state = { ...state, phase: "aborted", updatedAt: new Date().toISOString() };
					setState(ctx, state);
					return false;
				}
			}

			state = pauseState(pi, ctx.cwd, state, "execution_deadlock", "step");
			updateUi(ctx, state);
			if (ctx.hasUI) ctx.ui.notify(`Step ${stepIndex + 1} reached max iterations and is paused.`, "warning");
			return false;
		} catch (error) {
			state = pauseState(pi, ctx.cwd, state, "schema_failure", "step");
			updateUi(ctx, state);
			const message = error instanceof Error ? error.message : String(error);
			if (ctx.hasUI) ctx.ui.notify(`Execution failed: ${message}`, "error");
			else console.error(`Execution failed: ${message}`);
			return false;
		}
	}

	// ---------------------------------------------------------------------------
	// Relay execution mode: agents take turns implementing + reviewing
	// ---------------------------------------------------------------------------
	async function executeStepRelay(ctx: ExtensionContext, config: DuetConfig, plan: PlanDraft, stepIndex: number): Promise<boolean> {
		const runId = state.runId ?? generateRunId();
		if (!state.runId) state = { ...state, runId };
		const handoff = loadRunHandoff(ctx.cwd, runId);
		const step = plan.steps[stepIndex];
		const resumedExecution = isExecutionResume(runId, stepIndex);
		const startRound = getExecutionResumeRound(runId, stepIndex);
		let maxRounds = Math.max(config.maxExecutionRounds, startRound);

		try {
			const repoCheck = await ensureRepoReady(pi, ctx, config, state, "step");
			if (!repoCheck.ok) { state = repoCheck.state; return false; }

			const updateRelayExecutionState = (activity: string | undefined, round: number): void => {
				setState(ctx, {
					...state,
					phase: "executing",
					runId,
					plan,
					stepIndex,
					round,
					pausedReason: undefined,
					resumeAction: "step",
					handoffMode: handoff?.mode ?? state.handoffMode ?? "none",
					activity,
					activeSummary: {
						stepId: step.id,
						stepTitle: step.title,
						implementer: "A",
						reviewer: "B",
						gateResults: state.activeSummary?.gateResults,
						lastVerdict: state.activeSummary?.lastVerdict,
					},
					updatedAt: new Date().toISOString(),
				});
			};

			// Set initial executing state before opening the overlay
			updateRelayExecutionState(undefined, startRound);

			// Run the full step inside a single persistent overlay, handling retries and
			// user interventions in a loop.
			let currentStartRound = startRound;
			let breakPauseReason: PauseReason = "execution_deadlock";
			let autoRetryAttempts = 0;
			while (true) {
				const stepResult = await runRelayStep(
					ctx,
					pi,
					plan,
					stepIndex,
					config,
					runId,
					currentStartRound,
					maxRounds,
					handoff,
					resumedExecution,
					(activity, round) => updateRelayExecutionState(activity, round),
					orchestrationAbort?.signal,
					getPendingInterventionsFor,
					{
						setActiveChild: (info) => setState(ctx, { ...state, activeChild: info ?? undefined }),
						feedEvent: (e) => { workspace?.feedEvent(e); },
						setPhaseLabel: (label) => { workspace?.setPhaseLabel(label); },
						showCheckProgress: (id, status) => { workspace?.showCheckProgress(id, status); },
					},
				);

				if (stepResult.outcome !== "error") {
					autoRetryAttempts = 0;
				}

				if (stepResult.outcome === "completed") {
					const roundDir = stepIterationDir(ctx.cwd, runId, stepIndex, stepResult.finalRound);
					const nextStepIndex = stepIndex + 1;
					const nextPhase = nextStepIndex >= plan.steps.length ? "completed" : "plan_approved";
					writeJson(path.join(roundDir, "approved.json"), {
						stepId: step.id,
						round: stepResult.finalRound,
						gates: stepResult.gateResult?.evidence,
						verdict: "approve",
					});
					setState(ctx, {
						...state,
						phase: nextPhase,
						runId,
						plan,
						stepIndex: nextStepIndex,
						round: stepResult.finalRound,
						resumeAction: nextPhase === "completed" ? undefined : "run",
						activity: undefined,
						activeSummary: {
							stepId: step.id,
							stepTitle: step.title,
							gateResults: stepResult.gateResult?.gateResults,
							lastVerdict: "approve",
						},
						updatedAt: new Date().toISOString(),
					});
					// Auto-commit approved step
					if (config.repo.commitPerStep) {
						const commitResult = await commitApprovedStep(pi, stepIndex, step.title, runId);
						if (commitResult.committed && ctx.hasUI) {
							ctx.ui.notify(`Step ${stepIndex + 1} approved and committed (relay round ${stepResult.finalRound}).`, "info");
						} else if (ctx.hasUI) {
							ctx.ui.notify(`Step ${stepIndex + 1} approved (relay round ${stepResult.finalRound}).`, "info");
						}
					} else if (ctx.hasUI) {
						ctx.ui.notify(`Step ${stepIndex + 1} approved (relay round ${stepResult.finalRound}).`, "info");
					}
					return true;
				}

				if (stepResult.outcome === "aborted") {
					setState(ctx, { ...state, phase: "aborted", activity: undefined, updatedAt: new Date().toISOString() });
					return false;
				}

				if (stepResult.outcome === "error") {
					updateRelayExecutionState("waiting for retry decision", stepResult.finalRound);
					const errMessage = stepResult.errorMessage ?? "Relay execution error";
					const auto = await maybeAutoRetryChildError(ctx, errMessage, autoRetryAttempts, `Relay round ${stepResult.finalRound}`, orchestrationAbort?.signal, (label) => workspace?.setPhaseLabel(label));
					autoRetryAttempts = auto.attemptsUsed;
					if (auto.retry) {
						currentStartRound = stepResult.finalRound;
						continue;
					}
					const action = await promptPanelError(ctx, errMessage);
					if (action === "switch_model") {
						const failedRole = stepResult.finalRound % 2 === 1 ? "relay-a" : "relay-b";
						const updated = await switchRoleModelForRetry(ctx, config, failedRole);
						if (updated) config = updated;
						autoRetryAttempts = 0;
						currentStartRound = stepResult.finalRound;
						continue;
					}
					if (action === "retry") {
						autoRetryAttempts = 0;
						currentStartRound = stepResult.finalRound;
						continue;
					}
					setState(ctx, { ...state, phase: "aborted", activity: undefined, updatedAt: new Date().toISOString() });
					return false;
				}

				if (stepResult.outcome === "escalate") {
					const escalationReason = stepResult.escalationReason ?? "Step requires replanning";

					// Save escalation artifact
					const stepDirBase = path.join(runRoot(ctx.cwd, runId), "steps", String(stepIndex + 1));
					let escalationIndex = 0;
					if (fs.existsSync(stepDirBase)) {
						try {
							const entries = fs.readdirSync(stepDirBase);
							escalationIndex = entries.filter((e) => e.startsWith("escalation-")).length;
						} catch {
							// ignore
						}
					}
					const escalDir = escalationDir(ctx.cwd, runId, stepIndex, escalationIndex);
					ensureDir(escalDir);
					const escalReport: EscalationReport = {
						stepId: step.id,
						reason: escalationReason,
						category: "other",
					};
					const validatedEscalation = validateEscalationReport(escalReport);
					if (validatedEscalation.ok) {
						writeJson(path.join(escalDir, "escalation-report.json"), validatedEscalation.value);
					}
					writeText(path.join(escalDir, "escalation-reason.txt"), escalationReason);

					const choice = await promptEscalation(ctx, stepIndex, step.title, escalationReason);

					if (choice === "add_guidance") {
						await captureOperatorNoteForRun(ctx, runId);
						currentStartRound = stepResult.finalRound;
						continue;
					}

					if (choice === "replan") {
						// Persist resumeAction = "replan" before starting so crash recovery works
						state = { ...state, resumeAction: "replan" };
						persistState(pi, ctx.cwd, state);

						const result = await replanFromCurrentStep(
							ctx,
							config,
							plan,
							stepIndex,
							escalationReason,
							runId,
						);
						if (result.ok) {
							// Return false so runAllSteps can pick up the new plan from state
							return false;
						}
						// Replan was cancelled or failed — pause
						state = pauseState(pi, ctx.cwd, state, "replan_needed", "step");
						updateUi(ctx, state);
						if (ctx.hasUI) {
							ctx.ui.notify("Replan was cancelled. Paused for manual inspection.", "warning");
						}
						return false;
					}

					if (choice === "continue") {
						// Treat as needing more work — advance to next round
						currentStartRound = stepResult.finalRound + 1;
						continue;
					}

					// choice === "pause"
					breakPauseReason = "replan_needed";
					break;
				}

				// outcome === "deadlock": loop exhausted without approval
				if (stepResult.outcome === "deadlock") {
					updateRelayExecutionState("waiting for deadlock decision", stepResult.finalRound);
					const { choice, extraRounds } = await promptDeadlock(ctx, "execution", stepResult.finalRound);
					if (choice === "approve") {
						// Force approve — run final gates for evidence then mark complete
						const roundDir = stepIterationDir(ctx.cwd, runId, stepIndex, stepResult.finalRound);
						const finalGates = await runControllerGates(pi, roundDir, step, config, "full");
						writeJson(path.join(roundDir, "force-approved.json"), {
							stepId: step.id,
							round: stepResult.finalRound,
							gates: finalGates.evidence,
							verdict: "force_approved",
						});
						const nextStepIndex = stepIndex + 1;
						const nextPhase = nextStepIndex >= plan.steps.length ? "completed" : "plan_approved";
						setState(ctx, {
							...state,
							phase: nextPhase,
							runId,
							plan,
							stepIndex: nextStepIndex,
							round: stepResult.finalRound,
							resumeAction: nextPhase === "completed" ? undefined : "run",
							activity: undefined,
							activeSummary: {
								stepId: step.id,
								stepTitle: step.title,
								gateResults: finalGates.gateResults,
								lastVerdict: "force_approved",
							},
							updatedAt: new Date().toISOString(),
						});
						if (ctx.hasUI) ctx.ui.notify(`Step ${stepIndex + 1} force-approved.`, "info");
						return true;
					} else if (choice === "continue") {
						// Extend by extraRounds and re-run from the next round
						maxRounds = stepResult.finalRound + extraRounds;
						currentStartRound = stepResult.finalRound + 1;
						continue;
					}
					// choice === "abort" — fall through to pause
					break;
				}
			}

			state = pauseState(pi, ctx.cwd, state, breakPauseReason, "step");
			updateUi(ctx, state);
			if (breakPauseReason === "replan_needed") {
				if (ctx.hasUI) ctx.ui.notify(`Step ${stepIndex + 1} paused for manual inspection.`, "warning");
			} else {
				if (ctx.hasUI) ctx.ui.notify(`Step ${stepIndex + 1} reached max relay rounds and is paused.`, "warning");
			}
			return false;
		} catch (error) {
			state = pauseState(pi, ctx.cwd, state, "schema_failure", "step");
			updateUi(ctx, state);
			const message = error instanceof Error ? error.message : String(error);
			if (ctx.hasUI) ctx.ui.notify(`Relay execution failed: ${message}`, "error");
			return false;
		}
	}

	async function runAllSteps(ctx: ExtensionContext, config: DuetConfig, plan: PlanDraft, startIndex = 0): Promise<boolean> {
		if (startIndex >= plan.steps.length) {
			setState(ctx, {
				...state,
				phase: "completed",
				plan,
				stepIndex: plan.steps.length,
				round: undefined,
				pausedReason: undefined,
				resumeAction: undefined,
				activeSummary: { stepTitle: "All steps complete", gateResults: state.activeSummary?.gateResults },
				updatedAt: new Date().toISOString(),
			});
			await finalizeSuccessfulRunCloseout(ctx, config, plan);
			return true;
		}
		for (let index = startIndex; index < plan.steps.length; index++) {
			const ok = config.executionMode === "relay"
				? await executeStepRelay(ctx, config, plan, index)
				: await executeStepLoop(ctx, config, plan, index);
			if (!ok) {
				// Check if executeStepLoop returned false due to a successful replan.
				// After replan, state.plan is a new object and the phase is not paused/aborted.
				if (
					state.plan &&
					state.plan !== plan &&
					(state.phase === "plan_approved" || state.phase === "executing")
				) {
					// Replan succeeded — update local plan and re-run from the replanned step
					plan = state.plan;
					index = (state.stepIndex ?? index) - 1; // for-loop will increment
					continue;
				}
				return false;
			}
			if (index === plan.steps.length - 1) {
				setState(ctx, {
					...state,
					phase: "completed",
					plan,
					stepIndex: plan.steps.length,
					round: undefined,
					pausedReason: undefined,
					resumeAction: undefined,
					activeSummary: { stepTitle: "All steps complete", gateResults: state.activeSummary?.gateResults },
					updatedAt: new Date().toISOString(),
				});
				await finalizeSuccessfulRunCloseout(ctx, config, plan);
			}
		}
		return true;
	}

	pi.on("session_start", async (_event, ctx) => {
		latestCtx = ctx;
		workspace = new DuetWorkspaceUI(ctx.ui);
		state = restoreState(ctx);
		// Only show workspace UI if this session was previously running orchestration
		// (i.e. state came from this session's log, not just disk recovery).
		// Disk-recovered state is for /duet-status and /duet-abort awareness —
		// the user must explicitly /duet to resume and show the workspace.
		if (orchestrationRunning) {
			updateUi(ctx, state);
			workspace.update(state, countPendingByChildId());
			syncPlanWidgets(ctx);
		} else {
			clearPlanTransientUi(ctx);
		}
	});

	pi.registerCommand("duet", {
		description: "Start a two-agent duet run, or resume a paused one",
		handler: async (_args, ctx) => {
			await runOneShot(ctx);
		},
	});

	pi.registerCommand("duet-status", {
		description: "Show current duet phase and progress",
		handler: async (_args, ctx) => {
			if (!ctx.hasUI) {
				// No-UI path: emit detailed widget lines
				const lines = formatWidgetLines(state);
				// Append pending intervention info
				const runId = state.runId;
				if (runId) {
					const allEntries = loadInterventions(ctx.cwd, runId);
					const pending = allEntries.filter((e) => !e.deliveredAt && e.entryType !== "system");
					if (pending.length > 0) {
						const grouped: Record<string, number> = {};
						for (const e of pending) {
							grouped[e.target.childId] = (grouped[e.target.childId] ?? 0) + 1;
						}
						const summary = Object.entries(grouped).map(([id, n]) => `${id}: ${n}`).join(", ");
						lines.push(`Pending interventions: ${pending.length} (${summary})`);
					}
				}
				const queueCounts = countPendingByChildId();
				if (Object.keys(queueCounts).length > 0) {
					const summary = Object.entries(queueCounts).map(([id, n]) => `${id}: ${n}`).join(", ");
					lines.push(`Queued (in-memory): ${summary}`);
				}
				console.log(lines.join("\n"));
				return;
			}

			// UI path: build a concise status notification
			const parts: string[] = [formatStatus(state)];

			// Indicate if this is a stale run from a previous session
			if (!orchestrationRunning && state.phase !== "idle" && state.phase !== "completed" && state.phase !== "aborted") {
				parts.push("(stale — not actively running, use /duet to resume or /duet-abort to discard)");
			}

			// Active child info
			if (state.activeChild && orchestrationRunning) {
				const shortModel = state.activeChild.model.split("/").pop() ?? state.activeChild.model;
				parts.push(`active: ${state.activeChild.childId} (${shortModel})`);
			}

			// Pending intervention count (disk + queue)
			const runId = state.runId;
			let totalPending = 0;
			let pendingSummary = "";
			if (runId) {
				const allEntries = loadInterventions(ctx.cwd, runId);
				const diskPending = allEntries.filter((e) => !e.deliveredAt && e.entryType !== "system");
				const queueIds = new Set(steeringQueue.map((e) => e.id));
				const uniquePending = diskPending.filter((e) => !queueIds.has(e.id));
				totalPending = steeringQueue.length + uniquePending.length;
				if (totalPending > 0) {
					const grouped: Record<string, number> = {};
					for (const e of [...steeringQueue, ...uniquePending]) {
						const id = e.target.childId;
						grouped[id] = (grouped[id] ?? 0) + 1;
					}
					pendingSummary = Object.entries(grouped).map(([id, n]) => `${id}:${n}`).join(", ");
				}
			}
			if (totalPending > 0) {
				parts.push(`${totalPending} pending intervention${totalPending === 1 ? "" : "s"} (${pendingSummary})`);
			}

			// Cost summary
			if (runId) {
				const costSummary = loadRunCostSummary(ctx.cwd, runId);
				const costLine = formatCostOneLiner(costSummary);
				if (costLine) parts.push(costLine);
			}

			// Observations summary
			if (runId) {
				const obsLine = formatObservationsOneLiner(loadObservations(ctx.cwd, runId));
				if (obsLine) parts.push(obsLine);
			}

			ctx.ui.notify(parts.join(" • "), "info");
		},
	});

	pi.registerCommand("duet-pause", {
		description: "Pause the current duet run (saves state for later resume)",
		handler: async (_args, ctx) => {
			if (!orchestrationRunning) {
				if (ctx.hasUI) ctx.ui.notify("No active duet to pause. Use /duet to browse resumable runs.", "info");
				else console.log("No active duet to pause.");
				return;
			}
			orchestrationAbort?.abort();
			state = pauseState(pi, ctx.cwd, state, "user_paused", state.resumeAction ?? (state.phase === "planning" ? "planning" : "step"));
			if (state.runId) releaseRunLock(ctx.cwd, state.runId);
			orchestrationRunning = false;
			orchestrationAbort = null;
			workspace?.setActiveChild(undefined);
			if (ctx.hasUI) ctx.ui.notify("Duet paused. Use /duet to resume later or start a new run.", "info");
			else console.log("Duet paused.");
		},
	});

	pi.registerCommand("duet-abort", {
		description: "Abort the current duet run",
		handler: async (_args, ctx) => {
			if (!orchestrationRunning && state.phase !== "executing" && state.phase !== "planning" && state.phase !== "paused") {
				if (ctx.hasUI) ctx.ui.notify("No active duet to abort.", "info");
				else console.log("No active duet to abort.");
				return;
			}
			// Signal the background orchestration to stop
			orchestrationAbort?.abort();
			// Also update state immediately so status bar shows aborted
			setState(ctx, {
				...state,
				phase: "aborted",
				activity: undefined,
				pausedReason: undefined,
				updatedAt: new Date().toISOString(),
			});
			if (state.runId) releaseRunLock(ctx.cwd, state.runId);
			if (ctx.hasUI) ctx.ui.notify("Duet run abort signal sent.", "warning");
			else console.log("Duet run abort signal sent.");
		},
	});

	pi.registerCommand("duet-skip", {
		description: "Skip the current step and move to the next one",
		handler: async (_args, ctx) => {
			if (!orchestrationRunning && state.phase !== "executing" && state.phase !== "paused") {
				if (ctx.hasUI) ctx.ui.notify("No active step to skip. Use /duet to start or resume a run.", "info");
				else console.log("No active step to skip.");
				return;
			}
			if (!state.plan || state.stepIndex === undefined) {
				if (ctx.hasUI) ctx.ui.notify("No plan or step index — cannot determine which step to skip.", "warning");
				return;
			}
			const step = state.plan.steps[state.stepIndex];
			if (!step) {
				if (ctx.hasUI) ctx.ui.notify("Current step index is out of range.", "warning");
				return;
			}

			if (!ctx.hasUI) {
				console.log("Cannot skip without UI confirmation.");
				return;
			}

			const confirm = await ctx.ui.select(
				`Skip step ${state.stepIndex + 1}: ${step.title}?`,
				["Yes — mark as skipped and move on", "No — keep running"],
			);
			if (!confirm?.startsWith("Yes")) return;

			// Stop current orchestration if running
			orchestrationAbort?.abort();

			const runId = state.runId ?? "";
			const skipStepIndex = state.stepIndex;
			const nextStepIndex = skipStepIndex + 1;
			const nextPhase = nextStepIndex >= state.plan.steps.length ? "completed" : "plan_approved";

			// Write a skip marker
			const iterationDir = stepIterationDir(ctx.cwd, runId, skipStepIndex, state.round ?? 1);
			writeJson(path.join(iterationDir, "skipped.json"), {
				stepId: step.id,
				stepIndex: skipStepIndex,
				reason: "user_skipped",
				skippedAt: new Date().toISOString(),
			});

			setState(ctx, {
				...state,
				phase: nextPhase,
				stepIndex: nextStepIndex,
				round: undefined,
				pausedReason: undefined,
				resumeAction: nextPhase === "completed" ? undefined : "run",
				activeSummary: {
					stepTitle: `Step ${skipStepIndex + 1} skipped`,
					gateResults: state.activeSummary?.gateResults,
				},
				updatedAt: new Date().toISOString(),
			});

			orchestrationRunning = false;
			orchestrationAbort = null;
			workspace?.setActiveChild(undefined);

			if (nextPhase === "completed") {
				ctx.ui.notify(`Step ${skipStepIndex + 1} skipped. All steps complete.`, "info");
			} else {
				ctx.ui.notify(`Step ${skipStepIndex + 1} skipped. Use /duet to resume from step ${nextStepIndex + 1}.`, "info");
			}
		},
	});

	pi.registerCommand("duet-config", {
		description: "Show the active duet configuration",
		handler: async (_args, ctx) => {
			const config = getActiveConfig(ctx);
			const sideALabel = config.sideA.label || config.sideA.model.split("/").pop() || config.sideA.model;
			const sideBLabel = config.sideB.label || config.sideB.model.split("/").pop() || config.sideB.model;
			const checkIds = Object.keys(config.checks);
			const lines = [
				`Execution mode: ${config.executionMode}`,
				`Agent A: ${sideALabel} (${config.sideA.model}, thinking: ${config.sideA.thinking})`,
				`Agent B: ${sideBLabel} (${config.sideB.model}, thinking: ${config.sideB.thinking})`,
			];
			if (config.planner) lines.push(`Planner override: ${config.planner.label} (${config.planner.model})`);
			if (config.critic) lines.push(`Critic override: ${config.critic.label} (${config.critic.model})`);
			if (config.implementer) lines.push(`Implementer override: ${config.implementer.label} (${config.implementer.model})`);
			if (config.reviewer) lines.push(`Reviewer override: ${config.reviewer.label} (${config.reviewer.model})`);
			lines.push(
				`Max plan rounds: ${config.maxPlanRounds}`,
				`Max execution rounds: ${config.maxExecutionRounds}`,
				`Alternate by step: ${config.alternateByStep}`,
				`Persist sessions across steps: ${config.persistSessionAcrossSteps}`,
				`Checks: ${checkIds.join(", ")}`,
			);
			for (const [id, check] of Object.entries(config.checks)) {
				lines.push(`  ${id}: ${check.cmd} (timeout: ${check.timeoutSec ?? 300}s)`);
			}
			lines.push(
				`Repo — require git: ${config.repo.requireGit}`,
				`Repo — require clean start: ${config.repo.requireCleanStart}`,
				`Repo — commit per step: ${config.repo.commitPerStep}`,
				`Repo — capture diff check: ${config.repo.captureDiffCheck}`,
			);

			if (ctx.hasUI) ctx.ui.notify(lines.join("\n"), "info");
			else console.log(lines.join("\n"));
		},
	});

	async function showRunsList(ctx: DuetCommandContext): Promise<void> {
		if (!ctx.hasUI) {
			const entries = loadAllRuns(ctx.cwd);
			if (entries.length === 0) {
				console.log("No duet runs found.");
				return;
			}
			for (const e of entries) {
				const stepInfo = e.totalSteps > 0
					? `${e.stepIndex !== undefined ? e.stepIndex + 1 : 0}/${e.totalSteps} steps`
					: "no plan";
				const lockTag = e.lockedByOther ? " [locked]" : "";
				console.log(`${e.state.phase.padEnd(12)} ${e.dateStr.padEnd(14)} ${stepInfo.padEnd(14)} ${e.label}${lockTag}`);
			}
			return;
		}

		const entries = loadAllRuns(ctx.cwd);

		const result = await ctx.ui.custom<RunAction>((tui, theme, _keybindings, done) => {
			const component = new RunListComponent(theme, () => tui.terminal.rows, entries);
			component.onAction = (action) => {
				if (action.action === "delete") {
					const root = runRoot(ctx.cwd, action.runId);
					if (fs.existsSync(root)) {
						deleteRunRoot(ctx.cwd, action.runId);
						component.removeRun(action.runId);
						component.invalidate();
					}
					return;
				}
				if (action.action === "abort") {
					const statePath = path.join(runRoot(ctx.cwd, action.runId), "state.json");
					const diskState = readJson<DuetState>(statePath);
					if (diskState) {
						diskState.phase = "aborted";
						diskState.updatedAt = new Date().toISOString();
						writeJson(statePath, diskState);
						component.updateRunState(action.runId, "aborted");
						if (state.runId === action.runId) {
							setState(ctx, { ...state, phase: "aborted", activity: undefined, pausedReason: undefined, updatedAt: new Date().toISOString() });
							orchestrationAbort?.abort();
						}
						component.invalidate();
					}
					return;
				}
				done(action);
			};
			return component;
		});

		if (!result || result.action === "close") return;

		if (result.action === "resume") {
			state = { ...result.state, phase: result.state.phase === "aborted" ? "executing" : result.state.phase };
			persistState(pi, ctx.cwd, state);
			updateUi(ctx, state);
			const config = getCurrentPlanConfig(ctx, result.state.runId);
			void launchOrchestrationResume(ctx, config);
			return;
		}

		if (result.action === "view-plan") {
			// Load plan from disk and show in scrollable viewer
			const planPath = path.join(runRoot(ctx.cwd, result.runId), "plan.json");
			const plan = readJson<PlanDraft>(planPath);
			if (plan) {
				await showPlanForReview(ctx, plan, result.sourcePath);
			} else {
				ctx.ui.notify("Could not load plan.json for this run.", "error");
			}
			return;
		}

		if (result.action === "view-summary") {
			const summaryPath = path.join(runRoot(ctx.cwd, result.runId), "run-summary.md");
			if (fs.existsSync(summaryPath)) {
				const summaryText = fs.readFileSync(summaryPath, "utf8");
				await ctx.ui.custom<void>((tui, theme, _keybindings, done) => {
					let scrollOffset = 0;
					let renderedLines: string[] = [];
					let lastHeight = 0;

					const mdTheme = getMarkdownTheme();
					const md = new Markdown(summaryText, 2, 1, mdTheme);

					const viewer: Component = {
						handleInput(data: string) {
							const pageSize = Math.max(1, lastHeight - 4);
							if (matchesKey(data, Key.down) || data === "j") {
								scrollOffset = Math.min(scrollOffset + 1, Math.max(0, renderedLines.length - pageSize));
							} else if (matchesKey(data, Key.up) || data === "k") {
								scrollOffset = Math.max(0, scrollOffset - 1);
							} else if (matchesKey(data, Key.pageDown) || data === " ") {
								scrollOffset = Math.min(scrollOffset + pageSize, Math.max(0, renderedLines.length - pageSize));
							} else if (matchesKey(data, Key.pageUp)) {
								scrollOffset = Math.max(0, scrollOffset - pageSize);
							} else if (matchesKey(data, Key.home) || data === "g") {
								scrollOffset = 0;
							} else if (matchesKey(data, Key.end) || data === "G") {
								scrollOffset = Math.max(0, renderedLines.length - pageSize);
							} else if (matchesKey(data, Key.escape) || data === "q") {
								done();
								return;
							}
							viewer.invalidate?.();
						},
						render(width: number): string[] {
							const height = tui.terminal.rows;
							lastHeight = height;
							renderedLines = md.render(width - 2);
							const viewportHeight = Math.max(1, height - 3);
							const maxScroll = Math.max(0, renderedLines.length - viewportHeight);
							scrollOffset = Math.min(scrollOffset, maxScroll);
							const visible = renderedLines.slice(scrollOffset, scrollOffset + viewportHeight);
							while (visible.length < viewportHeight) visible.push("");
							const totalLines = renderedLines.length;
							const pct = totalLines <= viewportHeight ? 100 : Math.round(((scrollOffset + viewportHeight) / totalLines) * 100);
							const header = theme.fg("accent", `── Run Summary (${result.runId.slice(0, 19)}) ──`);
							const footer = theme.fg("dim", `  ↑/↓/j/k scroll · PgUp/PgDn page · g/G top/bottom · q/Esc close   ${pct}%`);
							return [header, ...visible, footer];
						},
						invalidate() {},
					};
					return viewer;
				});
			} else {
				ctx.ui.notify("No run-summary.md found for this run.", "error");
			}
			return;
		}
	}

	pi.registerCommand("duet-runs", {
		description: "Browse and manage all duet runs",
		handler: async (_args, ctx) => {
			await showRunsList(ctx);
		},
	});

	pi.registerCommand("duet-cost", {
		description: "Show cost breakdown for the current or most recent run",
		handler: async (_args, ctx) => {
			const runId = state.runId;
			if (!runId) {
				// Try to find the most recent run
				const runs = loadAllRuns(ctx.cwd);
				if (runs.length === 0) {
					if (ctx.hasUI) ctx.ui.notify("No duet runs found.", "info");
					else console.log("No duet runs found.");
					return;
				}
				const latestRunId = runs[0].runId;
				const summary = loadRunCostSummary(ctx.cwd, latestRunId);
				const report = formatCostReport(summary);
				if (ctx.hasUI) ctx.ui.notify(`Cost for ${latestRunId.slice(0, 19)}:\n${report}`, "info");
				else console.log(report);
				return;
			}
			const summary = loadRunCostSummary(ctx.cwd, runId);
			const report = formatCostReport(summary);
			if (ctx.hasUI) ctx.ui.notify(`Cost for ${runId.slice(0, 19)}:\n${report}`, "info");
			else console.log(report);
		},
	});

	pi.registerCommand("duet-observations", {
		description: "Show observations logged by relay agents during the current or most recent run",
		handler: async (_args, ctx) => {
			let targetRunId = state.runId;
			if (!targetRunId) {
				const runs = loadAllRuns(ctx.cwd);
				if (runs.length === 0) {
					if (ctx.hasUI) ctx.ui.notify("No duet runs found.", "info");
					else console.log("No duet runs found.");
					return;
				}
				targetRunId = runs[0].runId;
			}
			const observations = loadObservations(ctx.cwd, targetRunId);
			const report = formatObservationsReport(observations);
			if (ctx.hasUI) ctx.ui.notify(`Observations for ${targetRunId.slice(0, 19)}:\n${report}`, "info");
			else console.log(report);
		},
	});

	pi.registerCommand("duet-setup", {
		description: "Quick setup wizard for duet configuration",
		handler: async (_args, ctx) => {
			if (!ctx.hasUI) {
				console.log("/duet-setup requires a UI.");
				return;
			}

			const existing = loadConfig(ctx.cwd);
			const base = existing ?? DEFAULT_CONFIG;

			// Step 1: Execution mode
			const modeChoice = await ctx.ui.select("Execution mode", [
				"Relay (recommended) — both agents implement & review, taking turns",
				"Standard — one implements, the other reviews (read-only reviewer)",
			]);
			if (!modeChoice) return;
			const executionMode: ExecutionMode = modeChoice.startsWith("Relay") ? "relay" : "standard";

			// Step 2: Models
			const modelChoices = await getScopedModelChoices(ctx);
			const sideAPick = await pickModelChoice(ctx, "Agent A model", modelChoices, base.sideA.model, undefined, DEFAULT_CONFIG.sideA.model);
			if (!sideAPick) return;
			const sideAThinking = await pickThinkingLevel(ctx, `Agent A thinking (${sideAPick.key})`, sideAPick, DEFAULT_CONFIG.sideA.thinking);
			if (!sideAThinking) return;

			const sameModel = await ctx.ui.select("Use the same model for Agent B?", ["Yes", "No — pick a different model"]);
			if (!sameModel) return;

			let sideBModel = sideAPick;
			let sideBThinking = sideAThinking;
			if (sameModel.startsWith("No")) {
				const pick = await pickModelChoice(ctx, "Agent B model", modelChoices, base.sideB.model, undefined, DEFAULT_CONFIG.sideB.model);
				if (!pick) return;
				sideBModel = pick;
				const th = await pickThinkingLevel(ctx, `Agent B thinking (${pick.key})`, pick, DEFAULT_CONFIG.sideB.thinking);
				if (!th) return;
				sideBThinking = th;
			}

			// Step 3: Checks
			const checksChoice = await ctx.ui.select("What checks should run after each step?", [
				"Auto-detect from package.json",
				"Use current config checks",
				"Skip checks (not recommended)",
			]);
			if (!checksChoice) return;

			let checks = base.checks;
			if (checksChoice.startsWith("Auto")) {
				// Try to auto-detect from package.json
				const pkgPath = path.join(ctx.cwd, "package.json");
				if (fs.existsSync(pkgPath)) {
					try {
						const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf8")) as { scripts?: Record<string, string> };
						const detected: Record<string, { cmd: string; timeoutSec: number }> = {};

						// Consolidate lint + typecheck into a single "static" check to avoid
						// redundant tsc/gradle cold-starts when they run separately.
						const staticParts: string[] = [];
						if (pkg.scripts?.["lint"]) staticParts.push("npm run lint");
						if (pkg.scripts?.["typecheck"]) staticParts.push("npm run typecheck");
						else if (pkg.scripts?.["type-check"]) staticParts.push("npm run type-check");
						if (staticParts.length > 0) {
							detected["static"] = { cmd: staticParts.join(" && "), timeoutSec: 300 };
						}

						// Test / unit — cap vitest/jest workers to avoid memory explosion
						if (pkg.scripts?.["test"]) {
							detected["unit"] = { cmd: "npm test -- --maxWorkers=6", timeoutSec: 600 };
						}

						// Build — only if no typecheck script exists (build is redundant
						// when tsc --noEmit already catches type errors; vite/webpack build
						// failures are rare if types pass).
						if (pkg.scripts?.["build"] && !pkg.scripts?.["typecheck"] && !pkg.scripts?.["type-check"]) {
							detected["build"] = { cmd: "npm run build", timeoutSec: 600 };
						}
						if (Object.keys(detected).length > 0) {
							checks = detected;
							ctx.ui.notify(`Auto-detected checks: ${Object.keys(detected).join(", ")}`, "info");
						} else {
							ctx.ui.notify("No recognizable scripts found in package.json. Using default checks.", "warning");
						}
					} catch {
						ctx.ui.notify("Could not parse package.json. Using default checks.", "warning");
					}
				} else {
					ctx.ui.notify("No package.json found. Using default checks.", "warning");
				}
			} else if (checksChoice.startsWith("Skip")) {
				checks = { noop: { cmd: "true", timeoutSec: 10 } };
			}

			const config: DuetConfig = {
				sideA: { label: sideAPick.model.name || sideAPick.label, model: sideAPick.key, thinking: sideAThinking },
				sideB: { label: sideBModel.model.name || sideBModel.label, model: sideBModel.key, thinking: sideBThinking },
				executionMode,
				startImplementer: base.startImplementer,
				maxPlanRounds: base.maxPlanRounds,
				maxExecutionRounds: base.maxExecutionRounds,
				alternateByStep: base.alternateByStep,
				checks,
				repo: base.repo,
				persistSessionAcrossSteps: base.persistSessionAcrossSteps,
			};

			saveConfig(ctx.cwd, config);
			ctx.ui.notify(`Duet config saved to .pi/duet/config.json\nMode: ${executionMode} · A: ${config.sideA.label} · B: ${config.sideB.label} · Checks: ${Object.keys(checks).join(", ")}`, "info");
		},
	});

	// ---------------------------------------------------------------------------
	// Keyboard shortcuts — pane navigation
	// ---------------------------------------------------------------------------
	pi.registerShortcut(Key.alt(","), {
		description: "Duet: show activity pane",
		handler: async (_ctx) => { workspace?.togglePane("left"); },
	});

	pi.registerShortcut(Key.alt("."), {
		description: "Duet: show plan pane",
		handler: async (_ctx) => { workspace?.togglePane("right"); },
	});

	// Pause shortcut — Ctrl+Shift+C (Ctrl+C conflicts with built-in copy/clear)
	// Pauses instead of aborting — less destructive, easily resumed via /duet.
	pi.registerShortcut(Key.ctrlShift("c"), {
		description: "Duet: pause active run",
		handler: async (ctx) => {
			if (!orchestrationRunning) return;
			orchestrationAbort?.abort();
			state = pauseState(pi, ctx.cwd, state, "user_paused", state.resumeAction ?? (state.phase === "planning" ? "planning" : "step"));
			if (state.runId) releaseRunLock(ctx.cwd, state.runId);
			orchestrationRunning = false;
			orchestrationAbort = null;
			workspace?.setActiveChild(undefined);
			if (ctx.hasUI) ctx.ui.notify("Duet paused. /duet to resume, /duet-abort to discard.", "info");
		},
	});

	// ---------------------------------------------------------------------------
	// Input event handler — steering and notes for active/inactive children
	// ---------------------------------------------------------------------------
	pi.on("input", (event, ctx) => {
		latestCtx = ctx;

		// Don't intercept command invocations
		if (event.text.startsWith("/")) return { action: "continue" };

		const text = event.text.trim();
		if (!text) return { action: "continue" };

		// ------------------------------------------------------------------
		// Paused state (orchestration not running) — pre-queue interventions
		// ------------------------------------------------------------------
		if (!orchestrationRunning && state.phase === "paused" && state.runId) {
			const runId = state.runId;
			const config = state.activeConfig ?? DEFAULT_CONFIG;
			const now = new Date().toISOString();

			if (event.text.startsWith(">>")) {
				// Note for the "other" child — the one that activates second on resume.
				// Determine it as the pair of the next child.
				const content = event.text.slice(2).trim();
				if (!content) {
					if (ctx.hasUI) ctx.ui.notify("Empty note — add content after >>", "info");
					return { action: "handled" };
				}
				const nextChildId = determineNextChildId(config);
				if (!nextChildId) {
					if (ctx.hasUI) ctx.ui.notify("Cannot determine target child — use /duet to resume first.", "warning");
					return { action: "handled" };
				}
				// Derive the "other" child by using the inactive-child logic
				const fakeState: DuetState = {
					...state,
					activeChild: (() => {
						const dashIdx = nextChildId.indexOf("-");
						const side = nextChildId.slice(0, dashIdx) as "A" | "B";
						const role = nextChildId.slice(dashIdx + 1);
						return { childId: nextChildId, side, role, model: "", startedAt: now, round: state.round ?? 1 };
					})(),
				};
				const otherChildId = inactiveChildId(fakeState, config);
				if (!otherChildId) {
					if (ctx.hasUI) ctx.ui.notify("Cannot determine other child to note — use /duet to resume first.", "warning");
					return { action: "handled" };
				}
				const dashIdx = otherChildId.indexOf("-");
				const side = otherChildId.slice(0, dashIdx) as "A" | "B";
				const role = otherChildId.slice(dashIdx + 1);
				const entry: InterventionEntry = {
					id: crypto.randomUUID(),
					timestamp: now,
					target: { childId: otherChildId, side, role, intent: "note" },
					content,
				};
				steeringQueue.push(entry);
				appendIntervention(ctx.cwd, runId, entry);
				workspace?.update(state, countPendingByChildId());
				if (ctx.hasUI) ctx.ui.notify(`Note queued for ${otherChildId} (run paused — will deliver on resume)`, "info");
				return { action: "handled" };
			}

			// Regular text → steer for the next child to activate
			const nextChildId = determineNextChildId(config);
			if (!nextChildId) {
				if (ctx.hasUI) ctx.ui.notify("Cannot determine target child — use /duet to resume first.", "warning");
				return { action: "handled" };
			}
			const dashIdx = nextChildId.indexOf("-");
			const side = nextChildId.slice(0, dashIdx) as "A" | "B";
			const role = nextChildId.slice(dashIdx + 1);
			const entry: InterventionEntry = {
				id: crypto.randomUUID(),
				timestamp: now,
				target: { childId: nextChildId, side, role, intent: "steer" },
				content: text,
			};
			steeringQueue.push(entry);
			appendIntervention(ctx.cwd, runId, entry);
			workspace?.update(state, countPendingByChildId());
			if (ctx.hasUI) ctx.ui.notify(`Steer queued for ${nextChildId} (run paused — will deliver on resume)`, "info");
			return { action: "handled" };
		}

		// No active run or non-paused idle state — pass through to parent LLM
		if (!orchestrationRunning) return { action: "continue" };

		// ------------------------------------------------------------------
		// Active orchestration — steer active child or note inactive child
		// ------------------------------------------------------------------
		const runId = state.runId;
		if (!runId) return { action: "continue" };

		const now = new Date().toISOString();

		if (event.text.startsWith(">>")) {
			// Note for the inactive child (queued for its next activation)
			const content = event.text.slice(2).trim();
			if (!content) {
				if (ctx.hasUI) ctx.ui.notify("Empty note — add content after >>", "info");
				return { action: "handled" };
			}

			const inactiveId = inactiveChildId(state, state.activeConfig ?? DEFAULT_CONFIG);
			if (!inactiveId) {
				if (ctx.hasUI) ctx.ui.notify("No inactive child to target right now.", "warning");
				return { action: "handled" };
			}

			// Parse side and role from the childId (format: "${side}-${role}")
			const dashIdx = inactiveId.indexOf("-");
			const side = inactiveId.slice(0, dashIdx) as "A" | "B";
			const role = inactiveId.slice(dashIdx + 1);

			const entry: InterventionEntry = {
				id: crypto.randomUUID(),
				timestamp: now,
				target: { childId: inactiveId, side, role, intent: "note" },
				content,
			};
			steeringQueue.push(entry);
			appendIntervention(ctx.cwd, runId, entry);
			workspace?.update(state, countPendingByChildId());
			if (ctx.hasUI) ctx.ui.notify(`Note queued for ${inactiveId}`, "info");
			return { action: "handled" };
		}

		// Steer for the active child (or last known active child if between rounds)
		const targetChildId = state.activeChild?.childId ?? lastKnownActiveChildId;
		if (!targetChildId) {
			// Orchestration is running but no child is active yet (startup phase).
			// Consume the input with a notice — don't forward to the AI.
			if (ctx.hasUI) ctx.ui.notify("Orchestration is starting — no active child to steer yet. Try again shortly.", "warning");
			return { action: "handled" };
		}

		const dashIdx2 = targetChildId.indexOf("-");
		const side2 = targetChildId.slice(0, dashIdx2) as "A" | "B";
		const role2 = targetChildId.slice(dashIdx2 + 1);

		const entry: InterventionEntry = {
			id: crypto.randomUUID(),
			timestamp: now,
			target: { childId: targetChildId, side: side2, role: role2, intent: "steer" },
			content: text,
		};
		steeringQueue.push(entry);
		appendIntervention(ctx.cwd, runId, entry);
		workspace?.update(state, countPendingByChildId());
		if (ctx.hasUI) ctx.ui.notify(`Steer queued for ${targetChildId}`, "info");
		return { action: "handled" };
	});
}
