import { TexasHoldem } from "poker-odds-calc";
import { userIdToName } from "./users";

export type PlayerStreakStatus = "hot" | "cold";

type CardSnapshot = {
  rank: string;
  suit: string;
};

type PlayerSnapshot = {
  id: string;
  cards: CardSnapshot[];
};

export type ShowdownGameStateSnapshot = {
  activePlayers: PlayerSnapshot[];
  foldedPlayers: string[];
  communityCards: CardSnapshot[];
};

export type ShowdownEventSnapshot = {
  description: string;
  ephemeral?: boolean;
};

type StreetConfig = {
  label: "Pre-flop" | "Flop" | "Turn" | "River";
  communityCardCount: number;
};

type ShowdownPlayer = {
  playerId: string;
  cards: [CardSnapshot, CardSnapshot];
  position: number;
};

type StreetWinPercentageCalculator = (
  players: ShowdownPlayer[],
  communityCards: CardSnapshot[],
  streetLabel: StreetConfig["label"]
) => Promise<Map<string, number>> | Map<string, number>;

const PRE_FLOP_ITERATION_LIMIT = 100_000;
const STREETS: StreetConfig[] = [
  { label: "Pre-flop", communityCardCount: 0 },
  { label: "Flop", communityCardCount: 3 },
  { label: "Turn", communityCardCount: 4 },
  { label: "River", communityCardCount: 5 },
];

export async function buildShowdownWinPercentageMessage(
  gameState: ShowdownGameStateSnapshot,
  events: ShowdownEventSnapshot[],
  calculateStreetWinPercentagesFn: StreetWinPercentageCalculator = 
    calculateStreetWinPercentages,
  streakStatuses?: Map<string, PlayerStreakStatus>
): Promise<string | null> {
  if (!didHandGoToShowdown(events)) {
    console.info(
      "[ShowdownWinPercentage] Skipping showdown equity calculation because hand did not reach showdown",
      {
        eventCount: events.length,
      }
    );
    return null;
  }

  const showdownPlayers = getShowdownPlayers(gameState);
  if (showdownPlayers.length < 2 || gameState.communityCards.length < 5) {
    console.info(
      "[ShowdownWinPercentage] Skipping showdown equity calculation because snapshot is incomplete",
      {
        showdownPlayerCount: showdownPlayers.length,
        communityCardCount: gameState.communityCards.length,
      }
    );
    return null;
  }

  const streetResults = await Promise.all(
    STREETS.map(async (street) => {
      const board = gameState.communityCards.slice(0, street.communityCardCount);
      const results = await calculateStreetWinPercentagesFn(
        showdownPlayers,
        board,
        street.label
      );
      return { label: street.label, results };
    })
  );

  const hasAtLeastOneStreet = streetResults.some(
    (streetResult) => streetResult.results.size > 0
  );
  if (!hasAtLeastOneStreet) {
    console.warn(
      "[ShowdownWinPercentage] Local equity calculations completed without usable win percentages",
      {
        streetResultCounts: streetResults.map(({ label, results }) => ({
          streetLabel: label,
          matchedPlayerCount: results.size,
        })),
      }
    );
    return null;
  }

  const lines: string[] = ["*Showdown Win Percentage*"];
  for (const player of showdownPlayers) {
    const streetSummary = streetResults.map(
      ({ label, results }) =>
        `${label}: ${formatPercent(results.get(player.playerId))}`
    );
    const baseName =
      userIdToName[player.playerId as keyof typeof userIdToName] ||
      player.playerId;
    let streakEmoji = "";
    if (streakStatuses) {
      const status = streakStatuses.get(player.playerId);
      if (status === "hot") {
        streakEmoji = " :fire:";
      } else if (status === "cold") {
        streakEmoji = " :ice_cube:";
      }
    }
    const displayName = `${baseName}${streakEmoji}`;
    lines.push(`*${displayName}* - ${streetSummary.join(" | ")}`);
  }

  console.info(
    "[ShowdownWinPercentage] Built showdown win percentage message",
    {
      playerCount: showdownPlayers.length,
      streetResultCounts: streetResults.map(({ label, results }) => ({
        streetLabel: label,
        matchedPlayerCount: results.size,
      })),
    }
  );

  return lines.join("\n");
}

