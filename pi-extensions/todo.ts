import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type { ExtensionAPI, ExtensionCommandContext } from "@mariozechner/pi-coding-agent";
import { matchesKey, truncateToWidth } from "@mariozechner/pi-tui";

type TodoDifficulty = "easy" | "medium" | "hard";

interface TodoItem {
	id: number;
	text: string;
	createdAt: string;
	difficulty: TodoDifficulty;
}

const TODO_DIR = join(homedir(), ".pi", "todo");
const TODO_JSON_PATH = join(TODO_DIR, "todo.json");
const DELETE_CONFIRM_WINDOW_MS = 1200;
const TODO_DIFFICULTY_ORDER: readonly TodoDifficulty[] = ["easy", "medium", "hard"];
const DEFAULT_TODO_DIFFICULTY: TodoDifficulty = "medium";

type CommandAction =
	| { type: "list" }
	| { type: "help" }
	| { type: "clear" }
	| { type: "delete"; id: number }
	| { type: "add"; text: string };

function ensureTodoDir(): void {
	mkdirSync(dirname(TODO_JSON_PATH), { recursive: true });
}

function cloneTodos(todos: TodoItem[]): TodoItem[] {
	return todos.map((todo) => ({ ...todo }));
}

function normalizeDifficulty(value: unknown): TodoDifficulty {
	if (value === "easy" || value === "medium" || value === "hard") return value;
	return DEFAULT_TODO_DIFFICULTY;
}

function normalizeTodos(todos: TodoItem[]): TodoItem[] {
	return todos.map((todo, index) => ({
		id: index + 1,
		text: todo.text,
		createdAt: todo.createdAt,
		difficulty: normalizeDifficulty(todo.difficulty),
	}));
}

function readTodos(): TodoItem[] {
	if (!existsSync(TODO_JSON_PATH)) return [];
	try {
		const raw = readFileSync(TODO_JSON_PATH, "utf-8");
		const parsed = JSON.parse(raw) as unknown;
		if (!Array.isArray(parsed)) return [];

		const todos: TodoItem[] = [];
		for (const item of parsed) {
			if (!item || typeof item !== "object") continue;
			const maybe = item as Partial<TodoItem>;
			if (typeof maybe.text !== "string") continue;
			if (typeof maybe.createdAt !== "string") continue;
			const id = typeof maybe.id === "number" ? maybe.id : todos.length + 1;
			todos.push({
				id,
				text: maybe.text,
				createdAt: maybe.createdAt,
				difficulty: normalizeDifficulty(maybe.difficulty),
			});
		}

		todos.sort((a, b) => a.id - b.id);
		return normalizeTodos(todos);
	} catch {
		return [];
	}
}

function writeTodos(inputTodos: TodoItem[]): void {
	ensureTodoDir();
	const todos = normalizeTodos(inputTodos);
	writeFileSync(TODO_JSON_PATH, `${JSON.stringify(todos, null, 2)}\n`, "utf-8");
}

function parseAction(args: string): CommandAction {
	const trimmed = args.trim();
	if (trimmed.length === 0) return { type: "list" };
	if (trimmed === "help") return { type: "help" };
	if (trimmed === "list" || trimmed === "ls" || trimmed === "show") return { type: "list" };
	if (trimmed === "clear") return { type: "clear" };

	const deleteMatch = trimmed.match(/^(delete|del|rm)\s+(\d+)$/);
	if (deleteMatch) {
		return { type: "delete", id: Number(deleteMatch[2]) };
	}

	return { type: "add", text: args };
}

function buildTodoLines(todos: TodoItem[]): string[] {
	if (todos.length === 0) {
		return ["No global todos.", "", "Add one with: /todo something important"];
	}

	return [
		...todos.map((todo) => `- [${todo.difficulty}] ${todo.text}`),
		"",
		`${todos.length} total`,
		"Delete with: /todo rm <position>",
	];
}

