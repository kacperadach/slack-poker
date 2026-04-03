import { DurableObject } from "cloudflare:workers";
import {
  AnyMessageEvent,
  SlackApp,
  SlackAppContextWithChannelId,
  isPostedMessageEvent,
} from "slack-cloudflare-workers";
import { GameState, TexasHoldem } from "./Game";
import { Card } from "./Card";
import type { GameEvent } from "./GameEvent";
// @ts-ignore phe is not typed
import { rankDescription, rankCards } from "phe";
import { allUsers, userIdToName } from "./users";
import {
  fetchStockPrice,
  getHubsStockPriceMessage,
  getStockPriceMessage,
} from "./StockPrice";
import { buildShowdownWinPercentageMessage } from "./ShowdownWinPercentage";
import { ensureNarpBrainOnError } from "./slackErrorEmoji";

/**
 * Welcome to Cloudflare Workers! This is your first Durable Objects application.
 *
 * - Run `npm run dev` in your terminal to start a development server
 * - Open a browser tab at http://localhost:8787/ to see your Durable Object in action
 * - Run `npm run deploy` to publish your application
 *
 * Bind resources to your worker in `wrangler.jsonc`. After adding bindings, a type definition for the
 * `Env` object can be regenerated with `npm run cf-typegen`.
 *
 * Learn more at https://developers.cloudflare.com/durable-objects
 */

// Durable Object only needs to read/write game to SQL

type SerializedGame = ReturnType<TexasHoldem["toJson"]>;
type PublicGameState = ReturnType<TexasHoldem["getState"]>;

type ChannelGameStateRecord = {
  game: SerializedGame;
  nextGameId: number;
  activeGameId: number | null;
};

type ActiveGameRecord = {
  gameId: number;
  game: SerializedGame;
  createdAt: number;
  endedAt: number | null;
};

type ScopedGameContext = {
  scope: "channel" | "active";
  channelState: ChannelGameStateRecord;
  game: TexasHoldem;
  gameId?: number;
};

type PlayerHandFactRecord = {
  workspaceId: string;
  channelId: string;
  gameId: number;
  playerId: string;
  participated: boolean;
  wonAnyPot: boolean;
  reachedShowdown: boolean;
  folded: boolean;
  checkCount: number;
  callCount: number;
  betCount: number;
  raiseCount: number;
  allInCount: number;
  raiseToTotal: number;
  chipsCommitted: number;
  chipsWon: number;
  netChips: number;
};

type AggregatedPlayerHandStats = {
  playerId: string;
  handsCount: number;
  participated: number;
  wonAnyPot: number;
  reachedShowdown: number;
  folded: number;
  checkCount: number;
  callCount: number;
  betCount: number;
  raiseCount: number;
  allInCount: number;
  raiseToTotal: number;
  chipsCommitted: number;
  chipsWon: number;
  netChips: number;
};

type PlayerHandStreakFact = {
  gameId: number;
  playerId: string;
  participated: boolean;
  wonAnyPot: boolean;
};

type PublicApiResponse<T> = {
  data: T;
  pagination?: {
    nextCursor: string | null;
  };
  meta?: Record<string, unknown>;
};

type HandVisibility = "embargoed" | "revealed";

type ChannelSummaryResponse = {
  channelId: string;
  visibleHandsCount: number;
  firstHandEndedAt: number | null;
  lastHandEndedAt: number | null;
  playersWithTrackedStats: string[];
};

type ChannelHandPotResultSummary = {
  potIndex: number;
  potType: "main" | "side";
  potSize: number;
  splitAmount: number;
  winnerPlayerIds: string[];
};

type ChannelHandIndexItem = {
  gameId: number;
  createdAt: number;
  endedAt: number;
  playerIds: string[];
  playerCount: number;
  smallBlind: number | null;
  bigBlind: number | null;
  board: {
    flop: unknown[];
    turn: unknown[];
    river: unknown[];
  };
  winners: string[];
  totalPot: number;
  potResultsSummary: ChannelHandPotResultSummary[];
  reachedShowdown: boolean;
};

type EmbargoedChannelHandIndexItem = ChannelHandIndexItem & {
  visibility: "embargoed";
};

type RevealedChannelHandIndexItem = ChannelHandIndexItem & {
  visibility: "revealed";
};

type ChannelHandHistoryIndexItem =
  | EmbargoedChannelHandIndexItem
  | RevealedChannelHandIndexItem;

type ChannelHandListResponse = PublicApiResponse<ChannelHandIndexItem[]>;
type ChannelHandHistoryListResponse = PublicApiResponse<
  ChannelHandHistoryIndexItem[]
>;

type ChannelHandDetailResponse = {
  gameId: number;
  createdAt: number;
  endedAt: number;
  handStartSnapshot: SerializedGame["handHistory"]["handStartSnapshot"] | null;
  actionHistory: SerializedGame["handHistory"]["actionHistory"];
  boardSnapshot: SerializedGame["handHistory"]["boardSnapshot"];
  handEndSnapshot: SerializedGame["handHistory"]["handEndSnapshot"] | null;
  communityCards: SerializedGame["communityCards"];
  activePlayers: SerializedGame["activePlayers"];
  inactivePlayers: SerializedGame["inactivePlayers"];
  foldedPlayers: SerializedGame["foldedPlayers"];
  bettingHistory: SerializedGame["bettingHistory"];
  dealerPosition: SerializedGame["dealerPosition"];
  smallBlind: SerializedGame["smallBlind"];
  bigBlind: SerializedGame["bigBlind"];
  playerPositions: SerializedGame["playerPositions"];
  currentPot: SerializedGame["currentPot"];
  currentBetAmount: SerializedGame["currentBetAmount"];
  lastRaiseAmount: SerializedGame["lastRaiseAmount"];
  gameState: SerializedGame["gameState"];
  preDealId: SerializedGame["preDealId"];
  handStartChips: SerializedGame["handStartChips"];
};

type RevealedChannelHandDetailResponse = ChannelHandDetailResponse & {
  visibility: "revealed";
};

type EmbargoedHandStartPlayerSnapshot = Omit<
  NonNullable<ChannelHandDetailResponse["handStartSnapshot"]>["players"][number],
  "holeCards"
>;

type EmbargoedHandStartSnapshot = Omit<
  NonNullable<ChannelHandDetailResponse["handStartSnapshot"]>,
  "players"
> & {
  players: EmbargoedHandStartPlayerSnapshot[];
};

type EmbargoedHandEndPlayerSnapshot = NonNullable<
  ChannelHandDetailResponse["handEndSnapshot"]
>["players"][number] & {
  revealedHoleCards?: SerializedGame["communityCards"];
};

type EmbargoedHandEndSnapshot = Omit<
  NonNullable<ChannelHandDetailResponse["handEndSnapshot"]>,
  "players"
> & {
  players: EmbargoedHandEndPlayerSnapshot[];
};

type EmbargoedChannelHandDetailResponse = {
  visibility: "embargoed";
  gameId: number;
  createdAt: number;
  endedAt: number;
  handStartSnapshot: EmbargoedHandStartSnapshot | null;
  actionHistory: SerializedGame["handHistory"]["actionHistory"];
  boardSnapshot: SerializedGame["handHistory"]["boardSnapshot"];
  handEndSnapshot: EmbargoedHandEndSnapshot | null;
  dealerPosition: SerializedGame["dealerPosition"];
  smallBlind: SerializedGame["smallBlind"];
  bigBlind: SerializedGame["bigBlind"];
};

type ChannelHandHistoryDetailResponse =
  | EmbargoedChannelHandDetailResponse
  | RevealedChannelHandDetailResponse;

type ChannelPlayerStatsRow = {
  playerId: string;
  handsCount: number;
  wonAnyPot: number;
  reachedShowdown: number;
  folded: number;
  checkCount: number;
  callCount: number;
  betCount: number;
  raiseCount: number;
  allInCount: number;
  raiseToTotal: number;
  chipsCommitted: number;
  chipsWon: number;
  netChips: number;
};

type ChannelPlayerStatsListResponse = PublicApiResponse<ChannelPlayerStatsRow[]>;

type ChannelNetChipsSeriesHandRow = {
  gameId: number;
  endedAt: number;
};

type ChannelNetChipsSeriesPlayerRow = {
  playerId: string;
  playerName: string;
  series: number[];
};

type ChannelNetChipsSeriesResponse = {
  channelId: string;
  hands: ChannelNetChipsSeriesHandRow[];
  players: ChannelNetChipsSeriesPlayerRow[];
};

type ChannelPlayerStatsDetailResponse = {
  playerId: string;
  handsCount: number;
  wonAnyPot: number;
  reachedShowdown: number;
  folded: number;
  checkCount: number;
  callCount: number;
  betCount: number;
  raiseCount: number;
  allInCount: number;
  raiseToTotal: number;
  chipsCommitted: number;
  chipsWon: number;
  netChips: number;
  recentVisibleHands: ChannelHandIndexItem[];
};

type DecodedCursor = {
  endedAt: number;
  gameId: number;
};

const PUBLIC_WORKSPACE_ID = "TDUQJ4MMY";
const PUBLIC_HAND_EMBARGO_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;
const HOT_STREAK_THRESHOLD = 5;
const COLD_STREAK_THRESHOLD = 5;

function getPublicRevealCutoffMs(now: number = Date.now()): number {
  return now - PUBLIC_HAND_EMBARGO_WINDOW_MS;
}

function encodeCursor(cursor: DecodedCursor): string {
  return Buffer.from(JSON.stringify(cursor)).toString("base64url");
}

function decodeCursor(cursor: string | null): DecodedCursor | null {
  if (!cursor) {
    return null;
  }

  try {
    const decoded = JSON.parse(
      Buffer.from(cursor, "base64url").toString("utf8")
    ) as Partial<DecodedCursor>;
    if (
      typeof decoded.endedAt !== "number" ||
      typeof decoded.gameId !== "number"
    ) {
      return null;
    }
    return { endedAt: decoded.endedAt, gameId: decoded.gameId };
  } catch {
    return null;
  }
}

/** A Durable Object's behavior is defined in an exported Javascript class */
export class PokerDurableObject extends DurableObject<Env> {
  sql: SqlStorage;
  /**
   * The constructor is invoked once upon creation of the Durable Object, i.e. the first call to
   * 	`DurableObjectStub::get` for a given identifier (no-op constructors can be omitted)
   *
   * @param ctx - The interface for interacting with Durable Object state
   * @param env - The interface to reference bindings declared in wrangler.jsonc
   */
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.sql = ctx.storage.sql;
    this.migratePokerGamesSchemaIfNeeded();
    this.sql.exec(`
			CREATE TABLE IF NOT EXISTS PokerGames (
				workspaceId TEXT NOT NULL,
				channelId TEXT NOT NULL,
				gameId INTEGER NOT NULL,
				game JSON NOT NULL,
				createdAt INTEGER NOT NULL,
				endedAt INTEGER,
				PRIMARY KEY (workspaceId, channelId, gameId)
			);
		`);

    this.sql.exec(`
			CREATE TABLE IF NOT EXISTS ChannelGameState (
				workspaceId TEXT NOT NULL,
				channelId TEXT NOT NULL,
				game JSON NOT NULL,
				nextGameId INTEGER NOT NULL,
				activeGameId INTEGER,
				PRIMARY KEY (workspaceId, channelId)
			);
		`);

    this.sql.exec(`
			CREATE TABLE IF NOT EXISTS Flops (
				workspaceId TEXT NOT NULL,
				channelId TEXT NOT NULL,
				flop TEXT NOT NULL,
				createdAt INTEGER,
				PRIMARY KEY (workspaceId, channelId, flop)
			);
		`);

    this.sql.exec(`
			CREATE TABLE IF NOT EXISTS PlayerHandFacts (
				workspaceId TEXT NOT NULL,
				channelId TEXT NOT NULL,
				gameId INTEGER NOT NULL,
				playerId TEXT NOT NULL,
				participated INTEGER NOT NULL,
				wonAnyPot INTEGER NOT NULL,
				reachedShowdown INTEGER NOT NULL,
				folded INTEGER NOT NULL,
				checkCount INTEGER NOT NULL,
				callCount INTEGER NOT NULL,
				betCount INTEGER NOT NULL,
				raiseCount INTEGER NOT NULL,
				allInCount INTEGER NOT NULL,
				raiseToTotal INTEGER NOT NULL,
				chipsCommitted INTEGER NOT NULL,
				chipsWon INTEGER NOT NULL,
				netChips INTEGER NOT NULL,
				PRIMARY KEY (workspaceId, channelId, gameId, playerId)
			);
		`);

    this.sql.exec(`
			CREATE TABLE IF NOT EXISTS PendingChannelResets (
				workspaceId TEXT NOT NULL,
				channelId TEXT NOT NULL,
				requestedAt INTEGER NOT NULL,
				PRIMARY KEY (workspaceId, channelId)
			);
		`);

    // Table to track processed messages for idempotency
    // This prevents duplicate processing when Slack retries message delivery
    this.sql.exec(`
			CREATE TABLE IF NOT EXISTS ProcessedMessages (
				workspaceId TEXT NOT NULL,
				channelId TEXT NOT NULL,
				messageTs TEXT NOT NULL,
				processedAt INTEGER NOT NULL,
				PRIMARY KEY (workspaceId, channelId, messageTs)
			);
		`);

    // Index for cleanup queries (to delete old entries)
    this.sql.exec(`
			CREATE INDEX IF NOT EXISTS idx_processedmessages_cleanup
			ON ProcessedMessages (processedAt);
		`);

    // Table to store per-channel settings (e.g., command whitelist mode)
    this.sql.exec(`
			CREATE TABLE IF NOT EXISTS ChannelSettings (
				workspaceId TEXT NOT NULL,
				channelId TEXT NOT NULL,
				hubsOnlyMode INTEGER NOT NULL DEFAULT 0,
				PRIMARY KEY (workspaceId, channelId)
			);
		`);

    // Table to store daily closing prices for HUBS stock
    this.sql.exec(`
			CREATE TABLE IF NOT EXISTS closingPrices (
				date TEXT NOT NULL PRIMARY KEY,
				symbol TEXT NOT NULL,
				price REAL NOT NULL,
				collectedAt INTEGER NOT NULL
			);
		`);

