/**
 * ActionLog Types
 *
 * Minimal, immutable action log schema with discriminated union types.
 * Stores only raw/atomic actions - all other state can be derived.
 *
 * Each action type is versioned (V1, V2, etc.) to support schema migrations.
 * When modifying an action type's schema:
 * 1. Create a new versioned type (e.g., BetActionV2)
 * 2. Add the new type to the ActionLogEntry union
 * 3. Keep old versions for backwards compatibility
 */

// =============================================================================
// Base Types
// =============================================================================

/** Common fields present in ALL action log entries */
export interface ActionLogBase {
  /** Schema version for this action type */
  schemaVersion: number;
  /** Workspace ID (Slack team ID) */
  workspaceId: string;
  /** Channel ID where the game is taking place */
  channelId: string;
  /** Unix timestamp in milliseconds */
  timestamp: number;
  /** The type of action - discriminator field */
  actionType: string;
  /** The original message text that triggered this action */
  messageText: string;
}

/** Card representation (e.g., "Ah" for Ace of hearts) */
export type CardString = string;

// =============================================================================
// Game Management Actions
// =============================================================================

export interface NewGameActionV1 extends ActionLogBase {
  actionType: "new_game";
  schemaVersion: 1;
  /** Player who created the game */
  playerId: string;
  /** Small blind amount */
  smallBlind: number;
  /** Big blind amount */
  bigBlind: number;
}

// =============================================================================
// Player Management Actions
// =============================================================================

export interface JoinActionV1 extends ActionLogBase {
  actionType: "join";
  schemaVersion: 1;
  /** Player who joined */
  playerId: string;
}

export interface LeaveActionV1 extends ActionLogBase {
  actionType: "leave";
  schemaVersion: 1;
  /** Player who left */
  playerId: string;
}

export interface BuyInActionV1 extends ActionLogBase {
  actionType: "buy_in";
  schemaVersion: 1;
  /** Player who bought in */
  playerId: string;
  /** Amount bought in */
  amount: number;
}

export interface CashOutActionV1 extends ActionLogBase {
  actionType: "cash_out";
  schemaVersion: 1;
  /** Player who cashed out */
  playerId: string;
  /** Amount cashed out */
  amount: number;
}

// =============================================================================
// Round Management Actions
// =============================================================================

export interface RoundStartActionV1 extends ActionLogBase {
  actionType: "round_start";
  schemaVersion: 1;
  /** Dealer position (index in playerOrder) */
  dealerPosition: number;
  /** Active players in seat order */
  playerOrder: string[];
  /** Player chip stacks at start of round */
  playerStacks: Record<string, number>;
  /** Cards dealt to each player */
  playerCards: Record<string, [CardString, CardString]>;
  /** All 5 community cards (determined at shuffle, revealed during play) */
  communityCards: [CardString, CardString, CardString, CardString, CardString];
  /** Small blind player ID */
  smallBlindPlayerId: string;
  /** Small blind amount posted */
  smallBlindAmount: number;
  /** Big blind player ID */
  bigBlindPlayerId: string;
  /** Big blind amount posted */
  bigBlindAmount: number;
}

// =============================================================================
// Player Actions (The 4 Poker Actions)
// =============================================================================

export interface BetActionV1 extends ActionLogBase {
  actionType: "bet";
  schemaVersion: 1;
  /** Player making the bet */
  playerId: string;
  /** Bet amount */
  amount: number;
}

export interface CallActionV1 extends ActionLogBase {
  actionType: "call";
  schemaVersion: 1;
  /** Player making the call */
  playerId: string;
  /** Call amount */
  amount: number;
}

export interface CheckActionV1 extends ActionLogBase {
  actionType: "check";
  schemaVersion: 1;
  /** Player checking */
  playerId: string;
}

export interface FoldActionV1 extends ActionLogBase {
  actionType: "fold";
  schemaVersion: 1;
  /** Player folding */
  playerId: string;
}

// =============================================================================
// Utility Actions
// =============================================================================

export interface MessageReceivedActionV1 extends ActionLogBase {
  actionType: "message_received";
  schemaVersion: 1;
  /** Player who sent the message */
  playerId: string;
  /** Slack message timestamp (payload ts) */
  slackMessageTs: string;
  /** Normalized message text used for handler matching */
  normalizedText: string;
  /** Handler key that matched the message */
  handlerKey: string;
}

// =============================================================================
// Discriminated Union Type
// =============================================================================

/** All possible action types in the action log */
export type ActionLogEntry =
  // Game management
  | NewGameActionV1
  // Player management
  | JoinActionV1
  | LeaveActionV1
  | BuyInActionV1
  | CashOutActionV1
  // Round management
  | RoundStartActionV1
  // Player actions
  | BetActionV1
  | CallActionV1
  | CheckActionV1
  | FoldActionV1
  // Utility
  | MessageReceivedActionV1;

