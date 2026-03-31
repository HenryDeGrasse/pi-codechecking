/**
 * `/duet-runs` — interactive run manager.
 *
 * Full-screen scrollable list of all duet runs with actions:
 * resume, view plan, view summary, inspect artifacts, abort, delete.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { Key, matchesKey, truncateToWidth, visibleWidth, wrapTextWithAnsi } from "@mariozechner/pi-tui";
import type { Component } from "@mariozechner/pi-tui";
import type { Theme } from "@mariozechner/pi-coding-agent";
import { isRunLockedByOther, readJson, runsRoot, runRoot } from "./fs.js";
import type { DuetState, PlanDraft } from "./types.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface RunEntry {
	runId: string;
	state: DuetState;
	/** Parsed timestamp from run ID */
	date: Date;
	/** Human-readable date string */
	dateStr: string;
	/** Number of steps in the plan (0 if no plan) */
	totalSteps: number;
	/** Current step index */
	stepIndex: number | undefined;
	/** Goal or source path */
	label: string;
	/** Has plan.json on disk */
	hasPlan: boolean;
	/** Has run-summary.md on disk */
	hasSummary: boolean;
	/** Has gap-analysis/ dir */
	hasGapAnalysis: boolean;
	/** Run is locked by another process (parallel session) */
	lockedByOther: boolean;
}

export type RunAction =
	| { action: "resume"; runId: string; state: DuetState }
	| { action: "view-plan"; runId: string; plan: PlanDraft; sourcePath?: string }
	| { action: "view-summary"; runId: string; summary: string }
	| { action: "abort"; runId: string }
	| { action: "delete"; runId: string }
	| { action: "close" };

// ---------------------------------------------------------------------------
// Load all runs from disk
// ---------------------------------------------------------------------------

export function loadAllRuns(cwd: string): RunEntry[] {
	const root = runsRoot(cwd);
	if (!fs.existsSync(root)) return [];

	const dirs = fs.readdirSync(root).sort().reverse(); // newest first
	const entries: RunEntry[] = [];

	for (const dir of dirs) {
		const statePath = path.join(root, dir, "state.json");
		const state = readJson<DuetState>(statePath);
		if (!state) continue;

		// Parse date from run ID (format: 2026-03-18T03-39-48-870Z-434dcbbe)
		const isoStr = dir.slice(0, 24).replace(/-/g, (m, offset: number) => {
			if (offset === 4 || offset === 7) return "-"; // date separators
			if (offset === 13 || offset === 16) return ":"; // time separators
			if (offset === 19) return "."; // ms separator
			return m;
		});
		const date = new Date(isoStr);
		const dateStr = isNaN(date.getTime())
			? dir.slice(0, 19)
			: date.toLocaleString("en-US", {
					month: "short",
					day: "numeric",
					hour: "2-digit",
					minute: "2-digit",
					hour12: false,
			  });

		const plan = state.plan;
		const totalSteps = plan?.steps.length ?? 0;

		// Determine label
		let label = state.goal ?? state.planSourcePath ?? dir;
		if (label.length > 80) label = label.slice(0, 77) + "...";

		const runDir = runRoot(cwd, dir);
		const hasPlan = fs.existsSync(path.join(runDir, "plan.json"));
		const hasSummary = fs.existsSync(path.join(runDir, "run-summary.md"));
		const hasGapAnalysis = fs.existsSync(path.join(runDir, "gap-analysis"));
		const lockedByOther = isRunLockedByOther(cwd, dir);

		entries.push({
			runId: dir,
			state,
			date,
			dateStr,
			totalSteps,
			stepIndex: state.stepIndex,
			label,
			hasPlan,
			hasSummary,
			hasGapAnalysis,
			lockedByOther,
		});
	}

	return entries;
}

// ---------------------------------------------------------------------------
// RunListComponent — full-screen scrollable TUI
// ---------------------------------------------------------------------------

export class RunListComponent implements Component {
	private selectedIndex = 0;
	private scrollOffset = 0;
	private entries: RunEntry[];
	private mode: "list" | "actions" = "list";
	private actionIndex = 0;
	private lastHeight = 0;

	public onAction?: (action: RunAction) => void;

	constructor(
		private readonly theme: Theme,
		private readonly termRows: () => number,
		entries: RunEntry[],
	) {
		this.entries = entries;
	}

	invalidate(): void {}

	handleInput(data: string): void {
		if (this.mode === "actions") {
			this.handleActionsInput(data);
			return;
		}
		this.handleListInput(data);
	}

