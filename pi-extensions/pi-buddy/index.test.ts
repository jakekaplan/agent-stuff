// Run: node --experimental-vm-modules --experimental-strip-types --test index.test.ts
import assert from "node:assert/strict";
import * as crypto from "node:crypto";
import * as fs from "node:fs/promises";
import { stripTypeScriptTypes } from "node:module";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { test, type TestContext } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { createContext, SourceTextModule, SyntheticModule } from "node:vm";
import sharp from "sharp";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

const sheet = await sharp({ create: { width: 1008, height: 672, channels: 3, background: "#ddd" } }).png().toBuffer();
const signal = () => new AbortController().signal;

async function waitFor(predicate: () => boolean) {
	const deadline = Date.now() + 5000;
	while (!predicate()) {
		assert.ok(Date.now() < deadline, "Timed out waiting for the buddy's background update");
		await delay(10);
	}
}

async function loadBuddy(t: TestContext, agentDir?: string) {
	if (!agentDir) {
		agentDir = await fs.mkdtemp(path.join(tmpdir(), "pi-buddy-test-"));
		const temporary = agentDir;
		t.after(() => fs.rm(temporary, { recursive: true, force: true }));
		await fs.writeFile(path.join(agentDir, "pi-buddy.json"), JSON.stringify({ description: "a small robot", enabled: true }));
	}
	const model = {
		output: '{"id":"happy"}', stopReason: "stop", available: true, calls: [] as any[],
		beforeComplete: undefined as (() => Promise<void>) | undefined,
	};
	const image = { status: 200, calls: [] as any[] };
	const io = {
		beforeWrite: undefined as ((file: string) => void | Promise<void>) | undefined,
		beforeRemove: undefined as ((file: string) => void | Promise<void>) | undefined,
	};
	const notifications: { text: string; level: string }[] = [];
	const displayed: string[] = [];
	const labels: string[] = [];
	const dialogs = {
		choices: [] as (number | string | undefined)[],
		inputs: [] as (string | undefined)[],
		confirmations: [] as boolean[],
		shown: [] as { kind: string; title: string; options?: string[]; message?: string }[],
	};
	const capabilities = { images: false };
	const overlays: { anchor: string; hidden: boolean }[] = [];
	const timers = new Map<object, { callback: () => void; interval: number }>();
	const handlers = new Map<string, (...args: any[]) => any>();
	let command: any;
	let widget: any;
	let panel: any;
	let progress = "";
	let updates = 0;
	const queues = new Map<string, Promise<unknown>>();
	const pi = {
		on: (event: string, handler: (...args: any[]) => any) => handlers.set(event, handler),
		registerCommand: (_name: string, definition: any) => { command = definition; },
	};
	const tui = {
		showOverlay: (component: any, options: { anchor: string }) => {
			panel = component;
			const overlay = { anchor: options.anchor, hidden: false };
			overlays.push(overlay);
			return { hide() { overlay.hidden = true; } };
		},
		requestRender: () => {
			const lines = panel.render(26);
			const next = lines.at(-2).slice(1, -1).trim();
			labels.push(next);
			if (next !== progress && !["●··", "·●·", "··●"].includes(next) && next !== "Update failed") updates++;
			progress = next;
		},
	};
	const ctx = {
		mode: "tui",
		cwd: path.join(agentDir, "project"),
		sessionManager: { getBranch: () => branch },
		modelRegistry: {
			find: () => model.available ? {} : undefined,
			complete: async (_model: unknown, input: unknown, options: unknown) => {
				model.calls.push({ input, options });
				await model.beforeComplete?.();
				return { stopReason: model.stopReason, content: [{ type: "text", text: model.output }] };
			},
			getProviderAuth: async () => ({ auth: { apiKey: `header.${Buffer.from(JSON.stringify({
				"https://api.openai.com/auth": { chatgpt_account_id: "test" },
			})).toString("base64url")}.signature` } }),
		},
		ui: {
			select: async (title: string, options: string[]) => {
				dialogs.shown.push({ kind: "select", title, options });
				const choice = dialogs.choices.shift();
				const selected = typeof choice === "number" ? options[choice] : choice;
				if (choice !== undefined) assert.ok(selected !== undefined && options.includes(selected), `Invalid menu choice: ${choice}`);
				return selected;
			},
			input: async (title: string) => {
				dialogs.shown.push({ kind: "input", title });
				return dialogs.inputs.shift();
			},
			confirm: async (title: string, message: string) => {
				dialogs.shown.push({ kind: "confirm", title, message });
				return dialogs.confirmations.shift() ?? false;
			},
			notify: (text: string, level: string) => notifications.push({ text, level }),
			setWidget: (_name: string, factory: any) => {
				widget?.dispose();
				widget = factory?.(tui, { fg: (_color: string, text: string) => text });
			},
		},
	};
	let branch: any[] = [];
	function settleReply(text: string) {
		branch = [{ id: crypto.randomUUID(), type: "message", message: {
			role: "assistant", stopReason: "stop", content: [{ type: "text", text }],
		} }];
		handlers.get("agent_settled")!({}, ctx);
	}
	const imports = {
		"node:crypto": crypto,
		"node:fs/promises": {
			...fs,
			writeFile: async (file: any, ...args: any[]) => {
				await io.beforeWrite?.(String(file));
				return (fs.writeFile as any)(file, ...args);
			},
			rm: async (file: any, ...args: any[]) => {
				await io.beforeRemove?.(String(file));
				return (fs.rm as any)(file, ...args);
			},
		},
		"node:path": path,
		"@earendil-works/pi-coding-agent": {
			getAgentDir: () => agentDir,
			withFileMutationQueue: async (file: string, fn: () => Promise<unknown>) => {
				const pending = (queues.get(file) ?? Promise.resolve()).then(fn);
				queues.set(file, pending.catch(() => {}));
				return pending;
			},
		},
		"@earendil-works/pi-tui": {
			allocateImageId: () => 1,
			getCapabilities: () => capabilities,
			Image: class {
				constructor(data: string) { displayed.push(data); }
				render() { return ["sprite"]; }
				invalidate() {}
			},
			truncateToWidth: (text: string, width: number) => text.slice(0, width),
			visibleWidth: (text: string) => text.length,
		},
		sharp: { default: sharp },
	};
	const context = createContext({
		Buffer, Error, URL, AbortSignal, AbortController,
		setInterval: (callback: () => void, interval: number) => {
			const timer = { unref() {} };
			timers.set(timer, { callback, interval });
			return timer;
		},
		clearInterval: (timer: object) => timers.delete(timer),
		fetch: async (_url: string, options: any) => {
			image.calls.push(JSON.parse(options.body));
			return image.status === 200
				? Response.json({ data: [{ b64_json: sheet.toString("base64") }] })
				: new Response("", { status: image.status });
		},
	});
	// Load real module exports, mocking only the Pi host and external I/O boundaries.
	const modules = new Map<string, Promise<SourceTextModule>>();
	function loadModule(url: URL): Promise<SourceTextModule> {
		let pending = modules.get(url.href);
		if (!pending) {
			pending = fs.readFile(url, "utf8").then((source) => new SourceTextModule(stripTypeScriptTypes(source), {
				context,
				identifier: url.href,
				initializeImportMeta: (meta) => { meta.url = url.href; },
			}));
			modules.set(url.href, pending);
		}
		return pending;
	}
	const module = await loadModule(new URL("./index.ts", import.meta.url));
	await module.link(async (specifier, parent) => {
		if (specifier.startsWith(".")) return loadModule(new URL(specifier, parent.identifier));
		const values = imports[specifier as keyof typeof imports];
		assert.ok(values, `Unexpected import: ${specifier}`);
		return new SyntheticModule(Object.keys(values), function () {
			for (const [name, value] of Object.entries(values)) this.setExport(name, value);
		}, { context });
	});
	await module.evaluate();
	const api = {
		...(await loadModule(new URL("./emotions.ts", import.meta.url))).namespace,
		...(await loadModule(new URL("./sprites.ts", import.meta.url))).namespace,
		...(await loadModule(new URL("./settings.ts", import.meta.url))).namespace,
	} as typeof import("./emotions.ts") & typeof import("./sprites.ts") & typeof import("./settings.ts");
	(module.namespace as { default: (pi: unknown) => void }).default(pi);
	await handlers.get("session_start")!({}, ctx);
	t.after(() => handlers.get("session_shutdown")!({}, ctx));
	return {
		api, agentDir, model, image, io, notifications, displayed, labels, settleReply, timers, dialogs, capabilities, overlays,
		// The mock implements only the host capabilities exercised by this extension.
		ctx: ctx as unknown as ExtensionContext,
		tick: () => { for (const { callback } of [...timers.values()]) callback(); },
		catalog: path.join(agentDir, "pi-buddy", "custom-emotions.json"),
		legacy: path.join(agentDir, "pi-buddy", "emotions.json"),
		sprites: path.join(agentDir, "pi-buddy", "sprites"),
		render: (): string[] => panel.render(26),
		command: (input: string) => command.handler(input, ctx),
		async act(input: string) {
			const previous = updates;
			await command.handler(input, ctx);
			await waitFor(() => updates > previous);
		},
		async reply(text: string) {
			const previous = updates;
			settleReply(text);
			await waitFor(() => updates > previous);
		},
	};
}

