import { strict as assert } from "assert";
import { TexasHoldem, GameState, Success } from "./Game";
import { Card } from "./Card";

// Player IDs
const PLAYER_1 = "player1";
const PLAYER_2 = "player2";
const PLAYER_3 = "player3";

// Basic test setup
function test(description: string, testFn: () => void) {
  try {
    testFn();
    console.log(`✅ ${description}`);
  } catch (error) {
    console.error(`❌ ${description}`);
    console.error(error);
  }
}

// Test cases
test("Game initializes with correct default state", () => {
  const game = new TexasHoldem();

  assert.equal(game.getGameState(), GameState.WaitingForPlayers);
  assert.equal(game.getCurrentPot(), 0);
});

test("Adding players works correctly", () => {
  const game = new TexasHoldem();

  assert.equal(game.addPlayer(PLAYER_1), true);
  assert.equal(game.addPlayer(PLAYER_1), false); // Should not add duplicate
  assert.equal(game.addPlayer(PLAYER_2), true);

  const activePlayers = game.getActivePlayers();
  const inactivePlayers = game.getInactivePlayers();

  assert.equal(activePlayers.length, 2);
  assert.equal(inactivePlayers.length, 0);

  const playerIds = activePlayers.map((p) => p.getId());
  assert(playerIds.includes(PLAYER_1));
  assert(playerIds.includes(PLAYER_2));

  activePlayers.forEach((player) => {
    assert.equal(player.getChips(), 0); // Players should start with 0 chips
  });
});

test("Adding player and buying in works correctly", () => {
  const game = new TexasHoldem();

  // Add player and verify initial state
  assert.equal(game.addPlayer(PLAYER_1), true);
  const player = game.getActivePlayers().find((p) => p.getId() === PLAYER_1);
  assert(player);
  assert.equal(player?.getChips(), 0);

  // Attempt to buy in with invalid amounts
  assert.equal(game.buyIn(PLAYER_1, 0), "Buy in amount must be positive"); // 0 chips
  assert.equal(game.buyIn(PLAYER_1, -100), "Buy in amount must be positive"); // negative chips
  assert.equal(player?.getChips(), 0); // chips should remain unchanged

  // Successful buy in
  assert.equal(game.buyIn(PLAYER_1, 1000), Success);
  assert.equal(game.buyIn("invalid_player_id", 1000), "Player not found"); // should fail with invalid player id
  assert.equal(player?.getChips(), 1000);

  // Attempt to buy in during active round
  // Add another player and buy in
  assert.equal(game.addPlayer(PLAYER_2), true);
  assert.equal(game.buyIn(PLAYER_2, 1000), Success);
  assert.equal(game.startRound(PLAYER_1), Success);
  assert.equal(game.buyIn(PLAYER_1, 500), "Cannot buy in during active round"); // should fail during active round
  assert.equal(player?.getChips(), 1000 - game.getSmallBlind()); // chips should remain unchanged
});

test("Players are dealt cards correctly", () => {
  const game = new TexasHoldem();

  // Add players
  assert.equal(game.addPlayer(PLAYER_1), true);
  assert.equal(game.addPlayer(PLAYER_2), true);

  // Players must buy in before starting round
  assert.equal(game.buyIn(PLAYER_1, 1000), Success);
  assert.equal(game.buyIn(PLAYER_2, 1000), Success);

  // Start round to deal cards
  assert.equal(game.startRound(PLAYER_1), Success);
  assert.equal(game.getGameState(), GameState.PreFlop);

  const players = game.getActivePlayers();

  // Verify each player has 2 cards
  players.forEach((player) => {
    assert.equal(player.getCards().length, 2);
  });

  // Verify all cards are unique
  const allCards = players.flatMap((p) => p.getCards());
  const uniqueCards = new Set(allCards.map((card) => card.toString()));
  assert.equal(uniqueCards.size, allCards.length);

  // Verify no cards are undefined
  allCards.forEach((card) => {
    assert(card);
  });
});

