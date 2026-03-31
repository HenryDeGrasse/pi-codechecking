/**
 * Persistent workspace UI component — the primary active duet experience.
 *
 * Renders a compact status bar (`setStatus('duet', ...)`) and a persistent
 * activity widget (`setWidget('duet-workspace', ...)`) that are always visible
 * during active orchestration. No overlays, no pop-ups.
 *
 * Replaces the overlay-based DuetLivePanel for the normal active-run view.
 * DuetLivePanel itself is NOT imported here — the workspace is a fundamentally
 * different paradigm (persistent widget vs. modal overlay).
 */

import { truncateToWidth, visibleWidth, wrapTextWithAnsi } from "@mariozechner/pi-tui";
import type { Component, TUI } from "@mariozechner/pi-tui";
import type { Theme, ThemeColor } from "@mariozechner/pi-coding-agent";
import type { ExtensionContext } from "@mariozechner/pi-coding-agent";
import type { ActiveChildInfo, DuetState } from "./types.js";
import type { RunSideEvent } from "./runner.js";

// ---------------------------------------------------------------------------
// Helpers (copied from live-panel.ts — do NOT import DuetLivePanel)
// ---------------------------------------------------------------------------

const SPINNER_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"] as const;

function getSpinnerFrame(): string {
	return SPINNER_FRAMES[Math.floor(Date.now() / 120) % SPINNER_FRAMES.length];
}

function fmtDur(ms: number): string {
	const sec = Math.floor(ms / 1000);
	if (sec < 60) return `${sec}s`;
	return `${Math.floor(sec / 60)}m${(sec % 60).toString().padStart(2, "0")}s`;
}

function fmtSize(chars: number): string {
	if (chars < 1000) return `${chars}ch`;
	return `${(chars / 1000).toFixed(1)}k`;
}

// ---------------------------------------------------------------------------
// Internal types
// ---------------------------------------------------------------------------

type TailLineStyle = "thinking" | "tool" | "text" | "status" | "dim";

interface TailLine {
	style: TailLineStyle;
	raw: string;
}

interface CheckStatus {
	id: string;
	status: "running" | "passed" | "failed";
}

interface StreamState {
	thinkingActive: boolean;
	thinkingStart: number;
	thinkingLineBuf: string;
	textActive: boolean;
	textLineBuf: string;
	toolCount: number;
	textLength: number;
}

const TAIL_MAX_LINES = 2000;
const TAIL_TRIM_TO = 1500;

/**
 * Reserve this many terminal rows for the editor + footer + status bar.
 * The rest is available for the workspace widget.
 */
const RESERVED_ROWS_FOR_EDITOR = 5;

// ---------------------------------------------------------------------------
// WorkspaceComponent — TUI component
// ---------------------------------------------------------------------------

/**
 * The TUI component that renders the duet workspace widget.
 *
 * All mutable state is held as public fields so `DuetWorkspaceUI` can
 * update them freely. The component just renders whatever it sees on each
 * `render()` call — it never drives state itself.
 */
export class WorkspaceComponent implements Component {
	// State fields mutated externally by DuetWorkspaceUI
	state: DuetState | null = null;
	activeChildInfo: ActiveChildInfo | undefined = undefined;
	pendingCounts: Record<string, number> = {};
	phaseLabel: string | null = null;
	checkStatuses: CheckStatus[] = [];
	tailLines: TailLine[] = [];
	stream: StreamState = this.freshStream();
	childStartedAt = 0;
	/** One-line cost summary, updated periodically from DuetWorkspaceUI. */
	costLine: string | null = null;

	// Dual-pane state
	currentPane: "activity" | "plan" = "activity";

	// Plan-data fields (populated by DuetWorkspaceUI.setPlanInfo)
	planGoal: string | null = null;
	planSteps: Array<{ title: string; id: string }> | null = null;
	planSummaryText: string | null = null;
	currentStepIndex: number | undefined = undefined;
	statePhase: string | null = null;
	stateRound: number | undefined = undefined;
	modelInfo: string | null = null;
	configInfo: { executionMode?: string; handoffMode?: string } | null = null;

