import { Card } from "./Card";
import { Deck } from "./Deck";
import { Player } from "./Player";
import { GameEvent } from "./GameEvent";

const { rankDescription, evaluateCards, rankCards } = require("phe");

export enum GameState {
  WaitingForPlayers,
  PreFlop,
  Flop,
  Turn,
  River,
}

export const Success = "Success";

export type BettingStreet = "preflop" | "flop" | "turn" | "river";

export type BettingActionType =
  | "small_blind"
  | "big_blind"
  | "bet"
  | "raise"
  | "call"
  | "check"
  | "fold"
  | "all_in";

export type UnderlyingAllInActionType = "bet" | "raise" | "call";

export interface BettingAction {
  street: BettingStreet;
  playerId: string;
  actionType: BettingActionType;
  amount: number;
  contributionAmount?: number;
  underlyingActionType?: UnderlyingAllInActionType;
  timestamp: number;
}

export type HandActionType =
  | "post_small_blind"
  | "post_big_blind"
  | "fold"
  | "check"
  | "call"
  | "bet"
  | "raise";

export interface PlayerRoleFlags {
  isDealer: boolean;
  isSmallBlind: boolean;
  isBigBlind: boolean;
}

export interface HandStartPlayerSnapshot {
  playerId: string;
  seatIndex: number;
  roleFlags: PlayerRoleFlags;
  startingStack: number;
  holeCards: Card[];
}

export interface HandStartSnapshot {
  handId: number;
  dealerPosition: number;
  smallBlind: number;
  bigBlind: number;
  players: HandStartPlayerSnapshot[];
}

export interface HandAction {
  street: BettingStreet;
  actionIndex: number;
  playerId: string;
  actionType: HandActionType;
  contribution: number;
  targetBet: number;
  isAllIn: boolean;
  timestamp: number;
}

export interface BoardSnapshot {
  flop: Card[];
  turn: Card[];
  river: Card[];
}

export interface PotResult {
  potIndex: number;
  potType: "main" | "side";
  potSize: number;
  eligiblePlayerIds: string[];
  winnerPlayerIds: string[];
  splitAmount: number;
}

export interface HandEndPlayerSnapshot {
  playerId: string;
  finalStack: number;
  foldedStreet: BettingStreet | null;
  reachedShowdown: boolean;
  revealedCards: boolean;
  chipsWon: number;
}

export interface HandEndSnapshot {
  handId: number;
  players: HandEndPlayerSnapshot[];
  potResults: PotResult[];
}

export interface HandHistoryState {
  handCounter: number;
  handStartSnapshot: HandStartSnapshot | null;
  actionHistory: HandAction[];
  boardSnapshot: BoardSnapshot;
  handEndSnapshot: HandEndSnapshot | null;
}

export class TexasHoldem {
  private gameState: GameState;
  private deck: Deck;
  private communityCards: Card[];
  private activePlayers: Player[];
  private inactivePlayers: Player[];
  private currentPot: number;
  private dealerPosition: number;
  private smallBlind: number;
  private bigBlind: number;
  private currentPlayerIndex: number;
  private foldedPlayers: Set<string>;
  private currentBetAmount: number;
  private lastRaiseAmount: number;
  private playerPositions: Map<string, number>;
  private preDealId: string | undefined = undefined;
  private events: GameEvent[];
  private bettingHistory: BettingAction[];
  private handStartChips: Map<string, number>;
  private handCounter: number;
  private handStartSnapshot: HandStartSnapshot | null;
  private actionHistory: HandAction[];
  private boardSnapshot: BoardSnapshot;
  private handEndSnapshot: HandEndSnapshot | null;

  constructor(
    gameState: GameState = GameState.WaitingForPlayers,
    deck: Deck = new Deck(),
    communityCards: Card[] = [],
    activePlayers: Player[] = [],
    inactivePlayers: Player[] = [],
    currentPot: number = 0,
    dealerPosition: number = 0,
    smallBlind: number = 10,
    bigBlind: number = 20,
    currentPlayerIndex: number = 0,
    foldedPlayers: Set<string> = new Set(),
    currentBetAmount: number = 0,
    lastRaiseAmount: number = 0,
    playerPositions: Map<string, number> = new Map(),
    preDealId: string | undefined = undefined,
    bettingHistory: BettingAction[] = [],
    handStartChips: Map<string, number> = new Map(),
    handCounter: number = 0,
    handStartSnapshot: HandStartSnapshot | null = null,
    actionHistory: HandAction[] = [],
    boardSnapshot: BoardSnapshot = { flop: [], turn: [], river: [] },
    handEndSnapshot: HandEndSnapshot | null = null
  ) {
    this.gameState = gameState;
    this.deck = deck;
    this.communityCards = communityCards;
    this.activePlayers = activePlayers;
    this.inactivePlayers = inactivePlayers;
    this.currentPot = currentPot;
    this.dealerPosition = dealerPosition;
    this.smallBlind = smallBlind;
    this.bigBlind = bigBlind;
    this.currentPlayerIndex = currentPlayerIndex;
    this.foldedPlayers = foldedPlayers;
    this.currentBetAmount = currentBetAmount;
    this.lastRaiseAmount = lastRaiseAmount;
    this.playerPositions = playerPositions;
    this.preDealId = preDealId;
    this.events = [];
    this.bettingHistory = bettingHistory;
    this.handStartChips = handStartChips;
    this.handCounter = handCounter;
    this.handStartSnapshot = handStartSnapshot;
    this.actionHistory = actionHistory;
    this.boardSnapshot = boardSnapshot;
    this.handEndSnapshot = handEndSnapshot;
  }

  public progressGame(): void {
    switch (this.gameState) {
      case GameState.PreFlop:
        if (this.isBettingRoundComplete()) {
          this.dealFlop();
          this.gameState = GameState.Flop;
          this.startNewBettingRound();

          if (this.shouldSkipToShowdown()) {
            this.progressGame();
          }
        }
        break;

      case GameState.Flop:
        if (this.isBettingRoundComplete()) {
          this.dealTurn();
          this.gameState = GameState.Turn;
          this.startNewBettingRound();

          if (this.shouldSkipToShowdown()) {
            this.progressGame();
          }
        }
        break;

      case GameState.Turn:
        if (this.isBettingRoundComplete()) {
          this.dealRiver();
          this.gameState = GameState.River;
          this.startNewBettingRound();

          if (this.shouldSkipToShowdown()) {
            this.progressGame();
          }
        }
        break;

      case GameState.River:
        if (this.isBettingRoundComplete()) {
          this.endRound();
        }
        break;

      default:
        break;
    }

    // PreMove Logic
    if (this.gameState != GameState.WaitingForPlayers) {
      const currentPlayer = this.getCurrentPlayer();
      if (currentPlayer && currentPlayer.getPreMove() != null) {
        // perform premove
        const preMove = currentPlayer.getPreMove();
        currentPlayer.setPreMove(null); // need to do this before performing premove since progressGame is called recursively

        this.events.push(
          new GameEvent(`${currentPlayer.getId()} is pre-moving!`)
        );
        const move = preMove?.move.toLowerCase();
        if (move === "check") {
          this.check(currentPlayer.getId());
        } else if (move === "fold") {
          this.fold(currentPlayer.getId());
        } else if (move === "call") {
          const callAmount = preMove?.amount;
          if (!callAmount) {
            this.events.push(
              new GameEvent(
                `Call amount not set, Kapcer stinks at coding! No wonder he's a 3/5.`
              )
            );
            return;
          }
          if (callAmount !== this.currentBetAmount) {
            this.events.push(
              new GameEvent(
                `${currentPlayer.getId()} not pre-calling, bet amount has changed!`
              )
            );
            return;
          }

          this.call(currentPlayer.getId());
        } else if (move === "bet") {
          const betAmount = preMove?.amount;
          if (!betAmount) {
            this.events.push(
              new GameEvent(
                `Bet amount not set, Kapcer stinks at coding! No wonder he's a 3/5.`
              )
            );
            return;
          }
          this.bet(currentPlayer.getId(), betAmount);
        }
      }
    }
  }

  private shouldSkipToShowdown(): boolean {
    // If all players are either folded or all-in, we should skip to showdown
    const activeNonFoldedPlayers = this.activePlayers.filter(
      (player) =>
        !this.foldedPlayers.has(player.getId()) && !player.getIsAllIn()
    );
    return activeNonFoldedPlayers.length <= 1;
  }

  private resetCompletedHandTracking(): void {
    this.handStartChips = new Map();
    this.handStartSnapshot = null;
    this.actionHistory = [];
    this.boardSnapshot = { flop: [], turn: [], river: [] };
    this.handEndSnapshot = null;
  }

  private cloneCards(cards: Card[]): Card[] {
    return cards.map((card) => Card.fromJson(card.toJson()));
  }

  private cloneBoardSnapshot(boardSnapshot: BoardSnapshot): BoardSnapshot {
    return {
      flop: this.cloneCards(boardSnapshot.flop),
      turn: this.cloneCards(boardSnapshot.turn),
      river: this.cloneCards(boardSnapshot.river),
    };
  }

