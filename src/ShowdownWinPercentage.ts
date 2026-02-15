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

type CardPlayerSeat = {
  position?: string | number;
  win_pct?: string | number;
};

type CardPlayerResponse = {
  seats?: CardPlayerSeat[];
};

const CARDPLAYER_ENDPOINT =
  "https://www.cardplayer.com/wp-json/pocker/v1/cardplayer/";
const CARDPLAYER_TIMEOUT_MS = 2500;
const STREETS: StreetConfig[] = [
  { label: "Pre-flop", communityCardCount: 0 },
  { label: "Flop", communityCardCount: 3 },
  { label: "Turn", communityCardCount: 4 },
  { label: "River", communityCardCount: 5 },
];

export async function buildShowdownWinPercentageMessage(
  gameState: ShowdownGameStateSnapshot,
  events: ShowdownEventSnapshot[],
  fetchFn: typeof fetch = fetch
): Promise<string | null> {
  if (!didHandGoToShowdown(events)) {
    return null;
  }

  const showdownPlayers = getShowdownPlayers(gameState);
  if (showdownPlayers.length < 2 || gameState.communityCards.length < 5) {
    return null;
  }

  const streetResults = await Promise.all(
    STREETS.map(async (street) => {
      const board = gameState.communityCards.slice(0, street.communityCardCount);
      const results = await fetchStreetWinPercentages(
        showdownPlayers,
        board,
        fetchFn
      );
      return { label: street.label, results };
    })
  );

  const hasAtLeastOneStreet = streetResults.some(
    (streetResult) => streetResult.results.size > 0
  );
  if (!hasAtLeastOneStreet) {
    return null;
  }

  const lines: string[] = ["*Showdown Win Percentage*"];
  for (const player of showdownPlayers) {
    const streetSummary = streetResults.map(
      ({ label, results }) =>
        `${label}: ${formatPercent(results.get(player.playerId))}`
    );
    lines.push(`<@${player.playerId}> - ${streetSummary.join(" | ")}`);
  }

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

async function fetchStreetWinPercentages(
  players: ShowdownPlayer[],
  communityCards: CardSnapshot[],
  fetchFn: typeof fetch
): Promise<Map<string, number>> {
  const useTenAsTResponse = await fetchStreetWinPercentagesAttempt(
    players,
    communityCards,
    fetchFn,
    true
  );
  if (useTenAsTResponse.size > 0 || !hasTen(players, communityCards)) {
    return useTenAsTResponse;
  }

  return fetchStreetWinPercentagesAttempt(players, communityCards, fetchFn, false);
}

async function fetchStreetWinPercentagesAttempt(
  players: ShowdownPlayer[],
  communityCards: CardSnapshot[],
  fetchFn: typeof fetch,
  useTenAsT: boolean
): Promise<Map<string, number>> {
  const url = buildCardPlayerUrl(players, communityCards, useTenAsT);
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), CARDPLAYER_TIMEOUT_MS);

  try {
    const response = await fetchFn(url.toString(), {
      method: "GET",
      headers: {
        Accept: "application/json",
      },
      signal: controller.signal,
    });

    if (!response.ok) {
      return new Map<string, number>();
    }

    const contentType = response.headers.get("content-type") || "";
    if (!contentType.toLowerCase().includes("application/json")) {
      return new Map<string, number>();
    }

    const payload = (await response.json()) as CardPlayerResponse;
    return extractStreetWinPercentages(payload, players);
  } catch {
    return new Map<string, number>();
  } finally {
    clearTimeout(timeout);
  }
}

function buildCardPlayerUrl(
  players: ShowdownPlayer[],
  communityCards: CardSnapshot[],
  useTenAsT: boolean
): URL {
  const url = new URL(CARDPLAYER_ENDPOINT);
  url.searchParams.set("game_type", "texas_holdem");

  players.forEach((player, seatIndex) => {
    url.searchParams.append(
      `seats[${seatIndex}][hand][]`,
      toApiCard(player.cards[0], useTenAsT)
    );
    url.searchParams.append(
      `seats[${seatIndex}][hand][]`,
      toApiCard(player.cards[1], useTenAsT)
    );
    url.searchParams.append(
      `seats[${seatIndex}][position]`,
      String(player.position)
    );
  });

  communityCards.forEach((card) => {
    const serialized = toApiCard(card, useTenAsT);
    url.searchParams.append("community_cards[]", serialized);
    url.searchParams.append("board[]", serialized);
    url.searchParams.append("board_cards[]", serialized);
    url.searchParams.append("community[]", serialized);
  });

  url.searchParams.append("dead_cards", "");
  return url;
}

function extractStreetWinPercentages(
  payload: CardPlayerResponse,
  players: ShowdownPlayer[]
): Map<string, number> {
  const playerIdsByPosition = new Map<number, string>();
  players.forEach((player) => {
    playerIdsByPosition.set(player.position, player.playerId);
  });

  const results = new Map<string, number>();
  if (!Array.isArray(payload.seats)) {
    return results;
  }

  payload.seats.forEach((seat, seatIndex) => {
    const parsedPosition = Number.parseInt(String(seat.position), 10);
    const playerId =
      playerIdsByPosition.get(parsedPosition) ??
      (players[seatIndex] ? players[seatIndex].playerId : undefined);

    if (!playerId) {
      return;
    }

    const winPercent = parsePercent(seat.win_pct);
    if (winPercent === null) {
      return;
    }

    results.set(playerId, winPercent);
  });

  return results;
}

function parsePercent(value: unknown): number | null {
  if (typeof value !== "number" && typeof value !== "string") {
    return null;
  }

  const parsed = Number.parseFloat(
    String(value)
      .replace(/,/g, "")
      .replace("%", "")
      .trim()
  );

  return Number.isFinite(parsed) ? parsed : null;
}

function toApiCard(card: CardSnapshot, useTenAsT: boolean): string {
  const rank = normalizeRank(card.rank, useTenAsT);
  const suit = normalizeSuit(card.suit);
  return `${rank}${suit}`;
}

function normalizeRank(rank: string, useTenAsT: boolean): string {
  const upperRank = rank.toUpperCase();
  if (upperRank === "10") {
    return useTenAsT ? "T" : "10";
  }
  return upperRank;
}

function normalizeSuit(suit: string): string {
  switch (suit) {
    case "Hearts":
      return "H";
    case "Diamonds":
      return "D";
    case "Clubs":
      return "C";
    case "Spades":
      return "S";
    default:
      return suit.charAt(0).toUpperCase();
  }
}

function hasTen(players: ShowdownPlayer[], communityCards: CardSnapshot[]): boolean {
  const playerCards = players.flatMap((player) => player.cards);
  return [...playerCards, ...communityCards].some((card) => card.rank === "10");
}

function formatPercent(value: number | undefined): string {
  if (typeof value !== "number") {
    return "N/A";
  }
  return `${value.toFixed(2)}%`;
}
