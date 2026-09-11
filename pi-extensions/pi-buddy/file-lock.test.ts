import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { test, type TestContext } from "node:test";
import lockfile from "proper-lockfile";
import { loadBuddy, signal, waitFor } from "./test-host.ts";

function writer(t: TestContext, agentDir: string, kind: "settings" | "emotions", first: boolean) {
	const child = spawn(process.execPath, ["--experimental-vm-modules", "--experimental-strip-types", "--input-type=module", "--eval", `
		import * as fs from "node:fs";
		import { basename } from "node:path";
		import { loadBuddy, signal } from ${JSON.stringify(new URL("./test-host.ts", import.meta.url).href)};
		const buddy = await loadBuddy({ after() {} }, ${JSON.stringify(agentDir)});
		buddy.io.beforeLock = (_file, options) => {
			options.fs = { ...fs, mkdir(file, callback) {
				fs.mkdir(file, error => {
					if (error?.code === "EEXIST") process.send("contended");
					callback(error);
				});
			} };
		};
		buddy.io.beforeWrite = async file => {
			if (!basename(file).startsWith(".")) return;
			process.send("writing");
			if (${first}) await new Promise(resolve => process.once("message", resolve));
		};
		process.send("ready");
		await new Promise(resolve => process.once("message", resolve));
		if (${JSON.stringify(kind)} === "settings") {
			await buddy.api.saveSettings(${first} ? { enabled: false } : { position: "top-left" });
		} else {
			await buddy.api.addEmotion(${first}
				? { id: "juggling", action: "juggling three colorful balls" }
				: { id: "stretching", action: "stretching both arms overhead" }, signal());
		}
		process.send("done");
		process.disconnect();
	`], { stdio: ["ignore", "ignore", "pipe", "ipc"] });
	const messages: string[] = [];
	let stderr = "";
	let spawnError: Error | undefined;
	assert.ok(child.stderr);
	child.stderr.on("data", (data) => { stderr += data; });
	child.on("message", (message) => messages.push(String(message)));
	child.on("error", (error) => { spawnError = error; });
	const exited = new Promise<void>((resolve) => child.once("close", () => resolve()));
	t.after(async () => {
		if (child.exitCode === null && child.signalCode === null) child.kill();
		await exited;
	});
	return {
		messages,
		send: () => child.send("continue"),
		async wait(message: string) {
			await waitFor(() => {
				assert.ifError(spawnError);
				assert.ok(child.exitCode === null || child.exitCode === 0, stderr);
				return messages.includes(message);
			});
		},
	};
}

for (const kind of ["settings", "emotions"] as const) {
	test(`two processes preserve concurrent ${kind} changes`, async (t) => {
		const buddy = await loadBuddy(t);
		await buddy.api.readEmotions(signal());
		const first = writer(t, buddy.agentDir, kind, true);
		const second = writer(t, buddy.agentDir, kind, false);
		await Promise.all([first.wait("ready"), second.wait("ready")]);
		first.send();
		await first.wait("writing");
		second.send();
		// Observe an actual failed mkdir against the held lock, not a timing guess.
		await second.wait("contended");
		assert.ok(!second.messages.includes("writing"));
		first.send();
		await Promise.all([first.wait("done"), second.wait("done")]);
		if (kind === "settings") {
			const settings = await buddy.api.readSettings();
			assert.equal(settings.enabled, false);
			assert.equal(settings.position, "top-left");
		} else {
			const custom = JSON.parse(await fs.readFile(buddy.catalog, "utf8"));
			assert.deepEqual(custom.map((emotion: { id: string }) => emotion.id), ["juggling", "stretching"]);
		}
	});
}

test("failed transactions release the lock so later writes can succeed", async (t) => {
	const buddy = await loadBuddy(t);
	const file = path.join(buddy.agentDir, "pi-buddy.json");
	buddy.io.beforeWrite = () => { throw new Error("Disk full"); };
	await assert.rejects(buddy.api.saveSettings({ position: "top-left" }), /Disk full/);
	assert.equal(await lockfile.check(file), false);
	buddy.io.beforeWrite = undefined;
	assert.equal((await buddy.api.saveSettings({ position: "top-left" })).position, "top-left");
});

test("cancellation while waiting for another process never enters the transaction", async (t) => {
	const buddy = await loadBuddy(t);
	const file = path.join(buddy.agentDir, "pi-buddy.json");
	const release = await lockfile.lock(file);
	const controller = new AbortController();
	let waiting = false;
	let entered = false;
	buddy.io.beforeLock = () => { waiting = true; };
	const rejected = assert.rejects(buddy.api.withFileLock(file, async () => { entered = true; }, controller.signal), { name: "AbortError" });
	try {
		await waitFor(() => waiting);
		controller.abort();
	} finally {
		await release();
	}
	await rejected;
	assert.equal(entered, false);
	assert.equal(await lockfile.check(file), false);
});

test("abandoned locks can be recovered without changing the data format", async (t) => {
	const buddy = await loadBuddy(t);
	const file = path.join(buddy.agentDir, "pi-buddy.json");
	const abandoned = `${file}.lock`;
	await fs.mkdir(abandoned);
	const past = new Date(Date.now() - 60_000);
	await fs.utimes(abandoned, past, past);
	assert.equal((await buddy.api.saveSettings({ position: "top-left" })).position, "top-left");
	await assert.rejects(fs.access(abandoned), { code: "ENOENT" });
});

test("a lost lock aborts the transaction without releasing a replacement owner's lock", async (t) => {
	const buddy = await loadBuddy(t);
	const file = path.join(buddy.agentDir, "pi-buddy.json");
	const pending = Promise.withResolvers<void>();
	let entered = false;
	let compromise: ((error: Error) => void) | undefined;
	buddy.io.beforeLock = (_file, options) => { compromise = options.onCompromised; };
	const rejected = assert.rejects(buddy.api.withFileLock(file, async (signal) => {
		entered = true;
		await pending.promise;
		signal.throwIfAborted();
	}), /Lock lost/);
	await waitFor(() => entered);
	// Simulate the library retiring a compromised lock before calling onCompromised.
	await lockfile.unlock(file, { realpath: false });
	const release = await lockfile.lock(file, { realpath: false });
	try {
		assert.ok(compromise);
		compromise(new Error("Lock lost"));
		pending.resolve();
		await rejected;
		assert.equal(await lockfile.check(file), true);
	} finally {
		pending.resolve();
		await release();
	}
});
