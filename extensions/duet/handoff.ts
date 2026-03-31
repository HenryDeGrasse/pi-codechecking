/**
 * Handoff and operator notes management.
 *
 * Handles serializing the parent session conversation into a handoff
 * for child agents, persisting/loading handoff data, and managing
 * operator notes that steer the run.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import type { ExtensionContext } from "@mariozechner/pi-coding-agent";
import { ensureDir, runRoot, writeJson, writeText } from "./fs.js";
import type { HandoffMode } from "./types.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface RunHandoff {
	mode: Exclude<HandoffMode, "none">;
	content: string;
	sourceItemCount: number;
	summaryModel?: string;
}

interface StoredRunHandoff {
	mode: Exclude<HandoffMode, "none">;
	textPath: string;
	sourceItemCount: number;
	summaryModel?: string;
	createdAt: string;
}

const HANDOFF_MODE_VALUES: ReadonlySet<string> = new Set(["summary", "full", "custom"]);

// ---------------------------------------------------------------------------
// Content helpers
// ---------------------------------------------------------------------------

export function flattenStructuredContent(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) {
		if (content === undefined || content === null) return "";
		return JSON.stringify(content, null, 2);
	}
	return content
		.map((part) => {
			if (typeof part === "string") return part;
			if (!part || typeof part !== "object") return String(part);
			const record = part as Record<string, unknown>;
			if (record.type === "text" && typeof record.text === "string") return record.text;
			if (record.type === "image") return "[image]";
			return JSON.stringify(record, null, 2);
		})
		.filter((part) => part.trim().length > 0)
		.join("\n");
}

export function serializeSessionBranchForHandoff(ctx: ExtensionContext): { text: string; sourceItemCount: number } {
	const branch = ctx.sessionManager.getBranch();
	const chunks: string[] = [];
	let sourceItemCount = 0;

	for (const entry of branch as unknown as Array<{ type: string; [key: string]: unknown }>) {
		if (entry.type === "message") {
			const message = entry.message as { role?: string; content?: unknown; output?: unknown; result?: unknown } | undefined;
			if (!message?.role) continue;
			const rawContent = message.content ?? message.output ?? message.result ?? message;
			const body = flattenStructuredContent(rawContent).trim();
			if (!body) continue;
			sourceItemCount++;
			chunks.push(`## ${sourceItemCount}. ${message.role}\n${body}`);
			continue;
		}

		if (entry.type === "custom_message") {
			const customType = typeof entry.customType === "string" ? entry.customType : "custom";
			const body = flattenStructuredContent(entry.content).trim();
			if (!body) continue;
			sourceItemCount++;
			chunks.push(`## ${sourceItemCount}. custom:${customType}\n${body}`);
			continue;
		}

		if (entry.type === "compaction" && typeof entry.summary === "string" && entry.summary.trim().length > 0) {
			sourceItemCount++;
			chunks.push(`## ${sourceItemCount}. compaction-summary\n${entry.summary.trim()}`);
			continue;
		}

		if (entry.type === "branch_summary" && typeof entry.summary === "string" && entry.summary.trim().length > 0) {
			sourceItemCount++;
			chunks.push(`## ${sourceItemCount}. branch-summary\n${entry.summary.trim()}`);
		}
	}

	return {
		text: chunks.join("\n\n"),
		sourceItemCount,
	};
}

// ---------------------------------------------------------------------------
// Handoff persistence
// ---------------------------------------------------------------------------

function runHandoffTextPath(cwd: string, runId: string): string {
	return path.join(runRoot(cwd, runId), "handoff.txt");
}

function runHandoffMetadataPath(cwd: string, runId: string): string {
	return path.join(runRoot(cwd, runId), "handoff.json");
}

function runHandoffSourcePath(cwd: string, runId: string): string {
	return path.join(runRoot(cwd, runId), "handoff-source.txt");
}

export function saveRunHandoff(cwd: string, runId: string, handoff: RunHandoff, sourceText?: string): void {
	const textPath = runHandoffTextPath(cwd, runId);
	writeText(textPath, handoff.content);
	if (sourceText) writeText(runHandoffSourcePath(cwd, runId), sourceText);
	const metadata: StoredRunHandoff = {
		mode: handoff.mode,
		textPath: path.basename(textPath),
		sourceItemCount: handoff.sourceItemCount,
		summaryModel: handoff.summaryModel,
		createdAt: new Date().toISOString(),
	};
	writeJson(runHandoffMetadataPath(cwd, runId), metadata);
}

export function loadRunHandoff(cwd: string, runId: string): RunHandoff | undefined {
	try {
		const metadataPath = runHandoffMetadataPath(cwd, runId);
		if (!fs.existsSync(metadataPath)) return undefined;
		const metadata = JSON.parse(fs.readFileSync(metadataPath, "utf8")) as Partial<StoredRunHandoff>;
		if (!HANDOFF_MODE_VALUES.has(metadata.mode ?? "")) return undefined;
		const relativeTextPath = typeof metadata.textPath === "string" && metadata.textPath.trim().length > 0 ? metadata.textPath : "handoff.txt";
		const textPath = path.isAbsolute(relativeTextPath) ? relativeTextPath : path.join(runRoot(cwd, runId), relativeTextPath);
		if (!fs.existsSync(textPath)) return undefined;
		return {
			mode: metadata.mode as Exclude<HandoffMode, "none">,
			content: fs.readFileSync(textPath, "utf8"),
			sourceItemCount: typeof metadata.sourceItemCount === "number" ? metadata.sourceItemCount : 0,
			summaryModel: typeof metadata.summaryModel === "string" ? metadata.summaryModel : undefined,
		};
	} catch {
		return undefined;
	}
}

// ---------------------------------------------------------------------------
// Operator notes
// ---------------------------------------------------------------------------

export function runOperatorNotesPath(cwd: string, runId: string): string {
	return path.join(runRoot(cwd, runId), "operator-notes.md");
}

export function loadRunOperatorNotes(cwd: string, runId: string): string | undefined {
	const notesPath = runOperatorNotesPath(cwd, runId);
	if (!fs.existsSync(notesPath)) return undefined;
	try {
		const text = fs.readFileSync(notesPath, "utf8").trim();
		return text.length > 0 ? text : undefined;
	} catch {
		return undefined;
	}
}

export function appendRunOperatorNote(cwd: string, runId: string, note: string): void {
	const notesPath = runOperatorNotesPath(cwd, runId);
	ensureDir(path.dirname(notesPath));
	const existing = fs.existsSync(notesPath) ? fs.readFileSync(notesPath, "utf8").trimEnd() : "";
	const entry = [
		`## Operator note — ${new Date().toISOString()}`,
		note.trim(),
	].join("\n\n");
	const next = existing ? `${existing}\n\n${entry}\n` : `${entry}\n`;
	fs.writeFileSync(notesPath, next, "utf8");
}