  private getRoleFlags(playerIndex: number): PlayerRoleFlags {
    const numPlayers = this.activePlayers.length;
    const relativePosition =
      (playerIndex - this.dealerPosition + numPlayers) % numPlayers;

    return {
      isDealer: relativePosition === 0,
      isSmallBlind:
        numPlayers === 2 ? relativePosition === 1 : relativePosition === 1,
      isBigBlind:
        numPlayers === 2 ? relativePosition === 0 : relativePosition === 2,
    };
  }

  private recordHandAction(
    playerId: string,
    actionType: HandActionType,
    contribution: number,
    targetBet: number,
    isAllIn: boolean
  ): void {
    if (!this.handStartSnapshot) {
      return;
    }

    this.actionHistory.push({
      street: this.gameStateToStreet(this.gameState),
      actionIndex: this.actionHistory.length,
      playerId,
      actionType,
      contribution,
      targetBet,
      isAllIn,
      timestamp: Date.now(),
    });
  }

  private createHandStartSnapshot(): void {
    if (this.handStartChips.size === 0) {
      return;
    }

    this.handStartSnapshot = {
      handId: this.handCounter,
      dealerPosition: this.dealerPosition,
      smallBlind: this.smallBlind,
      bigBlind: this.bigBlind,
      players: this.activePlayers.map((player, seatIndex) => ({
        playerId: player.getId(),
        seatIndex,
        roleFlags: this.getRoleFlags(seatIndex),
        startingStack: this.handStartChips.get(player.getId()) ?? player.getChips(),
        holeCards: this.cloneCards(player.getCards()),
      })),
    };
  }

  private updateBoardSnapshot(): void {
    this.boardSnapshot = {
      flop: this.cloneCards(this.communityCards.slice(0, 3)),
      turn: this.cloneCards(this.communityCards.slice(3, 4)),
      river: this.cloneCards(this.communityCards.slice(4, 5)),
    };
  }

  private getFoldedStreetForPlayer(playerId: string): BettingStreet | null {
    const foldAction = this.actionHistory.find(
      (action) => action.playerId === playerId && action.actionType === "fold"
    );
    return foldAction?.street ?? null;
  }

  private finalizeHandEndSnapshot(potResults: PotResult[]): void {
    if (!this.handStartSnapshot) {
      this.handEndSnapshot = null;
      return;
    }

    const chipsWonByPlayerId = new Map<string, number>();
    potResults.forEach((potResult) => {
      potResult.winnerPlayerIds.forEach((playerId) => {
        chipsWonByPlayerId.set(
          playerId,
          (chipsWonByPlayerId.get(playerId) ?? 0) + potResult.splitAmount
        );
      });
    });

    this.handEndSnapshot = {
      handId: this.handStartSnapshot.handId,
      players: this.handStartSnapshot.players.map((playerSnapshot) => {
        const player = this.activePlayers.find(
          (activePlayer) => activePlayer.getId() === playerSnapshot.playerId
        );
        const foldedStreet = this.getFoldedStreetForPlayer(playerSnapshot.playerId);
        const reachedShowdown =
          foldedStreet === null &&
          this.handStartSnapshot!.players.filter(
            ({ playerId }) => this.getFoldedStreetForPlayer(playerId) === null
          ).length > 1;

        return {
          playerId: playerSnapshot.playerId,
          finalStack: player?.getChips() ?? playerSnapshot.startingStack,
          foldedStreet,
          reachedShowdown,
          revealedCards: reachedShowdown,
          chipsWon: chipsWonByPlayerId.get(playerSnapshot.playerId) ?? 0,
        };
      }),
      potResults: potResults.map((potResult) => ({ ...potResult })),
    };
  }

  public startNewBettingRound(): void {
    this.currentBetAmount = 0;
    this.lastRaiseAmount = 0;
    this.activePlayers.forEach((player) => {
      player.resetCurrentBet();
      player.resetLastRaise();
      player.resetHadTurnThisRound();
    });

    this.currentPlayerIndex = this.dealerPosition % this.activePlayers.length;
    this.advanceToNextPlayer();
  }

  private isBettingRoundComplete(): boolean {
    // Check if all players have either folded, called, or gone all-in
    const activePlayers = this.activePlayers.filter(
      (player) => !this.foldedPlayers.has(player.getId())
    );

    // If only one player remains, the betting round is complete
    if (activePlayers.length <= 1) return true;

    // If all active players are all-in, the betting round is complete
    if (activePlayers.every((player) => player.getIsAllIn())) {
      return true;
    }

    // Check if all remaining players have matched the current bet
    const allPlayersMatched = activePlayers.every((player) => {
      return (
        player.getCurrentBet() === this.currentBetAmount || player.getIsAllIn()
      );
    });

    // Additionally, we need to check if we've completed a full round of betting
    // since the last raise. This ensures the big blind gets a chance to raise
    if (allPlayersMatched) {
      const notAllInPlayers = activePlayers.filter(
        (player) => !player.getIsAllIn()
      );
      if (notAllInPlayers.length <= 1) return true;
      return activePlayers.every(
        (player) => player.getHadTurnThisRound() || player.getIsAllIn()
      );
    }

    return false;
  }

  public startRound(playerId: string): string {
    if (this.gameState !== GameState.WaitingForPlayers) {
      this.events.push(
        new GameEvent(`${playerId} Cannot start round, game is already active!`)
      );
      return "Game is already active";
    }

    const player = this.activePlayers.find((p) => p.getId() === playerId);
    if (!player) {
      this.events.push(
        new GameEvent(`${playerId} Player not found or not active!`)
      );
      return "Player not found or not active";
    }

    this.activePlayers.forEach((player) => {
      player.removeAllCards();
      player.setAllIn(false);
      player.setCurrentBet(0);
      player.resetTotalBet();
      player.setLastRaise(0);
      player.setHadTurnThisRound(false);
      player.setPreMove(null);
    });

    this.activePlayers.forEach((player) => {
      if (player.getChips() <= 0) {
        this.events.push(
          new GameEvent(
            `${player.getId()} is being removed from the game for having no chips`
          )
        );
        this.removePlayer(player.getId());
      }
    });

    if (this.activePlayers.length <= 1) {
      this.events.push(new GameEvent("How about you get some friends first"));
      return "Not enough players to start round";
    }

    // Reset dealer position if it's now invalid
    if (this.dealerPosition >= this.activePlayers.length) {
      this.dealerPosition = 0;
    }

    let startGameMessage = "Starting round with players: \n";
    this.activePlayers.forEach((player) => {
      startGameMessage += `${player.getId()} ${player.getChips()} chips\n`;
    });
    this.events.push(new GameEvent(startGameMessage));

    this.events.push(
      new GameEvent(
        `${this.activePlayers[this.dealerPosition]?.getId()} has the dealer button`
      )
    );

    this.communityCards = [];
    this.foldedPlayers.clear();
    this.resetCompletedHandTracking();
    this.handCounter += 1;
    this.handStartChips = new Map(
      this.activePlayers.map((activePlayer) => [
        activePlayer.getId(),
        activePlayer.getChips(),
      ])
    );
    this.currentPlayerIndex =
      (this.dealerPosition + 3) % this.activePlayers.length; // Start after big blind
    this.deck.reset();
    this.deck.shuffle();
    this.dealInitialCards();
    this.bettingHistory = [];

    this.smallBlind = this.getSmallBlindByDay();
    this.bigBlind = 2 * this.smallBlind;
    this.gameState = GameState.PreFlop;
    this.createHandStartSnapshot();

    const smallBlindPlayer =
      this.activePlayers[(this.dealerPosition + 1) % this.activePlayers.length];
    const bigBlindPlayer =
      this.activePlayers[(this.dealerPosition + 2) % this.activePlayers.length];

    // Handle small blind payment
    const smallBlindAmount = Math.min(
      this.smallBlind,
      smallBlindPlayer.getChips()
    );
    smallBlindPlayer.removeChips(smallBlindAmount);
    smallBlindPlayer.setCurrentBet(smallBlindAmount);
    this.events.push(
      new GameEvent(
        `${smallBlindPlayer.getId()} posted small blind of ${smallBlindAmount}${
          smallBlindPlayer.getChips() === 0 ? " *:rotating_light: ALL-IN :rotating_light:*" : ""
        }`
      )
    );
    this.bettingHistory.push({
      street: "preflop",
      playerId: smallBlindPlayer.getId(),
      actionType: "small_blind",
      amount: smallBlindAmount,
      contributionAmount: smallBlindAmount,
      timestamp: Date.now(),
    });
    this.recordHandAction(
      smallBlindPlayer.getId(),
      "post_small_blind",
      smallBlindAmount,
      smallBlindAmount,
      smallBlindPlayer.getIsAllIn()
    );

    // Handle big blind payment
    const bigBlindAmount = Math.min(this.bigBlind, bigBlindPlayer.getChips());
    bigBlindPlayer.removeChips(bigBlindAmount);
    bigBlindPlayer.setCurrentBet(bigBlindAmount);

    this.events.push(
      new GameEvent(
        `${bigBlindPlayer.getId()} posted big blind of ${bigBlindAmount}${bigBlindPlayer.getChips() === 0 ? " *:rotating_light: ALL-IN :rotating_light:*" : ""}`
      )
    );
    this.bettingHistory.push({
      street: "preflop",
      playerId: bigBlindPlayer.getId(),
      actionType: "big_blind",
      amount: bigBlindAmount,
      contributionAmount: bigBlindAmount,
      timestamp: Date.now(),
    });
    this.recordHandAction(
      bigBlindPlayer.getId(),
      "post_big_blind",
      bigBlindAmount,
      bigBlindAmount,
      bigBlindPlayer.getIsAllIn()
    );

    this.currentPot += smallBlindAmount + bigBlindAmount;
    this.currentBetAmount = this.bigBlind;

    const currentPlayer = this.getCurrentPlayer();
    if (currentPlayer) {
      this.events.push(
        new GameEvent(`${currentPlayer.getId()}'s turn`, [], false, "", true)
      );
    }
    return Success;
  }

