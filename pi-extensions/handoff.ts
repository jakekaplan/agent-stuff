/**
 * /handoff <goal>
 *
 * Asks the current agent to build a self-contained handoff prompt, then the
 * agent calls launch_handoff to open a fresh Ghostty pi session with that prompt.
 */

import { mkdtempSync, writeFileSync } from "node:fs";
import { platform, tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Type } from "typebox";

const HANDOFF_PROVIDER = "openai-codex";
const HANDOFF_MODEL = "gpt-5.5";

const LAUNCH_HANDOFF_PARAMS = Type.Object({
	prompt: Type.String({
		description: "Complete self-contained prompt for the fresh pi session",
	}),
});

interface HandoffModel {
	provider: string;
	modelId: string;
}

function shellQuote(value: string): string {
	return `'${value.replace(/'/g, `'"'"'`)}'`;
}

function buildPrompt(goal: string): string {
	return `Prepare a fresh-context handoff prompt for another pi agent.

User goal:
${goal}

Rules:
- Do not implement the task in this session.
- Do not edit files in this session.
- Inspect the conversation, repo, plan files, git state, or relevant files only as needed to make the handoff accurate.
- Build one complete prompt for a new agent with no access to this conversation.
- Include the current repo/cwd, relevant branch or git status, the plan item or next task, files already discussed or changed, constraints, acceptance criteria, and checks/tests to run when relevant.
- Tell the new agent to re-read files and run git status before editing.
- Make the prompt actionable enough that the new agent can start immediately.
- Finish by calling launch_handoff with the complete prompt.
- Do not print the handoff prompt in chat unless launch_handoff fails.`;
}

function writePromptFile(prompt: string): string {
	const dir = mkdtempSync(join(tmpdir(), "pi-handoff-"));
	const path = join(dir, "prompt.md");
	writeFileSync(path, prompt.endsWith("\n") ? prompt : `${prompt}\n`, { mode: 0o600 });
	return path;
}

function buildPiCommand(promptFile: string, model: HandoffModel | undefined): string {
	let command = "exec pi";
	if (model) {
		command += ` --provider ${shellQuote(model.provider)} --model ${shellQuote(model.modelId)}`;
	}
	return `${command} ${shellQuote(`@${promptFile}`)} ${shellQuote("Execute the handoff prompt in the attached file.")}`;
}

async function resolveHandoffModel(ctx: {
	modelRegistry: {
		find: (provider: string, modelId: string) => unknown;
		getApiKeyAndHeaders?: (model: unknown) => Promise<{ ok: true } | { ok: false }>;
		getApiKey?: (model: unknown) => Promise<string | undefined>;
	};
}): Promise<HandoffModel | undefined> {
	const model = ctx.modelRegistry.find(HANDOFF_PROVIDER, HANDOFF_MODEL);
	if (!model) return undefined;

	if (typeof ctx.modelRegistry.getApiKeyAndHeaders === "function") {
		const auth = await ctx.modelRegistry.getApiKeyAndHeaders(model);
		return auth.ok ? { provider: HANDOFF_PROVIDER, modelId: HANDOFF_MODEL } : undefined;
	}

	if (typeof ctx.modelRegistry.getApiKey === "function") {
		const apiKey = await ctx.modelRegistry.getApiKey(model);
		return apiKey ? { provider: HANDOFF_PROVIDER, modelId: HANDOFF_MODEL } : undefined;
	}

	return { provider: HANDOFF_PROVIDER, modelId: HANDOFF_MODEL };
}

async function openGhostty(pi: ExtensionAPI, cwd: string, promptFile: string, model: HandoffModel | undefined): Promise<void> {
	if (platform() !== "darwin") {
		throw new Error("/handoff only supports Ghostty on macOS");
	}

	const command = `${buildPiCommand(promptFile, model)}\n`;
	const script = `
		on run argv
			set workdir to item 1 of argv
			set inputText to item 2 of argv
			tell application "Ghostty"
				set cfg to new surface configuration
				set initial working directory of cfg to workdir
				set initial input of cfg to inputText
				set wait after command of cfg to true
				new window with configuration cfg
				activate
			end tell
		end run
	`;
	const result = await pi.exec("osascript", ["-e", script, cwd, command], { timeout: 5000 });

	if (result.code !== 0) {
		const stderr = result.stderr.trim();
		const stdout = result.stdout.trim();
		throw new Error(stderr || stdout || "Ghostty launch failed");
	}
}

export default function handoff(pi: ExtensionAPI) {
	pi.registerTool({
		name: "launch_handoff",
		label: "Launch Handoff",
		description: "Open a fresh Ghostty pi session with a complete handoff prompt",
		promptSnippet: "Open a fresh Ghostty pi session with a complete handoff prompt",
		promptGuidelines: ["Use launch_handoff only after constructing the full prompt for a fresh-context handoff."],
		parameters: LAUNCH_HANDOFF_PARAMS,
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const prompt = params.prompt.trim();
			if (!prompt) {
				throw new Error("Handoff prompt is empty");
			}

			const promptFile = writePromptFile(prompt);
			const model = await resolveHandoffModel(ctx);
			await openGhostty(pi, ctx.cwd, promptFile, model);

			const modelText = model ? `${model.provider}/${model.modelId}` : "default model";
			ctx.ui.notify(`Handoff launched in Ghostty (${modelText})`, "info");
			return {
				content: [{ type: "text", text: `Fresh handoff launched in Ghostty using ${modelText}.` }],
				details: { model: modelText },
				terminate: true,
			};
		},
	});

	pi.registerCommand("handoff", {
		description: "Ask the current agent to build and launch a fresh-context handoff",
		handler: async (args, ctx) => {
			const goal = args.trim();
			if (!goal) {
				ctx.ui.notify("Usage: /handoff <goal>", "error");
				return;
			}

			await ctx.waitForIdle();
			pi.setActiveTools([...new Set([...pi.getActiveTools(), "launch_handoff"])]);
			pi.sendUserMessage(buildPrompt(goal));
		},
	});
}
