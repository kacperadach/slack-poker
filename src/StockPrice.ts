/**
 * Stock price fetching utility.
 * Fetches stock prices from a public API with graceful error handling.
 * If the fetch fails for any reason, returns null instead of throwing.
 */

export interface StockPriceResult {
  symbol: string;
  price: number;
  change: number;
  changePercent: number;
  session: "regular" | "pre" | "post";
}

interface TradingPeriod {
  start?: number;
  end?: number;
}

function isWithinTradingPeriod(period: TradingPeriod | undefined, now: number): boolean {
  if (typeof period?.start !== "number" || typeof period?.end !== "number") {
    return false;
  }
  return now >= period.start && now < period.end;
}

function getLatestCloseInTradingPeriod(
  timestamps: number[] | undefined,
  closes: Array<number | null> | undefined,
  period: TradingPeriod | undefined
): number | null {
  if (
    typeof period?.start !== "number" ||
    typeof period?.end !== "number" ||
    !timestamps ||
    !closes
  ) {
    return null;
  }

  for (let i = Math.min(timestamps.length, closes.length) - 1; i >= 0; i--) {
    const timestamp = timestamps[i];
    if (timestamp < period.start || timestamp >= period.end) {
      continue;
    }

    const close = closes[i];
    if (typeof close === "number") {
      return close;
    }
  }

  return null;
}

/**
 * Fetches the current stock price for a given symbol.
 * Uses Yahoo Finance's public chart API.
 *
 * @param symbol - The stock symbol (e.g., "HUBS")
 * @param timeoutMs - Timeout in milliseconds (default: 3000ms)
 * @returns StockPriceResult if successful, null if any error occurs
 */
export async function fetchStockPrice(
  symbol: string,
  timeoutMs: number = 3000
): Promise<StockPriceResult | null> {
  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

    const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?interval=1m&range=1d&includePrePost=true`;

    const response = await fetch(url, {
      signal: controller.signal,
      headers: {
        "User-Agent": "Mozilla/5.0",
      },
    });

    clearTimeout(timeoutId);

    if (!response.ok) {
      return null;
    }

    const data = (await response.json()) as {
      chart?: {
        result?: Array<{
          meta?: {
            regularMarketPrice?: number;
            chartPreviousClose?: number;
            previousClose?: number;
            currentTradingPeriod?: {
              pre?: TradingPeriod;
              regular?: TradingPeriod;
              post?: TradingPeriod;
            };
          };
          timestamp?: number[];
          indicators?: {
            quote?: Array<{
              close?: Array<number | null>;
            }>;
          };
        }>;
      };
    };

    // Extract price data from Yahoo Finance response
    const result = data?.chart?.result?.[0];
    if (!result) {
      return null;
    }

    const meta = result.meta;
    if (!meta) {
      return null;
    }

    const timestamps = result.timestamp;
    const closes = result.indicators?.quote?.[0]?.close;
    const preMarketPrice = getLatestCloseInTradingPeriod(
      timestamps,
      closes,
      meta.currentTradingPeriod?.pre
    );
    const postMarketPrice = getLatestCloseInTradingPeriod(
      timestamps,
      closes,
      meta.currentTradingPeriod?.post
    );

    const now = Math.floor(Date.now() / 1000);
    const isRegularMarketOpen = isWithinTradingPeriod(
      meta.currentTradingPeriod?.regular,
      now
    );
    const isMorningPreMarket = isWithinTradingPeriod(
      meta.currentTradingPeriod?.pre,
      now
    );

    let session: StockPriceResult["session"] = "regular";
    let currentPrice = meta.regularMarketPrice;
    if (isMorningPreMarket && typeof preMarketPrice === "number") {
      session = "pre";
      currentPrice = preMarketPrice;
    } else if (!isRegularMarketOpen && typeof postMarketPrice === "number") {
      session = "post";
      currentPrice = postMarketPrice;
    }

    const previousClose = meta.chartPreviousClose ?? meta.previousClose;

    if (typeof currentPrice !== "number") {
      return null;
    }

    const change =
      typeof previousClose === "number" ? currentPrice - previousClose : 0;
    const changePercent =
      typeof previousClose === "number" && previousClose !== 0
        ? (change / previousClose) * 100
        : 0;

    return {
      symbol: symbol.toUpperCase(),
      price: currentPrice,
      change: Math.round(change * 100) / 100,
      changePercent: Math.round(changePercent * 100) / 100,
      session,
    };
  } catch {
    // Any error (network, timeout, parsing, etc.) - return null
    return null;
  }
}

/**
 * Formats a stock price result into a display string for Slack.
 *
 * @param result - The stock price result
 * @returns Formatted string like "$HUBS: $650.23 (+2.15, +0.33%)"
 */
export function formatStockPrice(result: StockPriceResult): string {
  const priceStr = result.price.toLocaleString("en-US", {
    style: "currency",
    currency: "USD",
  });

  const changeSign = result.change >= 0 ? "+" : "";
  const changeStr = `${changeSign}${result.change.toFixed(2)}`;
  const changePercentStr = `${changeSign}${result.changePercent.toFixed(2)}%`;

  const emoji = result.change >= 0 ? ":chart_with_upwards_trend:" : ":chart_with_downwards_trend:";
  const sessionLabel =
    result.session === "pre"
      ? " [pre-market]"
      : result.session === "post"
        ? " [post-market]"
        : "";

  return `${emoji} $${result.symbol}: ${priceStr}${sessionLabel} (${changeStr}, ${changePercentStr})`;
}

/**
 * Fetches and formats the HUBS stock price.
 * Returns null if the price cannot be fetched.
 *
 * @returns Formatted string or null
 */
export async function getHubsStockPriceMessage(): Promise<string | null> {
  const result = await fetchStockPrice("HUBS");
  if (!result) {
    return null;
  }
  return formatStockPrice(result);
}

/**
 * Fetches and formats the stock price for any given symbol.
 * Returns null if the price cannot be fetched.
 *
 * @param symbol - The stock symbol (e.g., "FIG", "HUBS", "GOOG")
 * @returns Formatted string or null
 */
export async function getStockPriceMessage(symbol: string): Promise<string | null> {
  const result = await fetchStockPrice(symbol);
  if (!result) {
    return null;
  }
  return formatStockPrice(result);
}
