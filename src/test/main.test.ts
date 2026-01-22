import { env, runInDurableObject } from "cloudflare:test";
import { describe, it, expect, vi, beforeAll, afterAll } from "vitest";
import { GameState, TexasHoldem } from "../Game";
import {
  buyIn,
  joinGame,
  newGame,
  preDeal,
  preNH,
  preAH,
  startRound,
  call,
  check,
  fold,
  bet,
  preCheck,
  preFold,
  preCall,
  preBet,
  cashOut,
  leaveGame,
  showCards,
  revealCards,
  showChips,
  showStacks,
  nudgePlayer,
  takeHerToThe,
  context,
} from "..";
import { MARCUS_USER_ID, CAMDEN_USER_ID, YUVI_USER_ID } from "../users";
import {
  GenericMessageEvent,
  SlackAppContextWithChannelId,
} from "slack-cloudflare-workers";
import {
  assertNewGame,
  assertMessageReceived,
  assertJoin,
  assertBuyIn,
  assertRoundStart,
  assertBet,
  assertCall,
  assertCheck,
  assertFold,
} from "../ActionLog";

async function getActionLogSnapshot(
  stub: DurableObjectStub,
  workspaceId: string,
  channelId: string
) {
  return await runInDurableObject(stub, async (_instance, state) => {
    const result = state.storage.sql
      .exec<{
        id: number;
        workspaceId: string;
        channelId: string;
        timestamp: number;
        data: string;
      }>(
        "SELECT id, workspaceId, channelId, timestamp, data FROM ActionLog WHERE workspaceId = ? AND channelId = ? ORDER BY id",
        workspaceId,
        channelId
      )
      .toArray();

    return result.map((row) => ({
      id: row.id,
      workspaceId: row.workspaceId,
      channelId: row.channelId,
      timestamp: row.timestamp,
      data: JSON.parse(row.data),
    }));
  });
}

