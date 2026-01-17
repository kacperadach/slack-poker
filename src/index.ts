import { DurableObject } from "cloudflare:workers";
import {
  SlackApp,
  SlackEdgeAppEnv,
  isPostedMessageEvent,
} from "slack-cloudflare-workers";
import { GameState, TexasHoldem } from "./Game";
import { GameEvent } from "./GameEvent";
import { Player } from "./Player";
import { Card } from "./Card";

const { rankDescription, rankCards } = require("phe");

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
      flops.push(row);
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
}

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

async function handleMessage(env: Env, context, payload) {
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

async function getGameState(env, context, payload) {
  const game = await fetchGame(env, context);
  if (!game) {
    await context.say({ text: `No game exists! Type 'New Game'` });
    return;
  }

  game.getGameStateEvent();
  await sendGameEventMessages(env, context, game);
}

async function context(env, context, payload) {
  const game = await fetchGame(env, context);
  if (!game) {
    await context.client.chat.postEphemeral({
      channel: context.channelId,
      user: context.userId,
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
      user: context.userId,
      text: `You are not in the game!`,
    });
    return;
  }

  if (inactivePlayer) {
    await context.client.chat.postEphemeral({
      channel: context.channelId,
      user: context.userId,
      text: `You are inactive. You are not at the table.`,
    });
    return;
  }

  const player = activePlayer;

  // Determine if player can check or needs to call
  const currentBetAmount = game.getCurrentBetAmount();
  const playerCurrentBet = player.getCurrentBet();
  const foldedPlayers = game.getFoldedPlayers();
  const hasFolded = foldedPlayers.has(context.userId);

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
  const playerCards = game.getPlayerHand(context.userId);
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
    user: context.userId,
    text: message,
  });
}

