import {
	BorderedLoader,
	DynamicBorder,
	getLanguageFromPath,
	highlightCode,
	type ExtensionAPI,
	type ExtensionCommandContext,
} from "@mariozechner/pi-coding-agent";
import {
	Container,
	matchesKey,
	type SelectItem,
	SelectList,
	Text,
	truncateToWidth,
	type TUI,
	visibleWidth,
	wrapTextWithAnsi,
} from "@mariozechner/pi-tui";

type DiffTarget =
	| { type: "uncommitted" }
	| { type: "branch"; branch: string }
	| { type: "commit"; sha: string; title?: string };

type ParsedDiffLine = {
	type: "context" | "add" | "remove";
	text: string;
	oldLineNumber: number | null;
	newLineNumber: number | null;
};

type ParsedHunk = {
	header: string;
	lines: ParsedDiffLine[];
};

type DiffStatus = "modified" | "added" | "deleted" | "renamed";

type ParsedDiffFile = {
	oldPath: string;
	newPath: string;
	status: DiffStatus;
	isBinary: boolean;
	oldMode?: string;
	newMode?: string;
	additions: number;
	deletions: number;
	hunks: ParsedHunk[];
	maxOldLineNumber: number;
	maxNewLineNumber: number;
};

type DiffSnapshot = {
	target: DiffTarget;
	targetLabel: string;
	files: ParsedDiffFile[];
	generatedAt: number;
};

type SplitRow =
	| { type: "hunk"; header: string }
	| {
			type: "line";
			left?: ParsedDiffLine;
			right?: ParsedDiffLine;
	  };

function cleanDiffPath(path: string): string {
	if (path.startsWith("a/")) return path.slice(2);
	if (path.startsWith("b/")) return path.slice(2);
	if (path === "/dev/null") return "";
	if (path.startsWith("\"") && path.endsWith("\"")) {
		return path.slice(1, -1).replaceAll('\\"', '"');
	}
	return path;
}

function parseDiffFiles(diffText: string): ParsedDiffFile[] {
	const lines = diffText.split("\n");
	const files: ParsedDiffFile[] = [];
	let currentFile: ParsedDiffFile | null = null;
	let currentHunk: ParsedHunk | null = null;
	let currentOldLine = 0;
	let currentNewLine = 0;

	const commitCurrent = () => {
		if (!currentFile) return;
		if (currentFile.status === "modified") {
			if (currentFile.oldPath && !currentFile.newPath) currentFile.status = "deleted";
			if (!currentFile.oldPath && currentFile.newPath) currentFile.status = "added";
		}
		files.push(currentFile);
		currentFile = null;
		currentHunk = null;
	};

	for (const line of lines) {
		if (line.startsWith("diff --git ")) {
			commitCurrent();
			const match = line.match(/^diff --git (.+) (.+)$/);
			const oldPath = cleanDiffPath(match?.[1] ?? "");
			const newPath = cleanDiffPath(match?.[2] ?? "");
			currentFile = {
				oldPath,
				newPath,
				status: "modified",
				isBinary: false,
				additions: 0,
				deletions: 0,
				hunks: [],
				maxOldLineNumber: 0,
				maxNewLineNumber: 0,
			};
			continue;
		}

		if (!currentFile) continue;

		if (line.startsWith("new file mode ")) {
			currentFile.status = "added";
			currentFile.newMode = line.slice("new file mode ".length).trim();
			continue;
		}
		if (line.startsWith("deleted file mode ")) {
			currentFile.status = "deleted";
			currentFile.oldMode = line.slice("deleted file mode ".length).trim();
			continue;
		}
		if (line.startsWith("old mode ")) {
			currentFile.oldMode = line.slice("old mode ".length).trim();
			continue;
		}
		if (line.startsWith("new mode ")) {
			currentFile.newMode = line.slice("new mode ".length).trim();
			continue;
		}
		if (line.startsWith("rename from ")) {
			currentFile.status = "renamed";
			currentFile.oldPath = line.slice("rename from ".length).trim();
			continue;
		}
		if (line.startsWith("rename to ")) {
			currentFile.status = "renamed";
			currentFile.newPath = line.slice("rename to ".length).trim();
			continue;
		}
		if (line.startsWith("--- ")) {
			currentFile.oldPath = cleanDiffPath(line.slice(4).trim()) || currentFile.oldPath;
			continue;
		}
		if (line.startsWith("+++ ")) {
			currentFile.newPath = cleanDiffPath(line.slice(4).trim()) || currentFile.newPath;
			continue;
		}
		if (line.startsWith("Binary files ") || line.startsWith("GIT binary patch")) {
			currentFile.isBinary = true;
			continue;
		}

		const hunkMatch = line.match(/^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@(.*)$/);
		if (hunkMatch) {
			currentOldLine = Number.parseInt(hunkMatch[1] ?? "0", 10);
			currentNewLine = Number.parseInt(hunkMatch[2] ?? "0", 10);
			currentHunk = { header: line, lines: [] };
			currentFile.hunks.push(currentHunk);
			continue;
		}

		if (!currentHunk) continue;

		if (line.startsWith("+")) {
			currentFile.additions += 1;
			currentFile.maxNewLineNumber = Math.max(currentFile.maxNewLineNumber, currentNewLine);
			currentHunk.lines.push({
				type: "add",
				text: line.slice(1),
				oldLineNumber: null,
				newLineNumber: currentNewLine,
			});
			currentNewLine += 1;
			continue;
		}
		if (line.startsWith("-")) {
			currentFile.deletions += 1;
			currentFile.maxOldLineNumber = Math.max(currentFile.maxOldLineNumber, currentOldLine);
			currentHunk.lines.push({
				type: "remove",
				text: line.slice(1),
				oldLineNumber: currentOldLine,
				newLineNumber: null,
			});
			currentOldLine += 1;
			continue;
		}
		if (line.startsWith(" ")) {
			currentFile.maxOldLineNumber = Math.max(currentFile.maxOldLineNumber, currentOldLine);
			currentFile.maxNewLineNumber = Math.max(currentFile.maxNewLineNumber, currentNewLine);
			currentHunk.lines.push({
				type: "context",
				text: line.slice(1),
				oldLineNumber: currentOldLine,
				newLineNumber: currentNewLine,
			});
			currentOldLine += 1;
			currentNewLine += 1;
		}
	}

	commitCurrent();
	return files;
}

function toSplitRows(file: ParsedDiffFile): SplitRow[] {
	const rows: SplitRow[] = [];
	for (const hunk of file.hunks) {
		rows.push({ type: "hunk", header: hunk.header });
		let idx = 0;
		while (idx < hunk.lines.length) {
			const current = hunk.lines[idx];
			if (!current) break;
			if (current.type === "context") {
				rows.push({ type: "line", left: current, right: current });
				idx += 1;
				continue;
			}

			const removes: ParsedDiffLine[] = [];
			const adds: ParsedDiffLine[] = [];
			while (idx < hunk.lines.length) {
				const next = hunk.lines[idx];
				if (!next || next.type === "context") break;
				if (next.type === "remove") removes.push(next);
				if (next.type === "add") adds.push(next);
				idx += 1;
			}

			const blockRows = Math.max(removes.length, adds.length);
			for (let i = 0; i < blockRows; i += 1) {
				rows.push({ type: "line", left: removes[i], right: adds[i] });
			}
		}
	}
	return rows;
}