	constructor(
		private readonly theme: Theme,
		private readonly tui: TUI,
	) {}

	/** Switch the active pane and trigger a re-render. */
	setPane(pane: "activity" | "plan"): void {
		this.currentPane = pane;
		this.requestRender();
	}

	// --- Component interface ---

	invalidate(): void {
		// No cache to clear; we rebuild lines from state on every render.
	}

		render(width: number): string[] {
			const state = this.state;
			if (!state) return [];

		const th = this.theme;

			const fit = (text: string): string => {
				if (visibleWidth(text) <= width) return text;
				return truncateToWidth(text, width);
			};

			const wrap = (text: string): string[] => {
				if (visibleWidth(text) <= width) return [text];
				return wrapTextWithAnsi(text, width);
			};

		const lines: string[] = [];

		// ── Header line 1: step/phase ────────────────────────────────
		const plan = state.plan;
		const stepIndex = state.stepIndex;
		const totalSteps = plan?.steps.length ?? 0;
		const child = this.activeChildInfo;

		if (plan && totalSteps > 0 && stepIndex !== undefined) {
			// Execution: show progress bar + step title
			const stepNum = stepIndex + 1;
			const stepTitle = plan.steps[stepIndex]?.title ?? "";
			const barWidth = Math.max(6, Math.min(20, width - 40));
			const filled = Math.round((stepNum / totalSteps) * barWidth);
			const empty = barWidth - filled;
			const bar = "█".repeat(filled) + "░".repeat(empty);
			const header = ` ${th.fg("muted", bar)} ${th.fg("dim", `${stepNum}/${totalSteps}`)}  ${th.bold(th.fg("accent", stepTitle || `step ${stepNum}`))}`;
			lines.push(fit(header));
		} else {
			// Planning / gap analysis / importing / other non-step phases:
			// Show activeSummary info when available for richer context.
			const summary = state.activeSummary;
			const parts: string[] = [];

			// Phase badge
			const phaseName = this.phaseLabel ?? state.phase;
			parts.push(th.fg("dim", phaseName));

			// Round indicator
			const round = state.round;
			if (round !== undefined && round > 0) {
				parts.push(th.fg("muted", `round ${round}`));
			}

			// Step/task title from activeSummary (e.g. "Gap analysis: plan.md", "Importing plan.md")
			const title = summary?.stepTitle;
			if (title) {
				parts.push(th.bold(th.fg("accent", title)));
			}

			// Last verdict if available
			const verdict = summary?.lastVerdict;
			if (verdict) {
				const vColor: ThemeColor = verdict === "approve" ? "success" : "warning";
				parts.push(th.fg(vColor, verdict));
			}

			const header = ` ${parts.join(th.fg("border", "  ·  "))}`;
			lines.push(fit(header));
		}

		// ── Tab indicator ────────────────────────────────────────────
		const isActivity = this.currentPane === "activity";
		const activityLabel = isActivity
			? th.bold(th.fg("accent", "[Activity]"))
			: th.fg("dim", "Activity");
		const planLabel = !isActivity
			? th.bold(th.fg("accent", "[Plan]"))
			: th.fg("dim", "Plan");
		const navHint = th.fg("muted", "alt+, / alt+.");
		lines.push(fit(`  ${activityLabel}  ${planLabel}    ${navHint}`));

		// ── Header line 2: active child status ──────────────────────
		if (child) {
			const elapsed =
				this.childStartedAt > 0 ? fmtDur(Date.now() - this.childStartedAt) : "";
			const ss = this.stream;

			let phase = "running";
			if (ss.thinkingActive) phase = "thinking";
			else if (ss.textActive) phase = "output";
			else if (ss.toolCount > 0) phase = "tools";

			const spinner = getSpinnerFrame();
			const parts = [` ${th.fg("success", spinner)} ${th.bold(child.role)}`];
			parts.push(th.fg("dim", child.model));
			parts.push(th.fg("muted", phase));
			if (ss.toolCount > 0) parts.push(th.fg("dim", `${ss.toolCount} tools`));
			if (ss.textLength > 0) parts.push(th.fg("dim", fmtSize(ss.textLength)));
			if (elapsed) parts.push(th.fg("dim", elapsed));

			// Gate checks inline on the same line
			if (this.checkStatuses.length > 0) {
				const checkParts = this.checkStatuses.map(({ id, status: s }) => {
					const icon = s === "running" ? getSpinnerFrame() : s === "passed" ? "✓" : "✗";
					const color: ThemeColor = s === "running" ? "dim" : s === "passed" ? "success" : "error";
					return th.fg(color, `${id}${icon}`);
				});
				parts.push(checkParts.join(" "));
			}

			lines.push(fit(parts.join("  ")));
		} else if (state.phase === "paused") {
			const pauseReason = state.pausedReason ? ` (${state.pausedReason})` : "";
			const totalPending = Object.values(this.pendingCounts).reduce((sum, n) => sum + n, 0);
			let pauseLine = ` ${th.fg("warning", "pause")} ${th.bold("paused")}${th.fg("dim", pauseReason)}`;
			if (totalPending > 0) {
				pauseLine += `  ${th.fg("warning", `${totalPending} queued`)}`;
			}
			lines.push(fit(pauseLine));
		} else {
			const label = this.phaseLabel ?? "waiting";
			lines.push(fit(` ${th.fg("dim", label)}`));
		}

		// ── Separator ───────────────────────────────────────────────
		lines.push(fit(th.fg("border", " " + "─".repeat(Math.max(0, width - 2)))));

		// ── Content: fills remaining terminal like normal pi output ─
		const termRows = this.tui.terminal.rows;
		const headerLineCount = lines.length;
		const availRows = Math.max(4, termRows - RESERVED_ROWS_FOR_EDITOR - headerLineCount);

		if (this.currentPane === "plan") {
			// ── Plan pane ──────────────────────────────────────────────
			const planLines: string[] = [];

			// Goal
			if (this.planGoal) {
				planLines.push(...wrap(` ${th.fg("accent", this.planGoal)}`));
				planLines.push("");
			}

			// Step list
			if (this.planSteps && this.planSteps.length > 0) {
				for (let i = 0; i < this.planSteps.length; i++) {
					const step = this.planSteps[i];
					const num = `${i + 1}.`;
					const ci = this.currentStepIndex;
					let styledLine: string;
					if (ci !== undefined && i < ci) {
						// Completed step
						styledLine = ` ${th.fg("success", `${num} ✓ ${step.title}`)}`;
					} else if (ci !== undefined && i === ci) {
						// Current step
						styledLine = ` ${th.bold(th.fg("accent", `${num} ${step.title}`))}`;
					} else {
						// Future step
						styledLine = ` ${th.fg("dim", `${num} ${step.title}`)}`;
					}
					planLines.push(...wrap(styledLine));
				}
				planLines.push("");
			}

			// Separator
			planLines.push(fit(th.fg("border", " " + "─".repeat(Math.max(0, width - 2)))));

			// State info
			if (this.statePhase) {
				planLines.push(fit(` ${th.fg("dim", "Phase:")}  ${this.statePhase}`));
			}
			if (this.stateRound !== undefined) {
				planLines.push(fit(` ${th.fg("dim", "Round:")}  ${this.stateRound}`));
			}
			if (this.configInfo?.executionMode) {
				planLines.push(fit(` ${th.fg("dim", "Execution:")}  ${this.configInfo.executionMode}`));
			}
			if (this.configInfo?.handoffMode) {
				planLines.push(fit(` ${th.fg("dim", "Handoff:")}  ${this.configInfo.handoffMode}`));
			}
			if (this.modelInfo) {
				planLines.push(...wrap(` ${th.fg("dim", "Model:")}  ${this.modelInfo}`));
			}

			// Summary text
			if (this.planSummaryText) {
				planLines.push("");
				planLines.push(...wrap(` ${th.fg("dim", this.planSummaryText)}`));
			}

			// Bottom-anchor: pad above, then show tail slice
			const shown = planLines.slice(-availRows);
			for (let i = 0; i < availRows - shown.length; i++) lines.push("");
			for (const line of shown) lines.push(line);
		} else {
			// ── Activity pane (default) ────────────────────────────────
			const displayTail = this.buildDisplayTail();
			const wrappedTail = displayTail.flatMap((tl) => wrap(` ${this.styleTailLine(tl)}`));
			if (wrappedTail.length === 0) {
				// Nothing streamed yet — pad to fill, placeholder at bottom
				for (let i = 0; i < availRows - 1; i++) lines.push("");
				if (child) {
					lines.push(fit(` ${th.fg("dim", "(streaming...)")}`));
				} else {
					lines.push(fit(` ${th.fg("dim", this.phaseLabel ?? "waiting")}`));
				}
			} else {
				const shown = wrappedTail.slice(-availRows);
				// Pad above so content anchors to bottom (like a terminal)
				for (let i = 0; i < availRows - shown.length; i++) lines.push("");
				for (const line of shown) lines.push(line);
			}
		}

		return lines;
	}

