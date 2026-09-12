import { parseBody, validateWebUrl } from "../scrape.js";

const FIRECRAWL_ENDPOINT = "https://api.firecrawl.dev/v2/scrape";
const MAX_SOURCES = 5;
const MAX_JOBS_PER_SOURCE = 8;
const MAX_RESULTS = 5;

export const maxDuration = 60;

const EXTRACTION_PROMPT = `Extract up to 8 job opportunities visibly listed on this page. Focus on actual job postings, not navigation or promotional content. For each job return title, employer, location, direct job URL if visible, date, employment type, a short factual description, evidence that it is junior/graduate/entry-level, transferable skills, future-relevant technology/digital/data/policy/innovation signals, learning/training signals, and any evidence that the role is actually senior. Do not infer unsupported facts. Return empty strings or arrays when evidence is unavailable.`;

const STRING_FIELDS = {
  type: "string",
};

const STRING_LIST = {
  type: "array",
  items: { type: "string" },
};

const JOB_SCHEMA = {
  type: "object",
  properties: {
    jobs: {
      type: "array",
      maxItems: MAX_JOBS_PER_SOURCE,
      items: {
        type: "object",
        properties: {
          title: STRING_FIELDS,
          employer: STRING_FIELDS,
          location: STRING_FIELDS,
          jobUrl: STRING_FIELDS,
          postedDate: STRING_FIELDS,
          employmentType: STRING_FIELDS,
          description: STRING_FIELDS,
          juniorEvidence: STRING_LIST,
          transferableSkills: STRING_LIST,
          futureRelevantSignals: STRING_LIST,
          learningSignals: STRING_LIST,
          seniorityWarnings: STRING_LIST,
        },
        required: [
          "title",
          "employer",
          "location",
          "jobUrl",
          "postedDate",
          "employmentType",
          "description",
          "juniorEvidence",
          "transferableSkills",
          "futureRelevantSignals",
          "learningSignals",
          "seniorityWarnings",
        ],
      },
    },
  },
  required: ["jobs"],
};

const EARLY_CAREER_SIGNALS = [
  "junior",
  "graduate",
  "entry-level",
  "entry level",
  "trainee",
  "internship",
  "intern",
  "assistant",
  "associate",
  "coordinator",
  "analyst",
  "0-2 years",
  "0–2 years",
  "no prior experience",
];

const TRANSFERABLE_SIGNALS = [
  "analysis",
  "communication",
  "presentation",
  "research",
  "project management",
  "stakeholder",
  "problem solving",
  "teamwork",
  "customer service",
  "writing",
];

const FUTURE_SIGNALS = [
  "artificial intelligence",
  " ai ",
  "digital",
  "data",
  "technology",
  "software",
  "cyber",
  "cloud",
  "policy",
  "innovation",
  "sustainability",
];

const LEARNING_SIGNALS = [
  "training",
  "mentor",
  "mentorship",
  "learning",
  "development programme",
  "development program",
  "rotation",
  "qualification",
];

const SENIOR_SIGNALS = [
  "senior",
  "lead",
  "principal",
  "head",
  "director",
  "executive",
  "5+ years",
  "five years",
];

function text(value, maximum = 800) {
  return typeof value === "string" ? value.replace(/\s+/g, " ").trim().slice(0, maximum) : "";
}

function textList(value, maximum = 6) {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.map((item) => text(item, 220)).filter(Boolean))].slice(0, maximum);
}

function normalizeUrls(values) {
  if (!Array.isArray(values) || values.length < 1) {
    throw new Error("Provide at least one public job-listing URL.");
  }
  if (values.length > MAX_SOURCES) {
    throw new Error("Provide no more than five job-listing URLs.");
  }

  const unique = new Map();
  values.forEach((value, index) => {
    let parsed;
    try {
      parsed = validateWebUrl(value);
    } catch (error) {
      throw new Error(`Job Source ${index + 1}: ${error.message}`);
    }
    unique.set(parsed.href, parsed);
  });

  return [...unique.values()];
}

