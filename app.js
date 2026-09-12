const loadButton = document.querySelector("#load-news");
const filterInput = document.querySelector("#news-filter");
const newsStatus = document.querySelector("#news-status");
const articleList = document.querySelector("#article-list");
const deepReadPanel = document.querySelector("#deep-read-panel");
const deepReadContent = document.querySelector("#deep-read-content");
const explorerForm = document.querySelector("#web-explorer-form");
const explorerInput = document.querySelector("#web-explorer-url");
const scrapePageButton = document.querySelector("#scrape-page");
const explorerStatus = document.querySelector("#web-explorer-status");
const explorerResult = document.querySelector("#web-explorer-result");
const jobScoutForm = document.querySelector("#job-scout-form");
const jobSourceInputs = [...document.querySelectorAll(".job-source-input")];
const findJobsButton = document.querySelector("#find-junior-jobs");
const clearJobsButton = document.querySelector("#clear-job-results");
const jobSourceStatuses = document.querySelector("#job-source-statuses");
const jobScoutStatus = document.querySelector("#job-scout-status");
const jobResults = document.querySelector("#job-results");

let loadedArticles = [];

function setNewsStatus(message, isError = false) {
  newsStatus.textContent = message;
  newsStatus.classList.toggle("error", isError);
}

function formatDate(value) {
  if (!value) return "Date unavailable";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "Date unavailable";
  return new Intl.DateTimeFormat(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(date);
}

function makeLink(label, url, className = "original-link") {
  const link = document.createElement("a");
  link.className = className;
  link.href = url;
  link.target = "_blank";
  link.rel = "noopener noreferrer";
  link.textContent = label;
  return link;
}

function createScrapeResult(payload, fallbackUrl, linkLabel) {
  const wrapper = document.createDocumentFragment();

  const title = document.createElement("h3");
  title.textContent = payload.title || payload.domain || "Retrieved webpage";

  const source = document.createElement("p");
  source.className = "result-source";
  source.textContent = `Retrieved from ${payload.domain || new URL(fallbackUrl).hostname}`;

  const url = document.createElement("p");
  url.className = "result-url";
  url.textContent = payload.url || fallbackUrl;

  wrapper.append(title, source, url);

  if (payload.description) {
    const description = document.createElement("p");
    description.className = "result-description";
    description.textContent = payload.description;
    wrapper.append(description);
  }

  const excerpt = document.createElement("p");
  excerpt.className = "deep-read-content";
  excerpt.textContent = payload.content || "No readable excerpt was returned.";
  wrapper.append(excerpt, makeLink(linkLabel, payload.url || fallbackUrl));

  return wrapper;
}

function createArticleCard(article) {
  const card = document.createElement("article");
  card.className = "article-card";

  const meta = document.createElement("div");
  meta.className = "article-meta";

  const source = document.createElement("span");
  source.className = "source-label";
  source.textContent = article.source;

  const date = document.createElement("time");
  date.dateTime = article.publishedAt || "";
  date.textContent = formatDate(article.publishedAt);
  meta.append(source, date);

  const title = document.createElement("h3");
  title.textContent = article.title;

  const summary = document.createElement("p");
  summary.className = "article-summary";
  summary.textContent = article.summary || "No RSS summary was provided for this story.";

  const actions = document.createElement("div");
  actions.className = "article-actions";
  actions.append(makeLink("Read Original Article ↗", article.url));

  const deepReadButton = document.createElement("button");
  deepReadButton.className = "deep-read-button";
  deepReadButton.type = "button";
  deepReadButton.textContent = "Deep Read";
  deepReadButton.addEventListener("click", () => runDeepRead(article, deepReadButton));
  actions.append(deepReadButton);

  card.append(meta, title, summary, actions);
  return card;
}

function renderArticles() {
  const query = filterInput.value.trim().toLocaleLowerCase();
  const matches = loadedArticles.filter((article) => {
    const searchable = `${article.title} ${article.summary}`.toLocaleLowerCase();
    return searchable.includes(query);
  });

  articleList.replaceChildren();

  if (!matches.length && loadedArticles.length) {
    const empty = document.createElement("p");
    empty.className = "empty-state";
    empty.textContent = `No matching stories for “${filterInput.value.trim()}”.`;
    articleList.append(empty);
    setNewsStatus(`Showing 0 of ${loadedArticles.length} loaded stories.`);
    return;
  }

  const fragment = document.createDocumentFragment();
  matches.forEach((article) => fragment.append(createArticleCard(article)));
  articleList.append(fragment);

  if (loadedArticles.length) {
    setNewsStatus(`Showing ${matches.length} of ${loadedArticles.length} loaded stories.`);
  }
}

async function loadNews() {
  loadButton.disabled = true;
  loadButton.textContent = "Loading feeds…";
  filterInput.disabled = true;
  setNewsStatus("Fetching WIRED, TechCrunch and VentureBeat RSS feeds…");

  try {
    const response = await fetch("/api/news");
    const payload = await response.json().catch(() => ({}));

    if (!response.ok && !payload.articles?.length) {
      throw new Error(payload.error || "The news feeds could not be loaded.");
    }

    loadedArticles = Array.isArray(payload.articles) ? payload.articles : [];
    filterInput.disabled = loadedArticles.length === 0;
    renderArticles();

    if (payload.errors?.length) {
      const failedSources = payload.errors.map((item) => item.source).join(", ");
      setNewsStatus(`Loaded ${loadedArticles.length} stories. Some sources were unavailable: ${failedSources}.`, true);
    } else if (!loadedArticles.length) {
      setNewsStatus("The feeds responded, but no stories were available.", true);
    }
  } catch (error) {
    loadedArticles = [];
    articleList.replaceChildren();
    setNewsStatus(`${error.message} Please try again.`, true);
  } finally {
    loadButton.disabled = false;
    loadButton.textContent = "Load Latest News";
  }
}

function showDeepReadError(message) {
  deepReadContent.replaceChildren();
  const error = document.createElement("p");
  error.className = "deep-read-error";
  error.textContent = `${message} Please try again.`;
  deepReadContent.append(error);
}

async function runDeepRead(article, button) {
  deepReadPanel.hidden = false;
  deepReadContent.replaceChildren();

  const loading = document.createElement("p");
  loading.textContent = `Retrieving “${article.title}”…`;
  deepReadContent.append(loading);
  deepReadPanel.scrollIntoView({ behavior: "smooth", block: "nearest" });

  button.disabled = true;
  button.textContent = "Retrieving…";

  try {
    const response = await fetch("/api/scrape", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ url: article.url }),
    });
    const payload = await response.json().catch(() => ({}));

    if (!response.ok) {
      throw new Error(payload.error || "Deep Read could not retrieve this article.");
    }

    deepReadContent.replaceChildren(
      createScrapeResult(
        { ...payload, title: payload.title || article.title },
        article.url,
        "Open Original Article ↗",
      ),
    );
  } catch (error) {
    showDeepReadError(error.message);
  } finally {
    button.disabled = false;
    button.textContent = "Deep Read";
  }
}

