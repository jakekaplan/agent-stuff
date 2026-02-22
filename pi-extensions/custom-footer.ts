/**
 * Custom Footer Extension
 *
 * Row 1: cwd (branch) .................. PR link (clickable)
 * Row 2: ↑in ↓out Rcache Wcache $cost usage%/max .. (provider) model • thinking
 *
 * PR link detected from bash output (gh pr create/view, etc.)
 * and restored from session history on reload.
 */

import type { AssistantMessage } from "@mariozechner/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import { isBashToolResult } from "@mariozechner/pi-coding-agent";
import { truncateToWidth, visibleWidth } from "@mariozechner/pi-tui";
import { homedir } from "node:os";

const PR_URL_RE = /https:\/\/github\.com\/[\w.-]+\/[\w.-]+\/pull\/\d+/;

function extractPrUrl(text: string): string | null {
	const match = text.match(PR_URL_RE);
	return match ? match[0] : null;
}

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

function renderRow1(ctx: ExtensionContext, prUrl: string | null, footerData: any, theme: any, width: number): string {
	const branch = footerData.getGitBranch();
	const branchStr = branch ? ` (${branch})` : "";
	const left = theme.fg("dim", `${shortenHome(ctx.cwd)}${branchStr}`);
	const right = prUrl ? theme.fg("dim", osc8Link(prUrl, formatPrLabel(prUrl))) : "";
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

function scanBranchForPrUrl(ctx: ExtensionContext): string | null {
	let found: string | null = null;
	for (const entry of ctx.sessionManager.getBranch()) {
		if (entry.type !== "message") continue;
		if (entry.message.role !== "toolResult") continue;
		if (entry.message.toolName !== "bash") continue;
		for (const block of entry.message.content) {
			if (block.type === "text") {
				const url = extractPrUrl(block.text);
				if (url) found = url;
			}
		}
	}
	return found;
}

export default function (pi: ExtensionAPI) {
	let prUrl: string | null = null;

	function installFooter(ctx: ExtensionContext) {
		ctx.ui.setFooter((tui, theme, footerData) => {
			const unsub = footerData.onBranchChange(() => tui.requestRender());
			return {
				dispose: unsub,
				invalidate() {},
				render(width: number): string[] {
					return [
						renderRow1(ctx, prUrl, footerData, theme, width),
						renderRow2(ctx, pi, theme, width),
					];
				},
			};
		});
	}

	pi.on("session_start", async (_event, ctx) => {
		prUrl = scanBranchForPrUrl(ctx);
		installFooter(ctx);
	});

	pi.on("tool_result", async (event, _ctx) => {
		if (!isBashToolResult(event)) return;
		for (const block of event.content) {
			if (block.type === "text") {
				const url = extractPrUrl(block.text);
				if (url) prUrl = url;
			}
		}
	});
}