test("First player can fold", () => {
  const game = new TexasHoldem();

  // Add players and buy in
  assert.equal(game.addPlayer(PLAYER_1), true);
  assert.equal(game.addPlayer(PLAYER_2), true);
  assert.equal(game.buyIn(PLAYER_1, 1000), Success);
  assert.equal(game.buyIn(PLAYER_2, 1000), Success);

  // Start round
  assert.equal(game.startRound(PLAYER_1), Success);

  // Get current player (should be first player after big blind)
  const currentPlayer = game.getCurrentPlayer();
  assert(currentPlayer);

  // First player folds
  assert.equal(
    game.fold(currentPlayer?.getId() || ""),
    Success + ": round ended"
  );

  // Verify player is folded
  const foldedPlayers = game.getFoldedPlayers();
  assert.equal(foldedPlayers.size, 1);
  const [foldedPlayerId] = foldedPlayers; // Get first (and only) element from Set
  assert.equal(foldedPlayerId, currentPlayer?.getId());

  assert.equal(game.getGameState(), GameState.WaitingForPlayers);
});

test("Blinds are taken correctly and 3rd player must call big blind", () => {
  const game = new TexasHoldem();

  // Add 3 players and buy in
  assert.equal(game.addPlayer(PLAYER_1), true);
  assert.equal(game.addPlayer(PLAYER_2), true);
  assert.equal(game.addPlayer(PLAYER_3), true);
  assert.equal(game.buyIn(PLAYER_1, 1000), Success);
  assert.equal(game.buyIn(PLAYER_2, 1000), Success);
  assert.equal(game.buyIn(PLAYER_3, 1000), Success);

  // Start round
  assert.equal(game.startRound(PLAYER_1), Success);

  // Get players
  const players = game.getActivePlayers();
  assert.equal(players.length, 3);

  // Verify blinds were taken correctly
  const smallBlindPlayer = players[0];
  const bigBlindPlayer = players[1];
  const thirdPlayer = players[2];

  assert.equal(smallBlindPlayer.getChips(), 1000 - game.getSmallBlind());
  assert.equal(bigBlindPlayer.getChips(), 1000 - game.getBigBlind());
  assert.equal(thirdPlayer.getChips(), 1000);

  // Verify current pot includes blinds
  assert.equal(game.getCurrentPot(), game.getSmallBlind() + game.getBigBlind());

  // Verify 3rd player must call big blind
  const currentPlayer = game.getCurrentPlayer();
  assert(currentPlayer);
  assert.equal(currentPlayer?.getId(), thirdPlayer.getId());

  // Attempt to check should fail since there's an active bet
  assert.equal(
    game.check(currentPlayer?.getId() || ""),
    "Cannot check, there are active bets"
  );

  // Call should succeed
  assert.equal(game.call(currentPlayer.getId()), Success);
  assert.equal(thirdPlayer.getChips(), 1000 - game.getBigBlind());
});

test("Game progresses to flop after players call/check", () => {
  const game = new TexasHoldem();

  // Add 2 players and buy in
  assert.equal(game.addPlayer(PLAYER_1), true);
  assert.equal(game.addPlayer(PLAYER_2), true);
  assert.equal(game.buyIn(PLAYER_1, 1000), Success);
  assert.equal(game.buyIn(PLAYER_2, 1000), Success);

  // Start round
  assert.equal(game.startRound(PLAYER_1), Success);
  assert.equal(game.getGameState(), GameState.PreFlop);
  // Verify both players have 2 cards
  game.getActivePlayers().forEach((player) => {
    const cards = game.getPlayerHand(player.getId());
    assert(cards);
    assert.equal(cards.length, 2);
  });

  // Get players
  const players = game.getActivePlayers();
  assert.equal(players.length, 2);

  // Verify blinds were taken correctly
  const smallBlindPlayer = players[0];
  const bigBlindPlayer = players[1];

  assert.equal(smallBlindPlayer.getChips(), 1000 - game.getSmallBlind());
  assert.equal(bigBlindPlayer.getChips(), 1000 - game.getBigBlind());

  // Verify current pot includes blinds
  assert.equal(game.getCurrentPot(), game.getSmallBlind() + game.getBigBlind());

  // Small blind player should be first to act
  const currentPlayer = game.getCurrentPlayer();
  assert(currentPlayer);
  assert.equal(currentPlayer.getId(), smallBlindPlayer.getId());

  // Small blind player calls the remaining amount to match big blind
  assert.equal(game.call(currentPlayer.getId()), Success);
  assert.equal(smallBlindPlayer.getChips(), 1000 - game.getBigBlind());

  // Big blind player should now act
  const nextPlayer = game.getCurrentPlayer();
  assert(nextPlayer);
  assert.equal(nextPlayer.getId(), bigBlindPlayer.getId());

  // Big blind player checks (since they already matched the bet)
  assert.equal(game.check(nextPlayer.getId()), Success);

  // Game should progress to flop
  assert.equal(game.getGameState(), GameState.Flop);
  assert.equal(game.getCurrentPot(), game.getBigBlind() * 2);
  assert.equal(game.getCommunityCards().length, 3);
});

