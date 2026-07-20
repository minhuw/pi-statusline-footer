/**
 * ClaudeTUI-style Footer — a rich multi-line statusline for pi, inspired by
 * https://github.com/slima4/claude-tui (claude-code-statusline).
 *
 * Full mode (3 lines), one theme per line:
 *   1 · Model state:  name (provider), context bar + %/tokens, compactions,
 *                     elapsed · turns, in/out tokens, cache ratio, cost ($/turn)
 *   2 · Performance:  mean + last TTFT, TTFB, weighted-avg + last tok/s,
 *                     tool call count, error rate
 *   3 · Local state:  git branch, working-tree diff (+adds −dels), files
 *                     touched, cwd
 *
 * Compact mode (1 line):
 *   model │ ██████░░░░ 42% 84k/200k │ $1.23 │ 12m │ 18 turns │ 2x compact
 *
 * Usage:
 *   /footer            toggle on/off
 *   /footer full       3-line layout (default)
 *   /footer compact    1-line layout
 *   /footer off        restore pi's default footer
 *   /footer debug      show metric-collection internals
 */

import { execFile } from "node:child_process";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import type {
	ExtensionAPI,
	ExtensionContext,
	ReadonlyFooterDataProvider,
	Theme,
} from "@earendil-works/pi-coding-agent";
import { truncateToWidth } from "@earendil-works/pi-tui";

type Mode = "full" | "compact" | "off";

const BAR_WIDTH = 18;

// ── formatting helpers ──────────────────────────────────────────────

function fmtTokens(n: number): string {
	if (n < 1000) return `${n}`;
	if (n < 1_000_000) return `${(n / 1000).toFixed(1)}k`;
	return `${(n / 1_000_000).toFixed(2)}M`;
}

function fmtCost(usd: number): string {
	return `$${usd < 1 ? usd.toFixed(3) : usd.toFixed(2)}`;
}

function fmtDuration(ms: number): string {
	const mins = Math.floor(ms / 60_000);
	if (mins < 60) return `${mins}m`;
	const h = Math.floor(mins / 60);
	return `${h}h ${String(mins % 60).padStart(2, "0")}m`;
}

function bar(pct: number, width = BAR_WIDTH): string {
	const filled = Math.round((Math.min(pct, 100) / 100) * width);
	return "█".repeat(filled) + "░".repeat(width - filled);
}

// ── session stats ───────────────────────────────────────────────────
//
// Walking the full branch is O(session size), so results are cached
// keyed by the branch's leaf entry id: the leaf changes exactly when a
// new entry is appended (or on fork/tree-nav/compaction), which means
// renders during streaming — the hot path — always hit the cache.
// Only durationMs is recomputed per render (Date.now() moves).

interface Stats {
	input: number;
	output: number;
	cost: number;
	cacheRead: number;
	turns: number;
	compactions: number;
	errors: number;
	toolCalls: number;
	files: number;
	durationMs: number;
}

interface StatsCache {
	leafId: string | null;
	firstTs: number | undefined;
	stats: Stats;
}

let statsCache: StatsCache | undefined;

function collectStats(ctx: ExtensionContext): Stats {
	const leafId = ctx.sessionManager.getLeafId();
	if (statsCache && statsCache.leafId === leafId) {
		statsCache.stats.durationMs = statsCache.firstTs
			? Math.max(0, Date.now() - statsCache.firstTs)
			: 0;
		return statsCache.stats;
	}

	const s: Stats = {
		input: 0,
		output: 0,
		cost: 0,
		cacheRead: 0,
		turns: 0,
		compactions: 0,
		errors: 0,
		toolCalls: 0,
		files: 0,
		durationMs: 0,
	};
	const files = new Set<string>();
	let firstTs: number | undefined;

	for (const e of ctx.sessionManager.getBranch()) {
		if (e.type === "compaction") {
			s.compactions++;
			continue;
		}
		if (e.type !== "message") continue;
		const m = e.message;
		if (m.timestamp && !firstTs) firstTs = m.timestamp;

		if (m.role === "user") {
			s.turns++;
		} else if (m.role === "assistant") {
			const a = m as AssistantMessage;
			// Guard against malformed/aborted messages with missing usage
			s.input += a.usage?.input ?? 0;
			s.output += a.usage?.output ?? 0;
			s.cacheRead += a.usage?.cacheRead ?? 0;
			s.cost += a.usage?.cost?.total ?? 0;
			for (const block of a.content ?? []) {
				if (block.type !== "toolCall") continue;
				s.toolCalls++;
				const args = block.arguments as Record<string, unknown>;
				if (typeof args.path === "string") files.add(args.path);
			}
		} else if (m.role === "toolResult" && m.isError) {
			s.errors++;
		}
	}

	s.files = files.size;
	s.durationMs = firstTs ? Math.max(0, Date.now() - firstTs) : 0;
	statsCache = { leafId, firstTs, stats: s };
	return s;
}

