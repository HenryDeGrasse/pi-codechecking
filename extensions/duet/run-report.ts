/**
 * Post-run observability report generation.
 *
 * Aggregates data from iteration directories, gate evidence, review reports,
 * and cost data into a human-readable markdown report showing:
 * - Rounds per step and what happened in each
 * - What the reviewer caught
 * - Time and cost per step
 * - Overall run statistics
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { readJson, runRoot } from "./fs.js";
import { loadRunCostSummary, formatCostOneLiner, type AgentCostEntry } from "./cost.js";
import { loadObservations, formatObservationsReport, type Observation } from "./observations.js";
import type { DuetConfig, DuetState, PlanDraft, ReviewReport } from "./types.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface IterationSummary {
	iteration: number;
	approved: boolean;
	forceApproved: boolean;
	skipped: boolean;
	verdict?: string;
	blockingIssues: string[];
	gatesPassed: boolean;
	/** Elapsed ms from first event to last (when events.jsonl exists). */
	elapsedMs?: number;
}

interface StepReport {
	stepIndex: number;
	title: string;
	id: string;
	iterations: IterationSummary[];
	totalRounds: number;
	approved: boolean;
	skipped: boolean;
	forceApproved: boolean;
	changedFiles: string[];
	/** Aggregated cost for this step. */
	costTotal: number;
	costTokens: number;
}

