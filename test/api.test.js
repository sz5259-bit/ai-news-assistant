import assert from "node:assert/strict";
import test from "node:test";

import newsHandler, { parseFeed } from "../api/news.js";
import scrapeHandler, { cleanExcerpt, validateWebUrl } from "../api/scrape.js";
import jobScanHandler, { normalizeUrls, rankJobs } from "../api/jobs/scan.js";

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
  assert.throws(() => validateWebUrl("http://10.0.0.8/private"), /public/);
  assert.throws(() => validateWebUrl("http://192.168.1.20/private"), /public/);
  assert.throws(() => validateWebUrl("http://[::1]/private"), /public/);
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

function extractedJobs(jobs) {
  return new Response(JSON.stringify({ success: true, data: { json: { jobs } } }), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

function job(overrides = {}) {
  return {
    title: "Junior Data Analyst",
    employer: "Example Agency",
    location: "London",
    jobUrl: "/jobs/123",
    postedDate: "2026-09-12",
    employmentType: "Full time",
    description: "A graduate role supporting data analysis and stakeholder communication.",
    juniorEvidence: ["Open to graduates with 0–2 years of experience"],
    transferableSkills: ["data analysis", "stakeholder communication"],
    futureRelevantSignals: ["digital public services"],
    learningSignals: ["structured training"],
    seniorityWarnings: [],
    ...overrides,
  };
}

test("job URL validation removes duplicates and rejects private or excess sources", () => {
  assert.equal(normalizeUrls(["https://example.com/jobs", "https://example.com/jobs"]).length, 1);
  assert.throws(() => normalizeUrls([]), /at least one/);
  assert.throws(() => normalizeUrls(Array.from({ length: 6 }, (_, index) => `https://example.com/${index}`)), /no more than five/);
  assert.throws(() => normalizeUrls(["http://172.16.0.2/jobs"]), /public/);
});

test("job ranking puts junior evidence ahead of senior roles and returns exactly three reasons", () => {
  const source = {
    sourceDomain: "example.com",
    sourceUrl: "https://example.com/jobs",
  };
  const ranked = rankJobs([
    { ...job(), ...source },
    {
      ...job({
        title: "Senior Data Director",
        description: "Lead the division. Requires 8 years of experience.",
        juniorEvidence: [],
        transferableSkills: ["leadership"],
        futureRelevantSignals: ["data strategy"],
        learningSignals: [],
        seniorityWarnings: ["Director role requiring 8 years of experience"],
        jobUrl: "/jobs/456",
      }),
      ...source,
    },
  ]);

  assert.equal(ranked[0].title, "Junior Data Analyst");
  assert.equal(ranked[0].reasons.length, 3);
  assert.deepEqual(ranked[0].reasons.map((reason) => reason.heading), [
    "Accessible start",
    "Skills you can build",
    "Career exposure",
  ]);
});

test("job scan accepts one source and returns normalized recommendations", async () => {
  const originalFetch = globalThis.fetch;
  const previousKey = process.env.FIRECRAWL_API_KEY;
  process.env.FIRECRAWL_API_KEY = "test-key";
  globalThis.fetch = async () => extractedJobs([job()]);

  try {
    const { response, result } = mockResponse();
    await jobScanHandler({ method: "POST", body: { urls: ["https://example.com/jobs"] } }, response);
    assert.equal(result.status, 200);
    assert.equal(result.body.sources[0].status, "extracted");
    assert.equal(result.body.jobs.length, 1);
    assert.equal(result.body.jobs[0].jobUrl, "https://example.com/jobs/123");
    assert.equal(result.body.jobs[0].reasons.length, 3);
  } finally {
    globalThis.fetch = originalFetch;
    if (previousKey) process.env.FIRECRAWL_API_KEY = previousKey;
    else delete process.env.FIRECRAWL_API_KEY;
  }
});

test("job scan handles five sources and preserves results when one source fails", async () => {
  const originalFetch = globalThis.fetch;
  const previousKey = process.env.FIRECRAWL_API_KEY;
  process.env.FIRECRAWL_API_KEY = "test-key";
  const requestedUrls = [];
  globalThis.fetch = async (_url, options) => {
    const request = JSON.parse(options.body);
    requestedUrls.push(request.url);
    assert.equal(request.formats[0].type, "json");
    if (request.url.includes("broken.example")) {
      return new Response(JSON.stringify({ success: false }), { status: 403 });
    }
    return extractedJobs([job({
      title: `Junior Analyst ${new URL(request.url).hostname}`,
      jobUrl: `${request.url.replace(/\/$/, "")}/role`,
    })]);
  };

  try {
    const urls = [
      "https://one.example/jobs",
      "https://two.example/jobs",
      "https://broken.example/jobs",
      "https://four.example/jobs",
      "https://five.example/jobs",
    ];
    const { response, result } = mockResponse();
    await jobScanHandler({ method: "POST", body: { urls } }, response);

    assert.equal(result.status, 200);
    assert.equal(requestedUrls.length, 5);
    assert.equal(result.body.sources.length, 5);
    assert.equal(result.body.sources.find((source) => source.domain === "broken.example").status, "could_not_extract");
    assert.equal(result.body.jobs.length, 4);
    result.body.jobs.forEach((item) => assert.equal(item.reasons.length, 3));
  } finally {
    globalThis.fetch = originalFetch;
    if (previousKey) process.env.FIRECRAWL_API_KEY = previousKey;
    else delete process.env.FIRECRAWL_API_KEY;
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
