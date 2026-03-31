/**
 * Controller gate checks — runs configured checks (lint, typecheck, tests, build)
 * and captures git diff/status artifacts for the orchestrator.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { spawn } from "node:child_process";
import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import { artifactPreview, ensureDir, writeJson, writeText } from "./fs.js";
import type { DuetConfig, DuetState, GateEvidence, PauseReason, PlanDraft, ResumeAction } from "./types.js";
import type { GateRunResult } from "./prompts.js";

// ---------------------------------------------------------------------------
// Shell execution helper
// ---------------------------------------------------------------------------

export type ExecResult = { stdout: string; stderr: string; code: number | null | undefined; killed?: boolean };

/**
 * Kill an entire process group (the process and all its descendants).
 * Uses negative PID to target the process group on Unix.
 */
function killProcessTree(pid: number): void {
	try {
		process.kill(-pid, "SIGTERM");
	} catch {
		// Ignore — process may already be dead
	}
	// Force-kill after 3 seconds if SIGTERM didn't work
	setTimeout(() => {
		try {
			process.kill(-pid, "SIGKILL");
		} catch {
			// Ignore — process may already be dead
		}
	}, 3000);
}

/**
 * Execute a shell command with proper process-group cleanup.
 *
 * Spawns with `detached: true` so the child gets its own process group,
 * then uses `process.kill(-pid)` on timeout/abort to kill the entire tree
 * (including forked workers like Vitest pool processes). This prevents
 * orphaned child processes when duet sessions are interrupted.
 *
 * NOTE: We intentionally do NOT use `pi.exec()` here because it spawns
 * without `detached: true` and only sends SIGTERM to the direct child,
 * leaving grandchild processes (e.g. Vitest workers) alive as orphans.
 */
export function execShell(_pi: ExtensionAPI, command: string, timeoutSec = 300): Promise<ExecResult> {
	return new Promise((resolve) => {
		const proc = spawn("bash", ["-lc", command], {
			cwd: process.cwd(),
			detached: true,
			stdio: ["ignore", "pipe", "pipe"],
		});

		let stdout = "";
		let stderr = "";
		let killed = false;
		let timeoutId: ReturnType<typeof setTimeout> | undefined;

		const doKill = () => {
			if (!killed && proc.pid) {
				killed = true;
				killProcessTree(proc.pid);
			}
		};

		if (timeoutSec > 0) {
			timeoutId = setTimeout(doKill, timeoutSec * 1000);
		}

		proc.stdout?.on("data", (data: Buffer) => { stdout += data.toString(); });
		proc.stderr?.on("data", (data: Buffer) => { stderr += data.toString(); });

		proc.on("close", (code) => {
			if (timeoutId) clearTimeout(timeoutId);
			resolve({ stdout, stderr, code, killed });
		});

		proc.on("error", () => {
			if (timeoutId) clearTimeout(timeoutId);
			resolve({ stdout, stderr, code: 1, killed });
		});

		// Detach from parent's reference count so pi can exit even if
		// the child somehow lingers (belt-and-suspenders).
		proc.unref();
	});
}

// ---------------------------------------------------------------------------
// Artifact writing
// ---------------------------------------------------------------------------

export function writeBoundedArtifact(filePath: string, value: string, maxChars: number, label: string): void {
	if (value.length <= maxChars) {
		writeText(filePath, value);
		return;
	}
	writeText(
		filePath,
		`${value.slice(0, maxChars)}\n...[${label} truncated at ${maxChars} chars to control duet artifact size]\n`,
	);
}

// ---------------------------------------------------------------------------
// Git snapshot
// ---------------------------------------------------------------------------

export interface GitSnapshot {
	root: string;
	statusPorcelain: string;
}

export async function getGitSnapshot(pi: ExtensionAPI): Promise<GitSnapshot | undefined> {
	const rootResult = await execShell(pi, "git rev-parse --show-toplevel", 30);
	if (rootResult.code !== 0) return undefined;
	const statusResult = await execShell(pi, "git status --porcelain", 30);
	return {
		root: rootResult.stdout.trim(),
		statusPorcelain: statusResult.stdout,
	};
}

// ---------------------------------------------------------------------------
// Repo readiness check
// ---------------------------------------------------------------------------

