import { strict as assert } from "assert";
import { TexasHoldem, GameState, Success } from "./Game";

const PLAYER_1 = "player1";
const PLAYER_2 = "player2";
const PLAYER_3 = "player3";

function test(description: string, testFn: () => void) {
  try {
    testFn();
    console.log(`✅ ${description}`);
  } catch (error) {
    console.error(`❌ ${description}`);
    console.error(error);
  }
}

test("Betting history tracks blinds at round start", () => {
  const game = new TexasHoldem();

  game.addPlayer(PLAYER_1);
  game.addPlayer(PLAYER_2);
  game.buyIn(PLAYER_1, 1000);
  game.buyIn(PLAYER_2, 1000);

  game.startRound(PLAYER_1);

  const actions = game.getBettingHistory();

  assert(actions.length >= 2, "Should have at least 2 actions (blinds)");

  const smallBlindAction = actions.find((a) => a.actionType === "small_blind");
  const bigBlindAction = actions.find((a) => a.actionType === "big_blind");

  assert(smallBlindAction, "Should have small blind action");
  assert(bigBlindAction, "Should have big blind action");

  assert.equal(smallBlindAction?.street, "preflop", "Small blind should be preflop");
  assert.equal(bigBlindAction?.street, "preflop", "Big blind should be preflop");

  assert.equal(smallBlindAction?.amount, game.getSmallBlind(), "Small blind amount");
  assert.equal(bigBlindAction?.amount, game.getBigBlind(), "Big blind amount");
});

test("Betting history tracks check actions", () => {
  const game = new TexasHoldem();

  game.addPlayer(PLAYER_1);
  game.addPlayer(PLAYER_2);
  game.buyIn(PLAYER_1, 1000);
  game.buyIn(PLAYER_2, 1000);

  game.startRound(PLAYER_1);

  const currentPlayer = game.getCurrentPlayer();
  assert(currentPlayer, "Should have current player");

  game.call(currentPlayer.getId());

  const nextPlayer = game.getCurrentPlayer();
  assert(nextPlayer, "Should have next player");

  game.check(nextPlayer.getId());

  const checkActions = game.getBettingHistory().filter((a) => a.actionType === "check");

  assert(checkActions.length >= 1, "Should have at least 1 check action");
  assert.equal(checkActions[0].street, "preflop", "Check should be preflop");
});

test("Betting history tracks call actions", () => {
  const game = new TexasHoldem();

  game.addPlayer(PLAYER_1);
  game.addPlayer(PLAYER_2);
  game.buyIn(PLAYER_1, 1000);
  game.buyIn(PLAYER_2, 1000);

  game.startRound(PLAYER_1);

  const currentPlayer = game.getCurrentPlayer();
  assert(currentPlayer, "Should have current player");

  game.call(currentPlayer.getId());

  const callActions = game.getBettingHistory().filter((a) => a.actionType === "call");

  assert(callActions.length >= 1, "Should have at least 1 call action");
  assert.equal(callActions[0].street, "preflop", "Call should be preflop");
});

test("Betting history tracks fold actions", () => {
  const game = new TexasHoldem();

  game.addPlayer(PLAYER_1);
  game.addPlayer(PLAYER_2);
  game.buyIn(PLAYER_1, 1000);
  game.buyIn(PLAYER_2, 1000);

  game.startRound(PLAYER_1);

  const currentPlayer = game.getCurrentPlayer();
  assert(currentPlayer, "Should have current player");

  game.fold(currentPlayer.getId());

  const foldActions = game.getBettingHistory().filter((a) => a.actionType === "fold");

  assert(foldActions.length >= 1, "Should have at least 1 fold action");
  assert.equal(foldActions[0].street, "preflop", "Fold should be preflop");
  assert.equal(foldActions[0].playerId, currentPlayer.getId(), "Fold player ID should match");
});

test("Betting history tracks bet/raise actions", () => {
  const game = new TexasHoldem();

  game.addPlayer(PLAYER_1);
  game.addPlayer(PLAYER_2);
  game.buyIn(PLAYER_1, 1000);
  game.buyIn(PLAYER_2, 1000);

  game.startRound(PLAYER_1);

  const currentPlayer = game.getCurrentPlayer();
  assert(currentPlayer, "Should have current player");

  game.bet(currentPlayer.getId(), 100);

  const betActions = game.getBettingHistory().filter(
    (a) => a.actionType === "bet" || a.actionType === "raise"
  );

  assert(betActions.length >= 1, "Should have at least 1 bet/raise action");
  assert.equal(betActions[0].street, "preflop", "Bet should be preflop");
  assert.equal(betActions[0].amount, 100, "Bet amount should be 100");
});

