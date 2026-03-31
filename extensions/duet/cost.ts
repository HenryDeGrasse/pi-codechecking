/**
 * Cost tracking for duet runs.
 *
 * Aggregates token usage and cost from child agent messages,
 * persists per-run cost data, and formats human-readable summaries.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import type { Message } from "@mariozechner/pi-ai";
import { runRoot, ensureDir, writeJson, readJson } from "./fs.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface AgentCostEntry {
	/** Which step this cost belongs to (0-indexed), or "planning" for plan phase. */
	phase: "planning" | number;
	/** Role: planner, critic, implementer, reviewer, relay-a, relay-b, etc. */
	role: string;
	/** Round/iteration within the phase. */
	round: number;
	/** Model key used. */
	model: string;
	/** Token counts. */
	inputTokens: number;
	outputTokens: number;
	cacheReadTokens: number;
	cacheWriteTokens: number;
	totalTokens: number;
	/** Cost in dollars. */
	costInput: number;
	costOutput: number;
	costCacheRead: number;
	costCacheWrite: number;
	costTotal: number;
	/** When this entry was recorded. */
	timestamp: string;
}

export interface RunCostSummary {
	entries: AgentCostEntry[];
	totalInputTokens: number;
	totalOutputTokens: number;
	totalCacheReadTokens: number;
	totalCacheWriteTokens: number;
	totalTokens: number;
	totalCost: number;
}

// ---------------------------------------------------------------------------
// Cost file path
// ---------------------------------------------------------------------------

function costFilePath(cwd: string, runId: string): string {
	return path.join(runRoot(cwd, runId), "cost.json");
}

// ---------------------------------------------------------------------------
// Extract usage from messages
// ---------------------------------------------------------------------------

/**
 * Extract aggregated usage/cost from an array of messages returned by `runSide`.
 * Each assistant message contains a `usage` object with token counts and costs.
 */
export function extractCostFromMessages(
	messages: Message[],
	phase: "planning" | number,
	role: string,
	round: number,
	model: string,
): AgentCostEntry {
	let inputTokens = 0;
	let outputTokens = 0;
	let cacheReadTokens = 0;
	let cacheWriteTokens = 0;
	let totalTokens = 0;
	let costInput = 0;
	let costOutput = 0;
	let costCacheRead = 0;
	let costCacheWrite = 0;
	let costTotal = 0;

	for (const msg of messages) {
		if (msg.role !== "assistant") continue;
		const usage = (msg as { usage?: { input?: number; output?: number; cacheRead?: number; cacheWrite?: number; totalTokens?: number; cost?: { input?: number; output?: number; cacheRead?: number; cacheWrite?: number; total?: number } } }).usage;
		if (!usage) continue;

		inputTokens += usage.input ?? 0;
		outputTokens += usage.output ?? 0;
		cacheReadTokens += usage.cacheRead ?? 0;
		cacheWriteTokens += usage.cacheWrite ?? 0;
		totalTokens += usage.totalTokens ?? 0;

		if (usage.cost) {
			costInput += usage.cost.input ?? 0;
			costOutput += usage.cost.output ?? 0;
			costCacheRead += usage.cost.cacheRead ?? 0;
			costCacheWrite += usage.cost.cacheWrite ?? 0;
			costTotal += usage.cost.total ?? 0;
		}
	}

	return {
		phase,
		role,
		round,
		model,
		inputTokens,
		outputTokens,
		cacheReadTokens,
		cacheWriteTokens,
		totalTokens,
		costInput,
		costOutput,
		costCacheRead,
		costCacheWrite,
		costTotal,
		timestamp: new Date().toISOString(),
	};
}

// ---------------------------------------------------------------------------
// Persistence
// ---------------------------------------------------------------------------

/** Append a cost entry to the run's cost.json file. */
export function appendCostEntry(cwd: string, runId: string, entry: AgentCostEntry): void {
	const filePath = costFilePath(cwd, runId);
	ensureDir(path.dirname(filePath));
	let entries: AgentCostEntry[] = [];
	try {
		const existing = readJson<{ entries: AgentCostEntry[] }>(filePath);
		if (existing?.entries) entries = existing.entries;
	} catch { /* fresh file */ }
	entries.push(entry);
	writeJson(filePath, { entries });
}

/** Load the full cost summary for a run. */
export function loadRunCostSummary(cwd: string, runId: string): RunCostSummary {
	const filePath = costFilePath(cwd, runId);
	let entries: AgentCostEntry[] = [];
	try {
		const existing = readJson<{ entries: AgentCostEntry[] }>(filePath);
		if (existing?.entries) entries = existing.entries;
	} catch { /* no cost data yet */ }

	let totalInputTokens = 0;
	let totalOutputTokens = 0;
	let totalCacheReadTokens = 0;
	let totalCacheWriteTokens = 0;
	let totalTokens = 0;
	let totalCost = 0;

	for (const e of entries) {
		totalInputTokens += e.inputTokens;
		totalOutputTokens += e.outputTokens;
		totalCacheReadTokens += e.cacheReadTokens;
		totalCacheWriteTokens += e.cacheWriteTokens;
		totalTokens += e.totalTokens;
		totalCost += e.costTotal;
	}

	return {
		entries,
		totalInputTokens,
		totalOutputTokens,
		totalCacheReadTokens,
		totalCacheWriteTokens,
		totalTokens,
		totalCost,
	};
}

// ---------------------------------------------------------------------------
// Formatting
// ---------------------------------------------------------------------------

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

/** One-line cost summary for status bar / notifications. */
export function formatCostOneLiner(summary: RunCostSummary): string {
	if (summary.entries.length === 0) return "";
	return `${fmtTokens(summary.totalTokens)} tokens · ${fmtCost(summary.totalCost)}`;
}

/** Detailed cost breakdown for reports. */
export function formatCostReport(summary: RunCostSummary): string {
	if (summary.entries.length === 0) return "No cost data recorded.";

	const lines = [
		"## Cost Summary",
		"",
		`Total tokens: ${fmtTokens(summary.totalTokens)} (${fmtTokens(summary.totalInputTokens)} in / ${fmtTokens(summary.totalOutputTokens)} out)`,
		`Cache: ${fmtTokens(summary.totalCacheReadTokens)} read / ${fmtTokens(summary.totalCacheWriteTokens)} write`,
		`Total cost: ${fmtCost(summary.totalCost)}`,
		"",
		"### Breakdown by phase",
		"",
	];

	// Group by phase
	const phases = new Map<string, AgentCostEntry[]>();
	for (const e of summary.entries) {
		const key = typeof e.phase === "number" ? `Step ${e.phase + 1}` : "Planning";
		if (!phases.has(key)) phases.set(key, []);
		phases.get(key)!.push(e);
	}

	for (const [phase, entries] of phases) {
		const phaseCost = entries.reduce((sum, e) => sum + e.costTotal, 0);
		const phaseTokens = entries.reduce((sum, e) => sum + e.totalTokens, 0);
		lines.push(`**${phase}**: ${fmtTokens(phaseTokens)} tokens · ${fmtCost(phaseCost)}`);
		for (const e of entries) {
			lines.push(`  ${e.role} r${e.round} (${e.model.split("/").pop()}): ${fmtTokens(e.totalTokens)} · ${fmtCost(e.costTotal)}`);
		}
		lines.push("");
	}

	return lines.join("\n");
}
