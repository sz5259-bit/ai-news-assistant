const FIRECRAWL_ENDPOINT = "https://api.firecrawl.dev/v2/scrape";
const MAX_CONTENT_LENGTH = 6_000;

function parseBody(body) {
  if (body && typeof body === "object") return body;
  if (typeof body !== "string" || !body.trim()) return {};
  try {
    return JSON.parse(body);
  } catch {
    return {};
  }
}

function validateWebUrl(value) {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error("A webpage URL is required.");
  }

  let url;
  try {
    url = new URL(value.trim());
  } catch {
    throw new Error("Enter a valid webpage URL.");
  }

  if (!["http:", "https:"].includes(url.protocol)) {
    throw new Error("Only http:// or https:// webpage URLs are allowed.");
  }

  if (url.username || url.password) {
    throw new Error("URLs containing usernames or passwords are not allowed.");
  }

  const hostname = url.hostname.toLowerCase();
  if (hostname === "localhost" || hostname.endsWith(".local") || hostname === "127.0.0.1" || hostname === "::1") {
    throw new Error("Only public webpage URLs are allowed.");
  }

  return url;
}

function cleanExcerpt(markdown) {
  if (typeof markdown !== "string") return "";
  return markdown
    .replace(/data:image\/[a-z0-9.+-]+;base64,[a-z0-9+/=\s]+/gi, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim()
    .slice(0, MAX_CONTENT_LENGTH);
}

function getFirecrawlError(payload, status) {
  const message = payload?.error || payload?.message || payload?.details;
  if (typeof message === "string" && message.trim()) return message.trim();
  if (status === 401 || status === 403) return "Firecrawl authentication failed.";
  if (status === 402) return "The Firecrawl account has insufficient credits.";
  if (status === 429) return "Firecrawl is temporarily rate-limited.";
  return "Firecrawl could not retrieve this page.";
}

export default async function handler(request, response) {
  if (request.method !== "POST") {
    response.setHeader("Allow", "POST");
    return response.status(405).json({ error: "Use POST to retrieve one webpage." });
  }

  let url;
  try {
    url = validateWebUrl(parseBody(request.body).url);
  } catch (error) {
    return response.status(400).json({ error: error.message });
  }

  const apiKey = process.env.FIRECRAWL_API_KEY;
  if (!apiKey) {
    return response.status(503).json({ error: "Deep Read is not configured yet. Add FIRECRAWL_API_KEY and retry." });
  }

  try {
    const firecrawlResponse = await fetch(FIRECRAWL_ENDPOINT, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        url: url.href,
        formats: ["markdown"],
        onlyMainContent: true,
        removeBase64Images: true,
        timeout: 30_000,
      }),
      signal: AbortSignal.timeout(40_000),
    });

    const payload = await firecrawlResponse.json().catch(() => ({}));
    if (!firecrawlResponse.ok || payload.success === false) {
      return response.status(firecrawlResponse.status >= 400 ? firecrawlResponse.status : 502).json({
        error: getFirecrawlError(payload, firecrawlResponse.status),
      });
    }

    const data = payload.data || {};
    const metadata = data.metadata || {};
    const content = cleanExcerpt(data.markdown);

    if (!content) {
      return response.status(502).json({ error: "Firecrawl returned no readable content for this page." });
    }

    return response.status(200).json({
      title: metadata.title || metadata.ogTitle || url.hostname,
      domain: url.hostname.replace(/^www\./, ""),
      url: metadata.sourceURL || metadata.url || url.href,
      description: metadata.description || metadata.ogDescription || "",
      content,
    });
  } catch (error) {
    const timedOut = error?.name === "TimeoutError" || error?.name === "AbortError";
    return response.status(502).json({
      error: timedOut ? "Firecrawl took too long to respond." : "Deep Read could not reach Firecrawl.",
    });
  }
}

export { cleanExcerpt, parseBody, validateWebUrl };
