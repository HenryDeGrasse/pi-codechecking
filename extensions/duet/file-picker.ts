import * as fs from "node:fs";
import * as path from "node:path";
import type { ExtensionContext } from "@mariozechner/pi-coding-agent";

const HIDDEN_DIRS_TO_SKIP = new Set([".git", "node_modules"]);

function shouldSkip(absPath: string, cwd: string, name: string): boolean {
	if (HIDDEN_DIRS_TO_SKIP.has(name)) return true;
	const rel = path.relative(cwd, absPath).replace(/\\/g, "/");
	if (rel === ".pi/duet" || rel.startsWith(".pi/duet/")) return true;
	return false;
}

function sortNames(values: string[]): string[] {
	return [...values].sort((a, b) => a.localeCompare(b, undefined, { sensitivity: "base" }));
}

export async function pickFileInRepo(
	ctx: ExtensionContext,
	title: string,
	cwd: string,
	startDir = cwd,
): Promise<string | undefined> {
	if (!ctx.hasUI) {
		throw new Error("File selection requires interactive mode.");
	}

	let currentDir = startDir;
	while (true) {
		const entries = fs
			.readdirSync(currentDir, { withFileTypes: true })
			.filter((entry) => !shouldSkip(path.join(currentDir, entry.name), cwd, entry.name));

		const dirs = sortNames(entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name));
		const files = sortNames(entries.filter((entry) => entry.isFile()).map((entry) => entry.name));
		const here = path.relative(cwd, currentDir).replace(/\\/g, "/") || ".";
		const options: string[] = [];
		const actions = new Map<string, { type: "up" | "dir" | "file" | "cancel"; value?: string }>();

		const cancel = "[cancel]";
		options.push(cancel);
		actions.set(cancel, { type: "cancel" });

		if (path.resolve(currentDir) !== path.resolve(cwd)) {
			const up = "[..] parent directory";
			options.push(up);
			actions.set(up, { type: "up" });
		}

		if (dirs.length > 0) options.push("--- directories ---");
		for (const dir of dirs) {
			const option = `[dir] ${dir}/`;
			options.push(option);
			actions.set(option, { type: "dir", value: dir });
		}

		if (files.length > 0) options.push("--- files ---");
		for (const file of files) {
			const option = `[file] ${file}`;
			options.push(option);
			actions.set(option, { type: "file", value: file });
		}

		const selected = await ctx.ui.select(`${title}\n${here}`, options);
		if (!selected) return undefined;
		const action = actions.get(selected);
		if (!action) continue;
		if (action.type === "cancel") return undefined;
		if (action.type === "up") {
			currentDir = path.dirname(currentDir);
			continue;
		}
		if (action.type === "dir") {
			currentDir = path.join(currentDir, action.value!);
			continue;
		}
		return path.relative(cwd, path.join(currentDir, action.value!)).replace(/\\/g, "/");
	}
}
