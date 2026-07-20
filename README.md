# pi-statusline-footer

A rich multi-line statusline footer for [pi](https://github.com/earendil-works/pi-coding-agent), inspired by [claude-tui](https://github.com/slima4/claude-tui)'s Claude Code statusline.

Three rows, one theme per row:

```
  k3 (moonshot) │   ███░░░░░░░░░░░░░░ 8% 78.9k/1.05M │   1x │   1h 32m   9 │  65.2k   31.4k │   96% │   $0.75 (~$0.058/turn)
  μ 4.2s    2.1s │   1.8s │   μ 28.9 tok/s    31.2 │   42 │   2 (4.8%)
  main │ +42 −17 in 3 │   5 touched │   ~/code/my-project
```

| Row | Theme | Contents |
| --- | ----- | -------- |
| 1 | **Model state** | model name (provider), context-window bar with % and tokens, compactions, elapsed time, turns, input/output tokens, cache hit ratio, session cost and cost/turn |
| 2 | **Performance** | mean + last TTFT (time to first token), TTFB, token-weighted average + last tokens/sec, tool call count, error rate |
| 3 | **Local state** | git branch, working-tree diff (`+adds −dels`), files touched this session, cwd |

A one-line compact mode is also available.

## Features

- **Live context window bar** — green → yellow → red as you approach the limit, so you know when to `/compact`
- **Real streaming metrics, measured passively** — TTFT and tokens/sec are computed from pi's event stream (`before_provider_headers` → first streamed delta → `message_end` with exact `usage.output`), not estimated
- **TTFB vs TTFT decomposition** — tells apart "server slow to respond" from "connected but silent stream" (handy for diagnosing gateways/proxies that buffer reasoning)
- **Session economics** — cost, cost/turn, cache hit ratio, in/out token totals, all parsed from session history
- **Git awareness** — branch plus working-tree `+adds −dels`, refreshed in the background (zero render cost)
- **Nerd Font icons + semantic theme colors** — respects your pi theme
- **Zero hot-path cost** — session stats are cached keyed by branch leaf; git stats are throttled and async

## Install

From git (replace with the actual repo URL):

```bash
pi install git:github.com/minhuw/pi-statusline-footer
```

Or from a local clone:

```bash
git clone <repo-url> && pi install /path/to/pi-statusline-footer
```

Or try it without installing (current run only):

```bash
pi -e git:github.com/minhuw/pi-statusline-footer
```

## Usage

| Command | Effect |
| ------- | ------ |
| `/footer` | Toggle on/off |
| `/footer full` | 3-row layout (default) |
| `/footer compact` | 1-row layout |
| `/footer off` | Restore pi's default footer |
| `/footer debug` | Show metric-collection internals (useful for diagnosing provider latency) |

## Requirements

- A current version of pi
- A terminal font with [Nerd Font](https://www.nerdfonts.com/) glyphs patched in for the icons (any FA 4.7-era Nerd Font works). Without one the icons render as boxes — the footer still works.

## How it works

- **Context bar, cost, turns, cache** — parsed from `ctx.sessionManager.getBranch()` (cached per leaf entry), context usage from `ctx.getContextUsage()`
- **TTFT** — `before_provider_headers` (request sent, per LLM call) → first `text_start`/`thinking_start`/`toolcall_start`/`*_delta` event. Falls back to `message_start` for providers that abstract HTTP away
- **TTFB** — `after_provider_response` (response headers), when the provider exposes it
- **Tokens/sec** — exact `usage.output` from `message_end` over measured stream wall-time; the average is token-weighted (`Σoutput ÷ Σstream time`)
- **Git** — `footerData.getGitBranch()` for the branch; `git diff --shortstat HEAD` refreshed at most every 15s in the background for diff stats

## License

MIT