/**
 * Check that the repo is in a suitable state for duet to run.
 * Returns a pause-state when the repo isn't ready, letting the caller
 * decide how to persist it.
 *
 * `pauseFn` wraps the caller's state-management: given a reason and a
 * resume action it returns the paused DuetState (the caller typically
 * calls its closure's `pauseState()` inside).
 */
export async function ensureRepoReady(
	pi: ExtensionAPI,
	ctx: ExtensionContext,
	config: DuetConfig,
	_state: DuetState,
	resumeAction: ResumeAction,
	pauseFn?: (reason: PauseReason, action: ResumeAction | undefined) => DuetState,
	updateUiFn?: (ctx: ExtensionContext, state: DuetState) => void,
): Promise<{ ok: true } | { ok: false; state: DuetState }> {
	// If no pause helper was provided, construct a minimal paused state.
	const doPause = pauseFn ?? ((reason: PauseReason, action: ResumeAction | undefined): DuetState => ({
		..._state,
		phase: "paused" as const,
		pausedReason: reason,
		resumeAction: action,
		activity: undefined,
		updatedAt: new Date().toISOString(),
	} as DuetState));
	const doUpdateUi = updateUiFn ?? (() => {});

	let snapshot = await getGitSnapshot(pi);
	if (config.repo.requireGit && !snapshot) {
		if (ctx.hasUI) {
			const initOption = "Initialize git repo (git init + initial commit)";
			const selected = await ctx.ui.select("No git repository found. Duet requires git for diff tracking.", [
				initOption,
				"Cancel duet run",
			]);
			if (selected === initOption) {
				const initResult = await execShell(pi, "git init && git add -A && git commit -m 'initial commit (duet auto-init)' --allow-empty", 60);
				if (initResult.code === 0) {
					snapshot = await getGitSnapshot(pi);
					if (snapshot) {
						ctx.ui.notify("Git repository initialized with initial commit.", "info");
					} else {
						const next = doPause("dirty_repo", resumeAction);
						doUpdateUi(ctx, next);
						ctx.ui.notify("Git init succeeded but repo still not detected. Check directory permissions.", "error");
						return { ok: false, state: next };
					}
				} else {
					const next = doPause("dirty_repo", resumeAction);
					doUpdateUi(ctx, next);
					ctx.ui.notify(`Git init failed: ${initResult.stderr || initResult.stdout}`, "error");
					return { ok: false, state: next };
				}
			} else {
				const next = doPause("missing_config", resumeAction);
				doUpdateUi(ctx, next);
				ctx.ui.notify("Duet paused — no git repository. Run 'git init' manually or set repo.requireGit to false in .pi/duet/config.json.", "warning");
				return { ok: false, state: next };
			}
		} else {
			throw new Error("Duet requires a git repository. Run 'git init' in the project directory or set repo.requireGit to false in .pi/duet/config.json.");
		}
	}
	if (snapshot && config.repo.requireCleanStart && snapshot.statusPorcelain.trim()) {
		const next = doPause("dirty_repo", resumeAction);
		doUpdateUi(ctx, next);
		if (ctx.hasUI) ctx.ui.notify("Dirty repo detected. Clean it or relax repo.requireCleanStart, then use /duet to resume.", "warning");
		return { ok: false, state: next };
	}
	return { ok: true };
}

// ---------------------------------------------------------------------------
// Auto-commit after approved step
// ---------------------------------------------------------------------------

/**
 * Stage all changes and commit with a message identifying the duet step.
 * Returns true if the commit succeeded (or there was nothing to commit).
 */
