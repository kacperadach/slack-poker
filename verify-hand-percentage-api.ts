import { buildShowdownWinPercentageMessage } from "./src/ShowdownWinPercentage.ts";

type BrowserFetchPayload = {
  requestUrl: string;
  method: string;
  headers: Record<string, string>;
};

type BrowserFetchResponse = {
  ok: boolean;
  status: number;
  headers: Array<[string, string]>;
  bodyText: string;
};

function requestInfoToUrl(input: RequestInfo | URL): string {
  if (typeof input === "string") {
    return input;
  }
  if (input instanceof URL) {
    return input.toString();
  }
  return input.url;
}

function headersToRecord(
  headersInit: HeadersInit | undefined
): Record<string, string> {
  if (!headersInit) {
    return {};
  }
  if (headersInit instanceof Headers) {
    return Object.fromEntries(headersInit.entries());
  }
  if (Array.isArray(headersInit)) {
    return Object.fromEntries(headersInit);
  }
  return { ...headersInit };
}

function getHeaderCaseInsensitive(
  headers: Record<string, string>,
  target: string
): string | undefined {
  const targetLower = target.toLowerCase();
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() === targetLower) {
      return value;
    }
  }
  return undefined;
}

async function main(): Promise<void> {
  let playwrightModule: { chromium: any };
  try {
    playwrightModule = (await import("playwright")) as { chromium: any };
  } catch {
    console.error(
      [
        "Missing playwright dependency.",
        "Install it temporarily with:",
        "  npm install --no-save --no-package-lock playwright",
        "Then rerun:",
        "  node --experimental-strip-types ./verify-hand-percentage-api.ts",
      ].join("\n")
    );
    process.exit(1);
    return;
  }

  const { chromium } = playwrightModule;
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({
    // Use a standard browser UA to mirror an incognito check.
    userAgent:
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/132.0.0.0 Safari/537.36",
    locale: "en-US",
  });
  const page = await context.newPage();

  const capturedRequestUrls: string[] = [];
  try {
    await page.goto("https://www.cardplayer.com/poker-tools/odds-calculator/texas-holdem", {
      waitUntil: "domcontentloaded",
      timeout: 90_000,
    });
    await page.waitForFunction(
      () => Boolean((globalThis as any).wpApiSettings?.nonce),
      undefined,
      { timeout: 15_000 }
    );

    const wpApiSettings = await page.evaluate(
      () => (globalThis as any).wpApiSettings
    );
    if (!wpApiSettings?.nonce) {
      throw new Error("Could not read wpApiSettings.nonce from CardPlayer page.");
    }

    const browserBackedFetch = (async (
      input: RequestInfo | URL,
      init?: RequestInit
    ) => {
      const requestUrl = requestInfoToUrl(input);
      capturedRequestUrls.push(requestUrl);

      const method = init?.method ?? "GET";
      const headers = headersToRecord(init?.headers);
      if (!getHeaderCaseInsensitive(headers, "accept")) {
        headers.Accept = "application/json";
      }
      headers["X-WP-Nonce"] = wpApiSettings.nonce;

      const payload: BrowserFetchPayload = { requestUrl, method, headers };
      const browserResponse = await page.evaluate(
        async (request: BrowserFetchPayload): Promise<BrowserFetchResponse> => {
          const response = await fetch(request.requestUrl, {
            method: request.method,
            headers: request.headers,
          });
          return {
            ok: response.ok,
            status: response.status,
            headers: Array.from(response.headers.entries()),
            bodyText: await response.text(),
          };
        },
        payload
      );

      const headerMap = new Map(
        browserResponse.headers.map(([key, value]) => [key.toLowerCase(), value])
      );

      const responseLike = {
        ok: browserResponse.ok,
        status: browserResponse.status,
        headers: {
          get(name: string): string | null {
            return headerMap.get(name.toLowerCase()) ?? null;
          },
        },
        async json(): Promise<unknown> {
          return JSON.parse(browserResponse.bodyText);
        },
      };

      return responseLike as Response;
    }) as typeof fetch;

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
      ],
      browserBackedFetch
    );

    if (!message) {
      throw new Error(
        "buildShowdownWinPercentageMessage returned null after live API calls."
      );
    }
    if (!message.includes("*Showdown Win Percentage*")) {
      throw new Error("Showdown message header missing.");
    }
    if (message.includes("N/A")) {
      throw new Error(
        "At least one street returned N/A, expected all four streets to resolve."
      );
    }

    const boardByCall = capturedRequestUrls.map(
      (requestUrl) => new URL(requestUrl).searchParams.get("board")
    );
    const expectedBoards = [
      null,
      "2C 7D 9H",
      "2C 7D 9H QC",
      "2C 7D 9H QC AS",
    ];

    if (boardByCall.length !== expectedBoards.length) {
      throw new Error(
        `Expected ${expectedBoards.length} API calls, got ${boardByCall.length}.`
      );
    }
    for (let i = 0; i < expectedBoards.length; i += 1) {
      if (boardByCall[i] !== expectedBoards[i]) {
        throw new Error(
          `Unexpected board param on call ${i + 1}: got ${String(boardByCall[i])}, expected ${String(expectedBoards[i])}`
        );
      }
      const parsedUrl = new URL(capturedRequestUrls[i]);
      if (parsedUrl.searchParams.has("dead_cards")) {
        throw new Error("Request unexpectedly included dead_cards param.");
      }
    }

    console.log("Live API verification passed.");
    console.log("Constructed message:");
    console.log(message);
  } finally {
    await context.close();
    await browser.close();
  }
}

main().catch((error) => {
  console.error("Verification failed.");
  console.error(error instanceof Error ? error.stack : String(error));
  process.exit(1);
});
