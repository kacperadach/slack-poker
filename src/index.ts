import { DurableObject } from 'cloudflare:workers';
import { SlackApp, SlackEdgeAppEnv, isPostedMessageEvent } from 'slack-cloudflare-workers';
import { GameState, TexasHoldem } from './Game';
import { GameEvent } from './GameEvent';
import { Player } from './Player';
import { Card } from './Card';

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

	addFlop(workspaceId: string, channelId: string, flop: string, createdAt: number): void {
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
			.one();

		if (!game) {
			return null;
		}

		return JSON.parse(game.game as string);
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
	async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
		const app = new SlackApp({ env }).event('message', async ({ context, payload }) => {
			if (!isPostedMessageEvent(payload)) {
				return;
			}
			await handleMessage(env, context, payload);
			// context.say;
		});
		return await app.run(request, ctx);
	},
} satisfies ExportedHandler<Env>;

const MESSAGE_HANDLERS = {
	'new game': newGame,
	'join table': joinGame,
	'leave table': leaveGame,
	'buy in': buyIn,
	'cash out': cashOut,
	chipnado: showChips,
	'start round': startRound,
	deal: startRound,
	roll: rollDice,
	keep: keepDice,
	score: scoreDice,
	fold: fold,
	check: check,
	call: call,
	bet: bet,
	precheck: preCheck,
	'pre-check': preCheck,
	prefold: preFold,
	'pre-fold': preFold,
	precall: preCall,
	'pre-call': preCall,
	prebet: preBet,
	'pre-bet': preBet,
	cards: showCards,
	dards: showCards,
	reveal: revealCards,
	rank: getGameState,
	help: help,
	poke: nudgePlayer,
	seppuku: commitSeppuku,
	':phone:': call,
	chexk: check,
	'i choose to call': call,
	'i choose to check': check,
	'i choose to fold': fold,
	'i choose to bet': bet,
	'i choose to pre-check': preCheck,
	'i choose to precheck': preCheck,
	'i choose to pre-fold': preFold,
	'i choose to prefold': preFold,
	'i choose to pre-call': preCall,
	'i choose to precall': preCall,
	'i choose to pre-bet': preBet,
	'i choose to prebet': preBet,
	d: showCards,
	a: ass,
	cjecl: check,
	prenh: preNH,
	preah: preAH,
	predeal: preDeal,
	tsa: preCheck,
	flops: showFlops,
};

