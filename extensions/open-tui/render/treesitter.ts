/**
 * Tree-sitter based syntax highlighting for TUI code rendering.
 *
 * Design constraints, in priority order:
 * 1. Zero cost until code is actually rendered: nothing initializes at
 *    startup. The first render of a language schedules an async load and
 *    falls back to the caller's legacy path (highlight.js); a ready callback
 *    lets the TUI re-render once the grammar is warm (~30ms).
 * 2. Bounded memory: grammars load once and stay resident (freeing and
 *    reloading churns the wasm heap), bounded by MAX_TOTAL_LANGS, plus a
 *    small block-level result cache.
 * 3. Fail open: any error (missing wasm, query/grammar version mismatch)
 *    permanently disables tree-sitter for that language and the legacy
 *    highlighter takes over. Never throws into a render path, never logs
 *    into the TUI.
 *
 * Theme coupling is inverted to avoid an import cycle: theme.ts injects a
 * capture-name -> formatter resolver via setCaptureFormatter().
 */

import { createRequire } from "node:module";
import path from "node:path";
import { Language, Parser, Query } from "web-tree-sitter";
import bashQuery from "./queries/bash.ts";
import cQuery from "./queries/c.ts";
import csharpQuery from "./queries/c_sharp.ts";
import cppQuery from "./queries/cpp.ts";
import cssQuery from "./queries/css.ts";
import dartQuery from "./queries/dart.ts";
import elixirQuery from "./queries/elixir.ts";
import goQuery from "./queries/go.ts";
import htmlQuery from "./queries/html.ts";
import javaQuery from "./queries/java.ts";
import javascriptQuery from "./queries/javascript.ts";
import jsonQuery from "./queries/json.ts";
import kotlinQuery from "./queries/kotlin.ts";
import luaQuery from "./queries/lua.ts";
import ocamlQuery from "./queries/ocaml.ts";
import phpQuery from "./queries/php.ts";
import pythonQuery from "./queries/python.ts";
import rubyQuery from "./queries/ruby.ts";
import rustQuery from "./queries/rust.ts";
import scalaQuery from "./queries/scala.ts";
import solidityQuery from "./queries/solidity.ts";
import tomlQuery from "./queries/toml.ts";
import typescriptQuery from "./queries/typescript.ts";
import yamlQuery from "./queries/yaml.ts";
import zigQuery from "./queries/zig.ts";

const require = createRequire(import.meta.url);

// web-tree-sitter's Language has no delete(): a loaded grammar module lives
// in the emscripten heap for the life of the process. Eviction is therefore
// impossible AND reloading would compile a duplicate module (repeated churn
// was observed exhausting v8's zone allocator). So: each grammar loads once,
// stays resident (~0.5-2.5MB), and a hard cap bounds the total. Sessions
// touching more languages than the cap fall back to highlight.js for the
// excess ones.
const MAX_TOTAL_LANGS = 12;
const MAX_HIGHLIGHT_BYTES = 200_000;
const BLOCK_CACHE_MAX = 512;
const BLOCK_CACHE_MAX_LEN = 2_048;

// language id (as used by getLanguageFromPath) -> grammar wasm basename and
// highlight query source. TS/TSX and C++ queries extend their base language,
// mirroring how the official repos structure them.
const LANGS: Record<string, { wasm: string; query: string }> = {
	rust: { wasm: "tree-sitter-rust", query: rustQuery },
	typescript: { wasm: "tree-sitter-typescript", query: `${javascriptQuery}\n${typescriptQuery}` },
	tsx: { wasm: "tree-sitter-tsx", query: `${javascriptQuery}\n${typescriptQuery}` },
	javascript: { wasm: "tree-sitter-javascript", query: javascriptQuery },
	python: { wasm: "tree-sitter-python", query: pythonQuery },
	go: { wasm: "tree-sitter-go", query: goQuery },
	bash: { wasm: "tree-sitter-bash", query: bashQuery },
	c: { wasm: "tree-sitter-c", query: cQuery },
	cpp: { wasm: "tree-sitter-cpp", query: `${cQuery}\n${cppQuery}` },
	json: { wasm: "tree-sitter-json", query: jsonQuery },
	css: { wasm: "tree-sitter-css", query: cssQuery },
	html: { wasm: "tree-sitter-html", query: htmlQuery },
	java: { wasm: "tree-sitter-java", query: javaQuery },
	ruby: { wasm: "tree-sitter-ruby", query: rubyQuery },
	php: { wasm: "tree-sitter-php", query: phpQuery },
	csharp: { wasm: "tree-sitter-c_sharp", query: csharpQuery },
	toml: { wasm: "tree-sitter-toml", query: tomlQuery },
	yaml: { wasm: "tree-sitter-yaml", query: yamlQuery },
	lua: { wasm: "tree-sitter-lua", query: luaQuery },
	kotlin: { wasm: "tree-sitter-kotlin", query: kotlinQuery },
	scala: { wasm: "tree-sitter-scala", query: scalaQuery },
	elixir: { wasm: "tree-sitter-elixir", query: elixirQuery },
	dart: { wasm: "tree-sitter-dart", query: dartQuery },
	ocaml: { wasm: "tree-sitter-ocaml", query: ocamlQuery },
	zig: { wasm: "tree-sitter-zig", query: zigQuery },
	solidity: { wasm: "tree-sitter-solidity", query: solidityQuery },
	// elm and swift are deliberately absent. elm's wasm faults at load with
	// "memory access out of bounds" and corrupts the shared wasm heap;
	// swift parses but corrupts state that crashes the process at exit
	// (reproducible with a single one-line parse). Their queries stay
	// vendored for when the bundled grammars are fixed.
};

