import { describe, it } from "node:test";
import * as assert from "node:assert/strict";
import {
	implementationPrompt,
	reviewPrompt,
	relayPrompt,
	previousStepContext,
	planPrompt,
	withOperatorNotes,
	withExecutionResumeContext,
	withPendingInterventions,
	humanPlanFeedbackReview,
	formatPlanPreviewLines,
	withRunHandoff,
} from "../prompts.js";
import type { PlanDraft, ReviewReport, InterventionEntry, GateEvidence } from "../types.js";
import type { GateRunResult } from "../prompts.js";

const SAMPLE_PLAN: PlanDraft = {
	goal: "Add authentication",
	steps: [
		{ id: "step-1", title: "Add auth schema", description: "Create DB tables", requiredChecks: ["test"] },
		{ id: "step-2", title: "Add auth middleware", description: "Express middleware", requiredChecks: ["test", "lint"] },
		{ id: "step-3", title: "Add login endpoint", description: "POST /login", requiredChecks: ["test"] },
	],
};

describe("implementationPrompt", () => {
	it("includes plan overview and step details", () => {
		const prompt = implementationPrompt(SAMPLE_PLAN, 0);
		assert.ok(prompt.includes("Plan overview:"));
		assert.ok(prompt.includes("Add auth schema"));
		assert.ok(prompt.includes("Implement step 1"));
	});

	it("includes step transition context when provided", () => {
		const context = "Previous step completed. Files changed: src/db.ts";
		const prompt = implementationPrompt(SAMPLE_PLAN, 1, undefined, context);
		assert.ok(prompt.includes("Previous step completed"));
		assert.ok(prompt.includes("src/db.ts"));
	});

	it("omits step transition context when undefined", () => {
		const prompt = implementationPrompt(SAMPLE_PLAN, 0);
		assert.ok(!prompt.includes("Previous step"));
	});

	it("includes reviewer feedback when provided", () => {
		const review: ReviewReport = {
			stepId: "step-1",
			verdict: "changes_requested",
			blockingIssues: ["Missing null check in auth handler"],
		};
		const prompt = implementationPrompt(SAMPLE_PLAN, 0, review);
		assert.ok(prompt.includes("Missing null check in auth handler"));
		assert.ok(prompt.includes("reviewer found these issues"));
	});
});

describe("relayPrompt", () => {
	it("identifies first round correctly", () => {
		const prompt = relayPrompt(SAMPLE_PLAN, 0, 1, undefined, undefined);
		assert.ok(prompt.includes("first agent to work on this step"));
		assert.ok(prompt.includes("Be thorough"));
	});

	it("identifies subsequent rounds with previous text", () => {
		const prompt = relayPrompt(SAMPLE_PLAN, 0, 2, "I added the schema migration", undefined);
		assert.ok(prompt.includes("relay round 2"));
		assert.ok(prompt.includes("I added the schema migration"));
	});

	it("includes step transition context for persistent sessions", () => {
		const context = "Step 1 done. Changed: src/db.ts";
		const prompt = relayPrompt(SAMPLE_PLAN, 1, 1, undefined, undefined, context);
		assert.ok(prompt.includes("Step 1 done"));
	});
});

describe("previousStepContext", () => {
	it("returns undefined for step 0", () => {
		assert.strictEqual(previousStepContext(SAMPLE_PLAN, 0, "/tmp", "run-1"), undefined);
	});

	it("returns undefined for negative step index", () => {
		assert.strictEqual(previousStepContext(SAMPLE_PLAN, -1, "/tmp", "run-1"), undefined);
	});

	it("includes previous step title for step > 0", () => {
		// No artifacts on disk, but should still mention the step
		const result = previousStepContext(SAMPLE_PLAN, 1, "/tmp/nonexistent", "run-1");
		assert.ok(result !== undefined);
		assert.ok(result!.includes("Add auth schema"));
		assert.ok(result!.includes("has been completed and approved"));
	});
});