	// --- Tail buffer management (called by DuetWorkspaceUI.feedEvent) ---

	pushTail(style: TailLineStyle, raw: string): void {
		this.tailLines.push({ style, raw });
		if (this.tailLines.length > TAIL_MAX_LINES) {
			this.tailLines = this.tailLines.slice(-TAIL_TRIM_TO);
		}
	}

	appendStream(style: "thinking" | "text", delta: string): void {
		const bufKey = style === "thinking" ? "thinkingLineBuf" : "textLineBuf";
		this.stream[bufKey] += delta;
		const parts = this.stream[bufKey].split("\n");
		this.stream[bufKey] = parts.pop() ?? "";
		for (const line of parts) {
			this.pushTail(style, line);
		}
	}

	flushThinkingBuf(): void {
		if (this.stream.thinkingLineBuf.length > 0) {
			this.pushTail("thinking", this.stream.thinkingLineBuf);
			this.stream.thinkingLineBuf = "";
		}
	}

	flushTextBuf(): void {
		if (this.stream.textLineBuf.length > 0) {
			this.pushTail("text", this.stream.textLineBuf);
			this.stream.textLineBuf = "";
		}
	}

	resetStream(): void {
		this.stream = this.freshStream();
	}

	/** Request a TUI re-render for this widget. */
	requestRender(): void {
		this.tui.requestRender();
	}