    // Clear any closing prices before the new start date (March 18, 2026)
    this.sql.exec(`
			DELETE FROM closingPrices WHERE date < '2026-03-18'
		`);
  }

  /**
   * Check if a message has already been processed (idempotency check).
   * Returns true if the message was already processed, false otherwise.
   */
  hasProcessedMessage(
    workspaceId: string,
    channelId: string,
    messageTs: string
  ): boolean {
    const result = this.sql.exec(
      `
			SELECT 1 FROM ProcessedMessages
			WHERE workspaceId = ? AND channelId = ? AND messageTs = ?
			LIMIT 1
		`,
      workspaceId,
      channelId,
      messageTs
    );
    return result.next().done === false;
  }

  /**
   * Mark a message as processed. Returns true if this is a new message,
   * false if it was already processed (idempotency).
   * Uses INSERT OR IGNORE for atomic check-and-set, then SELECT changes()
   * to reliably determine if the row was actually inserted.
   */
  markMessageProcessed(
    workspaceId: string,
    channelId: string,
    messageTs: string
  ): boolean {
    // Use INSERT OR IGNORE - if the message already exists, this is a no-op
    this.sql.exec(
      `
			INSERT OR IGNORE INTO ProcessedMessages (workspaceId, channelId, messageTs, processedAt)
			VALUES (?, ?, ?, ?)
		`,
      workspaceId,
      channelId,
      messageTs,
      Date.now()
    );
    // Use SQLite's changes() function to check if a row was actually inserted.
    // changes() returns the number of rows modified by the most recent INSERT/UPDATE/DELETE.
    // This is more reliable than checking rowsWritten on the cursor.
    const changesResult = this.sql.exec(`SELECT changes() as count`);
    const row = changesResult.one();
    return (row?.count as number) === 1;
  }

  /**
   * Clean up old processed message entries to prevent unbounded growth.
   * Call this periodically (e.g., on each request with a random chance).
   */
  cleanupOldProcessedMessages(maxAgeMs: number = 24 * 60 * 60 * 1000): void {
    const cutoff = Date.now() - maxAgeMs;
    this.sql.exec(
      `
			DELETE FROM ProcessedMessages WHERE processedAt < ?
		`,
      cutoff
    );
  }

  /**
   * Check if "hubs only" mode is enabled for a channel.
   * When enabled, only the HUBS command is allowed.
   * Uses .next() instead of .one() to handle missing rows gracefully.
   */
  isHubsOnlyMode(workspaceId: string, channelId: string): boolean {
    const result = this.sql.exec(
      `
			SELECT hubsOnlyMode FROM ChannelSettings
			WHERE workspaceId = ? AND channelId = ?
			LIMIT 1
		`,
      workspaceId,
      channelId
    );
    const row = result.next();
    // If no row exists, default to false (not in hubs only mode)
    if (!row.value) {
      return false;
    }
    return (row.value.hubsOnlyMode as number) === 1;
  }

  /**
   * Enable or disable "hubs only" mode for a channel.
   */
  setHubsOnlyMode(
    workspaceId: string,
    channelId: string,
    enabled: boolean
  ): void {
    this.sql.exec(
      `
			INSERT INTO ChannelSettings (workspaceId, channelId, hubsOnlyMode)
			VALUES (?, ?, ?)
			ON CONFLICT(workspaceId, channelId) DO UPDATE SET
				hubsOnlyMode = excluded.hubsOnlyMode
		`,
      workspaceId,
      channelId,
      enabled ? 1 : 0
    );
  }

  /**
   * Save a closing price for a given date.
   * Uses INSERT OR REPLACE to update if the date already exists.
   */
  saveClosingPrice(date: string, symbol: string, price: number): void {
    this.sql.exec(
      `
			INSERT OR REPLACE INTO closingPrices (date, symbol, price, collectedAt)
			VALUES (?, ?, ?, ?)
		`,
      date,
      symbol,
      price,
      Date.now()
    );
  }

  /**
   * Get all closing prices for a given symbol, ordered by date.
   */
  getClosingPrices(symbol: string): Array<{ date: string; price: number }> {
    const result = this.sql.exec(
      `
			SELECT date, price FROM closingPrices
			WHERE symbol = ?
			ORDER BY date ASC
		`,
      symbol
    );

    const prices: Array<{ date: string; price: number }> = [];
    for (const row of result) {
      prices.push({
        date: row.date as string,
        price: row.price as number,
      });
    }
    return prices;
  }

  /**
   * Calculate the trailing average of closing prices for a given symbol.
   * Returns null if no prices are available.
   */
  getTrailingAverage(
    symbol: string
  ): { average: number; count: number } | null {
    const prices = this.getClosingPrices(symbol);
    if (prices.length === 0) {
      return null;
    }

    const sum = prices.reduce((acc, p) => acc + p.price, 0);
    const average = sum / prices.length;

    return {
      average: Math.round(average * 100) / 100,
      count: prices.length,
    };
  }

  addFlop(
    workspaceId: string,
    channelId: string,
    flop: string,
    createdAt: number
  ): number {
    this.sql.exec(
      `
			INSERT INTO Flops (workspaceId, channelId, flop, createdAt)
			VALUES (?, ?, ?, ?)
		`,
      workspaceId,
      channelId,
      flop,
      createdAt
    );

    const result = this.sql.exec(
      `
			SELECT COUNT(*) AS count
			FROM Flops
			WHERE workspaceId = ?
			  AND channelId = ?
			`,
      workspaceId,
      channelId
    );
    return result.one().count as number;
  }

  async getFlop(workspaceId: string, channelId: string, flop: string) {
    const result = this.sql.exec(
      `
		  SELECT flop, createdAt FROM Flops
		  WHERE workspaceId = ? AND channelId = ? AND flop = ?
		  `,
      workspaceId,
      channelId,
      flop
    );

    // iterate over results (can be 0..n rows)
    for (const row of result) {
      return row; // just return first row
    }

    return null; // nothing found
  }

  async getFlops(workspaceId: string, channelId: string) {
    const result = this.sql.exec(
      `
			  SELECT flop, createdAt FROM Flops
			  WHERE workspaceId = ? AND channelId = ?
			  `,
      workspaceId,
      channelId
    );

    const flops: Array<{ createdAt: number; flop: string }> = [];
    for (const row of result) {
      flops.push({
        createdAt: row.createdAt as number,
        flop: row.flop as string,
      });
    }

    return flops;
  }

  async searchFlops(
    workspaceId: string,
    channelId: string,
    flopSearch: string
  ) {
    const result = this.sql.exec(
      `
			  SELECT flop, createdAt FROM Flops
			  WHERE workspaceId = ? AND channelId = ? AND flop LIKE ?
			  `,
      workspaceId,
      channelId,
      `%${flopSearch}%`
    );

    const flops: Array<{ createdAt: number; flop: string }> = [];
    for (const row of result) {
      flops.push({
        createdAt: row.createdAt as number,
        flop: row.flop as string,
      });
    }

    return flops;
  }

  private hasTable(tableName: string): boolean {
    const result = this.sql.exec(
      `
			SELECT name FROM sqlite_master
			WHERE type = 'table' AND name = ?
		`,
      tableName
    );
    return result.next().done === false;
  }

  private migratePokerGamesSchemaIfNeeded(): void {
    if (!this.hasTable("PokerGames")) {
      return;
    }

    const columns = this.sql
      .exec<{ name: string }>(`PRAGMA table_info(PokerGames)`)
      .toArray()
      .map((row) => row.name);

    if (columns.length === 0 || columns.includes("gameId")) {
      return;
    }

    if (!this.hasTable("LegacyPokerGames")) {
      this.sql.exec(`ALTER TABLE PokerGames RENAME TO LegacyPokerGames`);
    }
  }

  private loadLegacyGame(
    workspaceId: string,
    channelId: string
  ): SerializedGame | null {
    if (!this.hasTable("LegacyPokerGames")) {
      return null;
    }

    const row = this.sql
      .exec(
        `
			SELECT game FROM LegacyPokerGames
			WHERE workspaceId = ? AND channelId = ?
		`,
        workspaceId,
        channelId
      )
      .next();

    if (!row.value) {
      return null;
    }

    return JSON.parse(row.value.game as string) as SerializedGame;
  }

  private deleteLegacyGame(workspaceId: string, channelId: string): void {
    if (!this.hasTable("LegacyPokerGames")) {
      return;
    }

    this.sql.exec(
      `
			DELETE FROM LegacyPokerGames
			WHERE workspaceId = ? AND channelId = ?
		`,
      workspaceId,
      channelId
    );
  }

  private saveChannelGameState(
    workspaceId: string,
    channelId: string,
    game: string,
    nextGameId: number,
    activeGameId: number | null
  ): void {
    this.sql.exec(
      `
			INSERT INTO ChannelGameState (workspaceId, channelId, game, nextGameId, activeGameId)
			VALUES (?, ?, ?, ?, ?)
			ON CONFLICT(workspaceId, channelId) DO UPDATE SET
				game = excluded.game,
				nextGameId = excluded.nextGameId,
				activeGameId = excluded.activeGameId
		`,
      workspaceId,
      channelId,
      game,
      nextGameId,
      activeGameId
    );
  }

  private hasPendingChannelReset(
    workspaceId: string,
    channelId: string
  ): boolean {
    const row = this.sql
      .exec(
        `
			SELECT 1
			FROM PendingChannelResets
			WHERE workspaceId = ? AND channelId = ?
			LIMIT 1
		`,
        workspaceId,
        channelId
      )
      .next();

    return row.value !== undefined;
  }

  private queueChannelReset(
    workspaceId: string,
    channelId: string,
    requestedAt: number
  ): void {
    this.sql.exec(
      `
			INSERT INTO PendingChannelResets (workspaceId, channelId, requestedAt)
			VALUES (?, ?, ?)
			ON CONFLICT(workspaceId, channelId) DO UPDATE SET
				requestedAt = excluded.requestedAt
		`,
      workspaceId,
      channelId,
      requestedAt
    );
  }

  private clearPendingChannelReset(
    workspaceId: string,
    channelId: string
  ): void {
    this.sql.exec(
      `
			DELETE FROM PendingChannelResets
			WHERE workspaceId = ? AND channelId = ?
		`,
      workspaceId,
      channelId
    );
  }

  private resetChannelHistoryAndStats(
    workspaceId: string,
    channelId: string,
    preservedGame: string
  ): void {
    this.sql.exec(
      `
			DELETE FROM PokerGames
			WHERE workspaceId = ? AND channelId = ?
		`,
      workspaceId,
      channelId
    );
    this.sql.exec(
      `
			DELETE FROM PlayerHandFacts
			WHERE workspaceId = ? AND channelId = ?
		`,
      workspaceId,
      channelId
    );
    this.saveChannelGameState(workspaceId, channelId, preservedGame, 1, null);
  }

  private maybeApplyPendingChannelReset(
    workspaceId: string,
    channelId: string,
    preservedGame: string
  ): boolean {
    const channelState = this.getChannelGameState(workspaceId, channelId);
    if (
      !channelState ||
      channelState.activeGameId !== null ||
      !this.hasPendingChannelReset(workspaceId, channelId)
    ) {
      return false;
    }

    this.resetChannelHistoryAndStats(workspaceId, channelId, preservedGame);
    this.clearPendingChannelReset(workspaceId, channelId);
    return true;
  }

  private getChannelGameState(
    workspaceId: string,
    channelId: string
  ): ChannelGameStateRecord | null {
    const row = this.sql
      .exec(
        `
			SELECT game, nextGameId, activeGameId
			FROM ChannelGameState
			WHERE workspaceId = ? AND channelId = ?
		`,
        workspaceId,
        channelId
      )
      .next();

    if (!row.value) {
      return null;
    }

    return {
      game: JSON.parse(row.value.game as string) as SerializedGame,
      nextGameId: Number(row.value.nextGameId),
      activeGameId:
        row.value.activeGameId === null
          ? null
          : Number(row.value.activeGameId),
    };
  }

  private loadChannelGameState(
    workspaceId: string,
    channelId: string
  ): ChannelGameStateRecord | null {
    const existing = this.getChannelGameState(workspaceId, channelId);
    if (existing) {
      return existing;
    }

    const legacyGame = this.loadLegacyGame(workspaceId, channelId);
    if (!legacyGame) {
      return null;
    }

    const now = Date.now();
    const legacyTexasHoldem = TexasHoldem.fromJson(legacyGame);

    if (legacyTexasHoldem.getGameState() === GameState.WaitingForPlayers) {
      this.saveChannelGameState(
        workspaceId,
        channelId,
        JSON.stringify(legacyTexasHoldem.toJson()),
        1,
        null
      );
    } else {
      this.insertPokerGame(
        workspaceId,
        channelId,
        1,
        JSON.stringify(legacyTexasHoldem.toJson()),
        now,
        null
      );
      this.saveChannelGameState(
        workspaceId,
        channelId,
        JSON.stringify(legacyTexasHoldem.toJson()),
        2,
        1
      );
    }

    this.deleteLegacyGame(workspaceId, channelId);
    return this.getChannelGameState(workspaceId, channelId);
  }

  private insertPokerGame(
    workspaceId: string,
    channelId: string,
    gameId: number,
    game: string,
    createdAt: number,
    endedAt: number | null
  ): void {
    this.sql.exec(
      `
			INSERT INTO PokerGames (workspaceId, channelId, gameId, game, createdAt, endedAt)
			VALUES (?, ?, ?, ?, ?, ?)
		`,
      workspaceId,
      channelId,
      gameId,
      game,
      createdAt,
      endedAt
    );
  }

  private getPokerGame(
    workspaceId: string,
    channelId: string,
    gameId: number
  ): ActiveGameRecord | null {
    const row = this.sql
      .exec(
        `
			SELECT gameId, game, createdAt, endedAt
			FROM PokerGames
			WHERE workspaceId = ? AND channelId = ? AND gameId = ?
		`,
        workspaceId,
        channelId,
        gameId
      )
      .next();

    if (!row.value) {
      return null;
    }

    return {
      gameId: Number(row.value.gameId),
      game: JSON.parse(row.value.game as string) as SerializedGame,
      createdAt: Number(row.value.createdAt),
      endedAt: row.value.endedAt === null ? null : Number(row.value.endedAt),
    };
  }

  private loadActiveGame(
    workspaceId: string,
    channelId: string
  ): ActiveGameRecord | null {
    const channelState = this.loadChannelGameState(workspaceId, channelId);
    if (!channelState || channelState.activeGameId === null) {
      return null;
    }

    return this.getPokerGame(
      workspaceId,
      channelId,
      channelState.activeGameId
    );
  }

  private createHandFromChannelState(
    workspaceId: string,
    channelId: string
  ): { gameId: number; game: TexasHoldem; channelState: ChannelGameStateRecord } | null {
    let channelState = this.loadChannelGameState(workspaceId, channelId);
    if (!channelState || channelState.activeGameId !== null) {
      return null;
    }

    if (
      this.maybeApplyPendingChannelReset(
        workspaceId,
        channelId,
        JSON.stringify(channelState.game)
      )
    ) {
      channelState = this.getChannelGameState(workspaceId, channelId);
      if (!channelState) {
        return null;
      }
    }

    return {
      gameId: channelState.nextGameId,
      game: TexasHoldem.fromJson(channelState.game),
      channelState,
    };
  }

  private saveActiveHand(
    workspaceId: string,
    channelId: string,
    gameId: number,
    game: string,
    endedAt: number | null = null
  ): void {
    this.sql.exec(
      `
			UPDATE PokerGames
			SET game = ?, endedAt = ?
			WHERE workspaceId = ? AND channelId = ? AND gameId = ?
		`,
      game,
      endedAt,
      workspaceId,
      channelId,
      gameId
    );
  }

  private insertPlayerHandFact(record: PlayerHandFactRecord): void {
    this.sql.exec(
      `
			INSERT OR REPLACE INTO PlayerHandFacts (
				workspaceId, channelId, gameId, playerId, participated, wonAnyPot,
				reachedShowdown, folded, checkCount, callCount, betCount, raiseCount,
				allInCount, raiseToTotal, chipsCommitted, chipsWon, netChips
			)
			VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
		`,
      record.workspaceId,
      record.channelId,
      record.gameId,
      record.playerId,
      record.participated ? 1 : 0,
      record.wonAnyPot ? 1 : 0,
      record.reachedShowdown ? 1 : 0,
      record.folded ? 1 : 0,
      record.checkCount,
      record.callCount,
      record.betCount,
      record.raiseCount,
      record.allInCount,
      record.raiseToTotal,
      record.chipsCommitted,
      record.chipsWon,
      record.netChips
    );
  }

  private buildPlayerHandFactRecords(
    workspaceId: string,
    channelId: string,
    gameId: number,
    game: TexasHoldem
  ): PlayerHandFactRecord[] {
    const trackedPlayerIds = new Set(allUsers.map((user) => user.userId));
    const handStartSnapshot = game.getHandStartSnapshot();
    const handEndSnapshot = game.getHandEndSnapshot();
    if (!handStartSnapshot || !handEndSnapshot) {
      return [];
    }

    const playerById = new Map(
      [...game.getActivePlayers(), ...game.getInactivePlayers()].map((player) => [
        player.getId(),
        player,
      ])
    );
    const actionHistory = game.getActionHistory();
    const outcomeByPlayerId = new Map(
      handEndSnapshot.players.map((player) => [player.playerId, player])
    );

    return handStartSnapshot.players
      .filter(({ playerId }) => trackedPlayerIds.has(playerId))
      .map(({ playerId, startingStack }) => {
        const player = playerById.get(playerId);
        const playerActions = actionHistory.filter(
          (action) => action.playerId === playerId
        );
        let checkCount = 0;
        let callCount = 0;
        let betCount = 0;
        let raiseCount = 0;
        let allInCount = 0;
        let raiseToTotal = 0;

        playerActions.forEach((action) => {
          switch (action.actionType) {
            case "check":
              checkCount += 1;
              break;
            case "call":
              callCount += 1;
              break;
            case "bet":
              betCount += 1;
              break;
            case "raise":
              raiseCount += 1;
              raiseToTotal += action.targetBet;
              break;
            default:
              break;
          }
          if (action.isAllIn) {
            allInCount += 1;
          }
        });

        const chipsCommitted = playerActions.reduce(
          (total, action) => total + action.contribution,
          0
        );
        const finalChips = player?.getChips() ?? startingStack;
        const outcome = outcomeByPlayerId.get(playerId);

        return {
          workspaceId,
          channelId,
          gameId,
          playerId,
          participated: true,
          wonAnyPot: (outcome?.chipsWon ?? 0) > 0,
          reachedShowdown: outcome?.reachedShowdown ?? false,
          folded: outcome?.foldedStreet !== null,
          checkCount,
          callCount,
          betCount,
          raiseCount,
          allInCount,
          raiseToTotal,
          chipsCommitted,
          chipsWon: outcome?.chipsWon ?? 0,
          netChips: finalChips - startingStack,
        };
      });
  }

  private recordCompletedHandFacts(data: {
    workspaceId: string;
    channelId: string;
    gameId: number;
  }): { ok: true; count: number } | { ok: false; reason: "no_game" } {
    const activeGame = this.getPokerGame(
      data.workspaceId,
      data.channelId,
      data.gameId
    );
    if (!activeGame) {
      return { ok: false, reason: "no_game" };
    }

    const game = TexasHoldem.fromJson(activeGame.game);
    const records = this.buildPlayerHandFactRecords(
      data.workspaceId,
      data.channelId,
      data.gameId,
      game
    );

    records.forEach((record) => {
      this.insertPlayerHandFact(record);
    });

    return { ok: true, count: records.length };
  }

  private getLatestCompletedGameId(
    workspaceId: string,
    channelId: string
  ): number | null {
    const row = this.sql
      .exec(
        `
          SELECT MAX(gameId) AS gameId
          FROM PokerGames
          WHERE workspaceId = ?
            AND channelId = ?
            AND endedAt IS NOT NULL
        `,
        workspaceId,
        channelId
      )
      .one();

    if (!row || row.gameId === null || typeof row.gameId === "undefined") {
      return null;
    }

    return Number(row.gameId);
  }

  private getPlayerHandStreakFactsForGame(
    workspaceId: string,
    channelId: string,
    gameId: number
  ): PlayerHandStreakFact[] {
    return this.sql
      .exec(
        `
          SELECT gameId, playerId, participated, wonAnyPot
          FROM PlayerHandFacts
          WHERE workspaceId = ?
            AND channelId = ?
            AND gameId = ?
          ORDER BY playerId ASC
        `,
        workspaceId,
        channelId,
        gameId
      )
      .toArray()
      .map((row) => ({
        gameId: Number(row.gameId),
        playerId: row.playerId as string,
        participated: Number(row.participated) === 1,
        wonAnyPot: Number(row.wonAnyPot) === 1,
      }));
  }

  private countTrailingWinState(
    workspaceId: string,
    channelId: string,
    playerId: string,
    gameId: number,
    wonAnyPot: boolean
  ): number {
    const rows = this.sql
      .exec(
        `
          SELECT wonAnyPot
          FROM PlayerHandFacts
          WHERE workspaceId = ?
            AND channelId = ?
            AND playerId = ?
            AND gameId <= ?
          ORDER BY gameId DESC
        `,
        workspaceId,
        channelId,
        playerId,
        gameId
      )
      .toArray();

    let streak = 0;
    for (const row of rows) {
      if ((Number(row.wonAnyPot) === 1) !== wonAnyPot) {
        break;
      }
      streak += 1;
    }

    return streak;
  }

  async getCompletedHandStreakMessages(
    workspaceId: string,
    channelId: string,
    gameId?: number
  ): Promise<string[]> {
    const targetGameId =
      typeof gameId === "number"
        ? gameId
        : this.getLatestCompletedGameId(workspaceId, channelId);

    if (targetGameId === null) {
      return [];
    }

    const currentHandFacts = this.getPlayerHandStreakFactsForGame(
      workspaceId,
      channelId,
      targetGameId
    );
    if (currentHandFacts.length === 0) {
      return [];
    }

    const messages: string[] = [];

    currentHandFacts
      .filter((fact) => fact.wonAnyPot)
      .forEach((fact) => {
        const streak = this.countTrailingWinState(
          workspaceId,
          channelId,
          fact.playerId,
          targetGameId,
          true
        );
        if (streak === HOT_STREAK_THRESHOLD) {
          messages.push(`${fact.playerId} is running HOT :fire: :fire: :fire:`);
        }
      });

    currentHandFacts
      .filter((fact) => fact.participated && !fact.wonAnyPot)
      .forEach((fact) => {
        const streak = this.countTrailingWinState(
          workspaceId,
          channelId,
          fact.playerId,
          targetGameId,
          false
        );
        if (streak === COLD_STREAK_THRESHOLD) {
          messages.push(
            `${fact.playerId} is running COLD :ice_cube: :cold_face: :snowman:`
          );
        }
      });

    return messages;
  }

  async getPlayerHandStats(
    workspaceId: string,
    channelId: string
  ): Promise<AggregatedPlayerHandStats[]> {
    const rows = this.sql
      .exec(
        `
			SELECT
				playerId,
				COUNT(*) AS handsCount,
				SUM(participated) AS participated,
				SUM(wonAnyPot) AS wonAnyPot,
				SUM(reachedShowdown) AS reachedShowdown,
				SUM(folded) AS folded,
				SUM(checkCount) AS checkCount,
				SUM(callCount) AS callCount,
				SUM(betCount) AS betCount,
				SUM(raiseCount) AS raiseCount,
				SUM(allInCount) AS allInCount,
				SUM(raiseToTotal) AS raiseToTotal,
				SUM(chipsCommitted) AS chipsCommitted,
				SUM(chipsWon) AS chipsWon,
				SUM(netChips) AS netChips
			FROM PlayerHandFacts
			WHERE workspaceId = ? AND channelId = ?
			GROUP BY playerId
			ORDER BY playerId ASC
		`,
        workspaceId,
        channelId
      )
      .toArray();

    return allUsers.map((user) => {
      const row = rows.find((candidate) => candidate.playerId === user.userId);
      return {
        playerId: user.userId,
        handsCount: Number(row?.handsCount ?? 0),
        participated: Number(row?.participated ?? 0),
        wonAnyPot: Number(row?.wonAnyPot ?? 0),
        reachedShowdown: Number(row?.reachedShowdown ?? 0),
        folded: Number(row?.folded ?? 0),
        checkCount: Number(row?.checkCount ?? 0),
        callCount: Number(row?.callCount ?? 0),
        betCount: Number(row?.betCount ?? 0),
        raiseCount: Number(row?.raiseCount ?? 0),
        allInCount: Number(row?.allInCount ?? 0),
        raiseToTotal: Number(row?.raiseToTotal ?? 0),
        chipsCommitted: Number(row?.chipsCommitted ?? 0),
        chipsWon: Number(row?.chipsWon ?? 0),
        netChips: Number(row?.netChips ?? 0),
      };
    });
  }

  private channelExists(workspaceId: string, channelId: string): boolean {
    if (this.getChannelGameState(workspaceId, channelId)) {
      return true;
    }

    return (
      this.sql.exec(
        `
          SELECT 1
          FROM PokerGames
          WHERE workspaceId = ? AND channelId = ?
          LIMIT 1
        `,
        workspaceId,
        channelId
      ).next().done === false
    );
  }

  private isHandFullyRevealed(endedAt: number, now: number = Date.now()): boolean {
    return endedAt <= getPublicRevealCutoffMs(now);
  }

  private getCompletedPublicGameRows(
    workspaceId: string,
    channelId: string,
    options?: {
      limit?: number;
      cursor?: DecodedCursor | null;
      revealedOnly?: boolean;
      playerId?: string | null;
    }
  ): ActiveGameRecord[] {
    const limit = Math.max(1, Math.min(options?.limit ?? 25, 100));
    const params: Array<string | number> = [workspaceId, channelId];
    let visibilityClause = "";
    let playerClause = "";
    let cursorClause = "";

    if (options?.revealedOnly) {
      visibilityClause = `AND endedAt <= ?`;
      params.push(getPublicRevealCutoffMs());
    }

    if (options?.playerId) {
      playerClause = `
        AND EXISTS (
          SELECT 1
          FROM PlayerHandFacts facts
          WHERE facts.workspaceId = PokerGames.workspaceId
            AND facts.channelId = PokerGames.channelId
            AND facts.gameId = PokerGames.gameId
            AND facts.playerId = ?
        )
      `;
      params.push(options.playerId);
    }

    if (options?.cursor) {
      cursorClause = `
        AND (
          endedAt < ?
          OR (endedAt = ? AND gameId < ?)
        )
      `;
      params.push(
        options.cursor.endedAt,
        options.cursor.endedAt,
        options.cursor.gameId
      );
    }

    params.push(limit);

    return this.sql
      .exec(
        `
          SELECT gameId, game, createdAt, endedAt
          FROM PokerGames
          WHERE workspaceId = ?
            AND channelId = ?
            AND endedAt IS NOT NULL
            ${visibilityClause}
            ${playerClause}
            ${cursorClause}
          ORDER BY endedAt DESC, gameId DESC
          LIMIT ?
        `,
        ...params
      )
      .toArray()
      .map((row) => ({
        gameId: Number(row.gameId),
        game: JSON.parse(row.game as string) as SerializedGame,
        createdAt: Number(row.createdAt),
        endedAt: Number(row.endedAt),
      }));
  }

  private buildChannelHandIndexItem(record: ActiveGameRecord): ChannelHandIndexItem {
    const handHistory = record.game.handHistory ?? {
      handStartSnapshot: null,
      actionHistory: [],
      boardSnapshot: { flop: [], turn: [], river: [] },
      handEndSnapshot: null,
    };
    const handStartSnapshot = handHistory.handStartSnapshot as
      | {
          smallBlind?: number;
          bigBlind?: number;
          players?: Array<{ playerId: string }>;
        }
      | null;
    const handEndSnapshot = handHistory.handEndSnapshot as
      | {
          players?: Array<{ reachedShowdown: boolean }>;
          potResults?: Array<{
            potIndex: number;
            potType: "main" | "side";
            potSize: number;
            splitAmount: number;
            winnerPlayerIds: string[];
          }>;
        }
      | null;
    const playerIds: string[] =
      handStartSnapshot?.players?.map((player: { playerId: string }) => player.playerId) ??
      [
        ...record.game.activePlayers.map((player: { id: string }) => player.id),
        ...record.game.inactivePlayers.map((player: { id: string }) => player.id),
      ];
    const winners: string[] = Array.from(
      new Set(
        (handEndSnapshot?.potResults ?? []).flatMap(
          (potResult: { winnerPlayerIds: string[] }) => potResult.winnerPlayerIds
        )
      )
    );
    const potResultsSummary: ChannelHandPotResultSummary[] = (
      handEndSnapshot?.potResults ?? []
    ).map((potResult) => ({
        potIndex: potResult.potIndex,
        potType: potResult.potType,
        potSize: potResult.potSize,
        splitAmount: potResult.splitAmount,
        winnerPlayerIds: [...potResult.winnerPlayerIds],
      }));

    return {
      gameId: record.gameId,
      createdAt: record.createdAt,
      endedAt: record.endedAt ?? record.createdAt,
      playerIds,
      playerCount: playerIds.length,
      smallBlind: handStartSnapshot?.smallBlind ?? record.game.smallBlind ?? null,
      bigBlind: handStartSnapshot?.bigBlind ?? record.game.bigBlind ?? null,
      board: {
        flop: [...(handHistory.boardSnapshot?.flop ?? [])],
        turn: [...(handHistory.boardSnapshot?.turn ?? [])],
        river: [...(handHistory.boardSnapshot?.river ?? [])],
      },
      winners,
      totalPot: potResultsSummary.reduce(
        (total: number, potResult: ChannelHandPotResultSummary) =>
          total + potResult.potSize,
        0
      ),
      potResultsSummary,
      reachedShowdown: (handEndSnapshot?.players ?? []).some(
        (player: { reachedShowdown: boolean }) => player.reachedShowdown
      ),
    };
  }

  private buildChannelHandHistoryIndexItem(
    record: ActiveGameRecord
  ): ChannelHandHistoryIndexItem {
    const base = this.buildChannelHandIndexItem(record);
    return {
      ...base,
      visibility: this.isHandFullyRevealed(record.endedAt ?? record.createdAt)
        ? "revealed"
        : "embargoed",
    };
  }

  private buildRevealedHandDetail(
    gameRecord: ActiveGameRecord
  ): RevealedChannelHandDetailResponse {
    const handHistory = gameRecord.game.handHistory ?? {
      handStartSnapshot: null,
      actionHistory: [],
      boardSnapshot: { flop: [], turn: [], river: [] },
      handEndSnapshot: null,
    };

    return {
      visibility: "revealed",
      gameId: gameRecord.gameId,
      createdAt: gameRecord.createdAt,
      endedAt: gameRecord.endedAt!,
      handStartSnapshot: handHistory.handStartSnapshot ?? null,
      actionHistory: handHistory.actionHistory ?? [],
      boardSnapshot: handHistory.boardSnapshot ?? {
        flop: [],
        turn: [],
        river: [],
      },
      handEndSnapshot: handHistory.handEndSnapshot ?? null,
      communityCards: gameRecord.game.communityCards,
      activePlayers: gameRecord.game.activePlayers,
      inactivePlayers: gameRecord.game.inactivePlayers,
      foldedPlayers: gameRecord.game.foldedPlayers,
      bettingHistory: gameRecord.game.bettingHistory,
      dealerPosition: gameRecord.game.dealerPosition,
      smallBlind: gameRecord.game.smallBlind,
      bigBlind: gameRecord.game.bigBlind,
      playerPositions: gameRecord.game.playerPositions,
      currentPot: gameRecord.game.currentPot,
      currentBetAmount: gameRecord.game.currentBetAmount,
      lastRaiseAmount: gameRecord.game.lastRaiseAmount,
      gameState: gameRecord.game.gameState,
      preDealId: gameRecord.game.preDealId,
      handStartChips: gameRecord.game.handStartChips,
    };
  }

  private buildEmbargoedHandDetail(
    gameRecord: ActiveGameRecord
  ): EmbargoedChannelHandDetailResponse {
    const handHistory = gameRecord.game.handHistory ?? {
      handStartSnapshot: null,
      actionHistory: [],
      boardSnapshot: { flop: [], turn: [], river: [] },
      handEndSnapshot: null,
    };
    const allPlayers = [
      ...gameRecord.game.activePlayers,
      ...gameRecord.game.inactivePlayers,
    ];
    const holeCardsByPlayerId = new Map(
      allPlayers.map((player: { id: string; cards?: unknown[] }) => [
        player.id,
        [...(player.cards ?? [])],
      ])
    );

    return {
      visibility: "embargoed",
      gameId: gameRecord.gameId,
      createdAt: gameRecord.createdAt,
      endedAt: gameRecord.endedAt!,
      handStartSnapshot: handHistory.handStartSnapshot
        ? {
            ...handHistory.handStartSnapshot,
            players: handHistory.handStartSnapshot.players.map(
              (
                player
              ): EmbargoedHandStartPlayerSnapshot => ({
                playerId: player.playerId,
                seatIndex: player.seatIndex,
                roleFlags: player.roleFlags,
                startingStack: player.startingStack,
              })
            ),
          }
        : null,
      actionHistory: handHistory.actionHistory ?? [],
      boardSnapshot: handHistory.boardSnapshot ?? {
        flop: [],
        turn: [],
        river: [],
      },
      handEndSnapshot: handHistory.handEndSnapshot
        ? {
            ...handHistory.handEndSnapshot,
            players: handHistory.handEndSnapshot.players.map(
              (player): EmbargoedHandEndPlayerSnapshot => ({
                ...player,
                ...(player.reachedShowdown && player.revealedCards
                  ? {
                      revealedHoleCards:
                        holeCardsByPlayerId.get(player.playerId) ?? [],
                    }
                  : {}),
              })
            ),
          }
        : null,
      dealerPosition: gameRecord.game.dealerPosition,
      smallBlind: gameRecord.game.smallBlind,
      bigBlind: gameRecord.game.bigBlind,
    };
  }

  private buildChannelHandHistoryDetail(
    gameRecord: ActiveGameRecord
  ): ChannelHandHistoryDetailResponse {
    return this.isHandFullyRevealed(gameRecord.endedAt ?? gameRecord.createdAt)
      ? this.buildRevealedHandDetail(gameRecord)
      : this.buildEmbargoedHandDetail(gameRecord);
  }

  private getPublicPlayerStatsRows(
    workspaceId: string,
    channelId: string,
    options?: {
      visibleOnly?: boolean;
    }
  ): ChannelPlayerStatsRow[] {
    const endedAtClause = options?.visibleOnly ? "AND games.endedAt <= ?" : "";
    const rows = this.sql
      .exec(
        `
          SELECT
            facts.playerId AS playerId,
            COUNT(*) AS handsCount,
            SUM(facts.wonAnyPot) AS wonAnyPot,
            SUM(facts.reachedShowdown) AS reachedShowdown,
            SUM(facts.folded) AS folded,
            SUM(facts.checkCount) AS checkCount,
            SUM(facts.callCount) AS callCount,
            SUM(facts.betCount) AS betCount,
            SUM(facts.raiseCount) AS raiseCount,
            SUM(facts.allInCount) AS allInCount,
            SUM(facts.raiseToTotal) AS raiseToTotal,
            SUM(facts.chipsCommitted) AS chipsCommitted,
            SUM(facts.chipsWon) AS chipsWon,
            SUM(facts.netChips) AS netChips
          FROM PlayerHandFacts facts
          INNER JOIN PokerGames games
            ON games.workspaceId = facts.workspaceId
            AND games.channelId = facts.channelId
            AND games.gameId = facts.gameId
          WHERE facts.workspaceId = ?
            AND facts.channelId = ?
            AND games.endedAt IS NOT NULL
            ${endedAtClause}
          GROUP BY facts.playerId
        `,
        workspaceId,
        channelId,
        ...(options?.visibleOnly ? [getPublicRevealCutoffMs()] : [])
      )
      .toArray();

    return rows
      .map((row) => ({
        playerId: row.playerId as string,
        handsCount: Number(row.handsCount),
        wonAnyPot: Number(row.wonAnyPot),
        reachedShowdown: Number(row.reachedShowdown),
        folded: Number(row.folded),
        checkCount: Number(row.checkCount),
        callCount: Number(row.callCount),
        betCount: Number(row.betCount),
        raiseCount: Number(row.raiseCount),
        allInCount: Number(row.allInCount),
        raiseToTotal: Number(row.raiseToTotal),
        chipsCommitted: Number(row.chipsCommitted),
        chipsWon: Number(row.chipsWon),
        netChips: Number(row.netChips),
      }))
      .sort(
        (a, b) =>
          b.netChips - a.netChips ||
          b.handsCount - a.handsCount ||
          a.playerId.localeCompare(b.playerId)
      );
  }

  async getPublicChannelSummary(
    workspaceId: string,
    channelId: string
  ): Promise<ChannelSummaryResponse | null> {
    if (!this.channelExists(workspaceId, channelId)) {
      return null;
    }

    const summaryRow = this.sql
      .exec(
        `
          SELECT
            COUNT(*) AS visibleHandsCount,
            MIN(endedAt) AS firstHandEndedAt,
            MAX(endedAt) AS lastHandEndedAt
          FROM PokerGames
          WHERE workspaceId = ?
            AND channelId = ?
            AND endedAt IS NOT NULL
            AND endedAt <= ?
        `,
        workspaceId,
        channelId,
        getPublicRevealCutoffMs()
      )
      .one();
    const playersWithTrackedStats = this.getPublicPlayerStatsRows(
      workspaceId,
      channelId
    ).map((player) => player.playerId);

    return {
      channelId,
      visibleHandsCount: Number(summaryRow?.visibleHandsCount ?? 0),
      firstHandEndedAt:
        summaryRow?.firstHandEndedAt === null ||
        typeof summaryRow?.firstHandEndedAt === "undefined"
          ? null
          : Number(summaryRow.firstHandEndedAt),
      lastHandEndedAt:
        summaryRow?.lastHandEndedAt === null ||
        typeof summaryRow?.lastHandEndedAt === "undefined"
          ? null
          : Number(summaryRow.lastHandEndedAt),
      playersWithTrackedStats,
    };
  }

  async getPublicChannelHands(
    workspaceId: string,
    channelId: string,
    options?: {
      limit?: number;
      cursor?: DecodedCursor | null;
      playerId?: string | null;
    }
  ): Promise<ChannelHandListResponse | null> {
    if (!this.channelExists(workspaceId, channelId)) {
      return null;
    }

    const limit = Math.max(1, Math.min(options?.limit ?? 25, 100));
    const visibleRows = this.getCompletedPublicGameRows(workspaceId, channelId, {
      limit: limit + 1,
      cursor: options?.cursor ?? null,
      revealedOnly: true,
      playerId: options?.playerId ?? null,
    });
    const pageRows = visibleRows;
    const data = pageRows
      .slice(0, limit)
      .map((row) => this.buildChannelHandIndexItem(row));
    const nextCursor =
      pageRows.length > limit
        ? encodeCursor({
            endedAt: pageRows[limit - 1].endedAt ?? pageRows[limit - 1].createdAt,
            gameId: pageRows[limit - 1].gameId,
          })
        : null;

    return {
      data,
      pagination: {
        nextCursor,
      },
    };
  }

  async getPublicHandDetail(
    workspaceId: string,
    channelId: string,
    gameId: number
  ): Promise<ChannelHandDetailResponse | null> {
    const gameRecord = this.getPokerGame(workspaceId, channelId, gameId);
    if (!gameRecord || gameRecord.endedAt === null) {
      return null;
    }

    if (!this.isHandFullyRevealed(gameRecord.endedAt)) {
      return null;
    }

    const detail = this.buildRevealedHandDetail(gameRecord);
    const { visibility, ...legacyDetail } = detail;
    return legacyDetail;
  }

  async getPublicChannelHandHistory(
    workspaceId: string,
    channelId: string,
    options?: {
      limit?: number;
      cursor?: DecodedCursor | null;
      playerId?: string | null;
    }
  ): Promise<ChannelHandHistoryListResponse | null> {
    if (!this.channelExists(workspaceId, channelId)) {
      return null;
    }

    const limit = Math.max(1, Math.min(options?.limit ?? 25, 100));
    const rows = this.getCompletedPublicGameRows(workspaceId, channelId, {
      limit: limit + 1,
      cursor: options?.cursor ?? null,
      playerId: options?.playerId ?? null,
    });
    const pageRows = rows;
    const data = pageRows
      .slice(0, limit)
      .map((row) => this.buildChannelHandHistoryIndexItem(row));
    const nextCursor =
      pageRows.length > limit
        ? encodeCursor({
            endedAt: pageRows[limit - 1].endedAt ?? pageRows[limit - 1].createdAt,
            gameId: pageRows[limit - 1].gameId,
          })
        : null;

    return {
      data,
      pagination: {
        nextCursor,
      },
    };
  }

  async getPublicHandHistoryDetail(
    workspaceId: string,
    channelId: string,
    gameId: number
  ): Promise<ChannelHandHistoryDetailResponse | null> {
    const gameRecord = this.getPokerGame(workspaceId, channelId, gameId);
    if (!gameRecord || gameRecord.endedAt === null) {
      return null;
    }

    return this.buildChannelHandHistoryDetail(gameRecord);
  }

  async getPublicPlayerStats(
    workspaceId: string,
    channelId: string
  ): Promise<ChannelPlayerStatsListResponse | null> {
    if (!this.channelExists(workspaceId, channelId)) {
      return null;
    }

    return {
      data: this.getPublicPlayerStatsRows(workspaceId, channelId),
    };
  }

  async getPublicNetChipsSeries(
    workspaceId: string,
    channelId: string
  ): Promise<ChannelNetChipsSeriesResponse | null> {
    if (!this.channelExists(workspaceId, channelId)) {
      return null;
    }

    const hands = this.sql
      .exec(
        `
          SELECT gameId, endedAt
          FROM PokerGames
          WHERE workspaceId = ?
            AND channelId = ?
            AND endedAt IS NOT NULL
          ORDER BY gameId ASC
        `,
        workspaceId,
        channelId
      )
      .toArray()
      .map((row) => ({
        gameId: Number(row.gameId),
        endedAt: Number(row.endedAt),
      }));

    if (hands.length === 0) {
      return {
        channelId,
        hands: [],
        players: [],
      };
    }

    const rows = this.sql
      .exec(
        `
          SELECT facts.gameId, facts.playerId, facts.netChips
          FROM PlayerHandFacts facts
          INNER JOIN PokerGames games
            ON games.workspaceId = facts.workspaceId
            AND games.channelId = facts.channelId
            AND games.gameId = facts.gameId
          WHERE facts.workspaceId = ?
            AND facts.channelId = ?
            AND games.endedAt IS NOT NULL
          ORDER BY facts.gameId ASC, facts.playerId ASC
        `,
        workspaceId,
        channelId
      )
      .toArray();

    const netChipsByGameId = new Map<number, Map<string, number>>();
    const playerIds = new Set<string>();

    rows.forEach((row) => {
      const gameId = Number(row.gameId);
      const playerId = row.playerId as string;
      const netChips = Number(row.netChips);
      playerIds.add(playerId);

      const gameFacts = netChipsByGameId.get(gameId) ?? new Map<string, number>();
      gameFacts.set(playerId, netChips);
      netChipsByGameId.set(gameId, gameFacts);
    });

    const players = Array.from(playerIds).map((playerId) => {
      const series = [0];
      let runningTotal = 0;

      hands.forEach((hand) => {
        const handFacts = netChipsByGameId.get(hand.gameId);
        runningTotal += handFacts?.get(playerId) ?? 0;
        series.push(runningTotal);
      });

      return {
        playerId,
        playerName: userIdToName[playerId as keyof typeof userIdToName] || playerId,
        series,
        finalNetChips: runningTotal,
      };
    });

    return {
      channelId,
      hands,
      players: players
        .sort(
          (a, b) =>
            b.finalNetChips - a.finalNetChips ||
            a.playerId.localeCompare(b.playerId)
        )
        .map(({ finalNetChips: _finalNetChips, ...player }) => player),
    };
  }

  async getPublicPlayerStatsDetail(
    workspaceId: string,
    channelId: string,
    playerId: string
  ): Promise<ChannelPlayerStatsDetailResponse | null> {
    if (!this.channelExists(workspaceId, channelId)) {
      return null;
    }

    const row = this.getPublicPlayerStatsRows(workspaceId, channelId).find(
      (player) => player.playerId === playerId
    );
    if (!row) {
      return null;
    }

    const recentHands = await this.getPublicChannelHands(workspaceId, channelId, {
      limit: 10,
      playerId,
    });

    return {
      ...row,
      recentVisibleHands: recentHands?.data ?? [],
    };
  }

  async resetStatsAndHistory(data: {
    workspaceId: string;
    channelId: string;
    playerId: string;
    messageText: string;
    normalizedText: string;
    handlerKey: string;
    slackMessageTs: string;
    timestamp: number;
  }): Promise<
    | { ok: true; pending: boolean }
    | { ok: false; reason: "no_game" }
  > {
    const channelState = this.loadChannelGameState(
      data.workspaceId,
      data.channelId
    );
    if (!channelState) {
      return { ok: false, reason: "no_game" };
    }

    if (channelState.activeGameId !== null) {
      this.queueChannelReset(
        data.workspaceId,
        data.channelId,
        data.timestamp
      );
      return { ok: true, pending: true };
    }

    this.resetChannelHistoryAndStats(
      data.workspaceId,
      data.channelId,
      JSON.stringify(channelState.game)
    );
    this.clearPendingChannelReset(data.workspaceId, data.channelId);
    return { ok: true, pending: false };
  }

  private finalizeHandIfEnded(
    workspaceId: string,
    channelId: string,
    gameId: number,
    game: TexasHoldem,
    channelState: ChannelGameStateRecord,
    timestamp: number
  ): void {
    const serializedGame = JSON.stringify(game.toJson());

    if (game.getGameState() !== GameState.WaitingForPlayers) {
      this.saveActiveHand(workspaceId, channelId, gameId, serializedGame, null);
      return;
    }

    this.saveActiveHand(
      workspaceId,
      channelId,
      gameId,
      serializedGame,
      timestamp
    );
    this.recordCompletedHandFacts({
      workspaceId,
      channelId,
      gameId,
    });
    this.saveChannelGameState(
      workspaceId,
      channelId,
      serializedGame,
      channelState.nextGameId,
      null
    );
    this.maybeApplyPendingChannelReset(workspaceId, channelId, serializedGame);
  }

  private loadScopedGame(
    workspaceId: string,
    channelId: string
  ): ScopedGameContext | null {
    const channelState = this.loadChannelGameState(workspaceId, channelId);
    if (!channelState) {
      return null;
    }

    if (channelState.activeGameId !== null) {
      const activeGame = this.getPokerGame(
        workspaceId,
        channelId,
        channelState.activeGameId
      );
      if (activeGame) {
        return {
          scope: "active",
          channelState,
          gameId: activeGame.gameId,
          game: TexasHoldem.fromJson(activeGame.game),
        };
      }
    }

    return {
      scope: "channel",
      channelState,
      game: TexasHoldem.fromJson(channelState.game),
    };
  }

  private persistScopedGame(
    workspaceId: string,
    channelId: string,
    scopedGame: ScopedGameContext,
    timestamp: number
  ): void {
    const serializedGame = JSON.stringify(scopedGame.game.toJson());

    if (scopedGame.scope === "active") {
      this.finalizeHandIfEnded(
        workspaceId,
        channelId,
        scopedGame.gameId!,
        scopedGame.game,
        scopedGame.channelState,
        timestamp
      );
      return;
    }

    this.saveChannelGameState(
      workspaceId,
      channelId,
      serializedGame,
      scopedGame.channelState.nextGameId,
      scopedGame.channelState.activeGameId
    );
  }

  async fetchGame(workspaceId: string, channelId: string): Promise<any | null> {
    const activeGame = this.loadActiveGame(workspaceId, channelId);
    if (activeGame) {
      return activeGame.game;
    }

    const channelState = this.loadChannelGameState(workspaceId, channelId);
    return channelState?.game ?? null;
  }

  async newGame(data: {
    workspaceId: string;
    channelId: string;
    playerId: string;
    messageText: string;
    normalizedText: string;
    handlerKey: string;
    slackMessageTs: string;
    timestamp: number;
  }): Promise<{ ok: true } | { ok: false; blockingPlayerId: string }> {
    const channelState = this.loadChannelGameState(
      data.workspaceId,
      data.channelId
    );
    const existing = await this.fetchGame(data.workspaceId, data.channelId);
    if (existing) {
      const game = TexasHoldem.fromJson(existing);
      const allPlayers = [
        ...game.getActivePlayers(),
        ...game.getInactivePlayers(),
      ];
      const blockingPlayer = allPlayers.find(
        (player) => player.getChips() !== 0
      );
      if (blockingPlayer) {
        return { ok: false, blockingPlayerId: blockingPlayer.getId() };
      }
      if (channelState?.activeGameId !== null) {
        const fallbackPlayer = allPlayers[0];
        return {
          ok: false,
          blockingPlayerId: fallbackPlayer?.getId() ?? data.playerId,
        };
      }
    }

    const newGameInstance = new TexasHoldem();
    this.saveChannelGameState(
      data.workspaceId,
      data.channelId,
      JSON.stringify(newGameInstance.toJson()),
      channelState?.nextGameId ?? 1,
      null
    );

    return { ok: true };
  }

  async joinGame(data: {
    workspaceId: string;
    channelId: string;
    playerId: string;
    messageText: string;
    normalizedText: string;
    handlerKey: string;
    slackMessageTs: string;
    timestamp: number;
  }): Promise<
    | { ok: true; game: ReturnType<TexasHoldem["getState"]> }
    | { ok: false; reason: "no_game" }
  > {
    const scopedGame = this.loadScopedGame(data.workspaceId, data.channelId);
    if (!scopedGame) {
      return { ok: false, reason: "no_game" };
    }

    scopedGame.game.addPlayer(data.playerId);
    this.persistScopedGame(
      data.workspaceId,
      data.channelId,
      scopedGame,
      data.timestamp
    );

    return { ok: true, game: scopedGame.game.getState() };
  }

  async buyIn(data: {
    workspaceId: string;
    channelId: string;
    playerId: string;
    messageText: string;
    normalizedText: string;
    handlerKey: string;
    slackMessageTs: string;
    timestamp: number;
    amount: number;
  }): Promise<
    | { ok: true; game: ReturnType<TexasHoldem["getState"]> }
    | { ok: false; reason: "no_game" }
  > {
    const scopedGame = this.loadScopedGame(data.workspaceId, data.channelId);
    if (!scopedGame) {
      return { ok: false, reason: "no_game" };
    }

    scopedGame.game.buyIn(data.playerId, data.amount);
    this.persistScopedGame(
      data.workspaceId,
      data.channelId,
      scopedGame,
      data.timestamp
    );

    return { ok: true, game: scopedGame.game.getState() };
  }

  async setStacks(data: {
    workspaceId: string;
    channelId: string;
    playerId: string;
    messageText: string;
    normalizedText: string;
    handlerKey: string;
    slackMessageTs: string;
    timestamp: number;
    targetAmount: number;
  }): Promise<
    | {
        ok: true;
        game: ReturnType<TexasHoldem["getState"]>;
        adjustments: Array<{
          playerId: string;
          previousChips: number;
          newChips: number;
          difference: number;
        }>;
      }
    | { ok: false; reason: "no_game" | "round_in_progress" }
  > {
    const scopedGame = this.loadScopedGame(data.workspaceId, data.channelId);
    if (!scopedGame) {
      return { ok: false, reason: "no_game" };
    }

    if (scopedGame.game.getGameState() !== GameState.WaitingForPlayers) {
      return { ok: false, reason: "round_in_progress" };
    }

    const adjustments: Array<{
      playerId: string;
      previousChips: number;
      newChips: number;
      difference: number;
    }> = [];

    const allPlayers = [
      ...scopedGame.game.getActivePlayers(),
      ...scopedGame.game.getInactivePlayers(),
    ];

    allPlayers.forEach((player) => {
      const previousChips = player.getChips();
      const difference = previousChips - data.targetAmount;
      player.setChips(data.targetAmount);
      adjustments.push({
        playerId: player.getId(),
        previousChips,
        newChips: data.targetAmount,
        difference,
      });
    });

    this.persistScopedGame(
      data.workspaceId,
      data.channelId,
      scopedGame,
      data.timestamp
    );

    return { ok: true, game: scopedGame.game.getState(), adjustments };
  }

  async fold(data: {
    workspaceId: string;
    channelId: string;
    playerId: string;
    messageText: string;
    normalizedText: string;
    handlerKey: string;
    slackMessageTs: string;
    timestamp: number;
  }): Promise<
    | { ok: true; game: ReturnType<TexasHoldem["getState"]> }
    | { ok: false; reason: "no_game" }
  > {
    const activeGame = this.loadActiveGame(data.workspaceId, data.channelId);
    if (!activeGame) {
      return { ok: false, reason: "no_game" };
    }

    const channelState = this.loadChannelGameState(
      data.workspaceId,
      data.channelId
    )!;
    const game = TexasHoldem.fromJson(activeGame.game);
    game.fold(data.playerId);
    this.finalizeHandIfEnded(
      data.workspaceId,
      data.channelId,
      activeGame.gameId,
      game,
      channelState,
      data.timestamp
    );

    return { ok: true, game: game.getState() };
  }

  async check(data: {
    workspaceId: string;
    channelId: string;
    playerId: string;
    messageText: string;
    normalizedText: string;
    handlerKey: string;
    slackMessageTs: string;
    timestamp: number;
  }): Promise<
    | { ok: true; game: ReturnType<TexasHoldem["getState"]> }
    | { ok: false; reason: "no_game" }
  > {
    const activeGame = this.loadActiveGame(data.workspaceId, data.channelId);
    if (!activeGame) {
      return { ok: false, reason: "no_game" };
    }

    const channelState = this.loadChannelGameState(
      data.workspaceId,
      data.channelId
    )!;
    const game = TexasHoldem.fromJson(activeGame.game);
    game.check(data.playerId);
    this.finalizeHandIfEnded(
      data.workspaceId,
      data.channelId,
      activeGame.gameId,
      game,
      channelState,
      data.timestamp
    );

    return { ok: true, game: game.getState() };
  }

  async call(data: {
    workspaceId: string;
    channelId: string;
    playerId: string;
    messageText: string;
    normalizedText: string;
    handlerKey: string;
    slackMessageTs: string;
    timestamp: number;
  }): Promise<
    | { ok: true; game: ReturnType<TexasHoldem["getState"]> }
    | { ok: false; reason: "no_game" }
  > {
    const activeGame = this.loadActiveGame(data.workspaceId, data.channelId);
    if (!activeGame) {
      return { ok: false, reason: "no_game" };
    }

    const channelState = this.loadChannelGameState(
      data.workspaceId,
      data.channelId
    )!;
    const game = TexasHoldem.fromJson(activeGame.game);
    game.call(data.playerId);
    this.finalizeHandIfEnded(
      data.workspaceId,
      data.channelId,
      activeGame.gameId,
      game,
      channelState,
      data.timestamp
    );

    return { ok: true, game: game.getState() };
  }

  async bet(data: {
    workspaceId: string;
    channelId: string;
    playerId: string;
    messageText: string;
    normalizedText: string;
    handlerKey: string;
    slackMessageTs: string;
    timestamp: number;
    amount: number;
  }): Promise<
    | { ok: true; game: ReturnType<TexasHoldem["getState"]> }
    | { ok: false; reason: "no_game" }
  > {
    const activeGame = this.loadActiveGame(data.workspaceId, data.channelId);
    if (!activeGame) {
      return { ok: false, reason: "no_game" };
    }

    const channelState = this.loadChannelGameState(
      data.workspaceId,
      data.channelId
    )!;
    const game = TexasHoldem.fromJson(activeGame.game);
    game.bet(data.playerId, data.amount);
    this.finalizeHandIfEnded(
      data.workspaceId,
      data.channelId,
      activeGame.gameId,
      game,
      channelState,
      data.timestamp
    );

    return { ok: true, game: game.getState() };
  }

  async allIn(data: {
    workspaceId: string;
    channelId: string;
    playerId: string;
    messageText: string;
    normalizedText: string;
    handlerKey: string;
    slackMessageTs: string;
    timestamp: number;
  }): Promise<
    | { ok: true; game: ReturnType<TexasHoldem["getState"]> }
    | { ok: false; reason: "no_game" }
  > {
    const activeGame = this.loadActiveGame(data.workspaceId, data.channelId);
    if (!activeGame) {
      return { ok: false, reason: "no_game" };
    }

    const channelState = this.loadChannelGameState(
      data.workspaceId,
      data.channelId
    )!;
    const game = TexasHoldem.fromJson(activeGame.game);
    game.allIn(data.playerId);
    this.finalizeHandIfEnded(
      data.workspaceId,
      data.channelId,
      activeGame.gameId,
      game,
      channelState,
      data.timestamp
    );

    return { ok: true, game: game.getState() };
  }

  async startRound(data: {
    workspaceId: string;
    channelId: string;
    playerId: string;
    messageText: string;
    normalizedText: string;
    handlerKey: string;
    slackMessageTs: string;
    timestamp: number;
  }): Promise<
    | {
        ok: true;
        game: ReturnType<TexasHoldem["getState"]>;
        started: boolean;
        gameId: number | null;
      }
    | { ok: false; reason: "no_game" }
  > {
    const existingActiveGame = this.loadActiveGame(
      data.workspaceId,
      data.channelId
    );
    if (existingActiveGame) {
      const channelState = this.loadChannelGameState(
        data.workspaceId,
        data.channelId
      )!;
      const game = TexasHoldem.fromJson(existingActiveGame.game);
      game.startRound(data.playerId);
      this.finalizeHandIfEnded(
        data.workspaceId,
        data.channelId,
        existingActiveGame.gameId,
        game,
        channelState,
        data.timestamp
      );
      return {
        ok: true,
        game: game.getState(),
        started: false,
        gameId: existingActiveGame.gameId,
      };
    }

    const hand = this.createHandFromChannelState(
      data.workspaceId,
      data.channelId
    );
    if (!hand) {
      return { ok: false, reason: "no_game" };
    }

    hand.game.startRound(data.playerId);
    if (hand.game.getGameState() === GameState.WaitingForPlayers) {
      this.saveChannelGameState(
        data.workspaceId,
        data.channelId,
        JSON.stringify(hand.game.toJson()),
        hand.channelState.nextGameId,
        null
      );

      return {
        ok: true,
        game: hand.game.getState(),
        started: false,
        gameId: null,
      };
    }

    this.insertPokerGame(
      data.workspaceId,
      data.channelId,
      hand.gameId,
      JSON.stringify(hand.game.toJson()),
      data.timestamp,
      null
    );
    this.saveChannelGameState(
      data.workspaceId,
      data.channelId,
      JSON.stringify(hand.channelState.game),
      hand.channelState.nextGameId + 1,
      hand.gameId
    );

    return {
      ok: true,
      game: hand.game.getState(),
      started: true,
      gameId: hand.gameId,
    };
  }

  async takeHerToThe(data: {
    workspaceId: string;
    channelId: string;
    playerId: string;
    messageText: string;
    normalizedText: string;
    handlerKey: string;
    slackMessageTs: string;
    timestamp: number;
    targetPhase: "flop" | "turn" | "river";
  }): Promise<
    | { ok: true; game: ReturnType<TexasHoldem["getState"]> }
    | { ok: false; reason: "no_game" | "invalid_state" }
  > {
    const activeGame = this.loadActiveGame(data.workspaceId, data.channelId);
    if (!activeGame) {
      return { ok: false, reason: "no_game" };
    }

    const channelState = this.loadChannelGameState(
      data.workspaceId,
      data.channelId
    )!;
    const game = TexasHoldem.fromJson(activeGame.game);
    const currentState = game.getGameState();

    // Validate game state matches requested phase transition
    if (data.targetPhase === "flop" && currentState !== GameState.PreFlop) {
      return { ok: false, reason: "invalid_state" };
    } else if (data.targetPhase === "turn" && currentState !== GameState.Flop) {
      return { ok: false, reason: "invalid_state" };
    } else if (
      data.targetPhase === "river" &&
      currentState !== GameState.Turn
    ) {
      return { ok: false, reason: "invalid_state" };
    }

    game.callOrCheck(data.playerId);
    this.finalizeHandIfEnded(
      data.workspaceId,
      data.channelId,
      activeGame.gameId,
      game,
      channelState,
      data.timestamp
    );

    return { ok: true, game: game.getState() };
  }

  async thisPotAintBigEnough(data: {
    workspaceId: string;
    channelId: string;
    playerId: string;
    messageText: string;
    normalizedText: string;
    handlerKey: string;
    slackMessageTs: string;
    timestamp: number;
  }): Promise<
    | { ok: true; game: ReturnType<TexasHoldem["getState"]> }
    | { ok: false; reason: "no_game" | "not_river" }
  > {
    const activeGame = this.loadActiveGame(data.workspaceId, data.channelId);
    if (!activeGame) {
      return { ok: false, reason: "no_game" };
    }

    const channelState = this.loadChannelGameState(
      data.workspaceId,
      data.channelId
    )!;
    const game = TexasHoldem.fromJson(activeGame.game);
    const currentState = game.getGameState();

    if (currentState !== GameState.River) {
      return { ok: false, reason: "not_river" };
    }

    game.callOrCheck(data.playerId);
    this.finalizeHandIfEnded(
      data.workspaceId,
      data.channelId,
      activeGame.gameId,
      game,
      channelState,
      data.timestamp
    );

    return { ok: true, game: game.getState() };
  }

  async preDeal(data: {
    workspaceId: string;
    channelId: string;
    playerId: string;
    messageText: string;
    normalizedText: string;
    handlerKey: string;
    slackMessageTs: string;
    timestamp: number;
  }): Promise<
    | {
        ok: true;
        game: ReturnType<TexasHoldem["getState"]>;
        started: boolean;
        gameId: number | null;
      }
    | { ok: false; reason: "no_game" }
  > {
    const activeGame = this.loadActiveGame(data.workspaceId, data.channelId);
    if (!activeGame) {
      const hand = this.createHandFromChannelState(
        data.workspaceId,
        data.channelId
      );
      if (!hand) {
        return { ok: false, reason: "no_game" };
      }

      hand.game.preDeal(data.playerId);
      if (hand.game.getGameState() === GameState.WaitingForPlayers) {
        this.saveChannelGameState(
          data.workspaceId,
          data.channelId,
          JSON.stringify(hand.game.toJson()),
          hand.channelState.nextGameId,
          null
        );

        return {
          ok: true,
          game: hand.game.getState(),
          started: false,
          gameId: null,
        };
      }

      this.insertPokerGame(
        data.workspaceId,
        data.channelId,
        hand.gameId,
        JSON.stringify(hand.game.toJson()),
        data.timestamp,
        null
      );
      this.saveChannelGameState(
        data.workspaceId,
        data.channelId,
        JSON.stringify(hand.channelState.game),
        hand.channelState.nextGameId + 1,
        hand.gameId
      );

      return {
        ok: true,
        game: hand.game.getState(),
        started: true,
        gameId: hand.gameId,
      };
    }

    const channelState = this.loadChannelGameState(
      data.workspaceId,
      data.channelId
    )!;
    const game = TexasHoldem.fromJson(activeGame.game);
    game.preDeal(data.playerId);
    this.finalizeHandIfEnded(
      data.workspaceId,
      data.channelId,
      activeGame.gameId,
      game,
      channelState,
      data.timestamp
    );

    return {
      ok: true,
      game: game.getState(),
      started: false,
      gameId: activeGame.gameId,
    };
  }

  async preNH(data: {
    workspaceId: string;
    channelId: string;
    playerId: string;
    messageText: string;
    normalizedText: string;
    handlerKey: string;
    slackMessageTs: string;
    timestamp: number;
  }): Promise<
    | { ok: true; game: ReturnType<TexasHoldem["getState"]> }
    | { ok: false; reason: "no_game" }
  > {
    const activeGame = this.loadActiveGame(data.workspaceId, data.channelId);
    if (!activeGame) {
      return { ok: false, reason: "no_game" };
    }

    const channelState = this.loadChannelGameState(
      data.workspaceId,
      data.channelId
    )!;
    const game = TexasHoldem.fromJson(activeGame.game);
    game.preNH(data.playerId);
    this.finalizeHandIfEnded(
      data.workspaceId,
      data.channelId,
      activeGame.gameId,
      game,
      channelState,
      data.timestamp
    );

    return { ok: true, game: game.getState() };
  }

  async preAH(data: {
    workspaceId: string;
    channelId: string;
    playerId: string;
    messageText: string;
    normalizedText: string;
    handlerKey: string;
    slackMessageTs: string;
    timestamp: number;
  }): Promise<
    | { ok: true; game: ReturnType<TexasHoldem["getState"]> }
    | { ok: false; reason: "no_game" }
  > {
    const activeGame = this.loadActiveGame(data.workspaceId, data.channelId);
    if (!activeGame) {
      return { ok: false, reason: "no_game" };
    }

    const channelState = this.loadChannelGameState(
      data.workspaceId,
      data.channelId
    )!;
    const game = TexasHoldem.fromJson(activeGame.game);
    game.preAH(data.playerId);
    this.finalizeHandIfEnded(
      data.workspaceId,
      data.channelId,
      activeGame.gameId,
      game,
      channelState,
      data.timestamp
    );

    return { ok: true, game: game.getState() };
  }

  async preCheck(data: {
    workspaceId: string;
    channelId: string;
    playerId: string;
    messageText: string;
    normalizedText: string;
    handlerKey: string;
    slackMessageTs: string;
    timestamp: number;
  }): Promise<
    | { ok: true; game: ReturnType<TexasHoldem["getState"]> }
    | { ok: false; reason: "no_game" }
  > {
    const activeGame = this.loadActiveGame(data.workspaceId, data.channelId);
    if (!activeGame) {
      return { ok: false, reason: "no_game" };
    }

    const channelState = this.loadChannelGameState(
      data.workspaceId,
      data.channelId
    )!;
    const game = TexasHoldem.fromJson(activeGame.game);
    game.preCheck(data.playerId);
    this.finalizeHandIfEnded(
      data.workspaceId,
      data.channelId,
      activeGame.gameId,
      game,
      channelState,
      data.timestamp
    );

    return { ok: true, game: game.getState() };
  }

  async preFold(data: {
    workspaceId: string;
    channelId: string;
    playerId: string;
    messageText: string;
    normalizedText: string;
    handlerKey: string;
    slackMessageTs: string;
    timestamp: number;
  }): Promise<
    | { ok: true; game: ReturnType<TexasHoldem["getState"]> }
    | { ok: false; reason: "no_game" }
  > {
    const activeGame = this.loadActiveGame(data.workspaceId, data.channelId);
    if (!activeGame) {
      return { ok: false, reason: "no_game" };
    }

    const channelState = this.loadChannelGameState(
      data.workspaceId,
      data.channelId
    )!;
    const game = TexasHoldem.fromJson(activeGame.game);
    game.preFold(data.playerId);
    this.finalizeHandIfEnded(
      data.workspaceId,
      data.channelId,
      activeGame.gameId,
      game,
      channelState,
      data.timestamp
    );

    return { ok: true, game: game.getState() };
  }

  async preCall(data: {
    workspaceId: string;
    channelId: string;
    playerId: string;
    messageText: string;
    normalizedText: string;
    handlerKey: string;
    slackMessageTs: string;
    timestamp: number;
  }): Promise<
    | { ok: true; game: ReturnType<TexasHoldem["getState"]> }
    | { ok: false; reason: "no_game" }
  > {
    const activeGame = this.loadActiveGame(data.workspaceId, data.channelId);
    if (!activeGame) {
      return { ok: false, reason: "no_game" };
    }

    const channelState = this.loadChannelGameState(
      data.workspaceId,
      data.channelId
    )!;
    const game = TexasHoldem.fromJson(activeGame.game);
    game.preCall(data.playerId);
    this.finalizeHandIfEnded(
      data.workspaceId,
      data.channelId,
      activeGame.gameId,
      game,
      channelState,
      data.timestamp
    );

    return { ok: true, game: game.getState() };
  }

  async preBet(data: {
    workspaceId: string;
    channelId: string;
    playerId: string;
    messageText: string;
    normalizedText: string;
    handlerKey: string;
    slackMessageTs: string;
    timestamp: number;
    amount: number;
  }): Promise<
    | { ok: true; game: ReturnType<TexasHoldem["getState"]> }
    | { ok: false; reason: "no_game" }
  > {
    const activeGame = this.loadActiveGame(data.workspaceId, data.channelId);
    if (!activeGame) {
      return { ok: false, reason: "no_game" };
    }

    const channelState = this.loadChannelGameState(
      data.workspaceId,
      data.channelId
    )!;
    const game = TexasHoldem.fromJson(activeGame.game);
    game.preBet(data.playerId, data.amount);
    this.finalizeHandIfEnded(
      data.workspaceId,
      data.channelId,
      activeGame.gameId,
      game,
      channelState,
      data.timestamp
    );

    return { ok: true, game: game.getState() };
  }

  async cashOut(data: {
    workspaceId: string;
    channelId: string;
    playerId: string;
    messageText: string;
    normalizedText: string;
    handlerKey: string;
    slackMessageTs: string;
    timestamp: number;
  }): Promise<
    | { ok: true; game: ReturnType<TexasHoldem["getState"]> }
    | { ok: false; reason: "no_game" }
  > {
    const scopedGame = this.loadScopedGame(data.workspaceId, data.channelId);
    if (!scopedGame) {
      return { ok: false, reason: "no_game" };
    }

    scopedGame.game.cashOut(data.playerId);
    this.persistScopedGame(
      data.workspaceId,
      data.channelId,
      scopedGame,
      data.timestamp
    );

    return { ok: true, game: scopedGame.game.getState() };
  }

  async leaveGame(data: {
    workspaceId: string;
    channelId: string;
    playerId: string;
    messageText: string;
    normalizedText: string;
    handlerKey: string;
    slackMessageTs: string;
    timestamp: number;
  }): Promise<
    | { ok: true; game: ReturnType<TexasHoldem["getState"]> }
    | { ok: false; reason: "no_game" }
  > {
    const scopedGame = this.loadScopedGame(data.workspaceId, data.channelId);
    if (!scopedGame) {
      return { ok: false, reason: "no_game" };
    }

    scopedGame.game.removePlayer(data.playerId);
    this.persistScopedGame(
      data.workspaceId,
      data.channelId,
      scopedGame,
      data.timestamp
    );

    return { ok: true, game: scopedGame.game.getState() };
  }

  async deletePlayer(data: {
    workspaceId: string;
    channelId: string;
    requestingPlayerId: string;
    targetPlayerId: string;
    messageText: string;
    normalizedText: string;
    handlerKey: string;
    slackMessageTs: string;
    timestamp: number;
  }): Promise<
    | { ok: true; game: ReturnType<TexasHoldem["getState"]> }
    | { ok: false; reason: "no_game" | "delete_failed"; message?: string }
  > {
    const scopedGame = this.loadScopedGame(data.workspaceId, data.channelId);
    if (!scopedGame) {
      return { ok: false, reason: "no_game" };
    }

    const result = scopedGame.game.deletePlayer(data.targetPlayerId);

    if (result !== "Success") {
      return { ok: false, reason: "delete_failed", message: result };
    }
    this.persistScopedGame(
      data.workspaceId,
      data.channelId,
      scopedGame,
      data.timestamp
    );

    return { ok: true, game: scopedGame.game.getState() };
  }

}

