import { spawn, type ChildProcess } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import type { Message } from "@mariozechner/pi-ai";
import type { ThinkingLevel, Validator } from "./types.js";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface RunSideEvent {
	type: "thinking_start" | "thinking_delta" | "text_delta" | "tool_start" | "tool_end" | "message_end" | "turn_end" | "done";
	/** The new chunk of thinking text just received (raw delta). */
	thinkingDelta?: string;
	/** Accumulated thinking text so far (last ~2000 chars). */
	thinkingTail?: string;
	/** Total chars of thinking emitted so far. */
	thinkingLength?: number;
	/** The new chunk of output text just received (raw delta). */
	textDelta?: string;
	/** Accumulated output text so far (last ~2000 chars). */
	textTail?: string;
	/** Total chars of output text produced so far. */
	textLength?: number;
	/** Tool name (for tool_start / tool_end). */
	toolName?: string;
	/** Brief arg preview (for tool_start). */
	toolArgs?: string;
	/** Total tool calls made so far. */
	toolCount?: number;
	/** Milliseconds since runSide started. */
	elapsed?: number;
}

export interface RunSideOptions<T> {
	cwd: string;
	model: string;
	thinkingLevel?: ThinkingLevel;
	tools: readonly string[];
	prompt: string;
	roleSystemAddendum: string;
	artifactsDir: string;
	schemaName: string;
	validate: Validator<T>;
	allowRepair?: boolean;

	/** Streaming event callback — fired on every meaningful child event. */
	onEvent?: (event: RunSideEvent) => void;
	/** AbortSignal to kill the child process early (e.g. user Ctrl+C). */
	signal?: AbortSignal;
	/**
	 * Path to a file the model should write its structured result into.
	 * After the model finishes, the controller reads this file for JSON
	 * before falling back to parsing the text output. This lets the model
	 * use write/edit tools to build the result incrementally.
	 */
	resultFile?: string;
	/**
	 * Optional extractor that tries to parse structured data from the model's
	 * natural language text output (e.g. verdict footer parsing). Tried before
	 * JSON parsing. Return null/undefined to fall through to JSON.
	 */
	extractFromText?: (text: string) => unknown | null;
	/**
	 * Session directory for continuations. When set, uses `--continue --session-dir <dir>`
	 * so the model retains context across rounds (with pi's auto-compaction handling overflow).
	 * When unset, each call starts a fresh session.
	 */
	sessionDir?: string;
}

