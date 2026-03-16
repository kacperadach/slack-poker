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
import { userIdToName } from "./users";
import type {
  ActionLogEntry,
  CallActionV1,
  CheckActionV1,
  MessageReceivedActionV1,
  NewGameActionV1,
  RemovePlayerActionV1,
  RoundStartActionV1,
} from "./ActionLog";
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
    this.sql.exec(`
			CREATE TABLE IF NOT EXISTS PokerGames (
				workspaceId TEXT NOT NULL,
				channelId TEXT NOT NULL,
				game JSON NOT NULL,
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
			CREATE TABLE IF NOT EXISTS ActionLog (
				id INTEGER PRIMARY KEY AUTOINCREMENT,
				workspaceId TEXT NOT NULL,
				channelId TEXT NOT NULL,
				timestamp INTEGER NOT NULL,
				data JSON NOT NULL
			);
		`);

    this.sql.exec(`
			CREATE INDEX IF NOT EXISTS idx_actionlog_lookup
			ON ActionLog (workspaceId, channelId, timestamp);
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

    const flops = [];
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

    const flops = [];
    for (const row of result) {
      flops.push(row);
    }

    return flops;
  }

  createGame(workspaceId: string, channelId: string, game: any): void {
    this.sql.exec(
      `
			INSERT INTO PokerGames (workspaceId, channelId, game)
			VALUES (?, ?, ?)
			ON CONFLICT(workspaceId, channelId) DO UPDATE SET
				game = excluded.game
		`,
      workspaceId,
      channelId,
      game
    );
  }

  async fetchGame(workspaceId: string, channelId: string): Promise<any | null> {
    const game = this.sql
      .exec(
        `
			SELECT game FROM PokerGames
			WHERE workspaceId = ? AND channelId = ?
		`,
        workspaceId,
        channelId
      )
      .next();

    if (!game.value) {
      return null;
    }

    return JSON.parse(game.value.game as string);
  }

  async newGameWithAction(data: {
    workspaceId: string;
    channelId: string;
    playerId: string;
    messageText: string;
    normalizedText: string;
    handlerKey: string;
    slackMessageTs: string;
    timestamp: number;
  }): Promise<{ ok: true } | { ok: false; blockingPlayerId: string }> {
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
    }

    const newGameInstance = new TexasHoldem();
    this.createGame(
      data.workspaceId,
      data.channelId,
      JSON.stringify(newGameInstance.toJson())
    );

    const messageReceivedAction: MessageReceivedActionV1 = {
      schemaVersion: 1,
      workspaceId: data.workspaceId,
      channelId: data.channelId,
      timestamp: data.timestamp,
      actionType: "message_received",
      messageText: data.messageText,
      playerId: data.playerId,
      slackMessageTs: data.slackMessageTs,
      normalizedText: data.normalizedText,
      handlerKey: data.handlerKey,
    };
    this.logAction(messageReceivedAction);

    const newGameAction: NewGameActionV1 = {
      schemaVersion: 1,
      workspaceId: data.workspaceId,
      channelId: data.channelId,
      timestamp: Date.now(),
      actionType: "new_game",
      messageText: data.messageText,
      playerId: data.playerId,
      smallBlind: newGameInstance.getSmallBlind(),
      bigBlind: newGameInstance.getBigBlind(),
    };
    this.logAction(newGameAction);

    return { ok: true };
  }

  async joinGameWithAction(data: {
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
    const existing = await this.fetchGame(data.workspaceId, data.channelId);
    if (!existing) {
      return { ok: false, reason: "no_game" };
    }

    const game = TexasHoldem.fromJson(existing);
    game.addPlayer(data.playerId);

    const messageReceivedAction: MessageReceivedActionV1 = {
      schemaVersion: 1,
      workspaceId: data.workspaceId,
      channelId: data.channelId,
      timestamp: data.timestamp,
      actionType: "message_received",
      messageText: data.messageText,
      playerId: data.playerId,
      slackMessageTs: data.slackMessageTs,
      normalizedText: data.normalizedText,
      handlerKey: data.handlerKey,
    };
    this.logAction(messageReceivedAction);

    const joinAction: ActionLogEntry = {
      schemaVersion: 1,
      workspaceId: data.workspaceId,
      channelId: data.channelId,
      timestamp: Date.now(),
      actionType: "join",
      messageText: data.messageText,
      playerId: data.playerId,
    };

    this.saveGameWithAction(
      data.workspaceId,
      data.channelId,
      JSON.stringify(game.toJson()),
      joinAction
    );

    return { ok: true, game: game.getState() };
  }

  async buyInWithAction(data: {
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
    const existing = await this.fetchGame(data.workspaceId, data.channelId);
    if (!existing) {
      return { ok: false, reason: "no_game" };
    }

    const game = TexasHoldem.fromJson(existing);

    // Check if player needs to be auto-joined (not in active or inactive players)
    const isInActive = game
      .getActivePlayers()
      .some((p) => p.getId() === data.playerId);
    const isInInactive = game
      .getInactivePlayers()
      .some((p) => p.getId() === data.playerId);
    const needsAutoJoin = !isInActive && !isInInactive;

    game.buyIn(data.playerId, data.amount);

    const messageReceivedAction: MessageReceivedActionV1 = {
      schemaVersion: 1,
      workspaceId: data.workspaceId,
      channelId: data.channelId,
      timestamp: data.timestamp,
      actionType: "message_received",
      messageText: data.messageText,
      playerId: data.playerId,
      slackMessageTs: data.slackMessageTs,
      normalizedText: data.normalizedText,
      handlerKey: data.handlerKey,
    };
    this.logAction(messageReceivedAction);

    // If player was auto-joined, log the join action first
    if (needsAutoJoin) {
      const joinAction: ActionLogEntry = {
        schemaVersion: 1,
        workspaceId: data.workspaceId,
        channelId: data.channelId,
        timestamp: Date.now(),
        actionType: "join",
        messageText: data.messageText,
        playerId: data.playerId,
      };
      this.logAction(joinAction);
    }

    const buyInAction: ActionLogEntry = {
      schemaVersion: 1,
      workspaceId: data.workspaceId,
      channelId: data.channelId,
      timestamp: Date.now(),
      actionType: "buy_in",
      messageText: data.messageText,
      playerId: data.playerId,
      amount: data.amount,
    };

    this.saveGameWithAction(
      data.workspaceId,
      data.channelId,
      JSON.stringify(game.toJson()),
      buyInAction
    );

    return { ok: true, game: game.getState() };
  }

  async setStacksWithAction(data: {
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
    const existing = await this.fetchGame(data.workspaceId, data.channelId);
    if (!existing) {
      return { ok: false, reason: "no_game" };
    }

    const game = TexasHoldem.fromJson(existing);

    if (game.getGameState() !== GameState.WaitingForPlayers) {
      return { ok: false, reason: "round_in_progress" };
    }

    const adjustments: Array<{
      playerId: string;
      previousChips: number;
      newChips: number;
      difference: number;
    }> = [];

    const allPlayers = [
      ...game.getActivePlayers(),
      ...game.getInactivePlayers(),
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

    const messageReceivedAction: MessageReceivedActionV1 = {
      schemaVersion: 1,
      workspaceId: data.workspaceId,
      channelId: data.channelId,
      timestamp: data.timestamp,
      actionType: "message_received",
      messageText: data.messageText,
      playerId: data.playerId,
      slackMessageTs: data.slackMessageTs,
      normalizedText: data.normalizedText,
      handlerKey: data.handlerKey,
    };
    this.logAction(messageReceivedAction);

    const setStacksAction: ActionLogEntry = {
      schemaVersion: 1,
      workspaceId: data.workspaceId,
      channelId: data.channelId,
      timestamp: Date.now(),
      actionType: "set_stacks",
      messageText: data.messageText,
      playerId: data.playerId,
      amount: data.targetAmount,
    };

    this.saveGameWithAction(
      data.workspaceId,
      data.channelId,
      JSON.stringify(game.toJson()),
      setStacksAction
    );

    return { ok: true, game: game.getState(), adjustments };
  }

  async foldWithAction(data: {
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
    const existing = await this.fetchGame(data.workspaceId, data.channelId);
    if (!existing) {
      return { ok: false, reason: "no_game" };
    }

    const game = TexasHoldem.fromJson(existing);
    game.fold(data.playerId);

    const messageReceivedAction: MessageReceivedActionV1 = {
      schemaVersion: 1,
      workspaceId: data.workspaceId,
      channelId: data.channelId,
      timestamp: data.timestamp,
      actionType: "message_received",
      messageText: data.messageText,
      playerId: data.playerId,
      slackMessageTs: data.slackMessageTs,
      normalizedText: data.normalizedText,
      handlerKey: data.handlerKey,
    };
    this.logAction(messageReceivedAction);

    const foldAction: ActionLogEntry = {
      schemaVersion: 1,
      workspaceId: data.workspaceId,
      channelId: data.channelId,
      timestamp: Date.now(),
      actionType: "fold",
      messageText: data.messageText,
      playerId: data.playerId,
    };

    this.saveGameWithAction(
      data.workspaceId,
      data.channelId,
      JSON.stringify(game.toJson()),
      foldAction
    );

    return { ok: true, game: game.getState() };
  }

  async checkWithAction(data: {
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
    const existing = await this.fetchGame(data.workspaceId, data.channelId);
    if (!existing) {
      return { ok: false, reason: "no_game" };
    }

    const game = TexasHoldem.fromJson(existing);
    game.check(data.playerId);

    const messageReceivedAction: MessageReceivedActionV1 = {
      schemaVersion: 1,
      workspaceId: data.workspaceId,
      channelId: data.channelId,
      timestamp: data.timestamp,
      actionType: "message_received",
      messageText: data.messageText,
      playerId: data.playerId,
      slackMessageTs: data.slackMessageTs,
      normalizedText: data.normalizedText,
      handlerKey: data.handlerKey,
    };
    this.logAction(messageReceivedAction);

    const checkAction: ActionLogEntry = {
      schemaVersion: 1,
      workspaceId: data.workspaceId,
      channelId: data.channelId,
      timestamp: Date.now(),
      actionType: "check",
      messageText: data.messageText,
      playerId: data.playerId,
    };

    this.saveGameWithAction(
      data.workspaceId,
      data.channelId,
      JSON.stringify(game.toJson()),
      checkAction
    );

    return { ok: true, game: game.getState() };
  }

  async callWithAction(data: {
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
    const existing = await this.fetchGame(data.workspaceId, data.channelId);
    if (!existing) {
      return { ok: false, reason: "no_game" };
    }

    const game = TexasHoldem.fromJson(existing);
    const callAmount =
      game.getCurrentBetAmount() -
      (game.getCurrentPlayer()?.getCurrentBet() ?? 0);
    game.call(data.playerId);

    const messageReceivedAction: MessageReceivedActionV1 = {
      schemaVersion: 1,
      workspaceId: data.workspaceId,
      channelId: data.channelId,
      timestamp: data.timestamp,
      actionType: "message_received",
      messageText: data.messageText,
      playerId: data.playerId,
      slackMessageTs: data.slackMessageTs,
      normalizedText: data.normalizedText,
      handlerKey: data.handlerKey,
    };
    this.logAction(messageReceivedAction);

    const callAction: ActionLogEntry = {
      schemaVersion: 1,
      workspaceId: data.workspaceId,
      channelId: data.channelId,
      timestamp: Date.now(),
      actionType: "call",
      messageText: data.messageText,
      playerId: data.playerId,
      amount: callAmount,
    };

    this.saveGameWithAction(
      data.workspaceId,
      data.channelId,
      JSON.stringify(game.toJson()),
      callAction
    );

    return { ok: true, game: game.getState() };
  }

  async betWithAction(data: {
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
    const existing = await this.fetchGame(data.workspaceId, data.channelId);
    if (!existing) {
      return { ok: false, reason: "no_game" };
    }

    const game = TexasHoldem.fromJson(existing);
    game.bet(data.playerId, data.amount);

    const messageReceivedAction: MessageReceivedActionV1 = {
      schemaVersion: 1,
      workspaceId: data.workspaceId,
      channelId: data.channelId,
      timestamp: data.timestamp,
      actionType: "message_received",
      messageText: data.messageText,
      playerId: data.playerId,
      slackMessageTs: data.slackMessageTs,
      normalizedText: data.normalizedText,
      handlerKey: data.handlerKey,
    };
    this.logAction(messageReceivedAction);

    const betAction: ActionLogEntry = {
      schemaVersion: 1,
      workspaceId: data.workspaceId,
      channelId: data.channelId,
      timestamp: Date.now(),
      actionType: "bet",
      messageText: data.messageText,
      playerId: data.playerId,
      amount: data.amount,
    };

    this.saveGameWithAction(
      data.workspaceId,
      data.channelId,
      JSON.stringify(game.toJson()),
      betAction
    );

    return { ok: true, game: game.getState() };
  }

  async allInWithAction(data: {
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
    const existing = await this.fetchGame(data.workspaceId, data.channelId);
    if (!existing) {
      return { ok: false, reason: "no_game" };
    }

    const game = TexasHoldem.fromJson(existing);
    const player = game.getCurrentPlayer();
    const allInAmount = player ? player.getCurrentBet() + player.getChips() : 0;
    game.allIn(data.playerId);

    const messageReceivedAction: MessageReceivedActionV1 = {
      schemaVersion: 1,
      workspaceId: data.workspaceId,
      channelId: data.channelId,
      timestamp: data.timestamp,
      actionType: "message_received",
      messageText: data.messageText,
      playerId: data.playerId,
      slackMessageTs: data.slackMessageTs,
      normalizedText: data.normalizedText,
      handlerKey: data.handlerKey,
    };
    this.logAction(messageReceivedAction);

    const allInAction: ActionLogEntry = {
      schemaVersion: 1,
      workspaceId: data.workspaceId,
      channelId: data.channelId,
      timestamp: Date.now(),
      actionType: "all_in",
      messageText: data.messageText,
      playerId: data.playerId,
      amount: allInAmount,
    };

    this.saveGameWithAction(
      data.workspaceId,
      data.channelId,
      JSON.stringify(game.toJson()),
      allInAction
    );

    return { ok: true, game: game.getState() };
  }

  async startRoundWithAction(data: {
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
    const existing = await this.fetchGame(data.workspaceId, data.channelId);
    if (!existing) {
      return { ok: false, reason: "no_game" };
    }

    const game = TexasHoldem.fromJson(existing);
    game.startRound(data.playerId);

    const messageReceivedAction: MessageReceivedActionV1 = {
      schemaVersion: 1,
      workspaceId: data.workspaceId,
      channelId: data.channelId,
      timestamp: data.timestamp,
      actionType: "message_received",
      messageText: data.messageText,
      playerId: data.playerId,
      slackMessageTs: data.slackMessageTs,
      normalizedText: data.normalizedText,
      handlerKey: data.handlerKey,
    };
    this.logAction(messageReceivedAction);

    // Build round_start action
    const state = game.getState();
    const playerOrder = state.activePlayers.map((p) => p.id);
    const playerStacks: Record<string, number> = {};
    const playerCards: Record<string, [string, string]> = {};

    state.activePlayers.forEach((p) => {
      playerStacks[p.id] = p.chips;
      if (p.cards.length === 2) {
        playerCards[p.id] = [p.cards[0].toString(), p.cards[1].toString()];
      }
    });

    const communityCards = state.communityCards.map((c) => c.toString());
    const fullCommunityCards: [string, string, string, string, string] = [
      communityCards[0] ?? "",
      communityCards[1] ?? "",
      communityCards[2] ?? "",
      communityCards[3] ?? "",
      communityCards[4] ?? "",
    ];

    const numPlayers = playerOrder.length;
    const dealerPos = state.dealerPosition;
    const sbPos = numPlayers === 2 ? dealerPos : (dealerPos + 1) % numPlayers;
    const bbPos =
      numPlayers === 2
        ? (dealerPos + 1) % numPlayers
        : (dealerPos + 2) % numPlayers;

    const roundStartAction: RoundStartActionV1 = {
      schemaVersion: 1,
      workspaceId: data.workspaceId,
      channelId: data.channelId,
      timestamp: Date.now(),
      actionType: "round_start",
      messageText: data.messageText,
      dealerPosition: state.dealerPosition,
      playerOrder,
      playerStacks,
      playerCards,
      communityCards: fullCommunityCards,
      smallBlindPlayerId: playerOrder[sbPos] ?? "",
      smallBlindAmount: state.smallBlind,
      bigBlindPlayerId: playerOrder[bbPos] ?? "",
      bigBlindAmount: state.bigBlind,
    };

    this.saveGameWithAction(
      data.workspaceId,
      data.channelId,
      JSON.stringify(game.toJson()),
      roundStartAction
    );

    return { ok: true, game: game.getState() };
  }

  async takeHerToTheWithAction(data: {
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
    const existing = await this.fetchGame(data.workspaceId, data.channelId);
    if (!existing) {
      return { ok: false, reason: "no_game" };
    }

    const game = TexasHoldem.fromJson(existing);
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

    // Determine if this is a call or check
    const currentBet = game.getCurrentBetAmount();
    const playerBet = game.getCurrentPlayer()?.getCurrentBet() ?? 0;
    const isCall = currentBet > playerBet;
    const callAmount = currentBet - playerBet;

    game.callOrCheck(data.playerId);

    const messageReceivedAction: MessageReceivedActionV1 = {
      schemaVersion: 1,
      workspaceId: data.workspaceId,
      channelId: data.channelId,
      timestamp: data.timestamp,
      actionType: "message_received",
      messageText: data.messageText,
      playerId: data.playerId,
      slackMessageTs: data.slackMessageTs,
      normalizedText: data.normalizedText,
      handlerKey: data.handlerKey,
    };
    this.logAction(messageReceivedAction);

    if (isCall) {
      const callAction: CallActionV1 = {
        schemaVersion: 1,
        workspaceId: data.workspaceId,
        channelId: data.channelId,
        timestamp: Date.now(),
        actionType: "call",
        messageText: data.messageText,
        playerId: data.playerId,
        amount: callAmount,
      };
      this.saveGameWithAction(
        data.workspaceId,
        data.channelId,
        JSON.stringify(game.toJson()),
        callAction
      );
    } else {
      const checkAction: CheckActionV1 = {
        schemaVersion: 1,
        workspaceId: data.workspaceId,
        channelId: data.channelId,
        timestamp: Date.now(),
        actionType: "check",
        messageText: data.messageText,
        playerId: data.playerId,
      };
      this.saveGameWithAction(
        data.workspaceId,
        data.channelId,
        JSON.stringify(game.toJson()),
        checkAction
      );
    }

    return { ok: true, game: game.getState() };
  }

  async thisPotAintBigEnoughWithAction(data: {
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
    const existing = await this.fetchGame(data.workspaceId, data.channelId);
    if (!existing) {
      return { ok: false, reason: "no_game" };
    }

    const game = TexasHoldem.fromJson(existing);
    const currentState = game.getGameState();

    if (currentState !== GameState.River) {
      return { ok: false, reason: "not_river" };
    }

    const currentBet = game.getCurrentBetAmount();
    const playerBet = game.getCurrentPlayer()?.getCurrentBet() ?? 0;
    const isCall = currentBet > playerBet;
    const callAmount = currentBet - playerBet;

    game.callOrCheck(data.playerId);

    const messageReceivedAction: MessageReceivedActionV1 = {
      schemaVersion: 1,
      workspaceId: data.workspaceId,
      channelId: data.channelId,
      timestamp: data.timestamp,
      actionType: "message_received",
      messageText: data.messageText,
      playerId: data.playerId,
      slackMessageTs: data.slackMessageTs,
      normalizedText: data.normalizedText,
      handlerKey: data.handlerKey,
    };
    this.logAction(messageReceivedAction);

    if (isCall) {
      const callAction: CallActionV1 = {
        schemaVersion: 1,
        workspaceId: data.workspaceId,
        channelId: data.channelId,
        timestamp: Date.now(),
        actionType: "call",
        messageText: data.messageText,
        playerId: data.playerId,
        amount: callAmount,
      };
      this.saveGameWithAction(
        data.workspaceId,
        data.channelId,
        JSON.stringify(game.toJson()),
        callAction
      );
    } else {
      const checkAction: CheckActionV1 = {
        schemaVersion: 1,
        workspaceId: data.workspaceId,
        channelId: data.channelId,
        timestamp: Date.now(),
        actionType: "check",
        messageText: data.messageText,
        playerId: data.playerId,
      };
      this.saveGameWithAction(
        data.workspaceId,
        data.channelId,
        JSON.stringify(game.toJson()),
        checkAction
      );
    }

    return { ok: true, game: game.getState() };
  }

  async preDealWithAction(data: {
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
    const existing = await this.fetchGame(data.workspaceId, data.channelId);
    if (!existing) {
      return { ok: false, reason: "no_game" };
    }

    const game = TexasHoldem.fromJson(existing);
    const wasWaiting = game.getGameState() === GameState.WaitingForPlayers;

    game.preDeal(data.playerId);

    const messageReceivedAction: MessageReceivedActionV1 = {
      schemaVersion: 1,
      workspaceId: data.workspaceId,
      channelId: data.channelId,
      timestamp: data.timestamp,
      actionType: "message_received",
      messageText: data.messageText,
      playerId: data.playerId,
      slackMessageTs: data.slackMessageTs,
      normalizedText: data.normalizedText,
      handlerKey: data.handlerKey,
    };
    this.logAction(messageReceivedAction);

    // If state transitioned from WaitingForPlayers, log round_start
    if (wasWaiting && game.getGameState() !== GameState.WaitingForPlayers) {
      const state = game.getState();
      const playerOrder = state.activePlayers.map((p) => p.id);
      const playerStacks: Record<string, number> = {};
      const playerCards: Record<string, [string, string]> = {};

      state.activePlayers.forEach((p) => {
        playerStacks[p.id] = p.chips;
        if (p.cards.length === 2) {
          playerCards[p.id] = [p.cards[0].toString(), p.cards[1].toString()];
        }
      });

      const communityCards = state.communityCards.map((c) => c.toString());
      const fullCommunityCards: [string, string, string, string, string] = [
        communityCards[0] ?? "",
        communityCards[1] ?? "",
        communityCards[2] ?? "",
        communityCards[3] ?? "",
        communityCards[4] ?? "",
      ];

      const numPlayers = playerOrder.length;
      const dealerPos = state.dealerPosition;
      const sbPos = numPlayers === 2 ? dealerPos : (dealerPos + 1) % numPlayers;
      const bbPos =
        numPlayers === 2
          ? (dealerPos + 1) % numPlayers
          : (dealerPos + 2) % numPlayers;

      const roundStartAction: RoundStartActionV1 = {
        schemaVersion: 1,
        workspaceId: data.workspaceId,
        channelId: data.channelId,
        timestamp: Date.now(),
        actionType: "round_start",
        messageText: data.messageText,
        dealerPosition: state.dealerPosition,
        playerOrder,
        playerStacks,
        playerCards,
        communityCards: fullCommunityCards,
        smallBlindPlayerId: playerOrder[sbPos] ?? "",
        smallBlindAmount: state.smallBlind,
        bigBlindPlayerId: playerOrder[bbPos] ?? "",
        bigBlindAmount: state.bigBlind,
      };

      this.saveGameWithAction(
        data.workspaceId,
        data.channelId,
        JSON.stringify(game.toJson()),
        roundStartAction
      );
    } else {
      this.saveGame(
        data.workspaceId,
        data.channelId,
        JSON.stringify(game.toJson())
      );
    }

    return { ok: true, game: game.getState() };
  }

  async preNHWithAction(data: {
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
    const existing = await this.fetchGame(data.workspaceId, data.channelId);
    if (!existing) {
      return { ok: false, reason: "no_game" };
    }

    const game = TexasHoldem.fromJson(existing);
    game.preNH(data.playerId);

    const messageReceivedAction: MessageReceivedActionV1 = {
      schemaVersion: 1,
      workspaceId: data.workspaceId,
      channelId: data.channelId,
      timestamp: data.timestamp,
      actionType: "message_received",
      messageText: data.messageText,
      playerId: data.playerId,
      slackMessageTs: data.slackMessageTs,
      normalizedText: data.normalizedText,
      handlerKey: data.handlerKey,
    };
    this.logAction(messageReceivedAction);
    this.saveGame(
      data.workspaceId,
      data.channelId,
      JSON.stringify(game.toJson())
    );

    return { ok: true, game: game.getState() };
  }

  async preAHWithAction(data: {
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
    const existing = await this.fetchGame(data.workspaceId, data.channelId);
    if (!existing) {
      return { ok: false, reason: "no_game" };
    }

    const game = TexasHoldem.fromJson(existing);
    game.preAH(data.playerId);

    const messageReceivedAction: MessageReceivedActionV1 = {
      schemaVersion: 1,
      workspaceId: data.workspaceId,
      channelId: data.channelId,
      timestamp: data.timestamp,
      actionType: "message_received",
      messageText: data.messageText,
      playerId: data.playerId,
      slackMessageTs: data.slackMessageTs,
      normalizedText: data.normalizedText,
      handlerKey: data.handlerKey,
    };
    this.logAction(messageReceivedAction);
    this.saveGame(
      data.workspaceId,
      data.channelId,
      JSON.stringify(game.toJson())
    );

    return { ok: true, game: game.getState() };
  }

  async preCheckWithAction(data: {
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
    const existing = await this.fetchGame(data.workspaceId, data.channelId);
    if (!existing) {
      return { ok: false, reason: "no_game" };
    }

    const game = TexasHoldem.fromJson(existing);
    game.preCheck(data.playerId);

    const messageReceivedAction: MessageReceivedActionV1 = {
      schemaVersion: 1,
      workspaceId: data.workspaceId,
      channelId: data.channelId,
      timestamp: data.timestamp,
      actionType: "message_received",
      messageText: data.messageText,
      playerId: data.playerId,
      slackMessageTs: data.slackMessageTs,
      normalizedText: data.normalizedText,
      handlerKey: data.handlerKey,
    };
    this.logAction(messageReceivedAction);
    this.saveGame(
      data.workspaceId,
      data.channelId,
      JSON.stringify(game.toJson())
    );

    return { ok: true, game: game.getState() };
  }

  async preFoldWithAction(data: {
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
    const existing = await this.fetchGame(data.workspaceId, data.channelId);
    if (!existing) {
      return { ok: false, reason: "no_game" };
    }

    const game = TexasHoldem.fromJson(existing);
    game.preFold(data.playerId);

    const messageReceivedAction: MessageReceivedActionV1 = {
      schemaVersion: 1,
      workspaceId: data.workspaceId,
      channelId: data.channelId,
      timestamp: data.timestamp,
      actionType: "message_received",
      messageText: data.messageText,
      playerId: data.playerId,
      slackMessageTs: data.slackMessageTs,
      normalizedText: data.normalizedText,
      handlerKey: data.handlerKey,
    };
    this.logAction(messageReceivedAction);
    this.saveGame(
      data.workspaceId,
      data.channelId,
      JSON.stringify(game.toJson())
    );

    return { ok: true, game: game.getState() };
  }

  async preCallWithAction(data: {
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
    const existing = await this.fetchGame(data.workspaceId, data.channelId);
    if (!existing) {
      return { ok: false, reason: "no_game" };
    }

    const game = TexasHoldem.fromJson(existing);
    game.preCall(data.playerId);

    const messageReceivedAction: MessageReceivedActionV1 = {
      schemaVersion: 1,
      workspaceId: data.workspaceId,
      channelId: data.channelId,
      timestamp: data.timestamp,
      actionType: "message_received",
      messageText: data.messageText,
      playerId: data.playerId,
      slackMessageTs: data.slackMessageTs,
      normalizedText: data.normalizedText,
      handlerKey: data.handlerKey,
    };
    this.logAction(messageReceivedAction);
    this.saveGame(
      data.workspaceId,
      data.channelId,
      JSON.stringify(game.toJson())
    );

    return { ok: true, game: game.getState() };
  }

  async preBetWithAction(data: {
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
    const existing = await this.fetchGame(data.workspaceId, data.channelId);
    if (!existing) {
      return { ok: false, reason: "no_game" };
    }

    const game = TexasHoldem.fromJson(existing);
    game.preBet(data.playerId, data.amount);

    const messageReceivedAction: MessageReceivedActionV1 = {
      schemaVersion: 1,
      workspaceId: data.workspaceId,
      channelId: data.channelId,
      timestamp: data.timestamp,
      actionType: "message_received",
      messageText: data.messageText,
      playerId: data.playerId,
      slackMessageTs: data.slackMessageTs,
      normalizedText: data.normalizedText,
      handlerKey: data.handlerKey,
    };
    this.logAction(messageReceivedAction);
    this.saveGame(
      data.workspaceId,
      data.channelId,
      JSON.stringify(game.toJson())
    );

    return { ok: true, game: game.getState() };
  }

  async cashOutWithAction(data: {
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
    const existing = await this.fetchGame(data.workspaceId, data.channelId);
    if (!existing) {
      return { ok: false, reason: "no_game" };
    }

    const game = TexasHoldem.fromJson(existing);
    const allPlayers = [
      ...game.getActivePlayers(),
      ...game.getInactivePlayers(),
    ];
    const player = allPlayers.find((p) => p.getId() === data.playerId);
    const cashOutAmount = player?.getChips() ?? 0;
    game.cashOut(data.playerId);

    const messageReceivedAction: MessageReceivedActionV1 = {
      schemaVersion: 1,
      workspaceId: data.workspaceId,
      channelId: data.channelId,
      timestamp: data.timestamp,
      actionType: "message_received",
      messageText: data.messageText,
      playerId: data.playerId,
      slackMessageTs: data.slackMessageTs,
      normalizedText: data.normalizedText,
      handlerKey: data.handlerKey,
    };
    this.logAction(messageReceivedAction);

    const cashOutAction: ActionLogEntry = {
      schemaVersion: 1,
      workspaceId: data.workspaceId,
      channelId: data.channelId,
      timestamp: Date.now(),
      actionType: "cash_out",
      messageText: data.messageText,
      playerId: data.playerId,
      amount: cashOutAmount,
    };

    this.saveGameWithAction(
      data.workspaceId,
      data.channelId,
      JSON.stringify(game.toJson()),
      cashOutAction
    );

    return { ok: true, game: game.getState() };
  }

  async leaveGameWithAction(data: {
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
    const existing = await this.fetchGame(data.workspaceId, data.channelId);
    if (!existing) {
      return { ok: false, reason: "no_game" };
    }

    const game = TexasHoldem.fromJson(existing);
    game.removePlayer(data.playerId);

    const messageReceivedAction: MessageReceivedActionV1 = {
      schemaVersion: 1,
      workspaceId: data.workspaceId,
      channelId: data.channelId,
      timestamp: data.timestamp,
      actionType: "message_received",
      messageText: data.messageText,
      playerId: data.playerId,
      slackMessageTs: data.slackMessageTs,
      normalizedText: data.normalizedText,
      handlerKey: data.handlerKey,
    };
    this.logAction(messageReceivedAction);

    const leaveAction: ActionLogEntry = {
      schemaVersion: 1,
      workspaceId: data.workspaceId,
      channelId: data.channelId,
      timestamp: Date.now(),
      actionType: "leave",
      messageText: data.messageText,
      playerId: data.playerId,
    };

    this.saveGameWithAction(
      data.workspaceId,
      data.channelId,
      JSON.stringify(game.toJson()),
      leaveAction
    );

    return { ok: true, game: game.getState() };
  }

  async deletePlayerWithAction(data: {
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
    const existing = await this.fetchGame(data.workspaceId, data.channelId);
    if (!existing) {
      return { ok: false, reason: "no_game" };
    }

    const game = TexasHoldem.fromJson(existing);
    const result = game.deletePlayer(data.targetPlayerId);

    if (result !== "Success") {
      return { ok: false, reason: "delete_failed", message: result };
    }

    const messageReceivedAction: MessageReceivedActionV1 = {
      schemaVersion: 1,
      workspaceId: data.workspaceId,
      channelId: data.channelId,
      timestamp: data.timestamp,
      actionType: "message_received",
      messageText: data.messageText,
      playerId: data.requestingPlayerId,
      slackMessageTs: data.slackMessageTs,
      normalizedText: data.normalizedText,
      handlerKey: data.handlerKey,
    };
    this.logAction(messageReceivedAction);

    const removePlayerAction: RemovePlayerActionV1 = {
      schemaVersion: 1,
      workspaceId: data.workspaceId,
      channelId: data.channelId,
      timestamp: Date.now(),
      actionType: "remove_player",
      messageText: data.messageText,
      playerId: data.targetPlayerId,
    };

    this.saveGameWithAction(
      data.workspaceId,
      data.channelId,
      JSON.stringify(game.toJson()),
      removePlayerAction
    );

    return { ok: true, game: game.getState() };
  }

  saveGame(workspaceId: string, channelId: string, game: any): void {
    this.sql.exec(
      `
			UPDATE PokerGames
			SET game = ?
			WHERE workspaceId = ? AND channelId = ?
		`,
      game,
      workspaceId,
      channelId
    );
  }

  /**
   * Save game state and log action atomically.
   * Both operations happen in the same DO request, ensuring consistency.
   */
  saveGameWithAction(
    workspaceId: string,
    channelId: string,
    game: any,
    action: ActionLogEntry
  ): void {
    // Save game state
    this.sql.exec(
      `
			UPDATE PokerGames
			SET game = ?
			WHERE workspaceId = ? AND channelId = ?
		`,
      game,
      workspaceId,
      channelId
    );

    // Log the action
    this.sql.exec(
      `
			INSERT INTO ActionLog (workspaceId, channelId, timestamp, data)
			VALUES (?, ?, ?, ?)
		`,
      action.workspaceId,
      action.channelId,
      action.timestamp,
      JSON.stringify(action)
    );
  }

  /**
   * Log an action to the immutable ActionLog.
   * The data object should be self-contained with all relevant information.
   * workspaceId, channelId, and timestamp are duplicated in columns for indexing
   * and also stored in the JSON data for completeness.
   *
   * @param data - Typed action log entry (see ActionLog.ts for all types)
   */
  logAction(data: ActionLogEntry): void {
    this.sql.exec(
      `
			INSERT INTO ActionLog (workspaceId, channelId, timestamp, data)
			VALUES (?, ?, ?, ?)
		`,
      data.workspaceId,
      data.channelId,
      data.timestamp,
      JSON.stringify(data)
    );
  }

  /**
   * Get action logs for a game, ordered by timestamp ascending.
   * Returns typed ActionLogEntry objects for type-safe access.
   */
  getActionLogs(
    workspaceId: string,
    channelId: string,
    options: {
      limit?: number;
      offset?: number;
      startTime?: number;
      endTime?: number;
    } = {}
  ): Array<{
    id: number;
    data: ActionLogEntry;
  }> {
    let query = `
			SELECT id, data
			FROM ActionLog
			WHERE workspaceId = ? AND channelId = ?
		`;
    const params: (string | number)[] = [workspaceId, channelId];

    if (options.startTime !== undefined) {
      query += ` AND timestamp >= ?`;
      params.push(options.startTime);
    }

    if (options.endTime !== undefined) {
      query += ` AND timestamp <= ?`;
      params.push(options.endTime);
    }

    query += ` ORDER BY timestamp ASC`;

    if (options.limit) {
      query += ` LIMIT ?`;
      params.push(options.limit);
    }

    if (options.offset) {
      query += ` OFFSET ?`;
      params.push(options.offset);
    }

    const result = this.sql.exec(query, ...params);

    const logs: Array<{ id: number; data: ActionLogEntry }> = [];
    for (const row of result) {
      logs.push({
        id: row.id as number,
        data: JSON.parse(row.data as string) as ActionLogEntry,
      });
    }

    return logs;
  }

  /**
   * Get the database size in bytes using SQLite pragma.
   */
  getDatabaseSize(): {
    totalBytes: number;
    pageSize: number;
    pageCount: number;
  } {
    const pageSizeResult = this.sql.exec(`PRAGMA page_size`);
    const pageCountResult = this.sql.exec(`PRAGMA page_count`);

    const pageSize = pageSizeResult.one()?.page_size as number;
    const pageCount = pageCountResult.one()?.page_count as number;

    return {
      totalBytes: pageSize * pageCount,
      pageSize,
      pageCount,
    };
  }

  /**
   * Get all action logs across all workspaces/channels for analytics.
   * Only returns logs older than 24 hours to prevent live game snooping.
   * Returns an array of all logs for streaming.
   */
  getAllActionLogs(): Array<{
    id: number;
    workspaceId: string;
    channelId: string;
    timestamp: number;
    data: ActionLogEntry;
  }> {
    const oneDayAgo = Date.now() - 24 * 60 * 60 * 1000;
    const result = this.sql.exec(
      `
      SELECT id, workspaceId, channelId, timestamp, data
      FROM ActionLog
      WHERE timestamp < ?
      ORDER BY id ASC
    `,
      oneDayAgo
    );

    const logs: Array<{
      id: number;
      workspaceId: string;
      channelId: string;
      timestamp: number;
      data: ActionLogEntry;
    }> = [];
    for (const row of result) {
      logs.push({
        id: row.id as number,
        workspaceId: row.workspaceId as string,
        channelId: row.channelId as string,
        timestamp: row.timestamp as number,
        data: JSON.parse(row.data as string) as ActionLogEntry,
      });
    }
    return logs;
  }
}

type PostedMessage = typeof isPostedMessageEvent extends (
  arg: any
) => arg is infer R
  ? R
  : never;

export default {
  async fetch(
    request: Request,
    env: Env,
    ctx: ExecutionContext
  ): Promise<Response> {
    const url = new URL(request.url);

    // Analytics endpoints: /_analytics/db_size or /_analytics/logs
    if (url.pathname.startsWith("/_analytics/")) {
      const workspace = url.searchParams.get("workspace");
      const channel = url.searchParams.get("channel");

      if (!workspace || !channel) {
        return new Response(
          JSON.stringify({ error: "Missing workspace or channel query param" }),
          { status: 400, headers: { "Content-Type": "application/json" } }
        );
      }

      const id = env.POKER_DURABLE_OBJECT.idFromName(`${workspace}-${channel}`);
      const stub = env.POKER_DURABLE_OBJECT.get(id);

      // /_analytics/db_size?workspace=X&channel=Y
      if (url.pathname === "/_analytics/db_size") {
        const dbSize = await stub.getDatabaseSize();
        return new Response(JSON.stringify(dbSize, null, 2), {
          headers: { "Content-Type": "application/json" },
        });
      }

      // /_analytics/logs?workspace=X&channel=Y
      if (url.pathname === "/_analytics/logs") {
        const logs = await stub.getAllActionLogs();

        const { readable, writable } = new TransformStream();
        const writer = writable.getWriter();
        const encoder = new TextEncoder();

        ctx.waitUntil(
          (async () => {
            try {
              for (const log of logs) {
                await writer.write(encoder.encode(JSON.stringify(log) + "\n"));
              }
            } finally {
              await writer.close();
            }
          })()
        );

        return new Response(readable, {
          headers: {
            "Content-Type": "application/x-ndjson",
            "Transfer-Encoding": "chunked",
          },
        });
      }

      return new Response("Not found", { status: 404 });
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
      await context.say({ text: stockPriceMessage });
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
      if (handler !== newGame && handler !== joinGame && handler !== buyIn) {
        const messageAction: MessageReceivedActionV1 = {
          schemaVersion: 1,
          workspaceId: context.teamId!,
          channelId: context.channelId,
          timestamp: meta.timestamp,
          actionType: "message_received",
          messageText: meta.messageText,
          playerId: context.userId!,
          slackMessageTs: meta.slackMessageTs,
          normalizedText: meta.normalizedText,
          handlerKey: meta.handlerKey,
        };
        stub.logAction(messageAction);
      }
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

  if (!activePlayer) {
    await context.client.chat.postEphemeral({
      channel: context.channelId,
      user: context.userId!,
      text: ensureNarpBrainOnError("You are not in the game!"),
    });
    return;
  }

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

async function enableHubsOnlyMode(
  env: Env,
  context: SlackAppContextWithChannelId,
  _payload: PostedMessage
) {
  const stub = getDurableObject(env, context);
  stub.setHubsOnlyMode(context.teamId!, context.channelId, true);
  await context.say({
    text: ":lock: HUBS only mode enabled for this channel. Only the HUBS command will work until 'all commands' is typed.",
  });
}

async function disableHubsOnlyMode(
  env: Env,
  context: SlackAppContextWithChannelId,
  _payload: PostedMessage
) {
  const stub = getDurableObject(env, context);
  stub.setHubsOnlyMode(context.teamId!, context.channelId, false);
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

  const result = await stub.preDealWithAction({
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

  const result = await stub.preNHWithAction({
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

  const result = await stub.preAHWithAction({
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

  const result = await stub.preCheckWithAction({
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

  const result = await stub.preFoldWithAction({
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

  const result = await stub.preCallWithAction({
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

  const result = await stub.preBetWithAction({
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
      .replace("bet", "")
      .replace("donk", "")
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

  const result = await stub.betWithAction({
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

  const result = await stub.callWithAction({
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

  const result = await stub.allInWithAction({
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

  const result = await stub.checkWithAction({
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

  const result = await stub.thisPotAintBigEnoughWithAction({
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

  const result = await stub.takeHerToTheWithAction({
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

  const result = await stub.foldWithAction({
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

  const result = await stub.startRoundWithAction({
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

  // Display stock price when a hand starts (non-blocking, graceful failure)
  // Check if a round actually started (gameState is PreFlop)
  if (result.game.gameState === GameState.PreFlop) {
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

  const result = await stub.setStacksWithAction({
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

  const result = await stub.cashOutWithAction({
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

  const result = await stub.buyInWithAction({
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

  const result = await stub.leaveGameWithAction({
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

  const result = await stub.deletePlayerWithAction({
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

  const result = await stub.joinGameWithAction({
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

  const result = await stub.newGameWithAction({
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
  const game = await stub.fetchGame(workspaceId, channelId);

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