type PostedMessage = typeof isPostedMessageEvent extends (
  arg: any
) => arg is infer R
  ? R
  : never;

function jsonResponse(body: unknown, init?: ResponseInit): Response {
  return new Response(JSON.stringify(body), {
    ...init,
    headers: {
      "content-type": "application/json; charset=utf-8",
      ...(init?.headers ?? {}),
    },
  });
}

function notFoundResponse(message: string): Response {
  return jsonResponse({ error: message }, { status: 404 });
}

function methodNotAllowedResponse(): Response {
  return jsonResponse({ error: "Method not allowed" }, { status: 405 });
}

function badRequestResponse(message: string): Response {
  return jsonResponse({ error: message }, { status: 400 });
}

function getPublicDurableObject(env: Env, channelId: string) {
  const id = env.POKER_DURABLE_OBJECT.idFromName(
    `${PUBLIC_WORKSPACE_ID}-${channelId}`
  );
  return env.POKER_DURABLE_OBJECT.get(id);
}

async function handlePublicApiRequest(
  request: Request,
  env: Env
): Promise<Response> {
  if (request.method !== "GET") {
    return methodNotAllowedResponse();
  }

  const url = new URL(request.url);
  const segments = url.pathname.split("/").filter(Boolean);
  const channelId = segments[2] ? decodeURIComponent(segments[2]) : null;

  if (segments[0] !== "api" || segments[1] !== "channels" || !channelId) {
    return notFoundResponse("Not found");
  }

  const stub = getPublicDurableObject(env, channelId);

  if (segments.length === 3) {
    const summary = await stub.getPublicChannelSummary(
      PUBLIC_WORKSPACE_ID,
      channelId
    );
    if (!summary) {
      return notFoundResponse("Channel not found");
    }
    return jsonResponse({ data: summary } satisfies PublicApiResponse<ChannelSummaryResponse>);
  }

  if (segments[3] === "hands" && segments.length === 4) {
    const limitParam = url.searchParams.get("limit");
    const parsedLimit = limitParam ? Number(limitParam) : undefined;
    const cursorParam = url.searchParams.get("cursor");
    const decodedCursor = decodeCursor(cursorParam);
    if (
      typeof parsedLimit !== "undefined" &&
      (!Number.isFinite(parsedLimit) || parsedLimit < 1)
    ) {
      return badRequestResponse("Invalid limit");
    }
    if (cursorParam && !decodedCursor) {
      return badRequestResponse("Invalid cursor");
    }

    const response = await stub.getPublicChannelHands(
      PUBLIC_WORKSPACE_ID,
      channelId,
      {
        limit: parsedLimit,
        cursor: decodedCursor,
        playerId: url.searchParams.get("playerId"),
      }
    );
    if (!response) {
      return notFoundResponse("Channel not found");
    }
    return jsonResponse(response);
  }

  if (segments[3] === "hands" && segments.length === 5) {
    const gameId = Number(segments[4]);
    if (!Number.isInteger(gameId) || gameId < 1) {
      return badRequestResponse("Invalid gameId");
    }

    const detail = await stub.getPublicHandDetail(
      PUBLIC_WORKSPACE_ID,
      channelId,
      gameId
    );
    if (!detail) {
      return notFoundResponse("Hand not found");
    }
    return jsonResponse({ data: detail });
  }

  if (segments[3] === "all-hands" && segments.length === 4) {
    const limitParam = url.searchParams.get("limit");
    const parsedLimit = limitParam ? Number(limitParam) : undefined;
    const cursorParam = url.searchParams.get("cursor");
    const decodedCursor = decodeCursor(cursorParam);
    if (
      typeof parsedLimit !== "undefined" &&
      (!Number.isFinite(parsedLimit) || parsedLimit < 1)
    ) {
      return badRequestResponse("Invalid limit");
    }
    if (cursorParam && !decodedCursor) {
      return badRequestResponse("Invalid cursor");
    }

    const response = await stub.getPublicChannelHandHistory(
      PUBLIC_WORKSPACE_ID,
      channelId,
      {
        limit: parsedLimit,
        cursor: decodedCursor,
        playerId: url.searchParams.get("playerId"),
      }
    );
    if (!response) {
      return notFoundResponse("Channel not found");
    }
    return jsonResponse(response);
  }

  if (segments[3] === "all-hands" && segments.length === 5) {
    const gameId = Number(segments[4]);
    if (!Number.isInteger(gameId) || gameId < 1) {
      return badRequestResponse("Invalid gameId");
    }

    const detail = await stub.getPublicHandHistoryDetail(
      PUBLIC_WORKSPACE_ID,
      channelId,
      gameId
    );
    if (!detail) {
      return notFoundResponse("Hand not found");
    }
    const body: PublicApiResponse<ChannelHandHistoryDetailResponse> = {
      data: detail,
    };
    return jsonResponse(body);
  }

  if (segments[3] === "players" && segments[4] === "stats" && segments.length === 5) {
    const stats = await stub.getPublicPlayerStats(PUBLIC_WORKSPACE_ID, channelId);
    if (!stats) {
      return notFoundResponse("Channel not found");
    }
    return jsonResponse(stats);
  }

  if (
    segments[3] === "players" &&
    segments[4] === "net-chips-series" &&
    segments.length === 5
  ) {
    const series = await stub.getPublicNetChipsSeries(
      PUBLIC_WORKSPACE_ID,
      channelId
    );
    if (!series) {
      return notFoundResponse("Channel not found");
    }
    const body: PublicApiResponse<ChannelNetChipsSeriesResponse> = {
      data: series,
    };
    return jsonResponse(body);
  }

  if (segments[3] === "players" && segments[5] === "stats" && segments.length === 6) {
    const playerId = decodeURIComponent(segments[4]);
    const stats = await stub.getPublicPlayerStatsDetail(
      PUBLIC_WORKSPACE_ID,
      channelId,
      playerId
    );
    if (!stats) {
      return notFoundResponse("Player not found");
    }
    const body: PublicApiResponse<ChannelPlayerStatsDetailResponse> = {
      data: stats,
    };
    return jsonResponse(body);
  }

  return notFoundResponse("Not found");
}