export async function commitApprovedStep(
	pi: ExtensionAPI,
	stepIndex: number,
	stepTitle: string,
	runId: string,
): Promise<{ committed: boolean; error?: string }> {
	try {
		// Check if there's anything to commit
		const status = await execShell(pi, "git status --porcelain", 30);
		if (!status.stdout.trim()) return { committed: false };

		const safeTitle = stepTitle.replace(/"/g, '\\"').slice(0, 100);
		const shortRunId = runId.slice(0, 12);
		const msg = `duet: step ${stepIndex + 1} — ${safeTitle} [${shortRunId}]`;
		const result = await execShell(pi, `git add -A && git commit -m "${msg}"`, 60);
		if (result.code === 0) {
			return { committed: true };
		}
		return { committed: false, error: result.stderr || result.stdout };
	} catch (err) {
		return { committed: false, error: err instanceof Error ? err.message : String(err) };
	}
}

// ---------------------------------------------------------------------------
// Controller gate runner
// ---------------------------------------------------------------------------

export async function runControllerGates(
	pi: ExtensionAPI,
	iterationDir: string,
	step: PlanDraft["steps"][number],
	config: DuetConfig,
	mode: "full" | "snapshot" = "full",
	onCheckProgress?: (checkId: string, status: "running" | "passed" | "failed") => void,
): Promise<GateRunResult> {
	const controllerDir = path.join(iterationDir, "controller");
	const outputsDir = path.join(controllerDir, "outputs");
	ensureDir(outputsDir);

	const diffNames = await execShell(pi, "git diff HEAD --name-only 2>/dev/null || git diff --name-only", 60);
	const status = await execShell(pi, "git status --porcelain", 60);
	const diffPatch = mode === "full"
		? await execShell(pi, "git diff HEAD 2>/dev/null || git diff", 120)
		: { stdout: "", stderr: "", code: 0, killed: false };

	// Append untracked files (lines starting with "?? ") to the name-only list
	const untrackedFiles = status.stdout
		.split("\n")
		.filter((line) => line.startsWith("?? "))
		.map((line) => line.slice(3).replace(/\/$/, ""))
		.join("\n");
	const allChangedNames = [diffNames.stdout.trim(), untrackedFiles].filter(Boolean).join("\n");

	writeText(path.join(controllerDir, "diff-name-only.txt"), `${allChangedNames}\n`);
	writeBoundedArtifact(path.join(controllerDir, "diff.patch"), diffPatch.stdout, 120_000, "diff");
	writeBoundedArtifact(path.join(controllerDir, "git-status.txt"), status.stdout, 20_000, "git status");

	let diffCheckPassed = true;
	let diffCheckPath: string | undefined;
	if (mode === "full" && config.repo.captureDiffCheck) {
		const diffCheck = await execShell(pi, "git diff HEAD --check 2>/dev/null || git diff --check", 60);
		diffCheckPassed = diffCheck.code === 0;
		diffCheckPath = path.join(controllerDir, "git-diff-check.txt");
		writeBoundedArtifact(diffCheckPath, `${diffCheck.stdout}${diffCheck.stderr}`, 50_000, "git diff --check output");
	}

	const evidence: GateEvidence[] = [];
	const gateResults: Array<{ id: string; passed: boolean }> = [];
	if (mode === "full") {
		for (const checkId of step.requiredChecks) {
			const check = config.checks[checkId];
			onCheckProgress?.(checkId, "running");
			const result = await execShell(pi, check.cmd, check.timeoutSec ?? 300);
			const stdoutPath = path.join(outputsDir, `${checkId}.stdout.txt`);
			const stderrPath = path.join(outputsDir, `${checkId}.stderr.txt`);
			writeBoundedArtifact(stdoutPath, result.stdout, 120_000, `${checkId} stdout`);
			writeBoundedArtifact(stderrPath, result.stderr, 120_000, `${checkId} stderr`);
			const passed = result.code === 0;
			onCheckProgress?.(checkId, passed ? "passed" : "failed");
			evidence.push({
				checkId,
				cmd: check.cmd,
				exitCode: result.code ?? -1,
				passed,
				stdoutPath,
				stderrPath,
				truncatedPreview: artifactPreview(`${result.stdout}\n${result.stderr}`),
			});
			gateResults.push({ id: checkId, passed });
		}

		if (config.repo.captureDiffCheck) {
			gateResults.push({ id: "git-diff-check", passed: diffCheckPassed });
		}
		if (config.repo.enforceCleanAfterStep) {
			gateResults.push({ id: "git-clean-after-step", passed: status.stdout.trim().length === 0 });
		}
	}

	const allPassed = mode === "full"
		? evidence.every((item) => item.passed) &&
			diffCheckPassed &&
			(!config.repo.enforceCleanAfterStep || status.stdout.trim().length === 0)
		: false;

	writeJson(path.join(controllerDir, "gate-evidence.json"), evidence);

	return {
		evidence,
		gateResults,
		diffNameOnlyPath: path.join(controllerDir, "diff-name-only.txt"),
		diffPatchPath: path.join(controllerDir, "diff.patch"),
		diffCheckPath,
		statusPath: path.join(controllerDir, "git-status.txt"),
		allPassed,
		statusPorcelain: status.stdout,
	};
}