  private endRound(): void {
    // Handle side pots and distribute winnings
    const potResults = this.handleSidePots();

    if (this.communityCards.length < 5) {
      // round is over reveal community cards
      while (this.communityCards.length < 5) {
        if (this.communityCards.length === 0) {
          this.burnAndDeal(3);
        } else {
          this.burnAndDeal(1);
        }
      }
      this.updateBoardSnapshot();
      this.events.push(
        new GameEvent("Community Cards would have been:", [
          ...this.communityCards,
        ])
      );
    }

    this.activePlayers.forEach((player) => {
      if (player.getPreNH()) {
        this.events.push(new GameEvent(`${player.getId()} says :nh:`));
        player.setPreNH(false);
        player.setPreAH(false);
      } else if (player.getPreAH()) {
        this.events.push(new GameEvent(`${player.getId()} says :ah:`));
        player.setPreNH(false);
        player.setPreAH(false);
      }
    });

    this.finalizeHandEndSnapshot(potResults);
    this.currentPot = 0;
    this.currentBetAmount = 0;
    this.lastRaiseAmount = 0;

    this.gameState = GameState.WaitingForPlayers;
    // Move dealer button to next player for next round
    this.dealerPosition = (this.dealerPosition + 1) % this.activePlayers.length;

    const playersToAdd: string[] = [];
    const playersToRemove: string[] = [];

    this.inactivePlayers.forEach((player) => {
      if (player.getWantsToJoinTable()) {
        playersToAdd.push(player.getId());
        player.setWantsToJoinTable(false);
      }
    });
    this.activePlayers.forEach((player) => {
      if (player.getWantsToLeaveTable()) {
        playersToRemove.push(player.getId());
        player.setWantsToLeaveTable(false);
      }
    });

    playersToAdd.forEach((playerId) => {
      this.addPlayer(playerId);
    });
    playersToRemove.forEach((playerId) => {
      this.removePlayer(playerId);
    });

    if (this.preDealId) {
      const preDealPlayerId = this.preDealId;
      this.preDealId = undefined;
      this.startRound(preDealPlayerId);
    }
  }

  // private reorderPlayers(): void {
  // 	// Sort active players based on their original positions
  // 	this.activePlayers.sort((a, b) => {
  // 		const posA = this.playerPositions.get(a.getId()) || 0;
  // 		const posB = this.playerPositions.get(b.getId()) || 0;
  // 		return posA - posB;
  // 	});
  // }

  public getCurrentPlayer(): Player | null {
    if (
      this.gameState === GameState.WaitingForPlayers ||
      this.activePlayers.length === 0
    ) {
      return null;
    }
    return this.activePlayers[this.currentPlayerIndex];
  }

  public addPlayer(id: string): boolean {
    // if (this.gameState !== GameState.WaitingForPlayers) {
    // 	this.events.push(new GameEvent(`${id} can't join mid-round!`));
    // 	return false;
    // }

    if (this.activePlayers.length >= 10) {
      this.events.push(
        new GameEvent(`${id} can't join there are too many players!`)
      );
      return false;
    }

    // Check if player already exists in active players
    if (this.activePlayers.some((p) => p.getId() === id)) {
      this.events.push(new GameEvent(`${id} has already joined table!`));
      return false;
    }

    const inactivePlayerIndex = this.inactivePlayers.findIndex(
      (p) => p.getId() === id
    );

    if (this.gameState === GameState.WaitingForPlayers) {
      this.events.push(new GameEvent(`${id} Welcome to the table!`));

      if (inactivePlayerIndex !== -1) {
        const player = this.inactivePlayers[inactivePlayerIndex];
        this.inactivePlayers.splice(inactivePlayerIndex, 1);
        this.activePlayers.push(player);
        return true;
      }

      const newPlayer = new Player(id, 0);
      this.activePlayers.push(newPlayer);

      // Assign position to new player
      if (!this.playerPositions.has(id)) {
        this.playerPositions.set(id, this.activePlayers.length - 1);
      }
    } else {
      let player = new Player(id, 0);
      if (inactivePlayerIndex !== -1) {
        player = this.inactivePlayers[inactivePlayerIndex];
      }
      player.setWantsToJoinTable(true);
      this.events.push(
        new GameEvent(`${id} Will join the game once this round is over!`)
      );
    }

    return true;
  }

  public removePlayer(playerId: string): boolean {
    // if (this.gameState !== GameState.WaitingForPlayers) {
    // 	this.events.push(new GameEvent(`${playerId} Can't leave during round!`));
    // 	return false;
    // }
    const playerIndex = this.activePlayers.findIndex(
      (player) => player.getId() === playerId
    );
    if (playerIndex === -1) {
      this.events.push(new GameEvent(`${playerId} isn't at the table!`));
      return false;
    }

    if (this.gameState !== GameState.WaitingForPlayers) {
      const player = this.activePlayers.find((p) => p.getId() === playerId);
      if (!player) {
        this.events.push(new GameEvent(`${playerId} Player not found!`));
        return false;
      }
      player.setWantsToLeaveTable(true);
      this.events.push(
        new GameEvent(`${playerId} will leave once the round is over!`)
      );
      return true;
    } else {
      const [player] = this.activePlayers.splice(playerIndex, 1);
      this.inactivePlayers.push(player);

      // // Reset dealer position if it's now invalid
      // if (this.dealerPosition >= this.activePlayers.length) {
      //   this.dealerPosition = 0;
      // }
      this.events.push(new GameEvent(`${playerId} has left the table!`));
      return true;
    }
  }

  public deletePlayer(targetPlayerId: string): string {
    if (this.gameState !== GameState.WaitingForPlayers) {
      this.events.push(
        new GameEvent(`Cannot remove player during active round!`)
      );
      return "Cannot remove player during active round";
    }

    const activePlayerIndex = this.activePlayers.findIndex(
      (player) => player.getId() === targetPlayerId
    );
    const inactivePlayerIndex = this.inactivePlayers.findIndex(
      (player) => player.getId() === targetPlayerId
    );

    if (activePlayerIndex === -1 && inactivePlayerIndex === -1) {
      this.events.push(new GameEvent(`${targetPlayerId} Player not found!`));
      return "Player not found";
    }

    if (activePlayerIndex !== -1) {
      this.events.push(
        new GameEvent(
          `${targetPlayerId} is still active at the table! Player must be inactive to be removed.`
        )
      );
      return "Player is still active";
    }

    const player = this.inactivePlayers[inactivePlayerIndex];

    if (player.getChips() !== 0) {
      this.events.push(
        new GameEvent(
          `${targetPlayerId} Cannot remove player with ${player.getChips()} chips! Player must have 0 chips.`
        )
      );
      return "Cannot remove player with chips remaining";
    }

    this.inactivePlayers.splice(inactivePlayerIndex, 1);
    this.playerPositions.delete(targetPlayerId);

    this.events.push(
      new GameEvent(`${targetPlayerId} has been permanently removed from the game!`)
    );
    return Success;
  }

  public buyIn(playerId: string, chips: number): string {
    const roundedChips = Math.round(chips);

    if (this.gameState !== GameState.WaitingForPlayers) {
      this.events.push(
        new GameEvent(`${playerId} Cannot buy in during active round!`)
      );
      return "Cannot buy in during active round";
    }

    if (roundedChips <= 0) {
      this.events.push(new GameEvent(`${playerId} Invalid chip number!`));
      return "Buy in amount must be positive";
    }

    let player = this.activePlayers.find((p) => p.getId() === playerId);
    if (!player) {
      player = this.inactivePlayers.find((p) => p.getId() === playerId);
      if (!player) {
        // Auto-join the table if player is not found
        this.addPlayer(playerId);
        player = this.activePlayers.find((p) => p.getId() === playerId);
        if (!player) {
          this.events.push(new GameEvent(`${playerId} Failed to join table!`));
          return "Failed to join table";
        }
      }
    }

    player.addChips(roundedChips);
    player.addToTotalBuyIn(roundedChips);
    this.events.push(
      new GameEvent(`${playerId} Bought-in for ${roundedChips} chips`)
    );
    return Success;
  }

