import { env, runInDurableObject } from "cloudflare:test";
import { describe, it, expect, vi } from "vitest";
import { GameState, TexasHoldem } from "../Game";
import { buyIn, joinGame, newGame, preDeal, preNH, startRound } from "..";
import { Player } from "../Player";

describe("Poker Durable Object", () => {
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

  it("starts new game", async () => {
    const workspaceId = "test-workspace";
    const channelId = "test-channel";
    const context = {
      teamId: workspaceId,
      channelId: channelId,
      say: vi.fn(),
    };
    const id = env.POKER_DURABLE_OBJECT.idFromName(
      `${workspaceId}-${channelId}`
    );
    const stub = env.POKER_DURABLE_OBJECT.get(id);
    await newGame(env, context);
    const gameState = await getGameState(stub, workspaceId, channelId);
    expect(gameState.deck.cards.length).toBe(52);
    expect(gameState.smallBlind).toBe(10);
    expect(gameState.bigBlind).toBe(20);
    expect(context.say).toHaveBeenCalledWith({
      text: "New Poker Game created!",
    });
  });

  it("won't pre-deal if no game exists", async () => {
    const workspaceId = "test-workspace";
    const channelId = "test-channel";
    const context = {
      teamId: workspaceId,
      channelId: channelId,
      userId: "1",
      say: vi.fn(),
    };
    await preDeal(env, context, null);
    expect(context.say).toHaveBeenCalledWith({
      text: "No game exists! Type 'New Game'",
    });
  });

  it("won't pre-nh if no game exists", async () => {
    const workspaceId = "test-workspace";
    const channelId = "test-channel";
    const context = {
      teamId: workspaceId,
      channelId: channelId,
      userId: "1",
      say: vi.fn(),
    };
    await preNH(env, context, null);
    expect(context.say).toHaveBeenCalledWith({
      text: "No game exists! Type 'New Game'",
    });
  });

  it("starts new game", async () => {
    const workspaceId = "test-workspace";
    const channelId = "test-channel";
    const context = {
      teamId: workspaceId,
      channelId: channelId,
      say: vi.fn(),
    };
    const id = env.POKER_DURABLE_OBJECT.idFromName(
      `${workspaceId}-${channelId}`
    );
    const stub = env.POKER_DURABLE_OBJECT.get(id);
    await newGame(env, context);
    const gameState = await getGameState(stub, workspaceId, channelId);
    expect(gameState.deck.cards.length).toBe(52);
    expect(gameState.smallBlind).toBe(10);
    expect(gameState.bigBlind).toBe(20);
    expect(gameState.activePlayers.length).toBe(0);
    expect(gameState.inactivePlayers.length).toBe(0);

    expect(context.say).toHaveBeenCalledWith({
      text: "New Poker Game created!",
    });
  });

  it("allows players to join game", async () => {
    const workspaceId = "test-workspace";
    const channelId = "test-channel";
    const context = {
      teamId: workspaceId,
      channelId: channelId,
      userId: "1",
      say: vi.fn(),
    };
    const id = env.POKER_DURABLE_OBJECT.idFromName(
      `${workspaceId}-${channelId}`
    );
    const stub = env.POKER_DURABLE_OBJECT.get(id);
    await newGame(env, context);
    await joinGame(env, context);

    const gameState = await getGameState(stub, workspaceId, channelId);
    expect(gameState.activePlayers.length).toBe(1);
    expect(gameState.activePlayers[0].id).toBe("1");
    expect(gameState.activePlayers[0].chips).toBe(0);
  });

  it("game scenario 1", async () => {
    const workspaceId = "test-workspace";
    const channelId = "test-channel";
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
    const stub = getStub({ workspaceId, channelId });
    await newGame(env, contextUser1);
    expect(sayFn.mock.calls).toMatchInlineSnapshot(`
      [
        [
          {
            "text": "New Poker Game created!",
          },
        ],
      ]
    `);
    sayFn.mockClear();

    // user1 joins game
    await joinGame(env, contextUser1);

    // pre-deal
    const gameState1 = await getGameState(stub, workspaceId, channelId);
    expect(gameState1.activePlayers.length).toBe(1);
    expect(gameState1.inactivePlayers.length).toBe(0);
    expect(gameState1.gameState).toBe(GameState.WaitingForPlayers);
    expect(sayFn.mock.calls).toMatchInlineSnapshot(`
      [
        [
          {
            "text": "<@user1> Welcome to the table!",
          },
        ],
      ]
    `);
    sayFn.mockClear();

    // deal attempt
    // TODO: if invalid deal, don't remove player
    await startRound(env, contextUser1, null);
    const gameState2 = await getGameState(stub, workspaceId, channelId);
    expect(gameState2.activePlayers.length).toBe(0);
    expect(gameState2.inactivePlayers.length).toBe(1);
    expect(gameState2.gameState).toBe(GameState.WaitingForPlayers);
    expect(sayFn.mock.calls).toMatchInlineSnapshot(`
      [
        [
          {
            "text": "<@user1> is being removed from the game for having no chips
      <@user1> has left the table!
      How about you get some friends first",
          },
        ],
      ]
    `);
    sayFn.mockClear();

    // user2 joins game
    await joinGame(env, contextUser2);
    const gameState3 = await getGameState(stub, workspaceId, channelId);
    expect(gameState3.activePlayers.length).toBe(1);
    expect(gameState3.inactivePlayers.length).toBe(1);
    expect(gameState3.gameState).toBe(GameState.WaitingForPlayers);
    expect(sayFn.mock.calls).toMatchInlineSnapshot(`
      [
        [
          {
            "text": "<@user2> Welcome to the table!",
          },
        ],
      ]
    `);
    sayFn.mockClear();

    // user1 buy-in
    await buyIn(env, contextUser1, { text: "buy in 1000" });
    const gameState4 = await getGameState(stub, workspaceId, channelId);
    expect(getPlayerById(gameState4, "user1")?.chips).toBe(1000);
    expect(getPlayerById(gameState4, "user2")?.chips).toBe(0);
    expect(gameState3.gameState).toBe(GameState.WaitingForPlayers);
    expect(sayFn.mock.calls).toMatchInlineSnapshot(`
      [
        [
          {
            "text": "<@user1> Bought-in for 1000 chips",
          },
        ],
      ]
    `);
    sayFn.mockClear();

    // user2 buy-in
    await buyIn(env, contextUser2, { text: "buy in 1000" });
    const gameState5 = await getGameState(stub, workspaceId, channelId);

    expect(getPlayerById(gameState5, "user2")?.chips).toBe(1000);
    expect(getPlayerById(gameState5, "user1")?.chips).toBe(1000);
    expect(gameState5.gameState).toBe(GameState.WaitingForPlayers);
    expect(sayFn.mock.calls).toMatchInlineSnapshot(`
          [
            [
              {
                "text": "<@user2> Bought-in for 1000 chips",
              },
            ],
          ]
        `);
    sayFn.mockClear();

    // user2 re-join
    await joinGame(env, contextUser1);
    const gameState6 = await getGameState(stub, workspaceId, channelId);
    expect(gameState6.gameState).toBe(GameState.WaitingForPlayers);
    expect(sayFn.mock.calls).toMatchInlineSnapshot(`
      [
        [
          {
            "text": "<@user1> Welcome to the table!",
          },
        ],
      ]
    `);
    sayFn.mockClear();

    // valid deal
    await startRound(env, contextUser1, null);
    const gameState7 = await getGameState(stub, workspaceId, channelId);
    expect(gameState7.gameState).toBe(GameState.PreFlop);
    expect(gameState7.activePlayers.length).toBe(2);
    expect(gameState7.inactivePlayers.length).toBe(0);
    expect(sayFn.mock.calls).toMatchInlineSnapshot(`
      [
        [
          {
            "text": "Starting round with players: 
      <@user2> 1000 chips
      <@user1> 1000 chips

      <@user2> has the dealer button
      <@user1> posted small blind of 40
      <@user2> posted big blind of 80
      <@user1>'s turn!",
          },
        ],
      ]
    `);
    expect(postEphemeralFn.mock.calls).toMatchInlineSnapshot(`
      [
        [
          {
            "channel": "test-channel",
            "text": "<@user2> your cards:
      6:diamonds: 7:hearts:",
            "user": "user2",
          },
        ],
        [
          {
            "channel": "test-channel",
            "text": "<@user1> your cards:
      9:clubs: 8:diamonds:",
            "user": "user1",
          },
        ],
      ]
    `);
  });
});

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

function getPlayerById(
  gameState: ReturnType<TexasHoldem["toJson"]>,
  id: string
) {
  return [...gameState.activePlayers, ...gameState.inactivePlayers].find(
    (player) => player.id === id
  );
}

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
    return TexasHoldem.fromJson(JSON.parse(result.game as string)).toJson();
  });
}