function normalizeJob(rawJob, sourceUrl) {
  if (!rawJob || typeof rawJob !== "object") return null;
  const title = text(rawJob.title, 180);
  if (!title) return null;

  let jobUrl = "";
  if (text(rawJob.jobUrl, 1_000)) {
    try {
      jobUrl = validateWebUrl(new URL(rawJob.jobUrl, sourceUrl).href).href;
    } catch {
      jobUrl = "";
    }
  }

  return {
    title,
    employer: text(rawJob.employer, 180),
    location: text(rawJob.location, 180),
    jobUrl,
    postedDate: text(rawJob.postedDate, 100),
    employmentType: text(rawJob.employmentType, 100),
    description: text(rawJob.description, 1_000),
    juniorEvidence: textList(rawJob.juniorEvidence),
    transferableSkills: textList(rawJob.transferableSkills),
    futureRelevantSignals: textList(rawJob.futureRelevantSignals),
    learningSignals: textList(rawJob.learningSignals),
    seniorityWarnings: textList(rawJob.seniorityWarnings),
    sourceDomain: sourceUrl.hostname.replace(/^www\./, ""),
    sourceUrl: sourceUrl.href,
  };
}

function matchingSignals(content, signals) {
  const searchable = ` ${content.toLocaleLowerCase()} `;
  return signals.filter((signal) => searchable.includes(signal));
}

function scoreJob(job) {
  const content = [
    job.title,
    job.description,
    ...job.juniorEvidence,
    ...job.transferableSkills,
    ...job.futureRelevantSignals,
    ...job.learningSignals,
    ...job.seniorityWarnings,
  ].join(" ");

  const earlyMatches = matchingSignals(content, EARLY_CAREER_SIGNALS);
  const transferableMatches = matchingSignals(content, TRANSFERABLE_SIGNALS);
  const futureMatches = matchingSignals(content, FUTURE_SIGNALS);
  const learningMatches = matchingSignals(content, LEARNING_SIGNALS);
  const seniorMatches = matchingSignals(content, SENIOR_SIGNALS);
  const seniorTitle = matchingSignals(job.title, SENIOR_SIGNALS).length > 0;

  const accessibility = Math.min(40, (job.juniorEvidence.length * 9) + (earlyMatches.length * 7));
  const transferable = Math.min(30, (job.transferableSkills.length * 6) + (transferableMatches.length * 3));
  const future = Math.min(20, (job.futureRelevantSignals.length * 5) + (futureMatches.length * 3));
  const learning = Math.min(10, (job.learningSignals.length * 4) + (learningMatches.length * 2));
  const seniorityPenalty = Math.min(80, (job.seniorityWarnings.length * 20) + (seniorMatches.length * 15) + (seniorTitle ? 25 : 0));

  return {
    score: Math.max(0, accessibility + transferable + future + learning - seniorityPenalty),
    earlyMatches,
  };
}

function sentence(value) {
  const cleaned = text(value, 190).replace(/[.!?]+$/, "");
  return cleaned ? `${cleaned}.` : "";
}

function buildReasons(job, earlyMatches) {
  const accessible = job.juniorEvidence[0]
    ? `The listing states: ${sentence(job.juniorEvidence[0])}`
    : earlyMatches[0]
      ? `The visible listing uses the early-career signal “${earlyMatches[0]}”.`
      : job.seniorityWarnings[0]
        ? `The role ranks lower because the listing states: ${sentence(job.seniorityWarnings[0])}`
        : "The visible listing does not state a senior title or an extensive experience requirement.";

  const skills = job.transferableSkills.length
    ? `The listing identifies ${job.transferableSkills.slice(0, 3).join(", ")}.`
    : "The visible listing does not provide specific transferable-skill evidence.";

  const exposure = job.futureRelevantSignals.length
    ? `The listing highlights ${job.futureRelevantSignals.slice(0, 3).join(", ")}.`
    : job.learningSignals.length
      ? `The listing highlights ${job.learningSignals.slice(0, 3).join(", ")}.`
      : "The visible listing does not provide specific future-relevant exposure evidence.";

  return [
    { heading: "Accessible start", text: accessible },
    { heading: "Skills you can build", text: skills },
    { heading: "Career exposure", text: exposure },
  ];
}