test("bare /pi-buddy opens settings and cancellation does not mutate state", async (t) => {
	const buddy = await loadBuddy(t);
	const before = await fs.readFile(path.join(buddy.agentDir, "pi-buddy.json"), "utf8");
	await buddy.command("");
	assert.equal(buddy.dialogs.shown[0].title, "Pi Buddy settings");
	assert.equal(buddy.dialogs.shown[0].options?.length, 5);
	assert.ok(buddy.dialogs.shown[0].options?.includes("Position: Bottom right"));
	assert.equal(await fs.readFile(path.join(buddy.agentDir, "pi-buddy.json"), "utf8"), before);
	assert.equal(buddy.image.calls.length, 0);
	assert.equal(buddy.model.calls.length, 0);
});

test("settings use short confirmations and status messages without quota warnings", async (t) => {
	const buddy = await loadBuddy(t);
	buddy.dialogs.choices.push(0, 0, 1, 3, 4);
	buddy.dialogs.inputs.push("a small fox");
	buddy.dialogs.confirmations.push(true, true, true);
	await buddy.command("");
	assert.deepEqual(buddy.notifications.map((notice) => notice.text), [
		"Automatic reactions off.",
		"Automatic reactions on.",
		"Avatar saved. Images cleared.",
		"Custom emotions reset.",
		"Images cleared.",
	]);
	assert.deepEqual(buddy.dialogs.shown.filter((dialog) => dialog.kind === "confirm").map((dialog) => dialog.message), [
		"Old images will be cleared.",
		"Default emotions and cached images will stay.",
		"Your avatar and emotions will stay.",
	]);
});

