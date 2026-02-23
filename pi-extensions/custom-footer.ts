/**
 * Custom Footer Extension
 *
 * Row 1: cwd (branch) .................. PR link (clickable)
 * Row 2: ↑in ↓out Rcache Wcache $cost usage%/max .. (provider) model • thinking
 *
 * PR link is resolved via GitHub CLI for the current branch.
 */

import type { AssistantMessage } from "@mariozechner/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import { truncateToWidth, visibleWidth } from "@mariozechner/pi-tui";
import { execFile } from "node:child_process";
import { homedir } from "node:os";
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

async function fetchLatestOpenPrUrl(cwd: string, branch: string): Promise<string | null> {
	try {
		const { stdout } = await execFileAsync(
			"gh",
			["pr", "view", branch, "--json", "url,state"],
			{ cwd, timeout: 5000, maxBuffer: 1024 * 1024 },
		);
		const pr = JSON.parse(stdout || "{}") as { url?: string; state?: string };
		if (pr.url && pr.state === "OPEN") return pr.url;
	} catch {
		// Fallback to list in case view fails for this branch/context.
	}

	try {
		const { stdout } = await execFileAsync(
			"gh",
			["pr", "list", "--state", "open", "--head", branch, "--json", "url", "--limit", "1"],
			{ cwd, timeout: 5000, maxBuffer: 1024 * 1024 },
		);
		const prs = JSON.parse(stdout || "[]") as Array<{ url?: string }>;
		return prs[0]?.url ?? null;
	} catch {
		return null;
	}
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
	ctx: ExtensionContext,
	prUrl: string | null,
	prBranch: string | null,
	footerData: any,
	theme: any,
	width: number,
): string {
	const branch = normalizeBranch(footerData.getGitBranch());
	const branchStr = branch ? ` (${branch})` : "";
	const left = theme.fg("dim", `${shortenHome(ctx.cwd)}${branchStr}`);
	const showPrUrl = branch && prBranch === branch ? prUrl : null;
	const right = showPrUrl ? theme.fg("dim", osc8Link(showPrUrl, formatPrLabel(showPrUrl))) : "";
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
	if (usage && model) {
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
	let prUrl: string | null = null;
	let prBranch: string | null = null;
	let currentBranch: string | null = null;
	let requestRender: (() => void) | null = null;

	async function refreshPrUrl(ctx: ExtensionContext, branch: string | null) {
		if (!branch) {
			prUrl = null;
			prBranch = null;
			requestRender?.();
			return;
		}

		prUrl = await fetchLatestOpenPrUrl(ctx.cwd, branch);
		prBranch = branch;
		requestRender?.();
	}

	function installFooter(ctx: ExtensionContext) {
		ctx.ui.setFooter((tui, theme, footerData) => {
			const rerender = () => tui.requestRender();
			requestRender = rerender;

			const updateBranch = () => {
				currentBranch = normalizeBranch(footerData.getGitBranch());
				void refreshPrUrl(ctx, currentBranch);
				rerender();
			};

			const unsub = footerData.onBranchChange(updateBranch);
			updateBranch();

			return {
				dispose() {
					if (requestRender === rerender) requestRender = null;
					unsub();
				},
				invalidate() {},
				render(width: number): string[] {
					return [
						renderRow1(ctx, prUrl, prBranch, footerData, theme, width),
						renderRow2(ctx, pi, theme, width),
					];
				},
			};
		});
	}

	pi.on("session_start", async (_event, ctx) => {
		installFooter(ctx);
	});

	pi.on("agent_end", async (_event, ctx) => {
		await refreshPrUrl(ctx, currentBranch);
	});
}