// ── streaming metrics (TTFT + tokens/sec) ──────────────────────────
//
// Measured passively from pi's event stream:
//   before_provider_headers  → request about to be sent (per LLM call).
//                              Some providers abstract HTTP away and never
//                              fire this; message_start is the fallback marker.
//   message_update (*_delta) → first streamed token (text/thinking/toolcall)
//   message_end (assistant)  → exact usage.output + stream end time
//
// Weighted avg tok/s = Σ output tokens / Σ stream durations, i.e. a
// token-weighted mean over all completed requests in this session.

interface StreamMetrics {
	requestSentAt: number;
	firstTokenAt: number;
	curTtftMs: number | null; // TTFT of the in-flight request, if measured
	lastTtftMs: number | null;
	lastTtfbMs: number | null; // response-headers time, when the provider exposes it
	lastTokPerSec: number | null;
	totalOutput: number;
	totalStreamMs: number;
	totalTtftMs: number; // Σ TTFT over completed requests (for mean)
	ttftCount: number;
	requests: number;
	headersSeen: number; // how often before_provider_headers fired (diagnostic)
	responsesSeen: number; // how often after_provider_response fired (diagnostic)
}

function freshMetrics(): StreamMetrics {
	return {
		requestSentAt: 0,
		firstTokenAt: 0,
		curTtftMs: null,
		lastTtftMs: null,
		lastTtfbMs: null,
		lastTokPerSec: null,
		totalOutput: 0,
		totalStreamMs: 0,
		totalTtftMs: 0,
		ttftCount: 0,
		requests: 0,
		headersSeen: 0,
		responsesSeen: 0,
	};
}

const metrics = freshMetrics();

function avgTokPerSec(): number | null {
	if (metrics.totalStreamMs <= 0 || metrics.totalOutput <= 0) return null;
	return metrics.totalOutput / (metrics.totalStreamMs / 1000);
}

function avgTtftMs(): number | null {
	if (metrics.ttftCount === 0) return null;
	return metrics.totalTtftMs / metrics.ttftCount;
}

function fmtTtft(ms: number): string {
	return ms < 1000 ? `${Math.round(ms)}ms` : `${(ms / 1000).toFixed(1)}s`;
}

function fmtTokPerSec(tps: number): string {
	return `${tps < 10 ? tps.toFixed(1) : Math.round(tps)} tok/s`;
}

// ── git working-tree state (async, cached) ─────────────────────────
// Render must stay synchronous, so diff stats are refreshed in the
// background at most every 15s and the last value is painted.

interface GitStat {
	files: number;
	adds: number;
	dels: number;
}

let gitStat: GitStat | null = null;
let gitStatAt = 0;
let gitStatCwd = "";
let requestRender: (() => void) | undefined;

function refreshGitStat(cwd: string) {
	const now = Date.now();
	if (gitStatCwd === cwd && now - gitStatAt < 15_000) return;
	gitStatAt = now;
	gitStatCwd = cwd;
	execFile("git", ["diff", "--shortstat", "HEAD"], { cwd, timeout: 5000 }, (err, stdout) => {
		if (err) {
			gitStat = null;
			return;
		}
		const files = /(\d+) files? changed/.exec(stdout);
		const adds = /(\d+) insertions?\(\+\)/.exec(stdout);
		const dels = /(\d+) deletions?\(-\)/.exec(stdout);
		gitStat = {
			files: files ? Number(files[1]) : 0,
			adds: adds ? Number(adds[1]) : 0,
			dels: dels ? Number(dels[1]) : 0,
		};
		requestRender?.();
	});
}

// ── nerd font icons ────────────────────────────────────────────────
// PUA glyphs from Nerd Fonts (nf-fa-*). If your terminal font has no
// Nerd Font patched in, these render as boxes — tell me and I'll add
// an ASCII fallback mode.

