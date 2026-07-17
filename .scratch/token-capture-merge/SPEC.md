# Spec: Merge Token-Usage Network Capture into Context Meter

## Problem Statement

The context meter (`codex-context-used-meter.js`) and the Codex Token Usage script (`market-codex-token-usage.js`) both independently intercept the same network traffic (fetch, WebSocket, postMessage) to extract token usage data. Running both scripts causes duplicate interception, redundant `.clone().text()` calls, and cross-script deduplication complexity. The meter's own extraction layer is simpler than the token-usage script's: it only looks for `contextUsed`/`contextLimit`, misses cached token breakdowns, Anthropic-style field shapes, and SSE stream fragments. The meter also lacks XHR interception, which some Codex request paths use.

The user's goals are narrow: (1) a token spend effect that fires when tokens are consumed, and (2) real-time context remaining display. Both features already exist in the meter via `recordContextUsageDelta` + `showTokenSpendEffect` and `detectReading()`. The missing piece is better data capture feeding those features.

## Solution

Merge the token-usage script's network capture and extraction layer into the context meter as a single script. Replace the meter's simpler extraction functions and three interceptors with the token-usage script's more complete extraction layer (13-field normalization, recursive object tree traversal, SSE splitting) and four interceptors (fetch, XHR, WebSocket, postMessage). Redirect all four interceptors' output into the meter's existing `rememberCapturedUsage` path, which feeds `detectReading()` and `recordContextUsageDelta()`.

No turn model, no ledger, no history restoration, no sessionStorage persistence, no badge UI. The meter retains its current architecture; only the data capture layer is upgraded.

## User Stories

1. As a Codex user, I want the token spend effect to fire reliably when a response consumes tokens, so that I get visual feedback on every model call.
2. As a Codex user, I want the context remaining display to update as quickly as possible after a response, so that I know how much context window is left.
3. As a Codex user, I want token usage captured from all network transport types (fetch, XHR, WebSocket, postMessage), so that no consumption is missed regardless of which transport Codex uses.
4. As a Codex user, I want cached token fields (cache read, cache creation) to be parsed from API responses, so that the spend effect reflects the actual token cost including cache behavior.
5. As a Codex user, I want the model name from API responses to be captured, so that the context window lookup fallback works when the API response omits an explicit context limit.
6. As a Codex user, I want SSE stream fragments to be parsed for usage data, so that streaming responses are captured as completely as non-streaming ones.
7. As a Codex user, I want only one script running instead of two, so that there is no duplicate interception overhead or cross-script feedback loops.
8. As a Codex user, I want switching conversations to still reset the context remaining display, so that stale readings from one conversation do not bleed into another.
9. As a Codex user, I want the context remaining display to work when switching to a conversation that has no recent network traffic, so that the reading comes from the app signal path even without network capture.

## Implementation Decisions

### Extraction layer replacement

The meter's `normalizeUsageRaw`, `collectUsageFromObject`, `extractApiUsageFromObject`, and `extractUsagesFromPayload` are replaced by the token-usage script's `normalizeUsage`, `collectUsagesInObject`, `extractUsages`, and `extractJsonFragmentsFromSse`.

`normalizeUsage` produces a 13-field canonical structure: `inputTokens`, `inputTotalTokens`, `outputTokens`, `outputTotalTokens`, `totalTokens`, `requestTotalTokens`, `cachedTokens`, `cachedReadTokens`, `cacheReadTokens`, `cacheCreationTokens`, `totalEstimated`, `hasBreakdown`, `contextUsed`, `contextLimit`.

`collectUsagesInObject` recursively traverses object trees (max depth 8, WeakSet cycle detection), checking direct keys (`usage`, `last`, `lastUsage`, `lastTokenUsage`, `last_token_usage`), self-normalization, and nested keys (`response`, `data`, `body`, `message`, `result`, `event`, `params`, `tokenUsage`, `token_usage`, `contextUsage`, `context_usage`, `info`).

`extractUsages` handles strings (JSON.parse, then SSE `data:` line splitting) and objects.

### Model name capture

Model name is captured during extraction. The token-usage script's `collectUsagesInObject` does not currently capture `model`. The meter's `extractApiUsageFromObject` does. The merged version captures `model`/`modelName`/`model_name` from the same payload object where usage is found, storing it in `state.lastSeenModel`. This preserves the existing `lookupModelContextWindow` fallback used by `scanCapturedContextUsage` and `scanTokenUsageScriptContextUsage` (the latter being removed, but the model lookup is also used directly in `scanCapturedContextUsage`).

### Interceptor replacement

The meter's `installFetchInterceptor`, `installWebSocketInterceptor`, `installPostMessageUsageCapture`, and `installNetworkInterceptors` are replaced by the token-usage script's `installFetchObserver`, `installXhrObserver`, `installWebSocketObserver`, and `installPostMessageObserver`.