type CaptureFormatter = (text: string) => string;
type FormatterResolver = (captureName: string) => CaptureFormatter | undefined;

type LoadedLang = {
	parser: Parser;
	query: Query;
};

let initPromise: Promise<boolean> | undefined;
const loaded = new Map<string, LoadedLang>();
const loading = new Set<string>();
const broken = new Set<string>();
// Failed query compiles leak on the wasm side; cap them process-wide.
let failedCompileBudget = 120;
// Languages whose query compiled but never matches anything (grammar emits
// different node names): demote to the legacy highlighter after a few
// non-trivial renders with zero captures.
const emptyStreak = new Map<string, number>();
let resolver: FormatterResolver | undefined;
const readyCallbacks: Array<() => void> = [];
const blockCache = new Map<string, string[]>();

export function setCaptureFormatter(fn: FormatterResolver): void {
	resolver = fn;
	blockCache.clear();
}

/** Register a callback fired when a grammar finishes loading (for re-render). */
export function onTreeSitterReady(cb: () => void): void {
	readyCallbacks.push(cb);
}

function wasmDir(): string | undefined {
	try {
		return path.join(path.dirname(require.resolve("tree-sitter-wasms/package.json")), "out");
	} catch {
		return undefined;
	}
}

function webTreeSitterDir(): string | undefined {
	try {
		// web-tree-sitter 0.25 has an exports map that hides package.json;
		// resolve the module entry instead. tree-sitter.wasm sits next to it.
		return path.dirname(require.resolve("web-tree-sitter"));
	} catch {
		return undefined;
	}
}

async function ensureInit(): Promise<boolean> {
	if (!initPromise) {
		const dir = webTreeSitterDir();
		initPromise = dir
			? Parser.init({ locateFile: (f: string) => path.join(dir, f) }).then(
					() => true,
					() => false,
				)
			: Promise.resolve(false);
	}
	return initPromise;
}

// Split a highlights.scm source into top-level patterns (an s-expression plus
// its trailing @captures), respecting strings and ; comments. Needed so the
// lenient compiler can drop only the patterns a grammar version rejects.
function splitTopLevelPatterns(src: string): string[] {
	const out: string[] = [];
	let depth = 0;
	let start = 0;
	let sawExpr = false;
	let inString = false;
	let inComment = false;
	for (let i = 0; i < src.length; i++) {
		const ch = src[i];
		if (inComment) {
			if (ch === "\n") inComment = false;
			continue;
		}
		if (inString) {
			if (ch === "\\") i++;
			else if (ch === '"') inString = false;
			continue;
		}
		if (ch === '"') {
			inString = true;
		} else if (ch === ";") {
			inComment = true;
		} else if (ch === "(" || ch === "[") {
			depth++;
		} else if (ch === ")" || ch === "]") {
			depth--;
			if (depth === 0) sawExpr = true;
		} else if (ch === "\n" && depth === 0 && sawExpr) {
			// Pattern boundary: balanced expression ended and the trailing
			// @captures (same line) are consumed up to this newline.
			out.push(src.slice(start, i));
			start = i + 1;
			sawExpr = false;
		}
	}
	if (start < src.length) out.push(src.slice(start));
	return out.filter((p) => p.trim().length > 0);
}

