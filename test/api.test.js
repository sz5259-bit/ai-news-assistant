import assert from "node:assert/strict";
import test from "node:test";

import newsHandler, { parseFeed } from "../api/news.js";
import scrapeHandler, { cleanExcerpt, validateWebUrl } from "../api/scrape.js";

function mockResponse() {
  const result = { headers: {} };
  const response = {
    setHeader(name, value) {
      result.headers[name] = value;
    },
    status(code) {
      result.status = code;
      return this;
    },
    json(body) {
      result.body = body;
      return this;
    },
  };
  return { response, result };
}

function rss(title, link, date = "Fri, 12 Sep 2026 08:00:00 GMT") {
  return `<?xml version="1.0"?><rss version="2.0"><channel><item><title>${title}</title><link>${link}</link><pubDate>${date}</pubDate><description><![CDATA[<p>A useful summary.</p>]]></description></item></channel></rss>`;
}

test("RSS entries are normalized and encoded punctuation is cleaned", () => {
  const articles = parseFeed(rss("AI &amp;amp; chips &#8217;today&#8217;", "https://example.com/story"), "Test");
  assert.equal(articles.length, 1);
  assert.equal(articles[0].title, "AI & chips ’today’");
  assert.equal(articles[0].summary, "A useful summary.");
  assert.equal(articles[0].source, "Test");
});

test("news route keeps valid feeds when one publisher fails", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url) => {
    if (url.includes("venturebeat.com")) return new Response("Busy", { status: 429 });
    return new Response(rss("Story", `https://example.com/${encodeURIComponent(url)}`), { status: 200 });
  };

  try {
    const { response, result } = mockResponse();
    await newsHandler({ method: "GET" }, response);
    assert.equal(result.status, 200);
    assert.equal(result.body.articles.length, 2);
    assert.equal(result.body.errors[0].source, "VentureBeat");
    assert.equal(result.body.partial, true);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("scrape route rejects non-web URLs and reports a missing key", async () => {
  assert.throws(() => validateWebUrl("file:///tmp/private"), /Only http/);
  assert.throws(() => validateWebUrl("http://localhost/private"), /public/);
  assert.equal(validateWebUrl("https://example.com/article").hostname, "example.com");
  assert.equal(cleanExcerpt("x".repeat(7_000)).length, 6_000);

  const previousKey = process.env.FIRECRAWL_API_KEY;
  delete process.env.FIRECRAWL_API_KEY;
  try {
    const { response, result } = mockResponse();
    await scrapeHandler({ method: "POST", body: { url: "https://example.com" } }, response);
    assert.equal(result.status, 503);
    assert.match(result.body.error, /not configured/);
  } finally {
    if (previousKey) process.env.FIRECRAWL_API_KEY = previousKey;
  }
});

test("scrape route returns only normalized, limited page data", async () => {
  const originalFetch = globalThis.fetch;
  const previousKey = process.env.FIRECRAWL_API_KEY;
  process.env.FIRECRAWL_API_KEY = "test-key";
  globalThis.fetch = async () => new Response(JSON.stringify({
    success: true,
    data: {
      markdown: "Readable article content.",
      metadata: { title: "Example story", description: "Example description", sourceURL: "https://example.com/story" },
    },
  }), { status: 200, headers: { "Content-Type": "application/json" } });

  try {
    const { response, result } = mockResponse();
    await scrapeHandler({ method: "POST", body: { url: "https://example.com/story" } }, response);
    assert.equal(result.status, 200);
    assert.deepEqual(result.body, {
      title: "Example story",
      domain: "example.com",
      url: "https://example.com/story",
      description: "Example description",
      content: "Readable article content.",
    });
  } finally {
    globalThis.fetch = originalFetch;
    if (previousKey) process.env.FIRECRAWL_API_KEY = previousKey;
    else delete process.env.FIRECRAWL_API_KEY;
  }
});
