/**
 * Deep Research phase for duet.
 *
 * Runs a 3-stage pipeline before the planner+critic loop:
 *   1. Codebase crawl (via pi subprocess with read/ls/find/bash tools)
 *   2. Claude research + ChatGPT Deep Research (parallel, via web-research extension)
 *   3. ChatGPT Extended Pro synthesis (combines all three into actionable context)
 *
 * Output: research-context.md saved to the run directory, referenced by the planner.
 *
 * Requires the web-research extension to be installed and configured.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { runRoot } from "./fs.js";
import { runSide } from "./runner.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface DeepResearchResult {
	contextPath: string;           // absolute path to research-context.md
	contextRelPath: string;        // relative path from cwd
	codebaseReport: string;
	claudeResearch: string | null;
	gptDeepResearch: string | null;
	gptSynthesis: string;
	elapsed: number;               // total seconds
}

export interface DeepResearchCallbacks {
	onPhase: (phase: string) => void;
	onProgress: (msg: string) => void;
	signal?: AbortSignal;
}

// ---------------------------------------------------------------------------
// Check if web-research tools are available
// ---------------------------------------------------------------------------

/**
 * Returns true if both claude_research and chatgpt_research tools are registered.
 * Call this to decide whether to show the "deep research" menu option.
 */
export function hasWebResearchTools(getAllTools: () => Array<{ name: string }>): boolean {
	const tools = getAllTools();
	const names = new Set(tools.map(t => t.name));
	return names.has("claude_research") && names.has("chatgpt_research");
}

// ---------------------------------------------------------------------------
// Codebase scout prompt (lightweight — just structure + key files)
// ---------------------------------------------------------------------------

function codebaseScoutPrompt(goal: string): string {
	return [
		"You are a codebase scout gathering context for a planning task.",
		"Your job is to produce a structured report about this project — NOT to plan or implement anything.",
		"",
		`## Goal context`,
		`The user wants to: ${goal}`,
		"",
		"## What to explore",
		"",
		"1. **Project structure** — `ls` top-level directories, identify major modules (backend/frontend/shared/infra).",
		"2. **Tech stack** — read `package.json`, `tsconfig.json`, `build.gradle`, `pom.xml`, `Cargo.toml`, etc.",
		"   Note frameworks, key dependencies, and their versions.",
		"3. **Existing patterns** — read 2-3 representative files in areas relevant to the goal.",
		"   Note coding conventions, architecture patterns, naming conventions.",
		"4. **Related existing code** — find files/modules that the goal would touch or extend.",
		"   Read their interfaces, types, exports.",
		"5. **Test setup** — what test framework, where tests live, how they're structured.",
		"6. **Build/lint/CI** — what commands exist, what CI config looks like.",
		"",
		"## Output format",
		"",
		"Write a thorough report as plain text. Structure it as:",
		"",
		"### Project Structure",
		"(directory layout, key modules)",
		"",
		"### Tech Stack & Dependencies",
		"(frameworks, key packages and versions, language)",
		"",
		"### Relevant Existing Code",
		"(files/modules related to the goal, their interfaces, patterns used)",
		"",
		"### Conventions & Patterns",
		"(naming, architecture, error handling, how similar features are structured)",
		"",
		"### Test & Build Setup",
		"(test framework, directory, build commands, CI)",
		"",
		"Be factual and specific. Include actual file paths, function signatures, type names.",
		"Don't speculate — report what you find.",
	].join("\n");
}

// ---------------------------------------------------------------------------
// Synthesis prompt for Extended Pro
// ---------------------------------------------------------------------------

