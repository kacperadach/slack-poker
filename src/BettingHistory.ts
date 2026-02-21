import { GameState } from "./Game";

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

export interface BettingAction {
  street: BettingStreet;
  playerId: string;
  actionType: BettingActionType;
  amount: number;
  timestamp: number;
}

export class BettingHistory {
  private actions: BettingAction[] = [];

  public addAction(
    street: BettingStreet,
    playerId: string,
    actionType: BettingActionType,
    amount: number = 0
  ): void {
    this.actions.push({
      street,
      playerId,
      actionType,
      amount,
      timestamp: Date.now(),
    });
  }

  public getActions(): BettingAction[] {
    return [...this.actions];
  }

  public getActionsByStreet(street: BettingStreet): BettingAction[] {
    return this.actions.filter((action) => action.street === street);
  }

  public getActionsByPlayer(playerId: string): BettingAction[] {
    return this.actions.filter((action) => action.playerId === playerId);
  }

  public getPreflopActions(): BettingAction[] {
    return this.getActionsByStreet("preflop");
  }

  public getFlopActions(): BettingAction[] {
    return this.getActionsByStreet("flop");
  }

  public getTurnActions(): BettingAction[] {
    return this.getActionsByStreet("turn");
  }

  public getRiverActions(): BettingAction[] {
    return this.getActionsByStreet("river");
  }

  public getTotalBetByPlayer(playerId: string): number {
    return this.actions
      .filter((action) => action.playerId === playerId)
      .reduce((total, action) => total + action.amount, 0);
  }

  public clear(): void {
    this.actions = [];
  }

  public toJson(): BettingAction[] {
    return this.actions.map((action) => ({ ...action }));
  }

  public static fromJson(data: BettingAction[]): BettingHistory {
    const history = new BettingHistory();
    if (data && Array.isArray(data)) {
      data.forEach((action) => {
        history.actions.push({ ...action });
      });
    }
    return history;
  }

  public static gameStateToStreet(gameState: GameState): BettingStreet {
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
}
