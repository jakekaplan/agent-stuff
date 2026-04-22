/**
 * Custom Footer Extension
 *
 * Row 1: cwd (branch) .............. push-state PR-link
 * Row 2: ↑in ↓out Rcache Wcache $cost usage%/max .. (provider) model • thinking
 *
 * Push state indicators:
 *   ✓    = committed + pushed
 *   *    = uncommitted tracked changes
 *   ↑N   = N unpushed commits
 *   *↑N  = uncommitted + unpushed
 *
 * PR link resolved via GitHub CLI; push state via git upstream tracking.
 */

import type { AssistantMessage } from "@mariozechner/pi-ai";
import {
	type BashOperations,
	type ExtensionAPI,
	type ExtensionContext,
} from "@mariozechner/pi-coding-agent";
import { truncateToWidth, visibleWidth } from "@mariozechner/pi-tui";
import { execFile, spawn } from "node:child_process";
import { stat } from "node:fs/promises";
import { homedir } from "node:os";
import { resolve as resolvePath } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

function formatPrLabel(url: string): string {
	const match = url.match(/github\.com\/([\w.-]+)\/([\w.-]+)\/pull\/(\d+)/);
	if (!match) return url;
	return `${match[1]}/${match[2]}#${match[3]}`;
}

function osc8Link(url: string, label: string): string {
	return `\x1b]8;;${url}\x07${label}\x1b]8;;\x07`;
}

function shortenHome(path: string): string {
	const home = homedir();
	return path.startsWith(home) ? "~" + path.slice(home.length) : path;
}

function rightAlign(left: string, right: string, width: number): string {
	const gap = Math.max(1, width - visibleWidth(left) - visibleWidth(right));
	return truncateToWidth(left + " ".repeat(gap) + right, width);
}

function fmtTokens(n: number): string {
	return n < 1000 ? `${n}` : `${(n / 1000).toFixed(1)}k`;
}

function normalizeBranch(branch: string | null | undefined): string | null {
	const value = branch?.trim();
	if (!value || value === "HEAD") return null;
	return value;
}

interface ParsedCdCommand {
	rawTarget: string;
	target: string | null;
	usePrevious: boolean;
}

interface BashExecResult {
	output: string;
	exitCode: number | undefined;
	cancelled: boolean;
	truncated: boolean;
	fullOutputPath?: string;
}

interface BashExecutionMessageLike {
	role: "bashExecution";
	command: string;
	exitCode: number | undefined;
	cancelled: boolean;
	timestamp: number;
}

function isBashExecutionMessageLike(message: unknown): message is BashExecutionMessageLike {
	if (!message || typeof message !== "object") return false;
	const value = message as Partial<BashExecutionMessageLike>;
	return (
		value.role === "bashExecution"
		&& typeof value.command === "string"
		&& typeof value.cancelled === "boolean"
		&& typeof value.timestamp === "number"
	);
}

