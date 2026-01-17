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
  /** Round number (1-indexed) */
  roundNumber: number;
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
// Pre-Actions (Queued Actions)
// =============================================================================

/** Action types that can be queued */
export type QueuedActionType = "check" | "fold" | "call" | "bet";

export interface PreActionActionV1 extends ActionLogBase {
  actionType: "pre_action";
  schemaVersion: 1;
  /** Player queuing the action */
  playerId: string;
  /** The action being queued */
  queuedAction: QueuedActionType;
  /** Amount for bet/call actions */
  amount?: number;
}

export interface PreDealActionV1 extends ActionLogBase {
  actionType: "pre_deal";
  schemaVersion: 1;
  /** Player queuing next deal */
  playerId: string;
}

// =============================================================================
// Utility Actions
// =============================================================================

export interface ShowCardsActionV1 extends ActionLogBase {
  actionType: "show_cards";
  schemaVersion: 1;
  /** Player showing cards */
  playerId: string;
  /** Whether revealed to all (true) or just to self (false) */
  revealedToAll: boolean;
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
  // Pre-actions
  | PreActionActionV1
  | PreDealActionV1
  // Utility
  | ShowCardsActionV1;

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

export function isPreAction(
  action: ActionLogEntry
): action is PreActionActionV1 | PreDealActionV1 {
  return ["pre_action", "pre_deal"].includes(action.actionType);
}

export function isPlayerManagementAction(
  action: ActionLogEntry
): action is JoinActionV1 | LeaveActionV1 | BuyInActionV1 | CashOutActionV1 {
  return ["join", "leave", "buy_in", "cash_out"].includes(action.actionType);
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
  "pre_action",
  "pre_deal",
  "show_cards",
];