test("settings default old files to bottom-right and reject invalid positions", async (t) => {
	const buddy = await loadBuddy(t);
	assert.equal((await buddy.api.readSettings()).position, "bottom-right");
	for (const position of ["center", "", null, 3]) {
		assert.throws(() => buddy.api.parseSettings({ description: "a robot", enabled: true, position }), /position/);
	}
	const original = await fs.readFile(path.join(buddy.agentDir, "pi-buddy.json"), "utf8");
	buddy.io.beforeWrite = (file) => {
		if (path.basename(file).startsWith(".pi-buddy-")) throw new Error("Disk full");
	};
	await assert.rejects(buddy.api.saveSettings({ position: "top-left" }), /Disk full/);
	assert.equal(await fs.readFile(path.join(buddy.agentDir, "pi-buddy.json"), "utf8"), original);
});

test("the settings toggle and existing shortcuts share enable/disable behavior", async (t) => {
	const buddy = await loadBuddy(t);
	await buddy.act("happy");
	buddy.dialogs.choices.push(0);
	await buddy.command("");
	assert.equal((await buddy.api.readSettings()).enabled, false);
	assert.ok(buddy.overlays.every((overlay) => overlay.hidden));
	buddy.settleReply("We did it!");
	assert.equal(buddy.model.calls.length, 0);
	await buddy.command("on");
	assert.equal((await buddy.api.readSettings()).enabled, true);
	await buddy.command("stop");
	buddy.dialogs.choices.push(0);
	await buddy.command("");
	assert.equal((await buddy.api.readSettings()).enabled, true);
	await buddy.reply("We did it again!");
	assert.equal(buddy.image.calls.length, 1);
});

test("all four corners persist without replacing sprites or animation timers", async (t) => {
	const buddy = await loadBuddy(t);
	buddy.capabilities.images = true;
	await buddy.act("happy");
	const timers = [...buddy.timers.keys()];
	const files = await fs.readdir(buddy.sprites);
	for (const [index, corner] of ["top-left", "top-right", "bottom-left", "bottom-right"].entries()) {
		buddy.dialogs.choices.push(2, index);
		await buddy.command("");
		assert.equal((await buddy.api.readSettings()).position, corner);
		assert.equal(buddy.overlays.at(-1)?.anchor, corner);
		assert.equal(buddy.overlays.filter((overlay) => !overlay.hidden).length, 1);
		assert.deepEqual([...buddy.timers.keys()], timers);
		assert.equal(buddy.displayed.length, 6);
	}
	assert.deepEqual(await fs.readdir(buddy.sprites), files);
	assert.equal(buddy.image.calls.length, 1);
	buddy.dialogs.choices.push(2, 1);
	await buddy.command("");
	const reloaded = await loadBuddy(t, buddy.agentDir);
	await reloaded.act("happy");
	assert.equal(reloaded.overlays.at(-1)?.anchor, "top-right");
	assert.equal(reloaded.image.calls.length, 0);
});

test("repositioning during generation preserves the current sprite and pending update", async (t) => {
	const buddy = await loadBuddy(t);
	await buddy.act("happy");
	const writing = Promise.withResolvers<void>();
	let waiting = false;
	buddy.io.beforeWrite = (file) => {
		if (file.endsWith("frame-3.png")) { waiting = true; return writing.promise; }
	};
	await buddy.command("angry");
	try {
		await waitFor(() => waiting);
		const timers = [...buddy.timers.keys()];
		buddy.dialogs.choices.push(2, 0);
		await buddy.command("");
		assert.equal(buddy.overlays.at(-1)?.anchor, "top-left");
		assert.deepEqual([...buddy.timers.keys()], timers);
		assert.equal(buddy.displayed.length, 6);
	} finally {
		writing.resolve();
	}
	await waitFor(() => buddy.displayed.length === 12);
	assert.equal(buddy.labels.at(-1), "angry");
	assert.equal(buddy.image.calls.length, 2);
});

test("avatar settings confirm cache deletion and use the same default operation", async (t) => {
	const buddy = await loadBuddy(t);
	await buddy.act("happy");
	buddy.dialogs.choices.push(1);
	buddy.dialogs.inputs.push("a small fox");
	buddy.dialogs.confirmations.push(false);
	await buddy.command("");
	assert.equal((await buddy.api.readSettings()).description, "a small robot");
	await fs.access(buddy.sprites);
	buddy.dialogs.choices.push(1);
	buddy.dialogs.inputs.push("a small fox");
	buddy.dialogs.confirmations.push(true);
	await buddy.command("");
	assert.equal((await buddy.api.readSettings()).description, "a small fox");
	await assert.rejects(fs.access(buddy.sprites), { code: "ENOENT" });
	await buddy.act("happy");
	assert.ok(buddy.image.calls.at(-1).prompt.includes("a small fox"));
});

test("migrates learned entries once without changing the legacy catalog", async (t) => {
	const buddy = await loadBuddy(t);
	const defaults = JSON.parse(await fs.readFile(new URL("./emotions.json", import.meta.url), "utf8"));
	const custom = { id: "juggling", action: "juggling three colorful balls" };
	const legacy = JSON.stringify([...defaults, custom]);
	await fs.mkdir(path.dirname(buddy.legacy), { recursive: true });
	await fs.writeFile(buddy.legacy, legacy);
	assert.equal((await buddy.api.readEmotions(signal())).length, 31);
	assert.deepEqual(JSON.parse(await fs.readFile(buddy.catalog, "utf8")), [custom]);
	assert.equal(await fs.readFile(buddy.legacy, "utf8"), legacy);
	await buddy.act("happy");
	const files = await fs.readdir(buddy.sprites);
	buddy.dialogs.choices.push(3);
	buddy.dialogs.confirmations.push(true);
	await buddy.command("");
	assert.deepEqual(JSON.parse(await fs.readFile(buddy.catalog, "utf8")), []);
	assert.deepEqual(await fs.readdir(buddy.sprites), files);
	const reloaded = await loadBuddy(t, buddy.agentDir);
	assert.equal((await reloaded.api.readEmotions(signal())).length, 30, "reset must not re-import legacy entries");
	assert.equal(await fs.readFile(buddy.legacy, "utf8"), legacy);
});