async function inGitRepo(pi: ExtensionAPI): Promise<boolean> {
	const { code } = await pi.exec("git", ["rev-parse", "--git-dir"]);
	return code === 0;
}

async function getLocalBranches(pi: ExtensionAPI): Promise<string[]> {
	const { stdout, code } = await pi.exec("git", ["branch", "--format=%(refname:short)"]);
	if (code !== 0) return [];
	return stdout
		.split("\n")
		.map((item) => item.trim())
		.filter(Boolean);
}

async function getCurrentBranch(pi: ExtensionAPI): Promise<string | null> {
	const { stdout, code } = await pi.exec("git", ["branch", "--show-current"]);
	if (code !== 0) return null;
	const branch = stdout.trim();
	return branch || null;
}

function normalizeBranchRef(branch: string): string {
	let normalized = branch.trim();
	if (normalized.startsWith("refs/heads/")) normalized = normalized.slice("refs/heads/".length);
	if (normalized.startsWith("origin/")) normalized = normalized.slice("origin/".length);
	return normalized;
}

async function getParentBranchFromReflog(pi: ExtensionAPI, currentBranch: string, branches: string[]): Promise<string | null> {
	const { stdout, code } = await pi.exec("git", ["reflog", "show", "--format=%gs", "-n", "50", currentBranch]);
	if (code !== 0) return null;

	for (const line of stdout.split("\n")) {
		const match = line.match(/branch:\s+Created\s+from\s+(.+)$/i);
		if (!match?.[1]) continue;
		const candidate = normalizeBranchRef(match[1]);
		if (!candidate || candidate === "HEAD") continue;
		if (!branches.includes(candidate)) continue;
		if (candidate === currentBranch) continue;
		return candidate;
	}

	return null;
}

async function getParentBranchByMergeBase(pi: ExtensionAPI, currentBranch: string, branches: string[]): Promise<string | null> {
	let bestBranch: string | null = null;
	let bestTimestamp = -1;

	for (const branch of branches) {
		if (branch === currentBranch) continue;
		const mergeBase = await pi.exec("git", ["merge-base", currentBranch, branch]);
		if (mergeBase.code !== 0 || !mergeBase.stdout.trim()) continue;
		const baseSha = mergeBase.stdout.trim();
		const baseTime = await pi.exec("git", ["show", "-s", "--format=%ct", baseSha]);
		if (baseTime.code !== 0 || !baseTime.stdout.trim()) continue;
		const timestamp = Number.parseInt(baseTime.stdout.trim(), 10);
		if (!Number.isFinite(timestamp)) continue;
		if (timestamp > bestTimestamp) {
			bestTimestamp = timestamp;
			bestBranch = branch;
		}
	}

	return bestBranch;
}

async function getLikelyParentBranch(pi: ExtensionAPI, currentBranch: string, branches: string[]): Promise<string | null> {
	const fromReflog = await getParentBranchFromReflog(pi, currentBranch, branches);
	if (fromReflog) return fromReflog;
	return getParentBranchByMergeBase(pi, currentBranch, branches);
}

async function getRecentCommits(pi: ExtensionAPI, limit = 30): Promise<Array<{ sha: string; title: string }>> {
	const { stdout, code } = await pi.exec("git", ["log", `--oneline`, `-n`, `${limit}`]);
	if (code !== 0) return [];
	return stdout
		.split("\n")
		.map((line) => line.trim())
		.filter(Boolean)
		.map((line) => {
			const [sha = "", ...rest] = line.split(" ");
			return { sha, title: rest.join(" ") };
		});
}

async function resolveDiffTarget(ctx: ExtensionCommandContext, pi: ExtensionAPI, args: string | undefined): Promise<DiffTarget | null> {
	const parseArgs = (raw: string | undefined): DiffTarget | null => {
		if (!raw?.trim()) return null;
		const parts = raw.trim().split(/\s+/);
		const command = parts[0]?.toLowerCase();
		if (command === "uncommitted") return { type: "uncommitted" };
		if (command === "branch" && parts[1]) return { type: "branch", branch: parts[1] };
		if (command === "commit" && parts[1]) return { type: "commit", sha: parts[1] };
		return null;
	};

	const fromArgs = parseArgs(args);
	if (fromArgs) return fromArgs;
	if (args?.trim()) {
		ctx.ui.notify("Usage: /diff [uncommitted | branch <name> | commit <sha>]", "warning");
	}

	const mode = await ctx.ui.select("Select diff source", ["Compare against branch", "Uncommitted changes", "Show commit diff"]);
	if (!mode) return null;
	if (mode === "Compare against branch") return showBranchSelector(ctx, pi);
	if (mode === "Uncommitted changes") return { type: "uncommitted" };
	return showCommitSelector(ctx, pi);
}

async function showBranchSelector(ctx: ExtensionCommandContext, pi: ExtensionAPI): Promise<DiffTarget | null> {
	const branches = await getLocalBranches(pi);
	if (branches.length === 0) {
		ctx.ui.notify("No local branches found", "error");
		return null;
	}

	const currentBranch = await getCurrentBranch(pi);
	const preferredBranches: string[] = [];
	if (branches.includes("main")) preferredBranches.push("main");

	if (currentBranch) {
		const parentBranch = await getLikelyParentBranch(pi, currentBranch, branches);
		if (parentBranch && !preferredBranches.includes(parentBranch)) preferredBranches.push(parentBranch);
	}

	let candidates = preferredBranches;
	if (candidates.length === 0) {
		candidates = branches.filter((branch) => branch !== currentBranch);
	}

	if (candidates.length === 0 && currentBranch) {
		candidates = [currentBranch];
	}

	const items: SelectItem[] = candidates.map((branch, index) => ({
		value: branch,
		label: branch,
		description: index === 0 && branch === "main" ? "(main)" : "",
	}));

	const selected = await ctx.ui.custom<string | null>((tui, theme, _kb, done) => {
		const container = new Container();
		container.addChild(new DynamicBorder((s: string) => theme.fg("accent", s)));
		container.addChild(new Text(theme.fg("accent", theme.bold("Select base branch")), 1, 0));
		const list = new SelectList(items, Math.min(12, items.length), {
			selectedPrefix: (text) => theme.fg("accent", text),
			selectedText: (text) => theme.fg("accent", text),
			description: (text) => theme.fg("muted", text),
			scrollInfo: (text) => theme.fg("dim", text),
			noMatch: (text) => theme.fg("warning", text),
		});
		list.onSelect = (item) => done(item.value);
		list.onCancel = () => done(null);
		container.addChild(list);
		container.addChild(new Text(theme.fg("dim", "enter select • esc cancel"), 1, 0));
		container.addChild(new DynamicBorder((s: string) => theme.fg("accent", s)));
		return {
			render: (width) => container.render(width),
			invalidate: () => container.invalidate(),
			handleInput: (data) => {
				list.handleInput(data);
				tui.requestRender();
			},
		};
	});

	return selected ? { type: "branch", branch: selected } : null;
}