export default {
  async fetch(
    request: Request,
    env: Env,
    ctx: ExecutionContext
  ): Promise<Response> {
    if (new URL(request.url).pathname.startsWith("/api/")) {
      return handlePublicApiRequest(request, env);
    }

    const app = new SlackApp({ env }).event(
      "message",
      async ({ context, payload }) => {
        if (!isPostedMessageEvent(payload)) {
          return;
        }
        await handleMessage(env, context, payload);
      }
    );
    return await app.run(request, ctx);
  },

  async scheduled(
    _controller: ScheduledController,
    env: Env,
    _ctx: ExecutionContext
  ): Promise<void> {
    await collectHubsClosingPrice(env);
  },
} satisfies ExportedHandler<Env>;

/**
 * Get the global Durable Object for storing closing prices.
 * Uses a fixed ID to ensure all scheduled tasks use the same instance.
 */
function getGlobalDurableObject(env: Env) {
  const id = env.POKER_DURABLE_OBJECT.idFromName("global-stock-prices");
  return env.POKER_DURABLE_OBJECT.get(id);
}

/**
 * Collect and store the HUBS closing price.
 * Called by the scheduled handler at 4:30 PM ET on weekdays (Mon-Fri).
 * Only collects prices from Feb 18, 2026 to March 31, 2026 (not inclusive of April 1).
 */