	// --- Private helpers ---

	private freshStream(): StreamState {
		return {
			thinkingActive: false,
			thinkingStart: 0,
			thinkingLineBuf: "",
			textActive: false,
			textLineBuf: "",
			toolCount: 0,
			textLength: 0,
		};
	}

	/** Build display tail including any live partial line buffers. */
	private buildDisplayTail(): TailLine[] {
		const result = [...this.tailLines];
		const ss = this.stream;
		if (ss.thinkingLineBuf.length > 0) {
			result.push({ style: "thinking", raw: ss.thinkingLineBuf });
		} else if (ss.textLineBuf.length > 0) {
			result.push({ style: "text", raw: ss.textLineBuf });
		}
		return result;
	}

	private styleTailLine(tl: TailLine): string {
		const th = this.theme;
		switch (tl.style) {
			case "thinking":
				return th.fg("dim", th.italic(tl.raw));
			case "tool":
				return th.fg("muted", tl.raw);
			case "text":
				return th.fg("text", tl.raw);
			case "status":
				return th.fg("dim", tl.raw);
			case "dim":
				return th.fg("dim", tl.raw);
		}
	}

	/** Derive inactive child identity from the active child. */
	private resolveInactiveInfo():
		| { id: string; role: string; model: string }
		| undefined {
		if (!this.activeChildInfo || !this.state?.activeConfig) return undefined;
		const { side, role } = this.activeChildInfo;
		const other = (side === "A" ? "B" : "A") as "A" | "B";

		let inactiveRole: string;
		let inactiveId: string;

		if (role === "planner") {
			inactiveRole = "critic";
			inactiveId = `${other}-critic`;
		} else if (role === "critic") {
			inactiveRole = "planner";
			inactiveId = `${other}-planner`;
		} else if (role === "implementer") {
			inactiveRole = "reviewer";
			inactiveId = `${other}-reviewer`;
		} else if (role === "reviewer") {
			inactiveRole = "implementer";
			inactiveId = `${other}-implementer`;
		} else if (role === "relay-a") {
			inactiveRole = "relay-b";
			inactiveId = "B-relay-b";
		} else if (role === "relay-b") {
			inactiveRole = "relay-a";
			inactiveId = "A-relay-a";
		} else {
			return undefined;
		}

		const inactiveModel =
			other === "A"
				? this.state.activeConfig.sideA.model
				: this.state.activeConfig.sideB.model;

		return { id: inactiveId, role: inactiveRole, model: inactiveModel };
	}
}

