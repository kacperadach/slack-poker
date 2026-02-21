# Bug: Action Log Cards Stored as "[object Object]"

## Summary

The `round_start` action logs store player cards and community cards as `"[object Object]"` instead of proper card strings like `"Ah"`, `"Ks"`, etc.

## Root Cause

In `src/index.ts`, the code calls `.toString()` on card objects returned from `game.getState()`:

```typescript
playerCards[p.id] = [p.cards[0].toString(), p.cards[1].toString()];
```

However, `game.getState()` returns cards as plain JSON objects via `card.toJson()`:

```typescript
// In Game.ts getState()
communityCards: this.communityCards.map((card) => card.toJson()),
activePlayers: this.activePlayers.map((player) => player.toJson()),

// Card.toJson() returns:
{ suit: "Hearts", rank: "A" }
```

When you call `.toString()` on a plain JavaScript object, it returns `"[object Object]"`.

## Affected Code

Two locations in `src/index.ts`:

- Lines 962-969 (in `startRoundWithAction`)
- Lines 1152-1159 (in `takeHerToTheWithAction`)

## Impact

All `round_start` action logs in the database have corrupted card data. The analytics download endpoint returns `"[object Object]"` instead of actual card values.

## Test

A failing test was added to `src/test/main.test.ts`:

```typescript
it("startRoundWithAction logs cards as strings not objects", async () => {
  // ... test setup ...
  expect(roundStart.playerCards.player1[0]).not.toBe("[object Object]");
});
```

## Potential Fixes

1. **Fix in index.ts**: Use `Card.fromJson()` to reconstruct Card instances before calling `.toString()`
2. **Fix in Card.ts**: Modify `toJson()` to return an object with a `toString()` method
3. **Fix in Game.ts**: Change `getState()` to return card strings directly instead of JSON objects
