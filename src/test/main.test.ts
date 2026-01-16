import { env, runInDurableObject } from "cloudflare:test";
import { describe, it, expect } from "vitest";
import { TexasHoldem } from "../Game";

describe("Poker Durable Object", () => {
  // Each test gets isolated storage automatically
  it("creates tables", async () => {
    const id = env.POKER_DURABLE_OBJECT.idFromName("test");
    const stub = env.POKER_DURABLE_OBJECT.get(id);

    await runInDurableObject(stub, async (_instance, state) => {
      const result = state.storage.sql
        .exec<{
          name: string;
        }>("SELECT name FROM sqlite_master WHERE type='table'")
        .toArray();
      expect(result).toEqual([{ name: "PokerGames" }, { name: "Flops" }]);
    });
  });

  it("creates new game", async () => {
    const id = env.POKER_DURABLE_OBJECT.idFromName("test");
    const stub = env.POKER_DURABLE_OBJECT.get(id);

    await stub.createGame(
      "test-workspace",
      "test-channel",
      JSON.stringify(new TexasHoldem().toJson())
    );

    await runInDurableObject(stub, async (_instance, state) => {
      const result = state.storage.sql
        .exec(
          "SELECT game FROM PokerGames WHERE workspaceId = ? AND channelId = ?",
          "test-workspace",
          "test-channel"
        )
        .one();

      expect(JSON.parse(result.game as string)).toEqual({
        gameState: 0,
        deck: {
          cards: [
            { suit: "Hearts", rank: "2" },
            { suit: "Hearts", rank: "3" },
            { suit: "Hearts", rank: "4" },
            { suit: "Hearts", rank: "5" },
            { suit: "Hearts", rank: "6" },
            { suit: "Hearts", rank: "7" },
            { suit: "Hearts", rank: "8" },
            { suit: "Hearts", rank: "9" },
            { suit: "Hearts", rank: "10" },
            { suit: "Hearts", rank: "J" },
            { suit: "Hearts", rank: "Q" },
            { suit: "Hearts", rank: "K" },
            { suit: "Hearts", rank: "A" },
            { suit: "Diamonds", rank: "2" },
            { suit: "Diamonds", rank: "3" },
            { suit: "Diamonds", rank: "4" },
            { suit: "Diamonds", rank: "5" },
            { suit: "Diamonds", rank: "6" },
            { suit: "Diamonds", rank: "7" },
            { suit: "Diamonds", rank: "8" },
            { suit: "Diamonds", rank: "9" },
            { suit: "Diamonds", rank: "10" },
            { suit: "Diamonds", rank: "J" },
            { suit: "Diamonds", rank: "Q" },
            { suit: "Diamonds", rank: "K" },
            { suit: "Diamonds", rank: "A" },
            { suit: "Clubs", rank: "2" },
            { suit: "Clubs", rank: "3" },
            { suit: "Clubs", rank: "4" },
            { suit: "Clubs", rank: "5" },
            { suit: "Clubs", rank: "6" },
            { suit: "Clubs", rank: "7" },
            { suit: "Clubs", rank: "8" },
            { suit: "Clubs", rank: "9" },
            { suit: "Clubs", rank: "10" },
            { suit: "Clubs", rank: "J" },
            { suit: "Clubs", rank: "Q" },
            { suit: "Clubs", rank: "K" },
            { suit: "Clubs", rank: "A" },
            { suit: "Spades", rank: "2" },
            { suit: "Spades", rank: "3" },
            { suit: "Spades", rank: "4" },
            { suit: "Spades", rank: "5" },
            { suit: "Spades", rank: "6" },
            { suit: "Spades", rank: "7" },
            { suit: "Spades", rank: "8" },
            { suit: "Spades", rank: "9" },
            { suit: "Spades", rank: "10" },
            { suit: "Spades", rank: "J" },
            { suit: "Spades", rank: "Q" },
            { suit: "Spades", rank: "K" },
            { suit: "Spades", rank: "A" },
          ],
        },
        communityCards: [],
        activePlayers: [],
        inactivePlayers: [],
        currentPot: 0,
        dealerPosition: 0,
        smallBlind: 10,
        bigBlind: 20,
        currentPlayerIndex: 0,
        foldedPlayers: [],
        currentBetAmount: 0,
        lastRaiseAmount: 0,
        playerPositions: [],
      });
    });
  });
});
