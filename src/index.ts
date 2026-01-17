import { DurableObject } from "cloudflare:workers";
import {
  AnyMessageEvent,
  SlackApp,
  SlackAppContextWithChannelId,
  isPostedMessageEvent,
} from "slack-cloudflare-workers";
import { GameState, TexasHoldem } from "./Game";
import { Card } from "./Card";
// @ts-ignore phe is not typed
import { rankDescription, rankCards } from "phe";
import { userIdToName } from "./users";
import type { ActionLogEntry } from "./ActionLog";

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
} satisfies ExportedHandler<Env>;

const ALGO_MESSAGE =
  "Complaining about the algo? How about you try tightening up ranges, punishing leaks, and owning your position. Cut trash hands, widen late, and 3-bet light when stacks and image align. Always clock SPR, ICM, and blocker dynamics. Dont just run hot—range merge, polarize, and balance frequencies. Table select like a shark, exploit the fish, and never bleed chips OOP. To level up: study solvers, drill GTO, then weaponize exploit when villains deviate.";

const MESSAGE_HANDLERS = {
  "new game": newGame,
  "join table": joinGame,
  "leave table": leaveGame,
  "buy in": buyIn,
  "cash out": cashOut,
  chipnado: showChips,
  "start round": startRound,
  deal: startRound,
  roll: rollDice,
  keep: keepDice,
  score: scoreDice,
  fold: fold,
  check: check,
  call: call,
  bet: bet,
  precheck: preCheck,
  "pre-check": preCheck,
  prefold: preFold,
  "pre-fold": preFold,
  precall: preCall,
  "pre-call": preCall,
  prebet: preBet,
  "pre-bet": preBet,
  cards: showCards,
  dards: showCards,
  reveal: revealCards,
  rank: getGameState,
  help: help,
  poke: nudgePlayer,
  "it'll be a poke for me": nudgePlayer,
  seppuku: commitSeppuku,
  ":phone:": call,
  chexk: check,
  "i choose to call": call,
  "i choose to check": check,
  "i choose to fold": fold,
  "i choose to bet": bet,
  "i choose to pre-check": preCheck,
  "i choose to precheck": preCheck,
  "i choose to pre-fold": preFold,
  "i choose to prefold": preFold,
  "i choose to pre-call": preCall,
  "i choose to precall": preCall,
  "i choose to pre-bet": preBet,
  "i choose to prebet": preBet,
  "i choose to deal": startRound,
  "i choose to predeal": preDeal,
  "i choose to pre-deal": preDeal,
  "i choose to roll": rollDice,
  "i choose to see my dards": showCards,
  "i choose to cut my trash hand": fold,
  "i choose to poke": nudgePlayer,
  "its going to be a call for me": call,
  "itll be a call for me": call,
  "its gonna be a call for me": call,
  "its going to be a precall for me": preCall,
  "itll be a precall for me": preCall,
  "its gonna be a precall for me": preCall,
  "its going to be a precheck for me": preCheck,
  "itll be a precheck for me": preCheck,
  "its gonna be a precheck for me": preCheck,
  "its going to be a prefold for me": preFold,
  "itll be a prefold for me": preFold,
  "its gonna be a prefold for me": preFold,
  "its going to be a check for me": check,
  "itll be a check for me": check,
  "its gonna be a check for me": check,
  "too rich for me": fold,
  "its going to be a fold for me": fold,
  "itll be a fold for me": fold,
  "its gonna be a fold for me": fold,
  "im gonna go ahead and bet": bet,
  "im gonna go ahead and check": check,
  "im gonna go ahead and fold": fold,
  "im gonna go ahead and precall": preCall,
  "im gonna go ahead and precheck": preCheck,
  "im gonna go ahead and prefold": preFold,
  "im gonna go ahead and prebet": preBet,
  "im gonna go ahead and donk": bet,
  "im gonna go ahead and call": call,
  "im gonna go ahead and poke": nudgePlayer,
  "drill gto": drillGto,
  "i choose to drill gto": drillGto,
  donk: bet,
  "i choose to donk": bet,
  d: showCards,
  c: context,
  a: ass,
  cjecl: check,
  prenh: preNH,
  preah: preAH,
  predeal: preDeal,
  tsa: preCheck,
  flops: showFlops,
  fsearch: searchFlops,
  context: context,
  stacks: showStacks,
  "lets take her to the flop": takeHerToThe,
  "lets take her to the turn": takeHerToThe,
  "lets take her to the river": takeHerToThe,
};

