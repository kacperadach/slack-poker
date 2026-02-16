import { buildShowdownWinPercentageMessage } from "./src/ShowdownWinPercentage.ts";

async function main(): Promise<void> {
  const message = await buildShowdownWinPercentageMessage(
    {
      activePlayers: [
        {
          id: "player1",
          cards: [
            { rank: "A", suit: "Hearts" },
            { rank: "K", suit: "Hearts" },
          ],
        },
        {
          id: "player2",
          cards: [
            { rank: "5", suit: "Spades" },
            { rank: "4", suit: "Spades" },
          ],
        },
      ],
      foldedPlayers: [],
      communityCards: [
        { rank: "2", suit: "Clubs" },
        { rank: "7", suit: "Diamonds" },
        { rank: "9", suit: "Hearts" },
        { rank: "Q", suit: "Clubs" },
        { rank: "A", suit: "Spades" },
      ],
    },
    [
      { description: "player1 had Two Pair" },
      { description: "player2 had One Pair" },
      { description: "Main pot of 160 won by: player1" },
    ]
  );

  if (!message) {
    throw new Error("buildShowdownWinPercentageMessage returned null.");
  }
  if (!message.includes("*Showdown Win Percentage*")) {
    throw new Error("Showdown message header missing.");
  }
  if (message.includes("N/A")) {
    throw new Error(
      "At least one street returned N/A, expected all four streets to resolve."
    );
  }

  console.log("Local showdown odds verification passed.");
  console.log("Constructed message:");
  console.log(message);
}

main().catch((error) => {
  console.error("Verification failed.");
  console.error(error instanceof Error ? error.stack : String(error));
  process.exit(1);
});