  public cashOut(playerId: string): boolean {
    if (this.gameState !== GameState.WaitingForPlayers) {
      this.events.push(
        new GameEvent(`${playerId} Cannot cash out during active round!`)
      );
      return false;
    }

    const player =
      this.activePlayers.find((p) => p.getId() === playerId) ||
      this.inactivePlayers.find((p) => p.getId() === playerId);

    if (!player) {
      this.events.push(new GameEvent(`${playerId} Player not found!`));
      return false;
    }

    const chips = player.getChips();
    if (chips === 0) {
      this.events.push(new GameEvent(`${playerId} No chips to cash out!`));
      return false;
    }

    player.removeChips(chips);
    player.setTotalBuyIn(0);
    player.setAllIn(false);
    this.events.push(new GameEvent(`${playerId} Cashed out ${chips} chips`));
    return true;
  }

  public dealInitialCards(): void {
    // Deal two cards to each player
    for (let i = 0; i < 2; i++) {
      this.activePlayers.forEach((player) => {
        const card = this.deck.draw();
        if (card) {
          player.addCard(card);
        }
      });
    }

    this.activePlayers.forEach((player) => {
      this.events.push(
        new GameEvent(
          `${player.getId()} your cards:`,
          player.getCards(),
          true,
          player.getId()
        )
      );
    });
  }

  private burnAndDeal(numCards: number) {
    // Burn one card then deal one community card
    this.deck.draw();
    for (let i = 0; i < numCards; i++) {
      const card = this.deck.draw();
      if (card) {
        this.communityCards.push(card);
      }
    }
  }

  public dealFlop(): void {
    this.burnAndDeal(3);
    this.updateBoardSnapshot();
    this.events.push(new GameEvent("Flop:", this.communityCards));
    this.activePlayers.forEach((player) => {
      if (!this.foldedPlayers.has(player.getId())) {
        this.showCards(player.getId(), false, false);
      }
    });
  }

  public dealTurn(): void {
    this.burnAndDeal(1);
    this.updateBoardSnapshot();
    this.events.push(new GameEvent("Turn:", [...this.communityCards]));
    this.activePlayers.forEach((player) => {
      if (!this.foldedPlayers.has(player.getId())) {
        this.showCards(player.getId(), false, false);
      }
    });
  }

  public dealRiver(): void {
    this.burnAndDeal(1);
    this.updateBoardSnapshot();
    this.events.push(new GameEvent("River:", [...this.communityCards]));
    this.activePlayers.forEach((player) => {
      if (!this.foldedPlayers.has(player.getId())) {
        this.showCards(player.getId(), false, false);
      }
    });
  }

  public addToPot(amount: number): void {
    this.currentPot += amount;
  }

  private advanceToNextPlayer(): void {
    const initialIndex = this.currentPlayerIndex;
    let currentPlayer;
    do {
      this.currentPlayerIndex =
        (this.currentPlayerIndex + 1) % this.activePlayers.length;
      // If we've looped through all players and they're all folded or all-in, break
      if (this.currentPlayerIndex === initialIndex) {
        break;
      }
      currentPlayer = this.getCurrentPlayer();
    } while (
      currentPlayer &&
      (this.foldedPlayers.has(currentPlayer.getId()) ||
        currentPlayer.getIsAllIn())
    );

    if (currentPlayer) {
      this.events.push(
        new GameEvent(`${currentPlayer.getId()}'s turn`, [], false, "", true)
      );
    }
  }

  public preDeal(playerId: string): void {
    if (this.gameState === GameState.WaitingForPlayers) {
      this.startRound(playerId);
      return;
    }

    this.preDealId = playerId;
    this.events.push(new GameEvent(`${playerId} is pre-dealing!`));
  }

  public preAH(playerId: string): void {
    if (this.gameState === GameState.WaitingForPlayers) {
      this.events.push(
        new GameEvent(`${playerId} Cannot pre-ah, may not be a :ah:!`)
      );
      return;
    }

    const player = this.activePlayers.find(
      (player) => player.getId() === playerId
    );
    if (!player) {
      this.events.push(
        new GameEvent(`${playerId} Cannot pre-ah, player not found!`)
      );
      return;
    }

    player.setPreAH(true);
    player.setPreNH(false);
    this.events.push(new GameEvent(`${playerId} pre-ah!`));
  }

  public preNH(playerId: string): void {
    if (this.gameState === GameState.WaitingForPlayers) {
      this.events.push(
        new GameEvent(`${playerId} Cannot pre-nh, may not be a :nh:!`)
      );
      return;
    }

    const player = this.activePlayers.find(
      (player) => player.getId() === playerId
    );
    if (!player) {
      this.events.push(
        new GameEvent(`${playerId} Cannot pre-nh, player not found!`)
      );
      return;
    }

    player.setPreNH(true);
    player.setPreAH(false);
    this.events.push(new GameEvent(`${playerId} pre-nh!`));
  }

  public preFold(playerId: string): void {
    if (this.gameState === GameState.WaitingForPlayers) {
      this.events.push(
        new GameEvent(`${playerId} Cannot pre-fold, round has not started!`)
      );
      return;
    }

    const player = this.activePlayers.find(
      (player) => player.getId() === playerId
    );
    if (!player) {
      this.events.push(
        new GameEvent(`${playerId} Cannot pre-fold, player not found!`)
      );
      return;
    }

    const currentPlayer = this.getCurrentPlayer();
    if (!currentPlayer || currentPlayer.getId() == playerId) {
      this.fold(playerId);
      return;
    }

    if (this.foldedPlayers.has(playerId)) {
      this.events.push(
        new GameEvent(`${playerId} Cannot pre-fold, you have folded!`)
      );
      return;
    }

    player.setPreMove({ move: "fold" });
    this.events.push(new GameEvent(`${playerId} pre-folded!`));
  }

  // public fixTheGame(): void {
  // 	this.communityCards = [];
  // 	this.deck.reset();
  // 	this.deck.shuffle();

  // 	this.activePlayers.forEach((player) => {
  // 		player.removeAllCards();
  // 	});

  // 	this.dealInitialCards();

  // 	// this.dealFlop();
  // }

  public fold(playerId: string): string {
    // Can only fold during an active round
    if (this.gameState === GameState.WaitingForPlayers) {
      this.events.push(
        new GameEvent(`${playerId} Cannot fold, round has not started!`)
      );
      return "Cannot fold, game is not active";
    }

    const player = this.getCurrentPlayer();
    if (!player || player.getId() !== playerId) {
      this.events.push(
        new GameEvent(`${playerId} Cannot fold, not your turn!`)
      );
      return "Not your turn to fold";
    }

    let message = `${playerId} folded!`;

    if (
      this.currentBetAmount == 0 ||
      player.getCurrentBet() >= this.currentBetAmount
    ) {
      message += " :narp-brain:";
    }

    this.events.push(new GameEvent(message));

    this.foldedPlayers.add(playerId);
    player.setHadTurnThisRound(true);
    this.bettingHistory.push({
      street: this.gameStateToStreet(this.gameState),
      playerId,
      actionType: "fold",
      amount: 0,
      contributionAmount: 0,
      timestamp: Date.now(),
    });
    this.recordHandAction(playerId, "fold", 0, player.getCurrentBet(), player.getIsAllIn());

    this.advanceToNextPlayer();

    // Check if round should end (only one player left who hasn't folded)
    const activeNonFoldedPlayers = this.activePlayers.filter(
      (p) => !this.foldedPlayers.has(p.getId())
    );
    if (activeNonFoldedPlayers.length <= 1) {
      this.endRound();

      // if (this.communityCards.length < 5) {
      // 	// round is over reveal community cards
      // 	while (this.communityCards.length < 5) {
      // 		if (this.communityCards.length === 0) {
      // 			this.burnAndDeal(3);
      // 		} else {
      // 			this.burnAndDeal(1);
      // 		}
      // 	}
      // 	this.events.push(new GameEvent('Community Cards would have been:', [...this.communityCards]));
      // }

      return Success + ": round ended";
    }

    this.progressGame();
    return Success;
  }

  public preCheck(playerId: string): void {
    if (this.gameState === GameState.WaitingForPlayers) {
      this.events.push(
        new GameEvent(`${playerId} Cannot pre-check, round has not started!`)
      );
      return;
    }

    const player = this.activePlayers.find(
      (player) => player.getId() === playerId
    );
    if (!player) {
      this.events.push(
        new GameEvent(`${playerId} Cannot pre-check, player not found!`)
      );
      return;
    }

    if (this.foldedPlayers.has(playerId)) {
      this.events.push(
        new GameEvent(`${playerId} Cannot pre-check, you have folded!`)
      );
      return;
    }

    const currentPlayer = this.getCurrentPlayer();
    if (!currentPlayer || currentPlayer.getId() == playerId) {
      this.check(playerId);
      return;
    }

    player.setPreMove({ move: "check" });
    this.events.push(new GameEvent(`${playerId} pre-checked!`));
  }

