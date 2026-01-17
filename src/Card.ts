export type Suit = "Hearts" | "Diamonds" | "Clubs" | "Spades";
export type Rank =
  | "2"
  | "3"
  | "4"
  | "5"
  | "6"
  | "7"
  | "8"
  | "9"
  | "10"
  | "J"
  | "Q"
  | "K"
  | "A";

const rankValues: Record<Rank, number> = {
  "2": 2,
  "3": 3,
  "4": 4,
  "5": 5,
  "6": 6,
  "7": 7,
  "8": 8,
  "9": 9,
  "10": 10,
  J: 11,
  Q: 12,
  K: 13,
  A: 14,
};

export class Card {
  private suit: Suit;
  private rank: Rank;

  constructor(suit: Suit, rank: Rank) {
    this.suit = suit;
    this.rank = rank;
  }

  public getSuit(): Suit {
    return this.suit;
  }

  public getRank(): Rank {
    return this.rank;
  }

  public getValue(): number {
    return rankValues[this.rank];
  }

  public toString(): string {
    return `${this.rank}${this.suit[0].toLowerCase()}`;
  }

  public toSlackString(): string {
    let suitString = "";
    switch (this.suit) {
      case "Hearts":
        suitString = ":hearts:";
        break;
      case "Diamonds":
        suitString = ":diamonds:";
        break;
      case "Clubs":
        suitString = ":clubs:";
        break;
      case "Spades":
        suitString = ":spades:";
        break;
      default:
        suitString = "";
        break;
    }

    return `${this.rank}${suitString}`;
  }

  public equals(other: Card): boolean {
    return this.suit === other.suit && this.rank === other.rank;
  }

  public toJson() {
    return {
      suit: this.suit,
      rank: this.rank,
    } as const;
  }

  public static fromJson(data: any): Card {
    const { suit, rank } = data;
    return new Card(suit as Suit, rank as Rank);
  }
}