function setExplorerStatus(message, isError = false) {
  explorerStatus.textContent = message;
  explorerStatus.classList.toggle("error", isError);
}

async function exploreWebPage(event) {
  event.preventDefault();
  const requestedUrl = explorerInput.value.trim();

  explorerResult.hidden = true;
  explorerResult.replaceChildren();

  if (!requestedUrl) {
    setExplorerStatus("Enter a public webpage URL before choosing Scrape Page.", true);
    explorerInput.focus();
    return;
  }

  scrapePageButton.disabled = true;
  scrapePageButton.textContent = "Scraping page…";
  explorerInput.disabled = true;
  setExplorerStatus(`Retrieving ${requestedUrl}…`);

  try {
    const response = await fetch("/api/scrape", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ url: requestedUrl }),
    });
    const payload = await response.json().catch(() => ({}));

    if (!response.ok) {
      throw new Error(payload.error || "Web Explorer could not retrieve this page.");
    }

    explorerResult.replaceChildren(createScrapeResult(payload, requestedUrl, "Open Original Page ↗"));
    explorerResult.hidden = false;
    setExplorerStatus("Page retrieved successfully.");
  } catch (error) {
    setExplorerStatus(`${error.message} Please try again.`, true);
  } finally {
    scrapePageButton.disabled = false;
    scrapePageButton.textContent = "Scrape Page";
    explorerInput.disabled = false;
  }
}

function setJobScoutStatus(message, isError = false) {
  jobScoutStatus.textContent = message;
  jobScoutStatus.classList.toggle("error", isError);
}

function updateJobSourceStatuses(values, results = []) {
  const labels = {
    extracted: "Extracted",
    no_jobs: "No jobs found",
    could_not_extract: "Could not extract",
  };

  [...jobSourceStatuses.children].forEach((item, index) => {
    const status = item.querySelector("strong");
    const value = values[index]?.trim();
    let canonicalValue = value;
    try {
      canonicalValue = value ? new URL(value).href : "";
    } catch {
      canonicalValue = value;
    }
    const result = value
      ? results.find((source) => source.url === canonicalValue)
      : null;

    status.className = "";
    item.removeAttribute("title");
    if (!value) {
      status.textContent = "Waiting";
    } else if (!results.length) {
      status.textContent = "Scanning";
      status.className = "scanning";
    } else if (result) {
      status.textContent = labels[result.status] || "Could not extract";
      status.className = result.status;
      item.title = result.message || "";
    } else {
      status.textContent = "Could not extract";
      status.className = "could_not_extract";
    }
  });
}

