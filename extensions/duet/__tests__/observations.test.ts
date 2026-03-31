import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import {
	parseObservationsFromText,
	appendObservation,
	appendObservations,
	loadObservations,
	loadStepObservations,
	formatObservationsReport,
	formatObservationsOneLiner,
	formatObservation,
	observationsContextForStep,
	type Observation,
} from "../observations.js";

// ---------------------------------------------------------------------------
// Temp dir helpers
// ---------------------------------------------------------------------------

let tmpDir: string;
const RUN_ID = "2026-01-01T00-00-00-000Z-test1234";

function runDir() {
	return path.join(tmpDir, ".pi", "duet", "runs", RUN_ID);
}

beforeEach(() => {
	tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "obs-test-"));
	fs.mkdirSync(runDir(), { recursive: true });
});

afterEach(() => {
	fs.rmSync(tmpDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// parseObservationsFromText
// ---------------------------------------------------------------------------

describe("parseObservationsFromText", () => {
	it("extracts observations from a fenced block", () => {
		const text = [
			"Everything looks good. Approving.",
			"",
			"Verdict: approve",
			"",
			"```observations",
			"- [high] src/api/auth.ts: Missing null check on token refresh response",
			"- [medium] src/utils/format.ts: Date formatter does not handle timezone offsets",
			"- [low] src/components/Header.tsx: Comment references old brand name",
			"```",
		].join("\n");

		const obs = parseObservationsFromText(text, 2, 2, "relay-b");
		assert.equal(obs.length, 3);

		assert.equal(obs[0].severity, "high");
		assert.equal(obs[0].file, "src/api/auth.ts");
		assert.equal(obs[0].note, "Missing null check on token refresh response");
		assert.equal(obs[0].stepIndex, 2);
		assert.equal(obs[0].round, 2);
		assert.equal(obs[0].agent, "relay-b");

		assert.equal(obs[1].severity, "medium");
		assert.equal(obs[1].file, "src/utils/format.ts");

		assert.equal(obs[2].severity, "low");
		assert.equal(obs[2].file, "src/components/Header.tsx");
	});

	it("handles observations without file paths", () => {
		const text = [
			"```observations",
			"- [medium] The API error handling pattern is inconsistent across services",
			"```",
		].join("\n");

		const obs = parseObservationsFromText(text, 0, 1, "relay-a");
		assert.equal(obs.length, 1);
		assert.equal(obs[0].severity, "medium");
		assert.equal(obs[0].file, undefined);
		assert.equal(obs[0].note, "The API error handling pattern is inconsistent across services");
	});

	it("returns empty array when no observation block exists", () => {
		const text = "Verdict: approve\nAll good.";
		const obs = parseObservationsFromText(text, 0, 1, "relay-a");
		assert.equal(obs.length, 0);
	});

	it("handles multiple observation blocks", () => {
		const text = [
			"```observations",
			"- [high] src/a.ts: Bug A",
			"```",
			"Some text in between",
			"```observations",
			"- [low] src/b.ts: Nit B",
			"```",
		].join("\n");

		const obs = parseObservationsFromText(text, 1, 3, "relay-b");
		assert.equal(obs.length, 2);
		assert.equal(obs[0].severity, "high");
		assert.equal(obs[1].severity, "low");
	});

	it("ignores malformed lines in observation blocks", () => {
		const text = [
			"```observations",
			"- [high] src/a.ts: Valid observation",
			"- This line has no severity tag",
			"- [] Empty severity",
			"- [high]",
			"```",
		].join("\n");

		const obs = parseObservationsFromText(text, 0, 1, "relay-a");
		assert.equal(obs.length, 1);
		assert.equal(obs[0].severity, "high");
	});
});

// ---------------------------------------------------------------------------
// Persistence
// ---------------------------------------------------------------------------

describe("appendObservation / loadObservations", () => {
	it("appends and loads single observation", () => {
		const obs: Observation = {
			timestamp: "2026-01-01T00:00:00.000Z",
			stepIndex: 0,
			round: 2,
			agent: "relay-b",
			severity: "high",
			file: "src/index.ts",
			note: "Missing error handler",
		};
		appendObservation(tmpDir, RUN_ID, obs);
		const loaded = loadObservations(tmpDir, RUN_ID);
		assert.equal(loaded.length, 1);
		assert.equal(loaded[0].severity, "high");
		assert.equal(loaded[0].file, "src/index.ts");
	});

	it("appendObservations writes multiple at once", () => {
		const entries: Observation[] = [
			{ timestamp: "t1", stepIndex: 0, round: 1, agent: "relay-a", severity: "low", note: "Nit A" },
			{ timestamp: "t2", stepIndex: 0, round: 2, agent: "relay-b", severity: "medium", note: "Note B" },
		];
		appendObservations(tmpDir, RUN_ID, entries);
		const loaded = loadObservations(tmpDir, RUN_ID);
		assert.equal(loaded.length, 2);
	});

	it("returns empty array when file does not exist", () => {
		const loaded = loadObservations(tmpDir, "nonexistent-run");
		assert.equal(loaded.length, 0);
	});
});

describe("loadStepObservations", () => {
	it("filters by step index", () => {
		appendObservations(tmpDir, RUN_ID, [
			{ timestamp: "t1", stepIndex: 0, round: 1, agent: "relay-a", severity: "high", note: "Step 0 obs" },
			{ timestamp: "t2", stepIndex: 1, round: 2, agent: "relay-b", severity: "low", note: "Step 1 obs" },
			{ timestamp: "t3", stepIndex: 0, round: 3, agent: "relay-a", severity: "medium", note: "Step 0 obs 2" },
		]);
		const step0 = loadStepObservations(tmpDir, RUN_ID, 0);
		assert.equal(step0.length, 2);
		const step1 = loadStepObservations(tmpDir, RUN_ID, 1);
		assert.equal(step1.length, 1);
	});
});

// ---------------------------------------------------------------------------
// Formatting
// ---------------------------------------------------------------------------

describe("formatObservation", () => {
	it("formats with file path", () => {
		const s = formatObservation({
			timestamp: "t", stepIndex: 0, round: 1, agent: "relay-a",
			severity: "high", file: "src/a.ts", note: "Bug found",
		});
		assert.equal(s, "[HIGH] src/a.ts: Bug found");
	});

	it("formats without file path", () => {
		const s = formatObservation({
			timestamp: "t", stepIndex: 0, round: 1, agent: "relay-a",
			severity: "low", note: "General nit",
		});
		assert.equal(s, "[LOW]: General nit");
	});
});

describe("formatObservationsReport", () => {
	it("returns message for empty observations", () => {
		const r = formatObservationsReport([]);
		assert.equal(r, "No observations recorded.");
	});

	it("groups by step and sorts by severity", () => {
		const obs: Observation[] = [
			{ timestamp: "t1", stepIndex: 0, round: 1, agent: "relay-a", severity: "low", note: "Low" },
			{ timestamp: "t2", stepIndex: 0, round: 2, agent: "relay-b", severity: "high", note: "High" },
			{ timestamp: "t3", stepIndex: 1, round: 1, agent: "relay-a", severity: "medium", note: "Med" },
		];
		const r = formatObservationsReport(obs);
		assert.ok(r.includes("Step 1:"));
		assert.ok(r.includes("Step 2:"));
		assert.ok(r.includes("1 high, 1 medium, 1 low"));
		// High should come before low in step 1
		const step1Section = r.slice(r.indexOf("Step 1:"), r.indexOf("Step 2:"));
		assert.ok(step1Section.indexOf("HIGH") < step1Section.indexOf("LOW"));
	});
});

describe("formatObservationsOneLiner", () => {
	it("returns empty for no observations", () => {
		assert.equal(formatObservationsOneLiner([]), "");
	});

	it("formats counts correctly", () => {
		const obs: Observation[] = [
			{ timestamp: "t", stepIndex: 0, round: 1, agent: "a", severity: "high", note: "a" },
			{ timestamp: "t", stepIndex: 0, round: 1, agent: "a", severity: "high", note: "b" },
			{ timestamp: "t", stepIndex: 0, round: 1, agent: "a", severity: "low", note: "c" },
		];
		const s = formatObservationsOneLiner(obs);
		assert.equal(s, "3 observations (2 high, 1 low)");
	});
});

// ---------------------------------------------------------------------------
// observationsContextForStep
// ---------------------------------------------------------------------------

describe("observationsContextForStep", () => {
	it("returns empty when no prior observations", () => {
		const ctx = observationsContextForStep(tmpDir, RUN_ID, 0);
		assert.equal(ctx, "");
	});

	it("includes high/medium from earlier steps only", () => {
		appendObservations(tmpDir, RUN_ID, [
			{ timestamp: "t1", stepIndex: 0, round: 2, agent: "relay-b", severity: "high", file: "src/a.ts", note: "Critical bug" },
			{ timestamp: "t2", stepIndex: 0, round: 2, agent: "relay-b", severity: "low", note: "Nit" },
			{ timestamp: "t3", stepIndex: 1, round: 1, agent: "relay-a", severity: "medium", note: "Medium concern" },
			{ timestamp: "t4", stepIndex: 2, round: 1, agent: "relay-a", severity: "high", note: "Future step obs" },
		]);

		// Step 2 should see step 0 high + step 1 medium, but not step 0 low or step 2 obs
		const ctx = observationsContextForStep(tmpDir, RUN_ID, 2);
		assert.ok(ctx.includes("Critical bug"));
		assert.ok(ctx.includes("Medium concern"));
		assert.ok(!ctx.includes("Nit"));
		assert.ok(!ctx.includes("Future step obs"));
	});
});