async function collectHubsClosingPrice(env: Env): Promise<void> {
  const now = new Date();

  // Get date in Eastern Time (America/New_York) format
  const etOptions: Intl.DateTimeFormatOptions = {
    timeZone: "America/New_York",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  };
  const etDateStr = now.toLocaleDateString("en-CA", { ...etOptions }); // en-CA gives YYYY-MM-DD format

  // Check if date is within range: March 18, 2026 to March 31, 2026
  const startDate = "2026-03-18";
  const endDate = "2026-04-01"; // Not inclusive

  if (etDateStr < startDate || etDateStr >= endDate) {
    console.log(
      `Skipping price collection: ${etDateStr} is outside the allowed range`
    );
    return;
  }

  // Fetch the current HUBS stock price
  const result = await fetchStockPrice("HUBS");
  if (!result) {
    console.log(`Failed to fetch HUBS stock price on ${etDateStr}`);
    return;
  }

  // Save to the global Durable Object
  const stub = getGlobalDurableObject(env);
  await stub.saveClosingPrice(etDateStr, "HUBS", result.price);

  console.log(`Saved HUBS closing price: $${result.price} for ${etDateStr}`);
}

const ALGO_MESSAGE =
  "Complaining about the algo? How about you try tightening up ranges, punishing leaks, and owning your position. Cut trash hands, widen late, and 3-bet light when stacks and image align. Always clock SPR, ICM, and blocker dynamics. Dont just run hot—range merge, polarize, and balance frequencies. Table select like a shark, exploit the fish, and never bleed chips OOP. To level up: study solvers, drill GTO, then weaponize exploit when villains deviate.";
const NO_GAME_EXISTS_MESSAGE = ensureNarpBrainOnError(
  "No game exists! Type 'New Game'"
);

const MESSAGE_HANDLERS: Record<string, Function> = {
  "^new game": newGame,
  "^join table": joinGame,
  "^leave table": leaveGame,
  "^buy in": buyIn,
  "^cash out": cashOut,
  "^remove player": removePlayer,
  "^chipnado": showChips,
  "^start round": startRound,
  "^deal": startRound,
  "^roll": rollDice,
  "^keep": keepDice,
  "^score": scoreDice,
  "^fold": fold,
  "^check": check,
  "^call": call,
  "^bet": bet,
  "^all in": allIn,
  "^all-in": allIn,
  "^allin": allIn,
  "^precheck": preCheck,
  "^pre-check": preCheck,
  "^prefold": preFold,
  "^pre-fold": preFold,
  "^precall": preCall,
  "^pre-call": preCall,
  "^prebet": preBet,
  "^pre-bet": preBet,
  "^cards": showCards,
  "^dards": showCards,
  "^reveal dardless": revealCardsCardless,
  "^reveal cardless": revealCardsCardless,
  "^reveal dard": revealSingleCard,
  "^reveal card": revealSingleCard,
  "^reveal": revealCards,
  "^rank": getGameState,
  "^help": help,
  "^deployed": deployed,
  "^poke": nudgePlayer,
  "^silent poke": silentNudgePlayer,
  "^loud poke": loudNudgePlayer,
  "^it'll be a poke for me": nudgePlayer,
  "^it'll be a loud poke for me": loudNudgePlayer,
  "^seppuku": commitSeppuku,
  "^:phone:": call,
  "^chexk": check,
  "^i choose to call": call,
  "^i choose to check": check,
  "^i choose to fold": fold,
  "^i choose to bet": bet,
  "^i choose to all in": allIn,
  "^i choose to all-in": allIn,
  "^i choose to go all in": allIn,
  "^i choose to go all-in": allIn,
  "^i choose to pre-check": preCheck,
  "^i choose to precheck": preCheck,
  "^i choose to pre-fold": preFold,
  "^i choose to prefold": preFold,
  "^i choose to pre-call": preCall,
  "^i choose to precall": preCall,
  "^i choose to pre-bet": preBet,
  "^i choose to prebet": preBet,
  "^i choose to deal": startRound,
  "^i choose to predeal": preDeal,
  "^i choose to pre-deal": preDeal,
  "^i choose to roll": rollDice,
  "^i choose to see my dards": showCards,
  "^i choose to cut my trash hand": fold,
  "^i choose to poke": nudgePlayer,
  "^i choose to loud poke": loudNudgePlayer,
  "^its going to be a call for me": call,
  "^itll be a call for me": call,
  "^its gonna be a call for me": call,
  "^its going to be a precall for me": preCall,
  "^itll be a precall for me": preCall,
  "^its gonna be a precall for me": preCall,
  "^its going to be a precheck for me": preCheck,
  "^itll be a precheck for me": preCheck,
  "^its gonna be a precheck for me": preCheck,
  "^its going to be a prefold for me": preFold,
  "^itll be a prefold for me": preFold,
  "^its gonna be a prefold for me": preFold,
  "^its going to be a check for me": check,
  "^itll be a check for me": check,
  "^its gonna be a check for me": check,
  "^too rich for me": fold,
  "^its going to be a fold for me": fold,
  "^itll be a fold for me": fold,
  "^its gonna be a fold for me": fold,
  "^its going to be a bet": bet,
  "^itll be a bet": bet,
  "^its gonna be a bet": bet,
  "^im gonna go ahead and bet": bet,
  "^im gonna go ahead and check": check,
  "^im gonna go ahead and fold": fold,
  "^im gonna go ahead and precall": preCall,
  "^im gonna go ahead and precheck": preCheck,
  "^im gonna go ahead and prefold": preFold,
  "^im gonna go ahead and prebet": preBet,
  "^im gonna go ahead and donk": bet,
  "^im gonna go ahead and call": call,
  "^im gonna go ahead and all in": allIn,
  "^im gonna go ahead and go all in": allIn,
  "^im gonna go ahead and poke": nudgePlayer,
  "^im gonna go ahead and loud poke": loudNudgePlayer,
  "^drill gto": drillGto,
  "^i choose to drill gto": drillGto,
  "^donk": bet,
  "^i choose to donk": bet,
  "^d$": showCards,
  "^c$": context,
  "^ass$": ass,
  "^cjecl": check,
  "^cbecmk": check,
  "^prenh": preNH,
  "^preah": preAH,
  "^predeal": preDeal,
  "^tsa": preCheck,
  "^flops": showFlops,
  "^fsearch": searchFlops,
  "^context": context,
  "^stacks": showStacks,
  "^stats$": showStats,
  "^set stacks": setStacks,
  "^lets take her to the flop": takeHerToThe,
  "^lets take her to the turn": takeHerToThe,
  "^lets take her to the river": takeHerToThe,
  "^this pot aint big enough for the both of us": thisPotAintBigEnough,
  "^hubs only": enableHubsOnlyMode,
  "^all commands": disableHubsOnlyMode,
  "^hubs": hubsStockPrice,
  "^gyvs": hubsStockPrice,
};