  public check(playerId: string): string {
    if (this.gameState === GameState.WaitingForPlayers) {
      this.events.push(
        new GameEvent(`${playerId} Cannot check, round has not started!`)
      );
      return "Cannot check, game is not active";
    }

    const player = this.getCurrentPlayer();
    if (!player || player.getId() !== playerId) {
      this.events.push(
        new GameEvent(`${playerId} Cannot check, not your turn!`)
      );
      return "Not your turn to check";
    }

    // Player can only check if no bets have been made in current round
    if (
      this.currentBetAmount > 0 &&
      player.getCurrentBet() < this.currentBetAmount
    ) {
      this.events.push(
        new GameEvent(
          `${playerId} Cannot check, there are active bets! (${this.currentBetAmount} chips)`
        )
      );
      return "Cannot check, there are active bets";
    }

    this.events.push(new GameEvent(`${playerId} checked!`));

    player.setHadTurnThisRound(true);
    this.bettingHistory.push({
      street: this.gameStateToStreet(this.gameState),
      playerId,
      actionType: "check",
      amount: 0,
      contributionAmount: 0,
      timestamp: Date.now(),
    });
    this.recordHandAction(playerId, "check", 0, player.getCurrentBet(), player.getIsAllIn());

    this.advanceToNextPlayer();
    // if (this.isBettingRoundComplete()) {
    this.progressGame();
    // }
    return Success;
  }

  public preBet(playerId: string, amount: number): void {
    if (this.gameState === GameState.WaitingForPlayers) {
      this.events.push(
        new GameEvent(`${playerId} Cannot pre-bet, round has not started!`)
      );
      return;
    }

    const player = this.activePlayers.find(
      (player) => player.getId() === playerId
    );
    if (!player) {
      this.events.push(
        new GameEvent(`${playerId} Cannot pre-bet, player not found!`)
      );
      return;
    }

    if (this.foldedPlayers.has(playerId)) {
      this.events.push(
        new GameEvent(`${playerId} Cannot pre-bet, you have folded!`)
      );
      return;
    }

    const currentPlayer = this.getCurrentPlayer();
    if (!currentPlayer || currentPlayer.getId() == playerId) {
      this.bet(playerId, amount);
      return;
    }

    player.setPreMove({ move: "bet", amount: amount });
    this.events.push(new GameEvent(`${playerId} pre-bet ${amount}!`));
  }

  public bet(playerId: string, amount: number): string {
    if (this.gameState === GameState.WaitingForPlayers) {
      this.events.push(
        new GameEvent(`${playerId} Cannot bet, game is not active!`)
      );
      return "Cannot bet, game is not active";
    }

    const player = this.getCurrentPlayer();
    if (!player || player.getId() !== playerId) {
      this.events.push(new GameEvent(`${playerId} Cannot bet, not your turn!`));
      return "Not your turn to bet";
    }

    const roundedAmount = Math.round(amount);

    // Validate bet amount
    if (roundedAmount <= 0) {
      this.events.push(
        new GameEvent(`${playerId} Cannot bet, amount must be positive!`)
      );
      return "Bet amount must be positive";
    }

    let isRaise = false;
    let betAmount = 0;
    // If this is the first bet in the round
    if (this.currentBetAmount === 0) {
      // if (roundedAmount > player.getChips()) {
      // 	this.events.push(new GameEvent(`${playerId} Cannot bet, not enough chips!`));
      // 	return 'Not enough chips to bet';
      // }
      betAmount = roundedAmount;
    } else {
      // Calculate the raise amount by subtracting the player's current bet
      betAmount = roundedAmount - player.getCurrentBet();

      // const minRaise = Math.max(this.lastRaiseAmount, this.bigBlind);

      // if (roundedAmount - this.currentBetAmount < minRaise) {
      // 	this.events.push(new GameEvent(`${playerId} Cannot raise, minimum raise is ${minRaise}!`));
      // 	return `Raise must be at least ${minRaise}`;
      // }
      isRaise = true;
    }

    if (betAmount > player.getChips()) {
      this.events.push(
        new GameEvent(`${playerId} Cannot bet, not enough chips!`)
      );
      return "Not enough chips to bet";
    }

    if (betAmount != player.getChips()) {
      const minRaise = Math.max(this.lastRaiseAmount, this.bigBlind);
      if (roundedAmount - this.currentBetAmount < minRaise) {
        this.events.push(
          new GameEvent(
            `${playerId} Cannot raise, minimum raise is ${minRaise}!`
          )
        );
        return `Raise must be at least ${minRaise}`;
      }
    }

    // if (roundedAmount < this.bigBlind) {
    // 	this.events.push(new GameEvent(`${playerId} Cannot raise, minimum raise is ${this.bigBlind}!`));
    // 	return `Raise must be at least ${this.bigBlind}`;
    // }

    // Calculate total chips player can win from other players
    const maxWinnable = Math.max(
      ...this.activePlayers
        .filter((p) => p.getId() !== playerId)
        .map((p) => p.getChips() + p.getCurrentBet())
    );

    if (betAmount > maxWinnable) {
      this.events.push(
        new GameEvent(
          `${playerId} Cannot bet more than ${maxWinnable} - no reason to bet more than you can win!`
        )
      );
      return `No reason to bet more than ${maxWinnable}`;
    }

    this.currentBetAmount = roundedAmount;
    // if (isRaise) {
    this.lastRaiseAmount = betAmount;
    player.setLastRaise(betAmount);
    // }

    // this.currentBetAmount = roundedAmount;
    player.removeChips(betAmount);
    player.addToCurrentBet(betAmount);
    player.setHadTurnThisRound(true);

    this.addToPot(betAmount);
    
    const actionType: BettingActionType = player.getIsAllIn()
      ? "all_in"
      : isRaise
        ? "raise"
        : "bet";
    this.bettingHistory.push({
      street: this.gameStateToStreet(this.gameState),
      playerId,
      actionType,
      amount: roundedAmount,
      contributionAmount: betAmount,
      underlyingActionType: player.getIsAllIn()
        ? isRaise
          ? "raise"
          : "bet"
        : undefined,
      timestamp: Date.now(),
    });
    this.recordHandAction(
      playerId,
      isRaise ? "raise" : "bet",
      betAmount,
      roundedAmount,
      player.getIsAllIn()
    );
    
    this.advanceToNextPlayer();
    this.progressGame();

    this.events.push(
      new GameEvent(
        `${playerId} ${isRaise ? "raised" : "bet"} ${roundedAmount} chips!${player.getIsAllIn() ? " *:rotating_light: ALL-IN :rotating_light:*" : ""} Total Pot: ${
          this.currentPot
        }`
      )
    );

    return isRaise ? `Raised to ${roundedAmount}` : `Bet ${roundedAmount}`;
  }

  public preCall(playerId: string): void {
    if (this.gameState === GameState.WaitingForPlayers) {
      this.events.push(
        new GameEvent(`${playerId} Cannot pre-call, round has not started!`)
      );
      return;
    }

    const player = this.activePlayers.find(
      (player) => player.getId() === playerId
    );
    if (!player) {
      this.events.push(
        new GameEvent(`${playerId} Cannot pre-call, player not found!`)
      );
      return;
    }

    if (this.foldedPlayers.has(playerId)) {
      this.events.push(
        new GameEvent(`${playerId} Cannot pre-call, you have folded!`)
      );
      return;
    }

    const currentPlayer = this.getCurrentPlayer();
    if (!currentPlayer || currentPlayer.getId() == playerId) {
      this.call(playerId);
      return;
    }

    player.setPreMove({ move: "call", amount: this.currentBetAmount });
    this.events.push(new GameEvent(`${playerId} pre-called!`));
  }

  public call(playerId: string): string {
    if (this.gameState === GameState.WaitingForPlayers) {
      this.events.push(
        new GameEvent(`${playerId} cannot call, round has not started!`)
      );
      return "Game is not active";
    }

    const player = this.getCurrentPlayer();
    if (!player || player.getId() !== playerId) {
      this.events.push(new GameEvent(`${playerId} It's not your turn!`));
      return "Not your turn";
    }

    // Can only call if there are active bets
    if (this.currentBetAmount === 0) {
      this.events.push(new GameEvent(`${playerId} No active bets to call!`));
      return "No active bets to call";
    }

    // Calculate the amount needed to call, considering existing bet
    const amountToCall = this.currentBetAmount - player.getCurrentBet();
    const callAmount = Math.min(amountToCall, player.getChips());

    if (amountToCall === 0) {
      this.events.push(
        new GameEvent(`${playerId} How about you try doing a check`)
      );
      return "No need to call - already matched the current bet";
    }

    if (callAmount === player.getChips()) {
      player.setAllIn(true);
    }

    player.removeChips(callAmount);
    player.setCurrentBet(player.getCurrentBet() + callAmount);
    player.setHadTurnThisRound(true);

    this.addToPot(callAmount);
    
    this.bettingHistory.push({
      street: this.gameStateToStreet(this.gameState),
      playerId,
      actionType: player.getIsAllIn() ? "all_in" : "call",
      amount: this.currentBetAmount,
      contributionAmount: callAmount,
      underlyingActionType: player.getIsAllIn() ? "call" : undefined,
      timestamp: Date.now(),
    });
    this.recordHandAction(
      playerId,
      "call",
      callAmount,
      player.getCurrentBet(),
      player.getIsAllIn()
    );

    const message = player.getIsAllIn()
      ? `${playerId} called ${this.currentBetAmount} chips *:rotating_light: ALL-IN :rotating_light:* Total Pot: ${this.currentPot}`
      : `${playerId} called ${this.currentBetAmount} chips! Total Pot: ${this.currentPot}`;

    this.events.push(new GameEvent(message));

    this.advanceToNextPlayer();
    this.progressGame();

    return player.getIsAllIn() ? Success + ": Player went all-in" : Success;
  }