/** All action type strings */
export type ActionType = ActionLogEntry["actionType"];

// =============================================================================
// Type Guards
// =============================================================================

export function isPlayerAction(
  action: ActionLogEntry
): action is BetActionV1 | CallActionV1 | CheckActionV1 | FoldActionV1 {
  return ["bet", "call", "check", "fold"].includes(action.actionType);
}

export function isPlayerManagementAction(
  action: ActionLogEntry
): action is JoinActionV1 | LeaveActionV1 | BuyInActionV1 | CashOutActionV1 {
  return ["join", "leave", "buy_in", "cash_out"].includes(action.actionType);
}

// Individual type guards for each action type
// These accept a generic object with actionType to support data from database queries
type ActionLike = { actionType: string };

export function isNewGame(action: ActionLike): action is NewGameActionV1 {
  return action.actionType === "new_game";
}

export function isJoin(action: ActionLike): action is JoinActionV1 {
  return action.actionType === "join";
}

export function isLeave(action: ActionLike): action is LeaveActionV1 {
  return action.actionType === "leave";
}

export function isBuyIn(action: ActionLike): action is BuyInActionV1 {
  return action.actionType === "buy_in";
}

export function isCashOut(action: ActionLike): action is CashOutActionV1 {
  return action.actionType === "cash_out";
}

export function isRoundStart(action: ActionLike): action is RoundStartActionV1 {
  return action.actionType === "round_start";
}

export function isBet(action: ActionLike): action is BetActionV1 {
  return action.actionType === "bet";
}

export function isCall(action: ActionLike): action is CallActionV1 {
  return action.actionType === "call";
}

export function isCheck(action: ActionLike): action is CheckActionV1 {
  return action.actionType === "check";
}

export function isFold(action: ActionLike): action is FoldActionV1 {
  return action.actionType === "fold";
}

export function isMessageReceived(
  action: ActionLike
): action is MessageReceivedActionV1 {
  return action.actionType === "message_received";
}

// Assertion helpers - throw if wrong type, return narrowed type
export function assertNewGame(action: ActionLike): NewGameActionV1 {
  if (!isNewGame(action))
    throw new Error(`Expected new_game, got ${action.actionType}`);
  return action;
}

export function assertJoin(action: ActionLike): JoinActionV1 {
  if (!isJoin(action))
    throw new Error(`Expected join, got ${action.actionType}`);
  return action;
}

export function assertLeave(action: ActionLike): LeaveActionV1 {
  if (!isLeave(action))
    throw new Error(`Expected leave, got ${action.actionType}`);
  return action;
}

export function assertBuyIn(action: ActionLike): BuyInActionV1 {
  if (!isBuyIn(action))
    throw new Error(`Expected buy_in, got ${action.actionType}`);
  return action;
}

export function assertCashOut(action: ActionLike): CashOutActionV1 {
  if (!isCashOut(action))
    throw new Error(`Expected cash_out, got ${action.actionType}`);
  return action;
}

export function assertRoundStart(action: ActionLike): RoundStartActionV1 {
  if (!isRoundStart(action))
    throw new Error(`Expected round_start, got ${action.actionType}`);
  return action;
}

export function assertBet(action: ActionLike): BetActionV1 {
  if (!isBet(action)) throw new Error(`Expected bet, got ${action.actionType}`);
  return action;
}

export function assertCall(action: ActionLike): CallActionV1 {
  if (!isCall(action))
    throw new Error(`Expected call, got ${action.actionType}`);
  return action;
}

export function assertCheck(action: ActionLike): CheckActionV1 {
  if (!isCheck(action))
    throw new Error(`Expected check, got ${action.actionType}`);
  return action;
}

export function assertFold(action: ActionLike): FoldActionV1 {
  if (!isFold(action))
    throw new Error(`Expected fold, got ${action.actionType}`);
  return action;
}

export function assertMessageReceived(
  action: ActionLike
): MessageReceivedActionV1 {
  if (!isMessageReceived(action))
    throw new Error(`Expected message_received, got ${action.actionType}`);
  return action;
}

// =============================================================================
// Factory Functions
// =============================================================================

/** Create base fields for an action log entry */
export function createActionBase(
  workspaceId: string,
  channelId: string,
  messageText: string
): Omit<ActionLogBase, "actionType" | "schemaVersion"> {
  return {
    workspaceId,
    channelId,
    timestamp: Date.now(),
    messageText,
  };
}

// =============================================================================
// Action Type List (for validation)
// =============================================================================

export const ALL_ACTION_TYPES: ActionType[] = [
  "new_game",
  "join",
  "leave",
  "buy_in",
  "cash_out",
  "round_start",
  "bet",
  "call",
  "check",
  "fold",
  "message_received",
];