function cleanMessageText(messageText: string) {
  return messageText
    .toLowerCase()
    .replace(/'/g, "")
    .replace(/oh+\s*buddy\s*/g, "")
    .replace(/shi+/g, "")
    .replace(/fu+ck/g, "")
    .replace(/yeah+/g, "")
    .trim();
}

type HandlerMeta = {
  normalizedText: string;
  handlerKey: string;
  slackMessageTs: string;
  messageText: string;
  timestamp: number;
};

type GameEventJson = ReturnType<GameEvent["toJson"]>;

async function handleMessage(
  env: Env,
  context: SlackAppContextWithChannelId,
  payload: PostedMessage
) {
  if (!isPostedMessageEvent(payload)) {
    return;
  }

  // Idempotency check: prevent duplicate message processing
  // Slack can retry message delivery, so we track which messages we've already processed
  const messageTs = payload.ts;
  if (messageTs) {
    const stub = getDurableObject(env, context);
    const isNewMessage = await stub.markMessageProcessed(
      context.teamId!,
      context.channelId,
      messageTs
    );
    if (!isNewMessage) {
      // Message was already processed, skip to prevent duplicate actions
      console.log(`Skipping duplicate message: ${messageTs}`);
      return;
    }

    // Occasionally clean up old entries (1% chance per request)
    if (Math.random() < 0.01) {
      stub.cleanupOldProcessedMessages();
    }
  }

  const messageText = cleanMessageText(payload.text);

  if (messageText.includes("algo")) {
    await context.say({ text: ALGO_MESSAGE });
    return;
  }

  // Check if "hubs only" mode is enabled for this channel
  // When enabled, only allow: stock commands, hubs only, all commands
  const stub = getDurableObject(env, context);
  const hubsOnlyMode = await stub.isHubsOnlyMode(
    context.teamId!,
    context.channelId
  );

  // Commands allowed when in "hubs only" mode
  const HUBS_ONLY_WHITELIST = ["^hubs", "^hubs only", "^all commands", "^gyvs"];

  // Check for $SYMBOL pattern (e.g., $FIG, $HUBS, $GOOG)
  // Stock commands are always allowed, including in "hubs only" mode
  const stockSymbolMatch = messageText.match(/^\$([a-z]{1,5})$/i);
  if (stockSymbolMatch) {
    const symbol = stockSymbolMatch[1].toUpperCase();
    const stockPriceMessage = await getStockPriceMessage(symbol);
    if (stockPriceMessage) {
      let message = stockPriceMessage;

      // Add trailing average for HUBS
      if (symbol === "HUBS") {
        const globalStub = getGlobalDurableObject(env);
        const trailingAvg = await globalStub.getTrailingAverage("HUBS");
        if (trailingAvg) {
          const avgFormatted = trailingAvg.average.toLocaleString("en-US", {
            style: "currency",
            currency: "USD",
          });
          message += `\n:bar_chart: Trailing Avg (${trailingAvg.count} day${trailingAvg.count === 1 ? "" : "s"}): ${avgFormatted}`;
        }
      }

      await context.say({ text: message });
    } else {
      await context.say({
        text: ensureNarpBrainOnError(
          `Unable to fetch ${symbol} stock price at this time.`
        ),
      });
    }
    return;
  }

  // In "hubs only" mode, block non-whitelisted commands early
  // (stock commands handled above are always allowed)

  for (const [key, handler] of Object.entries(MESSAGE_HANDLERS)) {
    if (new RegExp(key).test(messageText)) {
      // Check if we're in "hubs only" mode and this command is not whitelisted
      if (hubsOnlyMode && !HUBS_ONLY_WHITELIST.includes(key)) {
        // Silently ignore non-whitelisted commands
        return;
      }

      const meta: HandlerMeta = {
        normalizedText: messageText,
        handlerKey: key,
        slackMessageTs: payload.ts ?? "",
        messageText: payload.text ?? "",
        timestamp: Date.now(),
      };
      await (handler as any)(env, context, payload, meta);
      return;
    }
  }
}

async function getGameState(
  env: Env,
  context: SlackAppContextWithChannelId,
  _payload: AnyMessageEvent
) {
  const game = await fetchGame(env, context);
  if (!game) {
    await context.say({ text: NO_GAME_EXISTS_MESSAGE });
    return;
  }

  game.getGameStateEvent();
  await sendGameEventMessages(env, context, game);
}

export async function context(
  env: Env,
  context: SlackAppContextWithChannelId,
  _payload: PostedMessage
) {
  const game = await fetchGame(env, context);
  if (!game) {
    await context.client.chat.postEphemeral({
      channel: context.channelId,
      user: context.userId!,
      text: NO_GAME_EXISTS_MESSAGE,
    });
    return;
  }

  // Get game state
  const gameState = game.getGameState();
  let gameStateText = "";
  switch (gameState) {
    case GameState.PreFlop:
      gameStateText = "Pre-Flop";
      break;
    case GameState.Flop:
      gameStateText = "Flop";
      break;
    case GameState.Turn:
      gameStateText = "Turn";
      break;
    case GameState.River:
      gameStateText = "River";
      break;
    case GameState.WaitingForPlayers:
      gameStateText = "Waiting for Players";
      break;
  }

  // Get current pot
  const potSize = game.getCurrentPot();

  // Find the player
  const activePlayers = game.getActivePlayers();
  const inactivePlayers = game.getInactivePlayers();
  const activePlayer = activePlayers.find((p) => p.getId() === context.userId);
  const inactivePlayer = inactivePlayers.find(
    (p) => p.getId() === context.userId
  );

  if (inactivePlayer) {
    await context.client.chat.postEphemeral({
      channel: context.channelId,
      user: context.userId!,
      text: ensureNarpBrainOnError(
        "You are inactive. You are not at the table."
      ),
    });
    return;
  }

  if (!activePlayer) {
    await context.client.chat.postEphemeral({
      channel: context.channelId,
      user: context.userId!,
      text: ensureNarpBrainOnError("You are not in the game!"),
    });
    return;
  }

  const player = activePlayer;

  // Determine if player can check or needs to call
  const currentBetAmount = game.getCurrentBetAmount();
  const playerCurrentBet = player.getCurrentBet();
  const foldedPlayers = game.getFoldedPlayers();
  const hasFolded = foldedPlayers.has(context.userId!);

  let actionText = "";
  if (gameState === GameState.WaitingForPlayers) {
    actionText = "Game has not started yet";
  } else if (hasFolded) {
    actionText = "You have folded";
  } else if (currentBetAmount === 0 || playerCurrentBet >= currentBetAmount) {
    actionText = "You can check";
  } else {
    const amountToCall = currentBetAmount - playerCurrentBet;
    actionText = `You must call ${amountToCall} chips (current bet: ${currentBetAmount})`;
  }

  // Get player's cards and community cards
  const playerCards = game.getPlayerHand(context.userId!);
  const communityCards = game.getCommunityCards();

  // Get turn information
  const currentPlayer = game.getCurrentPlayer();
  let turnText = "";
  if (gameState === GameState.WaitingForPlayers) {
    turnText = "No active round";
  } else if (currentPlayer && currentPlayer.getId() === context.userId) {
    turnText = ":rotating_light: It's your turn :rotating_light:";
  } else if (currentPlayer) {
    turnText = `It's <@${currentPlayer.getId()}>'s turn`;
  } else {
    turnText = "No current player";
  }

  // Build the message
  let message = `*Game Context*\n\n`;
  message += `*Game State:* ${gameStateText}\n`;
  message += `*Pot Size:* ${potSize} chips\n`;
  message += `*Turn:* ${turnText}\n`;
  message += `*Action:* ${actionText}\n\n`;

  // Add player list in table order (starting from dealer)
  const playersInOrder = game.getPlayersInTableOrder();
  if (playersInOrder.length > 0) {
    message += `*Players (table order):*\n`;
    for (const p of playersInOrder) {
      // Get player display name (use mapping or fall back to Slack mention)
      const displayName =
        userIdToName[p.playerId as keyof typeof userIdToName] ||
        `<@${p.playerId}>`;

      // Get chip count for this player
      const playerObj = activePlayers.find((ap) => ap.getId() === p.playerId);
      const chipCount = playerObj ? playerObj.getChips() : 0;

      let line = `*${displayName}*`;
      // Add chip count
      line += ` [${chipCount}]`;
      // Add position label if present
      if (p.positionLabel) {
        line += ` (${p.positionLabel})`;
      }
      // Add last action and state
      if (p.lastAction) {
        line += ` - ${p.lastAction}`;
      }
      if (p.isAllIn) {
        line += " *:rotating_light: ALL-IN :rotating_light:*";
      }
      // Add turn indicator on the right
      if (p.isCurrentTurn) {
        line += " ⬅️";
      }
      message += `${line}\n`;
    }
    message += "\n";

    // Add non-folded players section
    const nonFoldedPlayers = game.getNonFoldedPlayersInOrder();
    if (
      nonFoldedPlayers.length > 0 &&
      nonFoldedPlayers.length < playersInOrder.length
    ) {
      const nonFoldedNames = nonFoldedPlayers.map(
        (id) =>
          `*${userIdToName[id as keyof typeof userIdToName] || `<@${id}>`}*`
      );
      message += `*Still in hand:* ${nonFoldedNames.join(", ")}\n\n`;
    }
  }

  if (playerCards && playerCards.length > 0) {
    // Calculate hand description if there are community cards
    let handDescription = "";
    if (communityCards && communityCards.length > 0) {
      const cardStrings = [...communityCards, ...playerCards].map((card) => {
        const rank = card.getRank() === "10" ? "T" : card.getRank().charAt(0);
        const suit = card.getSuit().charAt(0).toLowerCase();
        return `${rank}${suit}`;
      });
      handDescription = rankDescription[rankCards(cardStrings)];
      if (handDescription == "High Card") {
        handDescription = "Ass";
      }
    }

    if (handDescription) {
      message += `*You have ${handDescription}:*\n`;
    } else {
      message += `*Your Cards:*\n`;
    }
    message += `${playerCards.map((card) => card.toSlackString()).join(" ")}\n\n`;
  } else {
    message += `*Your Cards:* No cards yet\n\n`;
  }

  if (communityCards && communityCards.length > 0) {
    message += `*Community Cards:*\n`;
    message += `${communityCards.map((card) => card.toSlackString()).join(" ")}\n`;
  } else {
    message += `*Community Cards:* None yet`;
  }

  await context.client.chat.postEphemeral({
    channel: context.channelId,
    user: context.userId!,
    text: message,
  });
}

async function searchFlops(
  env: Env,
  context: SlackAppContextWithChannelId,
  payload: PostedMessage
) {
  const workspaceId = context.teamId!;
  const channelId = context.channelId;
  const stub = getDurableObject(env, context);

  const flopSearchQuery = payload.text
    .toLowerCase()
    .replace("fsearch", "")
    .trim();

  let message = "";

  const flops = await stub.searchFlops(workspaceId, channelId, flopSearchQuery);

  for (const flop of flops) {
    message += formatFlop(flop);
  }

  await context.say({ text: message });
}

async function showFlops(
  env: Env,
  context: SlackAppContextWithChannelId,
  _payload: PostedMessage
) {
  const workspaceId = context.teamId!;
  const channelId = context.channelId;
  const stub = getDurableObject(env, context);

  const flops = await stub.getFlops(workspaceId, channelId);

  let message = "";

  for (const flop of flops) {
    message += formatFlop(flop);

    // const date = new Date(flop.createdAt).toLocaleDateString('en-US', {
    // 	year: 'numeric',
    // 	month: '2-digit',
    // 	day: '2-digit',
    // });
    // message += `${flop.flop.replace(/[dhsc]/g, (match: any) => {
    // 	switch (match) {
    // 		case 'd':
    // 			return ':diamonds:';
    // 		case 'h':
    // 			return ':hearts:';
    // 		case 's':
    // 			return ':spades:';
    // 		case 'c':
    // 			return ':clubs:';
    // 		default:
    // 			return match;
    // 	}
    // })} on ${date}\n`;
  }

  await context.say({ text: message });
}

async function ass(
  _env: Env,
  context: SlackAppContextWithChannelId,
  _payload: PostedMessage
) {
  await context.say({ text: "ASS" });
}

async function drillGto(
  _env: Env,
  context: SlackAppContextWithChannelId,
  _payload: PostedMessage
) {
  await context.say({
    text: `<@${context.userId}> is drilling GTO! :drill-gto:`,
  });
}

async function hubsStockPrice(
  env: Env,
  context: SlackAppContextWithChannelId,
  _payload: PostedMessage
) {
  const stockPriceMessage = await getHubsStockPriceMessage();
  if (stockPriceMessage) {
    // Get the trailing average from the global Durable Object
    const stub = getGlobalDurableObject(env);
    const trailingAvg = await stub.getTrailingAverage("HUBS");

    let message = stockPriceMessage;
    if (trailingAvg) {
      const avgFormatted = trailingAvg.average.toLocaleString("en-US", {
        style: "currency",
        currency: "USD",
      });
      message += `\n:bar_chart: Trailing Avg (${trailingAvg.count} day${trailingAvg.count === 1 ? "" : "s"}): ${avgFormatted}`;
    }

    await context.say({ text: message });
  } else {
    await context.say({
      text: ensureNarpBrainOnError(
        "Unable to fetch HUBS stock price at this time."
      ),
    });
  }
}

export async function enableHubsOnlyMode(
  env: Env,
  context: SlackAppContextWithChannelId,
  _payload: PostedMessage
) {
  const stub = getDurableObject(env, context);
  await stub.setHubsOnlyMode(context.teamId!, context.channelId, true);
  await context.say({
    text: ":lock: HUBS only mode enabled for this channel. Only the HUBS command will work until 'all commands' is typed.",
  });
}

export async function disableHubsOnlyMode(
  env: Env,
  context: SlackAppContextWithChannelId,
  _payload: PostedMessage
) {
  const stub = getDurableObject(env, context);
  await stub.setHubsOnlyMode(context.teamId!, context.channelId, false);
  await context.say({
    text: ":unlock: All commands are now enabled for this channel.",
  });
}

export async function nudgePlayer(
  env: Env,
  context: SlackAppContextWithChannelId,
  _payload: PostedMessage
) {
  const game = await fetchGame(env, context);
  if (!game) {
    await context.say({ text: NO_GAME_EXISTS_MESSAGE });
    return;
  }

  if (game.getGameState() === GameState.WaitingForPlayers) {
    await context.say({
      text: ensureNarpBrainOnError(
        "Game has not started yet! Who the hell am I going to nudge?"
      ),
    });
    return;
  }

  const currentPlayer = game.getCurrentPlayer();
  if (!currentPlayer) {
    await context.say({
      text: ensureNarpBrainOnError(
        "No current player which means the code is ASS"
      ),
    });
    return;
  }

  // Check if user is poking themselves
  const isSelfPoke = context.userId === currentPlayer.getId();
  const selfPokePrefix = isSelfPoke ? ":narp-brain: " : "";

  await context.say({
    text: `${selfPokePrefix}<@${currentPlayer.getId()}> it's your turn and you need to roll!`,
  });
}

export async function silentNudgePlayer(
  env: Env,
  context: SlackAppContextWithChannelId,
  _payload: PostedMessage
) {
  const game = await fetchGame(env, context);
  if (!game) {
    await context.say({ text: NO_GAME_EXISTS_MESSAGE });
    return;
  }

  if (game.getGameState() === GameState.WaitingForPlayers) {
    await context.say({
      text: ensureNarpBrainOnError(
        "Game has not started yet! Who the hell am I going to nudge?"
      ),
    });
    return;
  }

  const currentPlayer = game.getCurrentPlayer();
  if (!currentPlayer) {
    await context.say({
      text: ensureNarpBrainOnError(
        "No current player which means the code is ASS"
      ),
    });
    return;
  }

  // Get display name without tagging - very very quietly
  const playerId = currentPlayer.getId();
  const displayName =
    userIdToName[playerId as keyof typeof userIdToName] || playerId;

  // Check if user is poking themselves
  const isSelfPoke = context.userId === playerId;
  const selfPokePrefix = isSelfPoke ? ":narp-brain: " : "";

  await context.say({
    text: `${selfPokePrefix}^*${displayName.toLowerCase()}*^ ... ᶦᵗ'ˢ ʸᵒᵘʳ ᵗᵘʳⁿ`,
  });
}

export async function loudNudgePlayer(
  env: Env,
  context: SlackAppContextWithChannelId,
  _payload: PostedMessage
) {
  const game = await fetchGame(env, context);
  if (!game) {
    await context.say({ text: NO_GAME_EXISTS_MESSAGE });
    return;
  }

  if (game.getGameState() === GameState.WaitingForPlayers) {
    await context.say({
      text: ensureNarpBrainOnError(
        ":rotating_light::rotating_light::rotating_light: GAME HAS NOT STARTED YET! WHO THE HELL AM I GOING TO NUDGE?! :rotating_light::rotating_light::rotating_light:"
      ),
    });
    return;
  }

  const currentPlayer = game.getCurrentPlayer();
  if (!currentPlayer) {
    await context.say({
      text: ensureNarpBrainOnError(
        ":rotating_light::rotating_light::rotating_light: NO CURRENT PLAYER WHICH MEANS THE CODE IS ASS :rotating_light::rotating_light::rotating_light:"
      ),
    });
    return;
  }

  // Check if user is poking themselves
  const isSelfPoke = context.userId === currentPlayer.getId();
  const selfPokePrefix = isSelfPoke ? ":narp-brain: " : "";

  await context.say({
    text: `${selfPokePrefix}:rotating_light::rotating_light::rotating_light: <@${currentPlayer.getId()}> :rotating_light::rotating_light::rotating_light:\n:mega::mega::mega: *IT'S YOUR TURN AND YOU NEED TO ROLL RIGHT NOW!!!* :mega::mega::mega:\n:alarm_clock: HELLO??? WE'RE ALL WAITING!!! :alarm_clock:`,
  });
}

async function commitSeppuku(
  _env: Env,
  context: SlackAppContextWithChannelId,
  _payload: PostedMessage
) {
  await context.say({ text: `Hai` });
}

async function scoreDice(
  _env: Env,
  context: SlackAppContextWithChannelId,
  payload: PostedMessage
) {
  const messageText = payload.text.toLowerCase();
  const scored = messageText.replace("score", "").trim();
  await context.say({ text: `Scored: ${scored}` });
}

async function keepDice(
  env: Env,
  context: SlackAppContextWithChannelId,
  payload: PostedMessage
) {
  const messageText = payload.text.toLowerCase();
  const numbersToKeep = Array.from(messageText.replace("keep", "").trim())
    .map(Number)
    .filter((n) => !isNaN(n));
  await rollDice(env, context, payload, numbersToKeep);
}

async function rollDice(
  _env: Env,
  context: SlackAppContextWithChannelId,
  _payload: PostedMessage,
  keepDice: number[] = []
) {
  const diceRolls = [
    ...keepDice,
    ...Array.from(
      { length: 5 - keepDice.length },
      () => Math.floor(Math.random() * 6) + 1
    ),
  ];
  diceRolls.sort((a, b) => a - b);
  await context.say({ text: `Here are some dice: *${diceRolls.join(" ")}*` });
}

async function help(
  _env: Env,
  context: SlackAppContextWithChannelId,
  _payload: PostedMessage
) {
  const commands = Object.keys(MESSAGE_HANDLERS).join("\n");
  await context.say({
    text: `Available commands:\n${commands
      .split("\n")
      .map((cmd) => `\`${cmd}\``)
      .join("\n")}`,
  });
}

function formatRelativeDeploymentTime(timestamp: string): string | null {
  const deployedAt = new Date(timestamp);
  if (Number.isNaN(deployedAt.getTime())) {
    return null;
  }

  const elapsedSeconds = Math.max(
    0,
    Math.floor((Date.now() - deployedAt.getTime()) / 1000)
  );

  if (elapsedSeconds < 60) {
    return `${elapsedSeconds} ${elapsedSeconds === 1 ? "second" : "seconds"} ago`;
  }

  const elapsedMinutes = Math.floor(elapsedSeconds / 60);
  if (elapsedMinutes < 60) {
    return `${elapsedMinutes} ${elapsedMinutes === 1 ? "minute" : "minutes"} ago`;
  }

  const elapsedHours = Math.floor(elapsedMinutes / 60);
  if (elapsedHours < 24) {
    return `${elapsedHours} ${elapsedHours === 1 ? "hour" : "hours"} ago`;
  }

  const elapsedDays = Math.floor(elapsedHours / 24);
  return `${elapsedDays} ${elapsedDays === 1 ? "day" : "days"} ago`;
}

export async function deployed(
  env: Env,
  context: SlackAppContextWithChannelId,
  _payload: PostedMessage
) {
  const relativeDeploymentTime = env.CF_VERSION_METADATA?.timestamp
    ? formatRelativeDeploymentTime(env.CF_VERSION_METADATA.timestamp)
    : null;

  await context.say({
    text: relativeDeploymentTime
      ? `Worker deployed: ${relativeDeploymentTime}`
      : "Worker deployment time is unavailable.",
  });
}

function parseRevealSingleCardIndex(messageText: string): 0 | 1 | null {
  const normalizedText = cleanMessageText(messageText);
  const match = normalizedText.match(
    /^reveal\s+(?:dard|card)s?\s*\{?\s*([12])\s*\}?$/
  );
  if (!match) {
    return null;
  }
  return match[1] === "1" ? 0 : 1;
}

export async function revealSingleCard(
  env: Env,
  context: SlackAppContextWithChannelId,
  payload: PostedMessage
) {
  const game = await fetchGame(env, context);
  if (!game) {
    await context.say({ text: NO_GAME_EXISTS_MESSAGE });
    return;
  }
  if (game.getGameState() !== GameState.WaitingForPlayers) {
    await context.say({
      text: `<@${context.userId}> :narp-brain: Nice try bud`,
    });
    return;
  }

  const selectedCardIndex = parseRevealSingleCardIndex(payload.text ?? "");
  if (selectedCardIndex === null) {
    await context.say({
      text: ensureNarpBrainOnError(
        "Invalid format! Use 'reveal dard 1' or 'reveal dard 2'"
      ),
    });
    return;
  }

  game.showCards(context.userId!, true, true, true, selectedCardIndex);
  await sendGameEventMessages(env, context, game);
}

export async function revealCards(
  env: Env,
  context: SlackAppContextWithChannelId,
  _payload: PostedMessage
) {
  const game = await fetchGame(env, context);
  if (!game) {
    await context.say({ text: NO_GAME_EXISTS_MESSAGE });
    return;
  }
  if (game.getGameState() !== GameState.WaitingForPlayers) {
    await context.say({
      text: `<@${context.userId}> :narp-brain: Nice try bud`,
    });
    return;
  }

  game.showCards(context.userId!, true);
  await sendGameEventMessages(env, context, game);
}

export async function revealCardsCardless(
  env: Env,
  context: SlackAppContextWithChannelId,
  _payload: PostedMessage
) {
  const game = await fetchGame(env, context);
  if (!game) {
    await context.say({ text: NO_GAME_EXISTS_MESSAGE });
    return;
  }
  if (game.getGameState() !== GameState.WaitingForPlayers) {
    await context.say({
      text: `<@${context.userId}> :narp-brain: Nice try bud`,
    });
    return;
  }

  // Reveal hand description only, without showing the actual cards
  game.showCards(context.userId!, true, true, false);
  await sendGameEventMessages(env, context, game);
}

export async function showCards(
  env: Env,
  context: SlackAppContextWithChannelId,
  _payload: PostedMessage
) {
  const game = await fetchGame(env, context);
  if (!game) {
    await context.say({ text: NO_GAME_EXISTS_MESSAGE });
    return;
  }

  game.showCards(context.userId!, false);
  await sendGameEventMessages(env, context, game);
}

// async function fixTheGame(env, context, payload) {
// 	const game = await fetchGame(env, context);
// 	if (!game) {
// 		await context.say({ text: `No game exists! Type 'New Game'` });
// 		return;
// 	}
// 	await context.say({ text: `Fixing the game...` });
// 	game.fixTheGame();
// 	await context.say({ text: `Finished fixing the game...` });
// 	saveGame(env, context, game);
// 	await sendGameEventMessages(context, game);
// }

export async function preDeal(
  env: Env,
  context: SlackAppContextWithChannelId,
  payload: PostedMessage,
  meta?: HandlerMeta
) {
  const stub = getDurableObject(env, context);
  const rawMessageText = meta?.messageText ?? payload.text ?? "";
  const normalizedText =
    meta?.normalizedText ?? cleanMessageText(rawMessageText);
  const handlerKey = meta?.handlerKey ?? "preDeal";
  const slackMessageTs = meta?.slackMessageTs ?? payload.ts ?? "";
  const timestamp = meta?.timestamp ?? Date.now();

  const result = await stub.preDeal({
    workspaceId: context.teamId!,
    channelId: context.channelId,
    playerId: context.userId!,
    messageText: rawMessageText,
    normalizedText,
    handlerKey,
    slackMessageTs,
    timestamp,
  });

  if (!result.ok) {
    await context.say({ text: NO_GAME_EXISTS_MESSAGE });
    return;
  }

  await sendGameStateMessages(env, context, result.game);
}

export async function preNH(
  env: Env,
  context: SlackAppContextWithChannelId,
  payload: PostedMessage,
  meta?: HandlerMeta
) {
  const stub = getDurableObject(env, context);
  const rawMessageText = meta?.messageText ?? payload.text ?? "";
  const normalizedText =
    meta?.normalizedText ?? cleanMessageText(rawMessageText);
  const handlerKey = meta?.handlerKey ?? "preNH";
  const slackMessageTs = meta?.slackMessageTs ?? payload.ts ?? "";
  const timestamp = meta?.timestamp ?? Date.now();

  const result = await stub.preNH({
    workspaceId: context.teamId!,
    channelId: context.channelId,
    playerId: context.userId!,
    messageText: rawMessageText,
    normalizedText,
    handlerKey,
    slackMessageTs,
    timestamp,
  });

  if (!result.ok) {
    await context.say({ text: NO_GAME_EXISTS_MESSAGE });
    return;
  }

  await sendGameStateMessages(env, context, result.game);
}

export async function preAH(
  env: Env,
  context: SlackAppContextWithChannelId,
  payload: PostedMessage,
  meta?: HandlerMeta
) {
  const stub = getDurableObject(env, context);
  const rawMessageText = meta?.messageText ?? payload.text ?? "";
  const normalizedText =
    meta?.normalizedText ?? cleanMessageText(rawMessageText);
  const handlerKey = meta?.handlerKey ?? "preAH";
  const slackMessageTs = meta?.slackMessageTs ?? payload.ts ?? "";
  const timestamp = meta?.timestamp ?? Date.now();

  const result = await stub.preAH({
    workspaceId: context.teamId!,
    channelId: context.channelId,
    playerId: context.userId!,
    messageText: rawMessageText,
    normalizedText,
    handlerKey,
    slackMessageTs,
    timestamp,
  });

  if (!result.ok) {
    await context.say({ text: NO_GAME_EXISTS_MESSAGE });
    return;
  }

  await sendGameStateMessages(env, context, result.game);
}

export async function preCheck(
  env: Env,
  context: SlackAppContextWithChannelId,
  payload: PostedMessage,
  meta?: HandlerMeta
) {
  const stub = getDurableObject(env, context);
  const rawMessageText = meta?.messageText ?? payload.text ?? "";
  const normalizedText =
    meta?.normalizedText ?? cleanMessageText(rawMessageText);
  const handlerKey = meta?.handlerKey ?? "preCheck";
  const slackMessageTs = meta?.slackMessageTs ?? payload.ts ?? "";
  const timestamp = meta?.timestamp ?? Date.now();

  const result = await stub.preCheck({
    workspaceId: context.teamId!,
    channelId: context.channelId,
    playerId: context.userId!,
    messageText: rawMessageText,
    normalizedText,
    handlerKey,
    slackMessageTs,
    timestamp,
  });

  if (!result.ok) {
    await context.say({ text: NO_GAME_EXISTS_MESSAGE });
    return;
  }

  await sendGameStateMessages(env, context, result.game);
}

export async function preFold(
  env: Env,
  context: SlackAppContextWithChannelId,
  payload: PostedMessage,
  meta?: HandlerMeta
) {
  const stub = getDurableObject(env, context);
  const rawMessageText = meta?.messageText ?? payload.text ?? "";
  const normalizedText =
    meta?.normalizedText ?? cleanMessageText(rawMessageText);
  const handlerKey = meta?.handlerKey ?? "preFold";
  const slackMessageTs = meta?.slackMessageTs ?? payload.ts ?? "";
  const timestamp = meta?.timestamp ?? Date.now();

  const result = await stub.preFold({
    workspaceId: context.teamId!,
    channelId: context.channelId,
    playerId: context.userId!,
    messageText: rawMessageText,
    normalizedText,
    handlerKey,
    slackMessageTs,
    timestamp,
  });

  if (!result.ok) {
    await context.say({ text: NO_GAME_EXISTS_MESSAGE });
    return;
  }

  await sendGameStateMessages(env, context, result.game);
}

export async function preCall(
  env: Env,
  context: SlackAppContextWithChannelId,
  payload: PostedMessage,
  meta?: HandlerMeta
) {
  const stub = getDurableObject(env, context);
  const rawMessageText = meta?.messageText ?? payload.text ?? "";
  const normalizedText =
    meta?.normalizedText ?? cleanMessageText(rawMessageText);
  const handlerKey = meta?.handlerKey ?? "preCall";
  const slackMessageTs = meta?.slackMessageTs ?? payload.ts ?? "";
  const timestamp = meta?.timestamp ?? Date.now();

  const result = await stub.preCall({
    workspaceId: context.teamId!,
    channelId: context.channelId,
    playerId: context.userId!,
    messageText: rawMessageText,
    normalizedText,
    handlerKey,
    slackMessageTs,
    timestamp,
  });

  if (!result.ok) {
    await context.say({ text: NO_GAME_EXISTS_MESSAGE });
    return;
  }

  await sendGameStateMessages(env, context, result.game);
}

export async function preBet(
  env: Env,
  context: SlackAppContextWithChannelId,
  payload: PostedMessage,
  meta?: HandlerMeta
) {
  const rawMessageText = meta?.messageText ?? payload.text ?? "";
  const messageText = rawMessageText.toLowerCase();
  const betAmount = parseFloat(
    messageText
      .replace("i choose to", "")
      .replace("bet", "")
      .replace("pre", "")
      .replace("-", "")
      .trim()
  );

  if (isNaN(betAmount) || betAmount <= 0) {
    await context.say({
      text: ensureNarpBrainOnError(
        'Invalid bet amount! Please use format: "pre-bet {chips}"'
      ),
    });
    return;
  }

  const stub = getDurableObject(env, context);
  const normalizedText =
    meta?.normalizedText ?? cleanMessageText(rawMessageText);
  const handlerKey = meta?.handlerKey ?? "preBet";
  const slackMessageTs = meta?.slackMessageTs ?? payload.ts ?? "";
  const timestamp = meta?.timestamp ?? Date.now();

  const result = await stub.preBet({
    workspaceId: context.teamId!,
    channelId: context.channelId,
    playerId: context.userId!,
    messageText: rawMessageText,
    normalizedText,
    handlerKey,
    slackMessageTs,
    timestamp,
    amount: betAmount,
  });

  if (!result.ok) {
    await context.say({ text: NO_GAME_EXISTS_MESSAGE });
    return;
  }

  await sendGameStateMessages(env, context, result.game);
}

export async function bet(
  env: Env,
  context: SlackAppContextWithChannelId,
  payload: PostedMessage,
  meta?: HandlerMeta
) {
  const messageText = cleanMessageText(payload.text);
  const betAmount = parseFloat(
    messageText
      .replace("i choose to", "")
      .replace("im gonna go ahead and", "")
      .replace("its going to be a", "")
      .replace("itll be a", "")
      .replace("its gonna be a", "")
      .replace("bet", "")
      .replace("donk", "")
      .replace("for me", "")
      .replace("from me", "")
      .trim()
  );

  if (isNaN(betAmount) || betAmount <= 0) {
    await context.say({
      text: ensureNarpBrainOnError(
        'Invalid bet amount! Please use format: "bet {chips}"'
      ),
    });
    return;
  }

  const stub = getDurableObject(env, context);
  const rawMessageText = meta?.messageText ?? payload.text ?? "";
  const normalizedText =
    meta?.normalizedText ?? cleanMessageText(rawMessageText);
  const handlerKey = meta?.handlerKey ?? "bet";
  const slackMessageTs = meta?.slackMessageTs ?? payload.ts ?? "";
  const timestamp = meta?.timestamp ?? Date.now();

  const result = await stub.bet({
    workspaceId: context.teamId!,
    channelId: context.channelId,
    playerId: context.userId!,
    messageText: rawMessageText,
    normalizedText,
    handlerKey,
    slackMessageTs,
    timestamp,
    amount: betAmount,
  });

  if (!result.ok) {
    await context.say({ text: NO_GAME_EXISTS_MESSAGE });
    return;
  }

  await sendGameStateMessages(env, context, result.game);
}

export async function call(
  env: Env,
  context: SlackAppContextWithChannelId,
  payload: PostedMessage,
  meta?: HandlerMeta
) {
  const stub = getDurableObject(env, context);
  const rawMessageText = meta?.messageText ?? payload.text ?? "";
  const normalizedText =
    meta?.normalizedText ?? cleanMessageText(rawMessageText);
  const handlerKey = meta?.handlerKey ?? "call";
  const slackMessageTs = meta?.slackMessageTs ?? payload.ts ?? "";
  const timestamp = meta?.timestamp ?? Date.now();

  const result = await stub.call({
    workspaceId: context.teamId!,
    channelId: context.channelId,
    playerId: context.userId!,
    messageText: rawMessageText,
    normalizedText,
    handlerKey,
    slackMessageTs,
    timestamp,
  });

  if (!result.ok) {
    await context.say({ text: NO_GAME_EXISTS_MESSAGE });
    return;
  }

  await sendGameStateMessages(env, context, result.game);
}

export async function allIn(
  env: Env,
  context: SlackAppContextWithChannelId,
  payload: PostedMessage,
  meta?: HandlerMeta
) {
  const stub = getDurableObject(env, context);
  const rawMessageText = meta?.messageText ?? payload.text ?? "";
  const normalizedText =
    meta?.normalizedText ?? cleanMessageText(rawMessageText);
  const handlerKey = meta?.handlerKey ?? "all in";
  const slackMessageTs = meta?.slackMessageTs ?? payload.ts ?? "";
  const timestamp = meta?.timestamp ?? Date.now();

  const result = await stub.allIn({
    workspaceId: context.teamId!,
    channelId: context.channelId,
    playerId: context.userId!,
    messageText: rawMessageText,
    normalizedText,
    handlerKey,
    slackMessageTs,
    timestamp,
  });

  if (!result.ok) {
    await context.say({ text: NO_GAME_EXISTS_MESSAGE });
    return;
  }

  await sendGameStateMessages(env, context, result.game);
}

export async function check(
  env: Env,
  context: SlackAppContextWithChannelId,
  payload: PostedMessage,
  meta?: HandlerMeta
) {
  const stub = getDurableObject(env, context);
  const rawMessageText = meta?.messageText ?? payload.text ?? "";
  const normalizedText =
    meta?.normalizedText ?? cleanMessageText(rawMessageText);
  const handlerKey = meta?.handlerKey ?? "check";
  const slackMessageTs = meta?.slackMessageTs ?? payload.ts ?? "";
  const timestamp = meta?.timestamp ?? Date.now();

  const result = await stub.check({
    workspaceId: context.teamId!,
    channelId: context.channelId,
    playerId: context.userId!,
    messageText: rawMessageText,
    normalizedText,
    handlerKey,
    slackMessageTs,
    timestamp,
  });

  if (!result.ok) {
    await context.say({ text: NO_GAME_EXISTS_MESSAGE });
    return;
  }

  await sendGameStateMessages(env, context, result.game);
}

export async function thisPotAintBigEnough(
  env: Env,
  context: SlackAppContextWithChannelId,
  payload: PostedMessage,
  meta?: HandlerMeta
) {
  const stub = getDurableObject(env, context);
  const rawMessageText = meta?.messageText ?? payload.text ?? "";
  const normalizedText =
    meta?.normalizedText ?? cleanMessageText(rawMessageText);
  const handlerKey = meta?.handlerKey ?? "thisPotAintBigEnough";
  const slackMessageTs = meta?.slackMessageTs ?? payload.ts ?? "";
  const timestamp = meta?.timestamp ?? Date.now();

  const result = await stub.thisPotAintBigEnough({
    workspaceId: context.teamId!,
    channelId: context.channelId,
    playerId: context.userId!,
    messageText: rawMessageText,
    normalizedText,
    handlerKey,
    slackMessageTs,
    timestamp,
  });

  if (!result.ok) {
    if (result.reason === "not_river") {
      await context.say({
        text: "This command can only be used on the River, partner.",
      });
      return;
    }
    await context.say({ text: NO_GAME_EXISTS_MESSAGE });
    return;
  }

  await sendGameStateMessages(env, context, result.game);
}

export async function takeHerToThe(
  env: Env,
  context: SlackAppContextWithChannelId,
  payload: PostedMessage,
  meta?: HandlerMeta
) {
  const stub = getDurableObject(env, context);
  const rawMessageText = meta?.messageText ?? payload.text ?? "";
  const normalizedText =
    meta?.normalizedText ?? cleanMessageText(rawMessageText);
  const handlerKey = meta?.handlerKey ?? "takeHerToThe";
  const slackMessageTs = meta?.slackMessageTs ?? payload.ts ?? "";
  const timestamp = meta?.timestamp ?? Date.now();

  // Determine target phase from message
  let targetPhase: "flop" | "turn" | "river";
  if (normalizedText.startsWith("lets take her to the flop")) {
    targetPhase = "flop";
  } else if (normalizedText.startsWith("lets take her to the turn")) {
    targetPhase = "turn";
  } else if (normalizedText.startsWith("lets take her to the river")) {
    targetPhase = "river";
  } else {
    return;
  }

  const result = await stub.takeHerToThe({
    workspaceId: context.teamId!,
    channelId: context.channelId,
    playerId: context.userId!,
    messageText: rawMessageText,
    normalizedText,
    handlerKey,
    slackMessageTs,
    timestamp,
    targetPhase,
  });

  if (!result.ok) {
    if (result.reason === "no_game") {
      await context.say({ text: NO_GAME_EXISTS_MESSAGE });
    } else if (result.reason === "invalid_state") {
      if (targetPhase === "flop") {
        await context.say({
          text: ensureNarpBrainOnError(
            "We're not in pre-flop! Can't take her to the flop from here."
          ),
        });
      } else if (targetPhase === "turn") {
        await context.say({
          text: ensureNarpBrainOnError(
            "We're not on the flop! Can't take her to the turn from here."
          ),
        });
      } else {
        await context.say({
          text: ensureNarpBrainOnError(
            "We're not on the turn! Can't take her to the river from here."
          ),
        });
      }
    }
    return;
  }

  await sendGameStateMessages(env, context, result.game);
}

export async function fold(
  env: Env,
  context: SlackAppContextWithChannelId,
  payload: PostedMessage,
  meta?: HandlerMeta
) {
  const stub = getDurableObject(env, context);
  const rawMessageText = meta?.messageText ?? payload.text ?? "";
  const normalizedText =
    meta?.normalizedText ?? cleanMessageText(rawMessageText);
  const handlerKey = meta?.handlerKey ?? "fold";
  const slackMessageTs = meta?.slackMessageTs ?? payload.ts ?? "";
  const timestamp = meta?.timestamp ?? Date.now();

  const result = await stub.fold({
    workspaceId: context.teamId!,
    channelId: context.channelId,
    playerId: context.userId!,
    messageText: rawMessageText,
    normalizedText,
    handlerKey,
    slackMessageTs,
    timestamp,
  });

  if (!result.ok) {
    await context.say({ text: NO_GAME_EXISTS_MESSAGE });
    return;
  }

  await sendGameStateMessages(env, context, result.game);
}

export async function startRound(
  env: Env,
  context: SlackAppContextWithChannelId,
  payload: PostedMessage,
  meta?: HandlerMeta
) {
  const stub = getDurableObject(env, context);
  const rawMessageText = meta?.messageText ?? payload.text ?? "";
  const normalizedText =
    meta?.normalizedText ?? cleanMessageText(rawMessageText);
  const handlerKey = meta?.handlerKey ?? "startRound";
  const slackMessageTs = meta?.slackMessageTs ?? payload.ts ?? "";
  const timestamp = meta?.timestamp ?? Date.now();

  const result = await stub.startRound({
    workspaceId: context.teamId!,
    channelId: context.channelId,
    playerId: context.userId!,
    messageText: rawMessageText,
    normalizedText,
    handlerKey,
    slackMessageTs,
    timestamp,
  });

  if (!result.ok) {
    await context.say({ text: NO_GAME_EXISTS_MESSAGE });
    return;
  }

  if (result.started && result.gameId !== null) {
    await context.say({ text: `Starting game #${result.gameId}!` });
  }

  // Display stock price when a hand starts (non-blocking, graceful failure)
  // Check if a round actually started (gameState is PreFlop)
  if (result.started && result.game.gameState === GameState.PreFlop) {
    const stockPriceMessage = await getHubsStockPriceMessage();
    if (stockPriceMessage) {
      await context.say({ text: stockPriceMessage });
    }
  }

  await sendGameStateMessages(env, context, result.game);
}

