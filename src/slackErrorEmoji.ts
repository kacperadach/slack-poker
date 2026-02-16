export const NARP_BRAIN_EMOJI = ":narp-brain:";

const ERROR_MESSAGE_FRAGMENTS = [
  "no game exists",
  "unable to fetch",
  "game has not started yet",
  "no current player",
  "invalid",
  "cannot",
  "can't",
  "isn't",
  "failed",
  "not your turn",
  "no active bets",
  "no chips",
  "player not found",
  "not in the game",
  "has no cards to show",
  "how about you get some friends first",
  "you are not in the game",
  "you are inactive",
  "nice try bud",
  "we're not in",
  "we're not on",
  "who the hell am i going to nudge",
  "which means the code is ass",
  "how about you try doing a check",
];

export function isSlackErrorMessage(message: string): boolean {
  const normalizedMessage = message.toLowerCase();
  return ERROR_MESSAGE_FRAGMENTS.some((fragment) =>
    normalizedMessage.includes(fragment)
  );
}

export function ensureNarpBrainOnError(message: string): string {
  if (!message || message.includes(NARP_BRAIN_EMOJI)) {
    return message;
  }

  if (!isSlackErrorMessage(message)) {
    return message;
  }

  return `${NARP_BRAIN_EMOJI} ${message}`;
}