const I = {
	model: "\uF135", //  rocket (FA 4.7 — present in all Nerd Font versions)
	context: "\uF1C0", //  database
	compact: "\uF066", //  compress
	elapsed: "\uF252", //  hourglass-half
	turns: "\uF086", //  comments
	input: "\uF062", //  arrow-up
	output: "\uF063", //  arrow-down
	cache: "\uF0E7", //  bolt
	cost: "\uF155", //  usd
	ttft: "\uF251", //  hourglass-start
	ttfb: "\uF0EC", //  exchange
	speed: "\uF0E4", //  tachometer
	last: "\uF1DA", //  history
	calls: "\uF0AD", //  wrench
	err: "\uF057", //  times-circle
	ok: "\uF00C", //  check
	branch: "\uF126", //  code-fork
	file: "\uF0F6", //  file-o
	cwd: "\uF07C", //  folder-open
} as const;

// ── rendering ───────────────────────────────────────────────────────

function ctxColor(pct: number): "success" | "warning" | "error" {
	if (pct < 50) return "success";
	if (pct < 75) return "warning";
	return "error";
}

function renderCompact(ctx: ExtensionContext, theme: Theme, width: number): string {
	const s = collectStats(ctx);
	const usage = ctx.getContextUsage();
	const sep = theme.fg("borderMuted", " │ ");

	const parts: string[] = [
		theme.fg("accent", `${I.model} `) +
			theme.fg("accent", theme.bold(ctx.model?.id || "no-model")),
	];
	if (usage?.percent != null) {
		const pct = Math.round(usage.percent);
		const color = ctxColor(pct);
		parts.push(
			theme.fg(color, bar(pct, 10)) +
				theme.fg("dim", ` ${pct}% ${fmtTokens(usage.tokens ?? 0)}/${fmtTokens(usage.contextWindow)}`),
		);
	}
	parts.push(theme.fg("warning", `${I.cost} ${fmtCost(s.cost)}`));
	parts.push(theme.fg("muted", `${I.elapsed} `) + theme.fg("dim", fmtDuration(s.durationMs)));
	parts.push(theme.fg("muted", `${I.turns} `) + theme.fg("dim", `${s.turns}`));
	const avg = avgTokPerSec();
	if (avg != null) parts.push(theme.fg("success", `${I.speed} ${fmtTokPerSec(avg)}`));
	if (s.compactions > 0) parts.push(theme.fg("muted", `${I.compact} ${s.compactions}x`));

	return truncateToWidth(parts.join(sep), width);
}

function ttftColor(ms: number): "success" | "warning" | "error" {
	if (ms < 2_000) return "success";
	if (ms < 8_000) return "warning";
	return "error";
}