function usage(): string[] {
	return [
		"/todo                 list",
		"/todo <text>          add exact text as todo",
		"/todo rm <position>   delete todo",
		"/todo clear           clear all todos",
		"/todo help            help",
		"",
		"Keys:",
		"↑/↓                   navigate / reorder",
		"←/→                   difficulty easy/medium/hard",
		"opt+←/opt+→           move by word (input mode)",
		"opt+delete            delete word (input mode)",
		"space                 pick up / drop",
		"enter                 add todo / confirm",
		"e                     edit selected",
		"d/delete x2           delete selected",
		"esc                   cancel / close",
		"",
		"Examples:",
		"/todo ship auth retry",
		'/todo "follow up with alex on billing edge cases"',
	];
}

function isEnterKey(data: string): boolean {
	return matchesKey(data, "return") || matchesKey(data, "enter");
}

function isSpaceKey(data: string): boolean {
	return data === " " || matchesKey(data, "space");
}

function isDeleteTap(data: string): boolean {
	return data === "d" || data === "D" || matchesKey(data, "delete") || matchesKey(data, "backspace");
}

function shiftDifficulty(current: TodoDifficulty, delta: -1 | 1): TodoDifficulty {
	const currentIndex = TODO_DIFFICULTY_ORDER.indexOf(current);
	const nextIndex = Math.max(0, Math.min(TODO_DIFFICULTY_ORDER.length - 1, currentIndex + delta));
	return TODO_DIFFICULTY_ORDER[nextIndex] ?? current;
}

function findWordLeft(text: string, cursor: number): number {
	let i = cursor;
	while (i > 0 && text[i - 1] === " ") i--;
	while (i > 0 && text[i - 1] !== " ") i--;
	return i;
}

function findWordRight(text: string, cursor: number): number {
	let i = cursor;
	while (i < text.length && text[i] === " ") i++;
	while (i < text.length && text[i] !== " ") i++;
	return i;
}

function renderInputWithCursor(
	text: string,
	cursor: number,
	accent: (text: string) => string,
	normal: (text: string) => string,
	highlight: (text: string) => string,
): string {
	const clampedCursor = Math.max(0, Math.min(cursor, text.length));
	const before = text.slice(0, clampedCursor);

	if (clampedCursor < text.length) {
		const current = text[clampedCursor] ?? "";
		const after = text.slice(clampedCursor + 1);
		return `${accent("> ")}${normal(before)}${highlight(current)}${normal(after)}`;
	}

	return `${accent("> ")}${normal(before)}${highlight(" ")}`;
}