describe("planPrompt", () => {
	const config = {
		sideA: { label: "A", model: "a/model", thinking: "off" as const },
		sideB: { label: "B", model: "b/model", thinking: "off" as const },
		executionMode: "relay" as const,
		startImplementer: "A" as const,
		maxPlanRounds: 10,
		maxExecutionRounds: 10,
		alternateByStep: true,
		checks: { test: { cmd: "npm test", timeoutSec: 600 } },
		repo: { requireGit: true, requireCleanStart: false, enforceCleanAfterStep: false, captureDiffCheck: true, commitPerStep: true },
		persistSessionAcrossSteps: true,
	};

	it("includes goal and schema for initial round", () => {
		const prompt = planPrompt("Add auth", config, ".pi/duet/runs/x/draft-plan.json");
		assert.ok(prompt.includes("Add auth"));
		assert.ok(prompt.includes("draft-plan.json"));
		assert.ok(prompt.includes("requiredChecks"));
	});

	it("includes critique for revision rounds", () => {
		const review = { verdict: "changes_requested" as const, blockingIssues: ["Missing step for migrations"] };
		const prompt = planPrompt("Add auth", config, ".pi/duet/runs/x/draft-plan.json", review);
		assert.ok(prompt.includes("Missing step for migrations"));
		assert.ok(prompt.includes("address the critique"));
	});
});

describe("withOperatorNotes", () => {
	it("returns prompt unchanged when no notes", () => {
		assert.strictEqual(withOperatorNotes("do stuff", undefined), "do stuff");
		assert.strictEqual(withOperatorNotes("do stuff", ""), "do stuff");
		assert.strictEqual(withOperatorNotes("do stuff", "   "), "do stuff");
	});

	it("prepends notes to prompt", () => {
		const result = withOperatorNotes("do stuff", "Focus on error handling");
		assert.ok(result.includes("Focus on error handling"));
		assert.ok(result.includes("do stuff"));
		assert.ok(result.indexOf("Focus on error handling") < result.indexOf("do stuff"));
	});
});

describe("withExecutionResumeContext", () => {
	it("returns prompt unchanged when not resumed", () => {
		assert.strictEqual(withExecutionResumeContext("do stuff", false), "do stuff");
	});

	it("prepends resume notice when resumed", () => {
		const result = withExecutionResumeContext("do stuff", true);
		assert.ok(result.includes("Execution resume notice"));
		assert.ok(result.includes("do stuff"));
	});
});

describe("withPendingInterventions", () => {
	it("returns prompt unchanged with no interventions", () => {
		assert.strictEqual(withPendingInterventions("do stuff", []), "do stuff");
	});

	it("prepends interventions", () => {
		const interventions: InterventionEntry[] = [
			{
				id: "1",
				timestamp: new Date().toISOString(),
				target: { childId: "A-implementer", side: "A", role: "implementer", intent: "steer" },
				content: "Focus on the auth module",
			},
		];
		const result = withPendingInterventions("do stuff", interventions);
		assert.ok(result.includes("Focus on the auth module"));
		assert.ok(result.includes("Operator steer"));
	});
});

describe("humanPlanFeedbackReview", () => {
	it("creates a changes_requested review with the note", () => {
		const review = humanPlanFeedbackReview("Add error handling step");
		assert.strictEqual(review.verdict, "changes_requested");
		assert.strictEqual(review.blockingIssues.length, 1);
		assert.ok(review.blockingIssues[0].includes("Add error handling step"));
	});
});

describe("formatPlanPreviewLines", () => {
	it("shows all steps when under max", () => {
		const lines = formatPlanPreviewLines(SAMPLE_PLAN);
		assert.ok(lines.some((l) => l.includes("Add auth schema")));
		assert.ok(lines.some((l) => l.includes("Add login endpoint")));
		assert.strictEqual(lines.filter((l) => l.includes("more step")).length, 0);
	});

	it("truncates when over max", () => {
		const lines = formatPlanPreviewLines(SAMPLE_PLAN, "Preview", 2);
		assert.ok(lines.some((l) => l.includes("1 more step")));
	});
});

describe("withRunHandoff", () => {
	it("returns prompt unchanged with no handoff", () => {
		assert.strictEqual(withRunHandoff("do stuff", undefined), "do stuff");
	});

	it("prepends handoff content with correct heading", () => {
		const result = withRunHandoff("do stuff", { mode: "summary", content: "User wants auth" });
		assert.ok(result.includes("Parent conversation handoff summary:"));
		assert.ok(result.includes("User wants auth"));
		assert.ok(result.includes("do stuff"));
	});
});
