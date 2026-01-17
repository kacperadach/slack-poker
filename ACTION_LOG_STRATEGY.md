# Action Log Strategy

## Goal

Use the Action Log as the single source of truth for **game mutations**, while also capturing **user intent** for audit/debug. Keep replay logic deterministic and avoid logging non-mutating UI events as game actions.

## Strategy

- **Two streams in one log:**
  - `message_received`: records handled Slack messages (intent + routing context).
  - **Game mutation actions**: only actions that change game state (`new_game`, `join`, `buy_in`, `round_start`, `bet`, `call`, `check`, `fold`, etc.).
- **No pre-action entries** (`pre_call`, `pre_check`, etc.).
  - Pre-move intent is visible via `message_received`, and executed actions are logged as their actual mutation.
- **No `show_cards` action** (non-mutation).
  - Card reveal intent remains in `message_received` if needed.

## Implementation (Concise)

- Added `message_received` action type with:
  - `handlerKey`, `normalizedText`, `messageText`, `slackMessageTs`, `playerId`, `workspaceId`, `channelId`, `timestamp`.
- Removed pre-action and `show_cards` action types from the log schema and tests.
- Updated tests to assert `message_received` entries instead of filtering them out.
- Added an action-log snapshot test to capture full log rows including JSON `data`.

## Why This Works

- **Replay fidelity** comes from mutation-only entries.
- **Audit trail** comes from `message_received` with minimal overhead.
- Keeps logs aligned with actual state changes while still traceable to user input.