function renderFull(
	ctx: ExtensionContext,
	theme: Theme,
	footerData: ReadonlyFooterDataProvider,
	width: number,
): string[] {
	const s = collectStats(ctx);
	const usage = ctx.getContextUsage();
	const sep = theme.fg("borderMuted", " │ ");

	// ── Line 1 · Model state: identity, context capacity, elapsed, tokens, cost
	const l1: string[] = [];
	const model = ctx.model;
	l1.push(
		theme.fg("syntaxKeyword", `${I.model} `) +
			theme.fg("accent", theme.bold(model ? `${model.id} (${model.provider})` : "no-model")),
	);
	if (usage?.percent != null) {
		const pct = Math.round(usage.percent);
		const color = ctxColor(pct);
		l1.push(
			theme.fg("muted", `${I.context} `) +
				theme.fg(color, bar(pct)) +
				" " +
				theme.fg(color, theme.bold(`${pct}%`)) +
				theme.fg("dim", ` ${fmtTokens(usage.tokens ?? 0)}/${fmtTokens(usage.contextWindow)}`),
		);
	} else {
		l1.push(
			theme.fg("muted", `${I.context} `) +
				theme.fg("dim", `window ${fmtTokens(usage?.contextWindow ?? 0)}`),
		);
	}
	if (s.compactions > 0)
		l1.push(theme.fg("muted", `${I.compact} `) + theme.fg("dim", `${s.compactions}x`));
	l1.push(
		theme.fg("syntaxNumber", `${I.elapsed} `) +
			theme.fg("dim", fmtDuration(s.durationMs)) +
			theme.fg("muted", ` ${I.turns} `) +
			theme.fg("dim", `${s.turns}`),
	);
	l1.push(
		theme.fg("toolDiffAdded", `${I.input} `) +
			theme.fg("dim", fmtTokens(s.input)) +
			"  " +
			theme.fg("toolDiffRemoved", `${I.output} `) +
			theme.fg("dim", fmtTokens(s.output)),
	);
	const totalIn = s.input + s.cacheRead;
	if (totalIn > 0) {
		const cachePct = Math.round((s.cacheRead / totalIn) * 100);
		const cColor = cachePct >= 70 ? "success" : cachePct >= 40 ? "warning" : "dim";
		l1.push(theme.fg(cColor, `${I.cache} ${cachePct}%`));
	}
	l1.push(
		theme.fg("warning", `${I.cost} ${fmtCost(s.cost)}`) +
			(s.turns > 0 ? theme.fg("dim", ` (~${fmtCost(s.cost / s.turns)}/turn)`) : ""),
	);
	const line1 = truncateToWidth(l1.join(sep), width);

	// ── Line 2 · Performance: TTFT, TTFB, tok/s, tool calls, error rate
	const l2: string[] = [];
	const avgTtft = avgTtftMs();
	if (avgTtft != null) {
		l2.push(
			theme.fg(ttftColor(avgTtft), `${I.ttft} μ ${fmtTtft(avgTtft)}`) +
				(metrics.lastTtftMs != null && metrics.ttftCount > 1
					? theme.fg("dim", `  ${I.last} ${fmtTtft(metrics.lastTtftMs)}`)
					: ""),
		);
	} else {
		l2.push(theme.fg("dim", `${I.ttft} —`));
	}
	if (metrics.lastTtfbMs != null)
		l2.push(theme.fg("muted", `${I.ttfb} `) + theme.fg("dim", fmtTtft(metrics.lastTtfbMs)));
	const avg = avgTokPerSec();
	if (avg != null) {
		l2.push(
			theme.fg("success", `${I.speed} μ ${fmtTokPerSec(avg)}`) +
				(metrics.lastTokPerSec != null && metrics.requests > 1
					? theme.fg("dim", `  ${I.last} ${fmtTokPerSec(metrics.lastTokPerSec)}`)
					: ""),
		);
	} else {
		l2.push(theme.fg("dim", `${I.speed} — tok/s`));
	}
	if (s.toolCalls > 0) {
		l2.push(theme.fg("syntaxFunction", `${I.calls} `) + theme.fg("dim", `${s.toolCalls}`));
		l2.push(
			s.errors > 0
				? theme.fg(
						"error",
						`${I.err} ${s.errors} (${((s.errors / s.toolCalls) * 100).toFixed(1)}%)`,
					)
				: theme.fg("success", `${I.ok} 0`),
		);
	} else {
		l2.push(theme.fg("muted", `${I.calls} `) + theme.fg("dim", "0"));
	}
	const line2 = truncateToWidth(l2.join(sep), width);

	// ── Line 3 · Local state: git branch, working-tree diff, touched files, cwd
	refreshGitStat(ctx.cwd); // throttled, async; paints cached value
	const l3: string[] = [];
	const branch = footerData.getGitBranch();
	l3.push(
		branch
			? theme.fg("syntaxKeyword", `${I.branch} `) + theme.fg("accent", branch)
			: theme.fg("dim", `${I.branch} no git`),
	);
	if (gitStat && (gitStat.adds > 0 || gitStat.dels > 0)) {
		l3.push(
			theme.fg("toolDiffAdded", `+${gitStat.adds}`) +
				" " +
				theme.fg("toolDiffRemoved", `-${gitStat.dels}`) +
				theme.fg("dim", ` in ${gitStat.files}`),
		);
	} else if (branch) {
		l3.push(theme.fg("success", `${I.ok} clean`));
	}
	if (s.files > 0)
		l3.push(theme.fg("syntaxType", `${I.file} `) + theme.fg("dim", `${s.files} touched`));
	l3.push(
		theme.fg("muted", `${I.cwd} `) +
			theme.fg("dim", ctx.cwd.replace(/^\/home\/[^/]+/, "~")),
	);
	const line3 = truncateToWidth(l3.join(sep), width);

	return [line1, line2, line3];
}

// ── extension ───────────────────────────────────────────────────────