  public callOrCheck(playerId: string): string {
    const player = this.getCurrentPlayer();
    if (!player || player.getId() !== playerId) {
      this.events.push(new GameEvent(`${playerId} It's not your turn!`));
      return "Not your turn";
    }

    // If no bets or player has already matched, check. Otherwise call.
    if (
      this.currentBetAmount === 0 ||
      player.getCurrentBet() >= this.currentBetAmount
    ) {
      return this.check(playerId);
    } else {
      return this.call(playerId);
    }
  }

  public allIn(playerId: string): string {
    if (this.gameState === GameState.WaitingForPlayers) {
      this.events.push(
        new GameEvent(`${playerId} Cannot go all-in, game is not active!`)
      );
      return "Cannot go all-in, game is not active";
    }

    const player = this.getCurrentPlayer();
    if (!player || player.getId() !== playerId) {
      this.events.push(
        new GameEvent(`${playerId} Cannot go all-in, not your turn!`)
      );
      return "Not your turn to go all-in";
    }

    const playerChips = player.getChips();
    if (playerChips <= 0) {
      this.events.push(
        new GameEvent(`${playerId} Cannot go all-in, you have no chips!`)
      );
      return "No chips to go all-in with";
    }

    // Calculate what amount the all-in would be
    const allInAmount = player.getCurrentBet() + playerChips;

    // Use bet if we're raising, otherwise use call logic
    if (allInAmount > this.currentBetAmount) {
      // Going all-in as a bet/raise
      return this.bet(playerId, allInAmount);
    } else {
      // Going all-in as a call (can't cover the full bet)
      return this.call(playerId);
    }
  }

  private handleSidePots(): PotResult[] {
    const potResults: PotResult[] = [];
    // Get active players who haven't folded
    const activeNonFoldedPlayers = this.activePlayers.filter(
      (player) => !this.foldedPlayers.has(player.getId())
    );

    // If only one player remains, they get the entire pot
    if (activeNonFoldedPlayers.length === 1) {
      const winner = activeNonFoldedPlayers[0];
      this.events.push(
        new GameEvent(`${winner.getId()} wins ${this.currentPot} chips!`)
      );
      winner.addChips(this.currentPot);
      potResults.push({
        potIndex: 0,
        potType: "main",
        potSize: this.currentPot,
        eligiblePlayerIds: [winner.getId()],
        winnerPlayerIds: [winner.getId()],
        splitAmount: this.currentPot,
      });
      return potResults;
    }

    // Get all players who went all-in, sorted by their total contribution
    const allInPlayers = activeNonFoldedPlayers
      .filter((player) => player.getIsAllIn())
      .sort((a, b) => a.getTotalBet() - b.getTotalBet());

    // If all all-in players have the same bet amount, no side pots needed
    if (
      allInPlayers.length === 0 ||
      (activeNonFoldedPlayers.length > 0 &&
        activeNonFoldedPlayers.every(
          (p) => p.getTotalBet() <= allInPlayers[0].getTotalBet()
        ))
    ) {
      // No side pots needed, distribute the entire pot
      potResults.push(
        this.distributePot(activeNonFoldedPlayers, this.currentPot, false, 0)
      );
      return potResults;
    }

    // Create side pots
    let previousBet = 0;
    let totalDistributed = 0;

    allInPlayers.forEach((player) => {
      const currentBet = player.getTotalBet();
      //   const potSize =
      //     (currentBet - previousBet) * activeNonFoldedPlayers.length;

      let potSize = 0;
      this.activePlayers.forEach((p) => {
        if (p.getTotalBet() >= currentBet) {
          // Active players contribute the full difference
          potSize += currentBet - previousBet;
        } else if (
          this.foldedPlayers.has(p.getId()) &&
          p.getTotalBet() > previousBet
        ) {
          // Folded players contribute only what they actually bet
          potSize += Math.min(currentBet, p.getTotalBet()) - previousBet;
        }
      });
      totalDistributed += potSize;

      // Distribute this pot to eligible players
      const eligiblePlayers = activeNonFoldedPlayers.filter(
        (p) => p.getTotalBet() >= currentBet
      );
      potResults.push(
        this.distributePot(eligiblePlayers, potSize, true, potResults.length)
      );

      previousBet = currentBet;
    });

    // Distribute the remaining main pot
    const remainingPot = this.currentPot - totalDistributed;
    if (remainingPot > 0) {
      const eligiblePlayers = activeNonFoldedPlayers.filter(
        (p) => !p.getIsAllIn()
      );
      potResults.push(
        this.distributePot(eligiblePlayers, remainingPot, false, potResults.length)
      );
    }
    return potResults;
  }

  private distributePot(
    eligiblePlayers: Player[],
    potSize: number,
    isSidePot: boolean,
    potIndex: number
  ): PotResult {
    // Evaluate hands and determine the winner(s) for this pot
    const playerHands = eligiblePlayers.map((player) => ({
      player,
      hand: this.evaluateHand([...player.getCards(), ...this.communityCards]),
    }));

    // playerHands.forEach(({ player, hand }) => {
    //   console.log(`${player.getId()} has hand:`, hand);
    // });
    const bestHandPlayerIds = this.getBestHand(playerHands);
    const winners = playerHands.filter((ph) =>
      bestHandPlayerIds.includes(ph.player.getId())
    );
    // Split the pot among winners
    const winnings = potSize / winners.length;
    winners.forEach((winner) => {
      winner.player.addChips(winnings);
    });

    this.events.push(
      new GameEvent("Community Cards:", this.getCommunityCards())
    );

    playerHands.forEach(({ player, hand }) => {
      this.events.push(
        new GameEvent(
          `${player.getId()} had ${hand.description}`,
          player.getCards()
        )
      );
    });

    if (isSidePot) {
      this.events.push(
        new GameEvent(
          `Side pot of ${potSize} won by: ${winners.map((w) => w.player.getId()).join(", ")}`
        )
      );
    } else {
      this.events.push(
        new GameEvent(
          `Main pot of ${potSize} won by: ${winners.map((w) => w.player.getId()).join(", ")}`
        )
      );
    }

    return {
      potIndex,
      potType: isSidePot ? "side" : "main",
      potSize,
      eligiblePlayerIds: eligiblePlayers.map((player) => player.getId()),
      winnerPlayerIds: winners.map((winner) => winner.player.getId()),
      splitAmount: winnings,
    };
  }

  public evaluateHand(cards: Card[]): any {
    if (cards.length !== 7) {
      throw new Error(
        "A hand must consist of exactly 7 cards (2 hole cards + 5 community cards)"
      );
    }

    const cardStrings = cards.map((card) => {
      const rank = card.getRank() === "10" ? "T" : card.getRank().charAt(0);
      const suit = card.getSuit().charAt(0).toLowerCase();
      return `${rank}${suit}`;
    });

    const result = {
      value: evaluateCards(cardStrings),
      description: rankDescription[rankCards(cardStrings)],
    };

    return result;

    // return PokerEvaluator.evalHand(
    // 	cards.map((card) => {
    // 		const rank = card.getRank() === '10' ? 'T' : card.getRank().charAt(0);
    // 		const suit = card.getSuit().charAt(0).toLowerCase();
    // 		return `${rank}${suit}`;
    // 	})
    // );
  }

  public getBestHand(hands: any[]): string[] {
    //{ handType: 9,
    //  handRank: 10,
    //  value: 36874,
    //  handName: 'straight flush' }
    // Find the minimum handRank among all hands
    const minHandValue = Math.min(...hands.map((h) => h.hand.value));
    const winningPlayerIds = hands
      .filter((h) => h.hand.value === minHandValue)
      .map((h) => h.player.getId());
    return winningPlayerIds;
  }

  public getActivePlayers(): Player[] {
    return [...this.activePlayers];
  }

  public getInactivePlayers(): Player[] {
    return [...this.inactivePlayers];
  }

  public getSmallBlind(): number {
    return this.smallBlind;
  }

  public getBigBlind(): number {
    return this.bigBlind;
  }

