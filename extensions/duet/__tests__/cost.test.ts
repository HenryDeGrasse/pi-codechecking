import { describe, it } from "node:test";
import * as assert from "node:assert/strict";
import {
	extractCostFromMessages,
	formatCostOneLiner,
	formatCostReport,
	type RunCostSummary,
	type AgentCostEntry,
} from "../cost.js";

function makeAssistantMessage(usage: {
	input?: number;
	output?: number;
	cacheRead?: number;
	cacheWrite?: number;
	totalTokens?: number;
	cost?: { input?: number; output?: number; cacheRead?: number; cacheWrite?: number; total?: number };
}): any {
	return {
		role: "assistant",
		content: [{ type: "text", text: "hello" }],
		api: "anthropic",
		provider: "anthropic",
		model: "claude-sonnet-4-5",
		usage: {
			input: usage.input ?? 0,
			output: usage.output ?? 0,
			cacheRead: usage.cacheRead ?? 0,
			cacheWrite: usage.cacheWrite ?? 0,
			totalTokens: usage.totalTokens ?? 0,
			cost: {
				input: usage.cost?.input ?? 0,
				output: usage.cost?.output ?? 0,
				cacheRead: usage.cost?.cacheRead ?? 0,
				cacheWrite: usage.cost?.cacheWrite ?? 0,
				total: usage.cost?.total ?? 0,
			},
		},
		stopReason: "stop",
		timestamp: Date.now(),
	};
}

describe("extractCostFromMessages", () => {
	it("sums usage across multiple messages", () => {
		const messages = [
			makeAssistantMessage({ input: 100, output: 50, totalTokens: 150, cost: { total: 0.01 } }),
			makeAssistantMessage({ input: 200, output: 100, totalTokens: 300, cost: { total: 0.02 } }),
		];
		const entry = extractCostFromMessages(messages, 0, "implementer", 1, "test/model");
		assert.strictEqual(entry.inputTokens, 300);
		assert.strictEqual(entry.outputTokens, 150);
		assert.strictEqual(entry.totalTokens, 450);
		assert.strictEqual(entry.costTotal, 0.03);
		assert.strictEqual(entry.phase, 0);
		assert.strictEqual(entry.role, "implementer");
		assert.strictEqual(entry.round, 1);
	});

	it("handles empty message array", () => {
		const entry = extractCostFromMessages([], "planning", "planner", 1, "test/model");
		assert.strictEqual(entry.totalTokens, 0);
		assert.strictEqual(entry.costTotal, 0);
	});

	it("skips non-assistant messages", () => {
		const messages = [
			{ role: "user", content: "hello", timestamp: Date.now() } as any,
			makeAssistantMessage({ input: 100, output: 50, totalTokens: 150, cost: { total: 0.01 } }),
		];
		const entry = extractCostFromMessages(messages, 0, "reviewer", 2, "test/model");
		assert.strictEqual(entry.totalTokens, 150);
		assert.strictEqual(entry.costTotal, 0.01);
	});

	it("handles messages without usage field", () => {
		const messages = [
			{ role: "assistant", content: [{ type: "text", text: "hi" }], timestamp: Date.now() } as any,
		];
		const entry = extractCostFromMessages(messages, 0, "relay-a", 1, "test/model");
		assert.strictEqual(entry.totalTokens, 0);
	});
});

describe("formatCostOneLiner", () => {
	it("returns empty string for no entries", () => {
		const summary: RunCostSummary = {
			entries: [],
			totalInputTokens: 0, totalOutputTokens: 0,
			totalCacheReadTokens: 0, totalCacheWriteTokens: 0,
			totalTokens: 0, totalCost: 0,
		};
		assert.strictEqual(formatCostOneLiner(summary), "");
	});

	it("formats tokens and cost", () => {
		const summary: RunCostSummary = {
			entries: [{ phase: 0, role: "implementer", round: 1, model: "m", inputTokens: 1000, outputTokens: 500, cacheReadTokens: 0, cacheWriteTokens: 0, totalTokens: 1500, costInput: 0, costOutput: 0, costCacheRead: 0, costCacheWrite: 0, costTotal: 0.15, timestamp: "" }],
			totalInputTokens: 1000, totalOutputTokens: 500,
			totalCacheReadTokens: 0, totalCacheWriteTokens: 0,
			totalTokens: 1500, totalCost: 0.15,
		};
		const line = formatCostOneLiner(summary);
		assert.ok(line.includes("1.5k"));
		assert.ok(line.includes("$0.150"));
	});
});

describe("formatCostReport", () => {
	it("reports no data for empty entries", () => {
		const summary: RunCostSummary = {
			entries: [],
			totalInputTokens: 0, totalOutputTokens: 0,
			totalCacheReadTokens: 0, totalCacheWriteTokens: 0,
			totalTokens: 0, totalCost: 0,
		};
		assert.ok(formatCostReport(summary).includes("No cost data"));
	});

	it("groups by phase", () => {
		const entries: AgentCostEntry[] = [
			{ phase: "planning", role: "planner", round: 1, model: "m", inputTokens: 100, outputTokens: 50, cacheReadTokens: 0, cacheWriteTokens: 0, totalTokens: 150, costInput: 0, costOutput: 0, costCacheRead: 0, costCacheWrite: 0, costTotal: 0.01, timestamp: "" },
			{ phase: 0, role: "implementer", round: 1, model: "m", inputTokens: 200, outputTokens: 100, cacheReadTokens: 0, cacheWriteTokens: 0, totalTokens: 300, costInput: 0, costOutput: 0, costCacheRead: 0, costCacheWrite: 0, costTotal: 0.02, timestamp: "" },
		];
		const summary: RunCostSummary = {
			entries,
			totalInputTokens: 300, totalOutputTokens: 150,
			totalCacheReadTokens: 0, totalCacheWriteTokens: 0,
			totalTokens: 450, totalCost: 0.03,
		};
		const report = formatCostReport(summary);
		assert.ok(report.includes("Planning"));
		assert.ok(report.includes("Step 1"));
		assert.ok(report.includes("planner"));
		assert.ok(report.includes("implementer"));
	});
});
