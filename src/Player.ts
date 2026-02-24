import { Card } from "./Card";

export type PreMove = {
  move: "check" | "fold" | "bet" | "call";
  amount?: number;
};

export class Player {
  private id: string;
  private chips: number;
  private cards: Card[];
  private isAllIn: boolean;
  private currentBet: number;
  private totalBet: number;
  private lastRaise: number;
  private hadTurnThisRound: boolean;
  private wantsToLeaveTable: boolean; // indicates player wants to leave when round is over
  private wantsToJoinTable: boolean; // indicates player wants to join when round is over
  private totalBuyIn: number;
  private preMove: PreMove | null;
  private preNH: boolean = false;
  private preAH: boolean = false;
  private timeBankSeconds: number = 0; // time balance in seconds for time betting

  constructor(
    id: string,
    chips: number = 0,
    cards: Card[] = [],
    isAllIn: boolean = false,
    currentBet: number = 0,
    totalBet: number = 0,
    lastRaise: number = 0,
    hadTurnThisRound: boolean = false,
    wantsToLeaveTable: boolean = false,
    wantsToJoinTable: boolean = false,
    totalBuyIn: number = 0,
    preMove: PreMove | null = null,
    preNH: boolean = false,
    preAH: boolean = false,
    timeBankSeconds: number = 0
  ) {
    this.id = id;
    this.chips = chips;
    this.cards = cards;
    this.isAllIn = isAllIn;
    this.currentBet = currentBet;
    this.totalBet = totalBet;
    this.lastRaise = lastRaise;
    this.hadTurnThisRound = hadTurnThisRound;
    this.wantsToLeaveTable = wantsToLeaveTable;
    this.wantsToJoinTable = wantsToJoinTable;
    this.totalBuyIn = totalBuyIn;
    this.preMove = preMove;
    this.preNH = preNH;
    this.preAH = preAH;
    this.timeBankSeconds = timeBankSeconds;
  }

  public getHadTurnThisRound(): boolean {
    return this.hadTurnThisRound;
  }

  public setHadTurnThisRound(hadTurn: boolean): void {
    this.hadTurnThisRound = hadTurn;
  }

  public resetHadTurnThisRound(): void {
    this.setHadTurnThisRound(false);
  }

  public getTotalBet(): number {
    return this.totalBet;
  }

  public resetTotalBet(): void {
    this.totalBet = 0;
  }

  public getCurrentBet(): number {
    return this.currentBet;
  }

  public setCurrentBet(amount: number): void {
    this.currentBet = amount;
  }

  public addToCurrentBet(amount: number): void {
    this.currentBet += amount;
  }

  public resetCurrentBet(): void {
    this.setCurrentBet(0);
  }

  public getId(): string {
    return this.id;
  }

  public addCard(card: Card): void {
    this.cards.push(card);
  }

  public addCards(cards: Card[]): void {
    this.cards.push(...cards);
  }
  public removeAllCards(): void {
    this.cards = [];
  }
  public getCards(): Card[] {
    return this.cards;
  }

  public getChips(): number {
    return this.chips;
  }

  public addChips(amount: number): void {
    if (amount > 0) {
      this.chips += amount;
    }
  }

  public setAllIn(status: boolean): void {
    this.isAllIn = status;
  }

  public getIsAllIn(): boolean {
    return this.isAllIn;
  }

  public removeChips(amount: number): number {
    const chipsToRemove = Math.min(amount, this.chips);
    this.chips -= chipsToRemove;
    this.totalBet += chipsToRemove;
    if (this.chips === 0) {
      this.setAllIn(true);
    }
    return chipsToRemove;
  }

  public getLastRaise(): number {
    return this.lastRaise;
  }

  public setLastRaise(amount: number): void {
    this.lastRaise = amount;
  }

  public resetLastRaise(): void {
    this.setLastRaise(0);
  }

  public setTotalBuyIn(amount: number): void {
    this.totalBuyIn = amount;
  }

  public addToTotalBuyIn(amount: number): void {
    if (amount > 0) {
      this.totalBuyIn += amount;
    }
  }

  public getTotalBuyIn(): number {
    return this.totalBuyIn;
  }

  public setWantsToLeaveTable(status: boolean): void {
    this.wantsToLeaveTable = status;
  }

  public getWantsToLeaveTable(): boolean {
    return this.wantsToLeaveTable;
  }

  public setWantsToJoinTable(status: boolean): void {
    this.wantsToJoinTable = status;
  }

  public getWantsToJoinTable(): boolean {
    return this.wantsToJoinTable;
  }

  public getPreMove(): PreMove | null {
    return this.preMove;
  }

  public setPreMove(preMove: PreMove | null): void {
    this.preMove = preMove;
  }

  public toString(): string {
    return `Player ${this.id} (Chips: ${this.chips})`;
  }

  public getPreNH(): boolean {
    return this.preNH;
  }

  public setPreNH(preNH: boolean): void {
    this.preNH = preNH;
  }

  public getPreAH(): boolean {
    return this.preAH;
  }

  public setPreAH(preAH: boolean): void {
    this.preAH = preAH;
  }

  public getTimeBankSeconds(): number {
    return this.timeBankSeconds;
  }

  public setTimeBankSeconds(seconds: number): void {
    this.timeBankSeconds = Math.max(0, seconds);
  }

  public addTimeBankSeconds(seconds: number): void {
    if (seconds > 0) {
      this.timeBankSeconds += seconds;
    }
  }

  public removeTimeBankSeconds(seconds: number): number {
    const secondsToRemove = Math.min(seconds, this.timeBankSeconds);
    this.timeBankSeconds -= secondsToRemove;
    return secondsToRemove;
  }

  public formatTimeBank(): string {
    const hours = Math.floor(this.timeBankSeconds / 3600);
    const minutes = Math.floor((this.timeBankSeconds % 3600) / 60);
    const seconds = this.timeBankSeconds % 60;
    
    if (hours > 0) {
      return `${hours}h ${minutes}m ${seconds}s`;
    } else if (minutes > 0) {
      return `${minutes}m ${seconds}s`;
    } else {
      return `${seconds}s`;
    }
  }

  public toJson() {
    return {
      id: this.id,
      chips: this.chips,
      cards: this.cards.map((card) => card.toJson()),
      isAllIn: this.isAllIn,
      currentBet: this.currentBet,
      totalBet: this.totalBet,
      lastRaise: this.lastRaise,
      hadTurnThisRound: this.hadTurnThisRound,
      wantsToLeaveTable: this.wantsToLeaveTable,
      wantsToJoinTable: this.wantsToJoinTable,
      totalBuyIn: this.totalBuyIn,
      preMove: this.preMove,
      preNH: this.preNH,
      preAH: this.preAH,
      timeBankSeconds: this.timeBankSeconds,
    } as const;
  }

  public static fromJson(data: any): Player {
    return new Player(
      data.id,
      data.chips,
      data.cards.map((cardJson: any) => Card.fromJson(cardJson)),
      data.isAllIn,
      data.currentBet,
      data.totalBet,
      data.lastRaise,
      data.hadTurnThisRound,
      data?.wantsToLeaveTable || false,
      data?.wantsToJoinTable || false,
      data?.totalBuyIn || 0,
      data?.preMove || null,
      data?.preNH || false,
      data?.preAH || false,
      data?.timeBankSeconds || 0
    );
  }

  // ONLY FOR TESTING
  public setCards(cards: Card[]): void {
    this.cards = cards;
  }
}
