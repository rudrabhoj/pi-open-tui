import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { Language } from "web-tree-sitter";
import { onTreeSitterReady, setCaptureFormatter, tsHighlight } from "../extensions/open-tui/render/treesitter.ts";

const require = createRequire(import.meta.url);

test("Bash uses the maintained WASM and preserves highlighted shell source", { timeout: 10_000 }, async (t) => {
	const expectedPath = require.resolve("tree-sitter-bash/tree-sitter-bash.wasm");
	const load = Language.load;
	let recordPath: (input: string | Uint8Array) => void = () => {};
	const requestedPath = new Promise<string | Uint8Array>((resolve) => { recordPath = resolve; });
	const ready = new Promise<void>((resolve) => { onTreeSitterReady(resolve); });
	t.mock.method(Language, "load", async (input: string | Uint8Array) => {
		recordPath(input);
		// Fail before compiling the old artifact: its native compiler allocations escape the JS heap limit.
		if (input !== expectedPath) throw new Error("Unsafe Bash grammar path");
		return load.call(Language, input);
	});
	setCaptureFormatter(() => (text) => `\x1b[31m${text}\x1b[39m`);
	const source = '#!/bin/bash\nfor name in one two; do\n  printf "%s\\n" "$name"\ndone\n';
	assert.equal(tsHighlight(source, "bash"), undefined);
	assert.equal(await requestedPath, expectedPath);
	await ready;

	const lines = tsHighlight(source, "bash");
	assert.ok(lines);
	assert.ok(lines.some((line) => line.includes("\x1b[31m")));
	assert.equal(lines.join("\n").replace(/\x1b\[[0-9;]*m/g, ""), source);
	assert.deepEqual(tsHighlight(source, "bash"), lines);
	// Give background WASM compilation time to finish, not just the first parse.
	await delay(1_000);
	assert.ok(process.memoryUsage().rss < 768 * 1024 * 1024, "Bash grammar exceeded the memory budget");
});