test("Game progresses to flop with raise and fold", () => {
  const game = new TexasHoldem();

  // Add 2 players and buy in
  assert.equal(game.addPlayer(PLAYER_1), true);
  assert.equal(game.addPlayer(PLAYER_2), true);
  assert.equal(game.buyIn(PLAYER_1, 1000), Success);
  assert.equal(game.buyIn(PLAYER_2, 1000), Success);

  // Start round
  assert.equal(game.startRound(PLAYER_1), Success);
  assert.equal(game.getGameState(), GameState.PreFlop);
  // Verify both players have 2 cards
  game.getActivePlayers().forEach((player) => {
    const cards = game.getPlayerHand(player.getId());
    assert(cards);
    assert.equal(cards.length, 2);
  });

  // Get players
  const players = game.getActivePlayers();
  assert.equal(players.length, 2);

  // Verify blinds were taken correctly
  const smallBlindPlayer = players[0];
  const bigBlindPlayer = players[1];

  assert.equal(smallBlindPlayer.getChips(), 1000 - game.getSmallBlind());
  assert.equal(bigBlindPlayer.getChips(), 1000 - game.getBigBlind());

  // Verify current pot includes blinds
  assert.equal(game.getCurrentPot(), game.getSmallBlind() + game.getBigBlind());

  // Small blind player should be first to act
  const currentPlayer = game.getCurrentPlayer();
  assert(currentPlayer);
  assert.equal(currentPlayer.getId(), smallBlindPlayer.getId());

  // Small blind player calls the remaining amount to match big blind
  assert.equal(game.call(currentPlayer.getId()), Success);
  assert.equal(smallBlindPlayer.getChips(), 1000 - game.getBigBlind());

  // Big blind player should now act
  const nextPlayer = game.getCurrentPlayer();
  assert(nextPlayer);
  assert.equal(nextPlayer.getId(), bigBlindPlayer.getId());

  // Big blind player checks (since they already matched the bet)
  assert.equal(game.check(nextPlayer.getId()), Success);

  // Game should progress to flop
  assert.equal(game.getGameState(), GameState.Flop);
  assert.equal(game.getCurrentPot(), game.getBigBlind() * 2);
  assert.equal(game.getCommunityCards().length, 3);

  // Get current players after flop
  const flopPlayers = game.getActivePlayers();
  assert.equal(flopPlayers.length, 2);

  // First player raises
  const raisingPlayer = game.getCurrentPlayer();
  assert(raisingPlayer);
  const raiseAmount = 50;
  assert.equal(
    game.bet(raisingPlayer.getId(), raiseAmount),
    "Bet " + raiseAmount
  );
  assert.equal(
    raisingPlayer.getChips(),
    1000 - game.getBigBlind() - raiseAmount
  );
  assert.equal(game.getCurrentPot(), game.getBigBlind() * 2 + raiseAmount);

  // Next player folds
  const foldingPlayer = game.getCurrentPlayer();
  assert(foldingPlayer);
  assert.equal(game.fold(foldingPlayer.getId()), Success + ": round ended");
  assert.equal(game.getGameState(), GameState.WaitingForPlayers);
  // Verify the winning player has the expected chips
  const winningPlayer =
    raisingPlayer.getChips() > foldingPlayer.getChips()
      ? raisingPlayer
      : foldingPlayer;
  assert.equal(
    winningPlayer.getChips(),
    1000 +
      game.getBigBlind() * 2 +
      raiseAmount -
      game.getBigBlind() -
      raiseAmount
  );
});