  public getFoldedPlayers(): Set<string> {
    return this.foldedPlayers;
  }

  public getDealerPosition(): number {
    return this.dealerPosition;
  }

  /**
   * Returns position label for a player based on their index in the active players array.
   * Position labels: D (Dealer), SB (Small Blind), BB (Big Blind)
   * Heads-up: Dealer is also SB (D+SB), other player is BB
   */
  public getPositionLabel(playerIndex: number): string {
    const numPlayers = this.activePlayers.length;
    if (numPlayers === 0) return "";

    // Calculate position relative to dealer
    const relativePosition =
      (playerIndex - this.dealerPosition + numPlayers) % numPlayers;

    // Heads-up: Dealer is also Small Blind
    if (numPlayers === 2) {
      if (relativePosition === 0) return "D+SB";
      if (relativePosition === 1) return "BB";
      return "";
    }

    if (relativePosition === 0) return "D";
    if (relativePosition === 1) return "SB";
    if (relativePosition === 2) return "BB";

    return "";
  }

  /**
   * Returns all players in action order (first to act at top, last to act at bottom).
   * Pre-flop: UTG first, BB last
   * Post-flop: SB first, D last
   * Each entry includes: playerId, positionLabel, isFolded, isCurrentTurn, isAllIn, lastAction
   */
  public getPlayersInTableOrder(): Array<{
    playerId: string;
    positionLabel: string;
    isFolded: boolean;
    isCurrentTurn: boolean;
    isAllIn: boolean;
    lastAction: string | null;
  }> {
    const result: Array<{
      playerId: string;
      positionLabel: string;
      isFolded: boolean;
      isCurrentTurn: boolean;
      isAllIn: boolean;
      lastAction: string | null;
    }> = [];

    const numPlayers = this.activePlayers.length;
    if (numPlayers === 0) return result;

    const currentPlayer = this.getCurrentPlayer();
    const currentPlayerId = currentPlayer?.getId();

    // Determine starting position based on game state
    // Pre-flop: start at UTG (dealer + 3), or dealer in heads-up (dealer is SB)
    // Post-flop (or waiting): start at SB (dealer + 1)
    let startOffset: number;
    if (this.gameState === GameState.PreFlop) {
      // Heads-up: dealer/SB acts first pre-flop
      if (numPlayers === 2) {
        startOffset = 0; // Dealer (who is also SB) acts first
      } else {
        startOffset = 3; // UTG position (after BB)
      }
    } else {
      startOffset = 1; // SB position (first to act post-flop), or BB in heads-up
    }

    // Go around the table in action order
    for (let i = 0; i < numPlayers; i++) {
      const playerIndex = (this.dealerPosition + startOffset + i) % numPlayers;
      const player = this.activePlayers[playerIndex];
      const playerId = player.getId();

      // Derive last action from player state
      let lastAction: string | null = null;
      const isFolded = this.foldedPlayers.has(playerId);
      const hadTurn = player.getHadTurnThisRound();
      const lastRaise = player.getLastRaise();

      if (isFolded) {
        lastAction = "folded";
      } else if (hadTurn) {
        const currentBet = player.getCurrentBet();
        if (lastRaise > 0) {
          lastAction = `raised to ${currentBet}`;
        } else if (currentBet > 0) {
          lastAction = `called ${currentBet}`;
        } else {
          lastAction = "checked";
        }
      }

      result.push({
        playerId,
        positionLabel: this.getPositionLabel(playerIndex),
        isFolded,
        isCurrentTurn: playerId === currentPlayerId,
        isAllIn: player.getIsAllIn(),
        lastAction,
      });
    }

    return result;
  }

  /**
   * Returns list of non-folded player IDs in table order (starting from dealer).
   */
  public getNonFoldedPlayersInOrder(): string[] {
    return this.getPlayersInTableOrder()
      .filter((p) => !p.isFolded)
      .map((p) => p.playerId);
  }

  public getCurrentBetAmount(): number {
    return this.currentBetAmount;
  }
  public getCommunityCards(): Card[] {
    return this.communityCards;
  }

  public getGameState(): GameState {
    return this.gameState;
  }

  public getPlayerHand(playerId: string): Card[] | undefined {
    const player = this.activePlayers.find((p) => p.getId() === playerId);
    return player?.getCards();
  }

  public getCurrentPot(): number {
    return this.currentPot;
  }

  public getEvents(): GameEvent[] {
    return [...this.events];
  }

  public getBettingHistory(): BettingAction[] {
    return [...this.bettingHistory];
  }

  public getHandStartChips(): Map<string, number> {
    return new Map(this.handStartChips);
  }

  public getHandStartSnapshot(): HandStartSnapshot | null {
    if (!this.handStartSnapshot) {
      return null;
    }

    return {
      handId: this.handStartSnapshot.handId,
      dealerPosition: this.handStartSnapshot.dealerPosition,
      smallBlind: this.handStartSnapshot.smallBlind,
      bigBlind: this.handStartSnapshot.bigBlind,
      players: this.handStartSnapshot.players.map((player) => ({
        ...player,
        holeCards: this.cloneCards(player.holeCards),
      })),
    };
  }

  public getActionHistory(): HandAction[] {
    return this.actionHistory.map((action) => ({ ...action }));
  }

  public getBoardSnapshot(): BoardSnapshot {
    return this.cloneBoardSnapshot(this.boardSnapshot);
  }

  public getHandEndSnapshot(): HandEndSnapshot | null {
    if (!this.handEndSnapshot) {
      return null;
    }

    return {
      handId: this.handEndSnapshot.handId,
      players: this.handEndSnapshot.players.map((player) => ({ ...player })),
      potResults: this.handEndSnapshot.potResults.map((potResult) => ({
        ...potResult,
        eligiblePlayerIds: [...potResult.eligiblePlayerIds],
        winnerPlayerIds: [...potResult.winnerPlayerIds],
      })),
    };
  }

  public getBettingHistoryByStreet(street: BettingStreet): BettingAction[] {
    return this.bettingHistory.filter((action) => action.street === street);
  }

  public getPreflopBettingHistory(): BettingAction[] {
    return this.getBettingHistoryByStreet("preflop");
  }

  public getFlopBettingHistory(): BettingAction[] {
    return this.getBettingHistoryByStreet("flop");
  }

  public getTurnBettingHistory(): BettingAction[] {
    return this.getBettingHistoryByStreet("turn");
  }

  public getRiverBettingHistory(): BettingAction[] {
    return this.getBettingHistoryByStreet("river");
  }

  private gameStateToStreet(gameState: GameState): BettingStreet {
    switch (gameState) {
      case GameState.PreFlop:
        return "preflop";
      case GameState.Flop:
        return "flop";
      case GameState.Turn:
        return "turn";
      case GameState.River:
        return "river";
      default:
        return "preflop";
    }
  }

  public showCards(
    playerId: string,
    reveal: boolean = false,
    showCommunityCards: boolean = true,
    showPlayerCards: boolean = true,
    cardIndexToReveal?: number
  ): void {
    let player = this.activePlayers.find((p) => p.getId() === playerId);

    if (!player) {
      player = this.inactivePlayers.find((p) => p.getId() === playerId);
    }

    if (!player) {
      this.events.push(new GameEvent(`${playerId} is not in the game!`));
      return;
    }
    const cards = player.getCards();
    if (!cards || cards.length === 0) {
      this.events.push(new GameEvent(`${playerId} has no cards to show!`));
      return;
    }
    const isSingleCardReveal = cardIndexToReveal !== undefined;
    if (
      isSingleCardReveal &&
      (!Number.isInteger(cardIndexToReveal) ||
        (cardIndexToReveal as number) < 0 ||
        (cardIndexToReveal as number) >= cards.length)
    ) {
      this.events.push(
        new GameEvent(
          `${playerId} Invalid card selection! Choose 1 or 2.`
        )
      );
      return;
    }

    let cardsToShow = cards;
    if (isSingleCardReveal) {
      cardsToShow = [cards[cardIndexToReveal as number]];
    }

    const cardStrings = [...this.communityCards, ...cards].map((card) => {
      const rank = card.getRank() === "10" ? "T" : card.getRank().charAt(0);
      const suit = card.getSuit().charAt(0).toLowerCase();
      return `${rank}${suit}`;
    });

    let message = "";
    if (isSingleCardReveal) {
      message = reveal
        ? `${playerId} revealed card ${(cardIndexToReveal as number) + 1}`
        : `Your card ${(cardIndexToReveal as number) + 1}`;
    } else if (this.communityCards.length > 0) {
      let handDescription = rankDescription[rankCards(cardStrings)];
      if (handDescription == "High Card") {
        handDescription = "Ass";
      }
      if (reveal) {
        message = `${playerId} revealed ${handDescription}`;
      } else {
        message = `You have ${handDescription}`;
      }
    }

    if (showCommunityCards && this.communityCards.length > 0) {
      this.events.push(
        new GameEvent(
          "Community Cards:",
          this.communityCards,
          !reveal,
          playerId
        )
      );
    }

    // When showPlayerCards is false, don't include the cards in the event (for cardless reveal)
    if (showPlayerCards) {
      this.events.push(new GameEvent(message, cardsToShow, !reveal, playerId));
    } else {
      this.events.push(new GameEvent(message, [], !reveal, playerId));
    }
  }