async function handleMessage(env: Env, context, payload) {
	if (!isPostedMessageEvent(payload)) {
		return;
	}

	const messageText = payload.text.trim();

	for (const [key, handler] of Object.entries(MESSAGE_HANDLERS)) {
		if (messageText.toLowerCase().startsWith(key)) {
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

async function showFlops(env, context, payload) {
	const workspaceId = context.teamId;
	const channelId = context.channelId;
	const stub = getDurableObject(env, context);

	const flops = await stub.getFlops(workspaceId, channelId);

	let message = '';

	for (const flop of flops) {
		const date = new Date(flop.createdAt).toLocaleDateString('en-US', {
			year: 'numeric',
			month: '2-digit',
			day: '2-digit',
		});
		// message += `${flop.flop
		// 	.replaceAll('d', ':diamonds:')
		// 	.replaceAll('s', ':spades:')
		// 	.replaceAll('h', ':hearts:')
		// 	.replaceAll('c', ':clubs:')} on ${date}\n`;
		message += `${flop.flop.replace(/[dhsc]/g, (match: any) => {
			switch (match) {
				case 'd':
					return ':diamonds:';
				case 'h':
					return ':hearts:';
				case 's':
					return ':spades:';
				case 'c':
					return ':clubs:';
				default:
					return match;
			}
		})} on ${date}\n`;
	}

	await context.say({ text: message });
}

async function ass(env, context, payload) {
	await context.say({ text: 'ASS' });
}

async function nudgePlayer(env, context, payload) {
	const game = await fetchGame(env, context);
	if (!game) {
		await context.say({ text: `No game exists! Type 'New Game'` });
		return;
	}

	if (game.getGameState() === GameState.WaitingForPlayers) {
		await context.say({ text: 'Game has not started yet! Who the hell am I going to nudge?' });
		return;
	}

	const currentPlayer = game.getCurrentPlayer();
	if (!currentPlayer) {
		await context.say({ text: 'No current player which means the code is ASS' });
		return;
	}

	await context.say({ text: `<@${currentPlayer.getId()}> it's your turn and you need to roll!` });
}

async function commitSeppuku(env, context, payload) {
	await context.say({ text: `Hai` });
}

async function scoreDice(env, context, payload) {
	const messageText = payload.text.toLowerCase();
	const scored = messageText.replace('score', '').trim();
	await context.say({ text: `Scored: ${scored}` });
}

async function keepDice(env, context, payload) {
	const messageText = payload.text.toLowerCase();
	const numbersToKeep = Array.from(messageText.replace('keep', '').trim())
		.map(Number)
		.filter((n) => !isNaN(n));
	await rollDice(env, context, payload, numbersToKeep);
}

async function rollDice(env, context, payload, keepDice: number[] = []) {
	const diceRolls = [...keepDice, ...Array.from({ length: 5 - keepDice.length }, () => Math.floor(Math.random() * 6) + 1)];
	diceRolls.sort((a, b) => a - b);
	await context.say({ text: `Here are some dice: *${diceRolls.join(' ')}*` });
}

async function help(env, context, payload) {
	const commands = Object.keys(MESSAGE_HANDLERS).join('\n');
	await context.say({
		text: `Available commands:\n${commands
			.split('\n')
			.map((cmd) => `\`${cmd}\``)
			.join('\n')}`,
	});
}

async function revealCards(env, context, payload) {
	const game = await fetchGame(env, context);
	if (!game) {
		await context.say({ text: `No game exists! Type 'New Game'` });
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

async function preDeal(env, context, payload) {
	const game = await fetchGame(env, context);
	if (!game) {
		await context.say({ text: `No game exists! Type 'New Game'` });
		return;
	}

	game.preDeal(context.userId);
	saveGame(env, context, game);
	await sendGameEventMessages(env, context, game);
}

async function preNH(env, context, payload) {
	const game = await fetchGame(env, context);
	if (!game) {
		await context.say({ text: `No game exists! Type 'New Game'` });
		return;
	}

	game.preNH(context.userId);
	saveGame(env, context, game);
	await sendGameEventMessages(env, context, game);
}

async function preAH(env, context, payload) {
	const game = await fetchGame(env, context);
	if (!game) {
		await context.say({ text: `No game exists! Type 'New Game'` });
		return;
	}

	game.preAH(context.userId);
	saveGame(env, context, game);
	await sendGameEventMessages(env, context, game);
}

async function preCheck(env, context, payload) {
	const game = await fetchGame(env, context);
	if (!game) {
		await context.say({ text: `No game exists! Type 'New Game'` });
		return;
	}

	game.preCheck(context.userId);
	saveGame(env, context, game);
	await sendGameEventMessages(env, context, game);
}

async function preFold(env, context, payload) {
	const game = await fetchGame(env, context);
	if (!game) {
		await context.say({ text: `No game exists! Type 'New Game'` });
		return;
	}

	game.preFold(context.userId);
	saveGame(env, context, game);
	await sendGameEventMessages(env, context, game);
}

async function preCall(env, context, payload) {
	const game = await fetchGame(env, context);
	if (!game) {
		await context.say({ text: `No game exists! Type 'New Game'` });
		return;
	}

	game.preCall(context.userId);
	saveGame(env, context, game);
	await sendGameEventMessages(env, context, game);
}

async function preBet(env, context, payload) {
	const messageText = payload.text.toLowerCase();
	const betAmount = parseFloat(messageText.replace('i choose to', '').replace('bet', '').replace('pre', '').replace('-', '').trim());

	if (isNaN(betAmount) || betAmount <= 0) {
		await context.say({ text: 'Invalid bet amount! Please use format: "pre-bet {chips}"' });
		return;
	}

	const game = await fetchGame(env, context);
	if (!game) {
		await context.say({ text: `No game exists! Type 'New Game'` });
		return;
	}

	game.preBet(context.userId, betAmount);
	saveGame(env, context, game);
	await sendGameEventMessages(env, context, game);
}

async function bet(env, context, payload) {
	const messageText = payload.text.toLowerCase();
	const betAmount = parseFloat(messageText.replace('i choose to', '').replace('bet', '').trim());

	if (isNaN(betAmount) || betAmount <= 0) {
		await context.say({ text: 'Invalid bet amount! Please use format: "bet {chips}"' });
		return;
	}

	const game = await fetchGame(env, context);
	if (!game) {
		await context.say({ text: `No game exists! Type 'New Game'` });
		return;
	}

	game.bet(context.userId, betAmount);
	saveGame(env, context, game);
	await sendGameEventMessages(env, context, game);
}

async function call(env, context, payload) {
	const game = await fetchGame(env, context);
	if (!game) {
		await context.say({ text: `No game exists! Type 'New Game'` });
		return;
	}

	game.call(context.userId);
	saveGame(env, context, game);
	await sendGameEventMessages(env, context, game);
}

async function check(env, context, payload) {
	const game = await fetchGame(env, context);
	if (!game) {
		await context.say({ text: `No game exists! Type 'New Game'` });
		return;
	}

	game.check(context.userId);
	saveGame(env, context, game);
	await sendGameEventMessages(env, context, game);
}

async function fold(env, context, payload) {
	const game = await fetchGame(env, context);
	if (!game) {
		await context.say({ text: `No game exists! Type 'New Game'` });
		return;
	}

	game.fold(context.userId);
	saveGame(env, context, game);
	await sendGameEventMessages(env, context, game);
}

async function startRound(env, context, payload) {
	const game = await fetchGame(env, context);
	if (!game) {
		await context.say({ text: `No game exists! Type 'New Game'` });
		return;
	}

	game.startRound(context.userId);
	saveGame(env, context, game);
	await sendGameEventMessages(env, context, game);
}

async function showChips(env, context, payload) {
	const game = await fetchGame(env, context);
	if (!game) {
		await context.say({ text: `No game exists! Type 'New Game'` });
		return;
	}

	let message = '';
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
	saveGame(env, context, game);
	await sendGameEventMessages(env, context, game);
}

async function buyIn(env, context, payload) {
	const messageText = payload.text.toLowerCase();
	const buyInAmount = parseFloat(messageText.replace('buy in', '').trim());

	if (isNaN(buyInAmount) || buyInAmount <= 0) {
		await context.say({ text: 'Invalid buy in amount! Please use format: "buy in {chips}"' });
		return;
	}

	const game = await fetchGame(env, context);
	if (!game) {
		await context.say({ text: `No game exists! Type 'New Game'` });
		return;
	}

	game.buyIn(context.userId, buyInAmount);
	saveGame(env, context, game);
	await sendGameEventMessages(env, context, game);
}

async function leaveGame(env, context) {
	const game = await fetchGame(env, context);
	if (!game) {
		await context.say({ text: `No game exists! Type 'New Game'` });
		return;
	}

	game.removePlayer(context.userId);
	saveGame(env, context, game);
	await sendGameEventMessages(env, context, game);
}

async function joinGame(env, context) {
	const game = await fetchGame(env, context);
	if (!game) {
		await context.say({ text: `No game exists! Type 'New Game'` });
		return;
	}

	game.addPlayer(context.userId);
	saveGame(env, context, game);
	await sendGameEventMessages(env, context, game);
}

async function newGame(env, context, payload) {
	const game = await fetchGame(env, context);
	if (game) {
		const allPlayers = [...game.getActivePlayers(), ...game.getInactivePlayers()];
		for (const player of allPlayers) {
			if (player.getChips() !== 0) {
				await context.say({ text: `Cannot start new game - ${player.getId()} still has chips!` });
				return;
			}
		}
	}

	console.log(JSON.stringify(new TexasHoldem().toJson()));
	const stub = getDurableObject(env, context);
	stub.createGame(context.teamId, context.channelId, JSON.stringify(new TexasHoldem().toJson()));
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

function saveGame(env, context, game: TexasHoldem) {
	const workspaceId = context.teamId;
	const channelId = context.channelId;
	const stub = getDurableObject(env, context);

	stub.saveGame(workspaceId, channelId, JSON.stringify(game.toJson()));
}

function getDurableObject(env, context) {
	const workspaceId = context.teamId;
	const channelId = context.channelId;

	const id: DurableObjectId = env.POKER_DURABLE_OBJECT.idFromName(`${workspaceId}-${channelId}`);

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
	events = events.filter((event, index) => !event.getIsTurnMessage() || index === lastTurnMessageIndex);

	let publicMessages = [];

	for (const event of events) {
		let message = event.getDescription();

		let skipFlop = false;
		if (message.startsWith('Flop:') && event.getCards() && event.getCards().length == 3) {
			skipFlop = Math.random() < 0.01;
			if (skipFlop) {
				message = 'No flop this time';
			}

			const stub = getDurableObject(env, context);

			const workspaceId = context.teamId;
			const channelId = context.channelId;

			const flopString = getFlopString(event.getCards());

			const flop = await stub.getFlop(workspaceId, channelId, flopString);
			if (!flop) {
				message = `*NEW* ` + message;
				stub.addFlop(workspaceId, channelId, flopString, Date.now());
			} else {
				const human = new Date(flop.createdAt).toLocaleDateString('en-US', {
					year: 'numeric',
					month: '2-digit',
					day: '2-digit',
				});
				message = `Flop (First Seen ${human}):`;
				skipFlop = false;
			}
		}

		if (event.getCards() && event.getCards().length > 0 && !skipFlop) {
			message += `\n${event
				.getCards()
				.map((card) => card.toSlackString())
				.join(' ')}`;
		}

		const playerIds = game.getActivePlayers().map((player) => player.getId());
		const inactivePlayerIds = game.getInactivePlayers().map((player) => player.getId());
		playerIds.push(...inactivePlayerIds);
		// Replace all player IDs in message with @mentions
		playerIds.forEach((playerId) => {
			message = message.replace(new RegExp(playerId, 'g'), `<@${playerId}>`);
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
			text: publicMessages.join('\n'),
		});
	}
}

function getFlopString(cards: Card[]) {
	return cards
		.map((card) => card.toString())
		.sort((a, b) => a.localeCompare(b))
		.join('');
}
