import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { DEFAULT_CONFIG, type DuetConfig, type DuetState, type InterventionEntry, getConfigPath, validateConfig } from "./types.js";

export function ensureDir(dir: string): void {
	fs.mkdirSync(dir, { recursive: true });
}

export function duetRoot(cwd: string): string {
	return path.join(cwd, ".pi", "duet");
}

export function runsRoot(cwd: string): string {
	return path.join(duetRoot(cwd), "runs");
}

export function runRoot(cwd: string, runId: string): string {
	return path.join(runsRoot(cwd), runId);
}

export function deleteRunRoot(cwd: string, runId: string): void {
	fs.rmSync(runRoot(cwd, runId), { recursive: true, force: true });
}

export function writeJson(filePath: string, value: unknown): void {
	ensureDir(path.dirname(filePath));
	fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

export function writeText(filePath: string, value: string): void {
	ensureDir(path.dirname(filePath));
	fs.writeFileSync(filePath, value, "utf8");
}

export function readJson<T>(filePath: string): T | undefined {
	if (!fs.existsSync(filePath)) return undefined;
	const raw = fs.readFileSync(filePath, "utf8");
	return JSON.parse(raw) as T;
}

export function loadConfig(cwd: string): DuetConfig | undefined {
	const configPath = getConfigPath(cwd);
	if (!fs.existsSync(configPath)) return undefined;
	const raw = JSON.parse(fs.readFileSync(configPath, "utf8")) as unknown;
	const validated = validateConfig(raw);
	if (!validated.ok) {
		throw new Error(`Invalid duet config at ${configPath}: ${validated.error}`);
	}
	return validated.value;
}

export function saveConfig(cwd: string, config: DuetConfig): string {
	const configPath = getConfigPath(cwd);
	writeJson(configPath, config);
	return configPath;
}

export function defaultConfigText(): string {
	return `${JSON.stringify(DEFAULT_CONFIG, null, 2)}\n`;
}

export function generateRunId(): string {
	return `${new Date().toISOString().replace(/[:.]/g, "-")}-${crypto.randomUUID().slice(0, 8)}`;
}

export function writeRunStateSnapshot(cwd: string, state: DuetState): void {
	if (!state.runId) return;
	writeJson(path.join(runRoot(cwd, state.runId), "state.json"), state);
}

/**
 * Read the most recent run's state.json from disk (for crash recovery / resume).
 * Returns the latest non-idle, non-completed run — including aborted runs that
 * have progress (a plan). The caller decides whether to offer resume.
 */
export function loadLatestRunState(cwd: string): DuetState | undefined {
	const runs = runsRoot(cwd);
	if (!fs.existsSync(runs)) return undefined;
	// Run IDs are ISO-ish timestamps — lexicographic sort gives newest last
	const dirs = fs.readdirSync(runs).sort();
	for (let i = dirs.length - 1; i >= 0; i--) {
		const statePath = path.join(runs, dirs[i], "state.json");
		const s = readJson<DuetState>(statePath);
		if (!s || !s.phase || s.phase === "idle" || s.phase === "completed") continue;
		return s;
	}
	return undefined;
}

/**
 * Per-role session directory for a given step. Each role gets its own session
 * so context stays focused (no cross-role noise). Pi's auto-compaction handles
 * context overflow automatically.
 */
export function roleSessionDir(cwd: string, runId: string, stepIndex: number, role: string): string {
	return path.join(runRoot(cwd, runId), "sessions", `step-${stepIndex + 1}`, role);
}

/**
 * Continuous session directory for a role — shared across all steps.
 * Used when `persistSessionAcrossSteps` is true so the agent keeps context
 * between steps (pi's auto-compaction handles overflow).
 */
export function continuousSessionDir(cwd: string, runId: string, role: string): string {
	return path.join(runRoot(cwd, runId), "sessions", "continuous", role);
}

export function planningRoleSessionDir(cwd: string, runId: string, role: string): string {
	return path.join(runRoot(cwd, runId), "sessions", "planning", role);
}

export function helperSessionDir(cwd: string, runId: string, name: string): string {
	return path.join(runRoot(cwd, runId), "sessions", "helpers", name);
}

export function planningRoundDir(cwd: string, runId: string, round: number): string {
	return path.join(runRoot(cwd, runId), "planning", `round-${round}`);
}

export function stepIterationDir(cwd: string, runId: string, stepIndex: number, iteration: number): string {
	return path.join(runRoot(cwd, runId), "steps", String(stepIndex + 1), `iteration-${iteration}`);
}

export function escalationDir(cwd: string, runId: string, stepIndex: number, escalationIndex: number): string {
	return path.join(runRoot(cwd, runId), "steps", String(stepIndex + 1), `escalation-${escalationIndex}`);
}

export function replanRoundDir(cwd: string, runId: string, stepIndex: number, round: number): string {
	return path.join(runRoot(cwd, runId), "steps", String(stepIndex + 1), "replan", `round-${round}`);
}

export function replanSessionDir(cwd: string, runId: string, stepIndex: number, role: string): string {
	return path.join(runRoot(cwd, runId), "sessions", `replan-step-${stepIndex + 1}`, role);
}

export function artifactPreview(text: string, maxChars = 2000): string {
	const normalized = text.trim();
	if (normalized.length <= maxChars) return normalized;
	return `${normalized.slice(0, maxChars)}\n...[truncated]`;
}

// ---------------------------------------------------------------------------
// Intervention persistence — durable operator steering log
// ---------------------------------------------------------------------------

/** Cap before rotation: 500 entries or 100 KB. After rotation, keep last 400 entries. */
const INTERVENTION_MAX_ENTRIES = 500;
const INTERVENTION_MAX_BYTES = 100 * 1024;
const INTERVENTION_TRIM_TO = 400;

/**
 * Path to the intervention JSONL file for a given run.
 * Each line is a JSON-serialized `InterventionEntry`.
 */
export function interventionLogPath(cwd: string, runId: string): string {
	return path.join(runRoot(cwd, runId), "interventions.jsonl");
}

/**
 * Rotate the intervention log when it exceeds INTERVENTION_MAX_ENTRIES lines or
 * INTERVENTION_MAX_BYTES bytes.  The existing file is renamed to `interventions.1.jsonl`
 * and a new file containing only the last INTERVENTION_TRIM_TO entries is written.
 * Silently no-ops if the file does not exist or is within limits.
 */
function rotateInterventionLogIfNeeded(cwd: string, runId: string): void {
	const logPath = interventionLogPath(cwd, runId);
	if (!fs.existsSync(logPath)) return;
	const stat = fs.statSync(logPath);
	// Fast path: size below byte limit — read content only to check line count
	let content: string | undefined;
	let needsRotation = stat.size >= INTERVENTION_MAX_BYTES;
	if (!needsRotation) {
		content = fs.readFileSync(logPath, "utf8");
		const lineCount = content.split("\n").filter((l) => l.trim().length > 0).length;
		needsRotation = lineCount >= INTERVENTION_MAX_ENTRIES;
	}
	if (!needsRotation) return;

	// Read all lines (content may already be loaded above)
	if (content === undefined) content = fs.readFileSync(logPath, "utf8");
	const lines = content.split("\n").filter((l) => l.trim().length > 0);

	// Rename current file to .1.jsonl (overwrite any prior rotation)
	const rotatedPath = logPath.replace(/\.jsonl$/, ".1.jsonl");
	fs.renameSync(logPath, rotatedPath);

	// Write the last INTERVENTION_TRIM_TO entries to a fresh file
	const kept = lines.slice(-INTERVENTION_TRIM_TO);
	fs.writeFileSync(logPath, kept.length > 0 ? `${kept.join("\n")}\n` : "", "utf8");
}

/**
 * Append a single `InterventionEntry` to the run's intervention log.
 * Rotates the log first if it has grown beyond the configured limits.
 * Creates the file (and parent directories) if it does not exist.
 */
export function appendIntervention(cwd: string, runId: string, entry: InterventionEntry): void {
	const logPath = interventionLogPath(cwd, runId);
	ensureDir(path.dirname(logPath));
	rotateInterventionLogIfNeeded(cwd, runId);
	fs.appendFileSync(logPath, `${JSON.stringify(entry)}\n`, "utf8");
}

/**
 * Append a system (informational) entry to the intervention log.
 * System entries are auto-delivered and will never be returned by `loadPendingInterventions`.
 */
export function appendSystemIntervention(cwd: string, runId: string, content: string): void {
	const entry: InterventionEntry = {
		id: `system-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
		timestamp: new Date().toISOString(),
		entryType: "system",
		// Use sentinel target — system entries are never matched by loadPendingInterventions
		target: { childId: "system", side: "A", role: "system", intent: "steer" },
		content,
		deliveredAt: new Date().toISOString(),
	};
	appendIntervention(cwd, runId, entry);
}

/**
 * Load all `InterventionEntry` records from the run's intervention log.
 * Returns an empty array if the file does not exist or cannot be parsed.
 */
export function loadInterventions(cwd: string, runId: string): InterventionEntry[] {
	const logPath = interventionLogPath(cwd, runId);
	if (!fs.existsSync(logPath)) return [];
	const lines = fs.readFileSync(logPath, "utf8").split("\n");
	const entries: InterventionEntry[] = [];
	for (const line of lines) {
		const trimmed = line.trim();
		if (!trimmed) continue;
		try {
			entries.push(JSON.parse(trimmed) as InterventionEntry);
		} catch {
			// Skip malformed lines — they may be partially written
		}
	}
	return entries;
}

/**
 * Load undelivered `InterventionEntry` records targeted at a specific child.
 * Filters by `target.childId === childId`, `deliveredAt` absent, and `entryType !== 'system'`.
 */
export function loadPendingInterventions(cwd: string, runId: string, childId: string): InterventionEntry[] {
	return loadInterventions(cwd, runId).filter(
		(entry) =>
			entry.target.childId === childId &&
			entry.deliveredAt === undefined &&
			entry.entryType !== "system",
	);
}

/**
 * Mark a specific intervention as delivered by rewriting the log with updated
 * `deliveredAt`, `deliveredInRound`, and `deliveredInStep` fields.
 * Silently no-ops if the intervention ID is not found.
 */
// ---------------------------------------------------------------------------
// Run lock — PID-based lock so parallel sessions can detect active runs
// ---------------------------------------------------------------------------

export interface RunLock {
	pid: number;
	createdAt: string;
}

export function runLockPath(cwd: string, runId: string): string {
	return path.join(runRoot(cwd, runId), "lock.json");
}

/**
 * Acquire a lock for the given run. Writes the current PID to a lock file.
 * Returns true if acquired, false if another live process holds it.
 */
export function acquireRunLock(cwd: string, runId: string): boolean {
	const lockPath = runLockPath(cwd, runId);
	const existing = readJson<RunLock>(lockPath);
	if (existing && isProcessAlive(existing.pid)) {
		return false; // another live process holds the lock
	}
	writeJson(lockPath, { pid: process.pid, createdAt: new Date().toISOString() } satisfies RunLock);
	return true;
}

/**
 * Release the lock for the given run. Only removes if this process owns it.
 */
export function releaseRunLock(cwd: string, runId: string): void {
	const lockPath = runLockPath(cwd, runId);
	const existing = readJson<RunLock>(lockPath);
	if (existing && existing.pid === process.pid) {
		try {
			fs.unlinkSync(lockPath);
		} catch {
			// Ignore — file may already be gone
		}
	}
}

/**
 * Check if a run is locked by a live process (that is not this process).
 */
export function isRunLockedByOther(cwd: string, runId: string): boolean {
	const lockPath = runLockPath(cwd, runId);
	const existing = readJson<RunLock>(lockPath);
	if (!existing) return false;
	if (existing.pid === process.pid) return false;
	return isProcessAlive(existing.pid);
}

function isProcessAlive(pid: number): boolean {
	try {
		process.kill(pid, 0); // signal 0 = just check if process exists
		return true;
	} catch {
		return false;
	}
}

// ---------------------------------------------------------------------------
// Intervention persistence — durable operator steering log
// ---------------------------------------------------------------------------

export function markInterventionDelivered(
	cwd: string,
	runId: string,
	interventionId: string,
	round: number,
	stepIndex: number,
): void {
	const logPath = interventionLogPath(cwd, runId);
	if (!fs.existsSync(logPath)) return;
	const raw = fs.readFileSync(logPath, "utf8");
	const deliveredAt = new Date().toISOString();
	const updated: string[] = [];
	for (const line of raw.split("\n")) {
		const trimmed = line.trim();
		if (!trimmed) continue;
		try {
			const entry = JSON.parse(trimmed) as InterventionEntry;
			if (entry.id === interventionId) {
				updated.push(JSON.stringify({
					...entry,
					deliveredAt,
					deliveredInRound: round,
					deliveredInStep: stepIndex,
				} satisfies InterventionEntry));
			} else {
				updated.push(trimmed);
			}
		} catch {
			updated.push(trimmed);
		}
	}
	fs.writeFileSync(logPath, updated.length > 0 ? `${updated.join("\n")}\n` : "", "utf8");
}
