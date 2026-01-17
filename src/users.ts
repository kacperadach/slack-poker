export const MARCUS_USER_ID = "UDU6UNFRP";
export const CAMDEN_USER_ID = "UDUQPESM8";
export const YUVI_USER_ID = "UDV1N4HN1";
export const KACPER_USER_ID = "UDV1XR66R";
export const RYAN_USER_ID = "UDW5MDGV8";
export const JOHN_USER_ID = "UDW6VM8F8";
export const CHRIS_USER_ID = "UDW7TKBC6";
export const POKERNADO_USER_ID = "U08LP1Q4ES2";

export const userIdToName = {
  [MARCUS_USER_ID]: "Marcus",
  [CAMDEN_USER_ID]: "Camden",
  [YUVI_USER_ID]: "Yuvi",
  [KACPER_USER_ID]: "Kacper",
  [RYAN_USER_ID]: "Ryan",
  [JOHN_USER_ID]: "John",
  [CHRIS_USER_ID]: "Chris",
  [POKERNADO_USER_ID]: "Pokernado",
} as const;

export const allUsers = Object.entries(userIdToName).map(([userId, name]) => ({
  userId,
  name,
}));