test("reset pauses Luna so an in-flight proposal cannot re-add cleared emotions", async (t) => {
	const buddy = await loadBuddy(t);
	await buddy.api.addEmotion({ id: "juggling", action: "juggling three colorful balls" }, signal());
	const selection = Promise.withResolvers<void>();
	buddy.model.beforeComplete = () => selection.promise;
	buddy.model.output = '{"new":{"id":"stretching","action":"stretching both arms overhead"}}';
	await buddy.command("stretch your arms");
	await waitFor(() => buddy.model.calls.length === 1);
	buddy.dialogs.choices.push(3);
	buddy.dialogs.confirmations.push(true);
	let reset = false;
	const resetting = buddy.command("").then(() => { reset = true; });
	try {
		await waitFor(() => buddy.dialogs.shown.some((dialog) => dialog.kind === "confirm"));
		assert.equal(reset, false);
	} finally {
		selection.resolve();
		await resetting;
	}
	assert.equal((await buddy.api.readEmotions(signal())).length, 30);
	assert.equal(buddy.image.calls.length, 0);
	await buddy.act("happy");
	assert.equal(buddy.image.calls.length, 1);
});

test("reset cancellation preserves custom emotions; clear images preserves definitions and settings", async (t) => {
	const buddy = await loadBuddy(t);
	await buddy.api.addEmotion({ id: "juggling", action: "juggling three colorful balls" }, signal());
	await buddy.act("juggling");
	const settings = await fs.readFile(path.join(buddy.agentDir, "pi-buddy.json"), "utf8");
	const catalog = await fs.readFile(buddy.catalog, "utf8");
	buddy.dialogs.choices.push(3, 4);
	buddy.dialogs.confirmations.push(false, false);
	await buddy.command("");
	assert.equal(await fs.readFile(buddy.catalog, "utf8"), catalog);
	await fs.access(buddy.sprites);
	buddy.dialogs.choices.push(4);
	buddy.dialogs.confirmations.push(true);
	await buddy.command("");
	await assert.rejects(fs.access(buddy.sprites), { code: "ENOENT" });
	assert.equal(await fs.readFile(buddy.catalog, "utf8"), catalog);
	assert.equal(await fs.readFile(path.join(buddy.agentDir, "pi-buddy.json"), "utf8"), settings);
	await buddy.act("juggling");
	assert.equal(buddy.image.calls.length, 2);
});

test("invalid legacy data is left untouched and an explicit reset can recover", async (t) => {
	const buddy = await loadBuddy(t);
	await fs.mkdir(path.dirname(buddy.legacy), { recursive: true });
	await fs.writeFile(buddy.legacy, "{");
	await assert.rejects(buddy.api.readEmotions(signal()));
	await assert.rejects(fs.access(buddy.catalog), { code: "ENOENT" });
	assert.equal(await fs.readFile(buddy.legacy, "utf8"), "{");
	buddy.dialogs.choices.push(3);
	buddy.dialogs.confirmations.push(true);
	await buddy.command("");
	assert.equal((await buddy.api.readEmotions(signal())).length, 30);
	assert.equal(await fs.readFile(buddy.legacy, "utf8"), "{");
});

test("failed menu changes preserve stored values and release the reaction pause", async (t) => {
	const buddy = await loadBuddy(t);
	await buddy.act("happy");
	await buddy.api.addEmotion({ id: "juggling", action: "juggling three colorful balls" }, signal());
	const catalog = await fs.readFile(buddy.catalog, "utf8");
	buddy.io.beforeWrite = (file) => {
		if (path.basename(file).startsWith(".")) throw new Error("Disk full");
	};
	buddy.dialogs.choices.push(2, 0, 3);
	buddy.dialogs.confirmations.push(true);
	await buddy.command("");
	assert.equal((await buddy.api.readSettings()).position, "bottom-right");
	assert.equal(await fs.readFile(buddy.catalog, "utf8"), catalog);
	assert.equal(buddy.notifications.filter((notice) => notice.level === "error" && notice.text.includes("Disk full")).length, 2);
	buddy.io.beforeWrite = undefined;
	await buddy.act("happy");
	assert.equal(buddy.image.calls.length, 1);
});

test("shows only the emotion at the bottom left, whether generated or cached", async (t) => {
	const buddy = await loadBuddy(t);
	for (let update = 0; update < 2; update++) {
		await buddy.act("happy");
		const lines = buddy.render();
		assert.equal(lines.at(-2), `│ happy${" ".repeat(18)}│`);
		assert.ok(lines.at(-1)!.startsWith("╰"));
		assert.ok(lines.every((line) => line.length === 26));
		assert.ok(!lines.join("\n").includes("/pi-buddy stop"));
		assert.ok(!lines.join("\n").includes("(cached)"));
	}
	assert.equal(buddy.image.calls.length, 1);
	await buddy.command("stop");
	assert.ok(buddy.notifications.some((notice) => notice.text === "Automatic reactions off."));
});