function cleanMessageText(messageText: string) {
  return messageText
    .toLowerCase()
    .replace(/'/g, "")
    .replace(/oh+\s*buddy\s*/g, "")
    .replace(/shi+/g, "")
    .replace(/fu+ck/g, "")
    .trim();
}

async function handleMessage(
  env: Env,
  context: SlackAppContextWithChannelId,
  payload: PostedMessage
) {
  if (!isPostedMessageEvent(payload)) {
    return;
  }

  const messageText = cleanMessageText(payload.text);

  if (messageText.includes("algo")) {
    await context.say({ text: ALGO_MESSAGE });
    return;
  }

  for (const [key, handler] of Object.entries(MESSAGE_HANDLERS)) {
    if (messageText.startsWith(key)) {
      await handler(env, context, payload);
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
    await context.say({ text: `No game exists! Type 'New Game'` });
    return;
  }

  game.getGameStateEvent();
  await sendGameEventMessages(env, context, game);
}

async function context(
  env: Env,
  context: SlackAppContextWithChannelId,
  _payload: PostedMessage
) {
  const game = await fetchGame(env, context);
  if (!game) {
    await context.client.chat.postEphemeral({
      channel: context.channelId,
      user: context.userId!,
      text: `No game exists! Type 'New Game'`,
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
      text: `You are not in the game!`,
    });
    return;
  }

  if (inactivePlayer) {
    await context.client.chat.postEphemeral({
      channel: context.channelId,
      user: context.userId!,
      text: `You are inactive. You are not at the table.`,
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

export async function nudgePlayer(
  env: Env,
  context: SlackAppContextWithChannelId,
  _payload: PostedMessage
) {
  const game = await fetchGame(env, context);
  if (!game) {
    await context.say({ text: `No game exists! Type 'New Game'` });
    return;
  }

  if (game.getGameState() === GameState.WaitingForPlayers) {
    await context.say({
      text: "Game has not started yet! Who the hell am I going to nudge?",
    });
    return;
  }

  const currentPlayer = game.getCurrentPlayer();
  if (!currentPlayer) {
    await context.say({
      text: "No current player which means the code is ASS",
    });
    return;
  }

  await context.say({
    text: `<@${currentPlayer.getId()}> it's your turn and you need to roll!`,
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

export async function revealCards(
  env: Env,
  context: SlackAppContextWithChannelId,
  _payload: PostedMessage
) {
  const game = await fetchGame(env, context);
  if (!game) {
    await context.say({ text: `No game exists! Type 'New Game'` });
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

export async function showCards(
  env: Env,
  context: SlackAppContextWithChannelId,
  _payload: PostedMessage
) {
  const game = await fetchGame(env, context);
  if (!game) {
    await context.say({ text: `No game exists! Type 'New Game'` });
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
  payload: PostedMessage
) {
  const game = await fetchGame(env, context);
  if (!game) {
    await context.say({ text: `No game exists! Type 'New Game'` });
    return;
  }

  game.preDeal(context.userId!);
  await saveGameWithAction(env, context, game, {
    schemaVersion: 1,
    workspaceId: context.teamId!,
    channelId: context.channelId,
    timestamp: Date.now(),
    actionType: "pre_deal",
    messageText: payload.text ?? "",
    playerId: context.userId!,
  });
  await sendGameEventMessages(env, context, game);
}

export async function preNH(
  env: Env,
  context: SlackAppContextWithChannelId,
  payload: PostedMessage
) {
  const game = await fetchGame(env, context);
  if (!game) {
    await context.say({ text: `No game exists! Type 'New Game'` });
    return;
  }

  game.preNH(context.userId!);
  await saveGameWithAction(env, context, game, {
    schemaVersion: 1,
    workspaceId: context.teamId!,
    channelId: context.channelId,
    timestamp: Date.now(),
    actionType: "pre_deal",
    messageText: payload.text ?? "",
    playerId: context.userId!,
  });
  await sendGameEventMessages(env, context, game);
}

export async function preAH(
  env: Env,
  context: SlackAppContextWithChannelId,
  payload: PostedMessage
) {
  const game = await fetchGame(env, context);
  if (!game) {
    await context.say({ text: `No game exists! Type 'New Game'` });
    return;
  }

  game.preAH(context.userId!);
  await saveGameWithAction(env, context, game, {
    schemaVersion: 1,
    workspaceId: context.teamId!,
    channelId: context.channelId,
    timestamp: Date.now(),
    actionType: "pre_deal",
    messageText: payload.text ?? "",
    playerId: context.userId!,
  });
  await sendGameEventMessages(env, context, game);
}

export async function preCheck(
  env: Env,
  context: SlackAppContextWithChannelId,
  payload: PostedMessage
) {
  const game = await fetchGame(env, context);
  if (!game) {
    await context.say({ text: `No game exists! Type 'New Game'` });
    return;
  }

  game.preCheck(context.userId!);
  await saveGameWithAction(env, context, game, {
    schemaVersion: 1,
    workspaceId: context.teamId!,
    channelId: context.channelId,
    timestamp: Date.now(),
    actionType: "pre_action",
    messageText: payload.text ?? "",
    playerId: context.userId!,
    queuedAction: "check",
  });
  await sendGameEventMessages(env, context, game);
}

export async function preFold(
  env: Env,
  context: SlackAppContextWithChannelId,
  payload: PostedMessage
) {
  const game = await fetchGame(env, context);
  if (!game) {
    await context.say({ text: `No game exists! Type 'New Game'` });
    return;
  }

  game.preFold(context.userId!);
  await saveGameWithAction(env, context, game, {
    schemaVersion: 1,
    workspaceId: context.teamId!,
    channelId: context.channelId,
    timestamp: Date.now(),
    actionType: "pre_action",
    messageText: payload.text ?? "",
    playerId: context.userId!,
    queuedAction: "fold",
  });
  await sendGameEventMessages(env, context, game);
}

export async function preCall(
  env: Env,
  context: SlackAppContextWithChannelId,
  payload: PostedMessage
) {
  const game = await fetchGame(env, context);
  if (!game) {
    await context.say({ text: `No game exists! Type 'New Game'` });
    return;
  }

  game.preCall(context.userId!);
  await saveGameWithAction(env, context, game, {
    schemaVersion: 1,
    workspaceId: context.teamId!,
    channelId: context.channelId,
    timestamp: Date.now(),
    actionType: "pre_action",
    messageText: payload.text ?? "",
    playerId: context.userId!,
    queuedAction: "call",
  });
  await sendGameEventMessages(env, context, game);
}

export async function preBet(
  env: Env,
  context: SlackAppContextWithChannelId,
  payload: PostedMessage
) {
  const messageText = payload.text.toLowerCase();
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
      text: 'Invalid bet amount! Please use format: "pre-bet {chips}"',
    });
    return;
  }

  const game = await fetchGame(env, context);
  if (!game) {
    await context.say({ text: `No game exists! Type 'New Game'` });
    return;
  }

  game.preBet(context.userId!, betAmount);
  await saveGameWithAction(env, context, game, {
    schemaVersion: 1,
    workspaceId: context.teamId!,
    channelId: context.channelId,
    timestamp: Date.now(),
    actionType: "pre_action",
    messageText: payload.text ?? "",
    playerId: context.userId!,
    queuedAction: "bet",
    amount: betAmount,
  });
  await sendGameEventMessages(env, context, game);
}

export async function bet(
  env: Env,
  context: SlackAppContextWithChannelId,
  payload: PostedMessage
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
      text: 'Invalid bet amount! Please use format: "bet {chips}"',
    });
    return;
  }

  const game = await fetchGame(env, context);
  if (!game) {
    await context.say({ text: `No game exists! Type 'New Game'` });
    return;
  }

  game.bet(context.userId!, betAmount);
  await saveGameWithAction(env, context, game, {
    schemaVersion: 1,
    workspaceId: context.teamId!,
    channelId: context.channelId,
    timestamp: Date.now(),
    actionType: "bet",
    messageText: payload.text ?? "",
    playerId: context.userId!,
    amount: betAmount,
  });
  await sendGameEventMessages(env, context, game);
}

export async function call(
  env: Env,
  context: SlackAppContextWithChannelId,
  payload: PostedMessage
) {
  const game = await fetchGame(env, context);
  if (!game) {
    await context.say({ text: `No game exists! Type 'New Game'` });
    return;
  }

  const callAmount =
    game.getCurrentBetAmount() -
    (game.getCurrentPlayer()?.getCurrentBet() ?? 0);
  game.call(context.userId!);
  await saveGameWithAction(env, context, game, {
    schemaVersion: 1,
    workspaceId: context.teamId!,
    channelId: context.channelId,
    timestamp: Date.now(),
    actionType: "call",
    messageText: payload.text ?? "",
    playerId: context.userId!,
    amount: callAmount,
  });
  await sendGameEventMessages(env, context, game);
}

export async function check(
  env: Env,
  context: SlackAppContextWithChannelId,
  payload: PostedMessage
) {
  const game = await fetchGame(env, context);
  if (!game) {
    await context.say({ text: `No game exists! Type 'New Game'` });
    return;
  }

  game.check(context.userId!);
  await saveGameWithAction(env, context, game, {
    schemaVersion: 1,
    workspaceId: context.teamId!,
    channelId: context.channelId,
    timestamp: Date.now(),
    actionType: "check",
    messageText: payload.text ?? "",
    playerId: context.userId!,
  });
  await sendGameEventMessages(env, context, game);
}

export async function takeHerToThe(
  env: Env,
  context: SlackAppContextWithChannelId,
  payload: PostedMessage
) {
  const game = await fetchGame(env, context);
  if (!game) {
    await context.say({ text: `No game exists! Type 'New Game'` });
    return;
  }

  const messageText = cleanMessageText(payload.text);
  const currentState = game.getGameState();

  // Match exact phrases and validate game state
  if (messageText.startsWith("lets take her to the flop")) {
    if (currentState !== GameState.PreFlop) {
      await context.say({
        text: `We're not in pre-flop! Can't take her to the flop from here.`,
      });
      return;
    }
  } else if (messageText.startsWith("lets take her to the turn")) {
    if (currentState !== GameState.Flop) {
      await context.say({
        text: `We're not on the flop! Can't take her to the turn from here.`,
      });
      return;
    }
  } else if (messageText.startsWith("lets take her to the river")) {
    if (currentState !== GameState.Turn) {
      await context.say({
        text: `We're not on the turn! Can't take her to the river from here.`,
      });
      return;
    }
  } else {
    return;
  }

  // Determine if this is a call or check
  const currentBet = game.getCurrentBetAmount();
  const playerBet = game.getCurrentPlayer()?.getCurrentBet() ?? 0;
  const isCall = currentBet > playerBet;

  game.callOrCheck(context.userId!);

  if (isCall) {
    await saveGameWithAction(env, context, game, {
      schemaVersion: 1,
      workspaceId: context.teamId!,
      channelId: context.channelId,
      timestamp: Date.now(),
      actionType: "call",
      messageText: payload.text ?? "",
      playerId: context.userId!,
      amount: currentBet - playerBet,
    });
  } else {
    await saveGameWithAction(env, context, game, {
      schemaVersion: 1,
      workspaceId: context.teamId!,
      channelId: context.channelId,
      timestamp: Date.now(),
      actionType: "check",
      messageText: payload.text ?? "",
      playerId: context.userId!,
    });
  }
  await sendGameEventMessages(env, context, game);
}

export async function fold(
  env: Env,
  context: SlackAppContextWithChannelId,
  payload: PostedMessage
) {
  const game = await fetchGame(env, context);
  if (!game) {
    await context.say({ text: `No game exists! Type 'New Game'` });
    return;
  }

  game.fold(context.userId!);
  await saveGameWithAction(env, context, game, {
    schemaVersion: 1,
    workspaceId: context.teamId!,
    channelId: context.channelId,
    timestamp: Date.now(),
    actionType: "fold",
    messageText: payload.text ?? "",
    playerId: context.userId!,
  });
  await sendGameEventMessages(env, context, game);
}

export async function startRound(
  env: Env,
  context: SlackAppContextWithChannelId,
  payload: PostedMessage
) {
  const game = await fetchGame(env, context);
  if (!game) {
    await context.say({ text: `No game exists! Type 'New Game'` });
    return;
  }

  game.startRound(context.userId!);

  // Build round_start action with all the round initialization data
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

  // Get community cards from deck (they're predetermined at shuffle)
  const communityCards = state.communityCards.map((c) => c.toString());
  // Pad to 5 cards if not all dealt yet - get from deck
  const fullCommunityCards: [string, string, string, string, string] = [
    communityCards[0] ?? "",
    communityCards[1] ?? "",
    communityCards[2] ?? "",
    communityCards[3] ?? "",
    communityCards[4] ?? "",
  ];

  // Determine small blind and big blind players
  const numPlayers = playerOrder.length;
  const dealerPos = state.dealerPosition;
  const sbPos = numPlayers === 2 ? dealerPos : (dealerPos + 1) % numPlayers;
  const bbPos =
    numPlayers === 2
      ? (dealerPos + 1) % numPlayers
      : (dealerPos + 2) % numPlayers;

  await saveGameWithAction(env, context, game, {
    schemaVersion: 1,
    workspaceId: context.teamId!,
    channelId: context.channelId,
    timestamp: Date.now(),
    actionType: "round_start",
    messageText: payload.text ?? "",
    roundNumber: state.dealerPosition, // Use as proxy for round number for now
    dealerPosition: state.dealerPosition,
    playerOrder,
    playerStacks,
    playerCards,
    communityCards: fullCommunityCards,
    smallBlindPlayerId: playerOrder[sbPos] ?? "",
    smallBlindAmount: state.smallBlind * 4, // Game uses 4x multiplier
    bigBlindPlayerId: playerOrder[bbPos] ?? "",
    bigBlindAmount: state.bigBlind * 4,
  });
  await sendGameEventMessages(env, context, game);
}

export async function showChips(
  env: Env,
  context: SlackAppContextWithChannelId,
  _payload: PostedMessage
) {
  const game = await fetchGame(env, context);
  if (!game) {
    await context.say({ text: `No game exists! Type 'New Game'` });
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
    await context.say({ text: `No game exists! Type 'New Game'` });
    return;
  }

  let message = "*Stacks*\n";
  game.getActivePlayers().forEach((player) => {
    const name =
      userIdToName[player.getId() as keyof typeof userIdToName] ||
      player.getId();
    message += `${name}: ${player.getChips()} (Active)\n`;
  });

  game.getInactivePlayers().forEach((player) => {
    const name =
      userIdToName[player.getId() as keyof typeof userIdToName] ||
      player.getId();
    message += `${name}: ${player.getChips()} (Inactive)\n`;
  });

  await context.say({ text: message });
}

export async function cashOut(
  env: Env,
  context: SlackAppContextWithChannelId,
  payload: PostedMessage
) {
  const game = await fetchGame(env, context);
  if (!game) {
    await context.say({ text: `No game exists! Type 'New Game'` });
    return;
  }

  const allPlayers = [...game.getActivePlayers(), ...game.getInactivePlayers()];
  const player = allPlayers.find((p) => p.getId() === context.userId);
  const cashOutAmount = player?.getChips() ?? 0;
  game.cashOut(context.userId!);
  await saveGameWithAction(env, context, game, {
    schemaVersion: 1,
    workspaceId: context.teamId!,
    channelId: context.channelId,
    timestamp: Date.now(),
    actionType: "cash_out",
    messageText: payload.text ?? "",
    playerId: context.userId!,
    amount: cashOutAmount,
  });
  await sendGameEventMessages(env, context, game);
}

export async function buyIn(
  env: Env,
  context: SlackAppContextWithChannelId,
  payload: PostedMessage
) {
  const messageText = payload.text.toLowerCase();
  const buyInAmount = parseFloat(messageText.replace("buy in", "").trim());

  if (isNaN(buyInAmount) || buyInAmount <= 0) {
    await context.say({
      text: 'Invalid buy in amount! Please use format: "buy in {chips}"',
    });
    return;
  }

  const game = await fetchGame(env, context);
  if (!game) {
    await context.say({ text: `No game exists! Type 'New Game'` });
    return;
  }

  game.buyIn(context.userId!, buyInAmount);
  await saveGameWithAction(env, context, game, {
    schemaVersion: 1,
    workspaceId: context.teamId!,
    channelId: context.channelId,
    timestamp: Date.now(),
    actionType: "buy_in",
    messageText: payload.text ?? "",
    playerId: context.userId!,
    amount: buyInAmount,
  });
  await sendGameEventMessages(env, context, game);
}

export async function leaveGame(
  env: Env,
  context: SlackAppContextWithChannelId,
  payload: PostedMessage
) {
  const game = await fetchGame(env, context);
  if (!game) {
    await context.say({ text: `No game exists! Type 'New Game'` });
    return;
  }

  game.removePlayer(context.userId!);
  await saveGameWithAction(env, context, game, {
    schemaVersion: 1,
    workspaceId: context.teamId!,
    channelId: context.channelId,
    timestamp: Date.now(),
    actionType: "leave",
    messageText: payload.text ?? "",
    playerId: context.userId!,
  });
  await sendGameEventMessages(env, context, game);
}

export async function joinGame(
  env: Env,
  context: SlackAppContextWithChannelId,
  payload: PostedMessage
) {
  const game = await fetchGame(env, context);
  if (!game) {
    await context.say({ text: `No game exists! Type 'New Game'` });
    return;
  }

  game.addPlayer(context.userId!);
  await saveGameWithAction(env, context, game, {
    schemaVersion: 1,
    workspaceId: context.teamId!,
    channelId: context.channelId,
    timestamp: Date.now(),
    actionType: "join",
    messageText: payload.text ?? "",
    playerId: context.userId!,
  });
  await sendGameEventMessages(env, context, game);
}

export async function newGame(
  env: Env,
  context: SlackAppContextWithChannelId,
  payload: PostedMessage
) {
  const game = await fetchGame(env, context);
  if (game) {
    const allPlayers = [
      ...game.getActivePlayers(),
      ...game.getInactivePlayers(),
    ];
    for (const player of allPlayers) {
      if (player.getChips() !== 0) {
        await context.say({
          text: `Cannot start new game - ${player.getId()} still has chips!`,
        });
        return;
      }
    }
  }
  const stub = getDurableObject(env, context);
  const newGameInstance = new TexasHoldem();
  stub.createGame(
    context.teamId!,
    context.channelId,
    JSON.stringify(newGameInstance.toJson())
  );
  // Log the new_game action
  stub.logAction({
    schemaVersion: 1,
    workspaceId: context.teamId!,
    channelId: context.channelId,
    timestamp: Date.now(),
    actionType: "new_game",
    messageText: payload.text ?? "",
    playerId: context.userId!,
    smallBlind: newGameInstance.getSmallBlind(),
    bigBlind: newGameInstance.getBigBlind(),
  });
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

async function saveGame(
  env: Env,
  context: SlackAppContextWithChannelId,
  game: TexasHoldem
) {
  const workspaceId = context.teamId!;
  const channelId = context.channelId;
  const stub = getDurableObject(env, context);

  await stub.saveGame(workspaceId, channelId, JSON.stringify(game.toJson()));
}

async function saveGameWithAction(
  env: Env,
  context: SlackAppContextWithChannelId,
  game: TexasHoldem,
  action: ActionLogEntry
) {
  const workspaceId = context.teamId!;
  const channelId = context.channelId;
  const stub = getDurableObject(env, context);

  await stub.saveGameWithAction(
    workspaceId,
    channelId,
    JSON.stringify(game.toJson()),
    action
  );
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
    // Replace all player IDs in message with @mentions
    // TODO: maybe do it without replacement
    playerIds.forEach((playerId) => {
      message = message.replace(new RegExp(playerId, "g"), `<@${playerId}>`);
    });

    if (event.isEphemeral()) {
      await context.client.chat.postEphemeral({
        channel: context.channelId,
        user: event.getPlayerId(),
        text: message,
      });
    } else {
      publicMessages.push(message);
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