export async function showChips(
  env: Env,
  context: SlackAppContextWithChannelId,
  _payload: PostedMessage
) {
  const game = await fetchGame(env, context);
  if (!game) {
    await context.say({ text: NO_GAME_EXISTS_MESSAGE });
    return;
  }

  let message = "";
  game.getActivePlayers().forEach((player) => {
    message += `<@${player.getId()}>: ${player.getChips()} (Active)\n`;
  });

  // game.getInactivePlayers().forEach((player) => {
  // 	message += `<@${player.getId()}>: ${player.getChips()} (Inactive)\n`;
  // });
  await context.say({ text: message });
}

export async function showStacks(
  env: Env,
  context: SlackAppContextWithChannelId,
  _payload: PostedMessage
) {
  const game = await fetchGame(env, context);
  if (!game) {
    await context.say({ text: NO_GAME_EXISTS_MESSAGE });
    return;
  }

  const bigBlind = game.getBigBlind();
  const smallBlind = game.getSmallBlind();
  const numActivePlayers = game.getActivePlayers().length;
  const orbitCost = smallBlind + bigBlind;

  let message = "*Stacks*\n";
  game.getActivePlayers().forEach((player) => {
    const name =
      userIdToName[player.getId() as keyof typeof userIdToName] ||
      player.getId();
    const chips = player.getChips();
    const bbMultiple = Math.round(chips / bigBlind);
    const orbitsLeft = numActivePlayers > 0 ? Math.round(chips / orbitCost) : 0;
    message += `*${name}*: ${chips} (${bbMultiple}xBB, ${orbitsLeft} orbits) Active\n`;
  });

  game.getInactivePlayers().forEach((player) => {
    const name =
      userIdToName[player.getId() as keyof typeof userIdToName] ||
      player.getId();
    const chips = player.getChips();
    const bbMultiple = Math.round(chips / bigBlind);
    const orbitsLeft = numActivePlayers > 0 ? Math.round(chips / orbitCost) : 0;
    message += `*${name}*: ${chips} (${bbMultiple}xBB, ${orbitsLeft} orbits) Inactive\n`;
  });

  await context.say({ text: message });
}

export async function showStats(
  env: Env,
  context: SlackAppContextWithChannelId,
  _payload: PostedMessage
) {
  const stub = getDurableObject(env, context);
  const stats = await stub.getPlayerHandStats(context.teamId!, context.channelId);
  const trackedStats = stats.filter((player) => player.handsCount > 0);

  if (trackedStats.length === 0) {
    await context.say({
      text: "No tracked player hand stats yet in this channel.",
    });
    return;
  }

  let message = "*Player Hand Stats*\n";
  trackedStats.forEach((player) => {
    const name =
      userIdToName[player.playerId as keyof typeof userIdToName] ||
      player.playerId;
    message += `*${name}*: hands ${player.handsCount}, won ${player.wonAnyPot}, showdown ${player.reachedShowdown}, folded ${player.folded}, checks ${player.checkCount}, calls ${player.callCount}, bets ${player.betCount}, raises ${player.raiseCount}, all-ins ${player.allInCount}, raise total ${player.raiseToTotal}, committed ${player.chipsCommitted}, won chips ${player.chipsWon}, net ${player.netChips}\n`;
  });

  await context.say({ text: message.trimEnd() });
}