  public getGameStateEvent(): void {
    let message = `Game State: ${GameState[this.gameState]}\n`;
    message += `Total Pot: ${this.currentPot}\n`;
    message += `Current Bet: ${this.currentBetAmount}\n`;

    const allPlayers = [
      ...this.getActivePlayers(),
      ...this.getInactivePlayers(),
    ];

    allPlayers.forEach((player) => {
      message += `${player.getId()}: ${player.getChips()} chips, Total Bet ${player.getTotalBet()}, Current Bet ${player.getCurrentBet()}, Total Buy-In ${player.getTotalBuyIn()} ${
        player.getIsAllIn() ? "(All-In)" : ""
      } ${this.foldedPlayers.has(player.getId()) ? "(Folded)" : ""} \n`;
    });

    const currentPlayer = this.getCurrentPlayer();
    if (currentPlayer) {
      message += `\nIt's ${currentPlayer.getId()}'s turn`;
    }

    this.events.push(new GameEvent(message, this.getCommunityCards()));
  }

  private serializeHandStartSnapshot() {
    if (!this.handStartSnapshot) {
      return null;
    }

    return {
      ...this.handStartSnapshot,
      players: this.handStartSnapshot.players.map((player) => ({
        ...player,
        holeCards: player.holeCards.map((card) => card.toJson()),
      })),
    };
  }

  private serializeBoardSnapshot(boardSnapshot: BoardSnapshot) {
    return {
      flop: boardSnapshot.flop.map((card) => card.toJson()),
      turn: boardSnapshot.turn.map((card) => card.toJson()),
      river: boardSnapshot.river.map((card) => card.toJson()),
    };
  }

  private serializeHandEndSnapshot() {
    if (!this.handEndSnapshot) {
      return null;
    }

    return {
      ...this.handEndSnapshot,
    };
  }

  private serializeHandHistory() {
    return {
      handCounter: this.handCounter,
      handStartSnapshot: this.serializeHandStartSnapshot(),
      actionHistory: this.actionHistory,
      boardSnapshot: this.serializeBoardSnapshot(this.boardSnapshot),
      handEndSnapshot: this.serializeHandEndSnapshot(),
    };
  }

  public toJson(): any {
    return {
      gameState: this.gameState,
      deck: this.deck.toJson(),
      communityCards: this.communityCards.map((card) => card.toJson()),
      activePlayers: this.activePlayers.map((player) => player.toJson()),
      inactivePlayers: this.inactivePlayers.map((player) => player.toJson()),
      currentPot: this.currentPot,
      dealerPosition: this.dealerPosition,
      smallBlind: this.smallBlind,
      bigBlind: this.bigBlind,
      currentPlayerIndex: this.currentPlayerIndex,
      foldedPlayers: Array.from(this.foldedPlayers),
      currentBetAmount: this.currentBetAmount,
      lastRaiseAmount: this.lastRaiseAmount,
      playerPositions: Array.from(this.playerPositions.entries()),
      preDealId: this.preDealId,
      bettingHistory: this.bettingHistory,
      handStartChips: Array.from(this.handStartChips.entries()),
      handHistory: this.serializeHandHistory(),
    } as const;
  }

  public static fromJson(data: any): TexasHoldem {
    // const data = JSON.parse(json);
    const handHistory = data.handHistory ?? {};
    const deserializeBoardSnapshot = (boardSnapshot: any): BoardSnapshot => ({
      flop: (boardSnapshot?.flop ?? []).map((cardJson: any) =>
        Card.fromJson(cardJson)
      ),
      turn: (boardSnapshot?.turn ?? []).map((cardJson: any) =>
        Card.fromJson(cardJson)
      ),
      river: (boardSnapshot?.river ?? []).map((cardJson: any) =>
        Card.fromJson(cardJson)
      ),
    });

    const deserializeHandStartSnapshot = (
      handStartSnapshot: any
    ): HandStartSnapshot | null => {
      if (!handStartSnapshot) {
        return null;
      }

      return {
        handId: handStartSnapshot.handId,
        dealerPosition: handStartSnapshot.dealerPosition,
        smallBlind: handStartSnapshot.smallBlind,
        bigBlind: handStartSnapshot.bigBlind,
        players: (handStartSnapshot.players ?? []).map((player: any) => ({
          ...player,
          roleFlags: {
            isDealer: Boolean(
              player.roleFlags?.isDealer ?? player.positionLabel?.includes("D")
            ),
            isSmallBlind: Boolean(
              player.roleFlags?.isSmallBlind ??
                player.positionLabel?.includes("SB")
            ),
            isBigBlind: Boolean(
              player.roleFlags?.isBigBlind ?? player.positionLabel?.includes("BB")
            ),
          },
          holeCards: (player.holeCards ?? []).map((cardJson: any) =>
            Card.fromJson(cardJson)
          ),
        })),
      };
    };

    const deserializeHandEndSnapshot = (
      handEndSnapshot: any
    ): HandEndSnapshot | null => {
      if (!handEndSnapshot) {
        return null;
      }

      return {
        handId: handEndSnapshot.handId,
        players: (handEndSnapshot.players ?? []).map((player: any) => ({
          ...player,
        })),
        potResults: (handEndSnapshot.potResults ?? []).map((potResult: any) => ({
          ...potResult,
          eligiblePlayerIds: [...(potResult.eligiblePlayerIds ?? [])],
          winnerPlayerIds: [...(potResult.winnerPlayerIds ?? [])],
        })),
      };
    };

    const game = new TexasHoldem(
      data.gameState,
      Deck.fromJson(data.deck),
      data.communityCards.map((cardJson: string) => Card.fromJson(cardJson)),
      data.activePlayers.map((playerJson: string) =>
        Player.fromJson(playerJson)
      ),
      data.inactivePlayers.map((playerJson: string) =>
        Player.fromJson(playerJson)
      ),
      data.currentPot,
      data.dealerPosition,
      data.smallBlind,
      data.bigBlind,
      data.currentPlayerIndex,
      new Set(data.foldedPlayers),
      data.currentBetAmount,
      data.lastRaiseAmount,
      new Map(data.playerPositions),
      data.preDealId,
      data.bettingHistory || [],
      new Map(data.handStartChips || []),
      handHistory.handCounter ?? data.handCounter ?? 0,
      deserializeHandStartSnapshot(
        handHistory.handStartSnapshot ?? data.handStartSnapshot
      ),
      handHistory.actionHistory ?? data.actionHistory ?? [],
      deserializeBoardSnapshot(handHistory.boardSnapshot ?? data.boardSnapshot),
      deserializeHandEndSnapshot(
        handHistory.handEndSnapshot ?? data.handEndSnapshot
      )
    );
    return game;
  }

  // only for testing
  public setCommunityCards(cards: Card[]): void {
    this.communityCards = cards;
    this.updateBoardSnapshot();
  }

  private getSmallBlindByDay(): number {
    const now = new Date();

    // Always in Eastern Time (handles EST/EDT correctly)
    const options: Intl.DateTimeFormatOptions = {
      weekday: "long",
      timeZone: "America/New_York",
    };
    const dayOfWeek = new Intl.DateTimeFormat("en-US", options).format(now);

    let smallBlind = 10;

    switch (dayOfWeek) {
      case "Monday":
        smallBlind = 10;
        break;
      case "Tuesday":
        smallBlind = 15;
        break;
      case "Wednesday":
        smallBlind = 20;
        break;
      case "Thursday":
        smallBlind = 30;
        break;
      case "Friday":
        smallBlind = 40;
        break;
      case "Saturday":
        smallBlind = 10;
        break;
      case "Sunday":
        smallBlind = 10;
        break;
      default:
        smallBlind = 10;
    }

    return smallBlind;
  }

  public getState(): any {
    return {
      gameState: this.gameState,
      deck: this.deck.toJson(),
      events: this.events.map((event) => event.toJson()),
      communityCards: this.communityCards.map((card) => card.toJson()),
      activePlayers: this.activePlayers.map((player) => player.toJson()),
      inactivePlayers: this.inactivePlayers.map((player) => player.toJson()),
      currentPot: this.currentPot,
      dealerPosition: this.dealerPosition,
      smallBlind: this.smallBlind,
      bigBlind: this.bigBlind,
      currentPlayerIndex: this.currentPlayerIndex,
      foldedPlayers: Array.from(this.foldedPlayers),
      currentBetAmount: this.currentBetAmount,
      lastRaiseAmount: this.lastRaiseAmount,
      playerPositions: Array.from(this.playerPositions.entries()) as (
        | string
        | number
      )[][],
      preDealId: this.preDealId,
      bettingHistory: this.bettingHistory,
      handStartChips: Array.from(this.handStartChips.entries()),
      handHistory: this.serializeHandHistory(),
    } as const;
  }
}
