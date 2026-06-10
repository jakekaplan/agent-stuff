import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import type { ExtensionAPI, Theme } from "@mariozechner/pi-coding-agent";

const MAX_OUTPUT_CHARS = 20_000;
const SIGKILL_DELAY_MS = 2_000;
const SPINNER_INTERVAL_MS = 120;
const SPINNER_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

function buildPrompt(extraInstructions: string): string {
	const extra = extraInstructions.trim();
	return `Review the current branch against the local base branch main.

Instructions:
- Do not edit files.
- Use the local main branch only. Do not fetch or contact remotes.
- Use git status first.
- Use git merge-base HEAD main, then review git diff <merge-base>...HEAD.
- Also review uncommitted changes with git diff and git diff --cached.
- Read files as needed.
- Return only concrete findings. No praise, summary, or commentary.
- Format each finding with severity, file:line when possible, issue, and suggested fix.
- If no findings, say exactly “No findings.”
${extra ? `\nExtra user instructions:\n${extra}\n` : ""}`;
}

function appendChunk(current: string, chunk: Buffer): string {
	const next = current + chunk.toString("utf8");
	if (next.length <= MAX_OUTPUT_CHARS) return next;
	return next.slice(next.length - MAX_OUTPUT_CHARS);
}

function formatOutput(value: string): string {
	const trimmed = value.trim();
	return trimmed || "No output.";
}

function buildSuccessMessage(stdout: string, stderr: string): string {
	const output = stdout.trim() || stderr.trim() || "No findings.";
	return `## Empty-context review findings\n\n${output}`;
}

function buildFailureMessage(code: number | null, signal: NodeJS.Signals | null, stdout: string, stderr: string): string {
	const status = signal ? `signal ${signal}` : `exit code ${code ?? "unknown"}`;
	return [
		"## Empty-context review failed",
		"",
		`Child pi exited with ${status}.`,
		"",
		"stderr:",
		"```",
		formatOutput(stderr),
		"```",
		"",
		"stdout:",
		"```",
		formatOutput(stdout),
		"```",
	].join("\n");
}

function killChild(child: ChildProcessWithoutNullStreams): void {
	if (child.exitCode !== null || child.signalCode !== null) return;

	child.kill("SIGTERM");
	setTimeout(() => {
		if (child.exitCode === null && child.signalCode === null) {
			child.kill("SIGKILL");
		}
	}, SIGKILL_DELAY_MS).unref();
}

