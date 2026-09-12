import { XMLParser, XMLValidator } from "fast-xml-parser";

const FEEDS = [
  { source: "WIRED", url: "https://www.wired.com/feed/tag/ai/latest/rss" },
  { source: "TechCrunch", url: "https://techcrunch.com/category/artificial-intelligence/feed/" },
  { source: "VentureBeat", url: "https://venturebeat.com/category/ai/feed/" },
];

const ITEMS_PER_SOURCE = 6;
const MAX_ITEMS = 18;

const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: "@_",
  trimValues: true,
});

function asArray(value) {
  if (value == null) return [];
  return Array.isArray(value) ? value : [value];
}

function extractText(value) {
  if (value == null) return "";
  if (typeof value === "string" || typeof value === "number") return String(value);
  if (Array.isArray(value)) return value.map(extractText).find(Boolean) || "";
  if (typeof value === "object") {
    return extractText(value["#text"] ?? value.__cdata ?? value.value ?? "");
  }
  return "";
}

function cleanText(value) {
  return extractText(value)
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, " ")
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&#39;/gi, "'")
    .replace(/&quot;/gi, '"')
    .replace(/&#x([0-9a-f]+);/gi, (_, code) => String.fromCodePoint(Number.parseInt(code, 16)))
    .replace(/&#([0-9]+);/g, (_, code) => String.fromCodePoint(Number.parseInt(code, 10)))
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 900);
}

function extractLink(value) {
  if (typeof value === "string") return value;
  for (const link of asArray(value)) {
    if (typeof link === "string") return link;
    if (link?.["@_rel"] === "alternate" && link?.["@_href"]) return link["@_href"];
    if (link?.["@_href"]) return link["@_href"];
    if (link?.["#text"]) return link["#text"];
  }
  return "";
}

function normalizeDate(value) {
  const raw = extractText(value);
  if (!raw) return "";
  const date = new Date(raw);
  return Number.isNaN(date.getTime()) ? "" : date.toISOString();
}

function normalizeItem(item, source) {
  const title = cleanText(item.title) || "Untitled story";
  const url = extractLink(item.link);
  const publishedAt = normalizeDate(item.pubDate ?? item.published ?? item.updated ?? item["dc:date"]);
  const summary = cleanText(item.description ?? item.summary ?? item["content:encoded"] ?? item.content);
  const guid = extractText(item.guid ?? item.id);

  if (!url || !/^https?:\/\//i.test(url)) return null;

  return {
    id: guid || `${source}-${url}`,
    source,
    title,
    url,
    publishedAt,
    summary,
  };
}

function parseFeed(xml, source) {
  const validation = XMLValidator.validate(xml);
  if (validation !== true) throw new Error("The feed returned invalid XML.");

  const document = parser.parse(xml);
  const entries = document?.rss?.channel?.item ?? document?.feed?.entry ?? [];

  return asArray(entries)
    .map((item) => normalizeItem(item, source))
    .filter(Boolean)
    .slice(0, ITEMS_PER_SOURCE);
}

async function fetchFeed(feed) {
  const response = await fetch(feed.url, {
    headers: {
      Accept: "application/rss+xml, application/atom+xml, application/xml, text/xml",
      "User-Agent": "AI-News-Assistant/1.0",
    },
    signal: AbortSignal.timeout(12_000),
  });

  if (!response.ok) throw new Error(`Feed responded with HTTP ${response.status}.`);
  return parseFeed(await response.text(), feed.source);
}

export default async function handler(request, response) {
  if (request.method !== "GET") {
    response.setHeader("Allow", "GET");
    return response.status(405).json({ error: "Use GET to load news." });
  }

  const results = await Promise.allSettled(FEEDS.map(fetchFeed));
  const articles = [];
  const errors = [];

  results.forEach((result, index) => {
    if (result.status === "fulfilled") {
      articles.push(...result.value);
    } else {
      errors.push({
        source: FEEDS[index].source,
        message: result.reason?.message || "Feed unavailable.",
      });
    }
  });

  articles.sort((left, right) => {
    const leftTime = left.publishedAt ? Date.parse(left.publishedAt) : 0;
    const rightTime = right.publishedAt ? Date.parse(right.publishedAt) : 0;
    return rightTime - leftTime;
  });

  const payload = {
    articles: articles.slice(0, MAX_ITEMS),
    errors,
    partial: errors.length > 0 && articles.length > 0,
  };

  response.setHeader("Cache-Control", "s-maxage=300, stale-while-revalidate=600");

  if (!articles.length && errors.length) {
    return response.status(502).json({ ...payload, error: "All news feeds are currently unavailable." });
  }

  return response.status(200).json(payload);
}

export { cleanText, normalizeItem, parseFeed };