test("leaves the image area blank while the first sprite loads", async (t) => {
	const buddy = await loadBuddy(t);
	const selection = Promise.withResolvers<void>();
	buddy.model.beforeComplete = () => selection.promise;
	await buddy.command("say hello");
	try {
		await waitFor(() => buddy.model.calls.length === 1);
		const lines = buddy.render();
		assert.equal(lines.length, 13);
		assert.ok(lines.slice(1, -2).every((line) => line === `│${" ".repeat(24)}│`));
		assert.equal(lines.at(-2), `│ ●··${" ".repeat(20)}│`);
		assert.equal(buddy.timers.size, 1);
		assert.equal([...buddy.timers.values()][0].interval, 250);
		for (const dots of ["·●·", "··●", "●··"]) {
			buddy.tick();
			assert.equal(buddy.render().at(-2), `│ ${dots}${" ".repeat(20)}│`);
			assert.deepEqual(buddy.render().slice(0, -2), lines.slice(0, -2));
		}
		assert.equal(buddy.displayed.length, 0);
	} finally {
		selection.resolve();
	}
	await waitFor(() => buddy.displayed.length === 6);
	assert.equal(buddy.timers.size, 0);
});

test("keeps the existing sprite and shows loading dots throughout an update", async (t) => {
	const buddy = await loadBuddy(t);
	await buddy.act("happy");
	assert.deepEqual(buddy.labels, ["●··", "happy"]);
	const previous = buddy.render();
	const selection = Promise.withResolvers<void>();
	buddy.model.output = '{"id":"angry"}';
	buddy.model.beforeComplete = () => selection.promise;
	buddy.io.beforeWrite = (file) => {
		if (file.endsWith(".png")) {
			assert.equal(buddy.render().at(-2), `│ ·●·${" ".repeat(20)}│`);
			assert.equal(buddy.displayed.length, 6);
		}
	};
	await buddy.command("get mad");
	try {
		await waitFor(() => buddy.model.calls.length === 1);
		assert.equal(buddy.render().at(-2), `│ ●··${" ".repeat(20)}│`);
		buddy.tick();
		assert.equal(buddy.render().at(-2), `│ ·●·${" ".repeat(20)}│`);
		assert.deepEqual(buddy.render().slice(0, -2), previous.slice(0, -2));
		assert.equal(buddy.displayed.length, 6);
	} finally {
		selection.resolve();
	}
	await waitFor(() => buddy.displayed.length === 12);
	assert.deepEqual(buddy.labels, ["●··", "happy", "●··", "·●·", "angry"]);
	assert.equal(buddy.timers.size, 0);
	await buddy.act("angry");
	assert.deepEqual(buddy.labels.slice(-2), ["●··", "angry"]);
	assert.equal(buddy.image.calls.length, 2, "the repeated emotion still uses its cache");
});

test("stopping the buddy clears the loading timer", async (t) => {
	const buddy = await loadBuddy(t);
	const selection = Promise.withResolvers<void>();
	buddy.model.beforeComplete = () => selection.promise;
	await buddy.command("say hello");
	try {
		await waitFor(() => buddy.model.calls.length === 1);
		assert.equal(buddy.timers.size, 1);
		await buddy.command("stop");
		assert.equal(buddy.timers.size, 0);
		const renders = buddy.labels.length;
		buddy.tick();
		assert.equal(buddy.labels.length, renders);
	} finally {
		selection.resolve();
	}
});

test("a failed update stops the loading timer", async (t) => {
	const buddy = await loadBuddy(t);
	buddy.image.status = 500;
	await buddy.command("happy");
	await waitFor(() => buddy.notifications.some((notice) => notice.text.includes("HTTP 500")));
	assert.equal(buddy.labels.at(-1), "Update failed");
	assert.equal(buddy.timers.size, 0);
});

test("combines 30 bundled emotions with separately persisted additions across reloads", async (t) => {
	const buddy = await loadBuddy(t);
	const emotions = await buddy.api.readEmotions(signal());
	assert.equal(emotions.length, 30);
	assert.equal(new Set(emotions.map((emotion: any) => emotion.id)).size, 30);
	assert.equal(JSON.parse(await fs.readFile(buddy.catalog, "utf8")).length, 0);
	await Promise.all([
		buddy.api.addEmotion({ id: "juggling", action: "juggling three colorful balls" }, signal()),
		buddy.api.addEmotion({ id: "stretching", action: "stretching both arms overhead" }, signal()),
		buddy.api.addEmotion({ id: "juggling", action: "juggling four colorful balls" }, signal()),
	]);
	const reloaded = await loadBuddy(t, buddy.agentDir);
	const saved = await reloaded.api.readEmotions(signal());
	assert.equal(saved.length, 32);
	assert.equal(saved.find((emotion) => emotion.id === "juggling")?.action, "juggling three colorful balls");
	assert.equal(JSON.parse(await fs.readFile(new URL("./emotions.json", import.meta.url), "utf8")).length, 30);
});

test("deduplicates an identical visual action under a different ID", async (t) => {
	const buddy = await loadBuddy(t);
	const emotions = await buddy.api.readEmotions(signal());
	const existing = emotions.find((emotion) => emotion.id === "waving");
	assert.ok(existing);
	const selected = await buddy.api.addEmotion({ id: "greeting", action: existing.action }, signal());
	assert.equal(selected.id, "waving");
	assert.equal((await buddy.api.readEmotions(signal())).length, 30);
});