	private handleListInput(data: string): void {
		if (matchesKey(data, Key.escape) || data === "q") {
			this.onAction?.({ action: "close" });
			return;
		}
		if (matchesKey(data, Key.down) || data === "j") {
			if (this.selectedIndex < this.entries.length - 1) this.selectedIndex++;
		} else if (matchesKey(data, Key.up) || data === "k") {
			if (this.selectedIndex > 0) this.selectedIndex--;
		} else if (matchesKey(data, Key.pageDown)) {
			const page = Math.max(1, this.lastHeight - 6);
			this.selectedIndex = Math.min(this.selectedIndex + page, this.entries.length - 1);
		} else if (matchesKey(data, Key.pageUp)) {
			const page = Math.max(1, this.lastHeight - 6);
			this.selectedIndex = Math.max(this.selectedIndex - page, 0);
		} else if (matchesKey(data, Key.home) || data === "g") {
			this.selectedIndex = 0;
		} else if (matchesKey(data, Key.end) || data === "G") {
			this.selectedIndex = this.entries.length - 1;
		} else if (matchesKey(data, Key.enter)) {
			if (this.entries.length > 0) {
				this.mode = "actions";
				this.actionIndex = 0;
			}
		} else if (data === "d") {
			// Quick delete
			if (this.entries.length > 0) {
				this.onAction?.({ action: "delete", runId: this.entries[this.selectedIndex].runId });
			}
			return;
		}
	}

	private getActionsForEntry(entry: RunEntry): Array<{ label: string; action: RunAction }> {
		const actions: Array<{ label: string; action: RunAction }> = [];
		const phase = entry.state.phase;

		// Resumable phases — but not if locked by another process
		if (!entry.lockedByOther && (phase === "paused" || phase === "executing" || phase === "planning" || (phase === "aborted" && entry.hasPlan))) {
			actions.push({ label: "Resume run", action: { action: "resume", runId: entry.runId, state: entry.state } });
		}

		// View plan
		if (entry.hasPlan) {
			actions.push({
				label: "View plan",
				action: {
					action: "view-plan",
					runId: entry.runId,
					plan: {} as PlanDraft, // placeholder — loaded from disk by handler
					sourcePath: entry.state.planSourcePath,
				},
			});
		}

		// View summary
		if (entry.hasSummary) {
			actions.push({
				label: "View summary",
				action: { action: "view-summary", runId: entry.runId, summary: "" }, // placeholder
			});
		}

		// Abort stale runs
		if (phase === "planning" || phase === "executing" || phase === "paused") {
			actions.push({ label: "Abort run", action: { action: "abort", runId: entry.runId } });
		}

		// Delete
		actions.push({ label: "Delete run", action: { action: "delete", runId: entry.runId } });

		return actions;
	}

	private handleActionsInput(data: string): void {
		const entry = this.entries[this.selectedIndex];
		if (!entry) { this.mode = "list"; return; }
		const actions = this.getActionsForEntry(entry);

		if (matchesKey(data, Key.escape) || data === "q") {
			this.mode = "list";
			return;
		}
		if (matchesKey(data, Key.down) || data === "j") {
			if (this.actionIndex < actions.length - 1) this.actionIndex++;
		} else if (matchesKey(data, Key.up) || data === "k") {
			if (this.actionIndex > 0) this.actionIndex--;
		} else if (matchesKey(data, Key.enter)) {
			const selected = actions[this.actionIndex];
			if (selected) {
				this.onAction?.(selected.action);
			}
		}
	}