export default function (pi: ExtensionAPI) {
	let mode: Mode = "full";
	let installedCtx: ExtensionContext | undefined;

	function install(ctx: ExtensionContext) {
		if (!ctx.hasUI || installedCtx === ctx) return;
		installedCtx = ctx;

		ctx.ui.setFooter((tui, theme, footerData) => {
			requestRender = () => tui.requestRender();
			const unsubBranch = footerData.onBranchChange(() => tui.requestRender());
			// Keep duration fresh even when idle
			const timer = setInterval(() => tui.requestRender(), 30_000);
			timer.unref?.();

			return {
				dispose() {
					unsubBranch();
					clearInterval(timer);
				},
				invalidate() {},
				render(width: number): string[] {
					if (mode === "off") return [];
					return mode === "compact"
						? [renderCompact(ctx, theme, width)]
						: renderFull(ctx, theme, footerData, width);
				},
			};
		});
	}

	pi.on("session_start", async (event, ctx) => {
		installedCtx = undefined; // new session runtime → reinstall
		statsCache = undefined; // branch belongs to a different session now
		// Keep accumulated metrics across /reload — the session continues;
		// only a genuinely new session resets them.
		if (event.reason !== "reload") Object.assign(metrics, freshMetrics());
		if (mode !== "off") install(ctx);
	});

	// ── streaming metrics collection (works in all modes, not just TUI)

	pi.on("before_provider_headers", () => {
		// Request is about to hit the wire (fires once per LLM call;
		// retries reuse the same headers and don't re-fire).
		metrics.headersSeen++;
		metrics.requestSentAt = Date.now();
		metrics.firstTokenAt = 0;
		metrics.curTtftMs = null;
	});

	pi.on("after_provider_response", () => {
		// Response headers received (TTFB). Not all providers expose this.
		metrics.responsesSeen++;
		if (metrics.requestSentAt > 0) {
			metrics.lastTtfbMs = Date.now() - metrics.requestSentAt;
		}
	});

	pi.on("message_start", (event) => {
		// Fallback start marker for providers that never fire
		// before_provider_headers (stream consumption is beginning).
		if (event.message.role === "assistant" && metrics.requestSentAt === 0) {
			metrics.requestSentAt = Date.now();
		}
	});

	pi.on("message_update", (event) => {
		// First content-block start or delta (text/thinking/toolcall)
		// ≈ first token from the provider.
		const t = event.assistantMessageEvent.type;
		if (metrics.firstTokenAt === 0 && (t.endsWith("_delta") || t.endsWith("_start"))) {
			metrics.firstTokenAt = Date.now();
			if (metrics.requestSentAt > 0) {
				metrics.curTtftMs = metrics.firstTokenAt - metrics.requestSentAt;
				metrics.lastTtftMs = metrics.curTtftMs;
			}
		}
	});

	pi.on("message_end", (event) => {
		if (event.message.role !== "assistant") return;
		const usage = (event.message as AssistantMessage).usage;
		const streamStart = metrics.firstTokenAt || metrics.requestSentAt;
		const streamMs = streamStart > 0 ? Date.now() - streamStart : 0;
		// Ignore degenerate samples (no stream observed, or instant responses
		// where duration is too small to yield a meaningful rate).
		if (streamMs >= 50 && usage && usage.output > 0) {
			metrics.totalOutput += usage.output;
			metrics.totalStreamMs += streamMs;
			metrics.lastTokPerSec = usage.output / (streamMs / 1000);
			metrics.requests++;
			if (metrics.curTtftMs != null) {
				metrics.totalTtftMs += metrics.curTtftMs;
				metrics.ttftCount++;
			}
		}
		metrics.requestSentAt = 0;
		metrics.firstTokenAt = 0;
		metrics.curTtftMs = null;
		requestRender?.();
	});

	pi.on("session_shutdown", async () => {
		installedCtx = undefined;
		requestRender = undefined;
	});

	pi.registerCommand("footer", {
		description: "Statusline footer: /footer [full|compact|off|debug]",
		handler: async (args, ctx) => {
			const next = args.trim().toLowerCase();
			if (next === "debug") {
				ctx.ui.notify(
					[
						`mode=${mode}`,
						`headersSeen=${metrics.headersSeen} responsesSeen=${metrics.responsesSeen} requests=${metrics.requests}`,
						`lastTtfb=${metrics.lastTtfbMs ?? "-"} avgTtft=${avgTtftMs()?.toFixed(0) ?? "-"} lastTtft=${metrics.lastTtftMs ?? "-"} lastTok/s=${metrics.lastTokPerSec?.toFixed(1) ?? "-"}`,
					].join(" | "),
					"info",
				);
				return;
			}
			if (next === "full" || next === "compact" || next === "off") {
				mode = next as Mode;
			} else {
				mode = mode === "off" ? "full" : "off";
			}
			if (mode === "off") {
				installedCtx = undefined;
				requestRender = undefined;
				ctx.ui.setFooter(undefined); // restore pi's default footer
				ctx.ui.notify("Default footer restored", "info");
			} else {
				installedCtx = undefined; // force reinstall
				install(ctx);
				ctx.ui.notify(`Statusline footer: ${mode} mode`, "info");
			}
		},
	});
}