async function showListModal(ctx: ExtensionCommandContext, todos: TodoItem[]): Promise<void> {
	if (!ctx.hasUI) {
		console.log(buildTodoLines(todos).join("\n"));
		return;
	}

	let modalTodos = cloneTodos(todos);
	let selected = 0;
	let grabbedIndex: number | undefined;
	let grabSnapshot: TodoItem[] | undefined;
	let pendingDeleteIndex: number | undefined;
	let pendingDeleteAt = 0;
	let statusLine = "";

	let mode: "browse" | "add" | "edit" = "browse";
	let addText = "";
	let addCursor = 0;
	let editIndex: number | undefined;

	const clampSelected = () => {
		if (modalTodos.length === 0) {
			selected = 0;
			return;
		}
		selected = Math.max(0, Math.min(selected, modalTodos.length - 1));
	};

	const clearDeleteConfirm = () => {
		pendingDeleteIndex = undefined;
		pendingDeleteAt = 0;
	};

	const saveAndRefresh = () => {
		writeTodos(modalTodos);
		modalTodos = readTodos();
		clampSelected();
	};

	const clearInputMode = () => {
		mode = "browse";
		addText = "";
		addCursor = 0;
		editIndex = undefined;
	};

	const startGrab = () => {
		if (modalTodos.length === 0) return;
		grabSnapshot = cloneTodos(modalTodos);
		grabbedIndex = selected;
		statusLine = "";
		clearDeleteConfirm();
	};

	const dropGrab = () => {
		if (grabbedIndex === undefined) return;
		saveAndRefresh();
		grabbedIndex = undefined;
		grabSnapshot = undefined;
		statusLine = "";
		clearDeleteConfirm();
	};

	const cancelGrab = () => {
		if (grabbedIndex === undefined) return;
		if (grabSnapshot) {
			modalTodos = cloneTodos(grabSnapshot);
			clampSelected();
		}
		grabbedIndex = undefined;
		grabSnapshot = undefined;
		statusLine = "";
		clearDeleteConfirm();
	};

	const moveGrabbed = (delta: number) => {
		if (grabbedIndex === undefined) return;
		const from = grabbedIndex;
		const to = Math.max(0, Math.min(modalTodos.length - 1, from + delta));
		if (to === from) return;

		const moving = modalTodos[from]!;
		modalTodos.splice(from, 1);
		modalTodos.splice(to, 0, moving);
		grabbedIndex = to;
		selected = to;
		statusLine = "";
	};

	const adjustSelectedDifficulty = (delta: -1 | 1) => {
		if (modalTodos.length === 0) return;
		const todo = modalTodos[selected];
		if (!todo) return;
		const nextDifficulty = shiftDifficulty(todo.difficulty, delta);
		if (nextDifficulty === todo.difficulty) return;
		todo.difficulty = nextDifficulty;
		if (grabbedIndex === undefined) {
			writeTodos(modalTodos);
		}
		statusLine = "";
		clearDeleteConfirm();
	};

	const startEdit = () => {
		if (modalTodos.length === 0) return;
		if (grabbedIndex !== undefined) return;
		const todo = modalTodos[selected];
		if (!todo) return;
		mode = "edit";
		editIndex = selected;
		addText = todo.text;
		addCursor = addText.length;
		statusLine = "";
		clearDeleteConfirm();
	};

	const commitEdit = () => {
		if (editIndex === undefined) return;
		if (addText.trim().length === 0) {
			statusLine = "Todo text required.";
			return;
		}
		const todo = modalTodos[editIndex];
		if (!todo) {
			clearInputMode();
			return;
		}

		todo.text = addText;
		saveAndRefresh();
		selected = Math.max(0, Math.min(editIndex, modalTodos.length - 1));
		clearInputMode();
		clearDeleteConfirm();
		statusLine = "";
	};

	const commitAdd = () => {
		if (addText.trim().length === 0) {
			statusLine = "Todo text required.";
			return;
		}

		modalTodos.push({
			id: 0,
			text: addText,
			createdAt: new Date().toISOString(),
			difficulty: DEFAULT_TODO_DIFFICULTY,
		});
		saveAndRefresh();
		selected = Math.max(0, modalTodos.length - 1);
		clearInputMode();
		clearDeleteConfirm();
		statusLine = "";
	};

	await ctx.ui.custom<void>((tui, theme, _keybindings, done) => {
		return {
			render(width: number): string[] {
				const now = Date.now();
				if (pendingDeleteIndex !== undefined && now - pendingDeleteAt > DELETE_CONFIRM_WINDOW_MS) {
					clearDeleteConfirm();
				}

				const out: string[] = [];
				out.push("");
				out.push(truncateToWidth(`\x1b[97m${theme.bold("[TODO]")}\x1b[0m`, width));
				out.push("");

				if (mode === "add" || mode === "edit") {
					out.push(truncateToWidth(theme.fg("muted", mode === "add" ? "Add new todo:" : "Edit todo:"), width));
					out.push(
						truncateToWidth(
							renderInputWithCursor(
								addText,
								addCursor,
								(t) => theme.fg("accent", t),
								(t) => theme.fg("text", t),
								(t) => `\x1b[47m\x1b[30m${t}\x1b[0m`,
							),
							width,
						),
					);
					out.push("");
				} else if (modalTodos.length === 0) {
					out.push(truncateToWidth(theme.fg("dim", "No global todos."), width));
					out.push(truncateToWidth(theme.fg("dim", "Press Enter to add one."), width));
					out.push("");
				} else {
					for (let i = 0; i < modalTodos.length; i++) {
						const todo = modalTodos[i]!;
						const isSelected = i === selected;
						const isGrabbed = i === grabbedIndex;

						const marker = isGrabbed
							? theme.fg("warning", "✦")
							: isSelected
								? "\x1b[97m❯\x1b[0m"
								: theme.fg("dim", " ");
						const colored =
							todo.difficulty === "easy"
								? theme.fg("accent", ` ${todo.text}`)
								: todo.difficulty === "hard"
									? theme.fg("error", ` ${todo.text}`)
									: theme.fg("warning", ` ${todo.text}`);
						const styled = isSelected ? theme.bold(colored) : colored;
						out.push(truncateToWidth(`${marker}${styled}`, width));
					}
					out.push("");
				}

				if (statusLine.length > 0) {
					out.push(truncateToWidth(theme.fg("warning", statusLine), width));
					out.push("");
				}

				if (mode === "add" || mode === "edit") {
					out.push(
						truncateToWidth(
							theme.fg("dim", mode === "add" ? "type • opt+←/→ word • opt+delete word • enter add • esc cancel" : "type • opt+←/→ word • opt+delete word • enter save • esc cancel"),
							width,
						),
					);
				} else if (grabbedIndex !== undefined) {
					out.push(truncateToWidth(theme.fg("dim", "↑↓ move • ←→ difficulty • space/enter drop • esc cancel"), width));
				} else {
					out.push(truncateToWidth(theme.fg("dim", "↑↓ select • ←→ difficulty • space grab • enter new • e edit • d/delete x2 delete • esc close"), width));
				}
				out.push("");

				return out;
			},
			invalidate(): void {},
			handleInput(data: string): void {
				if (mode === "add" || mode === "edit") {
					if (matchesKey(data, "escape") || matchesKey(data, "ctrl+c")) {
						clearInputMode();
						statusLine = "";
						tui.requestRender();
						return;
					}

					if (isEnterKey(data)) {
						if (mode === "add") commitAdd();
						else commitEdit();
						tui.requestRender();
						return;
					}

					if (matchesKey(data, "alt+backspace") || matchesKey(data, "ctrl+w")) {
						if (addCursor > 0) {
							const nextCursor = findWordLeft(addText, addCursor);
							addText = addText.slice(0, nextCursor) + addText.slice(addCursor);
							addCursor = nextCursor;
						}
						tui.requestRender();
						return;
					}

					if (matchesKey(data, "alt+left") || matchesKey(data, "ctrl+left") || matchesKey(data, "alt+b")) {
						addCursor = findWordLeft(addText, addCursor);
						tui.requestRender();
						return;
					}

					if (matchesKey(data, "alt+right") || matchesKey(data, "ctrl+right") || matchesKey(data, "alt+f")) {
						addCursor = findWordRight(addText, addCursor);
						tui.requestRender();
						return;
					}

					if (matchesKey(data, "backspace")) {
						if (addCursor > 0) {
							addText = addText.slice(0, addCursor - 1) + addText.slice(addCursor);
							addCursor--;
						}
						tui.requestRender();
						return;
					}

					if (matchesKey(data, "left")) {
						addCursor = Math.max(0, addCursor - 1);
						tui.requestRender();
						return;
					}

					if (matchesKey(data, "right")) {
						addCursor = Math.min(addText.length, addCursor + 1);
						tui.requestRender();
						return;
					}

					if (data.length === 1 && data.charCodeAt(0) >= 32) {
						addText = addText.slice(0, addCursor) + data + addText.slice(addCursor);
						addCursor++;
						tui.requestRender();
						return;
					}

					tui.requestRender();
					return;
				}

				if (matchesKey(data, "escape") || matchesKey(data, "ctrl+c")) {
					if (grabbedIndex !== undefined) {
						cancelGrab();
						tui.requestRender();
						return;
					}
					done();
					return;
				}

				if (matchesKey(data, "up")) {
					if (grabbedIndex !== undefined) {
						moveGrabbed(-1);
					} else {
						selected = Math.max(0, selected - 1);
						statusLine = "";
					}
					clearDeleteConfirm();
					tui.requestRender();
					return;
				}

				if (matchesKey(data, "down")) {
					if (grabbedIndex !== undefined) {
						moveGrabbed(1);
					} else {
						selected = Math.min(Math.max(0, modalTodos.length - 1), selected + 1);
						statusLine = "";
					}
					clearDeleteConfirm();
					tui.requestRender();
					return;
				}

				if (matchesKey(data, "left")) {
					adjustSelectedDifficulty(-1);
					tui.requestRender();
					return;
				}

				if (matchesKey(data, "right")) {
					adjustSelectedDifficulty(1);
					tui.requestRender();
					return;
				}

				if (grabbedIndex !== undefined && (isSpaceKey(data) || isEnterKey(data))) {
					dropGrab();
					tui.requestRender();
					return;
				}

				if (isEnterKey(data)) {
					mode = "add";
					editIndex = undefined;
					addText = "";
					addCursor = 0;
					statusLine = "";
					clearDeleteConfirm();
					tui.requestRender();
					return;
				}

				if (data === "e" || data === "E") {
					startEdit();
					tui.requestRender();
					return;
				}

				if (isSpaceKey(data)) {
					startGrab();
					tui.requestRender();
					return;
				}

				if (isDeleteTap(data)) {
					if (modalTodos.length === 0) {
						statusLine = "No todos to delete.";
						clearDeleteConfirm();
						tui.requestRender();
						return;
					}

					const now = Date.now();
					const index = selected;
					const confirmed = pendingDeleteIndex === index && now - pendingDeleteAt <= DELETE_CONFIRM_WINDOW_MS;

					if (!confirmed) {
						pendingDeleteIndex = index;
						pendingDeleteAt = now;
						statusLine = "Press delete again to remove selected todo.";
						tui.requestRender();
						return;
					}

					modalTodos.splice(index, 1);
					saveAndRefresh();
					statusLine = "Deleted todo.";
					clearDeleteConfirm();
					tui.requestRender();
					return;
				}

				tui.requestRender();
			},
		};
	});
}

