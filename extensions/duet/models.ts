import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { modelsAreEqual, type Model } from "@mariozechner/pi-ai";
import type { ExtensionContext } from "@mariozechner/pi-coding-agent";
import { THINKING_LEVELS } from "./types.js";

export interface ModelChoice {
	key: string;
	label: string;
	description: string;
	model: Model<any>;
	source: "scoped" | "available";
}

const THINKING_LEVEL_SET = new Set<string>(THINKING_LEVELS);

function getAgentDir(): string {
	return process.env.PI_CODING_AGENT_DIR || path.join(os.homedir(), ".pi", "agent");
}

function readJsonIfExists(filePath: string): Record<string, unknown> | undefined {
	if (!fs.existsSync(filePath)) return undefined;
	try {
		const raw = fs.readFileSync(filePath, "utf8");
		const parsed = JSON.parse(raw) as unknown;
		return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
			? (parsed as Record<string, unknown>)
			: undefined;
	} catch {
		return undefined;
	}
}

function readEnabledModelPatterns(cwd: string): string[] | undefined {
	const globalSettingsPath = path.join(getAgentDir(), "settings.json");
	const projectSettingsPath = path.join(cwd, ".pi", "settings.json");
	const globalSettings = readJsonIfExists(globalSettingsPath);
	const projectSettings = readJsonIfExists(projectSettingsPath);
	const value = projectSettings?.enabledModels ?? globalSettings?.enabledModels;
	if (!Array.isArray(value)) return undefined;
	const patterns = value.filter((entry): entry is string => typeof entry === "string").map((entry) => entry.trim()).filter(Boolean);
	return patterns.length > 0 ? patterns : undefined;
}

function stripThinkingSuffix(pattern: string): string {
	const colonIndex = pattern.lastIndexOf(":");
	if (colonIndex === -1) return pattern;
	const suffix = pattern.slice(colonIndex + 1);
	if (!THINKING_LEVEL_SET.has(suffix)) return pattern;
	return pattern.slice(0, colonIndex);
}

function escapeRegex(text: string): string {
	// Note: `?` and `*` are intentionally excluded so globToRegex can convert them
	// to `.` and `.*` respectively after this call.
	return text.replace(/[|\\{}()[\]^$+.]/g, "\\$&");
}

function globToRegex(pattern: string): RegExp {
	const escaped = escapeRegex(pattern)
		.replace(/\*/g, ".*")
		.replace(/\?/g, ".");
	return new RegExp(`^${escaped}$`, "i");
}

function matchesPattern(model: Model<any>, rawPattern: string): boolean {
	const pattern = stripThinkingSuffix(rawPattern);
	const fullId = `${model.provider}/${model.id}`;
	const name = model.name || model.id;
	const hasGlob = pattern.includes("*") || pattern.includes("?");

	if (hasGlob) {
		const regex = globToRegex(pattern);
		return regex.test(fullId) || regex.test(model.id) || regex.test(name);
	}

	const normalized = pattern.toLowerCase();
	return (
		fullId.toLowerCase() === normalized ||
		model.id.toLowerCase() === normalized ||
		name.toLowerCase() === normalized ||
		fullId.toLowerCase().includes(normalized) ||
		model.id.toLowerCase().includes(normalized) ||
		name.toLowerCase().includes(normalized)
	);
}

function resolveScopedModels(patterns: string[], availableModels: Model<any>[]): Model<any>[] {
	const included: Model<any>[] = [];
	const excluded = new Set<string>();

	for (const pattern of patterns) {
		const isExclude = pattern.startsWith("!");
		const effectivePattern = isExclude ? pattern.slice(1) : pattern;
		if (!effectivePattern) continue;

		for (const model of availableModels) {
			if (!matchesPattern(model, effectivePattern)) continue;
			const key = `${model.provider}/${model.id}`;
			if (isExclude) {
				excluded.add(key);
				continue;
			}
			if (!included.find((entry) => modelsAreEqual(entry, model))) {
				included.push(model);
			}
		}
	}

	return included.filter((model) => !excluded.has(`${model.provider}/${model.id}`));
}

function sortModels(models: Model<any>[], currentModel: Model<any> | undefined): Model<any>[] {
	return [...models].sort((a, b) => {
		const aCurrent = modelsAreEqual(currentModel, a);
		const bCurrent = modelsAreEqual(currentModel, b);
		if (aCurrent && !bCurrent) return -1;
		if (!aCurrent && bCurrent) return 1;
		const providerCmp = a.provider.localeCompare(b.provider);
		if (providerCmp !== 0) return providerCmp;
		return a.id.localeCompare(b.id);
	});
}

export async function getScopedModelChoices(ctx: ExtensionContext): Promise<ModelChoice[]> {
	const availableModels = await ctx.modelRegistry.getAvailable();
	const scopedPatterns = readEnabledModelPatterns(ctx.cwd);
	const scopedModels = scopedPatterns ? resolveScopedModels(scopedPatterns, availableModels) : [];
	const chosen = scopedModels.length > 0 ? scopedModels : availableModels;
	const source: ModelChoice["source"] = scopedModels.length > 0 ? "scoped" : "available";

	return sortModels(chosen, ctx.model).map((model) => {
		const key = `${model.provider}/${model.id}`;
		const parts = [model.name || model.id];
		if (typeof model.contextWindow === "number") parts.push(`ctx ${model.contextWindow}`);
		if (model.reasoning) parts.push("reasoning");
		return {
			key,
			label: key,
			description: parts.join(" • "),
			model,
			source,
		};
	});
}