function synthesisPrompt(
	goal: string,
	codebaseReport: string,
	claudeResearch: string | null,
	gptDeepResearch: string | null,
): string {
	const sections: string[] = [
		"You are a senior technical architect synthesizing research for a coding task.",
		"Your output will be read by a planning agent that will create a step-by-step implementation plan.",
		"The planning agent has file-system tools (read, edit, write, bash) but NO web access.",
		"Everything it needs to know must be in your output.",
		"",
		"## Goal",
		goal,
		"",
		"## Codebase Analysis",
		"A scout agent explored the project and produced this report:",
		"",
		codebaseReport,
	];

	if (claudeResearch) {
		sections.push(
			"",
			"## Web Research (Claude — current docs, APIs, best practices)",
			"Claude searched the web for information relevant to this task:",
			"",
			claudeResearch,
		);
	}

	if (gptDeepResearch) {
		sections.push(
			"",
			"## Deep Research (ChatGPT — comprehensive domain investigation)",
			"ChatGPT performed comprehensive multi-source research on this topic:",
			"",
			gptDeepResearch,
		);
	}

	sections.push(
		"",
		"## Your Task",
		"",
		"Synthesize all of the above into a **technical context document** that gives the planning agent everything it needs to produce an accurate, concrete implementation plan.",
		"",
		"Structure your output as:",
		"",
		"### Technical Approach",
		"The recommended architecture/approach for this goal, grounded in what the codebase already does and what the research says.",
		"",
		"### Key APIs & Interfaces",
		"Exact import paths, function signatures, configuration patterns, and type definitions the implementation will need.",
		"Include both existing project interfaces to extend AND external library APIs from the research.",
		"",
		"### Implementation Considerations",
		"- Dependency ordering (what must exist before what)",
		"- Files/modules to create vs. modify",
		"- Patterns to follow (match existing codebase conventions)",
		"- Known gotchas, breaking changes, or compatibility issues from the research",
		"",
		"### Testing Strategy",
		"How to test this, based on the project's existing test setup and patterns.",
		"",
		"### Risks & Open Questions",
		"Anything uncertain, ambiguous, or potentially problematic that the planner should consider.",
		"",
		"Be concrete and specific — the planning agent will use this to write implementation steps.",
		"Include actual code snippets, config examples, and API signatures where helpful.",
		"Don't be vague ('use appropriate patterns') — state exactly which patterns, from which files.",
	);

	return sections.join("\n");
}

// ---------------------------------------------------------------------------
// Research query builders
// ---------------------------------------------------------------------------

function buildClaudeQuery(goal: string, codebaseReport: string): string {
	return [
		`I'm planning a coding task and need current web information.`,
		"",
		`**Goal:** ${goal}`,
		"",
		"**Project context (summarized):**",
		codebaseReport.slice(0, 2000),
		"",
		"Please research:",
		"1. Current documentation for any libraries/APIs this task will use — exact signatures, imports, configuration",
		"2. Known breaking changes, migration guides, or compatibility issues for the relevant dependency versions",
		"3. Current best practices and recommended patterns for this kind of implementation",
		"4. Any known gotchas, common mistakes, or issues others have encountered doing similar work",
		"",
		"Focus on actionable technical details — I need exact API info, not general advice.",
	].join("\n");
}

function buildDeepResearchQuery(goal: string, codebaseReport: string): string {
	return [
		`I'm planning a multi-step coding task and need comprehensive research.`,
		"",
		`**Goal:** ${goal}`,
		"",
		"**Project context (summarized):**",
		codebaseReport.slice(0, 2000),
		"",
		"Please thoroughly investigate:",
		"1. The best architectural approaches for this kind of task — compare alternatives with tradeoffs",
		"2. How production projects implement similar features — patterns, libraries, architecture decisions",
		"3. Potential pitfalls, edge cases, and failure modes to design around",
		"4. Testing strategies that work well for this kind of implementation",
		"5. Any relevant standards, RFCs, or specifications that should inform the design",
		"",
		"I need depth and breadth — this research will inform a detailed implementation plan.",
	].join("\n");
}

// ---------------------------------------------------------------------------
// Main entry point
// ---------------------------------------------------------------------------

/**
 * Run the deep research pipeline:
 *   1. Codebase crawl (pi subprocess)
 *   2. Claude research + GPT Deep Research (parallel, via imported functions)
 *   3. GPT Extended Pro synthesis
 *
 * Returns the path to the saved research-context.md file.
 */
