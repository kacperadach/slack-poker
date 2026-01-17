import { Card, Suit, Rank } from "./Card";

export class Deck {
  private cards: Card[];

  constructor() {
    this.cards = [];
    const suits: Suit[] = ["Hearts", "Diamonds", "Clubs", "Spades"];
    const ranks: Rank[] = [
      "2",
      "3",
      "4",
      "5",
      "6",
      "7",
      "8",
      "9",
      "10",
      "J",
      "Q",
      "K",
      "A",
    ];

    for (const suit of suits) {
      for (const rank of ranks) {
        this.cards.push(new Card(suit, rank));
      }
    }
  }

  public shuffle(): void {
    for (let i = this.cards.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [this.cards[i], this.cards[j]] = [this.cards[j], this.cards[i]];
    }
  }

  public draw(): Card | undefined {
    return this.cards.pop();
  }

  public getCardsRemaining(): number {
    return this.cards.length;
  }

  public reset(): void {
    this.cards = [];
    const suits: Suit[] = ["Hearts", "Diamonds", "Clubs", "Spades"];
    const ranks: Rank[] = [
      "2",
      "3",
      "4",
      "5",
      "6",
      "7",
      "8",
      "9",
      "10",
      "J",
      "Q",
      "K",
      "A",
    ];

    for (const suit of suits) {
      for (const rank of ranks) {
        this.cards.push(new Card(suit, rank));
      }
    }
  }

  public toJson() {
    return {
      cards: this.cards.map((card) => card.toJson()),
    } as const;
  }

  public static fromJson(data: any): Deck {
    const deck = new Deck();
    deck.cards = data.cards.map((cardJson: string) => Card.fromJson(cardJson));
    return deck;
  }
}