test("Betting history tracks actions across streets", () => {
  const game = new TexasHoldem();

  game.addPlayer(PLAYER_1);
  game.addPlayer(PLAYER_2);
  game.buyIn(PLAYER_1, 1000);
  game.buyIn(PLAYER_2, 1000);

  game.startRound(PLAYER_1);

  // Pre-flop: call and check to move to flop
  let currentPlayer = game.getCurrentPlayer();
  assert(currentPlayer, "Should have current player");
  game.call(currentPlayer.getId());

  currentPlayer = game.getCurrentPlayer();
  assert(currentPlayer, "Should have next player");
  game.check(currentPlayer.getId());

  // Should be at flop now
  assert.equal(game.getGameState(), GameState.Flop, "Should be at flop");

  // Flop: check check to move to turn
  currentPlayer = game.getCurrentPlayer();
  assert(currentPlayer, "Should have current player at flop");
  game.check(currentPlayer.getId());

  currentPlayer = game.getCurrentPlayer();
  assert(currentPlayer, "Should have next player at flop");
  game.check(currentPlayer.getId());

  // Should be at turn now
  assert.equal(game.getGameState(), GameState.Turn, "Should be at turn");

  const preflopActions = game.getPreflopBettingHistory();
  const flopActions = game.getFlopBettingHistory();
  const turnActions = game.getTurnBettingHistory();

  assert(preflopActions.length >= 2, "Should have preflop actions (blinds + actions)");
  assert(flopActions.length >= 2, "Should have flop actions");
  assert.equal(turnActions.length, 0, "Should have no turn actions yet");

  // Now take turn actions
  currentPlayer = game.getCurrentPlayer();
  game.check(currentPlayer!.getId());

  currentPlayer = game.getCurrentPlayer();
  game.check(currentPlayer!.getId());

  // Should be at river now
  assert.equal(game.getGameState(), GameState.River, "Should be at river");

  const updatedTurnActions = game.getTurnBettingHistory();
  const riverActions = game.getRiverBettingHistory();

  assert(updatedTurnActions.length >= 2, "Should have turn actions");
  assert.equal(riverActions.length, 0, "Should have no river actions yet");
});

test("Betting history is cleared between rounds", () => {
  const game = new TexasHoldem();

  game.addPlayer(PLAYER_1);
  game.addPlayer(PLAYER_2);
  game.buyIn(PLAYER_1, 1000);
  game.buyIn(PLAYER_2, 1000);

  // First round
  game.startRound(PLAYER_1);

  const currentPlayer = game.getCurrentPlayer();
  assert(currentPlayer, "Should have current player");
  game.fold(currentPlayer.getId());

  // Round should be over
  assert.equal(game.getGameState(), GameState.WaitingForPlayers);

  // Start another round
  game.startRound(PLAYER_1);

  const actions = game.getBettingHistory();

  // Should only have the blinds from the new round
  const smallBlindActions = actions.filter((a) => a.actionType === "small_blind");
  const bigBlindActions = actions.filter((a) => a.actionType === "big_blind");

  assert.equal(smallBlindActions.length, 1, "Should have exactly 1 small blind");
  assert.equal(bigBlindActions.length, 1, "Should have exactly 1 big blind");
});

test("Betting history serializes and deserializes correctly", () => {
  const game = new TexasHoldem();

  game.addPlayer(PLAYER_1);
  game.addPlayer(PLAYER_2);
  game.buyIn(PLAYER_1, 1000);
  game.buyIn(PLAYER_2, 1000);

  game.startRound(PLAYER_1);

  const currentPlayer = game.getCurrentPlayer();
  assert(currentPlayer, "Should have current player");
  game.call(currentPlayer.getId());

  // Serialize and deserialize
  const json = game.toJson();
  const restoredGame = TexasHoldem.fromJson(json);

  const originalHistory = game.getBettingHistory();
  const restoredHistory = restoredGame.getBettingHistory();

  assert.equal(restoredHistory.length, originalHistory.length, "History length should match");

  for (let i = 0; i < originalHistory.length; i++) {
    assert.equal(restoredHistory[i].actionType, originalHistory[i].actionType);
    assert.equal(restoredHistory[i].street, originalHistory[i].street);
    assert.equal(restoredHistory[i].playerId, originalHistory[i].playerId);
    assert.equal(restoredHistory[i].amount, originalHistory[i].amount);
  }
});

test("Betting history getBettingHistoryByStreet works", () => {
  const game = new TexasHoldem();

  game.addPlayer(PLAYER_1);
  game.addPlayer(PLAYER_2);
  game.buyIn(PLAYER_1, 1000);
  game.buyIn(PLAYER_2, 1000);

  game.startRound(PLAYER_1);

  const preflopActions = game.getBettingHistoryByStreet("preflop");
  
  // Should have at least the blinds
  assert(preflopActions.length >= 2, "Should have blind actions");
  assert(preflopActions.every(a => a.street === "preflop"), "All actions should be preflop");
});

test("Betting history tracks all-in actions", () => {
  const game = new TexasHoldem();

  game.addPlayer(PLAYER_1);
  game.addPlayer(PLAYER_2);
  game.buyIn(PLAYER_1, 500);
  game.buyIn(PLAYER_2, 500);

  game.startRound(PLAYER_1);

  // First player goes all-in
  const currentPlayer = game.getCurrentPlayer();
  assert(currentPlayer, "Should have current player");

  game.bet(currentPlayer.getId(), 500);

  const allInActions = game.getBettingHistory().filter(
    (a) => a.actionType === "all_in"
  );

  assert(allInActions.length >= 1, "Should have at least 1 all-in action");
});

console.log("\nBetting History test suite complete");
