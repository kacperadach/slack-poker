# Game Scenario Testing Pattern

This document describes the repeatable pattern used for writing comprehensive poker game scenario tests.

## Overview

Game scenario tests simulate full poker games turn-by-turn, verifying both the game state and Slack message outputs at each step. These tests are deterministic thanks to mocking `Math.random`.

## Key Components

### 1. Mock `Math.random` for Deterministic Card Dealing

The deck shuffle uses `Math.random`, so mocking it ensures the same cards are dealt every test run:

```typescript
it("game scenario X", async () => {
  vi.spyOn(Math, "random").mockReturnValue(0.6);
  // ... rest of test
});
```

**Why this matters:**

- Without mocking, each test run deals different cards
- Snapshots would fail on every run
- Hand outcomes (who wins) would be unpredictable

### 2. Set Up Context Objects for Each Player

Create separate context objects for each player in the game:

```typescript
const sayFn = vi.fn();
const postEphemeralFn = vi.fn();

const contextUser1 = {
  teamId: workspaceId,
  channelId: channelId,
  userId: "user1",
  say: sayFn,
  client: {
    chat: {
      postEphemeral: postEphemeralFn,
    },
  },
};

const contextUser2 = {
  teamId: workspaceId,
  channelId: channelId,
  userId: "user2",
  say: sayFn,
  client: {
    chat: {
      postEphemeral: postEphemeralFn,
    },
  },
};
```

**Key points:**

- All players share the same `sayFn` and `postEphemeralFn` mocks
- This allows verifying all messages in order
- Each context has a unique `userId`

### 3. Turn-by-Turn Pattern

Each turn follows this structure:

```typescript
// 1. Perform the action
await actionFunction(env, contextUserX, payload);

// 2. Get the updated game state
const gameStateN = await getGameState(stub, workspaceId, channelId);

// 3. Verify game state
expect(gameStateN.gameState).toBe(GameState.ExpectedState);
expect(gameStateN.communityCards.length).toBe(expectedCount);
expect(getPlayerById(gameStateN, "user1")?.chips).toBe(expectedChips);

// 4. Verify Slack messages with inline snapshots
expect(sayFn.mock.calls).toMatchInlineSnapshot(`
  [
    [
      {
        "text": "Expected message content",
      },
    ],
  ]
`);

// 5. Clear mocks for next turn
sayFn.mockClear();
postEphemeralFn.mockClear();
```

### 4. Available Action Functions

Import the action functions you need:

```typescript
import {
  buyIn,
  joinGame,
  newGame,
  startRound,
  call,
  check,
  fold,
  bet,
} from "..";
```

| Function     | Purpose                | Example Payload           |
| ------------ | ---------------------- | ------------------------- |
| `newGame`    | Create a new game      | `null`                    |
| `joinGame`   | Player joins table     | `null`                    |
| `buyIn`      | Player buys chips      | `{ text: "buy in 1000" }` |
| `startRound` | Deal cards, start hand | `null`                    |
| `call`       | Match current bet      | `null`                    |
| `check`      | Pass action            | `null`                    |
| `fold`       | Surrender hand         | `null`                    |
| `bet`        | Place a bet            | `{ text: "bet 100" }`     |

### 5. Helper Functions

#### `getStub` - Get Durable Object reference

```typescript
function getStub({
  workspaceId,
  channelId,
}: {
  workspaceId: string;
  channelId: string;
}) {
  const id = env.POKER_DURABLE_OBJECT.idFromName(`${workspaceId}-${channelId}`);
  return env.POKER_DURABLE_OBJECT.get(id);
}
```

#### `getGameState` - Read current game state from storage

```typescript
function getGameState(
  stub: DurableObjectStub,
  workspaceId: string,
  channelId: string
) {
  return runInDurableObject(stub, async (_instance, state) => {
    const result = state.storage.sql
      .exec(
        "SELECT game FROM PokerGames WHERE workspaceId = ? AND channelId = ?",
        workspaceId,
        channelId
      )
      .one();
    return TexasHoldem.fromJson(JSON.parse(result.game as string)).getState();
  });
}
```

#### `getPlayerById` - Find player in game state

```typescript
function getPlayerById(
  gameState: ReturnType<TexasHoldem["getState"]>,
  id: string
) {
  return [...gameState.activePlayers, ...gameState.inactivePlayers].find(
    (player) => player.id === id
  );
}
```

## Game Flow Reference

### Betting Order

**Pre-Flop (2 players):**

1. Small blind posts (player after dealer)
2. Big blind posts (player after small blind)
3. Small blind acts first (call/raise/fold)
4. Big blind gets option to check or raise

**Post-Flop (Flop, Turn, River):**

1. Player after dealer acts first
2. In heads-up, non-dealer acts first

### Game States

```typescript
enum GameState {
  WaitingForPlayers, // 0 - Before deal
  PreFlop, // 1 - After hole cards dealt
  Flop, // 2 - 3 community cards
  Turn, // 3 - 4 community cards
  River, // 4 - 5 community cards
}
```

### State Transitions

```
WaitingForPlayers → PreFlop (startRound)
PreFlop → Flop (betting complete)
Flop → Turn (betting complete)
Turn → River (betting complete)
River → WaitingForPlayers (showdown or all fold)
```

## Example: Complete Game Scenario Structure

```typescript
it("game scenario N", async () => {
  // === SETUP ===
  vi.spyOn(Math, "random").mockReturnValue(0.6);
  const workspaceId = "test-workspace";
  const channelId = "test-channel";
  const sayFn = vi.fn();
  const postEphemeralFn = vi.fn();

  // Create player contexts...
  const stub = getStub({ workspaceId, channelId });

  // === GAME SETUP PHASE ===
  // Create game
  await newGame(env, contextUser1);
  // Verify & clear mocks...

  // Players join
  await joinGame(env, contextUser1);
  // Verify & clear mocks...

  // Players buy in
  await buyIn(env, contextUser1, { text: "buy in 1000" });
  // Verify & clear mocks...

  // === ROUND 1: PREFLOP ===
  await startRound(env, contextUser1, null);
  // Verify game state, cards dealt, blinds posted...

  // Player actions
  await call(env, contextUser1, null);
  // Verify...

  await check(env, contextUser2, null);
  // Verify transition to Flop...

  // === ROUND 1: FLOP ===
  await check(env, contextUser1, null);
  // Verify...

  await check(env, contextUser2, null);
  // Verify transition to Turn...

  // === ROUND 1: TURN ===
  // Continue pattern...

  // === ROUND 1: RIVER ===
  // Continue pattern...

  // === SHOWDOWN ===
  // Verify winner, pot distribution, chip counts

  // === ROUND 2 (optional) ===
  // Verify dealer button moved, continue testing...
});
```

## Tips

1. **Run tests with `-u` flag first** to generate initial snapshots, then review them
2. **Different `Math.random` values** produce different shuffles - find one that creates the game state you want to test
3. **Test edge cases** in separate scenarios: all-in, side pots, folds, etc.
4. **Verify chip counts** at critical points (after blinds, after pot won)
5. **Check dealer position** moves correctly between rounds