test("rejects damaged or invalid catalogs without overwriting them", async (t) => {
	const buddy = await loadBuddy(t);
	await buddy.api.readEmotions(signal());
	for (const text of ["{", "{}", '[{"id":"happy","action":"smiling with a gentle bounce"}]', '[{"id":"../escape","action":"waving hello to everyone"}]',
		'[{"id":"happy","action":"smiling with a gentle bounce"},{"id":"happy","action":"bouncing with a happy smile"}]']) {
		await fs.writeFile(buddy.catalog, text);
		await assert.rejects(buddy.api.readEmotions(signal()));
		assert.equal(await fs.readFile(buddy.catalog, "utf8"), text);
	}
});

test("Luna selects canonical definitions and proposes normalized new actions", async (t) => {
	const buddy = await loadBuddy(t);
	const emotions = await buddy.api.readEmotions(signal());
	const initial = await fs.readFile(buddy.catalog, "utf8");
	const happy = emotions.find((emotion) => emotion.id === "happy");
	assert.ok(happy);
	let selected = await buddy.api.selectEmotion("That worked!", "reply", emotions, buddy.ctx, signal());
	assert.equal(selected.id, "happy");
	assert.equal(selected.action, happy.action);
	assert.ok(buddy.model.calls[0].input.systemPrompt.includes('"id":"facepalming"'));
	assert.equal(buddy.model.calls[0].options.reasoningEffort, "none");
	buddy.model.output = '{"new":{"id":"juggling","action":" juggling   three colorful balls "}}';
	selected = await buddy.api.selectEmotion("juggle", "action", emotions, buddy.ctx, signal());
	assert.equal(selected.id, "juggling");
	assert.equal(selected.action, "juggling three colorful balls");
	assert.equal(await fs.readFile(buddy.catalog, "utf8"), initial, "selection alone must not mutate the catalog");
	buddy.model.output = '{"new":{"id":"happy","action":"doing a completely different animation"}}';
	selected = await buddy.api.selectEmotion("happy", "reply", emotions, buddy.ctx, signal());
	assert.equal(selected.action, happy.action);
});

test("rejects malformed Luna choices without adding emotions", async (t) => {
	const buddy = await loadBuddy(t);
	const emotions = await buddy.api.readEmotions(signal());
	const initial = await fs.readFile(buddy.catalog, "utf8");
	for (const output of [
		"not JSON", 'null', '[]', '{"id":"unknown"}', '{"id":"happy","new":{}}',
		'{"new":{"id":"../escape","action":"juggling three colorful balls"}}',
		'{"new":{"id":"Juggling","action":"juggling three colorful balls"}}',
		'{"new":{"id":"juggling","action":"juggle"}}',
		'{"new":{"id":"juggling","action":"one two three four five six seven eight nine"}}',
		'{"new":{"id":"juggling","action":"juggling three colorful balls","appearance":"robot"}}',
	]) {
		buddy.model.output = output;
		await assert.rejects(buddy.api.selectEmotion("hello", "reply", emotions, buddy.ctx, signal()), /emotion/i, output);
	}
	buddy.model.output = '{"id":"happy"}';
	buddy.model.stopReason = "length";
	await assert.rejects(buddy.api.selectEmotion("hello", "reply", emotions, buddy.ctx, signal()), /could not select/);
	assert.equal(await fs.readFile(buddy.catalog, "utf8"), initial);
});

test("publishes six square PNGs and reuses them through the cache manifest", async (t) => {
	const buddy = await loadBuddy(t);
	assert.equal(await buddy.api.readSprite("test", signal()), undefined);
	const sprite = await buddy.api.saveSprite(sheet, "test", signal());
	assert.equal(sprite.frames.length, 6);
	assert.equal((await fs.readdir(sprite.directory)).length, 7);
	for (const frame of sprite.frames) {
		const metadata = await sharp(Buffer.from(frame, "base64")).metadata();
		assert.equal(metadata.width, 336);
		assert.equal(metadata.height, 336);
	}
	const cached = await buddy.api.readSprite("test", signal());
	assert.ok(cached);
	assert.equal(cached.directory, sprite.directory);
	assert.deepEqual([...cached.frames], [...sprite.frames]);
});

test("missing, malformed, and corrupt cache entries become misses", async (t) => {
	const buddy = await loadBuddy(t);
	const sprite = await buddy.api.saveSprite(sheet, "test", signal());
	const manifest = path.join(buddy.sprites, "test.json");
	const original = await fs.readFile(manifest, "utf8");
	for (const value of ["{", "null", '{"directory":"../../outside"}', '{"directory":"sprite-missing"}']) {
		await fs.writeFile(manifest, value);
		assert.equal(await buddy.api.readSprite("test", signal()), undefined);
	}
	await fs.writeFile(manifest, original);
	await fs.writeFile(path.join(sprite.directory, "frame-3.png"), sheet.subarray(0, 40));
	assert.equal(await buddy.api.readSprite("test", signal()), undefined, "a PNG header alone is not a valid frame");
	await buddy.api.saveSprite(sheet, "test", signal());
	assert.ok(await buddy.api.readSprite("test", signal()));
});

test("failed and cancelled writes never publish partial cache entries", async (t) => {
	const buddy = await loadBuddy(t);
	buddy.io.beforeWrite = (file) => {
		if (file.endsWith("frame-3.png")) throw new Error("Disk full");
	};
	await assert.rejects(buddy.api.saveSprite(sheet, "failed", signal()), /Disk full/);
	assert.deepEqual(await fs.readdir(buddy.sprites), []);
	const controller = new AbortController();
	buddy.io.beforeWrite = (file) => {
		if (file.endsWith("frame-3.png")) controller.abort();
	};
	await assert.rejects(buddy.api.saveSprite(sheet, "cancelled", controller.signal));
	assert.deepEqual(await fs.readdir(buddy.sprites), []);
});

