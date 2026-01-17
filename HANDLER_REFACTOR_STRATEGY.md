# Handler Refactor Strategy (Concise)

## Goal

Apply the same refactor pattern to **all message handlers**: keep worker handlers as thin shells and move transactional logic into the Durable Object so a single DO call handles validation, state changes, and action logging.

## Approach

- **Worker (shell):**
  - Parse/normalize Slack input.
  - Build pure data payload (workspaceId, channelId, playerId, messageText, handlerKey, timestamps).
  - Call a single DO method and handle Slack responses (success/failure).
- **Durable Object (core):**
  - Validate game state.
  - Mutate game state atomically.
  - Log `message_received` and the relevant action(s) in the same DO request.
  - Return a small result object for the worker to translate into Slack messages.

## Why

- Ensures **consistency**: all state mutations + logs occur in one serialized DO request.
- Keeps worker code minimal and focused on I/O.
- Improves auditability by tying message + mutation in the same transaction.

## Pattern to Reuse

For each handler, follow the same shape:

1. Worker builds payload → one DO call.
2. DO validates + mutates + logs.
3. Worker sends Slack messages based on DO result.

## Handler Inventory

### Already Refactored ✓
- newGame
- joinGame
- buyIn
- fold
- check
- call
- bet
- startRound
- takeHerToThe
- cashOut
- leaveGame
- preDeal
- preNH
- preAH
- preCheck
- preFold
- preCall
- preBet

### Need Refactoring (0)

All handlers requiring refactoring have been completed!

### No Refactoring Needed

**Read-only (9):** getGameState, context, showChips, showStacks, showFlops, searchFlops, nudgePlayer, showCards, revealCards

**Utility (7):** drillGto, ass, help, commitSeppuku, scoreDice, keepDice, rollDice
