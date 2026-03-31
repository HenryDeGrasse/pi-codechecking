import { supportsXhigh } from "@mariozechner/pi-ai";
import type { ExtensionContext } from "@mariozechner/pi-coding-agent";
import type { ModelChoice } from "./models.js";
import type { ThinkingLevel } from "./types.js";

const THINKING_LEVEL_DESCRIPTIONS: Record<ThinkingLevel, string> = {
	off: "no extra reasoning",
	minimal: "minimal reasoning budget",
	low: "low reasoning effort",
	medium: "balanced reasoning effort",
	high: "high reasoning effort",
	xhigh: "maximum reasoning effort",
};

function optionLabel(choice: ModelChoice): string {
	return `${choice.key} — ${choice.description}`;
}

function thinkingOptionLabel(level: ThinkingLevel): string {
	return `${level} — ${THINKING_LEVEL_DESCRIPTIONS[level]}`;
}

function modelSupportsXhigh(choice: ModelChoice): boolean {
	if (supportsXhigh(choice.model)) return true;
	const provider = choice.model.provider.toLowerCase();
	const id = choice.model.id.toLowerCase();
	if (provider.includes("openai") && (id.includes("gpt-5.4") || id.includes("gpt-5-codex"))) return true;
	if (provider.includes("anthropic") && (id.includes("opus-4-6") || id.includes("opus-4.6"))) return true;
	return false;
}

function availableThinkingLevels(choice: ModelChoice): ThinkingLevel[] {
	if (!choice.model.reasoning) return ["off"];
	return modelSupportsXhigh(choice)
		? ["off", "minimal", "low", "medium", "high", "xhigh"]
		: ["off", "minimal", "low", "medium", "high"];
}

function normalizeThinkingLevel(choice: ModelChoice, level: ThinkingLevel | undefined): ThinkingLevel {
	const levels = availableThinkingLevels(choice);
	if (!level) return levels[0] ?? "off";
	if (levels.includes(level)) return level;
	if (level === "xhigh" && levels.includes("high")) return "high";
	return levels[0] ?? "off";
}

function sortChoices(
	choices: ModelChoice[],
	currentKey?: string,
	selectedKey?: string,
	defaultKey?: string,
): ModelChoice[] {
	return choices
		.map((choice, index) => ({ choice, index }))
		.sort((a, b) => {
			const rank = (key: string): number => {
				if (defaultKey && key === defaultKey) return 0;
				if (selectedKey && key === selectedKey) return 1;
				if (currentKey && key === currentKey) return 2;
				return 3;
			};
			const rankDiff = rank(a.choice.key) - rank(b.choice.key);
			if (rankDiff !== 0) return rankDiff;
			return a.index - b.index;
		})
		.map((entry) => entry.choice);
}

function sortThinkingLevels(levels: ThinkingLevel[], preferredLevel: ThinkingLevel): ThinkingLevel[] {
	return [...levels].sort((a, b) => {
		if (a === preferredLevel && b !== preferredLevel) return -1;
		if (b === preferredLevel && a !== preferredLevel) return 1;
		return 0;
	});
}

export async function pickModelChoice(
	ctx: ExtensionContext,
	title: string,
	choices: ModelChoice[],
	currentKey?: string,
	selectedKey?: string,
	defaultKey?: string,
): Promise<ModelChoice | undefined> {
	if (!ctx.hasUI) {
		throw new Error("Model selection requires interactive mode.");
	}
	if (choices.length === 0) return undefined;

	const orderedChoices = sortChoices(choices, currentKey, selectedKey, defaultKey);
	const optionToChoice = new Map<string, ModelChoice>();
	const options = orderedChoices.map((choice) => {
		const option = optionLabel(choice);
		optionToChoice.set(option, choice);
		return option;
	});

	const selected = await ctx.ui.select(title, options);
	if (!selected) return undefined;
	return optionToChoice.get(selected);
}

export async function pickThinkingLevel(
	ctx: ExtensionContext,
	title: string,
	choice: ModelChoice,
	currentLevel?: ThinkingLevel,
): Promise<ThinkingLevel | undefined> {
	if (!ctx.hasUI) {
		throw new Error("Thinking level selection requires interactive mode.");
	}

	const levels = availableThinkingLevels(choice);
	if (levels.length === 1) return levels[0];

	const effectiveCurrent = normalizeThinkingLevel(choice, currentLevel);
	const orderedLevels = sortThinkingLevels(levels, effectiveCurrent);
	const optionToLevel = new Map<string, ThinkingLevel>();
	const options = orderedLevels.map((level) => {
		const option = thinkingOptionLabel(level);
		optionToLevel.set(option, level);
		return option;
	});

	const selected = await ctx.ui.select(title, options);
	if (!selected) return undefined;
	return optionToLevel.get(selected);
}