// ---------------------------------------------------------------------------
// DuetWorkspaceUI — public orchestrator API
// ---------------------------------------------------------------------------

/**
 * Manages the persistent duet workspace UI: status bar + activity widget.
 *
 * This IS the normal active duet experience.  It is always visible while a
 * run is active — the user never has to open it on demand.
 */
export class DuetWorkspaceUI {
	private component: WorkspaceComponent | null = null;
	private widgetActive = false;
	private tickInterval: ReturnType<typeof setInterval> | null = null;
	private latestState: DuetState | null = null;
	// Track active child here too so buildStatus doesn't depend on component existence
	private _activeChildInfo: ActiveChildInfo | undefined = undefined;

	constructor(private readonly ui: ExtensionContext["ui"]) {}

	// --- Public API ---

	/**
	 * Refresh the status bar and workspace widget from the latest `DuetState`.
	 * Call this whenever the orchestration state changes.
	 *
	 * Shows the workspace when the run is active; hides it when idle/done/aborted.
	 */
	update(state: DuetState, pendingCounts?: Record<string, number>): void {
		this.latestState = state;
		const shouldShow =
			state.phase !== "idle" &&
			state.phase !== "aborted" &&
			state.phase !== "completed";

		if (!shouldShow) {
			this.clear();
			return;
		}

		this.ensureWidget();

		if (this.component) {
			this.component.state = state;
			if (pendingCounts !== undefined) {
				this.component.pendingCounts = pendingCounts;
			}
			this.component.requestRender();
		}

		this.ui.setStatus("duet", this.buildStatus(state));
	}

	/**
	 * Feed a streaming event from the active child agent.
	 * Appends to the tail buffer and triggers a widget refresh.
	 */
	feedEvent(event: RunSideEvent): void {
		const c = this.component;
		if (!c) return;

		const ss = c.stream;
		if (event.toolCount !== undefined) ss.toolCount = event.toolCount;
		if (event.textLength !== undefined) ss.textLength = event.textLength;

		switch (event.type) {
			case "thinking_start":
				c.flushTextBuf();
				ss.textActive = false;
				ss.thinkingActive = true;
				ss.thinkingStart = Date.now();
				ss.thinkingLineBuf = "";
				c.pushTail("dim", "-- thinking --");
				break;

			case "thinking_delta":
				if (event.thinkingDelta) {
					c.appendStream("thinking", event.thinkingDelta);
				}
				break;

			case "text_delta":
				if (ss.thinkingActive) {
					c.flushThinkingBuf();
					ss.thinkingActive = false;
					c.pushTail(
						"dim",
						`-- thinking done (${fmtDur(Date.now() - ss.thinkingStart)}) --`,
					);
				}
				if (!ss.textActive) {
					ss.textActive = true;
					c.pushTail("dim", "-- output --");
				}
				if (event.textDelta) {
					c.appendStream("text", event.textDelta);
				}
				break;

			case "tool_start": {
				if (ss.thinkingActive) {
					c.flushThinkingBuf();
					ss.thinkingActive = false;
					c.pushTail(
						"dim",
						`-- thinking done (${fmtDur(Date.now() - ss.thinkingStart)}) --`,
					);
				}
				c.flushTextBuf();
				ss.textActive = false;
				const args = event.toolArgs ? ` ${event.toolArgs}` : "";
				c.pushTail("tool", `> ${event.toolName ?? "tool"}${args}`);
				break;
			}

			case "tool_end":
				break;

			case "message_end":
				c.flushThinkingBuf();
				c.flushTextBuf();
				ss.thinkingActive = false;
				ss.textActive = false;
				break;

			case "turn_end":
				break;

			case "done":
				break;
		}

		c.requestRender();
	}