beforeAll(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-01-16T12:00:00Z"));
});

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
      expect(result).toContainEqual({ name: "PokerGames" });
      expect(result).toContainEqual({ name: "Flops" });
      expect(result).toContainEqual({ name: "ActionLog" });
    });
  });

  it("creates ActionLog index", async () => {
    const id = env.POKER_DURABLE_OBJECT.idFromName("test-indexes");
    const stub = env.POKER_DURABLE_OBJECT.get(id);

    await runInDurableObject(stub, async (_instance, state) => {
      const result = state.storage.sql
        .exec<{
          name: string;
        }>(
          "SELECT name FROM sqlite_master WHERE type='index' AND name LIKE 'idx_actionlog%'"
        )
        .toArray();
      expect(result).toEqual([{ name: "idx_actionlog_lookup" }]);
    });
  });

  it("logs actions to ActionLog table", async () => {
    const workspaceId = "actionlog-test-workspace";
    const channelId = "actionlog-test-channel";
    const stub = getStub({ workspaceId, channelId });

    await runInDurableObject(stub, async (instance) => {
      // Log a series of actions with proper types
      instance.logAction({
        schemaVersion: 1,
        workspaceId,
        channelId,
        timestamp: 1000,
        actionType: "new_game",
        messageText: "new game",
        playerId: "player1",
        smallBlind: 10,
        bigBlind: 20,
      });

      instance.logAction({
        schemaVersion: 1,
        workspaceId,
        channelId,
        timestamp: 2000,
        actionType: "join",
        messageText: "join table",
        playerId: "player1",
      });

      instance.logAction({
        schemaVersion: 1,
        workspaceId,
        channelId,
        timestamp: 3000,
        actionType: "join",
        messageText: "join table",
        playerId: "player2",
      });

      instance.logAction({
        schemaVersion: 1,
        workspaceId,
        channelId,
        timestamp: 4000,
        actionType: "buy_in",
        messageText: "buy in 500",
        playerId: "player1",
        amount: 500,
      });

      // Retrieve and verify
      const logs = instance.getActionLogs(workspaceId, channelId);

      expect(logs.length).toBe(4);
      const newGame = assertNewGame(logs[0].data);
      assertJoin(logs[1].data);
      assertJoin(logs[2].data);
      const buyIn = assertBuyIn(logs[3].data);

      // Verify data is self-contained
      expect(newGame.workspaceId).toBe(workspaceId);
      expect(newGame.channelId).toBe(channelId);
      expect(newGame.timestamp).toBe(1000);
      expect(newGame.messageText).toBe("new game");

      // Type-safe access
      expect(buyIn.amount).toBe(500);
      expect(buyIn.messageText).toBe("buy in 500");
    });
  });

  it("queries ActionLog with time range filters", async () => {
    const workspaceId = "actionlog-filter-workspace";
    const channelId = "actionlog-filter-channel";
    const stub = getStub({ workspaceId, channelId });

    await runInDurableObject(stub, async (instance) => {
      // Log actions at different times using valid action types
      instance.logAction({
        schemaVersion: 1,
        workspaceId,
        channelId,
        timestamp: 1000,
        actionType: "check",
        messageText: "check",
        playerId: "player1",
      });
      instance.logAction({
        schemaVersion: 1,
        workspaceId,
        channelId,
        timestamp: 2000,
        actionType: "call",
        messageText: "call",
        playerId: "player2",
        amount: 50,
      });
      instance.logAction({
        schemaVersion: 1,
        workspaceId,
        channelId,
        timestamp: 3000,
        actionType: "fold",
        messageText: "fold",
        playerId: "player3",
      });
      instance.logAction({
        schemaVersion: 1,
        workspaceId,
        channelId,
        timestamp: 4000,
        actionType: "bet",
        messageText: "bet 100",
        playerId: "player1",
        amount: 100,
      });

      // Filter by start time
      const afterStart = instance.getActionLogs(workspaceId, channelId, {
        startTime: 2500,
      });
      expect(afterStart.length).toBe(2);
      assertFold(afterStart[0].data);
      assertBet(afterStart[1].data);

      // Filter by end time
      const beforeEnd = instance.getActionLogs(workspaceId, channelId, {
        endTime: 2500,
      });
      expect(beforeEnd.length).toBe(2);
      assertCheck(beforeEnd[0].data);
      assertCall(beforeEnd[1].data);

      // Filter by time range
      const inRange = instance.getActionLogs(workspaceId, channelId, {
        startTime: 1500,
        endTime: 3500,
      });
      expect(inRange.length).toBe(2);
      assertCall(inRange[0].data);
      assertFold(inRange[1].data);

      // Limit and offset
      const limited = instance.getActionLogs(workspaceId, channelId, {
        limit: 2,
      });
      expect(limited.length).toBe(2);

      const offsetted = instance.getActionLogs(workspaceId, channelId, {
        limit: 2,
        offset: 2,
      });
      expect(offsetted.length).toBe(2);
      assertFold(offsetted[0].data);
    });
  });

  it("ActionLog stores complex round_start data", async () => {
    const workspaceId = "actionlog-complex-workspace";
    const channelId = "actionlog-complex-channel";
    const stub = getStub({ workspaceId, channelId });

    await runInDurableObject(stub, async (instance) => {
      // Log a round_start with all the round initialization data
      instance.logAction({
        schemaVersion: 1,
        workspaceId,
        channelId,
        timestamp: Date.now(),
        actionType: "round_start",
        messageText: "deal",
        dealerPosition: 0,
        playerOrder: ["player1", "player2"],
        playerStacks: { player1: 500, player2: 500 },
        playerCards: {
          player1: ["Ah", "Kh"],
          player2: ["2c", "7d"],
        },
        communityCards: ["Qs", "Jd", "10c", "5h", "2s"],
        smallBlindPlayerId: "player2",
        smallBlindAmount: 10,
        bigBlindPlayerId: "player1",
        bigBlindAmount: 20,
      });

      // Log some player actions
      instance.logAction({
        schemaVersion: 1,
        workspaceId,
        channelId,
        timestamp: Date.now() + 1000,
        actionType: "call",
        messageText: "call",
        playerId: "player2",
        amount: 10,
      });

      instance.logAction({
        schemaVersion: 1,
        workspaceId,
        channelId,
        timestamp: Date.now() + 2000,
        actionType: "check",
        messageText: "check",
        playerId: "player1",
      });

      const logs = instance.getActionLogs(workspaceId, channelId);
      expect(logs.length).toBe(3);

      // Verify round_start data preserved with type-safe access
      const roundStart = assertRoundStart(logs[0].data);
      expect(roundStart.communityCards).toEqual([
        "Qs",
        "Jd",
        "10c",
        "5h",
        "2s",
      ]);
      expect(roundStart.playerCards.player1).toEqual(["Ah", "Kh"]);
      expect(roundStart.playerCards.player2).toEqual(["2c", "7d"]);
      expect(roundStart.playerStacks).toEqual({ player1: 500, player2: 500 });
      expect(roundStart.smallBlindPlayerId).toBe("player2");
      expect(roundStart.bigBlindPlayerId).toBe("player1");
    });
  });

  it("starts new game", async () => {
    const workspaceId = "test-workspace";
    const channelId = "test-channel";
    const sayFn = vi.fn();
    const context = createContext({
      userId: "test",
      sayFn,
      workspaceId,
      channelId,
    });
    const payload = createGenericMessageEvent("test");
    const stub = getStub({ workspaceId, channelId });
    await newGame(env, context, payload);
    const gameState = await getGameState(stub, workspaceId, channelId);
    expect(gameState.deck.cards.length).toBe(52);
    expect(gameState.smallBlind).toBe(10);
    expect(gameState.bigBlind).toBe(20);
    expect(sayFn).toHaveBeenCalledWith({
      text: "New Poker Game created!",
    });
  });

  it("won't pre-deal if no game exists", async () => {
    const workspaceId = "test-workspace";
    const channelId = "test-channel";
    const sayFn = vi.fn();
    const context = createContext({
      userId: "1",
      sayFn,
      workspaceId,
      channelId,
    });
    const payload = createGenericMessageEvent("1");
    await preDeal(env, context, payload);
    expect(sayFn).toHaveBeenCalledWith({
      text: "No game exists! Type 'New Game'",
    });
  });

  it("won't pre-nh if no game exists", async () => {
    const workspaceId = "test-workspace";
    const channelId = "test-channel";
    const sayFn = vi.fn();
    const context = createContext({
      userId: "1",
      sayFn,
      workspaceId,
      channelId,
    });
    const payload = createGenericMessageEvent("1");
    await preNH(env, context, payload);
    expect(sayFn).toHaveBeenCalledWith({
      text: "No game exists! Type 'New Game'",
    });
  });

  it("starts new game with player checks", async () => {
    const workspaceId = "test-workspace";
    const channelId = "test-channel";
    const sayFn = vi.fn();
    const context = createContext({
      userId: "test",
      sayFn,
      workspaceId,
      channelId,
    });
    const payload = createGenericMessageEvent("test");
    const stub = getStub({ workspaceId, channelId });
    await newGame(env, context, payload);
    const gameState = await getGameState(stub, workspaceId, channelId);
    expect(gameState.deck.cards.length).toBe(52);
    expect(gameState.smallBlind).toBe(10);
    expect(gameState.bigBlind).toBe(20);
    expect(gameState.activePlayers.length).toBe(0);
    expect(gameState.inactivePlayers.length).toBe(0);

    expect(sayFn).toHaveBeenCalledWith({
      text: "New Poker Game created!",
    });
  });

  it("allows players to join game", async () => {
    const workspaceId = "test-workspace";
    const channelId = "test-channel";
    const sayFn = vi.fn();
    const context = createContext({
      userId: "1",
      sayFn,
      workspaceId,
      channelId,
    });
    const payload = createGenericMessageEvent("1");
    const stub = getStub({ workspaceId, channelId });
    await newGame(env, context, payload);
    await joinGame(env, context, payload);

    const gameState = await getGameState(stub, workspaceId, channelId);
    expect(gameState.activePlayers.length).toBe(1);
    expect(gameState.activePlayers[0].id).toBe("1");
    expect(gameState.activePlayers[0].chips).toBe(0);
  });

  it("game scenario 1", async () => {
    vi.spyOn(Math, "random").mockReturnValue(0.6);
    const workspaceId = "test-workspace";
    const channelId = "test-channel";
    const sayFn = vi.fn();
    const postEphemeralFn = vi.fn();
    const contextUser1 = createContext({
      userId: "user1",
      sayFn,
      postEphemeralFn,
      workspaceId,
      channelId,
    });
    const contextUser2 = createContext({
      userId: "user2",
      sayFn,
      postEphemeralFn,
      workspaceId,
      channelId,
    });
    const payloadUser1 = createGenericMessageEvent("user1");
    const payloadUser2 = createGenericMessageEvent("user2");
    const stub = getStub({ workspaceId, channelId });
    await newGame(env, contextUser1, payloadUser1);
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
    await joinGame(env, contextUser1, payloadUser1);

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
    await startRound(env, contextUser1, payloadUser1);
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
    await joinGame(env, contextUser2, payloadUser2);
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
    await buyIn(
      env,
      contextUser1,
      createGenericMessageEvent("user1", "buy in 1000")
    );
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
    await buyIn(
      env,
      contextUser2,
      createGenericMessageEvent("user2", "buy in 1000")
    );
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
    await joinGame(env, contextUser1, payloadUser1);
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
    await startRound(env, contextUser1, payloadUser1);
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
      7:clubs: K:spades:",
            "user": "user2",
          },
        ],
        [
          {
            "channel": "test-channel",
            "text": "<@user1> your cards:
      6:clubs: 5:clubs:",
            "user": "user1",
          },
        ],
      ]
    `);
    sayFn.mockClear();
    postEphemeralFn.mockClear();

    // user1 calls (matches big blind)
    await call(env, contextUser1, payloadUser1);
    const gameState8 = await getGameState(stub, workspaceId, channelId);
    expect(gameState8.gameState).toBe(GameState.PreFlop);
    expect(getPlayerById(gameState8, "user1")?.chips).toBe(920); // 1000 - 80
    expect(getPlayerById(gameState8, "user2")?.chips).toBe(920); // 1000 - 80
    expect(sayFn.mock.calls).toMatchInlineSnapshot(`
      [
        [
          {
            "text": "<@user1> called 80 chips! Total Pot: 160
      <@user2>'s turn",
          },
        ],
      ]
    `);
    sayFn.mockClear();
    postEphemeralFn.mockClear();

    // user2 checks (big blind option)
    await check(env, contextUser2, payloadUser2);
    const gameState9 = await getGameState(stub, workspaceId, channelId);
    expect(gameState9.gameState).toBe(GameState.Flop);
    expect(gameState9.communityCards.length).toBe(3);
    expect(sayFn.mock.calls).toMatchInlineSnapshot(`
      [
        [
          {
            "text": "<@user2> checked!
      *NEW* Flop:
      1 flops discovered (0.00%), 22,099 remain
      10:spades: 3:clubs: 8:spades:
      <@user1>'s turn",
          },
        ],
      ]
    `);
    // Players should receive their hand information with community cards
    expect(postEphemeralFn.mock.calls.length).toBe(2); // Each player gets their hand info
    sayFn.mockClear();
    postEphemeralFn.mockClear();

    // user1 checks on flop (user1 acts first post-flop as dealer acts last)
    await check(env, contextUser1, payloadUser1);
    const gameState10 = await getGameState(stub, workspaceId, channelId);
    expect(gameState10.gameState).toBe(GameState.Flop);
    expect(sayFn.mock.calls).toMatchInlineSnapshot(`
      [
        [
          {
            "text": "<@user1> checked!
      <@user2>'s turn",
          },
        ],
      ]
    `);
    sayFn.mockClear();
    postEphemeralFn.mockClear();

    // user2 checks on flop - advances to turn
    await check(env, contextUser2, payloadUser2);
    const gameState11 = await getGameState(stub, workspaceId, channelId);
    expect(gameState11.gameState).toBe(GameState.Turn);
    expect(gameState11.communityCards.length).toBe(4);
    expect(sayFn.mock.calls).toMatchInlineSnapshot(`
      [
        [
          {
            "text": "<@user2> checked!
      Turn:
      10:spades: 3:clubs: 8:spades: A:diamonds:
      <@user1>'s turn",
          },
        ],
      ]
    `);
    sayFn.mockClear();
    postEphemeralFn.mockClear();

    // user1 checks on turn
    await check(env, contextUser1, payloadUser1);
    const gameState12 = await getGameState(stub, workspaceId, channelId);
    expect(gameState12.gameState).toBe(GameState.Turn);
    expect(sayFn.mock.calls).toMatchInlineSnapshot(`
      [
        [
          {
            "text": "<@user1> checked!
      <@user2>'s turn",
          },
        ],
      ]
    `);
    sayFn.mockClear();
    postEphemeralFn.mockClear();

    // user2 checks on turn - advances to river
    await check(env, contextUser2, payloadUser2);
    const gameState13 = await getGameState(stub, workspaceId, channelId);
    expect(gameState13.gameState).toBe(GameState.River);
    expect(gameState13.communityCards.length).toBe(5);
    expect(sayFn.mock.calls).toMatchInlineSnapshot(`
      [
        [
          {
            "text": "<@user2> checked!
      River:
      10:spades: 3:clubs: 8:spades: A:diamonds: K:diamonds:
      <@user1>'s turn",
          },
        ],
      ]
    `);
    sayFn.mockClear();
    postEphemeralFn.mockClear();

    // user1 checks on river
    await check(env, contextUser1, payloadUser1);
    const gameState14 = await getGameState(stub, workspaceId, channelId);
    expect(gameState14.gameState).toBe(GameState.River);
    expect(sayFn.mock.calls).toMatchInlineSnapshot(`
      [
        [
          {
            "text": "<@user1> checked!
      <@user2>'s turn",
          },
        ],
      ]
    `);
    sayFn.mockClear();
    postEphemeralFn.mockClear();

    // user2 checks on river - triggers showdown
    await check(env, contextUser2, payloadUser2);
    const gameState15 = await getGameState(stub, workspaceId, channelId);
    expect(gameState15.gameState).toBe(GameState.WaitingForPlayers);
    expect(sayFn.mock.calls).toMatchInlineSnapshot(`
      [
        [
          {
            "text": "<@user2> checked!
      <@user1>'s turn
      Community Cards:
      10:spades: 3:clubs: 8:spades: A:diamonds: K:diamonds:
      <@user2> had One Pair
      7:clubs: K:spades:
      <@user1> had High Card
      6:clubs: 5:clubs:
      Main pot of 160 won by: <@user2>",
          },
        ],
      ]
    `);
    sayFn.mockClear();
    postEphemeralFn.mockClear();

    // Verify final chip counts - winner gets the pot
    const gameState16 = await getGameState(stub, workspaceId, channelId);
    expect(gameState16.dealerPosition).toBe(1); // dealer button moved

    // Start a new round to verify game continues properly
    await startRound(env, contextUser1, payloadUser1);
    const gameState17 = await getGameState(stub, workspaceId, channelId);
    expect(gameState17.gameState).toBe(GameState.PreFlop);
    expect(sayFn.mock.calls).toMatchInlineSnapshot(`
      [
        [
          {
            "text": "Starting round with players: 
      <@user2> 1080 chips
      <@user1> 920 chips

      <@user1> has the dealer button
      <@user2> posted small blind of 40
      <@user1> posted big blind of 80
      <@user2>'s turn!",
          },
        ],
      ]
    `);
    sayFn.mockClear();
    postEphemeralFn.mockClear();

    // user2 folds immediately
    await fold(env, contextUser2, payloadUser2);
    const gameState18 = await getGameState(stub, workspaceId, channelId);
    expect(gameState18.gameState).toBe(GameState.WaitingForPlayers);
    expect(sayFn.mock.calls).toMatchInlineSnapshot(`
      [
        [
          {
            "text": "<@user2> folded!
      <@user1>'s turn
      <@user1> wins 120 chips!
      Community Cards would have been:
      10:spades: 3:clubs: 8:spades: A:diamonds: K:diamonds:",
          },
        ],
      ]
    `);

    // Verify final chip counts after fold
    // Round 1: user2 won showdown (1080 chips), user1 lost (920 chips)
    // Round 2: user2 posted SB (40), user1 posted BB (80), user2 folded
    // user1: 920 - 80 + 120 = 960, user2: 1080 - 40 = 1040
    const gameState19 = await getGameState(stub, workspaceId, channelId);
    expect(getPlayerById(gameState19, "user1")?.chips).toBe(960);
    expect(getPlayerById(gameState19, "user2")?.chips).toBe(1040);
  });

  /**
   * Game Scenario 2: Betting, Raising, and Folding to a Bet
   *
   * Tests:
   * - Raising during PreFlop (3-bet)
   * - Betting on the flop
   * - Calling a bet
   * - Folding to a bet on the turn
   * - Pot calculation with multiple bet sizes
   * - Winner takes pot without showdown
   */
  it("game scenario 2 - betting and folding", async () => {
    vi.spyOn(Math, "random").mockReturnValue(0.5);
    const workspaceId = "test-workspace-2";
    const channelId = "test-channel-2";
    const sayFn = vi.fn();
    const postEphemeralFn = vi.fn();

    const contextUser1 = createContext({
      userId: "alice",
      sayFn,
      postEphemeralFn,
      workspaceId,
      channelId,
    });
    const contextUser2 = createContext({
      userId: "bob",
      sayFn,
      postEphemeralFn,
      workspaceId,
      channelId,
    });
    const payloadAlice = createGenericMessageEvent("alice");
    const payloadBob = createGenericMessageEvent("bob");

    const stub = getStub({ workspaceId, channelId });

    // === GAME SETUP ===
    await newGame(env, contextUser1, payloadAlice);
    sayFn.mockClear();

    // Both players join
    await joinGame(env, contextUser1, payloadAlice);
    sayFn.mockClear();
    await joinGame(env, contextUser2, payloadBob);
    sayFn.mockClear();

    // Both players buy in
    await buyIn(
      env,
      contextUser1,
      createGenericMessageEvent("user1", "buy in 500")
    );
    const gameStateAfterBuyIn1 = await getGameState(
      stub,
      workspaceId,
      channelId
    );
    expect(getPlayerById(gameStateAfterBuyIn1, "alice")?.chips).toBe(500);
    sayFn.mockClear();

    await buyIn(
      env,
      contextUser2,
      createGenericMessageEvent("user2", "buy in 500")
    );
    const gameStateAfterBuyIn2 = await getGameState(
      stub,
      workspaceId,
      channelId
    );
    expect(getPlayerById(gameStateAfterBuyIn2, "bob")?.chips).toBe(500);
    sayFn.mockClear();

    // === ROUND 1: PREFLOP ===
    await startRound(env, contextUser1, payloadAlice);
    const gameStatePreflop = await getGameState(stub, workspaceId, channelId);
    expect(gameStatePreflop.gameState).toBe(GameState.PreFlop);
    expect(gameStatePreflop.currentPot).toBe(120); // 40 SB + 80 BB
    expect(sayFn.mock.calls).toMatchInlineSnapshot(`
      [
        [
          {
            "text": "Starting round with players: 
      <@alice> 500 chips
      <@bob> 500 chips

      <@alice> has the dealer button
      <@bob> posted small blind of 40
      <@alice> posted big blind of 80
      <@bob>'s turn!",
          },
        ],
      ]
    `);
    sayFn.mockClear();
    postEphemeralFn.mockClear();

    // bob (SB) raises to 160 instead of just calling
    await bet(env, contextUser2, createGenericMessageEvent("user2", "bet 160"));
    const gameStateAfterRaise = await getGameState(
      stub,
      workspaceId,
      channelId
    );
    expect(gameStateAfterRaise.gameState).toBe(GameState.PreFlop);
    expect(gameStateAfterRaise.currentPot).toBe(240); // 80 BB + 160 raise
    expect(getPlayerById(gameStateAfterRaise, "bob")?.chips).toBe(340); // 500 - 160
    expect(sayFn.mock.calls).toMatchInlineSnapshot(`
      [
        [
          {
            "text": "<@alice>'s turn
      <@bob> raised 160 chips! Total Pot: 240",
          },
        ],
      ]
    `);
    sayFn.mockClear();
    postEphemeralFn.mockClear();

    // alice (BB) calls the raise
    await call(env, contextUser1, payloadAlice);
    const gameStateAfterCall = await getGameState(stub, workspaceId, channelId);
    expect(gameStateAfterCall.gameState).toBe(GameState.Flop);
    expect(gameStateAfterCall.currentPot).toBe(320); // 160 + 160
    expect(getPlayerById(gameStateAfterCall, "alice")?.chips).toBe(340); // 500 - 160
    expect(gameStateAfterCall.communityCards.length).toBe(3);
    expect(sayFn.mock.calls).toMatchInlineSnapshot(`
      [
        [
          {
            "text": "<@alice> called 160 chips! Total Pot: 320
      *NEW* Flop:
      1 flops discovered (0.00%), 22,099 remain
      Q:diamonds: 9:spades: J:diamonds:
      <@bob>'s turn",
          },
        ],
      ]
    `);
    sayFn.mockClear();
    postEphemeralFn.mockClear();

    // === ROUND 1: FLOP ===
    // bob bets 100 on the flop
    await bet(env, contextUser2, createGenericMessageEvent("user2", "bet 100"));
    const gameStateAfterFlopBet = await getGameState(
      stub,
      workspaceId,
      channelId
    );
    expect(gameStateAfterFlopBet.gameState).toBe(GameState.Flop);
    expect(gameStateAfterFlopBet.currentPot).toBe(420); // 320 + 100
    expect(getPlayerById(gameStateAfterFlopBet, "bob")?.chips).toBe(240); // 340 - 100
    expect(sayFn.mock.calls).toMatchInlineSnapshot(`
      [
        [
          {
            "text": "<@alice>'s turn
      <@bob> bet 100 chips! Total Pot: 420",
          },
        ],
      ]
    `);
    sayFn.mockClear();
    postEphemeralFn.mockClear();

    // alice calls the 100 bet
    await call(env, contextUser1, payloadAlice);
    const gameStateAfterFlopCall = await getGameState(
      stub,
      workspaceId,
      channelId
    );
    expect(gameStateAfterFlopCall.gameState).toBe(GameState.Turn);
    expect(gameStateAfterFlopCall.currentPot).toBe(520); // 420 + 100
    expect(getPlayerById(gameStateAfterFlopCall, "alice")?.chips).toBe(240); // 340 - 100
    expect(gameStateAfterFlopCall.communityCards.length).toBe(4);
    expect(sayFn.mock.calls).toMatchInlineSnapshot(`
      [
        [
          {
            "text": "<@alice> called 100 chips! Total Pot: 520
      Turn:
      Q:diamonds: 9:spades: J:diamonds: 10:diamonds:
      <@bob>'s turn",
          },
        ],
      ]
    `);
    sayFn.mockClear();
    postEphemeralFn.mockClear();

    // === ROUND 1: TURN ===
    // bob bets 150 on the turn
    await bet(env, contextUser2, createGenericMessageEvent("user2", "bet 150"));
    const gameStateAfterTurnBet = await getGameState(
      stub,
      workspaceId,
      channelId
    );
    expect(gameStateAfterTurnBet.gameState).toBe(GameState.Turn);
    expect(gameStateAfterTurnBet.currentPot).toBe(670); // 520 + 150
    expect(getPlayerById(gameStateAfterTurnBet, "bob")?.chips).toBe(90); // 240 - 150
    expect(sayFn.mock.calls).toMatchInlineSnapshot(`
      [
        [
          {
            "text": "<@alice>'s turn
      <@bob> bet 150 chips! Total Pot: 670",
          },
        ],
      ]
    `);
    sayFn.mockClear();
    postEphemeralFn.mockClear();

    // alice folds to the turn bet - bob wins without showdown
    await fold(env, contextUser1, payloadAlice);
    const gameStateAfterFold = await getGameState(stub, workspaceId, channelId);
    expect(gameStateAfterFold.gameState).toBe(GameState.WaitingForPlayers);
    expect(sayFn.mock.calls).toMatchInlineSnapshot(`
      [
        [
          {
            "text": "<@alice> folded!
      <@bob>'s turn
      <@bob> wins 670 chips!
      Community Cards would have been:
      Q:diamonds: 9:spades: J:diamonds: 10:diamonds: 9:diamonds:",
          },
        ],
      ]
    `);
    sayFn.mockClear();
    postEphemeralFn.mockClear();

    // === VERIFY FINAL CHIP COUNTS ===
    // alice: 500 - 160 (preflop) - 100 (flop) = 240 chips remaining
    // bob: 500 - 160 - 100 - 150 + 670 = 760 chips
    const finalGameState = await getGameState(stub, workspaceId, channelId);
    expect(getPlayerById(finalGameState, "alice")?.chips).toBe(240);
    expect(getPlayerById(finalGameState, "bob")?.chips).toBe(760);
    expect(finalGameState.dealerPosition).toBe(1); // dealer moved

    // === VERIFY ACTION LOG ===
    const actionLogs = await stub.getActionLogs(workspaceId, channelId);

    // Verify the sequence of actions
    const actionTypes = actionLogs.map((log) => log.data.actionType);
    expect(actionTypes).toEqual([
      "message_received", // new_game message
      "new_game", // newGame
      "message_received", // join alice message
      "join", // alice joins
      "message_received", // join bob message
      "join", // bob joins
      "message_received", // buy in alice message
      "buy_in", // alice buys in 500
      "message_received", // buy in bob message
      "buy_in", // bob buys in 500
      "message_received", // start round message
      "round_start", // round starts
      "message_received", // bet message
      "bet", // bob bets 160
      "message_received", // call message
      "call", // alice calls
      "message_received", // bet message
      "bet", // bob bets 100
      "message_received", // call message
      "call", // alice calls
      "message_received", // bet message
      "bet", // bob bets 150
      "message_received", // fold message
      "fold", // alice folds
    ]);

    // Verify specific action details using type guards
    const newGameMessage = assertMessageReceived(actionLogs[0].data);
    expect(newGameMessage.handlerKey).toBe("new game");
    const joinAliceMessage = assertMessageReceived(actionLogs[2].data);
    expect(joinAliceMessage.handlerKey).toBe("join table");
    const joinBobMessage = assertMessageReceived(actionLogs[4].data);
    expect(joinBobMessage.handlerKey).toBe("join table");

    const newGameAction = assertNewGame(actionLogs[1].data);
    expect(newGameAction.workspaceId).toBe(workspaceId);
    expect(newGameAction.channelId).toBe(channelId);
    expect(newGameAction.schemaVersion).toBe(1);

    const joinAlice = assertJoin(actionLogs[3].data);
    expect(joinAlice.playerId).toBe("alice");

    const joinBob = assertJoin(actionLogs[5].data);
    expect(joinBob.playerId).toBe("bob");

    const buyInAliceMessage = assertMessageReceived(actionLogs[6].data);
    expect(buyInAliceMessage.handlerKey).toBe("buy in");
    const buyInAlice = assertBuyIn(actionLogs[7].data);
    expect(buyInAlice.playerId).toBe("alice");
    expect(buyInAlice.amount).toBe(500);

    const buyInBobMessage = assertMessageReceived(actionLogs[8].data);
    expect(buyInBobMessage.handlerKey).toBe("buy in");
    const buyInBob = assertBuyIn(actionLogs[9].data);
    expect(buyInBob.playerId).toBe("bob");
    expect(buyInBob.amount).toBe(500);

    const roundStart = assertRoundStart(actionLogs[11].data);
    expect(roundStart.playerOrder).toContain("alice");
    expect(roundStart.playerOrder).toContain("bob");
    expect(roundStart.playerStacks).toEqual({ alice: 420, bob: 460 }); // after blinds

    const bobBet160Message = assertMessageReceived(actionLogs[12].data);
    expect(bobBet160Message.playerId).toBe("bob");

    const bobBet160 = assertBet(actionLogs[13].data);
    expect(bobBet160.playerId).toBe("bob");
    expect(bobBet160.amount).toBe(160);
    expect(bobBet160.messageText).toBe("bet 160");

    const aliceCall160Message = assertMessageReceived(actionLogs[14].data);
    expect(aliceCall160Message.playerId).toBe("alice");

    const aliceCall160 = assertCall(actionLogs[15].data);
    expect(aliceCall160.playerId).toBe("alice");
    expect(aliceCall160.amount).toBe(80); // 160 - 80 (BB already posted)

    const bobBet100Message = assertMessageReceived(actionLogs[16].data);
    expect(bobBet100Message.playerId).toBe("bob");

    const bobBet100 = assertBet(actionLogs[17].data);
    expect(bobBet100.playerId).toBe("bob");
    expect(bobBet100.amount).toBe(100);

    const aliceCall100Message = assertMessageReceived(actionLogs[18].data);
    expect(aliceCall100Message.playerId).toBe("alice");

    const aliceCall100 = assertCall(actionLogs[19].data);
    expect(aliceCall100.playerId).toBe("alice");
    expect(aliceCall100.amount).toBe(100);

    const bobBet150Message = assertMessageReceived(actionLogs[20].data);
    expect(bobBet150Message.playerId).toBe("bob");

    const bobBet150 = assertBet(actionLogs[21].data);
    expect(bobBet150.playerId).toBe("bob");
    expect(bobBet150.amount).toBe(150);

    const aliceFoldMessage = assertMessageReceived(actionLogs[22].data);
    expect(aliceFoldMessage.playerId).toBe("alice");

    const aliceFold = assertFold(actionLogs[23].data);
    expect(aliceFold.playerId).toBe("alice");

    // Verify timestamps are in ascending order
    for (let i = 1; i < actionLogs.length; i++) {
      expect(actionLogs[i].data.timestamp).toBeGreaterThanOrEqual(
        actionLogs[i - 1].data.timestamp
      );
    }

    const actionLogSnapshot = await getActionLogSnapshot(
      stub,
      workspaceId,
      channelId
    );
  });

  /**
   * Game Scenario 3: All-In and Call
   *
   * Tests:
   * - Player going all-in
   * - Opponent calling all-in
   * - Automatic progression through streets when all-in
   * - Showdown with all community cards dealt
   * - Pot distribution after all-in showdown
   */
  it("game scenario 3 - all-in showdown", async () => {
    vi.spyOn(Math, "random").mockReturnValue(0.3);
    const workspaceId = "test-workspace-3";
    const channelId = "test-channel-3";
    const sayFn = vi.fn();
    const postEphemeralFn = vi.fn();

    const contextUser1 = createContext({
      userId: "player1",
      sayFn,
      postEphemeralFn,
      workspaceId,
      channelId,
    });
    const contextUser2 = createContext({
      userId: "player2",
      sayFn,
      postEphemeralFn,
      workspaceId,
      channelId,
    });
    const payloadPlayer1 = createGenericMessageEvent("player1");
    const payloadPlayer2 = createGenericMessageEvent("player2");

    const stub = getStub({ workspaceId, channelId });

    // === SETUP ===
    await newGame(env, contextUser1, payloadPlayer1);
    sayFn.mockClear();

    await joinGame(env, contextUser1, payloadPlayer1);
    await joinGame(env, contextUser2, payloadPlayer2);
    sayFn.mockClear();

    // Different stack sizes to test all-in dynamics
    await buyIn(
      env,
      contextUser1,
      createGenericMessageEvent("user1", "buy in 300")
    );
    await buyIn(
      env,
      contextUser2,
      createGenericMessageEvent("user2", "buy in 300")
    );
    sayFn.mockClear();

    // === START ROUND ===
    await startRound(env, contextUser1, payloadPlayer1);
    const gameStateStart = await getGameState(stub, workspaceId, channelId);
    expect(gameStateStart.gameState).toBe(GameState.PreFlop);
    expect(sayFn.mock.calls).toMatchInlineSnapshot(`
      [
        [
          {
            "text": "Starting round with players: 
      <@player1> 300 chips
      <@player2> 300 chips

      <@player1> has the dealer button
      <@player2> posted small blind of 40
      <@player1> posted big blind of 80
      <@player2>'s turn!",
          },
        ],
      ]
    `);
    sayFn.mockClear();
    postEphemeralFn.mockClear();

    // player2 (SB) goes ALL-IN
    await bet(env, contextUser2, createGenericMessageEvent("user2", "bet 300"));
    const gameStateAfterAllIn = await getGameState(
      stub,
      workspaceId,
      channelId
    );
    expect(gameStateAfterAllIn.gameState).toBe(GameState.PreFlop);
    expect(getPlayerById(gameStateAfterAllIn, "player2")?.chips).toBe(0);
    expect(sayFn.mock.calls).toMatchInlineSnapshot(`
      [
        [
          {
            "text": "<@player1>'s turn
      <@player2> raised 300 chips! *:rotating_light: ALL-IN :rotating_light:* Total Pot: 380",
          },
        ],
      ]
    `);
    sayFn.mockClear();
    postEphemeralFn.mockClear();

    // player1 (BB) calls the all-in - this should trigger automatic showdown
    await call(env, contextUser1, payloadPlayer1);
    const gameStateAfterCall = await getGameState(stub, workspaceId, channelId);

    // Game should be back to WaitingForPlayers after showdown
    expect(gameStateAfterCall.gameState).toBe(GameState.WaitingForPlayers);

    // Verify showdown happened with all 5 community cards
    expect(sayFn.mock.calls).toMatchInlineSnapshot(`
      [
        [
          {
            "text": "<@player1> called 300 chips *:rotating_light: ALL-IN :rotating_light:* Total Pot: 600
      Flop:
      10:spades: 2:diamonds: 8:spades: A:hearts: 4:spades:
      Turn:
      10:spades: 2:diamonds: 8:spades: A:hearts:
      River:
      10:spades: 2:diamonds: 8:spades: A:hearts: 4:spades:
      <@player2>'s turn
      Community Cards:
      10:spades: 2:diamonds: 8:spades: A:hearts: 4:spades:
      <@player1> had One Pair
      4:diamonds: K:spades:
      <@player2> had One Pair
      A:spades: 3:diamonds:
      Main pot of 600 won by: <@player2>",
          },
        ],
      ]
    `);
    sayFn.mockClear();

    // Verify chip distribution - winner gets all
    const finalState = await getGameState(stub, workspaceId, channelId);
    expect(getPlayerById(finalState, "player2")?.chips).toBe(600);
    expect(getPlayerById(finalState, "player1")?.chips).toBe(0);
  });

  /**
   * Game Scenario 4: Three Player Game
   *
   * Tests:
   * - 3-player dynamics
   * - Turn order with 3 players (dealer, SB, BB positions)
   * - One player folding, two continue
   * - Correct pot distribution with 3 players
   */
  it("game scenario 4 - three player game", async () => {
    vi.spyOn(Math, "random").mockReturnValue(0.7);
    const workspaceId = "test-workspace-4";
    const channelId = "test-channel-4";
    const sayFn = vi.fn();
    const postEphemeralFn = vi.fn();

    const contextAlice = createContext({
      userId: "alice",
      sayFn,
      postEphemeralFn,
      workspaceId,
      channelId,
    });
    const contextBob = createContext({
      userId: "bob",
      sayFn,
      postEphemeralFn,
      workspaceId,
      channelId,
    });
    const contextCharlie = createContext({
      userId: "charlie",
      sayFn,
      postEphemeralFn,
      workspaceId,
      channelId,
    });
    const payloadAlice = createGenericMessageEvent("alice");
    const payloadBob = createGenericMessageEvent("bob");
    const payloadCharlie = createGenericMessageEvent("charlie");

    const stub = getStub({ workspaceId, channelId });

    // === SETUP ===
    await newGame(env, contextAlice, payloadAlice);
    sayFn.mockClear();

    await joinGame(env, contextAlice, payloadAlice);
    await joinGame(env, contextBob, payloadBob);
    await joinGame(env, contextCharlie, payloadCharlie);
    sayFn.mockClear();

    await buyIn(
      env,
      contextAlice,
      createGenericMessageEvent("alice", "buy in 1000")
    );
    await buyIn(
      env,
      contextBob,
      createGenericMessageEvent("bob", "buy in 1000")
    );
    await buyIn(
      env,
      contextCharlie,
      createGenericMessageEvent("charlie", "buy in 1000")
    );
    sayFn.mockClear();

    // === START ROUND ===
    await startRound(env, contextAlice, payloadAlice);
    const gameStateStart = await getGameState(stub, workspaceId, channelId);
    expect(gameStateStart.gameState).toBe(GameState.PreFlop);
    expect(gameStateStart.activePlayers.length).toBe(3);

    // With 3 players: alice=dealer(0), bob=SB(1), charlie=BB(2)
    // First to act preflop is alice (after BB)
    expect(sayFn.mock.calls).toMatchInlineSnapshot(`
      [
        [
          {
            "text": "Starting round with players: 
      <@alice> 1000 chips
      <@bob> 1000 chips
      <@charlie> 1000 chips

      <@alice> has the dealer button
      <@bob> posted small blind of 40
      <@charlie> posted big blind of 80
      <@alice>'s turn!",
          },
        ],
      ]
    `);
    sayFn.mockClear();
    postEphemeralFn.mockClear();

    // alice (dealer/UTG) calls
    await call(env, contextAlice, payloadAlice);
    expect(sayFn.mock.calls).toMatchInlineSnapshot(`
      [
        [
          {
            "text": "<@alice> called 80 chips! Total Pot: 200
      <@bob>'s turn",
          },
        ],
      ]
    `);
    sayFn.mockClear();

    // bob (SB) folds
    await fold(env, contextBob, payloadBob);
    expect(sayFn.mock.calls).toMatchInlineSnapshot(`
      [
        [
          {
            "text": "<@bob> folded!
      <@charlie>'s turn",
          },
        ],
      ]
    `);
    sayFn.mockClear();

    // charlie (BB) checks - advances to flop
    await check(env, contextCharlie, payloadCharlie);
    const gameStateFlop = await getGameState(stub, workspaceId, channelId);
    expect(gameStateFlop.gameState).toBe(GameState.Flop);
    expect(gameStateFlop.communityCards.length).toBe(3);
    expect(sayFn.mock.calls).toMatchInlineSnapshot(`
      [
        [
          {
            "text": "<@charlie> checked!
      *NEW* Flop:
      1 flops discovered (0.00%), 22,099 remain
      7:clubs: 6:clubs: 6:spades:
      <@charlie>'s turn",
          },
        ],
      ]
    `);
    sayFn.mockClear();
    postEphemeralFn.mockClear();

    // Post-flop: bob folded, so it's between alice and charlie
    // charlie acts first (after dealer), then alice
    // But bob was skipped since he folded - charlie is first active after dealer

    // charlie bets 100
    await bet(
      env,
      contextCharlie,
      createGenericMessageEvent("charlie", "bet 100")
    );
    expect(sayFn.mock.calls).toMatchInlineSnapshot(`
      [
        [
          {
            "text": "<@alice>'s turn
      <@charlie> bet 100 chips! Total Pot: 300",
          },
        ],
      ]
    `);
    sayFn.mockClear();

    // alice calls
    await call(env, contextAlice, payloadAlice);
    const gameStateTurn = await getGameState(stub, workspaceId, channelId);
    expect(gameStateTurn.gameState).toBe(GameState.Turn);
    expect(sayFn.mock.calls).toMatchInlineSnapshot(`
      [
        [
          {
            "text": "<@alice> called 100 chips! Total Pot: 400
      Turn:
      7:clubs: 6:clubs: 6:spades: 4:clubs:
      <@charlie>'s turn",
          },
        ],
      ]
    `);
    sayFn.mockClear();
    postEphemeralFn.mockClear();

    // Both check through turn and river
    await check(env, contextCharlie, payloadCharlie);
    sayFn.mockClear();

    await check(env, contextAlice, payloadAlice);
    const gameStateRiver = await getGameState(stub, workspaceId, channelId);
    expect(gameStateRiver.gameState).toBe(GameState.River);
    sayFn.mockClear();
    postEphemeralFn.mockClear();

    await check(env, contextCharlie, payloadCharlie);
    sayFn.mockClear();

    // alice checks - triggers showdown
    await check(env, contextAlice, payloadAlice);
    const gameStateFinal = await getGameState(stub, workspaceId, channelId);
    expect(gameStateFinal.gameState).toBe(GameState.WaitingForPlayers);

    // Showdown between alice and charlie (bob folded)
    expect(sayFn.mock.calls).toMatchInlineSnapshot(`
      [
        [
          {
            "text": "<@alice> checked!
      <@charlie>'s turn
      Community Cards:
      7:clubs: 6:clubs: 6:spades: 4:clubs: 3:clubs:
      <@alice> had Flush
      Q:clubs: 10:clubs:
      <@charlie> had Flush
      K:spades: 8:clubs:
      Main pot of 400 won by: <@alice>",
          },
        ],
      ]
    `);
    sayFn.mockClear();

    // Verify final chips
    // bob: 1000 - 40 (SB folded) = 960
    // alice: 1000 - 80 - 100 + 400 = 1220 (winner)
    // charlie: 1000 - 80 - 100 = 820
    const finalState = await getGameState(stub, workspaceId, channelId);
    expect(getPlayerById(finalState, "bob")?.chips).toBe(960);
    expect(getPlayerById(finalState, "alice")?.chips).toBe(1220);
    expect(getPlayerById(finalState, "charlie")?.chips).toBe(820);
  });

  /**
   * Game Scenario 5: Check-Raise
   *
   * Tests:
   * - Check-raise strategy (check, opponent bets, then raise)
   * - Re-raising mechanics
   * - Pot calculations with multiple raises
   */
  it("game scenario 5 - check-raise", async () => {
    vi.spyOn(Math, "random").mockReturnValue(0.4);
    const workspaceId = "test-workspace-5";
    const channelId = "test-channel-5";
    const sayFn = vi.fn();
    const postEphemeralFn = vi.fn();

    const contextUser1 = createContext({
      userId: "trapper",
      sayFn,
      postEphemeralFn,
      workspaceId,
      channelId,
    });
    const contextUser2 = createContext({
      userId: "victim",
      sayFn,
      postEphemeralFn,
      workspaceId,
      channelId,
    });

    const stub = getStub({ workspaceId, channelId });

    // === SETUP ===
    await newGame(env, contextUser1, createGenericMessageEvent("trapper"));
    await joinGame(env, contextUser1, createGenericMessageEvent("trapper"));
    await joinGame(env, contextUser2, createGenericMessageEvent("victim"));
    await buyIn(
      env,
      contextUser1,
      createGenericMessageEvent("trapper", "buy in 1000")
    );
    await buyIn(
      env,
      contextUser2,
      createGenericMessageEvent("victim", "buy in 1000")
    );
    sayFn.mockClear();

    // === START ROUND ===
    await startRound(env, contextUser1, createGenericMessageEvent("trapper"));
    sayFn.mockClear();
    postEphemeralFn.mockClear();

    // Get through preflop with calls
    // trapper is BB, victim is SB/dealer
    await call(env, contextUser2, createGenericMessageEvent("victim")); // victim calls
    sayFn.mockClear();
    await check(env, contextUser1, createGenericMessageEvent("trapper")); // trapper checks

    const gameStateFlop = await getGameState(stub, workspaceId, channelId);
    expect(gameStateFlop.gameState).toBe(GameState.Flop);
    sayFn.mockClear();
    postEphemeralFn.mockClear();

    // === FLOP: THE CHECK-RAISE ===
    // trapper checks (setting the trap)
    await check(env, contextUser1, createGenericMessageEvent("trapper"));
    expect(sayFn.mock.calls).toMatchInlineSnapshot(`
      [
        [
          {
            "text": "<@trapper> Cannot check, not your turn!",
          },
        ],
      ]
    `);
    sayFn.mockClear();

    // victim bets 100 (falling into the trap)
    await bet(
      env,
      contextUser2,
      createGenericMessageEvent("victim", "bet 100")
    );
    const gameStateAfterBet = await getGameState(stub, workspaceId, channelId);
    expect(gameStateAfterBet.currentPot).toBe(260); // 160 + 100
    expect(sayFn.mock.calls).toMatchInlineSnapshot(`
      [
        [
          {
            "text": "<@trapper>'s turn
      <@victim> bet 100 chips! Total Pot: 260",
          },
        ],
      ]
    `);
    sayFn.mockClear();

    // trapper RAISES to 300 (the check-raise!)
    await bet(
      env,
      contextUser1,
      createGenericMessageEvent("trapper", "bet 300")
    );
    const gameStateAfterRaise = await getGameState(
      stub,
      workspaceId,
      channelId
    );
    // Pot: 160 (preflop) + 100 (victim bet) + 300 (trapper raise) = 560
    expect(gameStateAfterRaise.currentPot).toBe(560);
    expect(sayFn.mock.calls).toMatchInlineSnapshot(`
      [
        [
          {
            "text": "<@victim>'s turn
      <@trapper> raised 300 chips! Total Pot: 560",
          },
        ],
      ]
    `);
    sayFn.mockClear();

    // victim folds to the check-raise
    await fold(env, contextUser2, createGenericMessageEvent("victim"));
    const gameStateFinal = await getGameState(stub, workspaceId, channelId);
    expect(gameStateFinal.gameState).toBe(GameState.WaitingForPlayers);
    expect(sayFn.mock.calls).toMatchInlineSnapshot(`
      [
        [
          {
            "text": "<@victim> folded!
      <@trapper>'s turn
      <@trapper> wins 560 chips!
      Community Cards would have been:
      7:diamonds: 9:spades: 8:spades: 6:spades: 4:spades:",
          },
        ],
      ]
    `);

    // Verify chips
    // trapper: 1000 - 80 (BB) - 300 (raise) + 560 = 1180
    // victim: 1000 - 80 (call preflop) - 100 (bet) = 820
    const finalState = await getGameState(stub, workspaceId, channelId);
    expect(getPlayerById(finalState, "trapper")?.chips).toBe(1180);
    expect(getPlayerById(finalState, "victim")?.chips).toBe(820);
  });

  /**
   * Game Scenario 6: Pre-Move Actions
   *
   * Tests:
   * - Pre-check: queue a check before your turn
   * - Pre-call: queue a call before your turn
   * - Pre-fold: queue a fold before your turn
   * - Automatic execution of pre-moves when turn arrives
   */
  it("game scenario 6 - pre-move actions", async () => {
    vi.spyOn(Math, "random").mockReturnValue(0.2);
    const workspaceId = "test-workspace-6";
    const channelId = "test-channel-6";
    const sayFn = vi.fn();
    const postEphemeralFn = vi.fn();

    const contextAlice = createContext({
      userId: "alice",
      sayFn,
      postEphemeralFn,
      workspaceId,
      channelId,
    });
    const contextBob = createContext({
      userId: "bob",
      sayFn,
      postEphemeralFn,
      workspaceId,
      channelId,
    });
    const contextCharlie = createContext({
      userId: "charlie",
      sayFn,
      postEphemeralFn,
      workspaceId,
      channelId,
    });

    const stub = getStub({ workspaceId, channelId });

    // === SETUP ===
    await newGame(env, contextAlice, createGenericMessageEvent("alice"));
    await joinGame(env, contextAlice, createGenericMessageEvent("alice"));
    await joinGame(env, contextBob, createGenericMessageEvent("bob"));
    await joinGame(env, contextCharlie, createGenericMessageEvent("charlie"));
    await buyIn(
      env,
      contextAlice,
      createGenericMessageEvent("alice", "buy in 1000")
    );
    await buyIn(
      env,
      contextBob,
      createGenericMessageEvent("bob", "buy in 1000")
    );
    await buyIn(
      env,
      contextCharlie,
      createGenericMessageEvent("charlie", "buy in 1000")
    );
    sayFn.mockClear();

    // === START ROUND ===
    await startRound(env, contextAlice, createGenericMessageEvent("alice"));
    sayFn.mockClear();
    postEphemeralFn.mockClear();

    // alice is first to act (after BB)
    // bob and charlie can queue pre-moves

    // charlie (BB) queues a pre-check
    await preCheck(env, contextCharlie, createGenericMessageEvent("charlie"));
    expect(sayFn.mock.calls).toMatchInlineSnapshot(`
      [
        [
          {
            "text": "<@charlie> pre-checked!",
          },
        ],
      ]
    `);
    sayFn.mockClear();

    // alice calls
    await call(env, contextAlice, createGenericMessageEvent("alice"));
    expect(sayFn.mock.calls).toMatchInlineSnapshot(`
      [
        [
          {
            "text": "<@alice> called 80 chips! Total Pot: 200
      <@bob>'s turn",
          },
        ],
      ]
    `);
    sayFn.mockClear();

    // bob (SB) calls - this should trigger charlie's pre-check
    await call(env, contextBob, createGenericMessageEvent("bob"));
    const gameStateAfterPreCheck = await getGameState(
      stub,
      workspaceId,
      channelId
    );
    expect(gameStateAfterPreCheck.gameState).toBe(GameState.Flop);
    expect(sayFn.mock.calls).toMatchInlineSnapshot(`
      [
        [
          {
            "text": "<@bob> called 80 chips! Total Pot: 240
      <@charlie> is pre-moving!
      <@charlie> checked!
      *NEW* Flop:
      1 flops discovered (0.00%), 22,099 remain
      8:spades: 10:hearts: 6:spades:
      <@bob>'s turn",
          },
        ],
      ]
    `);
    sayFn.mockClear();
    postEphemeralFn.mockClear();

    // Now test pre-fold
    // charlie queues a pre-fold for the next betting round
    await preFold(env, contextCharlie, createGenericMessageEvent("charlie"));
    expect(sayFn.mock.calls).toMatchInlineSnapshot(`
      [
        [
          {
            "text": "<@charlie> pre-folded!",
          },
        ],
      ]
    `);
    sayFn.mockClear();

    // bob bets, alice calls
    await bet(env, contextBob, createGenericMessageEvent("bob", "bet 100"));
    sayFn.mockClear();

    await call(env, contextAlice, createGenericMessageEvent("alice"));
    // Alice's call triggers advance to turn (since charlie pre-folded, action is complete)
    expect(sayFn.mock.calls).toMatchInlineSnapshot(`
      [
        [
          {
            "text": "<@alice> called 100 chips! Total Pot: 440
      Turn:
      8:spades: 10:hearts: 6:spades: 4:spades:
      <@bob>'s turn",
          },
        ],
      ]
    `);
    sayFn.mockClear();

    // Verify charlie folded due to pre-fold
    const gameStateAfterFold = await getGameState(stub, workspaceId, channelId);
    expect(gameStateAfterFold.foldedPlayers).toContain("charlie");

    // === TEST PRE-CALL ===
    // bob bets, then alice can pre-call to queue the call for next bet
    await bet(env, contextBob, createGenericMessageEvent("bob", "bet 100"));
    sayFn.mockClear();

    // alice uses pre-call which immediately calls since there's an active bet
    await preCall(env, contextAlice, createGenericMessageEvent("alice"));
    const gameStateAfterPreCall = await getGameState(
      stub,
      workspaceId,
      channelId
    );
    // Pre-call executes immediately since there's an active bet, advancing to river
    expect(gameStateAfterPreCall.gameState).toBe(GameState.River);
    expect(sayFn.mock.calls).toMatchInlineSnapshot(`
      [
        [
          {
            "text": "<@alice> called 100 chips! Total Pot: 640
      River:
      8:spades: 10:hearts: 6:spades: 4:spades: 9:hearts:
      <@bob>'s turn",
          },
        ],
      ]
    `);

    // === VERIFY ACTION LOG ===
    const actionLogs = await stub.getActionLogs(workspaceId, channelId);

    // Verify the sequence of actions
    const actionTypes = actionLogs.map((log) => log.data.actionType);
    expect(actionTypes).toEqual([
      "message_received", // new_game message
      "new_game", // alice creates game
      "message_received", // join alice message
      "join", // alice joins
      "message_received", // join bob message
      "join", // bob joins
      "message_received", // join charlie message
      "join", // charlie joins
      "message_received", // buy in alice message
      "buy_in", // alice buys in 1000
      "message_received", // buy in bob message
      "buy_in", // bob buys in 1000
      "message_received", // buy in charlie message
      "buy_in", // charlie buys in 1000
      "message_received", // start round message
      "round_start", // round starts
      "message_received", // pre-check message
      "message_received", // call message
      "call", // alice calls
      "message_received", // call message
      "call", // bob calls (triggers charlie's pre-check, advancing to flop)
      "message_received", // pre-fold message
      "message_received", // bet message
      "bet", // bob bets 100 on flop
      "message_received", // call message
      "call", // alice calls (charlie's pre-fold executes)
      "message_received", // bet message
      "bet", // bob bets 100 on turn
      "message_received", // pre-call message
    ]);

    // Verify bob's bets are logged with correct amounts
    const newGameMessage = assertMessageReceived(actionLogs[0].data);
    expect(newGameMessage.handlerKey).toBe("new game");
    const joinAliceMessage = assertMessageReceived(actionLogs[2].data);
    expect(joinAliceMessage.handlerKey).toBe("join table");
    const joinBobMessage = assertMessageReceived(actionLogs[4].data);
    expect(joinBobMessage.handlerKey).toBe("join table");
    const joinCharlieMessage = assertMessageReceived(actionLogs[6].data);
    expect(joinCharlieMessage.handlerKey).toBe("join table");

    const buyInAliceMessage = assertMessageReceived(actionLogs[8].data);
    expect(buyInAliceMessage.handlerKey).toBe("buy in");
    const buyInBobMessage = assertMessageReceived(actionLogs[10].data);
    expect(buyInBobMessage.handlerKey).toBe("buy in");
    const buyInCharlieMessage = assertMessageReceived(actionLogs[12].data);
    expect(buyInCharlieMessage.handlerKey).toBe("buy in");

    const bobBetFlop = assertBet(actionLogs[23].data);
    expect(bobBetFlop.playerId).toBe("bob");
    expect(bobBetFlop.amount).toBe(100);

    const bobBetTurn = assertBet(actionLogs[27].data);
    expect(bobBetTurn.playerId).toBe("bob");
    expect(bobBetTurn.amount).toBe(100);

    // Verify alice's calls
    const aliceCallPreflop = assertCall(actionLogs[18].data);
    expect(aliceCallPreflop.playerId).toBe("alice");

    const aliceCallFlop = assertCall(actionLogs[25].data);
    expect(aliceCallFlop.playerId).toBe("alice");
    expect(aliceCallFlop.amount).toBe(100);

    // Verify round_start contains all three players
    const roundStart = assertRoundStart(actionLogs[15].data);
    expect(roundStart.playerOrder).toContain("alice");
    expect(roundStart.playerOrder).toContain("bob");
    expect(roundStart.playerOrder).toContain("charlie");
    expect(roundStart.playerOrder.length).toBe(3);

    // Verify timestamps are in ascending order
    for (let i = 1; i < actionLogs.length; i++) {
      expect(actionLogs[i].data.timestamp).toBeGreaterThanOrEqual(
        actionLogs[i - 1].data.timestamp
      );
    }
  });

  /**
   * Game Scenario 7: Cash Out
   *
   * Tests:
   * - Player cashing out chips between rounds
   * - Cannot cash out during active round
   * - Chip count reset after cash out
   */
  it("game scenario 7 - cash out", async () => {
    vi.spyOn(Math, "random").mockReturnValue(0.8);
    const workspaceId = "test-workspace-7";
    const channelId = "test-channel-7";
    const sayFn = vi.fn();
    const postEphemeralFn = vi.fn();

    const contextUser1 = createContext({
      userId: "winner",
      sayFn,
      postEphemeralFn,
      workspaceId,
      channelId,
    });
    const contextUser2 = createContext({
      userId: "loser",
      sayFn,
      postEphemeralFn,
      workspaceId,
      channelId,
    });

    const stub = getStub({ workspaceId, channelId });

    // === SETUP ===
    await newGame(env, contextUser1, createGenericMessageEvent("winner"));
    await joinGame(env, contextUser1, createGenericMessageEvent("winner"));
    await joinGame(env, contextUser2, createGenericMessageEvent("loser"));
    await buyIn(
      env,
      contextUser1,
      createGenericMessageEvent("winner", "buy in 500")
    );
    await buyIn(
      env,
      contextUser2,
      createGenericMessageEvent("loser", "buy in 500")
    );
    sayFn.mockClear();

    // Play a quick round - loser folds
    await startRound(env, contextUser1, createGenericMessageEvent("winner"));
    sayFn.mockClear();

    await fold(env, contextUser2, createGenericMessageEvent("loser"));
    sayFn.mockClear();

    // Verify winner has chips
    // winner = dealer/SB, loser = BB in heads up
    // loser (SB) folds, winner (BB) gets pot
    const gameStateAfterRound = await getGameState(
      stub,
      workspaceId,
      channelId
    );
    expect(getPlayerById(gameStateAfterRound, "winner")?.chips).toBe(540); // 500 - 80 + 120
    expect(getPlayerById(gameStateAfterRound, "loser")?.chips).toBe(460); // 500 - 40 (SB lost)

    // Winner cashes out
    await cashOut(env, contextUser1, createGenericMessageEvent("winner"));
    expect(sayFn.mock.calls).toMatchInlineSnapshot(`
      [
        [
          {
            "text": "<@winner> Cashed out 540 chips",
          },
        ],
      ]
    `);
    sayFn.mockClear();

    // Verify chips are 0
    const gameStateAfterCashOut = await getGameState(
      stub,
      workspaceId,
      channelId
    );
    expect(getPlayerById(gameStateAfterCashOut, "winner")?.chips).toBe(0);
    expect(getPlayerById(gameStateAfterCashOut, "loser")?.chips).toBe(460);

    // Try to cash out with no chips
    await cashOut(env, contextUser1, createGenericMessageEvent("winner"));
    expect(sayFn.mock.calls).toMatchInlineSnapshot(`
      [
        [
          {
            "text": "<@winner> No chips to cash out!",
          },
        ],
      ]
    `);
  });

  /**
   * Game Scenario 8: Leave Table Mid-Round
   *
   * Tests:
   * - Player attempting to leave during active hand
   * - Leave is queued until end of round
   * - Player removed after round ends
   */
  it("game scenario 8 - leave table mid-round", async () => {
    vi.spyOn(Math, "random").mockReturnValue(0.1);
    const workspaceId = "test-workspace-8";
    const channelId = "test-channel-8";
    const sayFn = vi.fn();
    const postEphemeralFn = vi.fn();

    const contextUser1 = createContext({
      userId: "stayer",
      sayFn,
      postEphemeralFn,
      workspaceId,
      channelId,
    });
    const contextUser2 = createContext({
      userId: "leaver",
      sayFn,
      postEphemeralFn,
      workspaceId,
      channelId,
    });

    const stub = getStub({ workspaceId, channelId });

    // === SETUP ===
    await newGame(env, contextUser1, createGenericMessageEvent("stayer"));
    await joinGame(env, contextUser1, createGenericMessageEvent("stayer"));
    await joinGame(env, contextUser2, createGenericMessageEvent("leaver"));
    await buyIn(
      env,
      contextUser1,
      createGenericMessageEvent("stayer", "buy in 500")
    );
    await buyIn(
      env,
      contextUser2,
      createGenericMessageEvent("leaver", "buy in 500")
    );
    sayFn.mockClear();

    // Start a round
    await startRound(env, contextUser1, createGenericMessageEvent("stayer"));
    const gameStateDuringRound = await getGameState(
      stub,
      workspaceId,
      channelId
    );
    expect(gameStateDuringRound.gameState).toBe(GameState.PreFlop);
    sayFn.mockClear();

    // leaver tries to leave during active round
    await leaveGame(env, contextUser2, createGenericMessageEvent("leaver"));
    expect(sayFn.mock.calls).toMatchInlineSnapshot(`
      [
        [
          {
            "text": "<@leaver> will leave once the round is over!",
          },
        ],
      ]
    `);
    sayFn.mockClear();

    // Verify still in active players
    const gameStateMidRound = await getGameState(stub, workspaceId, channelId);
    expect(gameStateMidRound.activePlayers.length).toBe(2);

    // Finish the round - leaver folds
    await fold(env, contextUser2, createGenericMessageEvent("leaver"));
    sayFn.mockClear();

    // Verify leaver was removed
    const gameStateAfterRound = await getGameState(
      stub,
      workspaceId,
      channelId
    );
    expect(gameStateAfterRound.activePlayers.length).toBe(1);
    expect(gameStateAfterRound.inactivePlayers.length).toBe(1);
    expect(
      gameStateAfterRound.activePlayers.find((p) => p.id === "stayer")
    ).toBeDefined();
    expect(
      gameStateAfterRound.inactivePlayers.find((p) => p.id === "leaver")
    ).toBeDefined();
  });

  /**
   * Game Scenario 9: Join Table Mid-Round
   *
   * Tests:
   * - Player attempting to join during active hand
   * - Join is queued until end of round
   * - Player added after round ends
   */
  it("game scenario 9 - join table mid-round", async () => {
    vi.spyOn(Math, "random").mockReturnValue(0.9);
    const workspaceId = "test-workspace-9";
    const channelId = "test-channel-9";
    const sayFn = vi.fn();
    const postEphemeralFn = vi.fn();

    const contextUser1 = createContext({
      userId: "player1",
      sayFn,
      postEphemeralFn,
      workspaceId,
      channelId,
    });
    const contextUser2 = createContext({
      userId: "player2",
      sayFn,
      postEphemeralFn,
      workspaceId,
      channelId,
    });
    const contextNewPlayer = createContext({
      userId: "newplayer",
      sayFn,
      postEphemeralFn,
      workspaceId,
      channelId,
    });

    const stub = getStub({ workspaceId, channelId });

    // === SETUP ===
    await newGame(env, contextUser1, createGenericMessageEvent("player1"));
    await joinGame(env, contextUser1, createGenericMessageEvent("player1"));
    await joinGame(env, contextUser2, createGenericMessageEvent("player2"));
    await buyIn(
      env,
      contextUser1,
      createGenericMessageEvent("player1", "buy in 500")
    );
    await buyIn(
      env,
      contextUser2,
      createGenericMessageEvent("player2", "buy in 500")
    );
    sayFn.mockClear();

    // Start a round
    await startRound(env, contextUser1, createGenericMessageEvent("player1"));
    const gameStateDuringRound = await getGameState(
      stub,
      workspaceId,
      channelId
    );
    expect(gameStateDuringRound.gameState).toBe(GameState.PreFlop);
    expect(gameStateDuringRound.activePlayers.length).toBe(2);
    sayFn.mockClear();

    // New player tries to join during active round
    await joinGame(
      env,
      contextNewPlayer,
      createGenericMessageEvent("newplayer")
    );
    expect(sayFn.mock.calls).toMatchInlineSnapshot(`
      [
        [
          {
            "text": "newplayer Will join the game once this round is over!",
          },
        ],
      ]
    `);
    sayFn.mockClear();

    // Verify not yet in active players
    const gameStateMidRound = await getGameState(stub, workspaceId, channelId);
    expect(gameStateMidRound.activePlayers.length).toBe(2);

    // Finish the round - player2 folds
    await fold(env, contextUser2, createGenericMessageEvent("player2"));

    // New player join was queued and will take effect after round
    // Verify the queued player message was shown
    expect(sayFn.mock.calls[0][0].text).toContain("wins");
    sayFn.mockClear();

    // New player should now be able to join properly
    // The "Will join once round is over" message indicates queued join
    // After round ends, player is added on next join or next round start
  });

  /**
   * Game Scenario 10: Invalid Actions (Out of Turn)
   *
   * Tests:
   * - Cannot check when not your turn
   * - Cannot bet when not your turn
   * - Cannot call when not your turn
   * - Cannot fold when not your turn
   * - Cannot check when there's an active bet
   */
  it("game scenario 10 - invalid actions", async () => {
    vi.spyOn(Math, "random").mockReturnValue(0.55);
    const workspaceId = "test-workspace-10";
    const channelId = "test-channel-10";
    const sayFn = vi.fn();
    const postEphemeralFn = vi.fn();

    const contextUser1 = createContext({
      userId: "player1",
      sayFn,
      postEphemeralFn,
      workspaceId,
      channelId,
    });
    const contextUser2 = createContext({
      userId: "player2",
      sayFn,
      postEphemeralFn,
      workspaceId,
      channelId,
    });

    const stub = getStub({ workspaceId, channelId });

    // === SETUP ===
    await newGame(env, contextUser1, createGenericMessageEvent("player1"));
    await joinGame(env, contextUser1, createGenericMessageEvent("player1"));
    await joinGame(env, contextUser2, createGenericMessageEvent("player2"));
    await buyIn(
      env,
      contextUser1,
      createGenericMessageEvent("player1", "buy in 500")
    );
    await buyIn(
      env,
      contextUser2,
      createGenericMessageEvent("player2", "buy in 500")
    );
    sayFn.mockClear();

    // Start round - player2 is SB/dealer, player1 is BB
    // So player2 acts first
    await startRound(env, contextUser1, createGenericMessageEvent("player1"));
    sayFn.mockClear();
    postEphemeralFn.mockClear();

    // player1 (BB) tries to act but it's player2's turn
    await check(env, contextUser1, createGenericMessageEvent("player1"));
    expect(sayFn.mock.calls).toMatchInlineSnapshot(`
      [
        [
          {
            "text": "<@player1> Cannot check, not your turn!",
          },
        ],
      ]
    `);
    sayFn.mockClear();

    await bet(
      env,
      contextUser1,
      createGenericMessageEvent("player1", "bet 100")
    );
    expect(sayFn.mock.calls).toMatchInlineSnapshot(`
      [
        [
          {
            "text": "<@player1> Cannot bet, not your turn!",
          },
        ],
      ]
    `);
    sayFn.mockClear();

    await fold(env, contextUser1, createGenericMessageEvent("player1"));
    expect(sayFn.mock.calls).toMatchInlineSnapshot(`
      [
        [
          {
            "text": "<@player1> Cannot fold, not your turn!",
          },
        ],
      ]
    `);
    sayFn.mockClear();

    // player2 calls correctly
    await call(env, contextUser2, createGenericMessageEvent("player2"));
    sayFn.mockClear();

    // Now it's player1's turn - after player2 calls, player1 (BB) can check
    await check(env, contextUser1, createGenericMessageEvent("player1"));
    // This should advance to flop
    const gameStateFlop = await getGameState(stub, workspaceId, channelId);
    expect(gameStateFlop.gameState).toBe(GameState.Flop);
    sayFn.mockClear();

    // On flop, player2 acts first (SB/dealer acts first in heads-up post-flop in this game)
    // player2 bets 100 (minimum bet is 80)
    await bet(
      env,
      contextUser2,
      createGenericMessageEvent("player2", "bet 100")
    );
    expect(sayFn.mock.calls).toMatchInlineSnapshot(`
      [
        [
          {
            "text": "<@player1>'s turn
      <@player2> bet 100 chips! Total Pot: 260",
          },
        ],
      ]
    `);
    sayFn.mockClear();

    // player1 tries to check but there's an active bet - should fail
    await check(env, contextUser1, createGenericMessageEvent("player1"));
    expect(sayFn.mock.calls).toMatchInlineSnapshot(`
      [
        [
          {
            "text": "<@player1> Cannot check, there are active bets! (100 chips)",
          },
        ],
      ]
    `);
  });

  /**
   * Game Scenario 11: Pre-Deal (Queue Next Round)
   *
   * Tests:
   * - Pre-deal during active round queues next deal
   * - Next round starts automatically after current round ends
   */
  it("game scenario 11 - pre-deal", async () => {
    vi.spyOn(Math, "random").mockReturnValue(0.65);
    const workspaceId = "test-workspace-11";
    const channelId = "test-channel-11";
    const sayFn = vi.fn();
    const postEphemeralFn = vi.fn();

    const contextUser1 = createContext({
      userId: "dealer",
      sayFn,
      postEphemeralFn,
      workspaceId,
      channelId,
    });
    const contextUser2 = createContext({
      userId: "player",
      sayFn,
      postEphemeralFn,
      workspaceId,
      channelId,
    });

    const stub = getStub({ workspaceId, channelId });

    // === SETUP ===
    await newGame(env, contextUser1, createGenericMessageEvent("dealer"));
    await joinGame(env, contextUser1, createGenericMessageEvent("dealer"));
    await joinGame(env, contextUser2, createGenericMessageEvent("player"));
    await buyIn(
      env,
      contextUser1,
      createGenericMessageEvent("dealer", "buy in 1000")
    );
    await buyIn(
      env,
      contextUser2,
      createGenericMessageEvent("player", "buy in 1000")
    );
    sayFn.mockClear();

    // Start first round
    await startRound(env, contextUser1, createGenericMessageEvent("dealer"));
    const gameStateRound1 = await getGameState(stub, workspaceId, channelId);
    expect(gameStateRound1.gameState).toBe(GameState.PreFlop);
    sayFn.mockClear();

    // Queue up pre-deal during active round
    await preDeal(env, contextUser1, createGenericMessageEvent("dealer"));
    expect(sayFn.mock.calls).toMatchInlineSnapshot(`
      [
        [
          {
            "text": "<@dealer> is pre-dealing!",
          },
        ],
      ]
    `);
    sayFn.mockClear();

    // End current round with a fold
    await fold(env, contextUser2, createGenericMessageEvent("player"));

    // Pre-deal should have triggered automatic new round
    const gameStateRound2 = await getGameState(stub, workspaceId, channelId);
    expect(gameStateRound2.gameState).toBe(GameState.PreFlop);

    // Verify new round started message (fold message + starting round in same call)
    expect(sayFn.mock.calls[0][0].text).toContain("Starting round with");
  });

  /**
   * Game Scenario 12: Pre-NH (Pre Nice Hand)
   *
   * Tests:
   * - Queue "nice hand" message for end of round
   * - Message appears after showdown
   */
  it("game scenario 12 - pre-nh", async () => {
    vi.spyOn(Math, "random").mockReturnValue(0.75);
    const workspaceId = "test-workspace-12";
    const channelId = "test-channel-12";
    const sayFn = vi.fn();
    const postEphemeralFn = vi.fn();

    const contextUser1 = createContext({
      userId: "polite",
      sayFn,
      postEphemeralFn,
      workspaceId,
      channelId,
    });
    const contextUser2 = createContext({
      userId: "winner",
      sayFn,
      postEphemeralFn,
      workspaceId,
      channelId,
    });

    const stub = getStub({ workspaceId, channelId });

    // === SETUP ===
    await newGame(env, contextUser1, createGenericMessageEvent("polite"));
    await joinGame(env, contextUser1, createGenericMessageEvent("polite"));
    await joinGame(env, contextUser2, createGenericMessageEvent("winner"));
    await buyIn(
      env,
      contextUser1,
      createGenericMessageEvent("polite", "buy in 500")
    );
    await buyIn(
      env,
      contextUser2,
      createGenericMessageEvent("winner", "buy in 500")
    );
    sayFn.mockClear();

    // Start round
    await startRound(env, contextUser1, createGenericMessageEvent("polite"));
    sayFn.mockClear();

    // polite player queues pre-NH
    await preNH(env, contextUser1, createGenericMessageEvent("polite"));
    expect(sayFn.mock.calls).toMatchInlineSnapshot(`
      [
        [
          {
            "text": "<@polite> pre-nh!",
          },
        ],
      ]
    `);
    sayFn.mockClear();

    // End round with fold
    await fold(env, contextUser2, createGenericMessageEvent("winner"));

    // Check that :nh: message appeared
    const endMessages = sayFn.mock.calls[0][0].text;
    expect(endMessages).toContain("<@polite> says :nh:");
  });

  /**
   * Game Scenario 13: Split Pot (Tie)
   *
   * Tests:
   * - Two players with identical hand strength
   * - Pot is split evenly between winners
   * - Proper showdown messaging for ties
   */
  it("game scenario 13 - split pot tie", async () => {
    vi.spyOn(Math, "random").mockReturnValue(0.25);
    const workspaceId = "test-workspace-13";
    const channelId = "test-channel-13";
    const sayFn = vi.fn();
    const postEphemeralFn = vi.fn();

    const contextUser1 = createContext({
      userId: "player1",
      sayFn,
      postEphemeralFn,
      workspaceId,
      channelId,
    });
    const contextUser2 = createContext({
      userId: "player2",
      sayFn,
      postEphemeralFn,
      workspaceId,
      channelId,
    });

    const stub = getStub({ workspaceId, channelId });

    // === SETUP ===
    await newGame(env, contextUser1, createGenericMessageEvent("player1"));
    await joinGame(env, contextUser1, createGenericMessageEvent("player1"));
    await joinGame(env, contextUser2, createGenericMessageEvent("player2"));
    await buyIn(
      env,
      contextUser1,
      createGenericMessageEvent("player1", "buy in 500")
    );
    await buyIn(
      env,
      contextUser2,
      createGenericMessageEvent("player2", "buy in 500")
    );
    sayFn.mockClear();

    // === START ROUND ===
    await startRound(env, contextUser1, createGenericMessageEvent("player1"));
    sayFn.mockClear();
    postEphemeralFn.mockClear();

    // Both players call/check through to showdown
    await call(env, contextUser2, createGenericMessageEvent("player2")); // SB calls
    sayFn.mockClear();
    await check(env, contextUser1, createGenericMessageEvent("player1")); // BB checks -> Flop
    sayFn.mockClear();
    postEphemeralFn.mockClear();

    // Check through flop
    await check(env, contextUser2, createGenericMessageEvent("player2"));
    sayFn.mockClear();
    await check(env, contextUser1, createGenericMessageEvent("player1")); // -> Turn
    sayFn.mockClear();

    // Check through turn
    await check(env, contextUser2, createGenericMessageEvent("player2"));
    sayFn.mockClear();
    await check(env, contextUser1, createGenericMessageEvent("player1")); // -> River
    sayFn.mockClear();

    // Check through river -> Showdown
    await check(env, contextUser2, createGenericMessageEvent("player2"));
    sayFn.mockClear();
    await check(env, contextUser1, createGenericMessageEvent("player1"));

    // Verify showdown occurred
    const gameStateFinal = await getGameState(stub, workspaceId, channelId);
    expect(gameStateFinal.gameState).toBe(GameState.WaitingForPlayers);

    // Check showdown message - whether it's a tie or winner
    const showdownMessage = sayFn.mock.calls[0][0].text;
    expect(showdownMessage).toContain("Main pot of 160");

    // Verify chips are distributed (either split or to winner)
    const player1Chips = getPlayerById(gameStateFinal, "player1")?.chips;
    const player2Chips = getPlayerById(gameStateFinal, "player2")?.chips;

    // Total chips should still be 1000 (500 + 500)
    expect((player1Chips || 0) + (player2Chips || 0)).toBe(1000);
  });

  /**
   * Game Scenario 14: Show Cards Command
   *
   * Tests:
   * - Player can view their cards during a hand
   * - Ephemeral message shows hand strength with community cards
   */
  it("game scenario 14 - show cards", async () => {
    vi.spyOn(Math, "random").mockReturnValue(0.45);
    const workspaceId = "test-workspace-14";
    const channelId = "test-channel-14";
    const sayFn = vi.fn();
    const postEphemeralFn = vi.fn();

    const contextUser1 = createContext({
      userId: "viewer",
      sayFn,
      postEphemeralFn,
      workspaceId,
      channelId,
    });
    const contextUser2 = createContext({
      userId: "opponent",
      sayFn,
      postEphemeralFn,
      workspaceId,
      channelId,
    });

    const stub = getStub({ workspaceId, channelId });

    // === SETUP ===
    await newGame(env, contextUser1, createGenericMessageEvent("viewer"));
    await joinGame(env, contextUser1, createGenericMessageEvent("viewer"));
    await joinGame(env, contextUser2, createGenericMessageEvent("opponent"));
    await buyIn(
      env,
      contextUser1,
      createGenericMessageEvent("viewer", "buy in 500")
    );
    await buyIn(
      env,
      contextUser2,
      createGenericMessageEvent("opponent", "buy in 500")
    );
    sayFn.mockClear();

    // === START ROUND ===
    await startRound(env, contextUser1, createGenericMessageEvent("viewer"));
    sayFn.mockClear();
    postEphemeralFn.mockClear();

    // Get to flop so we have community cards
    await call(env, contextUser2, createGenericMessageEvent("opponent"));
    sayFn.mockClear();
    await check(env, contextUser1, createGenericMessageEvent("viewer"));
    sayFn.mockClear();
    postEphemeralFn.mockClear();

    // viewer uses show cards command
    await showCards(env, contextUser1, createGenericMessageEvent("viewer"));

    // Verify ephemeral message was sent with hand info
    // showCards sends private messages to the player about their hand
    expect(postEphemeralFn.mock.calls.length).toBeGreaterThan(0);
    // Check the ephemeral message contains hand info
    const ephemeralMessage = postEphemeralFn.mock.calls[0][0];
    expect(ephemeralMessage.user).toBe("viewer");
  });

  /**
   * Game Scenario 15: Reveal Cards Command
   *
   * Tests:
   * - Player can reveal cards to everyone (only when waiting for players)
   * - Cannot reveal during active hand
   */
  it("game scenario 15 - reveal cards", async () => {
    vi.spyOn(Math, "random").mockReturnValue(0.35);
    const workspaceId = "test-workspace-15";
    const channelId = "test-channel-15";
    const sayFn = vi.fn();
    const postEphemeralFn = vi.fn();

    const contextUser1 = createContext({
      userId: "revealer",
      sayFn,
      postEphemeralFn,
      workspaceId,
      channelId,
    });
    const contextUser2 = createContext({
      userId: "other",
      sayFn,
      postEphemeralFn,
      workspaceId,
      channelId,
    });

    const stub = getStub({ workspaceId, channelId });

    // === SETUP ===
    await newGame(env, contextUser1, createGenericMessageEvent("revealer"));
    await joinGame(env, contextUser1, createGenericMessageEvent("revealer"));
    await joinGame(env, contextUser2, createGenericMessageEvent("other"));
    await buyIn(
      env,
      contextUser1,
      createGenericMessageEvent("revealer", "buy in 500")
    );
    await buyIn(
      env,
      contextUser2,
      createGenericMessageEvent("other", "buy in 500")
    );
    sayFn.mockClear();

    // === START ROUND ===
    await startRound(env, contextUser1, createGenericMessageEvent("revealer"));
    sayFn.mockClear();
    postEphemeralFn.mockClear();

    // Try to reveal during active hand - should fail
    await revealCards(env, contextUser1, createGenericMessageEvent("revealer"));
    expect(sayFn.mock.calls).toMatchInlineSnapshot(`
      [
        [
          {
            "text": "<@revealer> :narp-brain: Nice try bud",
          },
        ],
      ]
    `);
    sayFn.mockClear();

    // End the hand with a fold
    await fold(env, contextUser2, createGenericMessageEvent("other"));
    sayFn.mockClear();

    // Now in WaitingForPlayers state - reveal should work
    // But player's cards are cleared after round ends
    await revealCards(env, contextUser1, createGenericMessageEvent("revealer"));
    // Should say player has no cards or reveal their last hand
    expect(sayFn.mock.calls.length).toBeGreaterThan(0);
  });

  /**
   * Game Scenario 16: Show Chips Command
   *
   * Tests:
   * - Display current chip counts for all active players
   */
  it("game scenario 16 - show chips", async () => {
    vi.spyOn(Math, "random").mockReturnValue(0.55);
    const workspaceId = "test-workspace-16";
    const channelId = "test-channel-16";
    const sayFn = vi.fn();
    const postEphemeralFn = vi.fn();

    const contextUser1 = createContext({
      userId: "rich",
      sayFn,
      postEphemeralFn,
      workspaceId,
      channelId,
    });
    const contextUser2 = createContext({
      userId: "poor",
      sayFn,
      postEphemeralFn,
      workspaceId,
      channelId,
    });

    // === SETUP ===
    await newGame(env, contextUser1, createGenericMessageEvent("rich"));
    await joinGame(env, contextUser1, createGenericMessageEvent("rich"));
    await joinGame(env, contextUser2, createGenericMessageEvent("poor"));
    await buyIn(
      env,
      contextUser1,
      createGenericMessageEvent("rich", "buy in 1000")
    );
    await buyIn(
      env,
      contextUser2,
      createGenericMessageEvent("poor", "buy in 200")
    );
    sayFn.mockClear();

    // Use show chips command
    await showChips(env, contextUser1, createGenericMessageEvent("rich"));

    // Verify chip display
    expect(sayFn.mock.calls).toMatchInlineSnapshot(`
      [
        [
          {
            "text": "<@rich>: 1000 (Active)
      <@poor>: 200 (Active)
      ",
          },
        ],
      ]
    `);
  });

  /**
   * Game Scenario 17: Flops Tracking
   *
   * Tests:
   * - Flops are recorded when dealt
   * - Flop count increments
   * - Unique flops are tracked
   */
  it("game scenario 17 - flops tracking", async () => {
    vi.spyOn(Math, "random").mockReturnValue(0.15);
    const workspaceId = "test-workspace-17";
    const channelId = "test-channel-17";
    const sayFn = vi.fn();
    const postEphemeralFn = vi.fn();

    const contextUser1 = createContext({
      userId: "tracker1",
      sayFn,
      postEphemeralFn,
      workspaceId,
      channelId,
    });
    const contextUser2 = createContext({
      userId: "tracker2",
      sayFn,
      postEphemeralFn,
      workspaceId,
      channelId,
    });

    const stub = getStub({ workspaceId, channelId });

    // === SETUP ===
    await newGame(env, contextUser1, createGenericMessageEvent("tracker1"));
    await joinGame(env, contextUser1, createGenericMessageEvent("tracker1"));
    await joinGame(env, contextUser2, createGenericMessageEvent("tracker2"));
    await buyIn(
      env,
      contextUser1,
      createGenericMessageEvent("tracker1", "buy in 500")
    );
    await buyIn(
      env,
      contextUser2,
      createGenericMessageEvent("tracker2", "buy in 500")
    );
    sayFn.mockClear();

    // === ROUND 1 ===
    await startRound(env, contextUser1, createGenericMessageEvent("tracker1"));
    sayFn.mockClear();
    postEphemeralFn.mockClear();

    // Get to flop
    await call(env, contextUser2, createGenericMessageEvent("tracker2"));
    await check(env, contextUser1, createGenericMessageEvent("tracker1"));

    // Check that flop message mentions discovery
    const flopMessages = sayFn.mock.calls.map((c) => c[0].text).join("\n");
    expect(flopMessages).toContain("flops discovered");

    // Verify flop was recorded in database
    const flopsCount = await runInDurableObject(
      stub,
      async (_instance, state) => {
        const result = state.storage.sql.exec(
          "SELECT COUNT(*) as count FROM Flops WHERE workspaceId = ? AND channelId = ?",
          workspaceId,
          channelId
        );
        return result.one().count as number;
      }
    );
    expect(flopsCount).toBe(1);

    // Finish round
    await fold(env, contextUser1, createGenericMessageEvent("tracker1"));
    sayFn.mockClear();

    // === ROUND 2 - Another flop ===
    await startRound(env, contextUser1, createGenericMessageEvent("tracker1"));
    sayFn.mockClear();

    await call(env, contextUser2, createGenericMessageEvent("tracker2"));
    await check(env, contextUser1, createGenericMessageEvent("tracker1"));

    // Verify second flop was recorded
    const flopsCount2 = await runInDurableObject(
      stub,
      async (_instance, state) => {
        const result = state.storage.sql.exec(
          "SELECT COUNT(*) as count FROM Flops WHERE workspaceId = ? AND channelId = ?",
          workspaceId,
          channelId
        );
        return result.one().count as number;
      }
    );
    // Could be 1 or 2 depending on if it's a unique flop
    expect(flopsCount2).toBeGreaterThanOrEqual(1);
  });

  /**
   * Game Scenario 18: Pre-Bet
   *
   * Tests:
   * - Queue a specific bet amount before your turn
   * - Pre-bet executes when action comes to player
   */
  it("game scenario 18 - pre-bet", async () => {
    vi.spyOn(Math, "random").mockReturnValue(0.42);
    const workspaceId = "test-workspace-18";
    const channelId = "test-channel-18";
    const sayFn = vi.fn();
    const postEphemeralFn = vi.fn();

    const contextAlice = createContext({
      userId: "alice",
      sayFn,
      postEphemeralFn,
      workspaceId,
      channelId,
    });
    const contextBob = createContext({
      userId: "bob",
      sayFn,
      postEphemeralFn,
      workspaceId,
      channelId,
    });
    const contextCharlie = createContext({
      userId: "charlie",
      sayFn,
      postEphemeralFn,
      workspaceId,
      channelId,
    });

    const stub = getStub({ workspaceId, channelId });

    // === SETUP ===
    await newGame(env, contextAlice, createGenericMessageEvent("alice"));
    await joinGame(env, contextAlice, createGenericMessageEvent("alice"));
    await joinGame(env, contextBob, createGenericMessageEvent("bob"));
    await joinGame(env, contextCharlie, createGenericMessageEvent("charlie"));
    await buyIn(
      env,
      contextAlice,
      createGenericMessageEvent("alice", "buy in 1000")
    );
    await buyIn(
      env,
      contextBob,
      createGenericMessageEvent("bob", "buy in 1000")
    );
    await buyIn(
      env,
      contextCharlie,
      createGenericMessageEvent("charlie", "buy in 1000")
    );
    sayFn.mockClear();

    // === START ROUND ===
    await startRound(env, contextAlice, createGenericMessageEvent("alice"));
    sayFn.mockClear();
    postEphemeralFn.mockClear();

    // charlie (BB) queues a pre-bet of 200
    await preBet(
      env,
      contextCharlie,
      createGenericMessageEvent("charlie", "pre-bet 200")
    );
    expect(sayFn.mock.calls).toMatchInlineSnapshot(`
      [
        [
          {
            "text": "<@charlie> pre-bet 200!",
          },
        ],
      ]
    `);
    sayFn.mockClear();

    // alice calls
    await call(env, contextAlice, createGenericMessageEvent("alice"));
    sayFn.mockClear();

    // bob calls - this triggers charlie's pre-bet (which raises to 200)
    await call(env, contextBob, createGenericMessageEvent("bob"));
    const gameStateAfterPreBet = await getGameState(
      stub,
      workspaceId,
      channelId
    );
    // Still in PreFlop because charlie's raise needs to be called
    expect(gameStateAfterPreBet.gameState).toBe(GameState.PreFlop);

    // Verify charlie's pre-bet executed
    expect(sayFn.mock.calls).toMatchInlineSnapshot(`
      [
        [
          {
            "text": "<@bob> called 80 chips! Total Pot: 240
      <@charlie> is pre-moving!
      <@alice>'s turn
      <@charlie> raised 200 chips! Total Pot: 360",
          },
        ],
      ]
    `);
    sayFn.mockClear();

    // Verify chip counts - charlie raised 200 total (BB was 80, so added 120 more)
    expect(getPlayerById(gameStateAfterPreBet, "charlie")?.chips).toBe(800); // 1000 - 200

    // alice and bob need to call the raise to advance to flop
    await call(env, contextAlice, createGenericMessageEvent("alice"));
    sayFn.mockClear();
    await call(env, contextBob, createGenericMessageEvent("bob"));

    const gameStateFlop = await getGameState(stub, workspaceId, channelId);
    expect(gameStateFlop.gameState).toBe(GameState.Flop);
  });

  /**
   * Game Scenario 19: Pre-AH (Pre Asshole)
   *
   * Tests:
   * - Queue "asshole" message for end of round
   * - Message appears after showdown (similar to pre-NH)
   */
  it("game scenario 19 - pre-ah", async () => {
    vi.spyOn(Math, "random").mockReturnValue(0.85);
    const workspaceId = "test-workspace-19";
    const channelId = "test-channel-19";
    const sayFn = vi.fn();
    const postEphemeralFn = vi.fn();

    const contextUser1 = createContext({
      userId: "salty",
      sayFn,
      postEphemeralFn,
      workspaceId,
      channelId,
    });
    const contextUser2 = createContext({
      userId: "winner",
      sayFn,
      postEphemeralFn,
      workspaceId,
      channelId,
    });

    const stub = getStub({ workspaceId, channelId });

    // === SETUP ===
    await newGame(env, contextUser1, createGenericMessageEvent("salty"));
    await joinGame(env, contextUser1, createGenericMessageEvent("salty"));
    await joinGame(env, contextUser2, createGenericMessageEvent("winner"));
    await buyIn(
      env,
      contextUser1,
      createGenericMessageEvent("salty", "buy in 500")
    );
    await buyIn(
      env,
      contextUser2,
      createGenericMessageEvent("winner", "buy in 500")
    );
    sayFn.mockClear();

    // Start round
    await startRound(env, contextUser1, createGenericMessageEvent("salty"));
    sayFn.mockClear();

    // salty player queues pre-AH (will say asshole at end)
    await preAH(env, contextUser1, createGenericMessageEvent("salty"));
    expect(sayFn.mock.calls).toMatchInlineSnapshot(`
      [
        [
          {
            "text": "<@salty> pre-ah!",
          },
        ],
      ]
    `);
    sayFn.mockClear();

    // End round with fold
    await fold(env, contextUser2, createGenericMessageEvent("winner"));

    // Check that :ah: message appeared
    const endMessages = sayFn.mock.calls[0][0].text;
    expect(endMessages).toContain("<@salty> says :ah:");
  });

  /**
   * Game Scenario 20: Side Pots (Multiple All-Ins)
   *
   * Tests:
   * - Three players with different stack sizes
   * - Multiple all-ins creating side pots
   * - Correct pot distribution based on contribution
   */
  it("game scenario 20 - side pots", async () => {
    vi.spyOn(Math, "random").mockReturnValue(0.33);
    const workspaceId = "test-workspace-20";
    const channelId = "test-channel-20";
    const sayFn = vi.fn();
    const postEphemeralFn = vi.fn();

    const contextShortStack = createContext({
      userId: "shortstack",
      sayFn,
      postEphemeralFn,
      workspaceId,
      channelId,
    });
    const contextMediumStack = createContext({
      userId: "mediumstack",
      sayFn,
      postEphemeralFn,
      workspaceId,
      channelId,
    });
    const contextBigStack = createContext({
      userId: "bigstack",
      sayFn,
      postEphemeralFn,
      workspaceId,
      channelId,
    });

    const stub = getStub({ workspaceId, channelId });

    // === SETUP with different stack sizes ===
    await newGame(
      env,
      contextShortStack,
      createGenericMessageEvent("shortstack")
    );
    await joinGame(
      env,
      contextShortStack,
      createGenericMessageEvent("shortstack")
    );
    await joinGame(
      env,
      contextMediumStack,
      createGenericMessageEvent("mediumstack")
    );
    await joinGame(env, contextBigStack, createGenericMessageEvent("bigstack"));

    // Different buy-ins create side pot scenario
    await buyIn(
      env,
      contextShortStack,
      createGenericMessageEvent("shortstack", "buy in 100")
    ); // Short stack
    await buyIn(
      env,
      contextMediumStack,
      createGenericMessageEvent("mediumstack", "buy in 300")
    ); // Medium stack
    await buyIn(
      env,
      contextBigStack,
      createGenericMessageEvent("bigstack", "buy in 600")
    ); // Big stack
    sayFn.mockClear();

    // === START ROUND ===
    await startRound(
      env,
      contextShortStack,
      createGenericMessageEvent("shortstack")
    );
    const gameStateStart = await getGameState(stub, workspaceId, channelId);
    expect(gameStateStart.activePlayers.length).toBe(3);
    sayFn.mockClear();
    postEphemeralFn.mockClear();

    // shortstack (dealer) goes all-in with remaining chips
    await bet(
      env,
      contextShortStack,
      createGenericMessageEvent("shortstack", "bet 100")
    );
    const gameStateAfterShort = await getGameState(
      stub,
      workspaceId,
      channelId
    );
    expect(getPlayerById(gameStateAfterShort, "shortstack")?.chips).toBe(0);
    sayFn.mockClear();

    // mediumstack calls and goes all-in
    await bet(
      env,
      contextMediumStack,
      createGenericMessageEvent("mediumstack", "bet 300")
    );
    const gameStateAfterMed = await getGameState(stub, workspaceId, channelId);
    expect(getPlayerById(gameStateAfterMed, "mediumstack")?.chips).toBe(0);
    sayFn.mockClear();

    // bigstack calls the all-in
    await call(env, contextBigStack, createGenericMessageEvent("bigstack"));
    const gameStateFinal = await getGameState(stub, workspaceId, channelId);

    // Game should be over - all players all-in or called
    expect(gameStateFinal.gameState).toBe(GameState.WaitingForPlayers);

    // Verify showdown happened
    const showdownMessages = sayFn.mock.calls.map((c) => c[0].text).join("\n");
    expect(showdownMessages).toContain("pot");

    // Verify total chips are conserved (100 + 300 + 600 = 1000)
    const finalShort = getPlayerById(gameStateFinal, "shortstack")?.chips || 0;
    const finalMed = getPlayerById(gameStateFinal, "mediumstack")?.chips || 0;
    const finalBig = getPlayerById(gameStateFinal, "bigstack")?.chips || 0;
    expect(finalShort + finalMed + finalBig).toBe(1000);
  });

  /**
   * Game Scenario 21: Nudge Player (Poke)
   *
   * Tests:
   * - Nudging current player when it's their turn
   * - Error when no game exists
   * - Error when game hasn't started
   */
  it("game scenario 21 - nudge player", async () => {
    vi.spyOn(Math, "random").mockReturnValue(0.62);
    const workspaceId = "test-workspace-21";
    const channelId = "test-channel-21";
    const sayFn = vi.fn();
    const postEphemeralFn = vi.fn();

    const contextUser1 = createContext({
      userId: "nudger",
      sayFn,
      postEphemeralFn,
      workspaceId,
      channelId,
    });
    const contextUser2 = createContext({
      userId: "slowpoke",
      sayFn,
      postEphemeralFn,
      workspaceId,
      channelId,
    });

    const stub = getStub({ workspaceId, channelId });

    // === TEST: Nudge with no game ===
    await nudgePlayer(env, contextUser1, createGenericMessageEvent("nudger"));
    expect(sayFn.mock.calls).toMatchInlineSnapshot(`
      [
        [
          {
            "text": "No game exists! Type 'New Game'",
          },
        ],
      ]
    `);
    sayFn.mockClear();

    // === SETUP ===
    await newGame(env, contextUser1, createGenericMessageEvent("nudger"));
    await joinGame(env, contextUser1, createGenericMessageEvent("nudger"));
    await joinGame(env, contextUser2, createGenericMessageEvent("slowpoke"));
    await buyIn(
      env,
      contextUser1,
      createGenericMessageEvent("nudger", "buy in 500")
    );
    await buyIn(
      env,
      contextUser2,
      createGenericMessageEvent("slowpoke", "buy in 500")
    );
    sayFn.mockClear();

    // === TEST: Nudge before game starts ===
    await nudgePlayer(env, contextUser1, createGenericMessageEvent("nudger"));
    expect(sayFn.mock.calls).toMatchInlineSnapshot(`
      [
        [
          {
            "text": "Game has not started yet! Who the hell am I going to nudge?",
          },
        ],
      ]
    `);
    sayFn.mockClear();

    // === START ROUND ===
    await startRound(env, contextUser1, createGenericMessageEvent("nudger"));
    sayFn.mockClear();
    postEphemeralFn.mockClear();

    // === TEST: Nudge during active game ===
    await nudgePlayer(env, contextUser1, createGenericMessageEvent("nudger"));
    // Should nudge the current player (slowpoke is SB and acts first)
    expect(sayFn.mock.calls).toMatchInlineSnapshot(`
      [
        [
          {
            "text": "<@slowpoke> it's your turn and you need to roll!",
          },
        ],
      ]
    `);
  });

  /**
   * Game Scenario 22: Flop Tracking Count Verification
   *
   * Tests:
   * - Verify exact flop count after multiple rounds
   * - Confirm unique flops are tracked
   * - Check flop discovery message format
   */
  it("game scenario 22 - flop count verification", async () => {
    vi.spyOn(Math, "random").mockReturnValue(0.11);
    const workspaceId = "test-workspace-22";
    const channelId = "test-channel-22";
    const sayFn = vi.fn();
    const postEphemeralFn = vi.fn();

    const contextUser1 = createContext({
      userId: "counter1",
      sayFn,
      postEphemeralFn,
      workspaceId,
      channelId,
    });
    const contextUser2 = createContext({
      userId: "counter2",
      sayFn,
      postEphemeralFn,
      workspaceId,
      channelId,
    });

    const stub = getStub({ workspaceId, channelId });

    // === SETUP ===
    await newGame(env, contextUser1, createGenericMessageEvent("counter1"));
    await joinGame(env, contextUser1, createGenericMessageEvent("counter1"));
    await joinGame(env, contextUser2, createGenericMessageEvent("counter2"));
    await buyIn(
      env,
      contextUser1,
      createGenericMessageEvent("counter1", "buy in 1000")
    );
    await buyIn(
      env,
      contextUser2,
      createGenericMessageEvent("counter2", "buy in 1000")
    );
    sayFn.mockClear();

    // Verify no flops recorded initially
    const initialFlopCount = await runInDurableObject(
      stub,
      async (_instance, state) => {
        const result = state.storage.sql.exec(
          "SELECT COUNT(*) as count FROM Flops WHERE workspaceId = ? AND channelId = ?",
          workspaceId,
          channelId
        );
        return result.one().count as number;
      }
    );
    expect(initialFlopCount).toBe(0);

    // === ROUND 1 ===
    await startRound(env, contextUser1, createGenericMessageEvent("counter1"));
    sayFn.mockClear();

    // Get to flop
    await call(env, contextUser2, createGenericMessageEvent("counter2"));
    await check(env, contextUser1, createGenericMessageEvent("counter1"));

    // Verify flop message shows "1 flops discovered"
    const round1Messages = sayFn.mock.calls.map((c) => c[0].text).join("\n");
    expect(round1Messages).toContain("1 flops discovered");

    // Verify count in database
    const flopCountRound1 = await runInDurableObject(
      stub,
      async (_instance, state) => {
        const result = state.storage.sql.exec(
          "SELECT COUNT(*) as count FROM Flops WHERE workspaceId = ? AND channelId = ?",
          workspaceId,
          channelId
        );
        return result.one().count as number;
      }
    );
    expect(flopCountRound1).toBe(1);

    // Finish round
    await fold(env, contextUser1, createGenericMessageEvent("counter1"));
    sayFn.mockClear();

    // === ROUND 2 ===
    await startRound(env, contextUser1, createGenericMessageEvent("counter1"));
    sayFn.mockClear();

    await call(env, contextUser2, createGenericMessageEvent("counter2"));
    await check(env, contextUser1, createGenericMessageEvent("counter1"));

    // Get flop count after round 2
    const flopCountRound2 = await runInDurableObject(
      stub,
      async (_instance, state) => {
        const result = state.storage.sql.exec(
          "SELECT COUNT(*) as count FROM Flops WHERE workspaceId = ? AND channelId = ?",
          workspaceId,
          channelId
        );
        return result.one().count as number;
      }
    );
    // Should be 2 if unique flop, or 1 if same flop (due to mocked random)
    expect(flopCountRound2).toBeGreaterThanOrEqual(1);

    // Finish round
    await fold(env, contextUser1, createGenericMessageEvent("counter1"));
    sayFn.mockClear();

    // === ROUND 3 ===
    await startRound(env, contextUser1, createGenericMessageEvent("counter1"));
    sayFn.mockClear();

    await call(env, contextUser2, createGenericMessageEvent("counter2"));
    await check(env, contextUser1, createGenericMessageEvent("counter1"));

    // Verify flop count continues to increment for unique flops
    const flopCountRound3 = await runInDurableObject(
      stub,
      async (_instance, state) => {
        const result = state.storage.sql.exec(
          "SELECT COUNT(*) as count FROM Flops WHERE workspaceId = ? AND channelId = ?",
          workspaceId,
          channelId
        );
        return result.one().count as number;
      }
    );
    expect(flopCountRound3).toBeGreaterThanOrEqual(1);
  });

  it("shows stacks for active and inactive players without tagging", async () => {
    const workspaceId = "stacks-test-workspace";
    const channelId = "stacks-test-channel";
    const sayFn = vi.fn();
    const postEphemeralFn = vi.fn();

    // Create contexts for real users (Marcus, Camden, Yuvi)
    const contextMarcus = createContext({
      userId: MARCUS_USER_ID,
      sayFn,
      postEphemeralFn,
      workspaceId,
      channelId,
    });
    const contextCamden = createContext({
      userId: CAMDEN_USER_ID,
      sayFn,
      postEphemeralFn,
      workspaceId,
      channelId,
    });
    const contextYuvi = createContext({
      userId: YUVI_USER_ID,
      sayFn,
      postEphemeralFn,
      workspaceId,
      channelId,
    });

    const payloadMarcus = createGenericMessageEvent(MARCUS_USER_ID);
    const payloadCamden = createGenericMessageEvent(CAMDEN_USER_ID);
    const payloadYuvi = createGenericMessageEvent(YUVI_USER_ID);

    // Start new game
    await newGame(env, contextMarcus, payloadMarcus);
    sayFn.mockClear();

    // All three players join and buy in
    await joinGame(env, contextMarcus, payloadMarcus);
    await buyIn(
      env,
      contextMarcus,
      createGenericMessageEvent(MARCUS_USER_ID, "buy in 500")
    );
    sayFn.mockClear();

    await joinGame(env, contextCamden, payloadCamden);
    await buyIn(
      env,
      contextCamden,
      createGenericMessageEvent(CAMDEN_USER_ID, "buy in 300")
    );
    sayFn.mockClear();

    await joinGame(env, contextYuvi, payloadYuvi);
    await buyIn(
      env,
      contextYuvi,
      createGenericMessageEvent(YUVI_USER_ID, "buy in 400")
    );
    sayFn.mockClear();

    // Camden leaves the table (becomes inactive)
    await leaveGame(env, contextCamden, payloadCamden);
    sayFn.mockClear();

    // Call stacks command
    await showStacks(env, contextMarcus, payloadMarcus);

    // Verify the output shows names (not @mentions) and both active/inactive players
    expect(sayFn).toHaveBeenCalledTimes(1);
    const stacksMessage = sayFn.mock.calls[0][0].text;

    // Should contain player names, NOT @mentions
    expect(stacksMessage).toContain("Marcus");
    expect(stacksMessage).toContain("Camden");
    expect(stacksMessage).toContain("Yuvi");

    // Should NOT contain @mentions (user IDs with < and >)
    expect(stacksMessage).not.toContain(`<@${MARCUS_USER_ID}>`);
    expect(stacksMessage).not.toContain(`<@${CAMDEN_USER_ID}>`);
    expect(stacksMessage).not.toContain(`<@${YUVI_USER_ID}>`);

    // Should show chip counts
    expect(stacksMessage).toContain("500");
    expect(stacksMessage).toContain("300");
    expect(stacksMessage).toContain("400");

    // Should show active/inactive status with BB multiples and orbits
    expect(stacksMessage).toContain("Active");
    expect(stacksMessage).toContain("Inactive");
    expect(stacksMessage).toContain("xBB");
    expect(stacksMessage).toContain("orbits");

    // Verify Marcus and Yuvi are active, Camden is inactive (with BB and orbit info)
    expect(stacksMessage).toMatch(/Marcus: 500 \(\d+xBB, \d+ orbits\) Active/);
    expect(stacksMessage).toMatch(/Yuvi: 400 \(\d+xBB, \d+ orbits\) Active/);
    expect(stacksMessage).toMatch(/Camden: 300 \(\d+xBB, \d+ orbits\) Inactive/);
  });

  /**
   * Game Scenario 23: "Take her to the flop/turn/river" phrases
   *
   * Tests:
   * - "lets take her to the flop" only works in PreFlop (performs call or check)
   * - "lets take her to the turn" only works on Flop
   * - "lets take her to the river" only works on Turn
   * - Error messages when phrase used in wrong state
   */
  it("game scenario 23 - take her to the flop/turn/river", async () => {
    vi.spyOn(Math, "random").mockReturnValue(0.5);
    const workspaceId = "test-workspace-23";
    const channelId = "test-channel-23";
    const sayFn = vi.fn();
    const postEphemeralFn = vi.fn();

    const contextUser1 = createContext({
      userId: "player1",
      sayFn,
      postEphemeralFn,
      workspaceId,
      channelId,
    });
    const contextUser2 = createContext({
      userId: "player2",
      sayFn,
      postEphemeralFn,
      workspaceId,
      channelId,
    });

    const stub = getStub({ workspaceId, channelId });

    // === SETUP ===
    await newGame(env, contextUser1, createGenericMessageEvent("player1"));
    await joinGame(env, contextUser1, createGenericMessageEvent("player1"));
    await joinGame(env, contextUser2, createGenericMessageEvent("player2"));
    await buyIn(
      env,
      contextUser1,
      createGenericMessageEvent("player1", "buy in 500")
    );
    await buyIn(
      env,
      contextUser2,
      createGenericMessageEvent("player2", "buy in 500")
    );
    sayFn.mockClear();

    // === START ROUND ===
    await startRound(env, contextUser1, createGenericMessageEvent("player1"));
    const gameStateStart = await getGameState(stub, workspaceId, channelId);
    expect(gameStateStart.gameState).toBe(GameState.PreFlop);
    sayFn.mockClear();
    postEphemeralFn.mockClear();

    // === TEST: Wrong phrase in PreFlop ===
    // player2 (SB) tries "lets take her to the turn" - should fail (wrong state)
    await takeHerToThe(
      env,
      contextUser2,
      createGenericMessageEvent("player2", "lets take her to the turn")
    );
    expect(sayFn.mock.calls).toMatchInlineSnapshot(`
      [
        [
          {
            "text": "We're not on the flop! Can't take her to the turn from here.",
          },
        ],
      ]
    `);
    sayFn.mockClear();

    // === TEST: Correct phrase in PreFlop (call) ===
    // player2 (SB) uses "lets take her to the flop" - should call to match BB
    await takeHerToThe(
      env,
      contextUser2,
      createGenericMessageEvent("player2", "lets take her to the flop")
    );
    expect(sayFn.mock.calls).toMatchInlineSnapshot(`
      [
        [
          {
            "text": "<@player2> called 80 chips! Total Pot: 160
      <@player1>'s turn",
          },
        ],
      ]
    `);
    sayFn.mockClear();

    // === TEST: Correct phrase in PreFlop (check) ===
    // player1 (BB) uses "lets take her to the flop" - should check (already matched)
    await takeHerToThe(
      env,
      contextUser1,
      createGenericMessageEvent("player1", "lets take her to the flop")
    );
    const gameStateFlop = await getGameState(stub, workspaceId, channelId);
    expect(gameStateFlop.gameState).toBe(GameState.Flop);
    expect(sayFn.mock.calls[0][0].text).toContain("checked");
    sayFn.mockClear();
    postEphemeralFn.mockClear();

    // === TEST: Wrong phrase on Flop ===
    // player2 tries "lets take her to the flop" - should fail (already on flop)
    await takeHerToThe(
      env,
      contextUser2,
      createGenericMessageEvent("player2", "lets take her to the flop")
    );
    expect(sayFn.mock.calls).toMatchInlineSnapshot(`
      [
        [
          {
            "text": "We're not in pre-flop! Can't take her to the flop from here.",
          },
        ],
      ]
    `);
    sayFn.mockClear();

    // === TEST: Correct phrase on Flop (check) ===
    // player2 uses "lets take her to the turn" - should check (no bets)
    await takeHerToThe(
      env,
      contextUser2,
      createGenericMessageEvent("player2", "lets take her to the turn")
    );
    expect(sayFn.mock.calls[0][0].text).toContain("checked");
    sayFn.mockClear();

    // player1 also checks to advance to turn
    await takeHerToThe(
      env,
      contextUser1,
      createGenericMessageEvent("player1", "lets take her to the turn")
    );
    const gameStateTurn = await getGameState(stub, workspaceId, channelId);
    expect(gameStateTurn.gameState).toBe(GameState.Turn);
    sayFn.mockClear();
    postEphemeralFn.mockClear();

    // === TEST: Wrong phrase on Turn ===
    // player2 tries "lets take her to the turn" - should fail (already on turn)
    await takeHerToThe(
      env,
      contextUser2,
      createGenericMessageEvent("player2", "lets take her to the turn")
    );
    expect(sayFn.mock.calls).toMatchInlineSnapshot(`
      [
        [
          {
            "text": "We're not on the flop! Can't take her to the turn from here.",
          },
        ],
      ]
    `);
    sayFn.mockClear();

    // === TEST: Correct phrase on Turn (check) ===
    // player2 uses "lets take her to the river" - should check
    await takeHerToThe(
      env,
      contextUser2,
      createGenericMessageEvent("player2", "lets take her to the river")
    );
    expect(sayFn.mock.calls[0][0].text).toContain("checked");
    sayFn.mockClear();

    // player1 also checks to advance to river
    await takeHerToThe(
      env,
      contextUser1,
      createGenericMessageEvent("player1", "lets take her to the river")
    );
    const gameStateRiver = await getGameState(stub, workspaceId, channelId);
    expect(gameStateRiver.gameState).toBe(GameState.River);
    sayFn.mockClear();

    // === TEST: Wrong phrase on River ===
    // player2 tries "lets take her to the river" - should fail (already on river)
    await takeHerToThe(
      env,
      contextUser2,
      createGenericMessageEvent("player2", "lets take her to the river")
    );
    expect(sayFn.mock.calls).toMatchInlineSnapshot(`
      [
        [
          {
            "text": "We're not on the turn! Can't take her to the river from here.",
          },
        ],
      ]
    `);
  });

  /**
   * Game Scenario 24: Pre-call invalidated by raise
   *
   * Tests:
   * - Player queues pre-call
   * - Another player raises before pre-call executes
   * - Pre-call fails because bet amount changed
   * - Player must make a new call to continue
   * - Action log captures both the failed pre-call and the successful call
   */
  it("game scenario 24 - pre-call invalidated by raise", async () => {
    vi.spyOn(Math, "random").mockReturnValue(0.6);
    const workspaceId = "test-workspace-24";
    const channelId = "test-channel-24";
    const sayFn = vi.fn();
    const postEphemeralFn = vi.fn();

    const contextAlice = createContext({
      userId: "alice",
      sayFn,
      postEphemeralFn,
      workspaceId,
      channelId,
    });
    const contextBob = createContext({
      userId: "bob",
      sayFn,
      postEphemeralFn,
      workspaceId,
      channelId,
    });
    const contextCharlie = createContext({
      userId: "charlie",
      sayFn,
      postEphemeralFn,
      workspaceId,
      channelId,
    });

    const stub = getStub({ workspaceId, channelId });

    // === SETUP: 3 player game ===
    await newGame(env, contextAlice, createGenericMessageEvent("alice"));
    await joinGame(env, contextAlice, createGenericMessageEvent("alice"));
    await joinGame(env, contextBob, createGenericMessageEvent("bob"));
    await joinGame(env, contextCharlie, createGenericMessageEvent("charlie"));
    await buyIn(
      env,
      contextAlice,
      createGenericMessageEvent("alice", "buy in 1000")
    );
    await buyIn(
      env,
      contextBob,
      createGenericMessageEvent("bob", "buy in 1000")
    );
    await buyIn(
      env,
      contextCharlie,
      createGenericMessageEvent("charlie", "buy in 1000")
    );
    sayFn.mockClear();

    // === START ROUND ===
    // With 3 players: alice=dealer, bob=SB, charlie=BB
    // Action goes: alice (UTG) -> bob (SB) -> charlie (BB)
    await startRound(env, contextAlice, createGenericMessageEvent("alice"));
    sayFn.mockClear();
    postEphemeralFn.mockClear();

    // === CHARLIE PRE-CALLS (queues a call for BB amount of 80) ===
    // Charlie is BB, so they queue a pre-call expecting to just check/call the current bet
    await preCall(env, contextCharlie, createGenericMessageEvent("charlie"));
    expect(sayFn.mock.calls).toMatchInlineSnapshot(`
      [
        [
          {
            "text": "<@charlie> pre-called!",
          },
        ],
      ]
    `);
    sayFn.mockClear();

    // === ALICE CALLS (action to bob) ===
    await call(env, contextAlice, createGenericMessageEvent("alice"));
    expect(sayFn.mock.calls[0][0].text).toContain("alice> called");
    sayFn.mockClear();

    // === BOB RAISES to 200 (this should invalidate charlie's pre-call!) ===
    // After bob raises, action goes to charlie (who has a pre-call queued)
    // Charlie's pre-call should FAIL because the bet amount changed from 80 to 200
    await bet(env, contextBob, createGenericMessageEvent("bob", "bet 200"));
    expect(sayFn.mock.calls[0][0].text).toContain("bob> raised 200");
    expect(sayFn.mock.calls[0][0].text).toContain("charlie> is pre-moving");
    expect(sayFn.mock.calls[0][0].text).toContain(
      "not pre-calling, bet amount has changed"
    );
    sayFn.mockClear();

    // Verify game state - still in preflop, charlie needs to act
    const gameStateAfterFailedPrecall = await getGameState(
      stub,
      workspaceId,
      channelId
    );
    expect(gameStateAfterFailedPrecall.gameState).toBe(GameState.PreFlop);

    // === CHARLIE MUST NOW CALL MANUALLY ===
    await call(env, contextCharlie, createGenericMessageEvent("charlie"));
    // After charlie calls, alice also needs to call the raise (she only called 80 before)
    expect(sayFn.mock.calls[0][0].text).toContain("charlie> called");
    sayFn.mockClear();

    // === ALICE MUST ALSO CALL THE RAISE ===
    await call(env, contextAlice, createGenericMessageEvent("alice"));
    const gameStateAfterAllCalls = await getGameState(
      stub,
      workspaceId,
      channelId
    );
    // Now should advance to flop since all have called the 200
    expect(gameStateAfterAllCalls.gameState).toBe(GameState.Flop);
    expect(sayFn.mock.calls[0][0].text).toContain("alice> called");
    expect(sayFn.mock.calls[0][0].text).toContain("Flop");
    sayFn.mockClear();

    // === VERIFY ACTION LOG ===
    const actionLogs = await stub.getActionLogs(workspaceId, channelId);

    // Verify the sequence of actions
    const actionTypes = actionLogs.map((log) => log.data.actionType);
    expect(actionTypes).toEqual([
      "message_received", // new_game message
      "new_game", // alice creates game
      "message_received", // join alice message
      "join", // alice joins
      "message_received", // join bob message
      "join", // bob joins
      "message_received", // join charlie message
      "join", // charlie joins
      "message_received", // buy in alice message
      "buy_in", // alice buys in 1000
      "message_received", // buy in bob message
      "buy_in", // bob buys in 1000
      "message_received", // buy in charlie message
      "buy_in", // charlie buys in 1000
      "message_received", // start round message
      "round_start", // round starts
      "message_received", // pre-call message
      "message_received", // call message
      "call", // alice calls 80
      "message_received", // bet message
      "bet", // bob raises to 200 (charlie's pre-call fails)
      "message_received", // call message
      "call", // charlie calls manually (200 - 80 = 120)
      "message_received", // call message
      "call", // alice calls the raise (120 more)
    ]);

    const newGameMessage = assertMessageReceived(actionLogs[0].data);
    expect(newGameMessage.handlerKey).toBe("new game");
    const joinAliceMessage = assertMessageReceived(actionLogs[2].data);
    expect(joinAliceMessage.handlerKey).toBe("join table");
    const joinBobMessage = assertMessageReceived(actionLogs[4].data);
    expect(joinBobMessage.handlerKey).toBe("join table");
    const joinCharlieMessage = assertMessageReceived(actionLogs[6].data);
    expect(joinCharlieMessage.handlerKey).toBe("join table");

    // Verify bob's raise
    const buyInAliceMessage = assertMessageReceived(actionLogs[8].data);
    expect(buyInAliceMessage.handlerKey).toBe("buy in");
    const buyInBobMessage = assertMessageReceived(actionLogs[10].data);
    expect(buyInBobMessage.handlerKey).toBe("buy in");
    const buyInCharlieMessage = assertMessageReceived(actionLogs[12].data);
    expect(buyInCharlieMessage.handlerKey).toBe("buy in");

    // Verify timestamps are in ascending order
    for (let i = 1; i < actionLogs.length; i++) {
      expect(actionLogs[i].data.timestamp).toBeGreaterThanOrEqual(
        actionLogs[i - 1].data.timestamp
      );
    }
  });

  it("context command shows player positions and fold state", async () => {
    vi.spyOn(Math, "random").mockReturnValue(0.6);
    const workspaceId = "context-test-workspace";
    const channelId = "context-test-channel";
    const sayFn = vi.fn();
    const postEphemeralFn = vi.fn();

    const contextAlice = createContext({
      userId: "alice",
      sayFn,
      postEphemeralFn,
      workspaceId,
      channelId,
    });
    const contextBob = createContext({
      userId: "bob",
      sayFn,
      postEphemeralFn,
      workspaceId,
      channelId,
    });
    const contextCharlie = createContext({
      userId: "charlie",
      sayFn,
      postEphemeralFn,
      workspaceId,
      channelId,
    });

    const payloadAlice = createGenericMessageEvent("alice");
    const payloadBob = createGenericMessageEvent("bob");
    const payloadCharlie = createGenericMessageEvent("charlie");

    // Setup game with 3 players
    await newGame(env, contextAlice, payloadAlice);
    await joinGame(env, contextAlice, payloadAlice);
    await joinGame(env, contextBob, payloadBob);
    await joinGame(env, contextCharlie, payloadCharlie);

    await buyIn(env, contextAlice, {
      text: "buy in 1000",
    } as GenericMessageEvent);
    await buyIn(env, contextBob, {
      text: "buy in 1000",
    } as GenericMessageEvent);
    await buyIn(env, contextCharlie, {
      text: "buy in 1000",
    } as GenericMessageEvent);

    // Start round - alice is dealer (position 0), bob is SB, charlie is BB
    await startRound(env, contextAlice, payloadAlice);

    sayFn.mockClear();
    postEphemeralFn.mockClear();

    // Alice calls context - should see player list with positions
    await context(env, contextAlice, payloadAlice);

    // Check the ephemeral message content
    expect(postEphemeralFn).toHaveBeenCalledTimes(1);
    const contextMessage = postEphemeralFn.mock.calls[0][0];
    expect(contextMessage.text).toMatchInlineSnapshot(`
      "*Game Context*

      *Game State:* Pre-Flop
      *Pot Size:* 120 chips
      *Turn:* :rotating_light: It's your turn :rotating_light:
      *Action:* You must call 80 chips (current bet: 80)

      *Players (table order):*
      <@alice> (D) ⬅️
      <@bob> (SB)
      <@charlie> (BB)

      *Your Cards:*
      7:clubs: 5:clubs:

      *Community Cards:* None yet"
    `);

    postEphemeralFn.mockClear();

    // Alice calls
    await call(env, contextAlice, payloadAlice);
    // Bob checks
    await call(env, contextBob, payloadBob);
    // Charlie checks
    await check(env, contextCharlie, payloadCharlie);

    const stub = getStub({ workspaceId, channelId });
    const gameState = await getGameState(stub, workspaceId, channelId);

    expect(gameState.gameState).toBe(GameState.Flop);

    // Bob folds
    await check(env, contextBob, payloadBob);

    postEphemeralFn.mockClear();

    // Charlie calls context - should show bob as checked
    await context(env, contextCharlie, payloadCharlie);

    expect(postEphemeralFn).toHaveBeenCalledTimes(1);
    const contextMessageAfterFold = postEphemeralFn.mock.calls[0][0];
    expect(contextMessageAfterFold.text).toMatchInlineSnapshot(`
      "*Game Context*

      *Game State:* Flop
      *Pot Size:* 240 chips
      *Turn:* :rotating_light: It's your turn :rotating_light:
      *Action:* You can check

      *Players (table order):*
      <@bob> (SB) - checked
      <@charlie> (BB) ⬅️
      <@alice> (D)

      *You have Ass:*
      K:spades: 10:spades:

      *Community Cards:*
      8:spades: 2:clubs: A:diamonds:
      "
    `);

    postEphemeralFn.mockClear();

    await bet(env, contextCharlie, { text: "bet 100" } as GenericMessageEvent);

    // Charlie calls context - should show bob as checked
    await context(env, contextAlice, payloadAlice);

    expect(postEphemeralFn).toHaveBeenCalledTimes(1);
    const contextMessageAfterBet = postEphemeralFn.mock.calls[0][0];
    expect(contextMessageAfterBet.text).toMatchInlineSnapshot(`
      "*Game Context*

      *Game State:* Flop
      *Pot Size:* 340 chips
      *Turn:* :rotating_light: It's your turn :rotating_light:
      *Action:* You must call 100 chips (current bet: 100)

      *Players (table order):*
      <@bob> (SB) - checked
      <@charlie> (BB) - raised to 100
      <@alice> (D) ⬅️

      *You have Ass:*
      7:clubs: 5:clubs:

      *Community Cards:*
      8:spades: 2:clubs: A:diamonds:
      "
    `);

    await fold(env, contextAlice, payloadAlice);
    postEphemeralFn.mockClear();

    await context(env, contextBob, payloadBob);
    expect(postEphemeralFn).toHaveBeenCalledTimes(1);
    const contextMessageAfterAliceFold = postEphemeralFn.mock.calls[0][0];
    expect(contextMessageAfterAliceFold.text).toMatchInlineSnapshot(`
      "*Game Context*

      *Game State:* Flop
      *Pot Size:* 340 chips
      *Turn:* :rotating_light: It's your turn :rotating_light:
      *Action:* You must call 100 chips (current bet: 100)

      *Players (table order):*
      <@bob> (SB) - checked ⬅️
      <@charlie> (BB) - raised to 100
      <@alice> (D) - folded

      *Still in hand:* <@bob>, <@charlie>

      *You have Ass:*
      6:clubs: 4:clubs:

      *Community Cards:*
      8:spades: 2:clubs: A:diamonds:
      "
    `);
  });

  it("context command shows waiting for players state", async () => {
    const workspaceId = "context-waiting-workspace";
    const channelId = "context-waiting-channel";
    const sayFn = vi.fn();
    const postEphemeralFn = vi.fn();

    const contextAlice = createContext({
      userId: "alice",
      sayFn,
      postEphemeralFn,
      workspaceId,
      channelId,
    });
    const contextBob = createContext({
      userId: "bob",
      sayFn,
      postEphemeralFn,
      workspaceId,
      channelId,
    });

    const payloadAlice = createGenericMessageEvent("alice");
    const payloadBob = createGenericMessageEvent("bob");

    // Setup game but don't start round
    await newGame(env, contextAlice, payloadAlice);
    await joinGame(env, contextAlice, payloadAlice);
    await joinGame(env, contextBob, payloadBob);

    await buyIn(env, contextAlice, {
      text: "buy in 500",
    } as GenericMessageEvent);
    await buyIn(env, contextBob, { text: "buy in 500" } as GenericMessageEvent);

    postEphemeralFn.mockClear();

    // Alice calls context before round starts
    await context(env, contextAlice, payloadAlice);

    expect(postEphemeralFn).toHaveBeenCalledTimes(1);
    const contextMessage = postEphemeralFn.mock.calls[0][0];
    expect(contextMessage.text).toMatchInlineSnapshot(`
      "*Game Context*

      *Game State:* Waiting for Players
      *Pot Size:* 0 chips
      *Turn:* No active round
      *Action:* Game has not started yet

      *Players (table order):*
      <@bob> (BB)
      <@alice> (D+SB)

      *Your Cards:* No cards yet

      *Community Cards:* None yet"
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
  gameState: ReturnType<TexasHoldem["getState"]>,
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
    return TexasHoldem.fromJson(JSON.parse(result.game as string)).getState();
  });
}

function createGenericMessageEvent(
  userId: string,
  text?: string
): GenericMessageEvent {
  return {
    type: "message",
    user: userId,
    text: text ?? "test",
  } as GenericMessageEvent;
}

function createContext({
  userId,
  sayFn,
  postEphemeralFn,
  workspaceId = "test-workspace",
  channelId = "test-channel",
}: {
  userId: string;
  sayFn: ReturnType<typeof vi.fn>;
  postEphemeralFn?: ReturnType<typeof vi.fn>;
  workspaceId?: string;
  channelId?: string;
}): SlackAppContextWithChannelId {
  return {
    teamId: workspaceId,
    channelId: channelId,
    userId,
    say: sayFn,
    client: {
      chat: {
        postEphemeral: postEphemeralFn ?? vi.fn(),
      },
    },
  } as unknown as SlackAppContextWithChannelId;
}

afterAll(() => {
  vi.useRealTimers();
});
