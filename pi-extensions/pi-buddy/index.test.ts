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

const source = await fs.readFile(new URL("./index.ts", import.meta.url), "utf8");
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
		showOverlay: (component: any) => { panel = component; return { hide() {} }; },
		requestRender: () => {
			const lines = panel.render(26);
			const next = lines.at(-2).trim();
			if (next !== progress && !next.includes("…") && !next.includes("failed")) updates++;
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
			getCapabilities: () => ({ images: false }),
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
		Buffer, Error, URL, AbortSignal, AbortController, setInterval, clearInterval,
		fetch: async (_url: string, options: any) => {
			image.calls.push(JSON.parse(options.body));
			return image.status === 200
				? Response.json({ data: [{ b64_json: sheet.toString("base64") }] })
				: new Response("", { status: image.status });
		},
	});
	// Expose private operations only in this isolated test module, without expanding the extension's API.
	const module = new SourceTextModule(stripTypeScriptTypes(source + `
export { readEmotions, addEmotion, selectEmotion, readSprite, splitSheet, IMAGE_OPTIONS };
`), {
		context,
		initializeImportMeta: (meta) => { meta.url = new URL("./index.ts", import.meta.url).href; },
	});
	await module.link(async (specifier) => {
		const values = imports[specifier as keyof typeof imports];
		assert.ok(values, `Unexpected import: ${specifier}`);
		return new SyntheticModule(Object.keys(values), function () {
			for (const [name, value] of Object.entries(values)) this.setExport(name, value);
		}, { context });
	});
	await module.evaluate();
	const api = module.namespace as any;
	api.default(pi);
	await handlers.get("session_start")!({}, ctx);
	t.after(() => handlers.get("session_shutdown")!({}, ctx));
	return {
		api, ctx, agentDir, model, image, io, notifications, displayed, settleReply,
		catalog: path.join(agentDir, "pi-buddy", "emotions.json"),
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
	assert.ok(buddy.notifications.some((notice) => notice.text.includes("Pi Buddy stopped.")));
});

test("seeds 30 emotions once and preserves incremental additions across reloads", async (t) => {
	const buddy = await loadBuddy(t);
	const emotions = await buddy.api.readEmotions(signal());
	assert.equal(emotions.length, 30);
	assert.equal(new Set(emotions.map((emotion: any) => emotion.id)).size, 30);
	assert.equal(JSON.parse(await fs.readFile(buddy.catalog, "utf8")).length, 30);
	await Promise.all([
		buddy.api.addEmotion({ id: "juggling", action: "juggling three colorful balls" }, signal()),
		buddy.api.addEmotion({ id: "stretching", action: "stretching both arms overhead" }, signal()),
		buddy.api.addEmotion({ id: "juggling", action: "juggling four colorful balls" }, signal()),
	]);
	const reloaded = await loadBuddy(t, buddy.agentDir);
	const saved = await reloaded.api.readEmotions(signal());
	assert.equal(saved.length, 32);
	assert.equal(saved.find((emotion: any) => emotion.id === "juggling").action, "juggling three colorful balls");
	assert.equal(JSON.parse(await fs.readFile(new URL("./emotions.json", import.meta.url), "utf8")).length, 30);
});

test("deduplicates an identical visual action under a different ID", async (t) => {
	const buddy = await loadBuddy(t);
	const emotions = await buddy.api.readEmotions(signal());
	const existing = emotions.find((emotion: any) => emotion.id === "waving");
	const selected = await buddy.api.addEmotion({ id: "greeting", action: existing.action }, signal());
	assert.equal(selected.id, "waving");
	assert.equal((await buddy.api.readEmotions(signal())).length, 30);
});

