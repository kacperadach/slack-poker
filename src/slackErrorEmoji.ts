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

function addEmojiAfterLeadingUserTag(message: string): string | null {
  const leadingTagsMatch = message.match(/^(\s*(?:<@[^>]+>\s*)+)/);
  if (!leadingTagsMatch) {
    return null;
  }

  const leadingTagBlock = leadingTagsMatch[1].replace(/\s+$/, "");
  const remainingMessage = message.slice(leadingTagsMatch[1].length);
  return `${leadingTagBlock} ${NARP_BRAIN_EMOJI}${remainingMessage}`;
}

export function ensureNarpBrainOnError(message: string): string {
  if (!message || message.includes(NARP_BRAIN_EMOJI)) {
    return message;
  }

  if (!isSlackErrorMessage(message)) {
    return message;
  }

  const taggedMessageWithEmoji = addEmojiAfterLeadingUserTag(message);
  if (taggedMessageWithEmoji) {
    return taggedMessageWithEmoji;
  }

  return `${NARP_BRAIN_EMOJI} ${message}`;
}
