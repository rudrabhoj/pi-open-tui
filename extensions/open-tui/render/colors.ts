import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { getAgentDir, type Theme } from "@earendil-works/pi-coding-agent";

// Pi themes are validated strictly, so tree-sitter capture colors and diff line
// fills cannot live in the theme file. They live in this extension's own file.
export interface RenderColors {
	diffAddedBg?: string;
	diffRemovedBg?: string;
	captures: Record<string, string>;
}

const CONFIG_FILE = "open-tui-render.json";

export function loadRenderColors(): RenderColors {
	const path = join(getAgentDir(), CONFIG_FILE);
	if (!existsSync(path)) return { captures: {} };
	try {
		const raw = JSON.parse(readFileSync(path, "utf8")) as Partial<RenderColors>;
		return {
			diffAddedBg: typeof raw.diffAddedBg === "string" ? raw.diffAddedBg : undefined,
			diffRemovedBg: typeof raw.diffRemovedBg === "string" ? raw.diffRemovedBg : undefined,
			captures: raw.captures && typeof raw.captures === "object" ? raw.captures : {},
		};
	} catch {
		return { captures: {} };
	}
}

function hexToRgb(hex: string): [number, number, number] | undefined {
	const m = /^#?([0-9a-f]{6})$/i.exec(hex.trim());
	if (!m) return undefined;
	const n = Number.parseInt(m[1], 16);
	return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

export function fgHex(hex: string): ((text: string) => string) | undefined {
	const rgb = hexToRgb(hex);
	if (!rgb) return undefined;
	const open = `\x1b[38;2;${rgb[0]};${rgb[1]};${rgb[2]}m`;
	return (text) => `${open}${text}\x1b[39m`;
}

// Resets only the background channel, so syntax colors inside compose with it.
export function bgHex(hex: string | undefined): ((text: string) => string) | undefined {
	const rgb = hex ? hexToRgb(hex) : undefined;
	if (!rgb) return undefined;
	const open = `\x1b[48;2;${rgb[0]};${rgb[1]};${rgb[2]}m`;
	return (text) => `${open}${text}\x1b[49m`;
}

// Capture base name -> the theme's own syntax slot, for captures the config
// does not list. Keeps highlighting themed when no config file exists.
const LEGACY_CAPTURE_SLOTS: Record<string, string> = {
	keyword: "syntaxKeyword",
	include: "syntaxKeyword",
	repeat: "syntaxKeyword",
	conditional: "syntaxKeyword",
	exception: "syntaxKeyword",
	label: "syntaxKeyword",
	tag: "syntaxKeyword",
	function: "syntaxFunction",
	method: "syntaxFunction",
	constructor: "syntaxType",
	type: "syntaxType",
	class: "syntaxType",
	struct: "syntaxType",
	enum: "syntaxType",
	interface: "syntaxType",
	namespace: "syntaxType",
	module: "syntaxType",
	attribute: "syntaxType",
	string: "syntaxString",
	escape: "syntaxString",
	regexp: "syntaxString",
	number: "syntaxNumber",
	float: "syntaxNumber",
	boolean: "syntaxNumber",
	constant: "syntaxNumber",
	comment: "syntaxComment",
	variable: "syntaxVariable",
	parameter: "syntaxVariable",
	property: "syntaxVariable",
	field: "syntaxVariable",
	operator: "syntaxOperator",
	punctuation: "syntaxPunctuation",
	delimiter: "syntaxPunctuation",
};

/**
 * Resolve a capture ("function.method") to a formatter: exact capture in the
 * config, then dotted prefixes ("function"), then the theme's syntax slot.
 */
export function createCaptureResolver(colors: RenderColors, theme: Theme) {
	const cache = new Map<string, ((text: string) => string) | undefined>();
	return (name: string): ((text: string) => string) | undefined => {
		if (cache.has(name)) return cache.get(name);
		let formatter: ((text: string) => string) | undefined;
		let probe = name;
		for (;;) {
			const hex = colors.captures[probe];
			if (hex) {
				formatter = fgHex(hex);
				if (formatter) break;
			}
			const dot = probe.lastIndexOf(".");
			if (dot < 0) break;
			probe = probe.slice(0, dot);
		}
		if (!formatter) {
			const slot = LEGACY_CAPTURE_SLOTS[probe] ?? LEGACY_CAPTURE_SLOTS[name.split(".")[0]];
			if (slot) formatter = (text) => theme.fg(slot as Parameters<Theme["fg"]>[0], text);
		}
		cache.set(name, formatter);
		return formatter;
	};
}