test("All-in Pre-flop deals all cards and distributes pot to winner", () => {
  const game = new TexasHoldem();

  // Add players
  assert.equal(game.addPlayer(PLAYER_1), true);
  assert.equal(game.addPlayer(PLAYER_2), true);

  // Players must buy in before starting round
  assert.equal(game.buyIn(PLAYER_1, 1000), Success);
  assert.equal(game.buyIn(PLAYER_2, 1000), Success);

  // Start round to deal cards
  assert.equal(game.startRound(PLAYER_1), Success);
  assert.equal(game.getGameState(), GameState.PreFlop);

  // First player goes all-in
  const player1 = game.getCurrentPlayer();
  assert(player1);

  assert.equal(game.bet(player1.getId(), 1000), "Raised to 1000");
  assert.equal(player1.getChips(), 0);
  assert.equal(player1.getIsAllIn(), true);
  assert.equal(player1.getTotalBet(), 1000);

  // Second player calls all-in
  const player2 = game.getCurrentPlayer();
  assert(player2);
  //   player2?.setCards([new Card("Hearts", "2"), new Card("Diamonds", "3")]);

  assert.equal(game.call(player2.getId()), Success + ": Player went all-in");
  assert.equal(player2.getIsAllIn(), true);

  if (player2.getChips() === player1.getChips()) {
    assert.equal(player2.getChips(), 1000);
    assert.equal(player1.getChips(), 1000);
  } else if (player1.getChips() > 0) {
    assert.equal(player2.getChips(), 0);
    assert.equal(player1.getChips(), 2000);
  } else {
    assert.equal(player1.getChips(), 0);
    assert.equal(player2.getChips(), 2000);
  }

  assert.equal(game.getGameState(), GameState.WaitingForPlayers);
});