export interface RunReport {
	runId: string;
	goal: string;
	executionMode: string;
	totalSteps: number;
	completedSteps: number;
	skippedSteps: number;
	totalRounds: number;
	totalCost: number;
	totalTokens: number;
	steps: StepReport[];
	/** Observation counts (logged by relay agents). */
	observations: { high: number; medium: number; low: number; total: number };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function readEventsElapsed(eventsPath: string): number | undefined {
	if (!fs.existsSync(eventsPath)) return undefined;
	try {
		const lines = fs.readFileSync(eventsPath, "utf8").trim().split("\n");
		if (lines.length < 2) return undefined;
		const first = JSON.parse(lines[0]) as { t?: number };
		const last = JSON.parse(lines[lines.length - 1]) as { t?: number };
		if (typeof first.t === "number" && typeof last.t === "number") {
			return last.t - first.t;
		}
	} catch { /* ignore */ }
	return undefined;
}

function fmtDuration(ms: number): string {
	const sec = Math.floor(ms / 1000);
	if (sec < 60) return `${sec}s`;
	const min = Math.floor(sec / 60);
	const remSec = sec % 60;
	if (min < 60) return `${min}m${remSec.toString().padStart(2, "0")}s`;
	const hr = Math.floor(min / 60);
	const remMin = min % 60;
	return `${hr}h${remMin.toString().padStart(2, "0")}m`;
}

function fmtTokens(n: number): string {
	if (n < 1000) return `${n}`;
	if (n < 1_000_000) return `${(n / 1000).toFixed(1)}k`;
	return `${(n / 1_000_000).toFixed(2)}M`;
}

function fmtCost(dollars: number): string {
	if (dollars < 0.01) return `$${dollars.toFixed(4)}`;
	if (dollars < 1) return `$${dollars.toFixed(3)}`;
	return `$${dollars.toFixed(2)}`;
}

// ---------------------------------------------------------------------------
// Report generation
// ---------------------------------------------------------------------------

export function generateRunReport(
	cwd: string,
	runId: string,
	plan: PlanDraft,
	config: DuetConfig,
	savedState?: DuetState,
): RunReport {
	const costSummary = loadRunCostSummary(cwd, runId);
	const costByStep = new Map<number, { cost: number; tokens: number }>();
	for (const entry of costSummary.entries) {
		if (typeof entry.phase !== "number") continue;
		const existing = costByStep.get(entry.phase) ?? { cost: 0, tokens: 0 };
		existing.cost += entry.costTotal;
		existing.tokens += entry.totalTokens;
		costByStep.set(entry.phase, existing);
	}

	const steps: StepReport[] = [];
	let totalRounds = 0;
	let completedSteps = 0;
	let skippedSteps = 0;

	for (const [index, planStep] of plan.steps.entries()) {
		const stepDir = path.join(runRoot(cwd, runId), "steps", String(index + 1));
		const iterations: IterationSummary[] = [];
		let stepApproved = false;
		let stepSkipped = false;
		let stepForceApproved = false;
		let changedFiles: string[] = [];

		if (fs.existsSync(stepDir)) {
			const iterDirs = fs.readdirSync(stepDir, { withFileTypes: true })
				.filter((d) => d.isDirectory() && d.name.startsWith("iteration-"))
				.map((d) => d.name)
				.sort((a, b) => {
					const na = Number(a.slice("iteration-".length));
					const nb = Number(b.slice("iteration-".length));
					return na - nb;
				});

			for (const dirName of iterDirs) {
				const iterDir = path.join(stepDir, dirName);
				const iterNum = Number(dirName.slice("iteration-".length));
				const approved = fs.existsSync(path.join(iterDir, "approved.json"));
				const forceApproved = fs.existsSync(path.join(iterDir, "force-approved.json"));
				const skipped = fs.existsSync(path.join(iterDir, "skipped.json"));

				let verdict: string | undefined;
				let blockingIssues: string[] = [];
				const reviewPath = path.join(iterDir, "review-report.json");
				const review = readJson<ReviewReport>(reviewPath);
				if (review) {
					verdict = review.verdict;
					blockingIssues = review.blockingIssues ?? [];
				}

				// For relay mode, check relay-result.json
				const relayPath = path.join(iterDir, "relay-result.json");
				const relay = readJson<{ verdict?: string }>(relayPath);
				if (relay?.verdict && !verdict) {
					verdict = relay.verdict;
				}

				// Gate results
				const gateEvidence = readJson<Array<{ passed: boolean }>>(
					path.join(iterDir, "controller", "gate-evidence.json"),
				);
				const gatesPassed = gateEvidence
					? gateEvidence.every((g) => g.passed)
					: true;

				// Elapsed time from events
				const implEvents = path.join(iterDir, "implementer", "events.jsonl");
				const agentAEvents = path.join(iterDir, "agent-a", "events.jsonl");
				const eventsPath = fs.existsSync(implEvents) ? implEvents : agentAEvents;
				const elapsedMs = readEventsElapsed(eventsPath);

				// Changed files from last iteration
				if (approved || forceApproved) {
					const diffPath = path.join(iterDir, "controller", "diff-name-only.txt");
					if (fs.existsSync(diffPath)) {
						changedFiles = fs.readFileSync(diffPath, "utf8")
							.split("\n").map((l) => l.trim()).filter(Boolean);
					}
				}

				iterations.push({
					iteration: iterNum,
					approved,
					forceApproved,
					skipped,
					verdict,
					blockingIssues,
					gatesPassed,
					elapsedMs,
				});

				if (approved) stepApproved = true;
				if (forceApproved) stepForceApproved = true;
				if (skipped) stepSkipped = true;
			}
		}

		const stepCost = costByStep.get(index) ?? { cost: 0, tokens: 0 };
		const roundCount = iterations.length;
		totalRounds += roundCount;
		if (stepApproved || stepForceApproved) completedSteps++;
		if (stepSkipped) skippedSteps++;

		steps.push({
			stepIndex: index,
			title: planStep.title,
			id: planStep.id,
			iterations,
			totalRounds: roundCount,
			approved: stepApproved,
			skipped: stepSkipped,
			forceApproved: stepForceApproved,
			changedFiles,
			costTotal: stepCost.cost,
			costTokens: stepCost.tokens,
		});
	}

	// Planning cost
	const planningCost = costSummary.entries
		.filter((e) => e.phase === "planning")
		.reduce((sum, e) => sum + e.costTotal, 0);
	const planningTokens = costSummary.entries
		.filter((e) => e.phase === "planning")
		.reduce((sum, e) => sum + e.totalTokens, 0);

	// Observation counts
	const allObs = loadObservations(cwd, runId);
	const obsHigh = allObs.filter((o) => o.severity === "high").length;
	const obsMed = allObs.filter((o) => o.severity === "medium").length;
	const obsLow = allObs.filter((o) => o.severity === "low").length;

	return {
		runId,
		goal: plan.goal,
		executionMode: config.executionMode,
		totalSteps: plan.steps.length,
		completedSteps,
		skippedSteps,
		totalRounds,
		totalCost: costSummary.totalCost,
		totalTokens: costSummary.totalTokens,
		steps,
		observations: { high: obsHigh, medium: obsMed, low: obsLow, total: allObs.length },
	};
}

// ---------------------------------------------------------------------------
// Markdown formatting
// ---------------------------------------------------------------------------

export function formatRunReportMarkdown(report: RunReport): string {
	const lines: string[] = [];

	lines.push(`# Duet Run Report`);
	lines.push("");
	lines.push(`**Goal:** ${report.goal}`);
	lines.push(`**Run ID:** ${report.runId}`);
	lines.push(`**Mode:** ${report.executionMode}`);
	lines.push(`**Steps:** ${report.completedSteps} completed, ${report.skippedSteps} skipped, ${report.totalSteps} total`);
	lines.push(`**Total rounds:** ${report.totalRounds}`);
	if (report.totalCost > 0) {
		lines.push(`**Total cost:** ${fmtCost(report.totalCost)} (${fmtTokens(report.totalTokens)} tokens)`);
	}
	lines.push("");

	// Quick overview table
	lines.push("## Step Overview");
	lines.push("");
	lines.push("| # | Step | Rounds | Status | Cost |");
	lines.push("|---|------|--------|--------|------|");
	for (const step of report.steps) {
		const status = step.skipped ? "Skipped"
			: step.forceApproved ? "Force-approved"
			: step.approved ? "Approved"
			: step.iterations.length > 0 ? "Not approved"
			: "Not started";
		const cost = step.costTotal > 0 ? fmtCost(step.costTotal) : "—";
		lines.push(`| ${step.stepIndex + 1} | ${step.title} | ${step.totalRounds} | ${status} | ${cost} |`);
	}
	lines.push("");

	// Detailed per-step breakdown
	lines.push("## Step Details");
	for (const step of report.steps) {
		lines.push("");
		lines.push(`### Step ${step.stepIndex + 1}: ${step.title}`);

		if (step.skipped) {
			lines.push("*Skipped by user.*");
			continue;
		}

		if (step.iterations.length === 0) {
			lines.push("*Not started.*");
			continue;
		}

		if (step.costTotal > 0) {
			lines.push(`Cost: ${fmtCost(step.costTotal)} (${fmtTokens(step.costTokens)} tokens)`);
		}

		if (step.changedFiles.length > 0) {
			lines.push(`Changed files: ${step.changedFiles.join(", ")}`);
		}

		lines.push("");
		for (const iter of step.iterations) {
			const elapsed = iter.elapsedMs ? ` (${fmtDuration(iter.elapsedMs)})` : "";
			const gateTag = iter.gatesPassed ? "" : " ❌ gates failed";

			if (iter.skipped) {
				lines.push(`- **Round ${iter.iteration}:** Skipped`);
			} else if (iter.approved) {
				lines.push(`- **Round ${iter.iteration}:** Approved${elapsed}`);
			} else if (iter.forceApproved) {
				lines.push(`- **Round ${iter.iteration}:** Force-approved${elapsed}`);
			} else if (iter.verdict === "changes_requested" || iter.verdict === "changes_made") {
				lines.push(`- **Round ${iter.iteration}:** ${iter.verdict}${gateTag}${elapsed}`);
				for (const issue of iter.blockingIssues) {
					lines.push(`  - ${issue}`);
				}
			} else if (iter.verdict === "replan_needed") {
				lines.push(`- **Round ${iter.iteration}:** Escalated — replan needed${elapsed}`);
				for (const issue of iter.blockingIssues) {
					lines.push(`  - ${issue}`);
				}
			} else {
				lines.push(`- **Round ${iter.iteration}:** ${iter.verdict ?? "no verdict"}${gateTag}${elapsed}`);
			}
		}
	}

	// Observations section
	if (report.observations.total > 0) {
		lines.push("");
		lines.push("## Observations");
		lines.push("");
		lines.push(`${report.observations.total} observations logged by relay agents: ${report.observations.high} high, ${report.observations.medium} medium, ${report.observations.low} low.`);
		lines.push("");
		lines.push("Run `/duet-observations` for details.");
	}

	lines.push("");
	return lines.join("\n");
}