function parseCdCommand(command: string): ParsedCdCommand | null {
	const trimmed = command.trim();
	const match = trimmed.match(/^cd(?:\s+(.+))?$/);
	if (!match) return null;

	let target = (match[1] ?? "~").trim();
	if (!target) target = "~";
	if (/[;&|`\n]/.test(target)) return null;

	if (
		(target.startsWith('"') && target.endsWith('"'))
		|| (target.startsWith("'") && target.endsWith("'"))
	) {
		target = target.slice(1, -1);
	}

	if (target === "-") return { rawTarget: target, target: null, usePrevious: true };
	if (target === "~") return { rawTarget: target, target: homedir(), usePrevious: false };
	if (target.startsWith("~/")) {
		return { rawTarget: target, target: resolvePath(homedir(), target.slice(2)), usePrevious: false };
	}

	return { rawTarget: target, target, usePrevious: false };
}

function resolveTrackedCwdState(ctx: ExtensionContext): { cwd: string; previousCwd: string | null } {
	let cwd = ctx.cwd;
	let previousCwd: string | null = null;

	for (const entry of ctx.sessionManager.getBranch()) {
		if (entry.type !== "message") continue;
		if (!isBashExecutionMessageLike(entry.message)) continue;
		if (entry.message.cancelled || entry.message.exitCode !== 0) continue;

		const parsed = parseCdCommand(entry.message.command);
		if (!parsed) continue;

		if (parsed.usePrevious) {
			if (!previousCwd) continue;
			[cwd, previousCwd] = [previousCwd, cwd];
			continue;
		}

		previousCwd = cwd;
		cwd = resolvePath(cwd, parsed.target!);
	}

	return { cwd, previousCwd };
}

function getLatestBashSignature(ctx: ExtensionContext): string {
	const branch = ctx.sessionManager.getBranch();
	for (let i = branch.length - 1; i >= 0; i -= 1) {
		const entry = branch[i];
		if (entry.type !== "message") continue;
		if (!isBashExecutionMessageLike(entry.message)) continue;
		return `${entry.message.timestamp}:${entry.message.command}:${entry.message.exitCode ?? ""}:${entry.message.cancelled ? 1 : 0}`;
	}
	return "";
}

interface PrLookup {
	url: string | null;
	headRefOid: string | null;
}

async function fetchLatestOpenPr(cwd: string, branch: string): Promise<PrLookup> {
	try {
		const { stdout } = await execFileAsync(
			"gh",
			["pr", "view", branch, "--json", "url,state,headRefOid"],
			{ cwd, timeout: 5000, maxBuffer: 1024 * 1024 },
		);
		const pr = JSON.parse(stdout || "{}") as { url?: string; state?: string; headRefOid?: string };
		if (pr.url && pr.state === "OPEN") {
			return { url: pr.url, headRefOid: pr.headRefOid ?? null };
		}
	} catch {
		// Fallback to list in case view fails for this branch/context.
	}

	try {
		const { stdout } = await execFileAsync(
			"gh",
			["pr", "list", "--state", "open", "--head", branch, "--json", "url,headRefOid", "--limit", "1"],
			{ cwd, timeout: 5000, maxBuffer: 1024 * 1024 },
		);
		const prs = JSON.parse(stdout || "[]") as Array<{ url?: string; headRefOid?: string }>;
		const pr = prs[0];
		return { url: pr?.url ?? null, headRefOid: pr?.headRefOid ?? null };
	} catch {
		return { url: null, headRefOid: null };
	}
}

async function fetchGitBranch(cwd: string): Promise<string | null> {
	try {
		const { stdout } = await execFileAsync("git", ["symbolic-ref", "--quiet", "--short", "HEAD"], {
			cwd,
			timeout: 3000,
			maxBuffer: 1024 * 1024,
		});
		return normalizeBranch(stdout);
	} catch {
		return null;
	}
}

async function handleCdCommand(
	command: string,
	cwd: string,
	previousCwd: string | null,
): Promise<{ cwd: string; previousCwd: string | null; result: BashExecResult } | null> {
	const parsed = parseCdCommand(command);
	if (!parsed) return null;

	if (parsed.usePrevious) {
		if (!previousCwd) {
			return {
				cwd,
				previousCwd,
				result: { output: "bash: cd: OLDPWD not set", exitCode: 1, cancelled: false, truncated: false },
			};
		}

		return {
			cwd: previousCwd,
			previousCwd: cwd,
			result: { output: `${previousCwd}\n`, exitCode: 0, cancelled: false, truncated: false },
		};
	}

	const nextCwd = resolvePath(cwd, parsed.target!);

	try {
		const nextStat = await stat(nextCwd);
		if (!nextStat.isDirectory()) {
			return {
				cwd,
				previousCwd,
				result: {
					output: `bash: cd: ${parsed.rawTarget}: Not a directory`,
					exitCode: 1,
					cancelled: false,
					truncated: false,
				},
			};
		}
	} catch (error) {
		const code = error && typeof error === "object" && "code" in error ? error.code : undefined;
		const message = code === "ENOENT" ? "No such file or directory" : "Unable to access directory";
		return {
			cwd,
			previousCwd,
			result: {
				output: `bash: cd: ${parsed.rawTarget}: ${message}`,
				exitCode: 1,
				cancelled: false,
				truncated: false,
			},
		};
	}

	return {
		cwd: nextCwd,
		previousCwd: cwd,
		result: { output: "", exitCode: 0, cancelled: false, truncated: false },
	};
}

function killShell(child: ReturnType<typeof spawn>) {
	if (!child.pid) return;
	try {
		process.kill(-child.pid, "SIGTERM");
	} catch {
		child.kill("SIGTERM");
	}
}

function createTrackedBashOperations(getCwd: () => string): BashOperations {
	return {
		exec(command, _cwd, { onData, signal, timeout, env }) {
			return new Promise((resolve, reject) => {
				const shell = process.env.SHELL || "/bin/bash";
				const child = spawn(shell, ["-lc", command], {
					cwd: getCwd(),
					env: env ?? process.env,
					stdio: ["ignore", "pipe", "pipe"],
					detached: true,
				});

				let settled = false;
				let timeoutId: NodeJS.Timeout | undefined;

				const cleanup = () => {
					if (timeoutId) clearTimeout(timeoutId);
					if (signal) signal.removeEventListener("abort", onAbort);
				};

				const finish = (fn: () => void) => {
					if (settled) return;
					settled = true;
					cleanup();
					fn();
				};

				const onAbort = () => killShell(child);

				child.stdout?.on("data", onData);
				child.stderr?.on("data", onData);

				child.on("error", (error) => {
					finish(() => reject(error));
				});

				child.on("close", (code) => {
					finish(() => resolve({ exitCode: code }));
				});

				if (timeout !== undefined && timeout > 0) {
					timeoutId = setTimeout(() => {
						killShell(child);
						finish(() => reject(new Error(`timeout:${timeout}`)));
					}, timeout * 1000);
				}

				if (signal) {
					if (signal.aborted) onAbort();
					else signal.addEventListener("abort", onAbort, { once: true });
				}
			});
		},
	};
}

async function fetchLocalGitState(
	cwd: string,
): Promise<{ headOid: string | null; dirty: boolean; ahead: number }> {
	let headOid: string | null = null;
	let dirty = false;
	let ahead = -1;

	try {
		const { stdout } = await execFileAsync("git", ["rev-parse", "HEAD"], {
			cwd,
			timeout: 3000,
			maxBuffer: 1024 * 1024,
		});
		headOid = stdout.trim() || null;
	} catch {
		headOid = null;
	}

	try {
		const { stdout } = await execFileAsync("git", ["status", "--porcelain", "--untracked-files=no"], {
			cwd,
			timeout: 3000,
			maxBuffer: 1024 * 1024,
		});
		dirty = stdout.trim().length > 0;
	} catch {
		dirty = false;
	}

	try {
		const { stdout } = await execFileAsync("git", ["rev-list", "--count", "@{upstream}..HEAD"], {
			cwd,
			timeout: 3000,
			maxBuffer: 1024 * 1024,
		});
		ahead = parseInt(stdout.trim(), 10) || 0;
	} catch {
		ahead = -1;
	}

	return { headOid, dirty, ahead };
}

function formatPushState(
	dirty: boolean,
	ahead: number,
	localHeadOid: string | null,
	prHeadOid: string | null,
): string {
	const parts: string[] = [];
	if (dirty) parts.push("*");

	let unpushed: boolean;
	if (ahead >= 0) {
		unpushed = ahead > 0;
		if (unpushed) parts.push(`↑${ahead}`);
	} else if (localHeadOid && prHeadOid) {
		unpushed = localHeadOid !== prHeadOid;
		if (unpushed) parts.push("↑");
	} else {
		return parts.join("");
	}

	if (!dirty && !unpushed) parts.push("✓");
	return parts.join("");
}

interface TokenStats {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	cost: number;
}

function computeStats(ctx: ExtensionContext): TokenStats {
	const stats: TokenStats = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 };
	for (const e of ctx.sessionManager.getBranch()) {
		if (e.type === "message" && e.message.role === "assistant") {
			const u = (e.message as AssistantMessage).usage;
			stats.input += u.input;
			stats.output += u.output;
			stats.cacheRead += u.cacheRead;
			stats.cacheWrite += u.cacheWrite;
			stats.cost += u.cost.total;
		}
	}
	return stats;
}

function renderRow1(
	cwd: string,
	branch: string | null,
	prUrl: string | null,
	localHeadOid: string | null,
	prHeadOid: string | null,
	dirty: boolean,
	ahead: number,
	theme: any,
	width: number,
): string {
	const branchStr = branch ? ` (${branch})` : "";
	const left = theme.fg("dim", `${shortenHome(cwd)}${branchStr}`);
	const showPrUrl = branch ? prUrl : null;
	const state = formatPushState(dirty, ahead, localHeadOid, prHeadOid);
	const label = showPrUrl ? formatPrLabel(showPrUrl) : "";
	const right = showPrUrl
		? theme.fg("dim", `${state ? `${state} ` : ""}${osc8Link(showPrUrl, label)}`)
		: state
			? theme.fg("dim", state)
			: "";
	return rightAlign(left, right, width);
}

function renderRow2(ctx: ExtensionContext, pi: ExtensionAPI, theme: any, width: number): string {
	const stats = computeStats(ctx);
	const usage = ctx.getContextUsage();
	const model = ctx.model;
	const thinking = pi.getThinkingLevel();

	const parts = [`↑${fmtTokens(stats.input)}`, `↓${fmtTokens(stats.output)}`];
	if (stats.cacheRead > 0) parts.push(`R${fmtTokens(stats.cacheRead)}`);
	if (stats.cacheWrite > 0) parts.push(`W${fmtTokens(stats.cacheWrite)}`);
	parts.push(`$${stats.cost.toFixed(3)}`);
	if (usage?.tokens != null && model) {
		const pct = ((usage.tokens / model.contextWindow) * 100).toFixed(1);
		parts.push(`${pct}%/${Math.round(model.contextWindow / 1000)}k`);
	}
	const left = theme.fg("dim", parts.join(" "));

	let right = "";
	if (model) {
		const thinkStr = thinking !== "off" ? ` • ${thinking}` : "";
		right = theme.fg("dim", `(${model.provider}) ${model.id}${thinkStr}`);
	}

	return rightAlign(left, right, width);
}

export default function (pi: ExtensionAPI) {
	let trackedCwd: string | null = null;
	let previousTrackedCwd: string | null = null;
	const trackedBashOperations = createTrackedBashOperations(() => trackedCwd ?? process.cwd());
	let runtimeActive = true;
	let prUrl: string | null = null;
	let prHeadOid: string | null = null;
	let localHeadOid: string | null = null;
	let localDirty = false;
	let localAhead = -1;
	let currentBranch: string | null = null;
	let lastRefreshSignature: string | null = null;
	let refreshVersion = 0;
	let requestRender: (() => void) | null = null;

	function clearGitState() {
		prUrl = null;
		prHeadOid = null;
		localHeadOid = null;
		localDirty = false;
		localAhead = -1;
		currentBranch = null;
	}

	function syncTrackedCwd(ctx: ExtensionContext) {
		const state = resolveTrackedCwdState(ctx);
		trackedCwd = state.cwd;
		previousTrackedCwd = state.previousCwd;
	}

	function getCurrentCwd(ctx: ExtensionContext): string {
		return trackedCwd ?? resolveTrackedCwdState(ctx).cwd;
	}

	function setTrackedCwd(nextCwd: string, previousCwd: string | null) {
		if (trackedCwd === nextCwd && previousTrackedCwd === previousCwd) return;
		trackedCwd = nextCwd;
		previousTrackedCwd = previousCwd;
		lastRefreshSignature = null;
		clearGitState();
		requestRender?.();
	}

	async function refreshFooterState(ctx: ExtensionContext) {
		if (!runtimeActive) return;
		const cwd = getCurrentCwd(ctx);
		const version = ++refreshVersion;
		const [branch, local] = await Promise.all([fetchGitBranch(cwd), fetchLocalGitState(cwd)]);
		const pr = branch ? await fetchLatestOpenPr(cwd, branch) : { url: null, headRefOid: null };

		if (!runtimeActive || version !== refreshVersion) return;

		trackedCwd = cwd;
		currentBranch = branch;
		prUrl = pr.url;
		prHeadOid = pr.headRefOid;
		localHeadOid = local.headOid;
		localDirty = local.dirty;
		localAhead = local.ahead;
		requestRender?.();
	}

	function ensureFreshFooterState(ctx: ExtensionContext) {
		if (!runtimeActive) return;
		const signature = `${getCurrentCwd(ctx)}|${getLatestBashSignature(ctx)}`;
		if (signature === lastRefreshSignature) return;
		lastRefreshSignature = signature;
		void refreshFooterState(ctx);
	}

	function resetFooterState() {
		lastRefreshSignature = null;
		refreshVersion += 1;
		trackedCwd = null;
		previousTrackedCwd = null;
		clearGitState();
	}

	function installFooter(ctx: ExtensionContext) {
		ctx.ui.setFooter((tui, theme, footerData) => {
			let footerActive = true;
			const rerender = () => tui.requestRender();
			requestRender = rerender;

			const updateBranch = () => {
				if (!runtimeActive || !footerActive) return;
				lastRefreshSignature = null;
				void refreshFooterState(ctx);
				rerender();
			};

			const unsub = footerData.onBranchChange(updateBranch);
			ensureFreshFooterState(ctx);

			return {
				dispose() {
					footerActive = false;
					if (requestRender === rerender) requestRender = null;
					resetFooterState();
					unsub();
				},
				invalidate() {},
				render(width: number): string[] {
					if (!runtimeActive || !footerActive) return [];
					ensureFreshFooterState(ctx);
					return [
						renderRow1(getCurrentCwd(ctx), currentBranch, prUrl, localHeadOid, prHeadOid, localDirty, localAhead, theme, width),
						renderRow2(ctx, pi, theme, width),
					];
				},
			};
		});
	}

	pi.on("session_start", async (_event, ctx) => {
		runtimeActive = true;
		syncTrackedCwd(ctx);
		installFooter(ctx);
	});

	pi.on("session_shutdown", async () => {
		runtimeActive = false;
		refreshVersion += 1;
	});

	pi.on("session_switch", async (_event, ctx) => {
		lastRefreshSignature = null;
		syncTrackedCwd(ctx);
		await refreshFooterState(ctx);
	});

	pi.on("user_bash", async (event, ctx) => {
		const cwd = getCurrentCwd(ctx);
		const handledCd = await handleCdCommand(event.command, cwd, previousTrackedCwd);
		if (handledCd) {
			setTrackedCwd(handledCd.cwd, handledCd.previousCwd);
			await refreshFooterState(ctx);
			return { result: handledCd.result };
		}

		return { operations: trackedBashOperations };
	});

	pi.on("agent_end", async (_event, ctx) => {
		lastRefreshSignature = null;
		syncTrackedCwd(ctx);
		await refreshFooterState(ctx);
	});
}
