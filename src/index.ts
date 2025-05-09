import { DurableObject } from 'cloudflare:workers';
import { SlackApp, SlackEdgeAppEnv, isPostedMessageEvent } from 'slack-cloudflare-workers';
import { GameState, TexasHoldem } from './Game';
import { GameEvent } from './GameEvent';
import { Player } from './Player';

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
	cards: showCards,
	'reveal cards': revealCards,
	rank: getGameState,
	help: help,
	nudge: nudgePlayer,
	seppuku: commitSeppuku,
};

async function handleMessage(env: Env, context, payload) {
	if (!isPostedMessageEvent(payload)) {
		return;
	}

	const messageText = payload.text;

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
	await sendGameEventMessages(context, game);
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
	await sendGameEventMessages(context, game);
}

async function showCards(env, context, payload) {
	const game = await fetchGame(env, context);
	if (!game) {
		await context.say({ text: `No game exists! Type 'New Game'` });
		return;
	}

	game.showCards(context.userId, false);
	await sendGameEventMessages(context, game);
}

async function bet(env, context, payload) {
	const messageText = payload.text.toLowerCase();
	const betAmount = parseFloat(messageText.replace('bet', '').trim());

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
	await sendGameEventMessages(context, game);
}

async function call(env, context, payload) {
	const game = await fetchGame(env, context);
	if (!game) {
		await context.say({ text: `No game exists! Type 'New Game'` });
		return;
	}

	game.call(context.userId);
	saveGame(env, context, game);
	await sendGameEventMessages(context, game);
}

async function check(env, context, payload) {
	const game = await fetchGame(env, context);
	if (!game) {
		await context.say({ text: `No game exists! Type 'New Game'` });
		return;
	}

	game.check(context.userId);
	saveGame(env, context, game);
	await sendGameEventMessages(context, game);
}

async function fold(env, context, payload) {
	const game = await fetchGame(env, context);
	if (!game) {
		await context.say({ text: `No game exists! Type 'New Game'` });
		return;
	}

	game.fold(context.userId);
	saveGame(env, context, game);
	await sendGameEventMessages(context, game);
}

async function startRound(env, context, payload) {
	const game = await fetchGame(env, context);
	if (!game) {
		await context.say({ text: `No game exists! Type 'New Game'` });
		return;
	}

	game.startRound(context.userId);
	saveGame(env, context, game);
	await sendGameEventMessages(context, game);
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

	game.getInactivePlayers().forEach((player) => {
		message += `<@${player.getId()}>: ${player.getChips()} (Inactive)\n`;
	});
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
	await sendGameEventMessages(context, game);
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
	await sendGameEventMessages(context, game);
}

async function leaveGame(env, context) {
	const game = await fetchGame(env, context);
	if (!game) {
		await context.say({ text: `No game exists! Type 'New Game'` });
		return;
	}

	game.removePlayer(context.userId);
	saveGame(env, context, game);
	await sendGameEventMessages(context, game);
}

async function joinGame(env, context) {
	const game = await fetchGame(env, context);
	if (!game) {
		await context.say({ text: `No game exists! Type 'New Game'` });
		return;
	}

	game.addPlayer(context.userId);
	saveGame(env, context, game);
	await sendGameEventMessages(context, game);
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

async function sendGameEventMessages(context, game: TexasHoldem) {
	const events = game.getEvents();
	for (const event of events) {
		let message = event.getDescription();
		if (event.getCards() && event.getCards().length > 0) {
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
			await context.say({
				text: message,
			});
		}
	}
}