function didHandGoToShowdown(events: ShowdownEventSnapshot[]): boolean {
  const hadRevealedHands = events.some(
    (event) =>
      !event.ephemeral &&
      typeof event.description === "string" &&
      event.description.includes(" had ")
  );

  const hadPotResolution = events.some(
    (event) =>
      !event.ephemeral &&
      typeof event.description === "string" &&
      /(?:Main|Side) pot of /.test(event.description)
  );

  return hadRevealedHands && hadPotResolution;
}

function getShowdownPlayers(
  gameState: ShowdownGameStateSnapshot
): ShowdownPlayer[] {
  const foldedPlayers = new Set(gameState.foldedPlayers);

  return gameState.activePlayers
    .filter((player) => !foldedPlayers.has(player.id) && player.cards.length === 2)
    .map((player, index) => ({
      playerId: player.id,
      cards: [player.cards[0], player.cards[1]] as [CardSnapshot, CardSnapshot],
      position: index + 1,
    }));
}

async function calculateStreetWinPercentages(
  players: ShowdownPlayer[],
  communityCards: CardSnapshot[],
  streetLabel: StreetConfig["label"]
): Promise<Map<string, number>> {
  try {
    const table = new TexasHoldem();
    if (communityCards.length < 3) {
      // Pre-flop/early street odds can be expensive to enumerate exactly.
      // Keep the library's Monte Carlo strategy but make the iteration budget explicit.
      table.limit(PRE_FLOP_ITERATION_LIMIT);
    }

    players.forEach((player) => {
      table.addPlayer([
        toCalculatorCard(player.cards[0]),
        toCalculatorCard(player.cards[1]),
      ]);
    });

    if (communityCards.length >= 3) {
      table.setBoard(communityCards.map((card) => toCalculatorCard(card)));
    }

    const result = table.calculate();
    const resultPlayers = result.getPlayers();
    const extractedResults = new Map<string, number>();

    resultPlayers.forEach((resultPlayer, playerIndex) => {
      const showdownPlayer = players[playerIndex];
      if (!showdownPlayer) {
        return;
      }
      extractedResults.set(showdownPlayer.playerId, resultPlayer.getWinsPercentage());
    });

    console.info("[ShowdownWinPercentage] Calculated local showdown equities", {
      streetLabel,
      playerCount: players.length,
      board: formatBoardForLog(communityCards),
      iterations: result.getIterations(),
      approximate: result.isApproximate(),
      matchedPlayerCount: extractedResults.size,
    });

    return extractedResults;
  } catch (error) {
    console.error("[ShowdownWinPercentage] Local equity calculation failed", {
      streetLabel,
      playerCount: players.length,
      board: formatBoardForLog(communityCards),
      error: getErrorMessage(error),
    });
    return new Map<string, number>();
  }
}

function formatBoardForLog(communityCards: CardSnapshot[]): string {
  if (communityCards.length === 0) {
    return "(none)";
  }
  return communityCards.map((card) => toCalculatorCard(card).toUpperCase()).join(" ");
}

function getErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return `${error.name}: ${error.message}`;
  }
  return String(error);
}

function toCalculatorCard(card: CardSnapshot): string {
  const rank = normalizeRank(card.rank);
  const suit = normalizeSuit(card.suit);
  return `${rank}${suit}`;
}

function normalizeRank(rank: string): string {
  const upperRank = rank.toUpperCase();
  if (upperRank === "10") {
    return "T";
  }
  return upperRank;
}

function normalizeSuit(suit: string): string {
  switch (suit) {
    case "Hearts":
      return "h";
    case "Diamonds":
      return "d";
    case "Clubs":
      return "c";
    case "Spades":
      return "s";
    default:
      return suit.charAt(0).toLowerCase();
  }
}

function formatPercent(value: number | undefined): string {
  if (typeof value !== "number") {
    return "N/A";
  }
  return `${value.toFixed(2)}%`;
}
