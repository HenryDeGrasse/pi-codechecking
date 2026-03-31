import { describe, it, beforeEach, afterEach } from "node:test";
import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { formatRunReportMarkdown, type RunReport } from "../run-report.js";

describe("formatRunReportMarkdown", () => {
	it("generates a well-structured report", () => {
		const report: RunReport = {
			runId: "2025-01-15T10-30-00-abc123",
			goal: "Add authentication",
			executionMode: "relay",
			totalSteps: 3,
			completedSteps: 2,
			skippedSteps: 1,
			totalRounds: 5,
			totalCost: 1.23,
			totalTokens: 150000,
			steps: [
				{
					stepIndex: 0,
					title: "Add auth schema",
					id: "step-1",
					iterations: [
						{ iteration: 1, approved: true, forceApproved: false, skipped: false, verdict: "approve", blockingIssues: [], gatesPassed: true, elapsedMs: 45000 },
					],
					totalRounds: 1,
					approved: true,
					skipped: false,
					forceApproved: false,
					changedFiles: ["src/db/schema.ts", "src/db/migrations/001.ts"],
					costTotal: 0.45,
					costTokens: 50000,
				},
				{
					stepIndex: 1,
					title: "Add auth middleware",
					id: "step-2",
					iterations: [
						{ iteration: 1, approved: false, forceApproved: false, skipped: false, verdict: "changes_requested", blockingIssues: ["Missing null check in token validation", "Error not propagated to middleware chain"], gatesPassed: false, elapsedMs: 60000 },
						{ iteration: 2, approved: false, forceApproved: false, skipped: false, verdict: "changes_requested", blockingIssues: ["Edge case with expired refresh tokens"], gatesPassed: true, elapsedMs: 45000 },
						{ iteration: 3, approved: true, forceApproved: false, skipped: false, verdict: "approve", blockingIssues: [], gatesPassed: true, elapsedMs: 30000 },
					],
					totalRounds: 3,
					approved: true,
					skipped: false,
					forceApproved: false,
					changedFiles: ["src/middleware/auth.ts", "src/middleware/auth.test.ts"],
					costTotal: 0.68,
					costTokens: 80000,
				},
				{
					stepIndex: 2,
					title: "Add login endpoint",
					id: "step-3",
					iterations: [
						{ iteration: 1, approved: false, forceApproved: false, skipped: true, verdict: undefined, blockingIssues: [], gatesPassed: true },
					],
					totalRounds: 1,
					approved: false,
					skipped: true,
					forceApproved: false,
					changedFiles: [],
					costTotal: 0,
					costTokens: 0,
				},
			],
			observations: { high: 1, medium: 2, low: 0, total: 3 },
		};

		const md = formatRunReportMarkdown(report);

		// Header section
		assert.ok(md.includes("# Duet Run Report"));
		assert.ok(md.includes("Add authentication"));
		assert.ok(md.includes("relay"));
		assert.ok(md.includes("2 completed, 1 skipped, 3 total"));
		assert.ok(md.includes("$1.23"));

		// Overview table
		assert.ok(md.includes("| # | Step | Rounds | Status | Cost |"));
		assert.ok(md.includes("Approved"));
		assert.ok(md.includes("Skipped"));

		// Step details
		assert.ok(md.includes("### Step 1: Add auth schema"));
		assert.ok(md.includes("Approved"));

		// Multi-round step with blocking issues
		assert.ok(md.includes("### Step 2: Add auth middleware"));
		assert.ok(md.includes("Missing null check in token validation"));
		assert.ok(md.includes("Edge case with expired refresh tokens"));
		assert.ok(md.includes("changes_requested"));

		// Skipped step
		assert.ok(md.includes("*Skipped by user.*"));

		// Timing
		assert.ok(md.includes("45s") || md.includes("1m"));
	});

	it("handles empty report", () => {
		const report: RunReport = {
			runId: "test",
			goal: "Test",
			executionMode: "relay",
			totalSteps: 0,
			completedSteps: 0,
			skippedSteps: 0,
			totalRounds: 0,
			totalCost: 0,
			totalTokens: 0,
			steps: [],
			observations: { high: 0, medium: 0, low: 0, total: 0 },
		};
		const md = formatRunReportMarkdown(report);
		assert.ok(md.includes("# Duet Run Report"));
		assert.ok(md.includes("0 completed"));
	});
});