test("Test 1 Side Pot for non-all-in players", () => {
  const game = new TexasHoldem();

  // Add players
  assert.equal(game.addPlayer(PLAYER_1), true);
  assert.equal(game.addPlayer(PLAYER_2), true);
  assert.equal(game.addPlayer(PLAYER_3), true);

  // Players must buy in before starting round
  assert.equal(game.buyIn(PLAYER_1, 1000), Success);
  assert.equal(game.buyIn(PLAYER_2, 1000), Success);
  assert.equal(game.buyIn(PLAYER_3, 500), Success);

  // Start round to deal cards
  assert.equal(game.startRound(PLAYER_1), Success);
  assert.equal(game.getGameState(), GameState.PreFlop);

  // Player 3 goes all-in
  const player3 = game.getCurrentPlayer();
  assert(player3);
  assert.equal(player3?.getId(), PLAYER_3);

  assert.equal(game.bet(player3.getId(), 500), "Raised to 500");
  assert.equal(player3.getChips(), 0);
  assert.equal(player3.getIsAllIn(), true);
  assert.equal(player3.getTotalBet(), 500);

  // Player 1 calls all-in
  const player1 = game.getCurrentPlayer();
  assert(player1);
  assert.equal(player1.getId(), PLAYER_1);

  assert.equal(game.call(player1.getId()), Success);
  assert.equal(player1.getChips(), 500);
  assert.equal(player1.getIsAllIn(), false);
  assert.equal(player3.getTotalBet(), 500);

  const player2 = game.getCurrentPlayer();
  assert(player2);
  assert.equal(player2.getId(), PLAYER_2);

  assert.equal(game.call(player2.getId()), Success);
  assert.equal(player2.getChips(), 500);
  assert.equal(player2.getIsAllIn(), false);
  assert.equal(player3.getTotalBet(), 500);

  assert.equal(game.getGameState(), GameState.Flop);
  assert.equal(game.getCommunityCards().length, 3);

  assert.equal(game.getCurrentPlayer()?.getId(), PLAYER_1);
  assert.equal(game.bet(PLAYER_1, 300), "Bet 300");

  assert.equal(game.getCurrentPlayer()?.getId(), PLAYER_2);
  assert.equal(game.call(PLAYER_2), Success);

  assert.equal(game.getGameState(), GameState.Turn);
  assert.equal(game.getCommunityCards().length, 4);

  assert.equal(game.getCurrentPlayer()?.getId(), PLAYER_1);
  assert.equal(game.check(PLAYER_1), Success);

  assert.equal(game.getCurrentPlayer()?.getId(), PLAYER_2);
  assert.equal(game.call(PLAYER_2), "No active bets to call");
  assert.equal(game.check(PLAYER_2), Success);

  assert.equal(game.getGameState(), GameState.River);
  assert.equal(game.getCommunityCards().length, 5);

  // Set cards so that Player3 wins and Player1 wins side pot
  game.setCommunityCards([
    new Card("Clubs", "2"),
    new Card("Hearts", "4"),
    new Card("Diamonds", "6"),
    new Card("Spades", "8"),
    new Card("Clubs", "10"),
  ]);
  player1.setCards([new Card("Clubs", "K"), new Card("Hearts", "K")]);
  player2.setCards([new Card("Clubs", "Q"), new Card("Hearts", "Q")]);
  player3.setCards([new Card("Clubs", "A"), new Card("Hearts", "A")]);

  assert.equal(game.getCurrentPlayer()?.getId(), PLAYER_1);
  assert.equal(game.check(PLAYER_1), Success);

  assert.equal(game.getCurrentPlayer()?.getId(), PLAYER_2);
  assert.equal(game.call(PLAYER_2), "No active bets to call");
  assert.equal(game.check(PLAYER_2), Success);

  assert.equal(player1.getChips(), 800); // 300 + 300 side pot
  assert.equal(player2.getChips(), 200); // lost 500 + 300 from 1000
  assert.equal(player3.getChips(), 1500); // won 500 + 500 from first pot

  assert.equal(game.getGameState(), GameState.WaitingForPlayers);
  assert.equal(game.getDealerPosition(), 1);

  assert.equal(game.startRound(PLAYER_1), Success);
  assert.equal(player1.getChips(), 800);
  assert.equal(player2.getChips(), 200 - game.getSmallBlind());
  assert.equal(player3.getChips(), 1500 - game.getBigBlind());
});

