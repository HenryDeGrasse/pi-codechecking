/**
 * Observation log for relay agents.
 *
 * When Side B (or any reviewer round) notices something that is out of scope
 * for the current step but worth recording, it logs an observation instead of
 * drifting into unscoped edits. Observations are stored per-run (inside the
 * .pi/duet/runs/<runId>/ directory) so they never end up in the repo's git
 * history.
 *
 * Observations can be surfaced in:
 * - `/duet-observations` command
 * - Post-run report
 * - Future step prompts (so a later step can address a high-severity item)
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { runRoot, ensureDir } from "./fs.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type ObservationSeverity = "low" | "medium" | "high";

export interface Observation {
	/** When the observation was recorded. */
	timestamp: string;
	/** Plan step index (0-based). */
	stepIndex: number;
	/** Relay round that produced this observation. */
	round: number;
	/** Which agent logged it (e.g. "relay-a", "relay-b"). */
	agent: string;
	/** Severity — high = probable future bug, medium = notable, low = nit/style. */
	severity: ObservationSeverity;
	/** File path (relative to repo root) the observation concerns, if any. */
	file?: string;
	/** Free-form description of what was noticed. */
	note: string;
}

// ---------------------------------------------------------------------------
// Persistence  (.pi/duet/runs/<runId>/observations.jsonl)
// ---------------------------------------------------------------------------

function observationsPath(cwd: string, runId: string): string {
	return path.join(runRoot(cwd, runId), "observations.jsonl");
}

/** Append one observation to the run's log. */
export function appendObservation(cwd: string, runId: string, obs: Observation): void {
	const filePath = observationsPath(cwd, runId);
	ensureDir(path.dirname(filePath));
	fs.appendFileSync(filePath, JSON.stringify(obs) + "\n", "utf8");
}

/** Append many observations at once (e.g. parsed from agent output). */
export function appendObservations(cwd: string, runId: string, entries: Observation[]): void {
	if (entries.length === 0) return;
	const filePath = observationsPath(cwd, runId);
	ensureDir(path.dirname(filePath));
	const blob = entries.map((o) => JSON.stringify(o)).join("\n") + "\n";
	fs.appendFileSync(filePath, blob, "utf8");
}

/** Load all observations for a run. */
export function loadObservations(cwd: string, runId: string): Observation[] {
	const filePath = observationsPath(cwd, runId);
	if (!fs.existsSync(filePath)) return [];
	try {
		return fs
			.readFileSync(filePath, "utf8")
			.trim()
			.split("\n")
			.filter(Boolean)
			.map((line) => JSON.parse(line) as Observation);
	} catch {
		return [];
	}
}

/** Load observations for a specific step. */
export function loadStepObservations(cwd: string, runId: string, stepIndex: number): Observation[] {
	return loadObservations(cwd, runId).filter((o) => o.stepIndex === stepIndex);
}

// ---------------------------------------------------------------------------
// Parsing  (extract observations from agent output text)
// ---------------------------------------------------------------------------

/**
 * Extract structured observations from an agent's response text.
 *
 * The agent is prompted to emit observations in a fenced block:
 *
 * ```observations
 * - [high] path/to/file.tsx: Description of the issue
 * - [medium] Another note without a file path
 * - [low] path/to/other.css: Cosmetic nit
 * ```
 *
 * Returns parsed observations with metadata filled in from the caller.
 */
export function parseObservationsFromText(
	text: string,
	stepIndex: number,
	round: number,
	agent: string,
): Observation[] {
	const results: Observation[] = [];
	const now = new Date().toISOString();

	// Match fenced observation blocks
	const blockRegex = /```observations\s*\n([\s\S]*?)```/gi;
	let blockMatch: RegExpExecArray | null;
	while ((blockMatch = blockRegex.exec(text)) !== null) {
		const block = blockMatch[1];
		const lines = block.split("\n").map((l) => l.trim()).filter(Boolean);

		for (const line of lines) {
			const parsed = parseObservationLine(line);
			if (parsed) {
				results.push({
					timestamp: now,
					stepIndex,
					round,
					agent,
					...parsed,
				});
			}
		}
	}

	return results;
}

/**
 * Parse a single observation line like:
 *   - [high] path/to/file.tsx: Description
 *   - [medium] Description without file
 */