test("cancelled catalog writes and failed regeneration preserve existing data", async (t) => {
	const buddy = await loadBuddy(t);
	await buddy.api.readEmotions(signal());
	const initial = await fs.readFile(buddy.catalog, "utf8");
	const controller = new AbortController();
	buddy.io.beforeWrite = (file) => {
		if (path.basename(file).startsWith(".custom-emotions-")) controller.abort();
	};
	await assert.rejects(buddy.api.addEmotion({ id: "juggling", action: "juggling three colorful balls" }, controller.signal));
	assert.equal(await fs.readFile(buddy.catalog, "utf8"), initial);
	assert.deepEqual(await fs.readdir(path.dirname(buddy.catalog)), ["custom-emotions.json"]);
	buddy.io.beforeWrite = undefined;
	const existing = await buddy.api.saveSprite(sheet, "test", signal());
	const files = await fs.readdir(buddy.sprites);
	buddy.io.beforeWrite = (file) => {
		if (file.endsWith("frame-3.png")) throw new Error("Disk full");
	};
	await assert.rejects(buddy.api.saveSprite(sheet, "test", signal()), /Disk full/);
	assert.deepEqual(await fs.readdir(buddy.sprites), files);
	assert.equal((await buddy.api.readSprite("test", signal()))?.directory, existing.directory);
});

test("superseded Luna selections neither add new emotions nor generate their sprites", async (t) => {
	const buddy = await loadBuddy(t);
	let release!: () => void;
	buddy.model.beforeComplete = () => new Promise<void>((resolve) => { release = resolve; });
	buddy.model.output = '{"new":{"id":"juggling","action":"juggling three colorful balls"}}';
	await buddy.command("juggle some balls");
	await waitFor(() => buddy.model.calls.length === 1);
	await buddy.command("happy");
	release();
	await waitFor(() => buddy.notifications.some((notice) => notice.text.includes("Pi Buddy happy:")));
	assert.equal((await buddy.api.readEmotions(signal())).length, 30);
	assert.equal(buddy.image.calls.length, 1);
	assert.ok(buddy.image.calls[0].prompt.includes("smiling with a gentle bounce"));
});

test("different replies reuse one sprite; exact IDs bypass Luna across sessions and projects", async (t) => {
	const buddy = await loadBuddy(t);
	await buddy.reply("The fix works!");
	await buddy.reply("The next fix works too!");
	assert.equal(buddy.model.calls.length, 2);
	assert.equal(buddy.image.calls.length, 1);
	assert.equal(buddy.image.calls[0].quality, "low");
	assert.equal(buddy.image.calls[0].size, "1008x672");
	assert.ok(buddy.image.calls[0].prompt.includes("six equal 336 by 336 cells"));
	const reloaded = await loadBuddy(t, buddy.agentDir);
	reloaded.ctx.cwd = path.join(buddy.agentDir, "another-project");
	reloaded.model.available = false;
	await reloaded.act("happy");
	assert.equal(reloaded.model.calls.length, 0);
	assert.equal(reloaded.image.calls.length, 0);
	assert.deepEqual(reloaded.displayed, buddy.displayed.slice(0, 6));
	assert.ok(reloaded.notifications.some((notice) => notice.text.includes("Pi Buddy happy:")));
});

test("new emotions persist automatically, even when the first image request fails", async (t) => {
	const buddy = await loadBuddy(t);
	buddy.model.output = '{"new":{"id":"juggling","action":"juggling three colorful balls"}}';
	buddy.image.status = 500;
	await buddy.command("juggle some balls");
	await waitFor(() => buddy.notifications.some((notice) => notice.text.includes("HTTP 500")));
	assert.equal((await buddy.api.readEmotions(signal())).length, 31);
	assert.equal(buddy.displayed.length, 0);
	buddy.image.status = 200;
	await buddy.act("juggling");
	await buddy.act("juggling");
	assert.equal(buddy.model.calls.length, 1);
	assert.equal(buddy.image.calls.length, 2, "one failed request, then one successful request, then a cache hit");
});

test("cache keys change with avatar, emotion action, and image settings", async (t) => {
	const buddy = await loadBuddy(t);
	await buddy.act("happy");
	await buddy.command("default a small fox");
	await buddy.act("happy");
	assert.equal(buddy.image.calls.length, 2);
	await buddy.command("default a small robot");
	await buddy.act("happy");
	assert.equal(buddy.image.calls.length, 3, "returning to the original avatar generates fresh sprites");
	await buddy.api.addEmotion({ id: "juggling", action: "juggling three colorful balls" }, signal());
	await buddy.act("juggling");
	assert.equal(buddy.image.calls.length, 4);
	const custom = JSON.parse(await fs.readFile(buddy.catalog, "utf8"));
	custom[0].action = "juggling five colorful balls";
	await fs.writeFile(buddy.catalog, JSON.stringify(custom));
	await buddy.act("juggling");
	assert.equal(buddy.image.calls.length, 5);
	const key = buddy.api.spriteKey("a small robot", custom[0]);
	const expected = crypto.createHash("sha256").update(JSON.stringify({ id: "juggling", ...buddy.image.calls.at(-1) })).digest("hex");
	assert.equal(key, expected, "cache keys include all request settings and the full prompt");
	await fs.access(path.join(buddy.sprites, `${key}.json`));
});

