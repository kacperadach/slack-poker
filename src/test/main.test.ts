import { env, runInDurableObject } from "cloudflare:test";
import { describe, it, expect, vi } from "vitest";
import { GameState, TexasHoldem } from "../Game";
import {
  buyIn,
  joinGame,
  newGame,
  preDeal,
  preNH,
  startRound,
  call,
  check,
  fold,
  bet,
  preCheck,
  preFold,
  preCall,
  cashOut,
  leaveGame,
} from "..";

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
    vi.spyOn(Math, "random").mockReturnValue(0.6);
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
    await call(env, contextUser1, null);
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
    await check(env, contextUser2, null);
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
    await check(env, contextUser1, null);
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
    await check(env, contextUser2, null);
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
    await check(env, contextUser1, null);
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
    await check(env, contextUser2, null);
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
    await check(env, contextUser1, null);
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
    await check(env, contextUser2, null);
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
    await startRound(env, contextUser1, null);
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
    await fold(env, contextUser2, null);
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

    const contextUser1 = {
      teamId: workspaceId,
      channelId: channelId,
      userId: "alice",
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
      userId: "bob",
      say: sayFn,
      client: {
        chat: {
          postEphemeral: postEphemeralFn,
        },
      },
    };

    const stub = getStub({ workspaceId, channelId });

    // === GAME SETUP ===
    await newGame(env, contextUser1);
    sayFn.mockClear();

    // Both players join
    await joinGame(env, contextUser1);
    sayFn.mockClear();
    await joinGame(env, contextUser2);
    sayFn.mockClear();

    // Both players buy in
    await buyIn(env, contextUser1, { text: "buy in 500" });
    const gameStateAfterBuyIn1 = await getGameState(
      stub,
      workspaceId,
      channelId
    );
    expect(getPlayerById(gameStateAfterBuyIn1, "alice")?.chips).toBe(500);
    sayFn.mockClear();

    await buyIn(env, contextUser2, { text: "buy in 500" });
    const gameStateAfterBuyIn2 = await getGameState(
      stub,
      workspaceId,
      channelId
    );
    expect(getPlayerById(gameStateAfterBuyIn2, "bob")?.chips).toBe(500);
    sayFn.mockClear();

    // === ROUND 1: PREFLOP ===
    await startRound(env, contextUser1, null);
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
    await bet(env, contextUser2, { text: "bet 160" });
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
    await call(env, contextUser1, null);
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
    await bet(env, contextUser2, { text: "bet 100" });
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
    await call(env, contextUser1, null);
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
    await bet(env, contextUser2, { text: "bet 150" });
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
    await fold(env, contextUser1, null);
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

    const contextUser1 = {
      teamId: workspaceId,
      channelId: channelId,
      userId: "player1",
      say: sayFn,
      client: { chat: { postEphemeral: postEphemeralFn } },
    };

    const contextUser2 = {
      teamId: workspaceId,
      channelId: channelId,
      userId: "player2",
      say: sayFn,
      client: { chat: { postEphemeral: postEphemeralFn } },
    };

    const stub = getStub({ workspaceId, channelId });

    // === SETUP ===
    await newGame(env, contextUser1);
    sayFn.mockClear();

    await joinGame(env, contextUser1);
    await joinGame(env, contextUser2);
    sayFn.mockClear();

    // Different stack sizes to test all-in dynamics
    await buyIn(env, contextUser1, { text: "buy in 300" });
    await buyIn(env, contextUser2, { text: "buy in 300" });
    sayFn.mockClear();

    // === START ROUND ===
    await startRound(env, contextUser1, null);
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
    await bet(env, contextUser2, { text: "bet 300" });
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
      <@player2> raised 300 chips! and went all-in! Total Pot: 380",
          },
        ],
      ]
    `);
    sayFn.mockClear();
    postEphemeralFn.mockClear();

    // player1 (BB) calls the all-in - this should trigger automatic showdown
    await call(env, contextUser1, null);
    const gameStateAfterCall = await getGameState(stub, workspaceId, channelId);

    // Game should be back to WaitingForPlayers after showdown
    expect(gameStateAfterCall.gameState).toBe(GameState.WaitingForPlayers);

    // Verify showdown happened with all 5 community cards
    expect(sayFn.mock.calls).toMatchInlineSnapshot(`
      [
        [
          {
            "text": "<@player1> called 300 chips and went all-in! Total Pot: 600
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

    const contextAlice = {
      teamId: workspaceId,
      channelId: channelId,
      userId: "alice",
      say: sayFn,
      client: { chat: { postEphemeral: postEphemeralFn } },
    };

    const contextBob = {
      teamId: workspaceId,
      channelId: channelId,
      userId: "bob",
      say: sayFn,
      client: { chat: { postEphemeral: postEphemeralFn } },
    };

    const contextCharlie = {
      teamId: workspaceId,
      channelId: channelId,
      userId: "charlie",
      say: sayFn,
      client: { chat: { postEphemeral: postEphemeralFn } },
    };

    const stub = getStub({ workspaceId, channelId });

    // === SETUP ===
    await newGame(env, contextAlice);
    sayFn.mockClear();

    await joinGame(env, contextAlice);
    await joinGame(env, contextBob);
    await joinGame(env, contextCharlie);
    sayFn.mockClear();

    await buyIn(env, contextAlice, { text: "buy in 1000" });
    await buyIn(env, contextBob, { text: "buy in 1000" });
    await buyIn(env, contextCharlie, { text: "buy in 1000" });
    sayFn.mockClear();

    // === START ROUND ===
    await startRound(env, contextAlice, null);
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
    await call(env, contextAlice, null);
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
    await fold(env, contextBob, null);
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
    await check(env, contextCharlie, null);
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
    await bet(env, contextCharlie, { text: "bet 100" });
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
    await call(env, contextAlice, null);
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
    await check(env, contextCharlie, null);
    sayFn.mockClear();

    await check(env, contextAlice, null);
    const gameStateRiver = await getGameState(stub, workspaceId, channelId);
    expect(gameStateRiver.gameState).toBe(GameState.River);
    sayFn.mockClear();
    postEphemeralFn.mockClear();

    await check(env, contextCharlie, null);
    sayFn.mockClear();

    // alice checks - triggers showdown
    await check(env, contextAlice, null);
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

    const contextUser1 = {
      teamId: workspaceId,
      channelId: channelId,
      userId: "trapper",
      say: sayFn,
      client: { chat: { postEphemeral: postEphemeralFn } },
    };

    const contextUser2 = {
      teamId: workspaceId,
      channelId: channelId,
      userId: "victim",
      say: sayFn,
      client: { chat: { postEphemeral: postEphemeralFn } },
    };

    const stub = getStub({ workspaceId, channelId });

    // === SETUP ===
    await newGame(env, contextUser1);
    await joinGame(env, contextUser1);
    await joinGame(env, contextUser2);
    await buyIn(env, contextUser1, { text: "buy in 1000" });
    await buyIn(env, contextUser2, { text: "buy in 1000" });
    sayFn.mockClear();

    // === START ROUND ===
    await startRound(env, contextUser1, null);
    sayFn.mockClear();
    postEphemeralFn.mockClear();

    // Get through preflop with calls
    // trapper is BB, victim is SB/dealer
    await call(env, contextUser2, null); // victim calls
    sayFn.mockClear();
    await check(env, contextUser1, null); // trapper checks

    const gameStateFlop = await getGameState(stub, workspaceId, channelId);
    expect(gameStateFlop.gameState).toBe(GameState.Flop);
    sayFn.mockClear();
    postEphemeralFn.mockClear();

    // === FLOP: THE CHECK-RAISE ===
    // trapper checks (setting the trap)
    await check(env, contextUser1, null);
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
    await bet(env, contextUser2, { text: "bet 100" });
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
    await bet(env, contextUser1, { text: "bet 300" });
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
    await fold(env, contextUser2, null);
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

    const contextAlice = {
      teamId: workspaceId,
      channelId: channelId,
      userId: "alice",
      say: sayFn,
      client: { chat: { postEphemeral: postEphemeralFn } },
    };

    const contextBob = {
      teamId: workspaceId,
      channelId: channelId,
      userId: "bob",
      say: sayFn,
      client: { chat: { postEphemeral: postEphemeralFn } },
    };

    const contextCharlie = {
      teamId: workspaceId,
      channelId: channelId,
      userId: "charlie",
      say: sayFn,
      client: { chat: { postEphemeral: postEphemeralFn } },
    };

    const stub = getStub({ workspaceId, channelId });

    // === SETUP ===
    await newGame(env, contextAlice);
    await joinGame(env, contextAlice);
    await joinGame(env, contextBob);
    await joinGame(env, contextCharlie);
    await buyIn(env, contextAlice, { text: "buy in 1000" });
    await buyIn(env, contextBob, { text: "buy in 1000" });
    await buyIn(env, contextCharlie, { text: "buy in 1000" });
    sayFn.mockClear();

    // === START ROUND ===
    await startRound(env, contextAlice, null);
    sayFn.mockClear();
    postEphemeralFn.mockClear();

    // alice is first to act (after BB)
    // bob and charlie can queue pre-moves

    // charlie (BB) queues a pre-check
    await preCheck(env, contextCharlie, null);
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
    await call(env, contextAlice, null);
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
    await call(env, contextBob, null);
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
    await preFold(env, contextCharlie, null);
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
    await bet(env, contextBob, { text: "bet 100" });
    sayFn.mockClear();

    await call(env, contextAlice, null);
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
    await bet(env, contextBob, { text: "bet 100" });
    sayFn.mockClear();

    // alice uses pre-call which immediately calls since there's an active bet
    await preCall(env, contextAlice, null);
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

    const contextUser1 = {
      teamId: workspaceId,
      channelId: channelId,
      userId: "winner",
      say: sayFn,
      client: { chat: { postEphemeral: postEphemeralFn } },
    };

    const contextUser2 = {
      teamId: workspaceId,
      channelId: channelId,
      userId: "loser",
      say: sayFn,
      client: { chat: { postEphemeral: postEphemeralFn } },
    };

    const stub = getStub({ workspaceId, channelId });

    // === SETUP ===
    await newGame(env, contextUser1);
    await joinGame(env, contextUser1);
    await joinGame(env, contextUser2);
    await buyIn(env, contextUser1, { text: "buy in 500" });
    await buyIn(env, contextUser2, { text: "buy in 500" });
    sayFn.mockClear();

    // Play a quick round - loser folds
    await startRound(env, contextUser1, null);
    sayFn.mockClear();

    await fold(env, contextUser2, null);
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
    await cashOut(env, contextUser1, null);
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
    await cashOut(env, contextUser1, null);
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

    const contextUser1 = {
      teamId: workspaceId,
      channelId: channelId,
      userId: "stayer",
      say: sayFn,
      client: { chat: { postEphemeral: postEphemeralFn } },
    };

    const contextUser2 = {
      teamId: workspaceId,
      channelId: channelId,
      userId: "leaver",
      say: sayFn,
      client: { chat: { postEphemeral: postEphemeralFn } },
    };

    const stub = getStub({ workspaceId, channelId });

    // === SETUP ===
    await newGame(env, contextUser1);
    await joinGame(env, contextUser1);
    await joinGame(env, contextUser2);
    await buyIn(env, contextUser1, { text: "buy in 500" });
    await buyIn(env, contextUser2, { text: "buy in 500" });
    sayFn.mockClear();

    // Start a round
    await startRound(env, contextUser1, null);
    const gameStateDuringRound = await getGameState(
      stub,
      workspaceId,
      channelId
    );
    expect(gameStateDuringRound.gameState).toBe(GameState.PreFlop);
    sayFn.mockClear();

    // leaver tries to leave during active round
    await leaveGame(env, contextUser2);
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
    await fold(env, contextUser2, null);
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

    const contextUser1 = {
      teamId: workspaceId,
      channelId: channelId,
      userId: "player1",
      say: sayFn,
      client: { chat: { postEphemeral: postEphemeralFn } },
    };

    const contextUser2 = {
      teamId: workspaceId,
      channelId: channelId,
      userId: "player2",
      say: sayFn,
      client: { chat: { postEphemeral: postEphemeralFn } },
    };

    const contextNewPlayer = {
      teamId: workspaceId,
      channelId: channelId,
      userId: "newplayer",
      say: sayFn,
      client: { chat: { postEphemeral: postEphemeralFn } },
    };

    const stub = getStub({ workspaceId, channelId });

    // === SETUP ===
    await newGame(env, contextUser1);
    await joinGame(env, contextUser1);
    await joinGame(env, contextUser2);
    await buyIn(env, contextUser1, { text: "buy in 500" });
    await buyIn(env, contextUser2, { text: "buy in 500" });
    sayFn.mockClear();

    // Start a round
    await startRound(env, contextUser1, null);
    const gameStateDuringRound = await getGameState(
      stub,
      workspaceId,
      channelId
    );
    expect(gameStateDuringRound.gameState).toBe(GameState.PreFlop);
    expect(gameStateDuringRound.activePlayers.length).toBe(2);
    sayFn.mockClear();

    // New player tries to join during active round
    await joinGame(env, contextNewPlayer);
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
    await fold(env, contextUser2, null);

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

    const contextUser1 = {
      teamId: workspaceId,
      channelId: channelId,
      userId: "player1",
      say: sayFn,
      client: { chat: { postEphemeral: postEphemeralFn } },
    };

    const contextUser2 = {
      teamId: workspaceId,
      channelId: channelId,
      userId: "player2",
      say: sayFn,
      client: { chat: { postEphemeral: postEphemeralFn } },
    };

    const stub = getStub({ workspaceId, channelId });

    // === SETUP ===
    await newGame(env, contextUser1);
    await joinGame(env, contextUser1);
    await joinGame(env, contextUser2);
    await buyIn(env, contextUser1, { text: "buy in 500" });
    await buyIn(env, contextUser2, { text: "buy in 500" });
    sayFn.mockClear();

    // Start round - player2 is SB/dealer, player1 is BB
    // So player2 acts first
    await startRound(env, contextUser1, null);
    sayFn.mockClear();
    postEphemeralFn.mockClear();

    // player1 (BB) tries to act but it's player2's turn
    await check(env, contextUser1, null);
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

    await bet(env, contextUser1, { text: "bet 100" });
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

    await fold(env, contextUser1, null);
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
    await call(env, contextUser2, null);
    sayFn.mockClear();

    // Now it's player1's turn - after player2 calls, player1 (BB) can check
    await check(env, contextUser1, null);
    // This should advance to flop
    const gameStateFlop = await getGameState(stub, workspaceId, channelId);
    expect(gameStateFlop.gameState).toBe(GameState.Flop);
    sayFn.mockClear();

    // On flop, player2 acts first (SB/dealer acts first in heads-up post-flop in this game)
    // player2 bets 100 (minimum bet is 80)
    await bet(env, contextUser2, { text: "bet 100" });
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
    await check(env, contextUser1, null);
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

    const contextUser1 = {
      teamId: workspaceId,
      channelId: channelId,
      userId: "dealer",
      say: sayFn,
      client: { chat: { postEphemeral: postEphemeralFn } },
    };

    const contextUser2 = {
      teamId: workspaceId,
      channelId: channelId,
      userId: "player",
      say: sayFn,
      client: { chat: { postEphemeral: postEphemeralFn } },
    };

    const stub = getStub({ workspaceId, channelId });

    // === SETUP ===
    await newGame(env, contextUser1);
    await joinGame(env, contextUser1);
    await joinGame(env, contextUser2);
    await buyIn(env, contextUser1, { text: "buy in 1000" });
    await buyIn(env, contextUser2, { text: "buy in 1000" });
    sayFn.mockClear();

    // Start first round
    await startRound(env, contextUser1, null);
    const gameStateRound1 = await getGameState(stub, workspaceId, channelId);
    expect(gameStateRound1.gameState).toBe(GameState.PreFlop);
    sayFn.mockClear();

    // Queue up pre-deal during active round
    await preDeal(env, contextUser1, null);
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
    await fold(env, contextUser2, null);

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

    const contextUser1 = {
      teamId: workspaceId,
      channelId: channelId,
      userId: "polite",
      say: sayFn,
      client: { chat: { postEphemeral: postEphemeralFn } },
    };

    const contextUser2 = {
      teamId: workspaceId,
      channelId: channelId,
      userId: "winner",
      say: sayFn,
      client: { chat: { postEphemeral: postEphemeralFn } },
    };

    const stub = getStub({ workspaceId, channelId });

    // === SETUP ===
    await newGame(env, contextUser1);
    await joinGame(env, contextUser1);
    await joinGame(env, contextUser2);
    await buyIn(env, contextUser1, { text: "buy in 500" });
    await buyIn(env, contextUser2, { text: "buy in 500" });
    sayFn.mockClear();

    // Start round
    await startRound(env, contextUser1, null);
    sayFn.mockClear();

    // polite player queues pre-NH
    await preNH(env, contextUser1, null);
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
    await fold(env, contextUser2, null);

    // Check that :nh: message appeared
    const endMessages = sayFn.mock.calls[0][0].text;
    expect(endMessages).toContain("<@polite> says :nh:");
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
