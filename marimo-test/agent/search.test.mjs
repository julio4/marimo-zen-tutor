import assert from "node:assert/strict";
import { test } from "node:test";
import { searchSources } from "./search.mjs";

test("Exa search is opt-in, domain-scoped, bounded and does not expose credentials", async (t) => {
  const originalKey = process.env.EXA_API_KEY;
  t.after(() => { if (originalKey === undefined) delete process.env.EXA_API_KEY; else process.env.EXA_API_KEY = originalKey; });
  delete process.env.EXA_API_KEY;
  await assert.rejects(searchSources({ query: "mean", domains: ["docs.python.org"] }), /Set EXA_API_KEY/);
  process.env.EXA_API_KEY = "fake-exa-test-key";
  await assert.rejects(searchSources({ query: "mean", domains: ["127.0.0.1"] }), /authoritative/);
  const mock = t.mock.method(globalThis, "fetch", async (url, options) => {
    assert.equal(url, "https://api.exa.ai/search");
    assert.equal(options.redirect, "error");
    assert.equal(options.headers["x-api-key"], "fake-exa-test-key");
    assert.deepEqual(JSON.parse(options.body).includeDomains, ["docs.python.org"]);
    return Response.json({ results: [
      { title: "Statistics", url: "https://docs.python.org/3/library/statistics.html", highlights: ["fake-exa-test-key" + "x".repeat(3000)] },
      { title: "Impersonator", url: "https://docs.python.org.evil.invalid/", highlights: [] },
      { url: "javascript:alert(1)" },
    ] });
  });
  const result = await searchSources({ query: "mean", domains: ["docs.python.org"] });
  assert.equal(result.results.length, 1);
  assert.equal(result.results[0].excerpts[0].length, 1500);
  assert.doesNotMatch(JSON.stringify(result), /fake-exa-test-key/);
  mock.mock.mockImplementation(async () => new Response("private error", { status: 401 }));
  await assert.rejects(searchSources({ query: "mean", domains: ["docs.python.org"] }), /HTTP 401/);
});
