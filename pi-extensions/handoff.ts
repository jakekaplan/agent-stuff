/**
 * /handoff <prompt>
 *
 * Clones the current active session branch into a new persisted session file,
 * opens a new Ghostty window in the same cwd, and types an initial command that
 * runs `pi --session <new-session-file> <prompt>` there. The new session starts
 * with the same context path as this one, then diverges independently.
 */

import { existsSync } from "node:fs";
import { platform } from "node:os";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { SessionManager } from "@mariozechner/pi-coding-agent";

function shellQuote(value: string): string {
	return `'${value.replace(/'/g, `'"'"'`)}'`;
}

function buildPiCommand(sessionFile: string, prompt: string): string {
	return `exec pi --session ${shellQuote(sessionFile)} ${shellQuote(prompt)}`;
}

async function openGhostty(pi: ExtensionAPI, cwd: string, sessionFile: string, prompt: string): Promise<void> {
	if (platform() !== "darwin") {
		throw new Error("/handoff v1 only supports Ghostty on macOS");
	}

	const command = `${buildPiCommand(sessionFile, prompt)}\n`;
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
	pi.registerCommand("handoff", {
		description: "Clone current context into a new Ghostty window and run a prompt",
		handler: async (args, ctx) => {
			const prompt = args.trim();
			if (!prompt) {
				ctx.ui.notify("Usage: /handoff <prompt>", "error");
				return;
			}

			await ctx.waitForIdle();

			const sourceSessionFile = ctx.sessionManager.getSessionFile();
			if (!sourceSessionFile) {
				ctx.ui.notify("Current session is not persisted; cannot hand off", "error");
				return;
			}

			if (!existsSync(sourceSessionFile)) {
				ctx.ui.notify("Current session file does not exist yet; wait for an assistant response first", "error");
				return;
			}

			const leafId = ctx.sessionManager.getLeafId();
			if (!leafId) {
				ctx.ui.notify("No current context to hand off", "error");
				return;
			}

			let handoffSessionFile: string | undefined;
			try {
				const sessionDir = ctx.sessionManager.getSessionDir();
				const sourceSession = SessionManager.open(sourceSessionFile, sessionDir);
				handoffSessionFile = sourceSession.createBranchedSession(leafId);
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				ctx.ui.notify(`Failed to clone session: ${message}`, "error");
				return;
			}

			if (!handoffSessionFile) {
				ctx.ui.notify("Failed to create handoff session", "error");
				return;
			}

			try {
				await openGhostty(pi, ctx.cwd, handoffSessionFile, prompt);
				ctx.ui.notify("Handoff launched in Ghostty", "info");
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				ctx.ui.notify(`Failed to launch Ghostty: ${message}`, "error");
			}
		},
	});
}