async function showCommitSelector(ctx: ExtensionCommandContext, pi: ExtensionAPI): Promise<DiffTarget | null> {
	const commits = await getRecentCommits(pi);
	if (commits.length === 0) {
		ctx.ui.notify("No commits found", "error");
		return null;
	}

	const items: SelectItem[] = commits.map((commit) => ({
		value: commit.sha,
		label: `${commit.sha.slice(0, 8)} ${commit.title}`,
		description: "",
	}));

	const selectedCommit = await ctx.ui.custom<{ sha: string; title: string } | null>((tui, theme, _kb, done) => {
		const container = new Container();
		container.addChild(new DynamicBorder((s: string) => theme.fg("accent", s)));
		container.addChild(new Text(theme.fg("accent", theme.bold("Select commit")), 1, 0));
		const list = new SelectList(items, Math.min(12, items.length), {
			selectedPrefix: (text) => theme.fg("accent", text),
			selectedText: (text) => theme.fg("accent", text),
			description: (text) => theme.fg("muted", text),
			scrollInfo: (text) => theme.fg("dim", text),
			noMatch: (text) => theme.fg("warning", text),
		});
		list.searchable = true;
		list.onSelect = (item) => {
			const commit = commits.find((entry) => entry.sha === item.value);
			done(commit ?? null);
		};
		list.onCancel = () => done(null);
		container.addChild(list);
		container.addChild(new Text(theme.fg("dim", "Type to search • enter select • esc cancel"), 1, 0));
		container.addChild(new DynamicBorder((s: string) => theme.fg("accent", s)));
		return {
			render: (width) => container.render(width),
			invalidate: () => container.invalidate(),
			handleInput: (data) => {
				list.handleInput(data);
				tui.requestRender();
			},
		};
	});

	if (!selectedCommit) return null;
	return { type: "commit", sha: selectedCommit.sha, title: selectedCommit.title };
}

async function buildDiffSnapshot(pi: ExtensionAPI, target: DiffTarget): Promise<DiffSnapshot> {
	let command: string[];
	let targetLabel: string;

	if (target.type === "uncommitted") {
		command = ["diff", "--find-renames", "--find-copies", "--unified=3", "--no-ext-diff", "HEAD"];
		targetLabel = "uncommitted changes (tracked files)";
	} else if (target.type === "branch") {
		const mergeBase = await pi.exec("git", ["merge-base", "HEAD", target.branch]);
		if (mergeBase.code !== 0 || !mergeBase.stdout.trim()) {
			throw new Error(`Could not compute merge base with branch '${target.branch}'`);
		}
		const base = mergeBase.stdout.trim();
		command = ["diff", "--find-renames", "--find-copies", "--unified=3", "--no-ext-diff", `${base}..HEAD`];
		targetLabel = `branch comparison vs ${target.branch}`;
	} else {
		command = ["show", "--find-renames", "--find-copies", "--unified=3", "--no-ext-diff", "--format=", target.sha];
		targetLabel = target.title ? `commit ${target.sha.slice(0, 8)} · ${target.title}` : `commit ${target.sha.slice(0, 8)}`;
	}

	const result = await pi.exec("git", command);
	if (result.code !== 0) {
		throw new Error(result.stderr.trim() || result.stdout.trim() || "Failed to load diff");
	}

	return {
		target,
		targetLabel,
		files: parseDiffFiles(result.stdout),
		generatedAt: Date.now(),
	};
}

type HighlightTask = {
	generation: number;
	cacheKey: string;
	text: string;
	language: string;
};

type SidebarTreeNode = {
	dirs: Map<string, SidebarTreeNode>;
	files: number[];
};

type SidebarEntry =
	| { kind: "dir"; depth: number; name: string }
	| { kind: "file"; depth: number; fileIndex: number };

type SidebarData = {
	entries: SidebarEntry[];
	fileOrder: number[];
	fileOrderIndex: Map<number, number>;
	fileEntryIndex: Map<number, number>;
};

type RowRenderMetrics = {
	width: number;
	separator: string;
	sideWidth: number;
	leftNumberWidth: number;
	rightNumberWidth: number;
	leftContentWidth: number;
	rightContentWidth: number;
};

type BodyLayout = {
	metrics: RowRenderMetrics;
	rowStarts: number[];
	rowHeights: number[];
	totalLines: number;
};

class DiffViewer {
	private fileIndex = 0;
	private scrollOffset = 0;
	private refreshing = false;
	private statusMessage = "";
	private closed = false;
	private composingMode: "steer" | "followUp" | null = null;
	private composeText = "";
	private composeCursor = 0;
	private sendingMessage = false;

	private splitRowsCache = new Map<number, SplitRow[]>();
	private bodyLayoutCache = new Map<string, BodyLayout>();
	private sidebarDataCache: SidebarData | null = null;

	private highlightGeneration = 0;
	private highlightCache = new Map<string, string>();
	private highlightQueueHigh: HighlightTask[] = [];
	private highlightQueueLow: HighlightTask[] = [];
	private highlightQueuedKeys = new Set<string>();
	private highlightTimer: ReturnType<typeof setTimeout> | null = null;
	private highlightResumeTimer: ReturnType<typeof setTimeout> | null = null;
	private highlightTotal = 0;
	private highlightDone = 0;

	constructor(
		private readonly tui: TUI,
		private readonly theme: ExtensionCommandContext["ui"]["theme"],
		private snapshot: DiffSnapshot,
		private readonly onRefresh: () => Promise<DiffSnapshot>,
		private readonly onClose: () => void,
		private readonly onQueueMessage: (mode: "steer" | "followUp", text: string) => Promise<string | undefined>,
	) {
		this.rebuildHighlightQueue(this.fileIndex);
	}

	handleInput(data: string): void {
		if (this.composingMode) {
			this.handleComposeInput(data);
			return;
		}

		if (matchesKey(data, "escape") || matchesKey(data, "q") || matchesKey(data, "ctrl+c")) {
			this.close();
			return;
		}
		if (matchesKey(data, "space")) return this.startCompose();
		if (matchesKey(data, "tab")) return this.stepFile(1);
		if (matchesKey(data, "shift+tab")) return this.stepFile(-1);
		if (matchesKey(data, "up")) return this.scroll(-1);
		if (matchesKey(data, "down")) return this.scroll(1);
		if (matchesKey(data, "alt+up")) return this.scroll(-Math.max(12, Math.floor(this.viewportHeight() * 0.6)));
		if (matchesKey(data, "alt+down")) return this.scroll(Math.max(12, Math.floor(this.viewportHeight() * 0.6)));
		if (matchesKey(data, "pageUp")) return this.scroll(-Math.max(6, Math.floor(this.viewportHeight() * 0.7)));
		if (matchesKey(data, "pageDown")) return this.scroll(Math.max(6, Math.floor(this.viewportHeight() * 0.7)));
		if (matchesKey(data, "r")) return void this.refresh();

		const wheel = this.parseMouseWheel(data);
		if (wheel === "up") return this.scroll(-3);
		if (wheel === "down") return this.scroll(3);
	}

