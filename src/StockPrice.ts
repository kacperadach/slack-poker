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
  marketState?: string;
  preMarketPrice?: number;
  preMarketChange?: number;
  preMarketChangePercent?: number;
  postMarketPrice?: number;
  postMarketChange?: number;
  postMarketChangePercent?: number;
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

    const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?interval=1d&range=1d`;

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
            marketState?: string;
            preMarketPrice?: number;
            preMarketChange?: number;
            preMarketChangePercent?: number;
            postMarketPrice?: number;
            postMarketChange?: number;
            postMarketChangePercent?: number;
          };
        }>;
      };
    };

    // Extract price data from Yahoo Finance response
    const chartResult = data?.chart?.result?.[0];
    if (!chartResult) {
      return null;
    }

    const meta = chartResult.meta;
    if (!meta) {
      return null;
    }

    const currentPrice = meta.regularMarketPrice;
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

    const stockResult: StockPriceResult = {
      symbol: symbol.toUpperCase(),
      price: currentPrice,
      change: Math.round(change * 100) / 100,
      changePercent: Math.round(changePercent * 100) / 100,
    };

    // Add market state if available
    if (meta.marketState) {
      stockResult.marketState = meta.marketState;
    }

    // Add pre-market data if available
    if (typeof meta.preMarketPrice === "number") {
      stockResult.preMarketPrice = meta.preMarketPrice;
    }
    if (typeof meta.preMarketChange === "number") {
      stockResult.preMarketChange = Math.round(meta.preMarketChange * 100) / 100;
    }
    if (typeof meta.preMarketChangePercent === "number") {
      stockResult.preMarketChangePercent = Math.round(meta.preMarketChangePercent * 100) / 100;
    }

    // Add post-market data if available
    if (typeof meta.postMarketPrice === "number") {
      stockResult.postMarketPrice = meta.postMarketPrice;
    }
    if (typeof meta.postMarketChange === "number") {
      stockResult.postMarketChange = Math.round(meta.postMarketChange * 100) / 100;
    }
    if (typeof meta.postMarketChangePercent === "number") {
      stockResult.postMarketChangePercent = Math.round(meta.postMarketChangePercent * 100) / 100;
    }

    return stockResult;
  } catch {
    // Any error (network, timeout, parsing, etc.) - return null
    return null;
  }
}

/**
 * Formats a stock price result into a display string for Slack.
 * When the market is in pre-market hours, shows pre-market price changes.
 * When the market is closed/post-market, shows after-hours price changes.
 *
 * @param result - The stock price result
 * @returns Formatted string like "$HUBS: $650.23 (+2.15, +0.33%)" with pre-market or after-hours info
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

  let message = `${emoji} $${result.symbol}: ${priceStr} (${changeStr}, ${changePercentStr})`;

  // Add pre-market info if market is in pre-market state and pre-market data is available
  const isPreMarket = result.marketState === "PRE";
  
  if (isPreMarket && typeof result.preMarketPrice === "number") {
    const prePriceStr = result.preMarketPrice.toLocaleString("en-US", {
      style: "currency",
      currency: "USD",
    });
    
    const preChangeSign = (result.preMarketChange ?? 0) >= 0 ? "+" : "";
    const preChangeStr = typeof result.preMarketChange === "number" 
      ? `${preChangeSign}${result.preMarketChange.toFixed(2)}` 
      : "";
    const preChangePercentStr = typeof result.preMarketChangePercent === "number"
      ? `${preChangeSign}${result.preMarketChangePercent.toFixed(2)}%`
      : "";
    
    const preEmoji = (result.preMarketChange ?? 0) >= 0 ? ":chart_with_upwards_trend:" : ":chart_with_downwards_trend:";
    
    message += `\n${preEmoji} Pre-market: ${prePriceStr}`;
    if (preChangeStr && preChangePercentStr) {
      message += ` (${preChangeStr}, ${preChangePercentStr})`;
    }
  }

  // Add post-market info if market is closed/post-market and post-market data is available
  const isAfterHours = result.marketState === "POST" || result.marketState === "POSTPOST" || result.marketState === "CLOSED";
  
  if (isAfterHours && typeof result.postMarketPrice === "number") {
    const postPriceStr = result.postMarketPrice.toLocaleString("en-US", {
      style: "currency",
      currency: "USD",
    });
    
    const postChangeSign = (result.postMarketChange ?? 0) >= 0 ? "+" : "";
    const postChangeStr = typeof result.postMarketChange === "number" 
      ? `${postChangeSign}${result.postMarketChange.toFixed(2)}` 
      : "";
    const postChangePercentStr = typeof result.postMarketChangePercent === "number"
      ? `${postChangeSign}${result.postMarketChangePercent.toFixed(2)}%`
      : "";
    
    const postEmoji = (result.postMarketChange ?? 0) >= 0 ? ":chart_with_upwards_trend:" : ":chart_with_downwards_trend:";
    
    message += `\n${postEmoji} After-hours: ${postPriceStr}`;
    if (postChangeStr && postChangePercentStr) {
      message += ` (${postChangeStr}, ${postChangePercentStr})`;
    }
  }

  return message;
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
