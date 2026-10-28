import { type ExtensionAPI, getLanguageFromPath, highlightCode, type Theme } from "@earendil-works/pi-coding-agent";
import { type Component, Text } from "@earendil-works/pi-tui";
import { createCaptureResolver, loadRenderColors, type RenderColors } from "./colors.ts";
import { renderDiff } from "./diff.ts";
import { onTreeSitterReady, setCaptureFormatter, tsHighlight, tsSupportsLanguage } from "./treesitter.ts";

// Wraps pi's own edit/read/write renderers instead of replacing them: pi keeps
// headers, pending/error states, previews and truncation notes, and only the
// code body is re-rendered with tree-sitter colors. Pi core stays unpatched.

let colors: RenderColors = { captures: {} };
let resolverTheme: Theme | undefined;
const pendingRedraws = new Set<() => void>();

onTreeSitterReady(() => {
	for (const redraw of pendingRedraws) redraw();
	pendingRedraws.clear();
});

function useTheme(theme: Theme): void {
	if (theme === resolverTheme) return;
	resolverTheme = theme;
	setCaptureFormatter(createCaptureResolver(colors, theme));
}

function languageFor(path: string | undefined): string | undefined {
	if (!path) return undefined;
	// pi maps .tsx to typescript; tree-sitter has a real tsx grammar.
	if (path.endsWith(".tsx")) return "tsx";
	return getLanguageFromPath(path);
}

function highlightBlock(code: string, lang: string, theme: Theme, redraw: () => void): string[] {
	useTheme(theme);
	const ts = tsHighlight(code, lang);
	if (ts) return ts;
	// The grammar loads asynchronously; serve highlight.js now, redraw when warm.
	if (tsSupportsLanguage(lang)) pendingRedraws.add(redraw);
	return highlightCode(code, lang === "tsx" ? "typescript" : lang);
}

function replaceTabs(text: string): string {
	return text.replace(/\t/g, "   ");
}

function trimTrailingEmptyLines(lines: string[]): string[] {
	let end = lines.length;
	while (end > 0 && lines[end - 1] === "") end--;
	return lines.slice(0, end);
}

type TextLike = Component & { setText: (text: string) => void };

// Duck-typed rather than instanceof, so a second copy of pi-tui cannot break it.
function isTextLike(component: unknown): component is TextLike {
	return typeof (component as { setText?: unknown } | undefined)?.setText === "function";
}

// pi-tui's Text keeps its content private; read it to splice in our body.
function textOf(component: Component | undefined): string | undefined {
	const text = (component as { text?: unknown } | undefined)?.text;
	return typeof text === "string" ? text : undefined;
}

type EditCallComponent = Component & {
	children?: Component[];
	preview?: { diff: string } | { error: string };
	removeChild?: (c: Component) => void;
	addChild?: (c: Component) => void;
};

function patchEditBody(component: unknown, args: any, theme: Theme, redraw: () => void): void {
	const box = component as EditCallComponent | undefined;
	if (!box?.preview || "error" in box.preview || !box.children || !box.removeChild || !box.addChild) return;
	const body = box.children[box.children.length - 1];
	if (!isTextLike(body)) return;
	const lang = languageFor(args?.file_path ?? args?.path);
	const diff = renderDiff(box.preview.diff, {
		theme,
		addedBg: colors.diffAddedBg,
		removedBg: colors.diffRemovedBg,
		highlightLine: lang ? (code) => highlightBlock(code, lang, theme, redraw)[0] ?? code : undefined,
	});
	box.removeChild(body);
	box.addChild(new Text(diff, 0, 0));
}

// Replace `count` lines starting at `start` in a rendered text with our lines.
function spliceLines(text: string, start: number, lines: string[]): string {
	const parts = text.split("\n");
	if (parts.length < start + lines.length) return text;
	parts.splice(start, lines.length, ...lines);
	return parts.join("\n");
}

export function registerRenderers(pi: ExtensionAPI): void {
	// registerToolRenderer arrived in pi 1.0.1; older pi keeps its own rendering.
	if (typeof pi.registerToolRenderer !== "function") return;
	colors = loadRenderColors();

	pi.registerToolRenderer((toolName, next) => {
		const base = next();
		if (!base?.renderCall) return base;

		if (toolName === "edit") {
			return {
				...base,
				renderCall(args, theme, ctx) {
					const component = base.renderCall!(args, theme, ctx);
					patchEditBody(component, args, theme, ctx.invalidate);
					return component;
				},
				renderResult(result, options, theme, ctx) {
					const component = base.renderResult?.(result, options, theme, ctx);
					// pi rebuilds the call component when the final diff arrives.
					patchEditBody(ctx.state?.callComponent, ctx.args, theme, ctx.invalidate);
					return component as Component;
				},
			};
		}

		if (toolName === "read" && base.renderResult) {
			return {
				...base,
				renderResult(result, options, theme, ctx) {
					const component = base.renderResult!(result, options, theme, ctx);
					const args = ctx.args as { file_path?: string; path?: string } | undefined;
					const lang = languageFor(args?.file_path ?? args?.path);
					const text = textOf(component);
					if (!lang || !text || ctx.isError || !options.expanded || !isTextLike(component)) return component;
					const output = result.content
						.map((c) => (c.type === "text" ? c.text : undefined))
						.filter((t): t is string => t !== undefined)
						.join("\n");
					const lines = trimTrailingEmptyLines(highlightBlock(replaceTabs(output), lang, theme, ctx.invalidate));
					// pi's read result is "\n" followed by the displayed lines.
					component.setText(spliceLines(text, 1, lines));
					return component;
				},
			};
		}

		if (toolName === "write") {
			return {
				...base,
				renderCall(rawArgs, theme, ctx) {
					const component = base.renderCall!(rawArgs, theme, ctx);
					const args = rawArgs as { file_path?: string; path?: string; content?: unknown } | undefined;
					const content = typeof args?.content === "string" ? args.content : undefined;
					const lang = languageFor(args?.file_path ?? args?.path);
					const text = textOf(component);
					if (!content || !lang || !text || !isTextLike(component)) return component;
					const normalized = replaceTabs(content.replace(/\r\n?/g, "\n"));
					const lines = trimTrailingEmptyLines(highlightBlock(normalized, lang, theme, ctx.invalidate));
					const shown = ctx.expanded ? lines : lines.slice(0, 10);
					// pi's write call is the header, a blank line, then the shown lines.
					component.setText(spliceLines(text, 2, shown));
					return component;
				},
			};
		}

		return base;
	});
}
