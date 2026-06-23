import { describe, it, expect, vi, afterEach } from "vitest";
import {
  githubEnabled,
  buildIssueBody,
  createIssueFromBugReport,
} from "../../src/github.js";

const baseReport = {
  id: "rep_123",
  message: "Le bouton ne marche pas",
  diagnostics: { appVersion: "0.6.1", platform: "pwa" },
  logs: "12:00 [warn] socket disconnect\n12:01 [error] boom",
  appVersion: "0.6.1",
  platform: "pwa",
  user: { username: "alice" },
};

describe("buildIssueBody", () => {
  it("includes message, diagnostics, author and logs", () => {
    const body = buildIssueBody(baseReport);
    expect(body).toContain("Le bouton ne marche pas");
    expect(body).toContain("appVersion");
    expect(body).toContain("0.6.1");
    expect(body).toContain("socket disconnect");
    expect(body).toContain("@alice");
    expect(body).toContain("rep_123"); // report id breadcrumb
    expect(body).toContain("<details>"); // logs are collapsed
  });

  it("truncates oversized logs to stay under GitHub's 65536 body limit", () => {
    const body = buildIssueBody({ ...baseReport, logs: "x".repeat(100_000) });
    expect(body.length).toBeLessThanOrEqual(60_000);
    expect(body).toContain("(logs tronqués)");
    expect(body).toContain("Le bouton ne marche pas"); // fixed part survives
  });

  it("handles a report without logs (no <details> block)", () => {
    const body = buildIssueBody({ ...baseReport, logs: null });
    expect(body).toContain("Le bouton ne marche pas");
    expect(body).not.toContain("<details>");
  });
});

describe("githubEnabled", () => {
  afterEach(() => {
    delete process.env.GITHUB_BUG_TOKEN;
  });

  it("reflects presence of GITHUB_BUG_TOKEN", () => {
    delete process.env.GITHUB_BUG_TOKEN;
    expect(githubEnabled()).toBe(false);
    process.env.GITHUB_BUG_TOKEN = "tok";
    expect(githubEnabled()).toBe(true);
  });
});

describe("createIssueFromBugReport", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    delete process.env.GITHUB_BUG_TOKEN;
    delete process.env.GITHUB_REPO_OWNER;
    delete process.env.GITHUB_REPO_NAME;
  });

  it("is a no-op (null, no HTTP) when the bridge is disabled", async () => {
    delete process.env.GITHUB_BUG_TOKEN;
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    expect(await createIssueFromBugReport(baseReport)).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("POSTs a 'signalement'-labelled issue and returns its number/url", async () => {
    process.env.GITHUB_BUG_TOKEN = "tok";
    process.env.GITHUB_REPO_OWNER = "claude-murgat";
    process.env.GITHUB_REPO_NAME = "murgatchat";
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        number: 42,
        html_url: "https://github.com/claude-murgat/murgatchat/issues/42",
      }),
    });
    vi.stubGlobal("fetch", fetchMock);

    const res = await createIssueFromBugReport(baseReport);
    expect(res).toEqual({
      number: 42,
      url: "https://github.com/claude-murgat/murgatchat/issues/42",
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, opts] = fetchMock.mock.calls[0];
    expect(url).toBe("https://api.github.com/repos/claude-murgat/murgatchat/issues");
    expect(opts.method).toBe("POST");
    expect(opts.headers.Authorization).toBe("Bearer tok");
    const payload = JSON.parse(opts.body);
    expect(payload.labels).toEqual(["signalement"]);
    expect(payload.title.startsWith("[Signalement]")).toBe(true);
    expect(payload.body).toContain("Le bouton ne marche pas");
  });

  it("returns null on a non-ok response", async () => {
    process.env.GITHUB_BUG_TOKEN = "tok";
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: false,
        status: 422,
        text: async () => "Validation Failed",
      })
    );
    expect(await createIssueFromBugReport(baseReport)).toBeNull();
  });

  it("returns null (swallows) when the request throws", async () => {
    process.env.GITHUB_BUG_TOKEN = "tok";
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("network down")));
    expect(await createIssueFromBugReport(baseReport)).toBeNull();
  });
});