test("Test players leaving and joining and dealer position", () => {
  const game = new TexasHoldem();

  assert.equal(game.getDealerPosition(), 0);

  assert.equal(game.addPlayer(PLAYER_1), true);
  assert.equal(game.addPlayer(PLAYER_2), true);
  assert.equal(game.addPlayer(PLAYER_3), true);

  // Players must buy in before starting round
  assert.equal(game.buyIn(PLAYER_1, 1000), Success);
  assert.equal(game.buyIn(PLAYER_2, 1000), Success);
  assert.equal(game.buyIn(PLAYER_3, 1000), Success);

  assert.equal(game.startRound(PLAYER_1), Success);

  while (game.getGameState() !== GameState.WaitingForPlayers) {
    const currentPlayer = game.getCurrentPlayer();
    assert(currentPlayer);
    if (
      game.getCurrentBetAmount() > 0 &&
      currentPlayer.getCurrentBet() < game.getCurrentBetAmount()
    ) {
      assert.equal(game.call(currentPlayer.getId()), Success);
    } else {
      assert.equal(game.check(currentPlayer.getId()), Success);
    }
  }
  assert.equal(game.getDealerPosition(), 1);

  const player1 = game.getActivePlayers().find((p) => p.getId() == PLAYER_1);
  assert(player1);
  let player1Chips = player1.getChips();

  const player2 = game.getActivePlayers().find((p) => p.getId() == PLAYER_2);
  assert(player2);
  let player2Chips = player2.getChips();

  const player3 = game.getActivePlayers().find((p) => p.getId() == PLAYER_3);
  assert(player3);
  const player3Chips = player3.getChips();

  assert.equal(game.startRound(PLAYER_1), Success);
  assert.equal(player1.getChips(), player1Chips);
  assert.equal(player2.getChips(), player2Chips - game.getSmallBlind());
  assert.equal(player3.getChips(), player3Chips - game.getBigBlind());

  while (game.getGameState() !== GameState.WaitingForPlayers) {
    const currentPlayer = game.getCurrentPlayer();
    assert(currentPlayer);
    if (
      game.getCurrentBetAmount() > 0 &&
      currentPlayer.getCurrentBet() < game.getCurrentBetAmount()
    ) {
      assert.equal(game.call(currentPlayer.getId()), Success);
    } else {
      assert.equal(game.check(currentPlayer.getId()), Success);
    }
  }

  assert.equal(game.getDealerPosition(), 2);
  assert.equal(game.removePlayer(PLAYER_3), true);

  player1Chips = player1.getChips();
  player2Chips = player2.getChips();

  assert.equal(game.startRound(PLAYER_1), Success);
  assert.equal(game.getDealerPosition(), 0);
  assert.equal(player1.getChips(), player1Chips - game.getSmallBlind());
  assert.equal(player2.getChips(), player2Chips - game.getBigBlind());
});

test("Test player cant afford blinds goes all-in", () => {
  const game = new TexasHoldem();

  assert.equal(game.addPlayer(PLAYER_1), true);
  assert.equal(game.addPlayer(PLAYER_2), true);
  assert.equal(game.addPlayer(PLAYER_3), true);

  // Players must buy in before starting round
  assert.equal(game.buyIn(PLAYER_1, 1), Success);
  assert.equal(game.buyIn(PLAYER_2, 1000), Success);
  assert.equal(game.buyIn(PLAYER_3, 1000), Success);

  assert.equal(game.startRound(PLAYER_1), Success);
  const player1 = game.getActivePlayers().find((p) => p.getId() == PLAYER_1);
  assert(player1);
  assert.equal(player1.getIsAllIn(), true);

  assert.equal(game.getCurrentPlayer()?.getId(), PLAYER_3);
  assert.equal(game.call(PLAYER_3), Success);

  assert.equal(game.getCurrentPlayer()?.getId(), PLAYER_2);
  assert.equal(
    game.call(PLAYER_2),
    "No need to call - already matched the current bet"
  );
  assert.equal(game.check(PLAYER_2), Success);

  assert.equal(game.getGameState(), GameState.Flop);

  assert.equal(game.getCurrentPlayer()?.getId(), PLAYER_3);
  assert.equal(game.bet(PLAYER_3, 100), "Bet 100");
  assert.equal(game.call(PLAYER_2), Success);

  assert.equal(game.getGameState(), GameState.Turn);

  assert.equal(game.check(PLAYER_3), Success);
  assert.equal(game.check(PLAYER_2), Success);

  assert.equal(game.getGameState(), GameState.River);

  const player2 = game.getActivePlayers().find((p) => p.getId() == PLAYER_2);
  assert(player2);

  const player3 = game.getActivePlayers().find((p) => p.getId() == PLAYER_3);
  assert(player3);

  game.setCommunityCards([
    new Card("Clubs", "2"),
    new Card("Hearts", "4"),
    new Card("Diamonds", "6"),
    new Card("Spades", "8"),
    new Card("Clubs", "10"),
  ]);
  player1.setCards([new Card("Clubs", "A"), new Card("Hearts", "A")]);
  player2.setCards([new Card("Clubs", "K"), new Card("Hearts", "K")]);
  player3.setCards([new Card("Clubs", "Q"), new Card("Hearts", "Q")]);

  assert.equal(game.check(PLAYER_3), Success);
  assert.equal(game.check(PLAYER_2), Success);

  assert.equal(game.getGameState(), GameState.WaitingForPlayers);

  assert.equal(player1.getChips(), 3);
  assert.equal(player2.getChips(), 1118);
  assert.equal(player3.getChips(), 880);
});