function visibleLength(value: string): number {
	return value.replace(/\x1b\[[0-9;]*m/g, "").length;
}

function padLine(value: string, width: number): string {
	const visible = visibleLength(value);
	if (visible >= width) return value;
	return value + " ".repeat(width - visible);
}

class ReviewOverlay {
	constructor(
		private readonly theme: Theme,
		private readonly getCount: () => number,
		private readonly getFrame: () => string,
	) {}

	private box(lines: string[], width: number, title: string): string[] {
		const innerWidth = Math.max(1, width - 2);
		const titleText = ` ${title} `;
		const titleWidth = Math.min(titleText.length, innerWidth);
		const left = "─".repeat(Math.floor((innerWidth - titleWidth) / 2));
		const right = "─".repeat(Math.max(0, innerWidth - titleWidth - left.length));
		const output = [
			this.theme.fg("border", `╭${left}`) + this.theme.fg("accent", titleText) + this.theme.fg("border", `${right}╮`),
		];

		for (const line of lines) {
			output.push(this.theme.fg("border", "│") + padLine(line, innerWidth) + this.theme.fg("border", "│"));
		}

		output.push(this.theme.fg("border", `╰${"─".repeat(innerWidth)}╯`));
		return output;
	}

	render(width: number): string[] {
		const count = this.getCount();
		const suffix = count === 1 ? "process" : "processes";
		return this.box(
			[` ${this.theme.fg("accent", this.getFrame())} ${this.theme.fg("success", "Running")} ${this.theme.fg("dim", `${count} child ${suffix}`)}`],
			width,
			"Async review",
		);
	}

	invalidate(): void {}
	dispose(): void {}
}

export default function reviewAsync(pi: ExtensionAPI) {
	const running = new Set<ChildProcessWithoutNullStreams>();
	let shuttingDown = false;
	let spinnerFrame = 0;
	let spinnerTimer: ReturnType<typeof setInterval> | undefined;
	let closeOverlay: (() => void) | undefined;
	let requestOverlayRender: (() => void) | undefined;
	let overlayId = 0;

	function stopOverlay() {
		const close = closeOverlay;
		closeOverlay = undefined;
		requestOverlayRender = undefined;
		close?.();
	}

	pi.on("session_shutdown", async () => {
		shuttingDown = true;
		if (spinnerTimer) {
			clearInterval(spinnerTimer);
			spinnerTimer = undefined;
		}
		stopOverlay();
		for (const child of running) {
			killChild(child);
		}
	});

	pi.registerCommand("review-async", {
		description: "Run an empty-context background review against local main",
		handler: async (args, ctx) => {
			const openOverlay = () => {
				if (closeOverlay || ctx.mode !== "tui") return;

				const currentOverlayId = ++overlayId;
				void ctx.ui
					.custom<void>(
						(tui, theme, _keybindings, done) => {
							requestOverlayRender = () => tui.requestRender();
							closeOverlay = done;
							return new ReviewOverlay(
								theme,
								() => running.size,
								() => SPINNER_FRAMES[spinnerFrame % SPINNER_FRAMES.length] ?? "⠋",
							);
						},
						{
							overlay: true,
							overlayOptions: {
								anchor: "bottom-right",
								width: 32,
								maxHeight: 3,
								margin: { right: 2, bottom: 5 },
								nonCapturing: true,
							},
							onHandle: (handle) => handle.unfocus({ target: null }),
						},
					)
					.finally(() => {
						if (currentOverlayId !== overlayId) return;
						closeOverlay = undefined;
						requestOverlayRender = undefined;
					})
					.catch(() => {});
			};

			const updateStatus = () => {
				if (running.size === 0) {
					if (spinnerTimer) {
						clearInterval(spinnerTimer);
						spinnerTimer = undefined;
					}
					stopOverlay();
					return;
				}

				openOverlay();
				requestOverlayRender?.();
				if (spinnerTimer) return;

				spinnerTimer = setInterval(() => {
					spinnerFrame += 1;
					requestOverlayRender?.();
				}, SPINNER_INTERVAL_MS);
				if (typeof spinnerTimer === "object" && "unref" in spinnerTimer) {
					spinnerTimer.unref();
				}
			};
			let stdout = "";
			let stderr = "";
			let delivered = false;

			const child = spawn(
				"pi",
				[
					"-p",
					"--no-session",
					"--no-context-files",
					"--no-skills",
					"--no-prompt-templates",
					"--no-extensions",
					"--tools",
					"read,grep,find,ls,bash",
					"--thinking",
					"high",
					buildPrompt(args),
				],
				{
					cwd: ctx.cwd,
					stdio: ["ignore", "pipe", "pipe"],
				},
			);

			running.add(child);
			updateStatus();
			ctx.ui.notify("Async review started", "info");

			child.stdout.on("data", (chunk: Buffer) => {
				stdout = appendChunk(stdout, chunk);
			});

			child.stderr.on("data", (chunk: Buffer) => {
				stderr = appendChunk(stderr, chunk);
			});

			child.on("error", (error) => {
				running.delete(child);
				if (!shuttingDown) updateStatus();
				if (shuttingDown || delivered) return;
				delivered = true;
				pi.sendMessage(
					{
						customType: "review-async",
						content: `## Empty-context review failed\n\n${error.message}`,
						display: true,
					},
					{ deliverAs: "followUp" },
				);
			});

			child.on("close", (code, signal) => {
				running.delete(child);
				if (!shuttingDown) updateStatus();
				if (shuttingDown || delivered) return;
				delivered = true;

				const content = code === 0 ? buildSuccessMessage(stdout, stderr) : buildFailureMessage(code, signal, stdout, stderr);
				pi.sendMessage(
					{
						customType: "review-async",
						content,
						display: true,
						details: { code, signal },
					},
					{ deliverAs: "followUp" },
				);
			});
		},
	});
}
