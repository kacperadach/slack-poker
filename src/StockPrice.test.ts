import { afterEach, describe, expect, it, vi } from "vitest";
import { fetchStockPrice, formatStockPrice } from "./StockPrice";

describe("fetchStockPrice", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("uses pre-market price in the morning before open", async () => {
    const nowSeconds = 150;
    vi.spyOn(Date, "now").mockReturnValue(nowSeconds * 1000);

    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        chart: {
          result: [
            {
              meta: {
                regularMarketPrice: 100,
                chartPreviousClose: 95,
                currentTradingPeriod: {
                  pre: { start: 100, end: 200 },
                  regular: { start: 200, end: 300 },
                  post: { start: 300, end: 400 },
                },
              },
              timestamp: [110, 150, 220, 310, 330],
              indicators: {
                quote: [{ close: [96, 97, 101, 102, 103] }],
              },
            },
          ],
        },
      }),
    });
    vi.stubGlobal("fetch", fetchMock);

    const result = await fetchStockPrice("aapl");

    expect(fetchMock).toHaveBeenCalledWith(
      expect.stringContaining("includePrePost=true"),
      expect.any(Object)
    );
    expect(result).toEqual({
      symbol: "AAPL",
      price: 97,
      change: 2,
      changePercent: 2.11,
      session: "pre",
    });
  });

  it("uses post-market price when regular market is closed", async () => {
    const nowSeconds = 450;
    vi.spyOn(Date, "now").mockReturnValue(nowSeconds * 1000);

    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({
          chart: {
            result: [
              {
                meta: {
                  regularMarketPrice: 100,
                  chartPreviousClose: 95,
                  currentTradingPeriod: {
                    pre: { start: 100, end: 200 },
                    regular: { start: 200, end: 300 },
                    post: { start: 300, end: 400 },
                  },
                },
                timestamp: [110, 150, 220, 310, 330],
                indicators: {
                  quote: [{ close: [96, 97, 101, 102, 103] }],
                },
              },
            ],
          },
        }),
      })
    );

    const result = await fetchStockPrice("aapl");

    expect(result).toEqual({
      symbol: "AAPL",
      price: 103,
      change: 8,
      changePercent: 8.42,
      session: "post",
    });
  });

  it("uses regular market price while market is open", async () => {
    const nowSeconds = 250;
    vi.spyOn(Date, "now").mockReturnValue(nowSeconds * 1000);

    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({
          chart: {
            result: [
              {
                meta: {
                  regularMarketPrice: 101,
                  chartPreviousClose: 95,
                  currentTradingPeriod: {
                    pre: { start: 100, end: 200 },
                    regular: { start: 200, end: 300 },
                    post: { start: 300, end: 400 },
                  },
                },
                timestamp: [110, 150, 220, 310, 330],
                indicators: {
                  quote: [{ close: [96, 97, 101, 102, 103] }],
                },
              },
            ],
          },
        }),
      })
    );

    const result = await fetchStockPrice("aapl");

    expect(result).toEqual({
      symbol: "AAPL",
      price: 101,
      change: 6,
      changePercent: 6.32,
      session: "regular",
    });
  });
});

describe("formatStockPrice", () => {
  it("adds pre-market label when formatting pre-market data", () => {
    const message = formatStockPrice({
      symbol: "AAPL",
      price: 100,
      change: 1,
      changePercent: 1,
      session: "pre",
    });

    expect(message).toContain("[pre-market]");
  });

  it("keeps regular market format unchanged", () => {
    const message = formatStockPrice({
      symbol: "AAPL",
      price: 100,
      change: 1,
      changePercent: 1,
      session: "regular",
    });

    expect(message).toBe(
      ":chart_with_upwards_trend: $AAPL: $100.00 (+1.00, +1.00%)"
    );
  });
});