test("Test 2 players call the blinds", () => {
  const game = new TexasHoldem();

  assert.equal(game.addPlayer(PLAYER_1), true);
  assert.equal(game.addPlayer(PLAYER_2), true);

  assert.equal(game.buyIn(PLAYER_1, 1000), Success);
  assert.equal(game.buyIn(PLAYER_2, 1000), Success);

  assert.equal(game.startRound(PLAYER_1), Success);

  const player1 = game.getActivePlayers().find((p) => p.getId() == PLAYER_1);
  assert(player1);
  assert.equal(player1.getChips(), 1000 - game.getSmallBlind());

  const player2 = game.getActivePlayers().find((p) => p.getId() == PLAYER_2);
  assert(player2);
  assert.equal(player2.getChips(), 1000 - game.getBigBlind());

  assert.equal(game.getCurrentPlayer().getId(), PLAYER_1);
  assert.equal(game.call(PLAYER_1), Success);

  assert.equal(game.getCurrentPlayer().getId(), PLAYER_2);
  assert.equal(
    game.call(PLAYER_2),
    "No need to call - already matched the current bet"
  );
});

test("2 player game, one player all-in ends round", () => {
  const game = new TexasHoldem();

  assert.equal(game.addPlayer(PLAYER_1), true);
  assert.equal(game.addPlayer(PLAYER_2), true);

  assert.equal(game.buyIn(PLAYER_1, 100), Success);
  assert.equal(game.buyIn(PLAYER_2, 200), Success);

  assert.equal(game.startRound(PLAYER_1), Success);

  assert.equal(game.call(PLAYER_1), Success);

  assert.equal(game.bet(PLAYER_2, 100), "Raised to 100");

  assert.equal(game.call(PLAYER_1), Success + ": Player went all-in");
  const player = game.getActivePlayers().find((p) => p.getId() === PLAYER_1);
  assert(player);
  assert.equal(player.getIsAllIn(), true);

  assert.equal(game.getGameState(), GameState.WaitingForPlayers);
});

test("players cant bet more than they can win", () => {
  const game = new TexasHoldem();

  assert.equal(game.addPlayer(PLAYER_1), true);
  assert.equal(game.addPlayer(PLAYER_2), true);

  assert.equal(game.buyIn(PLAYER_1, 100), Success);
  assert.equal(game.buyIn(PLAYER_2, 200), Success);

  assert.equal(game.startRound(PLAYER_1), Success);

  assert.equal(game.call(PLAYER_1), Success);
  assert.equal(game.check(PLAYER_2), Success);

  assert.equal(game.check(PLAYER_1), Success);

  assert.equal(game.bet(PLAYER_2, 90), `No reason to bet more than 80`);
});