export async function runDeepResearch(
	cwd: string,
	runId: string,
	goal: string,
	callbacks: DeepResearchCallbacks,
): Promise<DeepResearchResult> {
	const startTime = Date.now();
	const researchDir = path.join(runRoot(cwd, runId), "deep-research");
	fs.mkdirSync(researchDir, { recursive: true });

	// Dynamic import of web-research functions — these come from the web-research extension
	// which must be installed alongside duet. We import dynamically to avoid hard coupling
	// and to give a clear error if the extension isn't installed.
	let queryClaudeAI: (opts: any) => Promise<{ response: string; elapsed: number }>;
	let queryChatGPT: (opts: any) => Promise<{ response: string; elapsed: number }>;

	// Try multiple possible locations for the web-research extension
	const possiblePaths = [
		path.join(cwd, ".pi", "extensions", "web-research"),
		path.join(process.env.HOME ?? "", ".pi", "agent", "extensions", "web-research"),
	];

	let webResearchPath: string | null = null;
	for (const p of possiblePaths) {
		if (fs.existsSync(path.join(p, "claude.ts"))) {
			webResearchPath = p;
			break;
		}
	}

	if (!webResearchPath) {
		throw new Error(
			"Web research extension not found. Install it at .pi/extensions/web-research/ or ~/.pi/agent/extensions/web-research/\n" +
			"See the web-research extension README for setup instructions."
		);
	}

	try {
		const claudeModule = await import(path.join(webResearchPath, "claude.js"));
		const chatgptModule = await import(path.join(webResearchPath, "chatgpt.js"));
		queryClaudeAI = claudeModule.queryClaudeAI;
		queryChatGPT = chatgptModule.queryChatGPT;
	} catch (e: any) {
		throw new Error(`Failed to import web-research extension: ${e.message}`);
	}

	// ─── Stage 1: Codebase crawl ───────────────────────────────────────────
	callbacks.onPhase("Codebase crawl");
	callbacks.onProgress("Exploring project structure…");

	const scoutResult = await runSide({
		cwd,
		model: "anthropic/claude-sonnet-4",  // fast, cheap model for scouting
		thinkingLevel: "off",
		tools: ["read", "find", "ls", "bash", "grep"],
		prompt: codebaseScoutPrompt(goal),
		roleSystemAddendum: "You are a codebase scout. Explore thoroughly but quickly. Use tools to read actual files — don't guess.",
		artifactsDir: path.join(researchDir, "scout"),
		schemaName: "ScoutReport",
		validate: (v: unknown) => {
			// Scout returns plain text, not structured JSON — accept anything
			if (typeof v === "string" && v.length > 0) return { ok: true as const, value: v };
			return { ok: false as const, error: "Empty scout report" };
		},
		extractFromText: (text: string) => text, // Accept raw text output
		signal: callbacks.signal,
		onEvent: (e) => {
			if (e.type === "tool_start" && e.toolName) {
				callbacks.onProgress(`Scout: ${e.toolName} ${e.toolArgs?.slice(0, 60) ?? ""}`);
			}
		},
	});

	const codebaseReport = scoutResult.finalAssistantText;
	fs.writeFileSync(path.join(researchDir, "codebase-report.md"), codebaseReport, "utf8");
	callbacks.onProgress(`Codebase crawl complete (${codebaseReport.length} chars)`);

	// ─── Stage 2: Claude research + GPT Deep Research (parallel) ───────────
	callbacks.onPhase("Web research (parallel)");

	const claudeQuery = buildClaudeQuery(goal, codebaseReport);
	const deepResearchQuery = buildDeepResearchQuery(goal, codebaseReport);

	// Save queries for auditability
	fs.writeFileSync(path.join(researchDir, "claude-query.md"), claudeQuery, "utf8");
	fs.writeFileSync(path.join(researchDir, "deep-research-query.md"), deepResearchQuery, "utf8");

	// Run both in parallel
	callbacks.onProgress("Starting Claude research + ChatGPT Deep Research in parallel…");

	const [claudeResult, gptDRResult] = await Promise.allSettled([
		queryClaudeAI({
			query: claudeQuery,
			signal: callbacks.signal,
			onUpdate: (msg: string) => callbacks.onProgress(`Claude: ${msg}`),
		}),
		queryChatGPT({
			query: deepResearchQuery,
			mode: "deep_research" as const,
			signal: callbacks.signal,
			onUpdate: (msg: string) => callbacks.onProgress(`GPT Deep Research: ${msg}`),
		}),
	]);

	const claudeResearch = claudeResult.status === "fulfilled" ? claudeResult.value.response : null;
	const gptDeepResearch = gptDRResult.status === "fulfilled" ? gptDRResult.value.response : null;

	if (claudeResult.status === "rejected") {
		callbacks.onProgress(`⚠️ Claude research failed: ${claudeResult.reason?.message ?? "unknown"} — continuing without it`);
	} else {
		fs.writeFileSync(path.join(researchDir, "claude-research.md"), claudeResearch!, "utf8");
		callbacks.onProgress(`Claude research complete (${claudeResearch!.length} chars)`);
	}

	if (gptDRResult.status === "rejected") {
		callbacks.onProgress(`⚠️ GPT Deep Research failed: ${gptDRResult.reason?.message ?? "unknown"} — continuing without it`);
	} else {
		fs.writeFileSync(path.join(researchDir, "gpt-deep-research.md"), gptDeepResearch!, "utf8");
		callbacks.onProgress(`GPT Deep Research complete (${gptDeepResearch!.length} chars)`);
	}

	if (!claudeResearch && !gptDeepResearch) {
		callbacks.onProgress("⚠️ Both research tools failed — synthesis will use codebase report only");
	}

	// ─── Stage 3: GPT Extended Pro synthesis ───────────────────────────────
	callbacks.onPhase("Synthesis (Extended Pro)");
	callbacks.onProgress("Synthesizing all research into technical context…");

	const synthesisQuery = synthesisPrompt(goal, codebaseReport, claudeResearch, gptDeepResearch);
	fs.writeFileSync(path.join(researchDir, "synthesis-query.md"), synthesisQuery, "utf8");

	const synthesisResult = await queryChatGPT({
		query: synthesisQuery,
		mode: "extended_pro" as const,
		signal: callbacks.signal,
		onUpdate: (msg: string) => callbacks.onProgress(`Synthesis: ${msg}`),
	});

	const gptSynthesis = synthesisResult.response;
	fs.writeFileSync(path.join(researchDir, "synthesis.md"), gptSynthesis, "utf8");
	callbacks.onProgress(`Synthesis complete (${gptSynthesis.length} chars, ${synthesisResult.elapsed}s)`);

	// ─── Save combined research context ────────────────────────────────────
	const contextPath = path.join(runRoot(cwd, runId), "research-context.md");
	const contextRelPath = path.relative(cwd, contextPath);

	const contextDoc = [
		"# Deep Research Context",
		"",
		`> Goal: ${goal}`,
		`> Generated: ${new Date().toISOString()}`,
		"",
		"---",
		"",
		gptSynthesis,
		"",
		"---",
		"",
		"## Raw Research (for reference)",
		"",
		"<details>",
		"<summary>Codebase Scout Report</summary>",
		"",
		codebaseReport,
		"",
		"</details>",
		"",
		...(claudeResearch ? [
			"<details>",
			"<summary>Claude Web Research</summary>",
			"",
			claudeResearch,
			"",
			"</details>",
			"",
		] : []),
		...(gptDeepResearch ? [
			"<details>",
			"<summary>ChatGPT Deep Research</summary>",
			"",
			gptDeepResearch,
			"",
			"</details>",
		] : []),
	].join("\n");

	fs.writeFileSync(contextPath, contextDoc, "utf8");

	const elapsed = Math.round((Date.now() - startTime) / 1000);
	callbacks.onProgress(`Deep research complete in ${elapsed}s — saved to ${contextRelPath}`);

	return {
		contextPath,
		contextRelPath,
		codebaseReport,
		claudeResearch,
		gptDeepResearch,
		gptSynthesis,
		elapsed,
	};
}