	/**
	 * Notify the workspace that a new child agent has started (or cleared).
	 *
	 * Resets the stream state for the incoming child and appends a round
	 * divider to the tail buffer for visual continuity across relay rounds.
	 */
	setActiveChild(info: ActiveChildInfo | undefined): void {
		this._activeChildInfo = info;

		const c = this.component;
		if (!c) return;

		if (info) {
			c.activeChildInfo = info;
			c.childStartedAt = Date.now();
			c.resetStream();
			c.checkStatuses = [];
			c.phaseLabel = null;
			// Visual divider when switching children mid-session
			if (c.tailLines.length > 0) {
				c.pushTail("dim", `── ${info.role} round ${info.round} ──`);
			}
		} else {
			c.activeChildInfo = undefined;
			c.childStartedAt = 0;
			c.resetStream();
			c.checkStatuses = [];
		}

		c.requestRender();
	}

	/**
	 * Set a transient phase label shown when no child is live.
	 * Examples: 'Running gate checks...', 'Waiting for next round'.
	 */
	setPhaseLabel(label: string): void {
		const c = this.component;
		if (!c) return;
		c.phaseLabel = label;
		c.checkStatuses = [];
		c.requestRender();
	}

	/**
	 * Update the inline gate-check progress display (one line below active child).
	 * Idempotent — calling with an existing checkId updates its status in-place.
	 */
	showCheckProgress(checkId: string, status: "running" | "passed" | "failed"): void {
		const c = this.component;
		if (!c) return;

		const existing = c.checkStatuses.find((cs) => cs.id === checkId);
		if (existing) {
			existing.status = status;
		} else {
			c.checkStatuses.push({ id: checkId, status });
		}
		c.requestRender();
	}

	/** Update the one-line cost summary shown in the status bar. */
	setCostLine(line: string | null): void {
		if (this.component) {
			this.component.costLine = line;
		}
	}

	/**
	 * Switch the active pane on the workspace component.
	 *
	 * - 'left'      → set to 'activity'
	 * - 'right'     → set to 'plan'
	 * - undefined   → toggle between the two
	 */
	togglePane(direction?: "left" | "right"): void {
		const c = this.component;
		if (!c) return;

		let next: "activity" | "plan";
		if (direction === "left") {
			next = "activity";
		} else if (direction === "right") {
			next = "plan";
		} else {
			next = c.currentPane === "activity" ? "plan" : "activity";
		}
		c.setPane(next);
	}

	/**
	 * Update the plan-related data fields on the workspace component.
	 * Pass `undefined` to clear all plan data (e.g. when starting fresh).
	 */
	setPlanInfo(
		data:
			| {
					goal?: string;
					steps?: Array<{ title: string; id: string }>;
					summaryText?: string;
					stepIndex?: number;
					phase?: string;
					round?: number;
					modelInfo?: string;
					executionMode?: string;
					handoffMode?: string;
			  }
			| undefined,
	): void {
		const c = this.component;
		if (!c) return;

		if (data === undefined) {
			c.planGoal = null;
			c.planSteps = null;
			c.planSummaryText = null;
			c.currentStepIndex = undefined;
			c.statePhase = null;
			c.stateRound = undefined;
			c.modelInfo = null;
			c.configInfo = null;
		} else {
			if (data.goal !== undefined) c.planGoal = data.goal;
			if (data.steps !== undefined) c.planSteps = data.steps;
			if (data.summaryText !== undefined) c.planSummaryText = data.summaryText;
			if (data.stepIndex !== undefined) c.currentStepIndex = data.stepIndex;
			if (data.phase !== undefined) c.statePhase = data.phase;
			if (data.round !== undefined) c.stateRound = data.round;
			if (data.modelInfo !== undefined) c.modelInfo = data.modelInfo;
			if (data.executionMode !== undefined || data.handoffMode !== undefined) {
				c.configInfo = {
					...c.configInfo,
					...(data.executionMode !== undefined && { executionMode: data.executionMode }),
					...(data.handoffMode !== undefined && { handoffMode: data.handoffMode }),
				};
			}
		}

		c.requestRender();
	}

