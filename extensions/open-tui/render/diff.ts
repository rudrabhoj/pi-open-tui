import type { Theme } from "@earendil-works/pi-coding-agent";
import * as Diff from "diff";
import { bgHex } from "./colors.ts";

// Port of the diff renderer from our former pi core patch: syntax-highlighted
// lines on full-line fills plus an added/removed summary. Without fills it
// falls back to pi's whole-line tint with intra-line inverse chips.

export interface DiffRenderOptions {
	theme: Theme;
	/** Highlight one line of code; returns the input unchanged when it cannot. */
	highlightLine?: (code: string) => string;
	addedBg?: string;
	removedBg?: string;
}

function parseDiffLine(line: string): { prefix: string; lineNum: string; content: string } | null {
	const match = line.match(/^([+-\s])(\s*\d*)\s(.*)$/);
	if (!match) return null;
	return { prefix: match[1], lineNum: match[2], content: match[3] };
}

function replaceTabs(text: string): string {
	return text.replace(/\t/g, "   ");
}

function renderIntraLineDiff(
	oldContent: string,
	newContent: string,
	theme: Theme,
): { removedLine: string; addedLine: string } {
	let removedLine = "";
	let addedLine = "";
	let isFirstRemoved = true;
	let isFirstAdded = true;
	for (const part of Diff.diffWords(oldContent, newContent)) {
		if (part.removed) {
			let value = part.value;
			if (isFirstRemoved) {
				const leadingWs = value.match(/^(\s*)/)?.[1] || "";
				value = value.slice(leadingWs.length);
				removedLine += leadingWs;
				isFirstRemoved = false;
			}
			if (value) removedLine += theme.inverse(value);
		} else if (part.added) {
			let value = part.value;
			if (isFirstAdded) {
				const leadingWs = value.match(/^(\s*)/)?.[1] || "";
				value = value.slice(leadingWs.length);
				addedLine += leadingWs;
				isFirstAdded = false;
			}
			if (value) addedLine += theme.inverse(value);
		} else {
			removedLine += part.value;
			addedLine += part.value;
		}
	}
	return { removedLine, addedLine };
}

export function renderDiff(diffText: string, options: DiffRenderOptions): string {
	const { theme } = options;
	const lines = diffText.split("\n");
	const result: string[] = [];
	const addedFill = bgHex(options.addedBg);
	const removedFill = bgHex(options.removedBg);
	const fills = addedFill !== undefined && removedFill !== undefined;
	const hl = options.highlightLine ?? ((code: string) => code);

	let addedCount = 0;
	let removedCount = 0;
	for (const line of lines) {
		const p = parseDiffLine(line);
		if (p?.prefix === "+") addedCount++;
		else if (p?.prefix === "-") removedCount++;
	}

	const renderAdded = (lineNum: string, content: string, intraLine?: string): string => {
		const text = replaceTabs(content);
		if (addedFill) return addedFill(theme.fg("toolDiffAdded", `+${lineNum} `) + hl(text));
		return theme.fg("toolDiffAdded", `+${lineNum} ${intraLine ?? text}`);
	};
	const renderRemoved = (lineNum: string, content: string, intraLine?: string): string => {
		const text = replaceTabs(content);
		if (removedFill) return removedFill(theme.fg("toolDiffRemoved", `-${lineNum} `) + hl(text));
		return theme.fg("toolDiffRemoved", `-${lineNum} ${intraLine ?? text}`);
	};
	const renderContext = (lineNum: string, content: string): string => {
		const text = replaceTabs(content);
		if (options.highlightLine) return theme.fg("dim", ` ${lineNum} `) + hl(text);
		return theme.fg("toolDiffContext", ` ${lineNum} ${text}`);
	};

	if (addedCount > 0 || removedCount > 0) {
		// Non-nested fg() segments: fg() resets to the default color, so nesting
		// would drop the muted tint after each count.
		const seg: string[] = [];
		if (addedCount > 0) {
			seg.push(
				theme.fg("muted", "Added "),
				theme.fg("toolDiffAdded", String(addedCount)),
				theme.fg("muted", ` line${addedCount === 1 ? "" : "s"}`),
			);
		}
		if (removedCount > 0) {
			seg.push(
				theme.fg("muted", addedCount > 0 ? ", removed " : "Removed "),
				theme.fg("toolDiffRemoved", String(removedCount)),
				theme.fg("muted", ` line${removedCount === 1 ? "" : "s"}`),
			);
		}
		result.push(seg.join(""));
	}

	let i = 0;
	while (i < lines.length) {
		const parsed = parseDiffLine(lines[i]);
		if (!parsed) {
			result.push(theme.fg("toolDiffContext", lines[i]));
			i++;
			continue;
		}
		if (parsed.prefix === "-") {
			const removedLines: { lineNum: string; content: string }[] = [];
			while (i < lines.length) {
				const p = parseDiffLine(lines[i]);
				if (!p || p.prefix !== "-") break;
				removedLines.push({ lineNum: p.lineNum, content: p.content });
				i++;
			}
			const addedLines: { lineNum: string; content: string }[] = [];
			while (i < lines.length) {
				const p = parseDiffLine(lines[i]);
				if (!p || p.prefix !== "+") break;
				addedLines.push({ lineNum: p.lineNum, content: p.content });
				i++;
			}
			// Inverse chips only help in tint mode; over fills and syntax colors they add noise.
			if (!fills && removedLines.length === 1 && addedLines.length === 1) {
				const { removedLine, addedLine } = renderIntraLineDiff(
					replaceTabs(removedLines[0].content),
					replaceTabs(addedLines[0].content),
					theme,
				);
				result.push(renderRemoved(removedLines[0].lineNum, removedLines[0].content, removedLine));
				result.push(renderAdded(addedLines[0].lineNum, addedLines[0].content, addedLine));
			} else {
				for (const r of removedLines) result.push(renderRemoved(r.lineNum, r.content));
				for (const a of addedLines) result.push(renderAdded(a.lineNum, a.content));
			}
		} else if (parsed.prefix === "+") {
			result.push(renderAdded(parsed.lineNum, parsed.content));
			i++;
		} else {
			result.push(renderContext(parsed.lineNum, parsed.content));
			i++;
		}
	}
	return result.join("\n");
}