test("changing the default clears all managed sprites but keeps emotions and project exports", async (t) => {
	const buddy = await loadBuddy(t);
	await buddy.act("happy");
	await buddy.act("angry");
	await buddy.api.saveSprite(sheet, "earlier-avatar", signal());
	await buddy.api.addEmotion({ id: "juggling", action: "juggling three colorful balls" }, signal());
	const catalog = await fs.readFile(buddy.catalog, "utf8");
	const exports = path.join(buddy.ctx.cwd, "generated_images");
	await fs.mkdir(exports, { recursive: true });
	await fs.writeFile(path.join(exports, "sheet.png"), sheet);
	await buddy.command("default a small fox");
	await assert.rejects(fs.access(buddy.sprites), { code: "ENOENT" });
	assert.equal(await fs.readFile(buddy.catalog, "utf8"), catalog);
	assert.deepEqual(await fs.readFile(path.join(exports, "sheet.png")), sheet);
	assert.equal(JSON.parse(await fs.readFile(path.join(buddy.agentDir, "pi-buddy.json"), "utf8")).description, "a small fox");
	assert.ok(buddy.notifications.some((notice) => notice.text === "Avatar saved. Images cleared."));
	await buddy.act("happy");
	assert.equal(buddy.image.calls.length, 3);
	assert.ok(buddy.image.calls.at(-1).prompt.includes("a small fox"));
});

test("saving the same trimmed default retains its sprite cache", async (t) => {
	const buddy = await loadBuddy(t);
	await buddy.act("happy");
	const files = await fs.readdir(buddy.sprites);
	await buddy.command("default   a small robot  ");
	assert.deepEqual(await fs.readdir(buddy.sprites), files);
	await buddy.act("happy");
	assert.equal(buddy.image.calls.length, 1);
	assert.ok(buddy.notifications.some((notice) => notice.text === "Avatar saved."));
});

test("changing the default works before any sprites have been generated", async (t) => {
	const buddy = await loadBuddy(t);
	await buddy.command("default a small fox");
	assert.ok(!buddy.notifications.some((notice) => notice.level === "error"));
	await buddy.act("happy");
	assert.equal(buddy.image.calls.length, 1);
	assert.ok(buddy.image.calls[0].prompt.includes("a small fox"));
});

test("avatar changes await cancelled writes and cleanup, dropping queued and paused reactions", async (t) => {
	const buddy = await loadBuddy(t);
	await buddy.act("happy");
	const write = Promise.withResolvers<void>();
	const cleanup = Promise.withResolvers<void>();
	let writing = false;
	let cleaning = false;
	let changed = false;
	buddy.io.beforeWrite = (file) => {
		if (file.endsWith("frame-3.png")) {
			writing = true;
			return write.promise;
		}
	};
	buddy.io.beforeRemove = (file) => {
		if (path.basename(file).startsWith("sprite-")) {
			cleaning = true;
			return cleanup.promise;
		}
	};
	await buddy.command("angry");
	await waitFor(() => writing);
	await buddy.command("sad");
	const changing = buddy.command("default a small fox").then(() => { changed = true; });
	try {
		await buddy.command("excited");
		buddy.settleReply("We did it!");
		assert.ok(buddy.notifications.some((notice) => notice.text.includes("Updating settings")));
		assert.equal(buddy.image.calls.length, 2);
		assert.equal(buddy.model.calls.length, 0);
		write.resolve();
		await waitFor(() => cleaning);
		assert.equal(changed, false, "the default command must await cleanup, not just abort the request");
		await fs.access(buddy.sprites);
		assert.equal(JSON.parse(await fs.readFile(path.join(buddy.agentDir, "pi-buddy.json"), "utf8")).description, "a small robot");
	} finally {
		write.resolve();
		cleanup.resolve();
		await changing;
	}
	await assert.rejects(fs.access(buddy.sprites), { code: "ENOENT" });
	assert.equal(buddy.displayed.length, 6, "the cancelled sprite must never be displayed");
	assert.equal(buddy.image.calls.length, 2, "no queued or paused reaction should restart after cleanup");
	buddy.io.beforeWrite = undefined;
	buddy.io.beforeRemove = undefined;
	await buddy.act("angry");
	assert.equal(buddy.image.calls.length, 3);
	assert.ok(buddy.image.calls.at(-1).prompt.includes("a small fox"));
});

test("cache deletion failures retain the old default and release the reaction pause", async (t) => {
	const buddy = await loadBuddy(t);
	await buddy.act("happy");
	buddy.io.beforeRemove = (file) => {
		if (file === buddy.sprites) throw new Error("Permission denied");
	};
	await buddy.command("default a small fox");
	assert.ok(buddy.notifications.some((notice) => notice.level === "error" && notice.text.includes("Permission denied")));
	assert.equal(JSON.parse(await fs.readFile(path.join(buddy.agentDir, "pi-buddy.json"), "utf8")).description, "a small robot");
	await buddy.act("happy");
	assert.equal(buddy.image.calls.length, 1);
	buddy.io.beforeRemove = undefined;
	await buddy.command("default a small fox");
	await assert.rejects(fs.access(buddy.sprites), { code: "ENOENT" });
	await buddy.act("happy");
	assert.equal(buddy.image.calls.length, 2);
});

test("a damaged cached frame triggers generation on the next reaction", async (t) => {
	const buddy = await loadBuddy(t);
	await buddy.act("happy");
	const manifest = (await fs.readdir(buddy.sprites)).find((file) => file.endsWith(".json"))!;
	const { directory } = JSON.parse(await fs.readFile(path.join(buddy.sprites, manifest), "utf8"));
	await fs.rm(path.join(buddy.sprites, directory, "frame-2.png"));
	await buddy.act("happy");
	assert.equal(buddy.image.calls.length, 2);
	await buddy.act("happy");
	assert.equal(buddy.image.calls.length, 2);
});