	render(width: number): string[] {
		const th = this.theme;
		const height = this.termRows();
		this.lastHeight = height;

		const fit = (text: string): string =>
			visibleWidth(text) <= width ? text : truncateToWidth(text, width);

		const lines: string[] = [];

		// Header
		const runCount = this.entries.length;
		lines.push(fit(th.fg("accent", `── Duet Runs (${runCount}) ── `) + th.fg("dim", "↑/↓ navigate · Enter select · d delete · q close")));
		lines.push("");

		if (this.entries.length === 0) {
			lines.push(fit(th.fg("dim", "  No duet runs found.")));
			// Pad
			while (lines.length < height - 1) lines.push("");
			return lines;
		}

		// Compute visible range
		const listHeight = Math.max(4, height - 4); // header + footer
		// Each entry takes 2 lines (main + detail). In actions mode, extra lines for actions.
		const entryHeight = 2;
		const visibleEntries = Math.floor(listHeight / entryHeight);

		// Scroll to keep selected visible
		if (this.selectedIndex < this.scrollOffset) {
			this.scrollOffset = this.selectedIndex;
		} else if (this.selectedIndex >= this.scrollOffset + visibleEntries) {
			this.scrollOffset = this.selectedIndex - visibleEntries + 1;
		}

		const start = this.scrollOffset;
		const end = Math.min(start + visibleEntries, this.entries.length);

		for (let i = start; i < end; i++) {
			const entry = this.entries[i];
			const isSelected = i === this.selectedIndex;

			// Status icon
			let prefix: string;
			let phaseColor: string;
			switch (entry.state.phase) {
				case "completed":
					prefix = "done";
					phaseColor = th.fg("success", entry.state.phase);
					break;
				case "paused":
					prefix = "pause";
					phaseColor = th.fg("warning", `paused${entry.state.pausedReason ? ` (${entry.state.pausedReason})` : ""}`);
					break;
				case "aborted":
					prefix = "abort";
					phaseColor = th.fg("error", "aborted");
					break;
				case "planning":
					prefix = "plan";
					phaseColor = th.fg("accent", "planning");
					break;
				case "executing":
					prefix = "run";
					phaseColor = th.fg("accent", `executing${entry.stepIndex !== undefined ? ` step ${entry.stepIndex + 1}/${entry.totalSteps}` : ""}`);
					break;
				default:
					prefix = "info";
					phaseColor = th.fg("dim", entry.state.phase);
			}

			// Lock indicator for runs active in another process
			if (entry.lockedByOther) {
				prefix = "lock";
				phaseColor += th.fg("dim", " (another session)");
			}

			// Step progress
			const stepInfo = entry.totalSteps > 0
				? th.fg("dim", `${entry.stepIndex !== undefined ? entry.stepIndex + 1 : 0}/${entry.totalSteps} steps`)
				: th.fg("dim", "no plan");

			// Line 1: date + phase + steps
			const rowPrefix = isSelected ? th.bold(th.fg("accent", "▸ ")) : "  ";
			const datePart = th.fg("dim", entry.dateStr.padEnd(14));
			const statusTag = isSelected ? th.bold(prefix.padEnd(5)) : th.fg("dim", prefix.padEnd(5));
			const line1 = `${rowPrefix}${statusTag} ${datePart} │ ${stepInfo.padEnd(18)} │ ${phaseColor}`;
			lines.push(fit(line1));

			// Line 2: goal/label
			const labelStyled = isSelected ? th.bold(entry.label) : th.fg("dim", entry.label);
			lines.push(fit(`    ${labelStyled}`));

			// If selected and in actions mode, show action menu
			if (isSelected && this.mode === "actions") {
				const actions = this.getActionsForEntry(entry);
				lines.push(fit(th.fg("border", `    ${"─".repeat(Math.max(0, width - 6))}`)));
				for (let a = 0; a < actions.length; a++) {
					const act = actions[a];
					const aPrefix = a === this.actionIndex ? th.bold(th.fg("accent", "  ▸ ")) : "    ";
					const aLabel = a === this.actionIndex ? th.bold(th.fg("accent", act.label)) : th.fg("dim", act.label);
					lines.push(fit(`${aPrefix}${aLabel}`));
				}
				lines.push(fit(th.fg("border", `    ${"─".repeat(Math.max(0, width - 6))}`)));
			}
		}

		// Pad to fill
		while (lines.length < height - 1) lines.push("");

		// Footer
		const pct = this.entries.length <= visibleEntries
			? 100
			: Math.round(((this.scrollOffset + visibleEntries) / this.entries.length) * 100);
		lines.push(fit(th.fg("dim", `  ${this.selectedIndex + 1}/${this.entries.length}  ${pct}%`)));

		return lines;
	}

	/** Remove a run from the list after deletion. */
	removeRun(runId: string): void {
		const idx = this.entries.findIndex((e) => e.runId === runId);
		if (idx === -1) return;
		this.entries.splice(idx, 1);
		if (this.selectedIndex >= this.entries.length) {
			this.selectedIndex = Math.max(0, this.entries.length - 1);
		}
		this.mode = "list";
	}

	/** Update a run's state (e.g. after abort). */
	updateRunState(runId: string, phase: string): void {
		const entry = this.entries.find((e) => e.runId === runId);
		if (entry) {
			entry.state = { ...entry.state, phase: phase as DuetState["phase"] };
		}
		this.mode = "list";
	}
}