function notify(ctx: ExtensionCommandContext, message: string, level: "info" | "warning" | "error" = "info"): void {
	if (ctx.hasUI) {
		ctx.ui.notify(message, level);
		return;
	}
	if (level === "error") {
		console.error(message);
		return;
	}
	console.log(message);
}

export default function todoExtension(pi: ExtensionAPI) {
	const runTodoCommand = async (args: string, ctx: ExtensionCommandContext) => {
		const action = parseAction(args);
		const todos = readTodos();

		switch (action.type) {
			case "help": {
				if (ctx.hasUI) {
					for (const line of usage()) {
						notify(ctx, line, "info");
					}
				} else {
					console.log(usage().join("\n"));
				}
				return;
			}

			case "list": {
				await showListModal(ctx, todos);
				return;
			}

			case "clear": {
				writeTodos([]);
				notify(ctx, "Cleared all global todos.", "info");
				return;
			}

			case "delete": {
				const index = action.id - 1;
				if (index < 0 || index >= todos.length) {
					notify(ctx, "Todo not found.", "warning");
					return;
				}

				const nextTodos = todos.filter((_todo, i) => i !== index);
				writeTodos(nextTodos);
				notify(ctx, "Deleted todo.", "info");
				return;
			}

			case "add": {
				if (action.text.trim().length === 0) {
					notify(ctx, "Todo text required. See /todo help", "warning");
					return;
				}

				writeTodos([
					...todos,
					{
						id: 0,
						text: action.text,
						createdAt: new Date().toISOString(),
						difficulty: DEFAULT_TODO_DIFFICULTY,
					},
				]);
				notify(ctx, "Added todo.", "info");
				return;
			}
		}
	};

	pi.registerCommand("todo", {
		description: "Global todos in ~/.pi/todo/todo.json",
		handler: runTodoCommand,
	});

}