export interface RunSideResult<T> {
	messages: Message[];
	finalAssistantText: string;
	parsed: T;
	eventsPath: string;
	stderrPath: string;
	rawAssistantPath: string;
	parsedPath: string;
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function ensureDir(dir: string): void {
	fs.mkdirSync(dir, { recursive: true });
}

function getFileFingerprint(filePath: string): { mtimeMs: number; size: number } | undefined {
	try {
		const stat = fs.statSync(filePath);
		if (!stat.isFile()) return undefined;
		return { mtimeMs: stat.mtimeMs, size: stat.size };
	} catch {
		return undefined;
	}
}

function fileFingerprintChanged(
	before: { mtimeMs: number; size: number } | undefined,
	after: { mtimeMs: number; size: number } | undefined,
): boolean {
	if (!after) return false;
	if (!before) return true;
	return before.mtimeMs !== after.mtimeMs || before.size !== after.size;
}

/** Check if a session directory already has a session file (i.e. a previous round ran). */
function sessionExists(sessionDir: string): boolean {
	try {
		// pi stores sessions as .jsonl files in the session dir
		const entries = fs.readdirSync(sessionDir);
		return entries.some((e) => e.endsWith(".jsonl"));
	} catch {
		return false;
	}
}

function extractText(message: Message): string {
	if (message.role !== "assistant") return "";
	return message.content
		.filter((part): part is { type: "text"; text: string } => part.type === "text")
		.map((part) => part.text)
		.join("\n");
}

function tail(text: string, maxChars: number): string {
	if (text.length <= maxChars) return text;
	return text.slice(text.length - maxChars);
}

function collectBalancedObjectCandidates(text: string): string[] {
	const candidates: string[] = [];
	let depth = 0;
	let start = -1;
	let inString = false;
	let escaped = false;

	for (let i = 0; i < text.length; i++) {
		const char = text[i];
		if (inString) {
			if (escaped) {
				escaped = false;
				continue;
			}
			if (char === "\\") {
				escaped = true;
				continue;
			}
			if (char === '"') {
				inString = false;
			}
			continue;
		}

		if (char === '"') {
			inString = true;
			continue;
		}
		if (char === "{") {
			if (depth === 0) start = i;
			depth++;
			continue;
		}
		if (char === "}") {
			if (depth === 0) continue;
			depth--;
			if (depth === 0 && start !== -1) {
				candidates.push(text.slice(start, i + 1));
				start = -1;
			}
		}
	}

	return candidates;
}

function parseJsonPayload(text: string): { payload: string; parsed: unknown } {
	const trimmed = text.trim();
	const fenceMatches = Array.from(trimmed.matchAll(/```(?:json)?\s*([\s\S]*?)\s*```/gi)).map((match) => match[1].trim());
	const balancedObjects = collectBalancedObjectCandidates(trimmed).map((candidate) => candidate.trim());
	const candidates = [...fenceMatches.reverse(), ...balancedObjects.reverse(), trimmed];
	const seen = new Set<string>();
	const uniqueCandidates = candidates.filter((candidate) => {
		if (!candidate || seen.has(candidate)) return false;
		seen.add(candidate);
		return true;
	});

	let lastError: unknown;
	for (const candidate of uniqueCandidates) {
		try {
			return { payload: candidate, parsed: JSON.parse(candidate) };
		} catch (error) {
			lastError = error;
		}
	}

	throw lastError instanceof Error ? lastError : new Error("No valid JSON object found in assistant output");
}

function repairPrompt(schemaName: string, previousResponse: string): string {
	return [
		`Your previous response was invalid for schema ${schemaName}.`,
		"Return only valid JSON. You may wrap it in a ```json fenced block.",
		"Do not include any other commentary.",
		"",
		"Previous response:",
		previousResponse,
	].join("\n");
}

function nudgePrompt(schemaName: string, previousResponse: string): string {
	const truncated = previousResponse.length > 4000
		? `…${previousResponse.slice(-4000)}`
		: previousResponse;

	if (schemaName === "PlanReview" || schemaName === "ReviewReport") {
		return [
			"You completed your analysis but did not include the required verdict.",
			"Do not do any more work or use any tools.",
			"Based on your analysis, respond with ONLY the following:",
			"",
			"Verdict: approve",
			"or",
			"Verdict: changes_requested",
			"",
			"Blocking issues:",
			"- description of each blocking issue",
			"- or just: none",
			"",
			"Your previous analysis for reference:",
			truncated,
		].join("\n");
	}

	// For other schemas, fall back to repair-style prompt
	return repairPrompt(schemaName, previousResponse);
}

/** Truncate a tool args JSON string to a brief preview. */
function briefArgs(argsJson: string, maxLen = 60): string {
	try {
		const parsed = JSON.parse(argsJson);
		if (typeof parsed === "object" && parsed !== null) {
			const p = parsed.path ?? parsed.command ?? parsed.pattern;
			if (typeof p === "string") return p.length > maxLen ? `${p.slice(0, maxLen)}…` : p;
		}
	} catch { /* ignore */ }
	return argsJson.length > maxLen ? `${argsJson.slice(0, maxLen)}…` : argsJson;
}

function compactTextPreview(text: string, maxChars = 400): string {
	const normalized = text.replace(/\s+/g, " ").trim();
	if (normalized.length <= maxChars) return normalized;
	return `${normalized.slice(0, maxChars)}…`;
}

function writeCompactEvent(stream: fs.WriteStream, event: Record<string, unknown>): void {
	stream.write(`${JSON.stringify(event)}\n`);
}

// ---------------------------------------------------------------------------
// Main runner
// ---------------------------------------------------------------------------

export async function runSide<T>(options: RunSideOptions<T>): Promise<RunSideResult<T>> {
	ensureDir(options.artifactsDir);

	const eventsPath = path.join(options.artifactsDir, "events.jsonl");
	const stderrPath = path.join(options.artifactsDir, "stderr.txt");
	const rawAssistantPath = path.join(options.artifactsDir, "assistant.txt");
	const parsedPath = path.join(options.artifactsDir, "parsed.json");
	const systemPromptPath = path.join(options.artifactsDir, "system-prompt.txt");
	const initialResultFingerprint = options.resultFile ? getFileFingerprint(options.resultFile) : undefined;
	const eventsStream = fs.createWriteStream(eventsPath, { encoding: "utf8" });
	const stderrStream = fs.createWriteStream(stderrPath, { encoding: "utf8" });

	fs.writeFileSync(systemPromptPath, options.roleSystemAddendum, "utf8");

	// Detect whether a session already exists in the session dir (for --continue)
	const useSessionContinue = !!options.sessionDir && sessionExists(options.sessionDir);
	if (options.sessionDir) ensureDir(options.sessionDir);

	const args = [
		"--mode",
		"json",
		...(useSessionContinue ? ["--continue"] : []),
		...(options.sessionDir ? ["--session-dir", options.sessionDir] : []),
		"-p",
		"--thinking",
		options.thinkingLevel ?? "off",
		"--model",
		options.model,
		"--tools",
		options.tools.join(","),
		"--no-extensions",
		"--no-skills",
		"--no-prompt-templates",
		"--append-system-prompt",
		systemPromptPath,
	];

	const messages: Message[] = [];
	let latestAssistantText = "";
	let agentEndAssistantText = "";
	let stdoutBuffer = "";
	let stderrText = "";
	let aborted = false;
	const startTime = Date.now();

	// Streaming state for onEvent
	const emit = options.onEvent;
	let thinkingBuf = "";
	let textBuf = "";
	let toolCount = 0;
	let lastStopReason = "";

	function emitEvent(partial: Omit<RunSideEvent, "elapsed" | "toolCount" | "thinkingLength" | "thinkingTail" | "textLength" | "textTail">): void {
		if (!emit) return;
		emit({
			...partial,
			elapsed: Date.now() - startTime,
			toolCount,
			thinkingLength: thinkingBuf.length,
			thinkingTail: tail(thinkingBuf, 2000),
			textLength: textBuf.length,
			textTail: tail(textBuf, 2000),
		});
	}

	const exitCode = await new Promise<number>((resolve, reject) => {
		const proc = spawn("pi", args, {
			cwd: options.cwd,
			shell: false,
			stdio: ["pipe", "pipe", "pipe"],
			detached: true,
		});

		// Kill the entire process group (pi + all its children: bash, npm,
		// vitest workers, etc.) to prevent orphaned processes.
		const killTree = (sig: NodeJS.Signals) => {
			if (proc.pid) {
				try { process.kill(-proc.pid, sig); } catch { /* already dead */ }
			}
		};

		// Abort signal support
		if (options.signal) {
			if (options.signal.aborted) {
				aborted = true;
				killTree("SIGTERM");
			} else {
				const onAbort = () => {
					aborted = true;
					killTree("SIGTERM");
					setTimeout(() => killTree("SIGKILL"), 3000).unref();
				};
				options.signal.addEventListener("abort", onAbort, { once: true });
				proc.on("close", () => options.signal?.removeEventListener("abort", onAbort));
			}
		}

		const processLine = (line: string) => {
			if (!line.trim()) return;
			let event: any;
			try {
				event = JSON.parse(line);
			} catch {
				return;
			}

			// --- Streaming event dispatch ---
			if (event.type === "message_update" && event.assistantMessageEvent) {
				const sub = event.assistantMessageEvent;
				if (sub.type === "thinking_start") {
					writeCompactEvent(eventsStream, { t: Date.now() - startTime, type: "thinking_start" });
					emitEvent({ type: "thinking_start" });
				} else if (sub.type === "thinking_delta" && typeof sub.delta === "string") {
					thinkingBuf += sub.delta;
					emitEvent({ type: "thinking_delta", thinkingDelta: sub.delta });
				} else if (sub.type === "text_delta" && typeof sub.delta === "string") {
					textBuf += sub.delta;
					emitEvent({ type: "text_delta", textDelta: sub.delta });
				} else if (sub.type === "toolcall_end" && sub.toolCall) {
					// Tool call finished streaming — a tool execution will follow
				}
			}

			if (event.type === "tool_execution_start") {
				toolCount++;
				const toolArgs = event.args ? briefArgs(JSON.stringify(event.args)) : undefined;
				writeCompactEvent(eventsStream, {
					t: Date.now() - startTime,
					type: "tool_start",
					toolName: event.toolName,
					toolArgs,
				});
				emitEvent({
					type: "tool_start",
					toolName: event.toolName,
					toolArgs,
				});
			}
			if (event.type === "tool_execution_end") {
				writeCompactEvent(eventsStream, { t: Date.now() - startTime, type: "tool_end", toolName: event.toolName });
				emitEvent({ type: "tool_end", toolName: event.toolName });
			}

			if (event.type === "turn_end") {
				writeCompactEvent(eventsStream, {
					t: Date.now() - startTime,
					type: "turn_end",
					toolCount,
					thinkingLength: thinkingBuf.length,
					textLength: textBuf.length,
				});
				emitEvent({ type: "turn_end" });
			}

			// --- Result capture (existing logic) ---
			if (event.type === "message_end" && event.message) {
				const message = event.message as Message;
				messages.push(message);
				if (message.role === "assistant") {
					const text = extractText(message);
					if (text.trim()) {
						latestAssistantText = text;
					}
					writeCompactEvent(eventsStream, {
						t: Date.now() - startTime,
						type: "message_end",
						role: message.role,
						stopReason: (message as any).stopReason,
						textLength: text.length,
						textPreview: compactTextPreview(text),
					});
					// Track API errors (provider returned error before model could respond)
					if ((message as any).stopReason === "error") {
						lastStopReason = "error";
					}
				} else {
					writeCompactEvent(eventsStream, {
						t: Date.now() - startTime,
						type: "message_end",
						role: message.role,
					});
				}
				emitEvent({ type: "message_end" });
			}

			if (event.type === "agent_end" && Array.isArray(event.messages)) {
				for (const message of event.messages as Message[]) {
					if (message.role === "assistant") {
						const text = extractText(message);
						if (text.trim()) {
							agentEndAssistantText = text;
						}
					}
				}
				writeCompactEvent(eventsStream, {
					t: Date.now() - startTime,
					type: "agent_end",
					messageCount: event.messages.length,
					toolCount,
					thinkingLength: thinkingBuf.length,
					textLength: textBuf.length,
				});
			}
		};

		proc.stdin.on("error", () => {
			// Ignore broken pipe if the child exits before fully consuming stdin.
		});
		proc.stdin.end(options.prompt);

		proc.stdout.on("data", (chunk: Buffer | string) => {
			stdoutBuffer += chunk.toString();
			const lines = stdoutBuffer.split("\n");
			stdoutBuffer = lines.pop() ?? "";
			for (const line of lines) processLine(line);
		});

		proc.stderr.on("data", (chunk: Buffer | string) => {
			const text = chunk.toString();
			stderrText += text;
			stderrStream.write(text);
		});

		proc.on("error", (error) => {
			reject(error);
		});
		proc.on("close", (code) => {
			if (stdoutBuffer.trim()) processLine(stdoutBuffer);
			resolve(code ?? 0);
		});
	});

	eventsStream.end();
	stderrStream.end();

	// Emit final done event
	emitEvent({ type: "done" });

	if (aborted) {
		throw new Error("Child run aborted by user");
	}

	// ---------------------------------------------------------------------------
	// Collect usable text from assistant messages
	// ---------------------------------------------------------------------------

	// Primary sources: message_end captures, agent_end captures
	let bestText = latestAssistantText || agentEndAssistantText;

	// Fallback 1: salvage from earlier assistant turns in message log
	if (!bestText.trim()) {
		const assistantMessages = messages.filter((m) => m.role === "assistant");
		for (let i = assistantMessages.length - 1; i >= 0; i--) {
			const textParts = assistantMessages[i].content
				.filter((p: any) => p.type === "text" && typeof p.text === "string")
				.map((p: any) => p.text)
				.join("");
			if (textParts.trim()) {
				bestText = textParts;
				break;
			}
		}
	}

	// Fallback 2: use streamed text_delta accumulator.
	// If the process exited before message_end fired (API error, crash),
	// textBuf still has whatever was streamed. This is the key safety net.
	if (!bestText.trim() && textBuf.trim()) {
		bestText = textBuf;
	}

	fs.writeFileSync(rawAssistantPath, bestText, "utf8");
	const usableText = bestText;

	// ---------------------------------------------------------------------------
	// Structured data extraction — layered fallback
	// ---------------------------------------------------------------------------

	const makeResult = (value: unknown): RunSideResult<T> | null => {
		const validated = options.validate(value);
		if (!validated.ok) return null;
		fs.writeFileSync(parsedPath, `${JSON.stringify(validated.value, null, 2)}\n`, "utf8");
		return {
			messages,
			finalAssistantText: usableText,
			parsed: validated.value,
			eventsPath,
			stderrPath,
			rawAssistantPath,
			parsedPath,
		};
	};

	// Priority 1: Result file on disk (e.g. planner's draft-plan.json)
	// Only trust it if this run actually created or updated the file; otherwise we
	// might accidentally accept stale JSON left behind by an earlier round.
	if (options.resultFile) {
		try {
			const currentResultFingerprint = getFileFingerprint(options.resultFile);
			if (fileFingerprintChanged(initialResultFingerprint, currentResultFingerprint)) {
				const fileContent = fs.readFileSync(options.resultFile, "utf8").trim();
				if (fileContent) {
					const result = makeResult(parseJsonPayload(fileContent).parsed);
					if (result) return result;
				}
			}
		} catch { /* fall through */ }
	}

	// Priority 2: Extract from natural language (e.g. verdict footer)
	if (usableText.trim() && options.extractFromText) {
		const extracted = options.extractFromText(usableText);
		if (extracted !== null && extracted !== undefined) {
			const result = makeResult(extracted);
			if (result) return result;
		}
	}

	// Priority 3: Parse JSON from text (backward compat)
	if (usableText.trim()) {
		try {
			const result = makeResult(parseJsonPayload(usableText).parsed);
			if (result) return result;
		} catch { /* no valid JSON found */ }
	}

	// Priority 4: Nudge follow-up — ask model for just the control data
	if (usableText.trim() && options.allowRepair !== false) {
		const nudged = await runSide({
			...options,
			allowRepair: false,
			artifactsDir: path.join(options.artifactsDir, "nudge"),
			prompt: nudgePrompt(options.schemaName, usableText),
			onEvent: undefined,
			signal: options.signal,
		});
		return nudged;
	}

	// Priority 5: Auto-retry once on API errors that prevented text output
	if (!usableText.trim() && lastStopReason === "error" && options.allowRepair !== false) {
		// The API returned an error mid-conversation (e.g. transient server error).
		// Retry the entire call once before surfacing the error to the user.
		// Use fresh session (no --continue) since the errored session may be corrupt.
		return runSide({
			...options,
			allowRepair: false, // only retry once
			sessionDir: undefined,
			artifactsDir: path.join(options.artifactsDir, "retry"),
		});
	}

	// Priority 6: No text at all — hard error
	if (!usableText.trim()) {
		const stderrPreview = stderrText.trim();
		const suffix = stderrPreview ? `\n\nStderr:\n${stderrPreview}` : "";
		const assistantMessages = messages.filter((m) => m.role === "assistant");
		const toolCallCount = assistantMessages.reduce((sum, m) => sum + m.content.filter((p: any) => p.type === "toolCall").length, 0);
		const hint = toolCallCount > 0
			? ` (model made ${toolCallCount} tool calls across ${assistantMessages.length} turns without producing final text)`
			: "";
		const apiErr = lastStopReason === "error" ? " [API returned error]" : "";
		throw new Error(`Child run produced no assistant output (exit ${exitCode})${apiErr}${hint}${suffix}`);
	}

	// Fallback: text exists but nothing parsed and repair exhausted
	throw new Error(`No structured output found in ${options.schemaName} response`);
}