test("rejects damaged or invalid catalogs without overwriting them", async (t) => {
	const buddy = await loadBuddy(t);
	await buddy.api.readEmotions(signal());
	for (const text of ["{", "[]", '[{"id":"../escape","action":"waving hello to everyone"}]',
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
	let selected = await buddy.api.selectEmotion("That worked!", "reply", emotions, buddy.ctx, signal());
	assert.equal(selected.id, "happy");
	assert.equal(selected.action, emotions.find((emotion: any) => emotion.id === "happy").action);
	assert.ok(buddy.model.calls[0].input.systemPrompt.includes('"id":"facepalming"'));
	assert.equal(buddy.model.calls[0].options.reasoningEffort, "none");
	buddy.model.output = '{"new":{"id":"juggling","action":" juggling   three colorful balls "}}';
	selected = await buddy.api.selectEmotion("juggle", "action", emotions, buddy.ctx, signal());
	assert.equal(selected.id, "juggling");
	assert.equal(selected.action, "juggling three colorful balls");
	assert.equal(await fs.readFile(buddy.catalog, "utf8"), initial, "selection alone must not mutate the catalog");
	buddy.model.output = '{"new":{"id":"happy","action":"doing a completely different animation"}}';
	selected = await buddy.api.selectEmotion("happy", "reply", emotions, buddy.ctx, signal());
	assert.equal(selected.action, emotions.find((emotion: any) => emotion.id === "happy").action);
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
		await assert.rejects(buddy.api.selectEmotion("hello", "reply", emotions, buddy.ctx, signal()), undefined, output);
	}
	buddy.model.output = '{"id":"happy"}';
	buddy.model.stopReason = "length";
	await assert.rejects(buddy.api.selectEmotion("hello", "reply", emotions, buddy.ctx, signal()), /could not select/);
	assert.equal(await fs.readFile(buddy.catalog, "utf8"), initial);
});

test("publishes six square PNGs and reuses them through the cache manifest", async (t) => {
	const buddy = await loadBuddy(t);
	assert.equal(await buddy.api.readSprite("test", signal()), undefined);
	const sprite = await buddy.api.splitSheet(sheet, "test", signal());
	assert.equal(sprite.frames.length, 6);
	assert.equal((await fs.readdir(sprite.directory)).length, 7);
	for (const frame of sprite.frames) {
		const metadata = await sharp(Buffer.from(frame, "base64")).metadata();
		assert.equal(metadata.width, 336);
		assert.equal(metadata.height, 336);
	}
	const cached = await buddy.api.readSprite("test", signal());
	assert.equal(cached.directory, sprite.directory);
	assert.deepEqual([...cached.frames], [...sprite.frames]);
});

test("missing, malformed, and corrupt cache entries become misses", async (t) => {
	const buddy = await loadBuddy(t);
	const sprite = await buddy.api.splitSheet(sheet, "test", signal());
	const manifest = path.join(buddy.sprites, "test.json");
	const original = await fs.readFile(manifest, "utf8");
	for (const value of ["{", "null", '{"directory":"../../outside"}', '{"directory":"sprite-missing"}']) {
		await fs.writeFile(manifest, value);
		assert.equal(await buddy.api.readSprite("test", signal()), undefined);
	}
	await fs.writeFile(manifest, original);
	await fs.writeFile(path.join(sprite.directory, "frame-3.png"), sheet.subarray(0, 40));
	assert.equal(await buddy.api.readSprite("test", signal()), undefined, "a PNG header alone is not a valid frame");
	await buddy.api.splitSheet(sheet, "test", signal());
	assert.ok(await buddy.api.readSprite("test", signal()));
});

test("failed and cancelled writes never publish partial cache entries", async (t) => {
	const buddy = await loadBuddy(t);
	buddy.io.beforeWrite = (file) => {
		if (file.endsWith("frame-3.png")) throw new Error("Disk full");
	};
	await assert.rejects(buddy.api.splitSheet(sheet, "failed", signal()), /Disk full/);
	assert.deepEqual(await fs.readdir(buddy.sprites), []);
	const controller = new AbortController();
	buddy.io.beforeWrite = (file) => {
		if (file.endsWith("frame-3.png")) controller.abort();
	};
	await assert.rejects(buddy.api.splitSheet(sheet, "cancelled", controller.signal));
	assert.deepEqual(await fs.readdir(buddy.sprites), []);
});

test("cancelled catalog writes and failed regeneration preserve existing data", async (t) => {
	const buddy = await loadBuddy(t);
	await buddy.api.readEmotions(signal());
	const initial = await fs.readFile(buddy.catalog, "utf8");
	const controller = new AbortController();
	buddy.io.beforeWrite = (file) => {
		if (path.basename(file).startsWith(".emotions-")) controller.abort();
	};
	await assert.rejects(buddy.api.addEmotion({ id: "juggling", action: "juggling three colorful balls" }, controller.signal));
	assert.equal(await fs.readFile(buddy.catalog, "utf8"), initial);
	assert.deepEqual(await fs.readdir(path.dirname(buddy.catalog)), ["emotions.json"]);
	buddy.io.beforeWrite = undefined;
	const existing = await buddy.api.splitSheet(sheet, "test", signal());
	const files = await fs.readdir(buddy.sprites);
	buddy.io.beforeWrite = (file) => {
		if (file.endsWith("frame-3.png")) throw new Error("Disk full");
	};
	await assert.rejects(buddy.api.splitSheet(sheet, "test", signal()), /Disk full/);
	assert.deepEqual(await fs.readdir(buddy.sprites), files);
	assert.equal((await buddy.api.readSprite("test", signal())).directory, existing.directory);
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
	const emotions = JSON.parse(await fs.readFile(buddy.catalog, "utf8"));
	emotions.find((emotion: any) => emotion.id === "happy").action = "smiling and clapping both hands";
	await fs.writeFile(buddy.catalog, JSON.stringify(emotions));
	await buddy.act("happy");
	assert.equal(buddy.image.calls.length, 4);
	buddy.api.IMAGE_OPTIONS.quality = "medium";
	await buddy.act("happy");
	assert.equal(buddy.image.calls.length, 5);
	assert.equal(buddy.image.calls.at(-1).quality, "medium");
});

test("changing the default clears all managed sprites but keeps emotions and project exports", async (t) => {
	const buddy = await loadBuddy(t);
	await buddy.act("happy");
	await buddy.act("angry");
	await buddy.api.splitSheet(sheet, "earlier-avatar", signal());
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
	assert.ok(buddy.notifications.some((notice) => notice.text.includes("Cached sprites cleared.")));
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
	assert.ok(!buddy.notifications.some((notice) => notice.text.includes("Cached sprites cleared.")));
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
		assert.ok(buddy.notifications.some((notice) => notice.text.includes("changing avatars")));
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