	/**
	 * Return the currently active pane ('activity' or 'plan').
	 * Used by the status bar to show the pane indicator.
	 */
	getCurrentPane(): "activity" | "plan" {
		return this.component?.currentPane ?? "activity";
	}

	/**
	 * Remove all duet widgets and status entries.
	 * Call when the run ends, is aborted, or becomes idle.
	 */
	clear(): void {
		this.stopTick();
		this.ui.setStatus("duet", undefined);
		this.ui.setWidget("duet-workspace", undefined);
		this.widgetActive = false;
		this.latestState = null;
		this.component = null;
		this._activeChildInfo = undefined;
	}

	// --- Private helpers ---

	/**
	 * Create the widget component on first use.
	 * Guards against repeated calls — only calls setWidget once per run.
	 */
	private ensureWidget(): void {
		if (this.widgetActive) return;
		this.widgetActive = true;

		const self = this;
		this.ui.setWidget(
			"duet-workspace",
			(tui: TUI, theme: Theme) => {
				const comp = new WorkspaceComponent(theme, tui);
				self.component = comp;
				return comp;
			},
		);

		this.startTick();
	}

	/** Periodic tick to animate the spinner when a child is running. */
	private startTick(): void {
		if (this.tickInterval) return;
		this.tickInterval = setInterval(() => {
			const c = this.component;
			if (!c) return;
			const needsTick =
				c.activeChildInfo !== undefined ||
				c.stream.thinkingActive ||
				c.checkStatuses.some((cs) => cs.status === "running");
			if (needsTick) {
				c.requestRender();
				if (this.latestState) this.ui.setStatus("duet", this.buildStatus(this.latestState));
			}
		}, 120);
	}

	private stopTick(): void {
		if (this.tickInterval) {
			clearInterval(this.tickInterval);
			this.tickInterval = null;
		}
	}

	/**
	 * Build the compact status-bar text for the 'duet' key.
	 *
	 * Format: `duet:executing • step 2/5 • round:3 • implementer[claude-3-7]  type to steer • >> to note other`
	 */
	private buildStatus(state: DuetState): string {
		const hasRunningChecks = this.component?.checkStatuses.some((cs) => cs.status === "running") ?? false;
		const prefix = this._activeChildInfo || hasRunningChecks ? `${getSpinnerFrame()} ` : "";
		const parts: string[] = [`${prefix}duet:${state.phase}`];

		if (state.plan && state.stepIndex !== undefined) {
			parts.push(`step:${state.stepIndex + 1}/${state.plan.steps.length}`);
		}
		if (state.round !== undefined) {
			parts.push(`round:${state.round}`);
		}

		const child = this._activeChildInfo;
		if (child) {
			// Short model name: take last segment of "provider/model-name"
			const shortModel = child.model.split("/").pop() ?? child.model;
			parts.push(`${child.role}[${shortModel}]`);

			const elapsed = child.startedAt
				? fmtDur(Date.now() - new Date(child.startedAt).getTime())
				: "";
			if (elapsed) parts.push(elapsed);
		}

		if (state.pausedReason) {
			parts.push(`paused:${state.pausedReason}`);
		}

		// Cost summary — kept compact for the status bar
		if (this.component?.costLine) {
			parts.push(this.component.costLine);
		}

		const status = parts.join(" • ");

		if (child) {
			return `${status}  type to steer • >> to note other • alt+,/. panes`;
		}
		if (this.widgetActive) {
			return `${status}  alt+,/. panes`;
		}
		return status;
	}
}