All four observers redirect their captured usages to the meter's `rememberCapturedUsage` instead of the token-usage script's turn/ledger pipeline. The fetch and XHR observers use `isCodexApiUrl` to filter which URLs to process.

### rememberCapturedUsage adaptation

`rememberCapturedUsage` currently expects `{used, limit, conversationId}` from the meter's simpler extraction. After the merge, it receives normalized usage objects with `contextUsed`/`contextLimit` fields. It is adapted to read `contextUsed` (falling back to `totalTokens` or `inputTokens`) and `contextLimit` from the normalized structure, while preserving the existing conversation ID attribution logic and 10-minute freshness window.

### State field changes

Removed state fields: `postMessageUsage`, `postMessageUsageConversationId`, `postMessageUsageAt`, `postMessageListenerInstalled`, `postMessageUsageListener`.

Kept state fields (repurposed): `capturedUsage`, `capturedUsageConversationId`, `capturedUsageAt`, `lastSeenModel`, `webSocketIntercepted`, `fetchIntercepted`. A new `xhrIntercepted` field is added to track XHR observer installation.

### Functions removed

- `normalizeUsageRaw` (replaced by `normalizeUsage`)
- `collectUsageFromObject` (replaced by `collectUsagesInObject`)
- `extractApiUsageFromObject` (model capture merged into `collectUsagesInObject`)
- `extractUsagesFromPayload` (replaced by `extractUsages`)
- `installFetchInterceptor` (replaced by `installFetchObserver`)
- `installWebSocketInterceptor` (replaced by `installWebSocketObserver`)
- `installPostMessageUsageCapture` (replaced by `installPostMessageObserver`)
- `installNetworkInterceptors` (replaced by direct calls to the four observers)
- `restoreLegacyCaptureHooks` (no legacy hooks to restore)
- `scanTokenUsageScriptContextUsage` (no external token-usage script to read from)
- `scanPostMessageContextUsage` (dead code, already unused)

### Functions kept unchanged

- `detectReading()` (only the `scanTokenUsageScriptContextUsage` call removed)
- `recordContextUsageDelta` + `showTokenSpendEffect` (spend effect)
- `scanCapturedContextUsage` (reads from `state.capturedUsage`)
- `scanAppSignalContextUsage` and all app signal / React state scanning (conversation switch primary path)
- `scanStatusReactContextUsage`, `scanWindowForContextUsage` (fallback paths)
- All meter UI rendering
- `lookupModelContextWindow`, `MODEL_CONTEXT_WINDOWS`
- `makeReading`, `withConversationId`, `normalizeConversationId`

### diagnose() API

The `diagnose()` function keeps returning `capturedUsage`, `capturedUsageConversationId`, `lastSeenModel`, `webSocketIntercepted`, `fetchIntercepted`. A new `xhrIntercepted` field is added.

## Testing Decisions

The existing test seam at `test/detect-reading.test.js` is the highest and only seam. It loads the full script via `eval` in a mocked browser environment and tests behavior through the public `window.__codexContextMeter` API. This seam is preserved and extended.

A good test verifies external behavior (what the API returns, what state changes are observable) without asserting on internal function names or implementation details. The existing tests already follow this pattern: they send fake usage payloads through message listeners and assert on `diagnose()` output and `getState()` output.

Tests to keep (behavior unchanged):
- Script loads with correct version
- diagnose returns expected shape
- refresh doesn't throw
- Network-captured usage via message listener sets capturedUsage with correct used/limit
- Model-based context window lookup (gpt-5, gpt-4.1, GLM variants)
- Conversation switching resets context (no bleed)

Tests to add:
- XHR interception is installed (new `xhrIntercepted` in diagnose)
- SSE stream fragment parsing (usage in `data:` lines)
- Cached token fields are captured in the normalized usage

Tests to update:
- The `capturedUsage` shape assertion: `used` should still equal `input_tokens` (50000 for gpt-5), `limit` should still equal the model context window. The internal extraction path changes but the externally observable behavior should not.

## Out of Scope

- Turn model (turn lifecycle, turn aggregation, per-turn call deduplication)
- Ledger (append-only event log, turn reconstruction from ledger)
- History restoration (server-side usage history backfill via session bridge)
- sessionStorage persistence (reload recovery of turn aggregates)
- Badge UI (token-usage script's DOM badge, MutationObserver, render scheduler)
- Per-turn input/output/cached breakdown display
- Any changes to meter UI rendering or styling
- Any changes to the app signal / React state scanning paths

## Further Notes

The token-usage script (`market-codex-token-usage.js`) is not modified or deleted by this change. It remains in the user scripts directory. After the merge, running both scripts simultaneously would cause the token-usage script's interceptors to wrap the already-wrapped functions, but both would feed the same data — the meter's interceptors run first (installed at script load), and the token-usage script's would be redundant. Users who want a clean setup can disable the token-usage script.

The `SCRIPT_VERSION` constant in the meter should be incremented to signal the new behavior. The test's version assertion should be updated to match.
