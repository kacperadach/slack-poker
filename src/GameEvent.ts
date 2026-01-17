import { Card } from "./Card";

export class GameEvent {
  private description: string;
  private cards: Card[];
  private ephemeral: boolean;
  private playerId: string;
  private isTurnMessage: boolean;

  constructor(description: string);
  constructor(description: string, cards: Card[]);
  constructor(description: string, cards: Card[], ephemeral: boolean);
  constructor(
    description: string,
    cards: Card[],
    ephemeral: boolean,
    playerId: string
  );
  constructor(
    description: string,
    cards: Card[],
    ephemeral: boolean,
    playerId: string,
    isTurnMessage: boolean
  );
  constructor(
    description: string,
    cards: Card[] = [],
    ephemeral: boolean = false,
    playerId: string = "",
    isTurnMessage: boolean = false
  ) {
    this.description = description;
    this.cards = cards;
    this.ephemeral = ephemeral;
    this.playerId = playerId;
    this.isTurnMessage = isTurnMessage;
  }

  public getDescription(): string {
    return this.description;
  }

  public getCards(): Card[] {
    return this.cards;
  }

  public isEphemeral(): boolean {
    return this.ephemeral;
  }

  public addCard(card: Card): void {
    this.cards.push(card);
  }

  public setDescription(description: string): void {
    this.description = description;
  }

  public setEphemeral(ephemeral: boolean): void {
    this.ephemeral = ephemeral;
  }

  public getPlayerId(): string {
    return this.playerId;
  }

  public setPlayerId(playerId: string): void {
    this.playerId = playerId;
  }

  public getIsTurnMessage(): boolean {
    return this.isTurnMessage;
  }

  public setIsTurnMessage(isTurnMessage: boolean): void {
    this.isTurnMessage = isTurnMessage;
  }

  public toJson() {
    return {
      description: this.description,
      cards: this.cards.map((card) => card.toJson()),
      ephemeral: this.ephemeral,
      playerId: this.playerId,
      isTurnMessage: this.isTurnMessage,
    } as const;
  }
}