function rankJobs(jobs) {
  const unique = new Map();

  jobs.forEach((job) => {
    const scoring = scoreJob(job);
    const key = job.jobUrl.toLocaleLowerCase()
      || `${job.title}|${job.employer}|${job.sourceDomain}`.toLocaleLowerCase();
    const candidate = { ...job, ...scoring };
    const existing = unique.get(key);
    if (!existing || candidate.score > existing.score) unique.set(key, candidate);
  });

  return [...unique.values()]
    .sort((a, b) => b.score - a.score || a.title.localeCompare(b.title))
    .slice(0, MAX_RESULTS)
    .map((job, index) => ({
      rank: index + 1,
      title: job.title,
      employer: job.employer,
      location: job.location,
      jobUrl: job.jobUrl,
      postedDate: job.postedDate,
      employmentType: job.employmentType,
      sourceDomain: job.sourceDomain,
      reasons: buildReasons(job, job.earlyMatches),
    }));
}

function parseExtractedJson(value) {
  if (value && typeof value === "object") return value;
  if (typeof value !== "string") return {};
  try {
    return JSON.parse(value);
  } catch {
    return {};
  }
}

async function scanSource(sourceUrl, apiKey) {
  const source = {
    url: sourceUrl.href,
    domain: sourceUrl.hostname.replace(/^www\./, ""),
  };

  try {
    const firecrawlResponse = await fetch(FIRECRAWL_ENDPOINT, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        url: sourceUrl.href,
        formats: [{
          type: "json",
          prompt: EXTRACTION_PROMPT,
          schema: JOB_SCHEMA,
        }],
        onlyMainContent: true,
        removeBase64Images: true,
        blockAds: true,
        timeout: 45_000,
      }),
      signal: AbortSignal.timeout(52_000),
    });

    const payload = await firecrawlResponse.json().catch(() => ({}));
    if (!firecrawlResponse.ok || payload.success === false) {
      throw new Error("Firecrawl did not return a usable response.");
    }

    const extracted = parseExtractedJson(payload.data?.json);
    const jobs = (Array.isArray(extracted.jobs) ? extracted.jobs : [])
      .slice(0, MAX_JOBS_PER_SOURCE)
      .map((job) => normalizeJob(job, sourceUrl))
      .filter(Boolean);

    if (!jobs.length) {
      return {
        ...source,
        status: "no_jobs",
        message: "No usable job listings were found on this page.",
        jobs: [],
      };
    }

    return {
      ...source,
      status: "extracted",
      message: `Extracted ${jobs.length} job${jobs.length === 1 ? "" : "s"}.`,
      jobs,
    };
  } catch {
    return {
      ...source,
      status: "could_not_extract",
      message: "This page could not be cleanly extracted. Try another public job page.",
      jobs: [],
    };
  }
}

export default async function handler(request, response) {
  if (request.method !== "POST") {
    response.setHeader("Allow", "POST");
    return response.status(405).json({ error: "Use POST to scan job-listing pages." });
  }

  let urls;
  try {
    urls = normalizeUrls(parseBody(request.body).urls);
  } catch (error) {
    return response.status(400).json({ error: error.message });
  }

  const apiKey = process.env.FIRECRAWL_API_KEY;
  if (!apiKey) {
    return response.status(503).json({ error: "Junior Job Scout is not configured yet." });
  }

  const sourceResults = await Promise.all(urls.map((url) => scanSource(url, apiKey)));
  const sources = sourceResults.map(({ jobs, ...source }) => source);
  const jobs = rankJobs(sourceResults.flatMap((source) => source.jobs));
  const allFailed = sourceResults.every((source) => source.status === "could_not_extract");

  if (allFailed) {
    return response.status(502).json({
      error: "None of the supplied job pages could be cleanly extracted.",
      sources,
      jobs: [],
    });
  }

  return response.status(200).json({
    sources,
    jobs,
    message: jobs.length
      ? `Ranked ${jobs.length} promising early-career opportunit${jobs.length === 1 ? "y" : "ies"}.`
      : "No junior opportunities could be ranked from the visible listings.",
  });
}

export {
  buildReasons,
  normalizeJob,
  normalizeUrls,
  rankJobs,
  scanSource,
  scoreJob,
};
