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
const CARDPLAYER_LOG_BODY_PREVIEW_LENGTH = 2000;
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
    console.info(
      "[ShowdownWinPercentage] Skipping CardPlayer lookup because hand did not reach showdown",
      {
        eventCount: events.length,
      }
    );
    return null;
  }

  const showdownPlayers = getShowdownPlayers(gameState);
  if (showdownPlayers.length < 2 || gameState.communityCards.length < 5) {
    console.info(
      "[ShowdownWinPercentage] Skipping CardPlayer lookup because showdown snapshot is incomplete",
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
      const results = await fetchStreetWinPercentages(
        showdownPlayers,
        board,
        fetchFn,
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
      "[ShowdownWinPercentage] CardPlayer lookups completed without usable win percentages",
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
    lines.push(`<@${player.playerId}> - ${streetSummary.join(" | ")}`);
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

async function fetchStreetWinPercentages(
  players: ShowdownPlayer[],
  communityCards: CardSnapshot[],
  fetchFn: typeof fetch,
  streetLabel: StreetConfig["label"]
): Promise<Map<string, number>> {
  return fetchStreetWinPercentagesAttempt(
    players,
    communityCards,
    fetchFn,
    streetLabel
  );
}

async function fetchStreetWinPercentagesAttempt(
  players: ShowdownPlayer[],
  communityCards: CardSnapshot[],
  fetchFn: typeof fetch,
  streetLabel: StreetConfig["label"]
): Promise<Map<string, number>> {
  const url = buildCardPlayerUrl(players, communityCards);
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), CARDPLAYER_TIMEOUT_MS);
  const requestLogContext = {
    streetLabel,
    playerCount: players.length,
    board: formatBoardForLog(communityCards),
    url: url.toString(),
  };

  console.info(
    "[ShowdownWinPercentage] Requesting CardPlayer win percentage data",
    requestLogContext
  );

  try {
    const response = await fetchFn(url.toString(), {
      method: "GET",
      headers: {
        Accept: "application/json",
      },
      signal: controller.signal,
    });
    const responseBody = await response.text();
    const contentType = response.headers.get("content-type") || "";
    const responseLogContext = {
      ...requestLogContext,
      status: response.status,
      statusText: response.statusText,
      ok: response.ok,
      contentType,
      body: formatBodyForLog(responseBody),
    };

    if (!response.ok) {
      console.warn(
        "[ShowdownWinPercentage] CardPlayer request returned non-OK status",
        responseLogContext
      );
      return new Map<string, number>();
    }

    if (!contentType.toLowerCase().includes("application/json")) {
      console.warn(
        "[ShowdownWinPercentage] CardPlayer response content-type was not JSON",
        responseLogContext
      );
      return new Map<string, number>();
    }

    const payload = parseCardPlayerPayload(responseBody, responseLogContext);
    if (!payload) {
      return new Map<string, number>();
    }

    const extractedResults = extractStreetWinPercentages(payload, players);
    console.info(
      "[ShowdownWinPercentage] Parsed CardPlayer win percentage response",
      {
        ...responseLogContext,
        seatCount: Array.isArray(payload.seats) ? payload.seats.length : 0,
        matchedPlayerCount: extractedResults.size,
      }
    );
    return extractedResults;
  } catch (error) {
    console.error("[ShowdownWinPercentage] CardPlayer request threw an error", {
      ...requestLogContext,
      timeoutMs: CARDPLAYER_TIMEOUT_MS,
      aborted: controller.signal.aborted,
      isAbortError: isAbortError(error),
      error: getErrorMessage(error),
    });
    return new Map<string, number>();
  } finally {
    clearTimeout(timeout);
  }
}

function parseCardPlayerPayload(
  responseBody: string,
  responseLogContext: {
    streetLabel: StreetConfig["label"];
    playerCount: number;
    board: string;
    url: string;
    status: number;
    statusText: string;
    ok: boolean;
    contentType: string;
    body: string;
  }
): CardPlayerResponse | null {
  try {
    return JSON.parse(responseBody) as CardPlayerResponse;
  } catch (error) {
    console.warn(
      "[ShowdownWinPercentage] Failed to parse CardPlayer response body as JSON",
      {
        ...responseLogContext,
        parseError: getErrorMessage(error),
      }
    );
    return null;
  }
}

function formatBoardForLog(communityCards: CardSnapshot[]): string {
  if (communityCards.length === 0) {
    return "(none)";
  }
  return communityCards.map((card) => toApiCard(card)).join(" ");
}

function formatBodyForLog(body: string): string {
  const trimmed = body.trim();
  if (trimmed.length === 0) {
    return "(empty)";
  }
  if (trimmed.length <= CARDPLAYER_LOG_BODY_PREVIEW_LENGTH) {
    return trimmed;
  }
  return `${trimmed.slice(0, CARDPLAYER_LOG_BODY_PREVIEW_LENGTH)}...(truncated)`;
}

function isAbortError(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "name" in error &&
    (error as { name?: unknown }).name === "AbortError"
  );
}

function getErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return `${error.name}: ${error.message}`;
  }
  return String(error);
}

function buildCardPlayerUrl(
  players: ShowdownPlayer[],
  communityCards: CardSnapshot[]
): URL {
  const url = new URL(CARDPLAYER_ENDPOINT);
  url.searchParams.set("game_type", "texas_holdem");

  players.forEach((player, seatIndex) => {
    url.searchParams.append(
      `seats[${seatIndex}][hand][]`,
      toApiCard(player.cards[0])
    );
    url.searchParams.append(
      `seats[${seatIndex}][hand][]`,
      toApiCard(player.cards[1])
    );
    url.searchParams.append(
      `seats[${seatIndex}][position]`,
      String(player.position)
    );
  });

  // CardPlayer's calculator expects post-flop board cards as one
  // space-delimited `board` query parameter (e.g. "2C 7D 9H").
  if (communityCards.length >= 3) {
    url.searchParams.append(
      "board",
      communityCards.map((card) => toApiCard(card)).join(" ")
    );
  }

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

function toApiCard(card: CardSnapshot): string {
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

function formatPercent(value: number | undefined): string {
  if (typeof value !== "number") {
    return "N/A";
  }
  return `${value.toFixed(2)}%`;
}