function createJobCard(job) {
  const card = document.createElement("article");
  card.className = "job-card";

  const rank = document.createElement("span");
  rank.className = "job-rank";
  rank.textContent = `#${job.rank}`;

  const title = document.createElement("h4");
  title.textContent = job.title;

  const meta = document.createElement("div");
  meta.className = "job-meta";
  [
    job.employer,
    job.location,
    job.employmentType,
    job.postedDate,
    job.sourceDomain,
  ].filter(Boolean).forEach((value) => {
    const item = document.createElement("span");
    item.textContent = value;
    meta.append(item);
  });

  const reasons = document.createElement("ul");
  reasons.className = "job-reasons";
  (Array.isArray(job.reasons) ? job.reasons : []).slice(0, 3).forEach((reason) => {
    const item = document.createElement("li");
    const heading = document.createElement("strong");
    heading.textContent = `${reason.heading}: `;
    item.append(heading, document.createTextNode(reason.text));
    reasons.append(item);
  });

  const actions = document.createElement("div");
  actions.className = "article-actions";
  if (job.jobUrl) {
    actions.append(makeLink("Open Job Posting ↗", job.jobUrl));
  } else {
    const unavailable = document.createElement("span");
    unavailable.className = "link-unavailable";
    unavailable.textContent = "Original posting link unavailable";
    actions.append(unavailable);
  }

  card.append(rank, title, meta, reasons, actions);
  return card;
}

function renderJobResults(jobs) {
  jobResults.replaceChildren();
  if (!jobs.length) {
    const empty = document.createElement("p");
    empty.className = "empty-state";
    empty.textContent = "No junior opportunities could be ranked from the visible listings.";
    jobResults.append(empty);
    return;
  }

  const fragment = document.createDocumentFragment();
  jobs.forEach((job) => fragment.append(createJobCard(job)));
  jobResults.append(fragment);
}

function validateJobSourceInputs(values) {
  if (!values[0]) {
    throw new Error("Enter a public URL in Job Source 1.");
  }

  values.forEach((value, index) => {
    if (!value) return;
    let parsed;
    try {
      parsed = new URL(value);
    } catch {
      throw new Error(`Job Source ${index + 1} needs a valid webpage URL.`);
    }
    if (!["http:", "https:"].includes(parsed.protocol)) {
      throw new Error(`Job Source ${index + 1} must use http:// or https://.`);
    }
  });
}

async function runJobScout(event) {
  event.preventDefault();
  const values = jobSourceInputs.map((input) => input.value.trim());

  try {
    validateJobSourceInputs(values);
  } catch (error) {
    setJobScoutStatus(error.message, true);
    const invalidIndex = values.findIndex((value, index) => index === 0 ? !value : false);
    jobSourceInputs[Math.max(0, invalidIndex)].focus();
    return;
  }

  const urls = values.filter(Boolean);
  findJobsButton.disabled = true;
  findJobsButton.textContent = "Scanning job pages…";
  clearJobsButton.disabled = true;
  jobSourceInputs.forEach((input) => { input.disabled = true; });
  jobResults.replaceChildren();
  updateJobSourceStatuses(values);
  setJobScoutStatus(`Scanning ${urls.length} public job page${urls.length === 1 ? "" : "s"}…`);

  try {
    const response = await fetch("/api/jobs/scan", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ urls }),
    });
    const payload = await response.json().catch(() => ({}));
    updateJobSourceStatuses(values, Array.isArray(payload.sources) ? payload.sources : []);

    if (!response.ok) {
      throw new Error(payload.error || "Junior Job Scout could not scan these pages.");
    }

    const jobs = Array.isArray(payload.jobs) ? payload.jobs : [];
    renderJobResults(jobs);
    setJobScoutStatus(payload.message || `Ranked ${jobs.length} junior opportunities.`);
  } catch (error) {
    renderJobResults([]);
    setJobScoutStatus(`${error.message} Please try another public job page.`, true);
  } finally {
    findJobsButton.disabled = false;
    findJobsButton.textContent = "Find Junior Opportunities";
    clearJobsButton.disabled = false;
    jobSourceInputs.forEach((input) => { input.disabled = false; });
  }
}

function clearJobScout() {
  jobScoutForm.reset();
  jobResults.replaceChildren();
  updateJobSourceStatuses(jobSourceInputs.map(() => ""));
  setJobScoutStatus("Add at least one public job-listing page to begin.");
  jobSourceInputs[0].focus();
}

loadButton.addEventListener("click", loadNews);
filterInput.addEventListener("input", renderArticles);
explorerForm.addEventListener("submit", exploreWebPage);
jobScoutForm.addEventListener("submit", runJobScout);
clearJobsButton.addEventListener("click", clearJobScout);