async function searchFlops(env, context, payload) {
  const workspaceId = context.teamId;
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

async function showFlops(env, context, payload) {
  const workspaceId = context.teamId;
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

async function ass(env, context, payload) {
  await context.say({ text: "ASS" });
}

async function drillGto(env, context, payload) {
  await context.say({
    text: `<@${context.userId}> is drilling GTO! :drill-gto:`,
  });
}

async function nudgePlayer(env, context, payload) {
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

async function commitSeppuku(env, context, payload) {
  await context.say({ text: `Hai` });
}

async function scoreDice(env, context, payload) {
  const messageText = payload.text.toLowerCase();
  const scored = messageText.replace("score", "").trim();
  await context.say({ text: `Scored: ${scored}` });
}

async function keepDice(env, context, payload) {
  const messageText = payload.text.toLowerCase();
  const numbersToKeep = Array.from(messageText.replace("keep", "").trim())
    .map(Number)
    .filter((n) => !isNaN(n));
  await rollDice(env, context, payload, numbersToKeep);
}

async function rollDice(env, context, payload, keepDice: number[] = []) {
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

async function help(env, context, payload) {
  const commands = Object.keys(MESSAGE_HANDLERS).join("\n");
  await context.say({
    text: `Available commands:\n${commands
      .split("\n")
      .map((cmd) => `\`${cmd}\``)
      .join("\n")}`,
  });
}

async function revealCards(env, context, payload) {
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

  game.showCards(context.userId, true);
  await sendGameEventMessages(env, context, game);
}

async function showCards(env, context, payload) {
  const game = await fetchGame(env, context);
  if (!game) {
    await context.say({ text: `No game exists! Type 'New Game'` });
    return;
  }

  game.showCards(context.userId, false);
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

export async function preDeal(env, context, payload) {
  const game = await fetchGame(env, context);
  if (!game) {
    await context.say({ text: `No game exists! Type 'New Game'` });
    return;
  }

  game.preDeal(context.userId);
  await saveGame(env, context, game);
  await sendGameEventMessages(env, context, game);
}

export async function preNH(env, context, payload) {
  const game = await fetchGame(env, context);
  if (!game) {
    await context.say({ text: `No game exists! Type 'New Game'` });
    return;
  }

  game.preNH(context.userId);
  await saveGame(env, context, game);
  await sendGameEventMessages(env, context, game);
}

async function preAH(env, context, payload) {
  const game = await fetchGame(env, context);
  if (!game) {
    await context.say({ text: `No game exists! Type 'New Game'` });
    return;
  }

  game.preAH(context.userId);
  await saveGame(env, context, game);
  await sendGameEventMessages(env, context, game);
}

async function preCheck(env, context, payload) {
  const game = await fetchGame(env, context);
  if (!game) {
    await context.say({ text: `No game exists! Type 'New Game'` });
    return;
  }

  game.preCheck(context.userId);
  await saveGame(env, context, game);
  await sendGameEventMessages(env, context, game);
}

async function preFold(env, context, payload) {
  const game = await fetchGame(env, context);
  if (!game) {
    await context.say({ text: `No game exists! Type 'New Game'` });
    return;
  }

  game.preFold(context.userId);
  await saveGame(env, context, game);
  await sendGameEventMessages(env, context, game);
}

async function preCall(env, context, payload) {
  const game = await fetchGame(env, context);
  if (!game) {
    await context.say({ text: `No game exists! Type 'New Game'` });
    return;
  }

  game.preCall(context.userId);
  await saveGame(env, context, game);
  await sendGameEventMessages(env, context, game);
}

async function preBet(env, context, payload) {
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

  game.preBet(context.userId, betAmount);
  await saveGame(env, context, game);
  await sendGameEventMessages(env, context, game);
}

export async function bet(env, context, payload) {
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

  game.bet(context.userId, betAmount);
  await saveGame(env, context, game);
  await sendGameEventMessages(env, context, game);
}

export async function call(env, context, payload) {
  const game = await fetchGame(env, context);
  if (!game) {
    await context.say({ text: `No game exists! Type 'New Game'` });
    return;
  }

  game.call(context.userId);
  await saveGame(env, context, game);
  await sendGameEventMessages(env, context, game);
}

export async function check(env, context, payload) {
  const game = await fetchGame(env, context);
  if (!game) {
    await context.say({ text: `No game exists! Type 'New Game'` });
    return;
  }

  game.check(context.userId);
  await saveGame(env, context, game);
  await sendGameEventMessages(env, context, game);
}

export async function fold(env, context, payload) {
  const game = await fetchGame(env, context);
  if (!game) {
    await context.say({ text: `No game exists! Type 'New Game'` });
    return;
  }

  game.fold(context.userId);
  await saveGame(env, context, game);
  await sendGameEventMessages(env, context, game);
}

export async function startRound(env, context, payload) {
  const game = await fetchGame(env, context);
  if (!game) {
    await context.say({ text: `No game exists! Type 'New Game'` });
    return;
  }

  game.startRound(context.userId);
  await saveGame(env, context, game);
  await sendGameEventMessages(env, context, game);
}

async function showChips(env, context, payload) {
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

async function cashOut(env, context, payload) {
  const game = await fetchGame(env, context);
  if (!game) {
    await context.say({ text: `No game exists! Type 'New Game'` });
    return;
  }

  game.cashOut(context.userId);
  await saveGame(env, context, game);
  await sendGameEventMessages(env, context, game);
}

export async function buyIn(env, context, payload: { text: string }) {
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

  game.buyIn(context.userId, buyInAmount);
  await saveGame(env, context, game);
  await sendGameEventMessages(env, context, game);
}

async function leaveGame(env, context) {
  const game = await fetchGame(env, context);
  if (!game) {
    await context.say({ text: `No game exists! Type 'New Game'` });
    return;
  }

  game.removePlayer(context.userId);
  await saveGame(env, context, game);
  await sendGameEventMessages(env, context, game);
}

export async function joinGame(env, context) {
  const game = await fetchGame(env, context);
  if (!game) {
    await context.say({ text: `No game exists! Type 'New Game'` });
    return;
  }

  game.addPlayer(context.userId);
  await saveGame(env, context, game);
  await sendGameEventMessages(env, context, game);
}

export async function newGame(env, context) {
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
  stub.createGame(
    context.teamId,
    context.channelId,
    JSON.stringify(new TexasHoldem().toJson())
  );
  await context.say({ text: `New Poker Game created!` });
}

async function fetchGame(env, context) {
  const workspaceId = context.teamId;
  const channelId = context.channelId;
  const stub = getDurableObject(env, context);
  const game = await stub.fetchGame(workspaceId, channelId);

  if (!game) {
    return null;
  }

  return TexasHoldem.fromJson(game);
}

async function saveGame(env, context, game: TexasHoldem) {
  const workspaceId = context.teamId;
  const channelId = context.channelId;
  const stub = getDurableObject(env, context);

  await stub.saveGame(workspaceId, channelId, JSON.stringify(game.toJson()));
}

function getDurableObject(env, context) {
  const workspaceId = context.teamId;
  const channelId = context.channelId;

  const id: DurableObjectId = env.POKER_DURABLE_OBJECT.idFromName(
    `${workspaceId}-${channelId}`
  );

  return env.POKER_DURABLE_OBJECT.get(id);
}

async function sendGameEventMessages(env, context, game: TexasHoldem) {
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

      const workspaceId = context.teamId;
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
        const human = new Date(flop.createdAt).toLocaleDateString("en-US", {
          year: "numeric",
          month: "2-digit",
          day: "2-digit",
        });
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

function formatFlop(flop) {
  const date = new Date(flop.createdAt).toLocaleDateString("en-US", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  });
  return `${flop.flop.replace(/[dhsc]/g, (match: any) => {
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