	render(width: number): string[] {
		const safeWidth = Math.max(40, width);
		const lines: string[] = [];

		lines.push(truncateToWidth(`${this.theme.bold("Diff Viewer")} · ${this.theme.fg("accent", this.snapshot.targetLabel)}`, safeWidth));
		lines.push(
			truncateToWidth(
				this.theme.fg(
					"dim",
					"space compose msg • compose: enter steer, ⌥enter follow-up • tab/shift+tab file • ↑↓ scroll • ⌥↑/⌥↓ fast scroll • pgup/pgdn • mouse wheel • r refresh • q/esc close",
				),
				safeWidth,
			),
		);

		if (safeWidth < 120) {
			lines.push(truncateToWidth(this.theme.fg("error", this.theme.bold("⚠ SIDE-BY-SIDE NEEDS A WIDER WINDOW (120+ COLS)")), safeWidth));
		}

		if (this.statusMessage) {
			const color = this.statusMessage.startsWith("Refresh failed") ? "error" : "muted";
			lines.push(truncateToWidth(this.theme.fg(color, this.statusMessage), safeWidth));
		}

		if (this.composingMode) {
			lines.push(truncateToWidth(this.theme.fg("accent", "Compose message · enter=steer · opt+enter=follow-up · esc cancel"), safeWidth));
			lines.push(truncateToWidth(this.renderComposeLine(), safeWidth));
		}

		if (this.snapshot.files.length > 0) {
			const file = this.snapshot.files[this.fileIndex];
			if (file) lines.push(truncateToWidth(this.renderFileHeader(file), safeWidth));
		}

		lines.push(truncateToWidth(this.theme.fg("border", "─".repeat(Math.max(1, safeWidth))), safeWidth));

		const viewport = this.viewportHeight();
		const separator = this.theme.fg("borderMuted", " │ ");
		const separatorWidth = visibleWidth(separator);
		const sidebarWidth = this.sidebarWidth(safeWidth);
		const contentWidth = Math.max(24, safeWidth - sidebarWidth - separatorWidth);

		const body = this.currentBodyViewport(contentWidth, viewport);
		const maxOffset = body.maxOffset;
		const visibleBody = body.lines;

		const sidebar = this.renderSidebarLines(sidebarWidth, viewport);
		for (let i = 0; i < viewport; i += 1) {
			const left = this.padToWidth(sidebar[i] ?? "", sidebarWidth);
			const right = this.padToWidth(visibleBody[i] ?? "", contentWidth);
			lines.push(`${left}${separator}${right}`);
		}

		const footerLeft = `${this.snapshot.files.length === 0 ? "0/0" : `${this.fileIndex + 1}/${this.snapshot.files.length}`} files · ${this.currentChangedLineCount()} lines changed`;
		const footerRight = `${this.scrollOffset}/${maxOffset}`;
		const gap = safeWidth - visibleWidth(footerLeft) - visibleWidth(footerRight);
		const footer = gap >= 1 ? `${footerLeft}${" ".repeat(gap)}${footerRight}` : `${footerLeft} · ${footerRight}`;
		lines.push(truncateToWidth(this.theme.fg("dim", footer), safeWidth));
		return lines.map((line) => truncateToWidth(line, safeWidth));
	}

	invalidate(): void {
		this.highlightGeneration += 1;
		this.highlightCache.clear();
		this.bodyLayoutCache.clear();
		this.clearSidebarCache();
		this.rebuildHighlightQueue(this.fileIndex);
		this.tui.requestRender();
	}

	private currentChangedLineCount(): number {
		const file = this.snapshot.files[this.fileIndex];
		if (!file) return 0;
		return file.additions + file.deletions;
	}