test("no sidepot needed for all-in player with other folded players", () => {
  const game = new TexasHoldem();

  assert.equal(game.addPlayer(PLAYER_1), true);
  assert.equal(game.addPlayer(PLAYER_2), true);
  assert.equal(game.addPlayer(PLAYER_3), true);

  assert.equal(game.buyIn(PLAYER_1, 100), Success);
  assert.equal(game.buyIn(PLAYER_2, 200), Success);
  assert.equal(game.buyIn(PLAYER_3, 200), Success);

  assert.equal(game.startRound(PLAYER_1), Success);

  assert.equal(game.call(PLAYER_3), Success);
  assert.equal(game.call(PLAYER_1), Success);
  assert.equal(game.check(PLAYER_2), Success);
  assert.equal(game.getCurrentPot(), 60);

  assert.equal(game.getGameState(), GameState.Flop);

  assert.equal(game.check(PLAYER_3), Success);
  assert.equal(game.check(PLAYER_1), Success);
  assert.equal(game.bet(PLAYER_2, 40), "Bet 40");
  assert.equal(game.fold(PLAYER_3), Success);
  assert.equal(game.call(PLAYER_1), Success);

  assert.equal(game.getCurrentPot(), 140);

  assert.equal(game.getGameState(), GameState.Turn);

  assert.equal(game.check(PLAYER_2), Success);
  assert.equal(game.check(PLAYER_1), Success);

  assert.equal(game.getGameState(), GameState.River);

  const player1 = game.getActivePlayers().find((p) => p.getId() == PLAYER_1);
  assert(player1);
  const player2 = game.getActivePlayers().find((p) => p.getId() == PLAYER_2);
  assert(player2);
  const player3 = game.getActivePlayers().find((p) => p.getId() == PLAYER_3);
  assert(player3);

  game.setCommunityCards([
    new Card("Clubs", "2"),
    new Card("Hearts", "4"),
    new Card("Diamonds", "6"),
    new Card("Spades", "8"),
    new Card("Clubs", "10"),
  ]);
  player1.setCards([new Card("Clubs", "A"), new Card("Hearts", "A")]);
  player2.setCards([new Card("Clubs", "K"), new Card("Hearts", "K")]);

  assert.equal(game.bet(PLAYER_2, 40), "Bet 40"); // 120
  assert.equal(game.getCurrentPot(), 180);
  assert.equal(game.call(PLAYER_1), Success + ": Player went all-in");

  assert.equal(player1.getChips(), 220);
  assert.equal(player2.getChips(), 100);
  assert.equal(player3.getChips(), 180);
});

test("sidepot only for loser who bet more than all-in player", () => {
  const game = new TexasHoldem();

  assert.equal(game.addPlayer(PLAYER_1), true);
  assert.equal(game.addPlayer(PLAYER_2), true);
  assert.equal(game.addPlayer(PLAYER_3), true);

  assert.equal(game.buyIn(PLAYER_1, 100), Success);
  assert.equal(game.buyIn(PLAYER_2, 200), Success);
  assert.equal(game.buyIn(PLAYER_3, 200), Success);

  assert.equal(game.startRound(PLAYER_1), Success);

  assert.equal(game.call(PLAYER_3), Success);
  assert.equal(game.call(PLAYER_1), Success);
  assert.equal(game.check(PLAYER_2), Success);
  assert.equal(game.getCurrentPot(), 60);

  assert.equal(game.getGameState(), GameState.Flop);

  assert.equal(game.check(PLAYER_3), Success);
  assert.equal(game.check(PLAYER_1), Success);
  assert.equal(game.bet(PLAYER_2, 40), "Bet 40");
  assert.equal(game.fold(PLAYER_3), Success);
  assert.equal(game.call(PLAYER_1), Success);

  assert.equal(game.getCurrentPot(), 140);

  assert.equal(game.getGameState(), GameState.Turn);

  assert.equal(game.check(PLAYER_2), Success);
  assert.equal(game.check(PLAYER_1), Success);

  assert.equal(game.getGameState(), GameState.River);

  const player1 = game.getActivePlayers().find((p) => p.getId() == PLAYER_1);
  assert(player1);
  const player2 = game.getActivePlayers().find((p) => p.getId() == PLAYER_2);
  assert(player2);
  const player3 = game.getActivePlayers().find((p) => p.getId() == PLAYER_3);
  assert(player3);

  game.setCommunityCards([
    new Card("Clubs", "2"),
    new Card("Hearts", "4"),
    new Card("Diamonds", "6"),
    new Card("Spades", "8"),
    new Card("Clubs", "10"),
  ]);
  player1.setCards([new Card("Clubs", "A"), new Card("Hearts", "A")]);
  player2.setCards([new Card("Clubs", "K"), new Card("Hearts", "K")]);

  assert.equal(game.bet(PLAYER_2, 60), "Bet 60"); // 120
  assert.equal(game.getCurrentPot(), 200);
  assert.equal(game.call(PLAYER_1), Success + ": Player went all-in");

  assert.equal(player1.getChips(), 220);
  assert.equal(player2.getChips(), 100);
  assert.equal(player3.getChips(), 180);
});

console.log("\nTest suite complete");
