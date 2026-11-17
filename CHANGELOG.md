# Changelog

## [0.2.0](https://github.com/fdkevin0/pi-agy-acp/compare/v0.1.4...v0.2.0) (2026-11-17)


### Features

* discover model context windows dynamically from session metadata ([#29](https://github.com/fdkevin0/pi-agy-acp/issues/29)) ([c29277f](https://github.com/fdkevin0/pi-agy-acp/commit/c29277ff3e8c64b9549444b14177bcfd283ef50a))

## [0.1.4](https://github.com/fdkevin0/pi-agy-acp/compare/v0.1.3...v0.1.4) (2026-11-15)


### Bug Fixes

* accept the flat mcp_pi_&lt;tool&gt; name agy 1.5.8 reports for Pi tools ([#23](https://github.com/fdkevin0/pi-agy-acp/issues/23)) ([d202134](https://github.com/fdkevin0/pi-agy-acp/commit/d2021349a4886ae34c5d4de7510da102f0e0c655))
* deliver harness system prompt in opening ACP prompt ([#24](https://github.com/fdkevin0/pi-agy-acp/issues/24)) ([#26](https://github.com/fdkevin0/pi-agy-acp/issues/26)) ([b8679b0](https://github.com/fdkevin0/pi-agy-acp/commit/b8679b0baa171d6447a1cb11195d82a949bb2adf))
* match quota groups to specific models and scope cache-warming veto ([#21](https://github.com/fdkevin0/pi-agy-acp/issues/21)) ([4f5bc7b](https://github.com/fdkevin0/pi-agy-acp/commit/4f5bc7b82f4e232ba36e2fcd3aa1e9ea5483e88b))
* preserve turn usage totals, pin CI baseline, and test permission probe timing ([#10](https://github.com/fdkevin0/pi-agy-acp/issues/10)) ([#27](https://github.com/fdkevin0/pi-agy-acp/issues/27)) ([148fb6a](https://github.com/fdkevin0/pi-agy-acp/commit/148fb6a2f9bf12b31cac4e854d22a652a72c4f3b))

## [0.1.3]

- Default quota display to `used` across the status bar, quota panel, and warnings, with `/agy-acp quota [used|remaining]` persistence in `settings.json` and `PI_AGY_QUOTA_DISPLAY` startup override.
- Harden MCP HTTP request boundaries, runtime disposal, conversation turn ownership, and tool continuation/cancellation handling.
- Correct the minimum Node.js version to 22.19.0 to match Pi 1.5.x requirements.
- Add contribution and security policies, issue templates, dependency updates, and CI coverage for Node.js 22.19.0 and 24.

## [0.1.2]

- Fix model refresh self-cancellation and support forced or cancelled refreshes.
- Keep ACP running during compaction and tree navigation while clearing conversation sessions.
- Report context overflow and exhausted quota in the format Pi uses for recovery and retry decisions.
- Handle fragmented tool arguments and skip empty system updates.
- Show cached quota in the status bar and check quota after settled Antigravity runs, with deduplicated low-quota warnings.
- Stop automatic prompt-cache warming and keep runtime warnings out of the TUI.
- Report the package version in ACP and MCP handshakes.

## [0.1.1]

- Add CI and release workflows, with tag validation and safe release retries.
- Deduplicate model discovery and clean up temporary ACP session files and rotated logs.

## [0.1.0]

- Add the Antigravity ACP provider for Pi, including streaming, images, and parallel tool calls.
- Discover account models and reasoning levels through ACP.
- Add status and quota panels with account details, remaining-quota bars, and reset countdowns.