export async function setStacks(
  env: Env,
  context: SlackAppContextWithChannelId,
  payload: PostedMessage,
  meta?: HandlerMeta
) {
  const messageText = payload.text.toLowerCase();
  const targetAmount = parseFloat(
    messageText.replace("set stacks", "").trim()
  );

  if (isNaN(targetAmount) || targetAmount < 0) {
    await context.say({
      text: ensureNarpBrainOnError(
        'Invalid amount! Please use format: "set stacks {amount}"'
      ),
    });
    return;
  }

  const stub = getDurableObject(env, context);
  const rawMessageText = meta?.messageText ?? payload.text ?? "";
  const normalizedText =
    meta?.normalizedText ?? cleanMessageText(rawMessageText);
  const handlerKey = meta?.handlerKey ?? "set stacks";
  const slackMessageTs = meta?.slackMessageTs ?? payload.ts ?? "";
  const timestamp = meta?.timestamp ?? Date.now();

  const result = await stub.setStacks({
    workspaceId: context.teamId!,
    channelId: context.channelId,
    playerId: context.userId!,
    messageText: rawMessageText,
    normalizedText,
    handlerKey,
    slackMessageTs,
    timestamp,
    targetAmount,
  });

  if (!result.ok) {
    if (result.reason === "no_game") {
      await context.say({ text: NO_GAME_EXISTS_MESSAGE });
    } else if (result.reason === "round_in_progress") {
      await context.say({
        text: ensureNarpBrainOnError(
          "Cannot set stacks while a round is in progress!"
        ),
      });
    }
    return;
  }

  const { adjustments } = result;

  if (adjustments.length === 0) {
    await context.say({
      text: ensureNarpBrainOnError("No players in the game!"),
    });
    return;
  }

  let outputMessage = `*Stacks equalized to ${targetAmount}*\n\n`;

  const positiveCommands: string[] = [];
  const negativeCommands: { playerName: string; command: string }[] = [];

  adjustments.forEach(({ playerId, difference }) => {
    const playerName =
      userIdToName[playerId as keyof typeof userIdToName] || playerId;

    if (difference > 0) {
      positiveCommands.push(
        `/metacoins banker ${difference} @pokernado <@${playerId}>`
      );
    } else if (difference < 0) {
      negativeCommands.push({
        playerName,
        command: `/metacoins ${Math.abs(difference)} @pokernado`,
      });
    }
  });

  if (positiveCommands.length > 0) {
    outputMessage += "*Players receiving from banker:*\n";
    positiveCommands.forEach((command) => {
      outputMessage += `\`${command}\`\n`;
    });
    outputMessage += "\n";
  }

  if (negativeCommands.length > 0) {
    outputMessage += "*Players paying to banker:*\n";
    negativeCommands.forEach(({ playerName, command }) => {
      outputMessage += `${playerName}: \`${command}\`\n`;
    });
  }

  if (positiveCommands.length === 0 && negativeCommands.length === 0) {
    outputMessage = `*Stacks equalized to ${targetAmount}*\n\nAll players already had exactly the target amount!`;
  }

  await context.say({ text: outputMessage });
}

export async function cashOut(
  env: Env,
  context: SlackAppContextWithChannelId,
  payload: PostedMessage,
  meta?: HandlerMeta
) {
  const stub = getDurableObject(env, context);
  const rawMessageText = meta?.messageText ?? payload.text ?? "";
  const normalizedText =
    meta?.normalizedText ?? cleanMessageText(rawMessageText);
  const handlerKey = meta?.handlerKey ?? "cash out";
  const slackMessageTs = meta?.slackMessageTs ?? payload.ts ?? "";
  const timestamp = meta?.timestamp ?? Date.now();

  const result = await stub.cashOut({
    workspaceId: context.teamId!,
    channelId: context.channelId,
    playerId: context.userId!,
    messageText: rawMessageText,
    normalizedText,
    handlerKey,
    slackMessageTs,
    timestamp,
  });

  if (!result.ok) {
    await context.say({ text: NO_GAME_EXISTS_MESSAGE });
    return;
  }

  await sendGameStateMessages(env, context, result.game);
}

export async function buyIn(
  env: Env,
  context: SlackAppContextWithChannelId,
  payload: PostedMessage,
  meta?: HandlerMeta
) {
  const messageText = payload.text.toLowerCase();
  const buyInAmount = parseFloat(messageText.replace("buy in", "").trim());

  if (isNaN(buyInAmount) || buyInAmount <= 0) {
    await context.say({
      text: ensureNarpBrainOnError(
        'Invalid buy in amount! Please use format: "buy in {chips}"'
      ),
    });
    return;
  }

  const stub = getDurableObject(env, context);
  const rawMessageText = meta?.messageText ?? payload.text ?? "";
  const normalizedText =
    meta?.normalizedText ?? cleanMessageText(rawMessageText);
  const handlerKey = meta?.handlerKey ?? "buy in";
  const slackMessageTs = meta?.slackMessageTs ?? payload.ts ?? "";
  const timestamp = meta?.timestamp ?? Date.now();

  const result = await stub.buyIn({
    workspaceId: context.teamId!,
    channelId: context.channelId,
    playerId: context.userId!,
    messageText: rawMessageText,
    normalizedText,
    handlerKey,
    slackMessageTs,
    timestamp,
    amount: buyInAmount,
  });

  if (!result.ok) {
    await context.say({ text: NO_GAME_EXISTS_MESSAGE });
    return;
  }

  await sendGameStateMessages(env, context, result.game);
}

export async function leaveGame(
  env: Env,
  context: SlackAppContextWithChannelId,
  payload: PostedMessage,
  meta?: HandlerMeta
) {
  const stub = getDurableObject(env, context);
  const rawMessageText = meta?.messageText ?? payload.text ?? "";
  const normalizedText =
    meta?.normalizedText ?? cleanMessageText(rawMessageText);
  const handlerKey = meta?.handlerKey ?? "leave table";
  const slackMessageTs = meta?.slackMessageTs ?? payload.ts ?? "";
  const timestamp = meta?.timestamp ?? Date.now();

  const result = await stub.leaveGame({
    workspaceId: context.teamId!,
    channelId: context.channelId,
    playerId: context.userId!,
    messageText: rawMessageText,
    normalizedText,
    handlerKey,
    slackMessageTs,
    timestamp,
  });

  if (!result.ok) {
    await context.say({ text: NO_GAME_EXISTS_MESSAGE });
    return;
  }

  await sendGameStateMessages(env, context, result.game);
}

function parseTaggedPlayerId(messageText: string): string | null {
  const match = messageText.match(/<@([A-Z0-9]+)>/);
  return match ? match[1] : null;
}

export async function removePlayer(
  env: Env,
  context: SlackAppContextWithChannelId,
  payload: PostedMessage,
  meta?: HandlerMeta
) {
  const rawMessageText = meta?.messageText ?? payload.text ?? "";
  const targetPlayerId = parseTaggedPlayerId(rawMessageText);

  if (!targetPlayerId) {
    await context.say({
      text: ensureNarpBrainOnError(
        'Please tag the player you want to remove. Usage: "remove player @username"'
      ),
    });
    return;
  }

  const stub = getDurableObject(env, context);
  const normalizedText =
    meta?.normalizedText ?? cleanMessageText(rawMessageText);
  const handlerKey = meta?.handlerKey ?? "remove player";
  const slackMessageTs = meta?.slackMessageTs ?? payload.ts ?? "";
  const timestamp = meta?.timestamp ?? Date.now();

  const result = await stub.deletePlayer({
    workspaceId: context.teamId!,
    channelId: context.channelId,
    requestingPlayerId: context.userId!,
    targetPlayerId,
    messageText: rawMessageText,
    normalizedText,
    handlerKey,
    slackMessageTs,
    timestamp,
  });

  if (!result.ok) {
    if (result.reason === "no_game") {
      await context.say({ text: NO_GAME_EXISTS_MESSAGE });
    } else if (result.reason === "delete_failed" && result.message) {
      await context.say({
        text: ensureNarpBrainOnError(result.message),
      });
    }
    return;
  }

  await sendGameStateMessages(env, context, result.game);
}

export async function joinGame(
  env: Env,
  context: SlackAppContextWithChannelId,
  payload: PostedMessage,
  meta?: HandlerMeta
) {
  const stub = getDurableObject(env, context);
  const messageText = meta?.messageText ?? payload.text ?? "";
  const normalizedText = meta?.normalizedText ?? cleanMessageText(messageText);
  const handlerKey = meta?.handlerKey ?? "join table";
  const slackMessageTs = meta?.slackMessageTs ?? payload.ts ?? "";
  const timestamp = meta?.timestamp ?? Date.now();

  const result = await stub.joinGame({
    workspaceId: context.teamId!,
    channelId: context.channelId,
    playerId: context.userId!,
    messageText,
    normalizedText,
    handlerKey,
    slackMessageTs,
    timestamp,
  });

  if (!result.ok) {
    await context.say({ text: NO_GAME_EXISTS_MESSAGE });
    return;
  }

  await sendGameStateMessages(env, context, result.game);
}

export async function newGame(
  env: Env,
  context: SlackAppContextWithChannelId,
  payload: PostedMessage,
  meta?: HandlerMeta
) {
  const stub = getDurableObject(env, context);
  const messageText = meta?.messageText ?? payload.text ?? "";
  const normalizedText = meta?.normalizedText ?? cleanMessageText(messageText);
  const handlerKey = meta?.handlerKey ?? "new game";
  const slackMessageTs = meta?.slackMessageTs ?? payload.ts ?? "";
  const timestamp = meta?.timestamp ?? Date.now();

  const result = await stub.newGame({
    workspaceId: context.teamId!,
    channelId: context.channelId,
    playerId: context.userId!,
    messageText,
    normalizedText,
    handlerKey,
    slackMessageTs,
    timestamp,
  });

  if (!result.ok) {
    await context.say({
      text: ensureNarpBrainOnError(
        `Cannot start new game - ${result.blockingPlayerId} still has chips!`
      ),
    });
    return;
  }

  await context.say({ text: `New Poker Game created!` });
}

async function fetchGame(env: Env, context: SlackAppContextWithChannelId) {
  const workspaceId = context.teamId!;
  const channelId = context.channelId;
  const stub = getDurableObject(env, context);
  const game = (await stub.fetchGame(
    workspaceId,
    channelId
  )) as SerializedGame | null;

  if (!game) {
    return null;
  }

  return TexasHoldem.fromJson(game);
}

async function sendGameStateMessages(
  env: Env,
  context: SlackAppContextWithChannelId,
  gameState: ReturnType<TexasHoldem["getState"]>
) {
  const events = gameState.events;
  const playerIds = [
    ...gameState.activePlayers.map((p) => p.id),
    ...gameState.inactivePlayers.map((p) => p.id),
  ];
  await sendEventsWithPlayerIds(env, context, events, playerIds, gameState);
}

async function sendEventsWithPlayerIds(
  env: Env,
  context: SlackAppContextWithChannelId,
  events: GameEventJson[],
  playerIds: string[],
  gameState?: ReturnType<TexasHoldem["getState"]>
) {
  // Filter turn messages to keep only the last one
  let lastTurnMessageIndex = -1;
  events.forEach((event, index) => {
    if (event.isTurnMessage) {
      lastTurnMessageIndex = index;
    }
  });
  const filteredEvents = events.filter(
    (event, index) => !event.isTurnMessage || index === lastTurnMessageIndex
  );
  const handCompleted =
    gameState?.gameState === GameState.WaitingForPlayers &&
    filteredEvents.some(
      (event) =>
        event.description.includes(" wins ") ||
        event.description.includes(" won by:")
    );

  let publicMessages: string[] = [];

  for (const event of filteredEvents) {
    let message = event.description;

    let skipFlop = false;
    if (message.startsWith("Flop:") && event.cards && event.cards.length == 3) {
      skipFlop = Math.random() < 0.01;

      const stub = getDurableObject(env, context);

      const workspaceId = context.teamId!;
      const channelId = context.channelId;

      const cards = event.cards.map((card) => Card.fromJson(card));
      const flopString = getFlopString(cards);

      const flop = await stub.getFlop(workspaceId, channelId, flopString);
      if (!flop) {
        message = `*NEW* ` + message;
        const flopCount = await stub.addFlop(
          workspaceId,
          channelId,
          flopString,
          Date.now()
        );
        const flopsDiscoveredPercentage = (flopCount / 22100) * 100;
        const numberFormatter = new Intl.NumberFormat("en-US");
        const percentFormatter = new Intl.NumberFormat("en-US", {
          minimumFractionDigits: 2,
          maximumFractionDigits: 2,
        });
        message =
          message +
          `\n${numberFormatter.format(flopCount)} flops discovered (${percentFormatter.format(
            flopsDiscoveredPercentage
          )}%), ${numberFormatter.format(22100 - flopCount)} remain`;
      } else {
        const human = new Date(flop.createdAt as number).toLocaleDateString(
          "en-US",
          {
            year: "numeric",
            month: "2-digit",
            day: "2-digit",
          }
        );
        message = `Flop (First Seen ${human}):`;
        skipFlop = false;
      }

      if (skipFlop) {
        message = ":no-bump-this-time: No flop this time";
      }
    }

    if (event.cards && event.cards.length > 0 && !skipFlop) {
      const cardStrings = event.cards.map((card) =>
        Card.fromJson(card).toSlackString()
      );
      message += `\n${cardStrings.join(" ")}`;
    }

    // Only tag users (with <@userId>) for turn notifications to reduce excessive pinging
    // For all other messages, use display names from the user name map
    if (event.isTurnMessage) {
      message = replacePlayerIdsWithTags(message, playerIds);
    } else {
      message = replacePlayerIdsWithDisplayNames(message, playerIds);
    }
    const slackMessage = ensureNarpBrainOnError(message);

    if (event.ephemeral) {
      await context.client.chat.postEphemeral({
        channel: context.channelId,
        user: event.playerId,
        text: slackMessage,
      });
    } else {
      publicMessages.push(slackMessage);
    }
  }

  if (gameState && !isVitestRuntime()) {
    try {
      const showdownWinPercentageMessage =
        await buildShowdownWinPercentageMessage(
          {
            activePlayers: gameState.activePlayers,
            foldedPlayers: gameState.foldedPlayers,
            communityCards: gameState.communityCards,
          },
          filteredEvents
        );

      if (showdownWinPercentageMessage) {
        publicMessages.push(showdownWinPercentageMessage);
      }
    } catch (error) {
      // Never let optional showdown stats impact core game messaging.
      console.error("Failed to build showdown win percentage message", error);
    }
  }

  if (handCompleted) {
    const stub = getDurableObject(env, context);
    const streakMessages = await stub.getCompletedHandStreakMessages(
      context.teamId!,
      context.channelId
    );
    streakMessages.forEach((message) => {
      publicMessages.push(
        ensureNarpBrainOnError(
          replacePlayerIdsWithDisplayNames(message, playerIds)
        )
      );
    });
  }

  if (publicMessages.length > 0) {
    await context.say({ text: publicMessages.join("\n") });
  }
}

function isVitestRuntime(): boolean {
  if (
    typeof process !== "undefined" &&
    typeof process.env === "object" &&
    process.env !== null
  ) {
    if (process.env.VITEST === "true") {
      return true;
    }
    if (typeof process.env.VITEST_WORKER_ID === "string") {
      return true;
    }
  }

  // @cloudflare/vitest-pool-workers exposes this global in worker runtime.
  return (
    typeof (globalThis as { __vitest_worker__?: unknown }).__vitest_worker__ !==
    "undefined"
  );
}

/**
 * Replaces player IDs in a message with display names (not Slack tags).
 * This is used for most messages to avoid excessive user pinging.
 */
function replacePlayerIdsWithDisplayNames(
  message: string,
  playerIds: string[]
): string {
  let result = message;
  playerIds.forEach((playerId) => {
    const displayName =
      userIdToName[playerId as keyof typeof userIdToName] || playerId;
    result = result.replace(new RegExp(playerId, "g"), `*${displayName}*`);
  });
  return result;
}

/**
 * Replaces player IDs in a message with Slack tags (<@userId>).
 * This should only be used for turn notifications to ping the user.
 */
function replacePlayerIdsWithTags(
  message: string,
  playerIds: string[]
): string {
  let result = message;
  playerIds.forEach((playerId) => {
    result = result.replace(new RegExp(playerId, "g"), `<@${playerId}>`);
  });
  return result;
}

function getDurableObject(env: Env, context: SlackAppContextWithChannelId) {
  const workspaceId = context.teamId!;
  const channelId = context.channelId;

  const id: DurableObjectId = env.POKER_DURABLE_OBJECT.idFromName(
    `${workspaceId}-${channelId}`
  );

  return env.POKER_DURABLE_OBJECT.get(id);
}

async function fetchStoredGameFromStub(
  stub: {
    fetchGame(workspaceId: string, channelId: string): Promise<SerializedGame | null>;
  },
  workspaceId: string,
  channelId: string
): Promise<SerializedGame | null> {
  return stub.fetchGame(workspaceId, channelId);
}

async function sendGameEventMessages(
  env: Env,
  context: SlackAppContextWithChannelId,
  game: TexasHoldem
) {
  let events = game.getEvents();
  // Filter turn messages to keep only the last one
  let lastTurnMessageIndex = -1;
  events.forEach((event, index) => {
    if (event.getIsTurnMessage()) {
      lastTurnMessageIndex = index;
    }
  });
  // Remove all turn messages except the last one
  events = events.filter(
    (event, index) =>
      !event.getIsTurnMessage() || index === lastTurnMessageIndex
  );

  let publicMessages = [];

  for (const event of events) {
    let message = event.getDescription();

    let skipFlop = false;
    if (
      message.startsWith("Flop:") &&
      event.getCards() &&
      event.getCards().length == 3
    ) {
      skipFlop = Math.random() < 0.01;

      const stub = getDurableObject(env, context);

      const workspaceId = context.teamId!;
      const channelId = context.channelId;

      const flopString = getFlopString(event.getCards());

      const flop = await stub.getFlop(workspaceId, channelId, flopString);
      if (!flop) {
        message = `*NEW* ` + message;
        const flopCount = await stub.addFlop(
          workspaceId,
          channelId,
          flopString,
          Date.now()
        );
        const flopsDiscoveredPercentage = (flopCount / 22100) * 100;
        const numberFormatter = new Intl.NumberFormat("en-US");
        const percentFormatter = new Intl.NumberFormat("en-US", {
          minimumFractionDigits: 2,
          maximumFractionDigits: 2,
        });
        message =
          message +
          `\n${numberFormatter.format(flopCount)} flops discovered (${percentFormatter.format(
            flopsDiscoveredPercentage
          )}%), ${numberFormatter.format(22100 - flopCount)} remain`;
      } else {
        const human = new Date(flop.createdAt as number).toLocaleDateString(
          "en-US",
          {
            year: "numeric",
            month: "2-digit",
            day: "2-digit",
          }
        );
        message = `Flop (First Seen ${human}):`;
        skipFlop = false;
      }

      if (skipFlop) {
        message = ":no-bump-this-time: No flop this time";
      }
    }

    if (event.getCards() && event.getCards().length > 0 && !skipFlop) {
      message += `\n${event
        .getCards()
        .map((card) => card.toSlackString())
        .join(" ")}`;
    }

    const playerIds = game.getActivePlayers().map((player) => player.getId());
    const inactivePlayerIds = game
      .getInactivePlayers()
      .map((player) => player.getId());
    playerIds.push(...inactivePlayerIds);
    // Only tag users (with <@userId>) for turn notifications to reduce excessive pinging
    // For all other messages, use display names from the user name map
    if (event.getIsTurnMessage()) {
      message = replacePlayerIdsWithTags(message, playerIds);
    } else {
      message = replacePlayerIdsWithDisplayNames(message, playerIds);
    }
    const slackMessage = ensureNarpBrainOnError(message);

    if (event.isEphemeral()) {
      await context.client.chat.postEphemeral({
        channel: context.channelId,
        user: event.getPlayerId(),
        text: slackMessage,
      });
    } else {
      publicMessages.push(slackMessage);
    }
  }

  if (publicMessages.length > 0) {
    await context.say({
      text: publicMessages.join("\n"),
    });
  }
}

function getFlopString(cards: Card[]) {
  return cards
    .map((card) => card.toString())
    .sort((a, b) => a.localeCompare(b))
    .join("");
}

function formatFlop(flop: { createdAt: number; flop: string }) {
  const date = new Date(flop.createdAt).toLocaleDateString("en-US", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  });
  return `${flop.flop.replace(/[dhsc]/g, (match: string) => {
    switch (match) {
      case "d":
        return ":diamonds:";
      case "h":
        return ":hearts:";
      case "s":
        return ":spades:";
      case "c":
        return ":clubs:";
      default:
        return match;
    }
  })} on ${date}\n`;
}