// Pre-validate a pattern's node names, quoted tokens, and field names against
// the grammar in plain JS. Failed wasm query compiles are not just slow: they
// leak and can corrupt the emscripten heap (observed as v8 zone OOMs at
// process exit), so patterns that cannot compile must be dropped BEFORE the
// compiler ever sees them.
function sanitizePatterns(language: Language, patterns: string[]): string[] {
	const nodeOk = (name: string, named: boolean): boolean => {
		try {
			const id = language.idForNodeType(name, named);
			return id !== null && id !== 0;
		} catch {
			return false;
		}
	};
	const fieldOk = (name: string): boolean => {
		try {
			return language.fieldIdForName(name) !== null;
		} catch {
			return false;
		}
	};

	const out: string[] = [];
	for (const pattern of patterns) {
		// Blank out predicate groups: their quoted args are regexes/literals,
		// not grammar tokens, and must be neither validated nor removed.
		const noPreds = pattern.replace(/\(#[^)]*\)/g, (m) => " ".repeat(m.length));

		let ok = true;
		for (const m of noPreds.matchAll(/\(([a-zA-Z_][\w]*)/g)) {
			const name = m[1];
			if (name === "_" || name === "ERROR" || name === "MISSING") continue;
			if (!nodeOk(name, true)) {
				ok = false;
				break;
			}
		}
		if (ok) {
			for (const m of noPreds.matchAll(/([a-zA-Z_][\w]*)\s*:/g)) {
				if (!fieldOk(m[1])) {
					ok = false;
					break;
				}
			}
		}
		if (!ok) continue;

		// Quoted anonymous tokens (keyword lists): remove unknown ones rather
		// than dropping the pattern, so one renamed keyword does not kill the
		// whole list. Predicate args are protected by position.
		let cleaned = "";
		let last = 0;
		for (const m of pattern.matchAll(/"((?:[^"\\]|\\.)*)"/g)) {
			const idx = m.index ?? 0;
			const inPred = noPreds.slice(idx, idx + m[0].length) !== m[0];
			const raw = m[1].replace(/\\(.)/g, "$1");
			if (!inPred && !nodeOk(raw, false)) {
				cleaned += pattern.slice(last, idx);
				last = idx + m[0].length;
			}
		}
		cleaned += pattern.slice(last);
		// A keyword list emptied of every member cannot compile.
		if (/\[\s*\]/.test(cleaned)) continue;
		out.push(cleaned);
	}
	return out;
}

// Compile a query against a possibly older grammar: patterns are sanitized
// against the grammar first (see above), then a short lenient loop handles
// whatever the pre-validation cannot see. The vendored queries track current
// grammars while tree-sitter-wasms bundles older ones, so skew is expected.
function compileQueryLenient(language: Language, src: string): Query | undefined {
	const allPatterns = splitTopLevelPatterns(src);
	const originalCount = allPatterns.length;
	let patterns = sanitizePatterns(language, allPatterns);
	for (let attempt = 0; attempt < 8; attempt++) {
		if (failedCompileBudget <= 0) return undefined;
		try {
			const query = new Query(language, patterns.join("\n"));
			// Losing most patterns to skew means near-plain output that would
			// shadow the richer highlight.js fallback. Reject the language.
			if (patterns.length < originalCount * 0.25) {
				try {
					query.delete();
				} catch {
					// best-effort
				}
				return undefined;
			}
			return query;
		} catch (e) {
			// web-tree-sitter leaks wasm allocations on failed query compiles,
			// so the total number of failures a process may spend is bounded.
			failedCompileBudget--;
			const m = /Bad (?:node name|field name|capture name|pattern|syntax)[^']*'([^']+)'/.exec(String(e));
			const token = m?.[1];
			// A mis-parsed error message can yield a huge "token"; compiling
			// that into a regex allocates unboundedly (observed as a v8 zone
			// OOM). Real node/field names are short.
			if (!token || token.length > 64) return undefined;
			const escaped = token.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
			// Keyword lists like ["fn" "let" ...] @keyword fail as a unit when
			// one token is unknown to an older grammar. Removing just the
			// quoted token keeps the rest of the list alive; dropping the
			// whole pattern is the fallback for bare node names.
			const quotedRe = new RegExp(`"${escaped}"`, "g");
			if (patterns.some((p) => quotedRe.test(p))) {
				patterns = patterns.map((p) => p.replace(quotedRe, ""));
				continue;
			}
			const bareRe = new RegExp(`(^|[^\\w.])${escaped}($|[^\\w])`);
			const kept = patterns.filter((p) => !bareRe.test(p));
			if (kept.length === patterns.length || kept.length === 0) return undefined;
			patterns = kept;
		}
	}
	return undefined;
}

// Grammar loads are serialized: N concurrent wasm instantiations spike memory
// before the LRU can evict anything (observed as a v8 zone OOM when many
// languages were requested in one burst). One at a time is also all real
// usage ever needs.
let loadChain: Promise<void> = Promise.resolve();

function loadLanguage(langId: string): void {
	loadChain = loadChain.then(() => loadLanguageNow(langId));
}

async function loadLanguageNow(langId: string): Promise<void> {
	const spec = LANGS[langId];
	const dir = wasmDir();
	if (!spec || !dir) {
		broken.add(langId);
		return;
	}
	try {
		if (!(await ensureInit())) {
			broken.add(langId);
			return;
		}
		const language = await Language.load(path.join(dir, `${spec.wasm}.wasm`));
		const query = compileQueryLenient(language, spec.query);
		if (!query) {
			broken.add(langId);
			return;
		}
		// A query that lost most of its patterns to grammar skew renders
		// nearly plain text while still claiming the language, which would
		// shadow the richer highlight.js fallback. Reject it instead.
		if (query.captureNames.length < 3) {
			try {
				query.delete();
			} catch {
				// best-effort
			}
			broken.add(langId);
			return;
		}
		const parser = new Parser();
		parser.setLanguage(language);
		loaded.set(langId, { parser, query });
		for (const cb of readyCallbacks) {
			try {
				cb();
			} catch {
				// listener errors must not break loading
			}
		}
	} catch {
		// Grammar/query version mismatch or missing wasm: permanent fallback.
		broken.add(langId);
	} finally {
		loading.delete(langId);
	}
}

/**
 * Highlight a block of code. Returns the highlighted lines, or undefined when
 * tree-sitter cannot serve this request (language unknown/broken, not yet
 * loaded, block too large, or no formatter resolver installed). Undefined
 * means: use the legacy highlighter. Never throws.
 */
export function tsHighlight(code: string, langId: string): string[] | undefined {
	if (!resolver || broken.has(langId) || !(langId in LANGS)) return undefined;
	if (code.length > MAX_HIGHLIGHT_BYTES) return undefined;

	const entry = loaded.get(langId);
	if (!entry) {
		// Hard cap on resident grammars: languages beyond it use the legacy
		// highlighter for the rest of the session (grammars cannot be freed).
		if (loaded.size >= MAX_TOTAL_LANGS) {
			broken.add(langId);
			return undefined;
		}
		if (!loading.has(langId)) {
			loading.add(langId);
			void loadLanguage(langId);
		}
		return undefined;
	}

	const cacheKey = code.length <= BLOCK_CACHE_MAX_LEN ? `${langId} ${code}` : undefined;
	if (cacheKey) {
		const hit = blockCache.get(cacheKey);
		if (hit) return hit;
	}

	let tree: ReturnType<Parser["parse"]> = null;
	try {
		tree = entry.parser.parse(code);
		if (!tree) return undefined;
		const captures = entry.query.captures(tree.rootNode);

		// Zero captures on real code means the query targets node names this
		// grammar version never produces. Three strikes and the language is
		// demoted so highlight.js serves it instead of plain text.
		if (captures.length === 0 && code.trim().length > 40) {
			const streak = (emptyStreak.get(langId) ?? 0) + 1;
			emptyStreak.set(langId, streak);
			if (streak >= 3) broken.add(langId);
			return undefined;
		}
		if (captures.length > 0) emptyStreak.delete(langId);

		// Innermost/last capture wins per character. Captures arrive in tree
		// order, so children overwrite their parents, which matches the
		// intended precedence closely enough for display.
		const owner = new Int16Array(code.length).fill(-1);
		const names: string[] = [];
		const nameIndex = new Map<string, number>();
		for (const cap of captures) {
			const name = cap.name;
			let idx = nameIndex.get(name);
			if (idx === undefined) {
				idx = names.length;
				names.push(name);
				nameIndex.set(name, idx);
			}
			const end = Math.min(cap.node.endIndex, code.length);
			for (let i = cap.node.startIndex; i < end; i++) owner[i] = idx;
		}

		const formatters = names.map((n) => resolver?.(n));
		const out: string[] = [];
		let lineStart = 0;
		for (let i = 0; i <= code.length; i++) {
			if (i === code.length || code[i] === "\n") {
				out.push(renderLine(code, lineStart, i, owner, formatters));
				lineStart = i + 1;
			}
		}
		if (cacheKey) {
			if (blockCache.size >= BLOCK_CACHE_MAX) {
				const first = blockCache.keys().next().value;
				if (first !== undefined) blockCache.delete(first);
			}
			blockCache.set(cacheKey, out);
		}
		return out;
	} catch {
		return undefined;
	} finally {
		try {
			tree?.delete();
		} catch {
			// best-effort
		}
	}
}

function renderLine(
	code: string,
	start: number,
	end: number,
	owner: Int16Array,
	formatters: Array<CaptureFormatter | undefined>,
): string {
	let out = "";
	let runStart = start;
	let runOwner = start < end ? owner[start] : -1;
	for (let i = start + 1; i <= end; i++) {
		const o = i < end ? owner[i] : -2;
		if (o !== runOwner) {
			const text = code.slice(runStart, i);
			const fmt = runOwner >= 0 ? formatters[runOwner] : undefined;
			out += fmt ? fmt(text) : text;
			runStart = i;
			runOwner = o;
		}
	}
	return out;
}

/** True when this language can eventually be served by tree-sitter. */
export function tsSupportsLanguage(langId: string): boolean {
	return langId in LANGS && !broken.has(langId);
}