	private parseMouseWheel(data: string): "up" | "down" | null {
		const match = data.match(/^\x1b\[<(\d+);\d+;\d+[mM]$/);
		if (!match) return null;
		const code = Number.parseInt(match[1] ?? "0", 10);
		if ((code & 64) === 0) return null;
		return (code & 1) === 0 ? "up" : "down";
	}

	private close(): void {
		if (this.closed) return;
		this.closed = true;
		if (this.highlightTimer) {
			clearTimeout(this.highlightTimer);
			this.highlightTimer = null;
		}
		if (this.highlightResumeTimer) {
			clearTimeout(this.highlightResumeTimer);
			this.highlightResumeTimer = null;
		}
		this.highlightQueueHigh = [];
		this.highlightQueueLow = [];
		this.highlightQueuedKeys.clear();
		this.onClose();
	}

	private startCompose(): void {
		if (this.closed || this.sendingMessage) return;
		this.composingMode = "steer";
		this.composeText = "";
		this.composeCursor = 0;
		this.statusMessage = "Compose message";
		this.tui.requestRender();
	}

	private cancelCompose(): void {
		if (!this.composingMode) return;
		this.composingMode = null;
		this.composeText = "";
		this.composeCursor = 0;
		this.statusMessage = "Compose cancelled";
		this.tui.requestRender();
	}

	private handleComposeInput(data: string): void {
		if (!this.composingMode) return;

		if (matchesKey(data, "escape") || matchesKey(data, "ctrl+c")) {
			this.cancelCompose();
			return;
		}

		if (matchesKey(data, "alt+enter") || matchesKey(data, "alt+return")) {
			void this.submitCompose("followUp");
			return;
		}
		if (matchesKey(data, "enter") || matchesKey(data, "return")) {
			void this.submitCompose("steer");
			return;
		}

		if (matchesKey(data, "backspace")) {
			if (this.composeCursor > 0) {
				this.composeText = this.composeText.slice(0, this.composeCursor - 1) + this.composeText.slice(this.composeCursor);
				this.composeCursor -= 1;
			}
			this.tui.requestRender();
			return;
		}

		if (matchesKey(data, "delete")) {
			if (this.composeCursor < this.composeText.length) {
				this.composeText = this.composeText.slice(0, this.composeCursor) + this.composeText.slice(this.composeCursor + 1);
			}
			this.tui.requestRender();
			return;
		}

		if (matchesKey(data, "left")) {
			this.composeCursor = Math.max(0, this.composeCursor - 1);
			this.tui.requestRender();
			return;
		}

		if (matchesKey(data, "right")) {
			this.composeCursor = Math.min(this.composeText.length, this.composeCursor + 1);
			this.tui.requestRender();
			return;
		}

		if (matchesKey(data, "home")) {
			this.composeCursor = 0;
			this.tui.requestRender();
			return;
		}

		if (matchesKey(data, "end")) {
			this.composeCursor = this.composeText.length;
			this.tui.requestRender();
			return;
		}

		if (!data.startsWith("\u001b")) {
			this.insertComposeText(data);
			this.tui.requestRender();
		}
	}

	private insertComposeText(text: string): void {
		if (!text) return;
		const sanitized = [...text].filter((char) => char >= " " && char !== "\u007f").join("");
		if (!sanitized) return;
		this.composeText = this.composeText.slice(0, this.composeCursor) + sanitized + this.composeText.slice(this.composeCursor);
		this.composeCursor += sanitized.length;
	}

	private async submitCompose(mode: "steer" | "followUp"): Promise<void> {
		if (!this.composingMode || this.sendingMessage) return;
		const text = this.composeText.trim();
		if (!text) {
			this.statusMessage = "Message empty";
			this.tui.requestRender();
			return;
		}

		this.sendingMessage = true;
		this.statusMessage = mode === "steer" ? "Sending steering message..." : "Queueing follow-up message...";
		this.tui.requestRender();

		try {
			const status = await this.onQueueMessage(mode, text);
			if (this.closed) return;
			this.composingMode = null;
			this.composeText = "";
			this.composeCursor = 0;
			if (status) this.statusMessage = status;
		} catch (error) {
			if (this.closed) return;
			const message = error instanceof Error ? error.message : String(error);
			this.statusMessage = `Message failed: ${message}`;
		} finally {
			this.sendingMessage = false;
			if (!this.closed) this.tui.requestRender();
		}
	}

	private renderComposeLine(): string {
		const prefix = this.theme.fg("accent", "✎ ");
		if (this.composeText.length === 0) {
			return `${prefix}${this.theme.fg("dim", "▏type message")}`;
		}
		const before = this.composeText.slice(0, this.composeCursor);
		const after = this.composeText.slice(this.composeCursor);
		return `${prefix}${before}${this.theme.fg("accent", "▏")}${after}`;
	}

	private stepFile(delta: 1 | -1): void {
		if (this.snapshot.files.length === 0) return;
		const order = this.sidebarFileOrder();
		if (order.length === 0) return;

		const current = this.sidebarFileOrderIndex(this.fileIndex);
		const start = current >= 0 ? current : 0;
		let next = start + delta;
		if (next < 0) next = order.length - 1;
		if (next >= order.length) next = 0;
		this.fileIndex = order[next] ?? this.fileIndex;
		this.scrollOffset = 0;
		this.pauseHighlightUntilIdle();
		this.tui.requestRender();
	}

	private sidebarFileOrder(): number[] {
		return this.sidebarData().fileOrder;
	}

	private sidebarFileOrderIndex(fileIndex: number): number {
		return this.sidebarData().fileOrderIndex.get(fileIndex) ?? -1;
	}

	private pauseHighlightUntilIdle(): void {
		if (this.highlightTimer) {
			clearTimeout(this.highlightTimer);
			this.highlightTimer = null;
		}
		this.highlightQueueHigh = [];
		this.highlightQueueLow = [];
		this.highlightQueuedKeys.clear();

		if (this.highlightResumeTimer) clearTimeout(this.highlightResumeTimer);
		this.highlightResumeTimer = setTimeout(() => {
			this.highlightResumeTimer = null;
			if (this.closed) return;
			this.rebuildHighlightQueue(this.fileIndex);
			this.tui.requestRender();
		}, 120);
	}

	private scroll(delta: number): void {
		if (delta === 0) return;
		this.scrollOffset = Math.max(0, this.scrollOffset + delta);
		this.tui.requestRender();
	}

	private viewportHeight(): number {
		return Math.max(8, this.tui.terminal.rows - 10);
	}

	private sidebarWidth(totalWidth: number): number {
		return Math.max(22, Math.min(40, Math.floor(totalWidth * 0.28)));
	}

	private padToWidth(text: string, width: number): string {
		const clipped = truncateToWidth(text, width, "", false);
		const fill = width - visibleWidth(clipped);
		if (fill <= 0) return clipped;
		return `${clipped}${" ".repeat(fill)}`;
	}

	private async refresh(): Promise<void> {
		if (this.refreshing || this.closed) return;
		this.refreshing = true;
		this.statusMessage = "Refreshing diff...";
		this.tui.requestRender();

		try {
			const snapshot = await this.onRefresh();
			if (this.closed) return;
			this.snapshot = snapshot;
			if (this.fileIndex >= this.snapshot.files.length) this.fileIndex = Math.max(0, this.snapshot.files.length - 1);
			this.scrollOffset = 0;
			this.splitRowsCache.clear();
			this.bodyLayoutCache.clear();
			this.clearSidebarCache();
			this.highlightGeneration += 1;
			this.highlightCache.clear();
			this.rebuildHighlightQueue(this.fileIndex);
			this.statusMessage = `Refreshed at ${new Date().toLocaleTimeString()}`;
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			this.statusMessage = `Refresh failed: ${message}`;
		}

		this.refreshing = false;
		this.tui.requestRender();
	}

	private currentBodyViewport(width: number, viewport: number): { lines: string[]; maxOffset: number } {
		if (this.snapshot.files.length === 0) {
			const all = [
				truncateToWidth(this.theme.fg("warning", "No diff files for this target."), width),
				truncateToWidth(this.theme.fg("dim", "Try a different source or press r to refresh."), width),
			];
			const maxOffset = Math.max(0, all.length - viewport);
			this.scrollOffset = Math.max(0, Math.min(this.scrollOffset, maxOffset));
			return { lines: all.slice(this.scrollOffset, this.scrollOffset + viewport), maxOffset };
		}

		const file = this.snapshot.files[this.fileIndex];
		if (!file) return { lines: [], maxOffset: 0 };
		return this.renderFileViewport(file, width, this.fileIndex, viewport);
	}

	private renderSidebarLines(sidebarWidth: number, height: number): string[] {
		const lines: string[] = [];
		lines.push(truncateToWidth(this.theme.bold(`Files (${this.snapshot.files.length})`), sidebarWidth));

		if (this.snapshot.files.length === 0) {
			for (let i = 1; i < height; i += 1) lines.push("");
			return lines;
		}

		const entries = this.sidebarEntries();
		const selectedEntryIndex = Math.max(0, this.sidebarEntryIndex(this.fileIndex));
		const visibleRows = Math.max(1, height - 1);

		let start = 0;
		if (entries.length > visibleRows) {
			const centered = selectedEntryIndex - Math.floor(visibleRows / 2);
			start = Math.max(0, Math.min(centered, entries.length - visibleRows));
		}

		for (let row = 0; row < visibleRows; row += 1) {
			const idx = start + row;
			if (idx >= entries.length) {
				lines.push("");
				continue;
			}

			const entry = entries[idx];
			if (!entry) {
				lines.push("");
				continue;
			}

			if (entry.kind === "dir") {
				const prefix = this.treePrefix(entry.depth);
				let label = `${prefix}${entry.name}`;
				if (idx === start && start > 0) label = `… ${label}`;
				if (idx === start + visibleRows - 1 && idx < entries.length - 1) label = `${label} …`;
				lines.push(truncateToWidth(this.theme.fg("dim", ` ${label}`), sidebarWidth));
				continue;
			}

			const file = this.snapshot.files[entry.fileIndex];
			if (!file) {
				lines.push("");
				continue;
			}

			const prefix = this.treePrefix(entry.depth);
			let label = `${prefix}${this.fileBaseName(file)}`;
			if (idx === start && start > 0) label = `… ${label}`;
			if (idx === start + visibleRows - 1 && idx < entries.length - 1) label = `${label} …`;

			if (entry.fileIndex === this.fileIndex) {
				lines.push(truncateToWidth(this.theme.fg("accent", `›${label}`), sidebarWidth));
			} else {
				lines.push(truncateToWidth(this.theme.fg("muted", ` ${label}`), sidebarWidth));
			}
		}

		return lines;
	}

	private getDisplayPath(file: ParsedDiffFile): string {
		return file.status === "renamed" && file.oldPath !== file.newPath
			? `${file.oldPath} → ${file.newPath}`
			: file.newPath || file.oldPath;
	}

	private getSyntaxPath(file: ParsedDiffFile): string {
		return file.newPath || file.oldPath;
	}

	private getSyntaxLanguage(file: ParsedDiffFile): string | undefined {
		const path = this.getSyntaxPath(file);
		if (!path) return undefined;
		return getLanguageFromPath(path);
	}

	private clearSidebarCache(): void {
		this.sidebarDataCache = null;
	}

	private sidebarEntries(): SidebarEntry[] {
		return this.sidebarData().entries;
	}

	private sidebarEntryIndex(fileIndex: number): number {
		return this.sidebarData().fileEntryIndex.get(fileIndex) ?? -1;
	}

	private sidebarData(): SidebarData {
		if (this.sidebarDataCache) return this.sidebarDataCache;
		const entries = this.buildSidebarEntries();
		const fileOrder: number[] = [];
		const fileOrderIndex = new Map<number, number>();
		const fileEntryIndex = new Map<number, number>();

		for (let i = 0; i < entries.length; i += 1) {
			const entry = entries[i];
			if (!entry || entry.kind !== "file") continue;
			const orderIndex = fileOrder.length;
			fileOrder.push(entry.fileIndex);
			fileOrderIndex.set(entry.fileIndex, orderIndex);
			fileEntryIndex.set(entry.fileIndex, i);
		}

		this.sidebarDataCache = { entries, fileOrder, fileOrderIndex, fileEntryIndex };
		return this.sidebarDataCache;
	}

	private buildSidebarEntries(): SidebarEntry[] {
		const root: SidebarTreeNode = { dirs: new Map(), files: [] };

		for (let fileIndex = 0; fileIndex < this.snapshot.files.length; fileIndex += 1) {
			const file = this.snapshot.files[fileIndex];
			if (!file) continue;
			const path = (this.getSyntaxPath(file) || this.getDisplayPath(file)).replaceAll("\\", "/");
			const parts = path.split("/").filter(Boolean);
			if (parts.length === 0) {
				root.files.push(fileIndex);
				continue;
			}

			let node = root;
			for (let i = 0; i < parts.length - 1; i += 1) {
				const part = parts[i];
				if (!part) continue;
				let child = node.dirs.get(part);
				if (!child) {
					child = { dirs: new Map(), files: [] };
					node.dirs.set(part, child);
				}
				node = child;
			}
			node.files.push(fileIndex);
		}

		const entries: SidebarEntry[] = [];
		const walk = (node: SidebarTreeNode, depth: number) => {
			for (const [name, child] of node.dirs) {
				entries.push({ kind: "dir", depth, name });
				walk(child, depth + 1);
			}
			for (const fileIndex of node.files) {
				entries.push({ kind: "file", depth, fileIndex });
			}
		};
		walk(root, 0);
		return entries;
	}

	private treePrefix(depth: number): string {
		if (depth <= 0) return "";
		return " ".repeat(depth);
	}

	private fileBaseName(file: ParsedDiffFile): string {
		const path = this.getSyntaxPath(file) || this.getDisplayPath(file);
		const parts = path.split("/").filter(Boolean);
		return parts[parts.length - 1] || path;
	}


	private renderFileHeader(file: ParsedDiffFile): string {
		const path = this.getDisplayPath(file);

		const status =
			file.status === "added"
				? this.theme.fg("success", "[new]")
				: file.status === "deleted"
					? this.theme.fg("error", "[deleted]")
					: file.status === "renamed"
						? this.theme.fg("accent", "[renamed]")
						: this.theme.fg("muted", "[modified]");

		const binary = file.isBinary ? ` ${this.theme.fg("warning", "[binary]")}` : "";
		const counts = ` ${this.theme.fg("toolDiffAdded", `+${file.additions}`)} ${this.theme.fg("toolDiffRemoved", `-${file.deletions}`)}`;
		const mode = file.oldMode && file.newMode && file.oldMode !== file.newMode
			? ` ${this.theme.fg("warning", `[mode ${file.oldMode}→${file.newMode}]`)}`
			: "";

		return `${status} ${this.theme.bold(path)}${binary}${counts}${mode}`;
	}

	private renderFileViewport(file: ParsedDiffFile, width: number, fileIndex: number, viewport: number): { lines: string[]; maxOffset: number } {
		if (file.isBinary) {
			const all = [truncateToWidth(this.theme.fg("warning", "Binary file changed. Side-by-side text diff unavailable."), width)];
			const maxOffset = Math.max(0, all.length - viewport);
			this.scrollOffset = Math.max(0, Math.min(this.scrollOffset, maxOffset));
			return { lines: all.slice(this.scrollOffset, this.scrollOffset + viewport), maxOffset };
		}

		const rows = this.getSplitRows(fileIndex, file);
		if (rows.length === 0) {
			const all = [truncateToWidth(this.theme.fg("muted", "No textual changes."), width)];
			const maxOffset = Math.max(0, all.length - viewport);
			this.scrollOffset = Math.max(0, Math.min(this.scrollOffset, maxOffset));
			return { lines: all.slice(this.scrollOffset, this.scrollOffset + viewport), maxOffset };
		}

		const layout = this.getBodyLayout(fileIndex, file, width);
		const maxOffset = Math.max(0, layout.totalLines - viewport);
		this.scrollOffset = Math.max(0, Math.min(this.scrollOffset, maxOffset));
		const lines = this.renderVisibleRows(rows, fileIndex, layout, this.scrollOffset, viewport);
		return { lines, maxOffset };
	}

	private getBodyLayout(fileIndex: number, file: ParsedDiffFile, width: number): BodyLayout {
		const key = `${fileIndex}:${width}`;
		const cached = this.bodyLayoutCache.get(key);
		if (cached) return cached;

		const rows = this.getSplitRows(fileIndex, file);
		const metrics = this.rowRenderMetrics(file, width);
		const rowStarts: number[] = [];
		const rowHeights: number[] = [];
		let totalLines = 0;

		for (const row of rows) {
			rowStarts.push(totalLines);
			let height = 1;
			if (row.type === "line") {
				const leftHeight = this.measureSideWrapCount(row.left, metrics.leftContentWidth);
				const rightHeight = this.measureSideWrapCount(row.right, metrics.rightContentWidth);
				height = Math.max(leftHeight, rightHeight);
			}
			rowHeights.push(height);
			totalLines += height;
		}

		const layout: BodyLayout = { metrics, rowStarts, rowHeights, totalLines };
		this.bodyLayoutCache.set(key, layout);
		return layout;
	}

	private rowRenderMetrics(file: ParsedDiffFile, width: number): RowRenderMetrics {
		const separator = this.theme.fg("borderMuted", " │ ");
		const separatorWidth = visibleWidth(separator);
		const sideWidth = Math.max(12, Math.floor((width - separatorWidth) / 2));
		const leftNumberWidth = Math.max(4, String(Math.max(file.maxOldLineNumber, 9999)).length);
		const rightNumberWidth = Math.max(4, String(Math.max(file.maxNewLineNumber, 9999)).length);
		const leftContentWidth = Math.max(1, sideWidth - (leftNumberWidth + 3));
		const rightContentWidth = Math.max(1, sideWidth - (rightNumberWidth + 3));
		return { width, separator, sideWidth, leftNumberWidth, rightNumberWidth, leftContentWidth, rightContentWidth };
	}

	private measureSideWrapCount(line: ParsedDiffLine | undefined, contentWidth: number): number {
		if (!line) return 1;
		const wrapped = wrapTextWithAnsi(line.text || " ", contentWidth);
		return wrapped.length > 0 ? wrapped.length : 1;
	}

	private findRowIndexForOffset(rowStarts: number[], rowHeights: number[], offset: number): number {
		if (rowStarts.length === 0) return 0;
		let low = 0;
		let high = rowStarts.length - 1;

		while (low <= high) {
			const mid = Math.floor((low + high) / 2);
			const start = rowStarts[mid] ?? 0;
			const end = start + (rowHeights[mid] ?? 1);
			if (offset < start) high = mid - 1;
			else if (offset >= end) low = mid + 1;
			else return mid;
		}

		return Math.max(0, Math.min(rowStarts.length - 1, low));
	}

	private renderVisibleRows(rows: SplitRow[], fileIndex: number, layout: BodyLayout, startOffset: number, viewport: number): string[] {
		if (rows.length === 0 || viewport <= 0) return [];
		const out: string[] = [];
		const endOffset = startOffset + viewport;
		let rowIndex = this.findRowIndexForOffset(layout.rowStarts, layout.rowHeights, startOffset);

		while (rowIndex < rows.length && out.length < viewport) {
			const row = rows[rowIndex];
			if (!row) {
				rowIndex += 1;
				continue;
			}

			const rowStart = layout.rowStarts[rowIndex] ?? 0;
			const rowHeight = layout.rowHeights[rowIndex] ?? 1;
			const sliceStart = Math.max(0, startOffset - rowStart);
			const sliceEnd = Math.min(rowHeight, endOffset - rowStart);

			if (sliceStart < sliceEnd) {
				const rendered = this.renderSplitRow(row, fileIndex, layout.metrics);
				out.push(...rendered.slice(sliceStart, sliceEnd));
			}

			rowIndex += 1;
		}

		return out;
	}

	private renderSplitRow(row: SplitRow, fileIndex: number, metrics: RowRenderMetrics): string[] {
		if (row.type === "hunk") return [truncateToWidth(this.theme.fg("accent", row.header), metrics.width)];

		const leftLines = this.renderSide(row.left, metrics.sideWidth, metrics.leftNumberWidth, "left", fileIndex);
		const rightLines = this.renderSide(row.right, metrics.sideWidth, metrics.rightNumberWidth, "right", fileIndex);
		const lineCount = Math.max(leftLines.length, rightLines.length);
		const out: string[] = [];

		for (let i = 0; i < lineCount; i += 1) {
			const left = leftLines[i] ?? " ".repeat(metrics.sideWidth);
			const right = rightLines[i] ?? " ".repeat(metrics.sideWidth);
			const paddedLeft = this.padToWidth(left, metrics.sideWidth);
			const paddedRight = this.padToWidth(right, metrics.sideWidth);
			const tintedLeft = this.tintSideCell(paddedLeft, row.left);
			const tintedRight = this.tintSideCell(paddedRight, row.right);
			out.push(truncateToWidth(`${tintedLeft}${metrics.separator}${tintedRight}`, metrics.width));
		}

		return out;
	}

	private renderSide(
		line: ParsedDiffLine | undefined,
		sideWidth: number,
		numberWidth: number,
		side: "left" | "right",
		fileIndex: number,
	): string[] {
		if (!line) return [" ".repeat(sideWidth)];

		const color = line.type === "add" ? "toolDiffAdded" : line.type === "remove" ? "toolDiffRemoved" : "toolDiffContext";
		const marker = line.type === "add" ? "+" : line.type === "remove" ? "-" : " ";
		const lineNumber = side === "left" ? line.oldLineNumber : line.newLineNumber;
		const numberText = lineNumber == null ? " ".repeat(numberWidth) : String(lineNumber).padStart(numberWidth, " ");
		const prefixPlain = `${numberText} ${marker} `;
		const prefix = this.theme.fg(color, prefixPlain);
		const contentWidth = Math.max(1, sideWidth - visibleWidth(prefixPlain));
		const styledContent = this.getStyledContent(fileIndex, line, color);
		const wrapped = wrapTextWithAnsi(styledContent, contentWidth);
		const actualWrapped = wrapped.length > 0 ? wrapped : [""];

		const rendered: string[] = [];
		for (let i = 0; i < actualWrapped.length; i += 1) {
			const text = i === 0 ? `${prefix}${actualWrapped[i]}` : `${" ".repeat(visibleWidth(prefixPlain))}${actualWrapped[i]}`;
			rendered.push(truncateToWidth(text, sideWidth, "", true));
		}
		return rendered;
	}

	private tintSideCell(text: string, line: ParsedDiffLine | undefined): string {
		if (!line) return text;
		if (line.type === "add") return this.applyBackgroundPreservingAnsi(text, "toolSuccessBg");
		if (line.type === "remove") return this.applyBackgroundPreservingAnsi(text, "toolErrorBg");
		return text;
	}

	private applyBackgroundPreservingAnsi(text: string, color: "toolSuccessBg" | "toolErrorBg"): string {
		const getBgAnsi = (this.theme as unknown as { getBgAnsi?: (token: "toolSuccessBg" | "toolErrorBg") => string }).getBgAnsi;
		if (!getBgAnsi) return this.theme.bg(color, text);
		const bgAnsi = getBgAnsi.call(this.theme, color);
		if (!bgAnsi) return this.theme.bg(color, text);
		return `${bgAnsi}${text.replaceAll("\u001b[0m", `\u001b[0m${bgAnsi}`)}\u001b[0m`;
	}

	private getStyledContent(fileIndex: number, line: ParsedDiffLine, fallbackColor: "toolDiffAdded" | "toolDiffRemoved" | "toolDiffContext"): string {
		const text = line.text || " ";
		const key = this.highlightKey(fileIndex, line, text);
		const highlighted = this.highlightCache.get(key);
		if (highlighted != null) return highlighted;
		return this.theme.fg(fallbackColor, text);
	}

	private getSplitRows(fileIndex: number, file: ParsedDiffFile): SplitRow[] {
		const cached = this.splitRowsCache.get(fileIndex);
		if (cached) return cached;
		const rows = toSplitRows(file);
		this.splitRowsCache.set(fileIndex, rows);
		return rows;
	}

	private highlightKey(fileIndex: number, line: ParsedDiffLine, text: string): string {
		const oldLine = line.oldLineNumber ?? "";
		const newLine = line.newLineNumber ?? "";
		return `${this.highlightGeneration}:${fileIndex}:${line.type}:${oldLine}:${newLine}:${text}`;
	}

	private rebuildHighlightQueue(primaryFileIndex: number): void {
		if (this.closed) return;
		if (this.highlightResumeTimer) {
			clearTimeout(this.highlightResumeTimer);
			this.highlightResumeTimer = null;
		}
		this.highlightQueueHigh = [];
		this.highlightQueueLow = [];
		this.highlightQueuedKeys.clear();
		if (this.highlightTimer) {
			clearTimeout(this.highlightTimer);
			this.highlightTimer = null;
		}

		const fileCount = this.snapshot.files.length;
		if (fileCount === 0) {
			this.highlightTotal = 0;
			this.highlightDone = 0;
			return;
		}

		const order: number[] = [];
		if (primaryFileIndex >= 0 && primaryFileIndex < fileCount) order.push(primaryFileIndex);
		for (let i = 0; i < fileCount; i += 1) {
			if (i !== primaryFileIndex) order.push(i);
		}

		const seen = new Set<string>();
		let total = 0;
		let done = 0;

		for (let rank = 0; rank < order.length; rank += 1) {
			const fileIndex = order[rank] ?? 0;
			const file = this.snapshot.files[fileIndex];
			if (!file || file.isBinary) continue;
			const language = this.getSyntaxLanguage(file);
			if (!language) continue;

			for (const hunk of file.hunks) {
				for (const line of hunk.lines) {
					const text = line.text || " ";
					const key = this.highlightKey(fileIndex, line, text);
					if (seen.has(key)) continue;
					seen.add(key);
					total += 1;

					if (this.highlightCache.has(key)) {
						done += 1;
						continue;
					}

					this.highlightQueuedKeys.add(key);
					const task: HighlightTask = {
						generation: this.highlightGeneration,
						cacheKey: key,
						text,
						language,
					};

					if (rank === 0) this.highlightQueueHigh.push(task);
					else this.highlightQueueLow.push(task);
				}
			}
		}

		this.highlightTotal = total;
		this.highlightDone = done;
		this.startHighlightWorker();
	}

	private startHighlightWorker(): void {
		if (this.closed) return;
		if (this.highlightTimer) return;
		if (this.highlightQueueHigh.length === 0 && this.highlightQueueLow.length === 0) return;
		this.highlightTimer = setTimeout(() => this.processHighlightChunk(), 0);
	}

	private processHighlightChunk(): void {
		this.highlightTimer = null;
		if (this.closed) return;

		const started = Date.now();
		let changed = false;
		let processed = 0;

		while (Date.now() - started < 8 && processed < 120) {
			const task = this.highlightQueueHigh.shift() ?? this.highlightQueueLow.shift();
			if (!task) break;
			this.highlightQueuedKeys.delete(task.cacheKey);
			processed += 1;

			if (task.generation !== this.highlightGeneration) continue;
			if (this.highlightCache.has(task.cacheKey)) continue;

			let highlighted = task.text;
			try {
				const out = highlightCode(task.text, task.language);
				highlighted = out[0] ?? task.text;
			} catch {
				highlighted = task.text;
			}

			this.highlightCache.set(task.cacheKey, highlighted);
			this.highlightDone += 1;
			changed = true;
		}

		if (changed) this.tui.requestRender();
		if (this.highlightQueueHigh.length > 0 || this.highlightQueueLow.length > 0) {
			this.startHighlightWorker();
		}
	}

}

export default function diffExtension(pi: ExtensionAPI) {
	pi.registerCommand("diff", {
		description: "Browse git diffs in a side-by-side TUI viewer",
		handler: async (args, ctx) => {
			if (!ctx.hasUI) {
				ctx.ui.notify("/diff requires interactive mode", "error");
				return;
			}

			if (!(await inGitRepo(pi))) {
				ctx.ui.notify("Not a git repository", "error");
				return;
			}

			const target = await resolveDiffTarget(ctx, pi, args);
			if (!target) {
				ctx.ui.notify("Diff cancelled", "info");
				return;
			}

			const snapshot = await ctx.ui.custom((tui, theme, _kb, done) => {
				const loader = new BorderedLoader(tui, theme, "Loading diff...");
				loader.onAbort = () => done(null);
				buildDiffSnapshot(pi, target)
					.then(done)
					.catch((error) => {
						const message = error instanceof Error ? error.message : String(error);
						ctx.ui.notify(`Failed to load diff: ${message}`, "error");
						done(null);
					});
				return loader;
			});

			if (!snapshot) return;

			const queueFromDiffViewer = async (mode: "steer" | "followUp", text: string): Promise<string | undefined> => {
				if (ctx.isIdle()) {
					pi.sendUserMessage(text);
					const status = "Sent message (agent idle)";
					ctx.ui.notify(status, "info");
					return status;
				}

				pi.sendUserMessage(text, { deliverAs: mode });
				const status = mode === "steer" ? "Queued steering message" : "Queued follow-up message";
				ctx.ui.notify(status, "info");
				return status;
			};

			await ctx.ui.custom<void>((tui, theme, _kb, done) => {
				const viewer = new DiffViewer(
					tui,
					theme,
					snapshot,
					() => buildDiffSnapshot(pi, target),
					() => done(undefined),
					queueFromDiffViewer,
				);
				return {
					render: (width: number) => viewer.render(width),
					invalidate: () => viewer.invalidate(),
					handleInput: (data: string) => viewer.handleInput(data),
				};
			});
		},
	});
}