function parseObservationLine(line: string): { severity: ObservationSeverity; file?: string; note: string } | null {
	// Strip leading "- " or "* "
	const stripped = line.replace(/^[-*]\s*/, "");

	// Match severity tag
	const sevMatch = stripped.match(/^\[(low|medium|high)\]\s*/i);
	if (!sevMatch) return null;

	const severity = sevMatch[1].toLowerCase() as ObservationSeverity;
	const rest = stripped.slice(sevMatch[0].length).trim();
	if (!rest) return null;

	// Try to split "file/path.ext: description"
	const colonIdx = rest.indexOf(": ");
	if (colonIdx > 0) {
		const maybePath = rest.slice(0, colonIdx);
		// Heuristic: looks like a file path if it contains a dot or slash
		if (/[./]/.test(maybePath) && !maybePath.includes("  ")) {
			return { severity, file: maybePath, note: rest.slice(colonIdx + 2).trim() };
		}
	}

	return { severity, note: rest };
}

// ---------------------------------------------------------------------------
// Formatting
// ---------------------------------------------------------------------------

const SEV_LABELS: Record<ObservationSeverity, string> = {
	high: "HIGH",
	medium: "MED",
	low: "LOW",
};

/** Format a single observation for display. */
export function formatObservation(obs: Observation): string {
	const sev = SEV_LABELS[obs.severity];
	const loc = obs.file ? ` ${obs.file}` : "";
	return `[${sev}]${loc}: ${obs.note}`;
}

/** Format all observations for a run as a readable report. */
export function formatObservationsReport(observations: Observation[]): string {
	if (observations.length === 0) return "No observations recorded.";

	const lines: string[] = [`Observations (${observations.length} total)`, ""];

	// Group by step
	const byStep = new Map<number, Observation[]>();
	for (const obs of observations) {
		const list = byStep.get(obs.stepIndex) ?? [];
		list.push(obs);
		byStep.set(obs.stepIndex, list);
	}

	for (const [stepIdx, stepObs] of [...byStep.entries()].sort((a, b) => a[0] - b[0])) {
		lines.push(`Step ${stepIdx + 1}:`);
		// Sort by severity: high first
		const sevOrder: Record<ObservationSeverity, number> = { high: 0, medium: 1, low: 2 };
		const sorted = [...stepObs].sort((a, b) => sevOrder[a.severity] - sevOrder[b.severity]);
		for (const obs of sorted) {
			lines.push(`  ${formatObservation(obs)}  (round ${obs.round}, ${obs.agent})`);
		}
		lines.push("");
	}

	const highCount = observations.filter((o) => o.severity === "high").length;
	const medCount = observations.filter((o) => o.severity === "medium").length;
	const lowCount = observations.filter((o) => o.severity === "low").length;
	lines.push(`Summary: ${highCount} high, ${medCount} medium, ${lowCount} low`);

	return lines.join("\n");
}

/** One-liner for status display. */
export function formatObservationsOneLiner(observations: Observation[]): string {
	if (observations.length === 0) return "";
	const highCount = observations.filter((o) => o.severity === "high").length;
	const medCount = observations.filter((o) => o.severity === "medium").length;
	const lowCount = observations.filter((o) => o.severity === "low").length;
	const parts: string[] = [];
	if (highCount) parts.push(`${highCount} high`);
	if (medCount) parts.push(`${medCount} med`);
	if (lowCount) parts.push(`${lowCount} low`);
	return `${observations.length} observations (${parts.join(", ")})`;
}

/**
 * Build a prompt snippet that feeds relevant prior observations into a future
 * step so the agent can address high-severity items if they're in scope.
 */
export function observationsContextForStep(cwd: string, runId: string, stepIndex: number): string {
	const all = loadObservations(cwd, runId);
	// Only surface high/medium observations from previous steps
	const relevant = all.filter(
		(o) => o.stepIndex < stepIndex && (o.severity === "high" || o.severity === "medium"),
	);
	if (relevant.length === 0) return "";

	const lines = [
		"Prior observations from earlier steps (address if they fall within this step's scope):",
	];
	for (const obs of relevant) {
		lines.push(`- [${obs.severity.toUpperCase()}] step ${obs.stepIndex + 1}${obs.file ? ` ${obs.file}` : ""}: ${obs.note}`);
	}
	return lines.join("\n");
}
