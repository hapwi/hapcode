import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const getUsageMock = vi.fn();

vi.mock("./nativeApi", () => ({
  readNativeApi: () => ({
    claude: {
      getUsage: getUsageMock,
    },
  }),
}));

describe("claudeUsageStore", () => {
  beforeEach(async () => {
    vi.resetModules();
    getUsageMock.mockReset();
  });

  afterEach(async () => {
    const { resetClaudeUsageStoreForTests } = await import("./claudeUsageStore");
    resetClaudeUsageStoreForTests();
  });

  it("deduplicates concurrent refreshes and shares the same snapshot", async () => {
    getUsageMock.mockImplementation(
      () =>
        new Promise((resolve) =>
          setTimeout(
            () =>
              resolve({
                fiveHour: { utilization: 35, resetsAt: "2026-03-31T18:00:00.000Z" },
                sevenDay: null,
              }),
            0,
          ),
        ),
    );

    const { getClaudeUsageSnapshot, refreshClaudeUsage } = await import("./claudeUsageStore");

    await Promise.all([refreshClaudeUsage({ force: true }), refreshClaudeUsage({ force: true })]);

    expect(getUsageMock).toHaveBeenCalledTimes(1);
    expect(getClaudeUsageSnapshot()).toEqual({
      fiveHourPercent: 35,
      resetsAt: "2026-03-31T18:00:00.000Z",
    });
  });

  it("keeps the last known snapshot when the API returns no five-hour data", async () => {
    getUsageMock.mockResolvedValueOnce({
      fiveHour: { utilization: 42, resetsAt: "2026-03-31T19:00:00.000Z" },
      sevenDay: null,
    });

    const { getClaudeUsageSnapshot, refreshClaudeUsage } = await import("./claudeUsageStore");

    await refreshClaudeUsage({ force: true });

    getUsageMock.mockResolvedValueOnce({
      fiveHour: null,
      sevenDay: null,
    });

    await refreshClaudeUsage({ force: true });

    expect(getClaudeUsageSnapshot()).toEqual({
      fiveHourPercent: 42,
      resetsAt: "2026-03-31T19:00:00.000Z",
    });
  });
});
