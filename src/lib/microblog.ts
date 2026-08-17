import { ELEMENT_NODE, parse, renderSync, walkSync } from "ultrahtml";
import type { ElementNode } from "ultrahtml";
import sanitize from "ultrahtml/transformers/sanitize";
import { siteConfig } from "../site.config.ts";

export type GoToSocialEmoji = {
  shortcode: string;
  static_url: string;
  url: string;
};

export type GoToSocialMediaAttachment = {
  id: string;
  type: string;
  url: string;
  preview_url: string;
  description: string | null;
  meta?: Record<string, unknown> | null;
};

export type GoToSocialPollOption = {
  title: string;
  votes_count: number | null;
};

export type GoToSocialPoll = {
  expired: boolean;
  expires_at: string | null;
  multiple: boolean;
  options: GoToSocialPollOption[];
  votes_count: number | null;
  voters_count: number | null;
};

export type GoToSocialAccount = {
  id: string;
  acct: string;
  display_name?: string;
  username?: string;
};

export type GoToSocialStatus = {
  id: string;
  account: GoToSocialAccount;
  content: string;
  created_at: string;
  url: string | null;
  visibility: string;
  spoiler_text: string;
  sensitive: boolean;
  in_reply_to_id: string | null;
  reblog: unknown | null;
  emojis: GoToSocialEmoji[];
  media_attachments: GoToSocialMediaAttachment[];
  poll: GoToSocialPoll | null;
};

export type MicroblogPost = GoToSocialStatus & {
  contentHtml: string;
};

export type PaginatedMicroblogPosts = {
  posts: MicroblogPost[];
  currentPage: number;
  totalPages: number;
  totalPosts: number;
};

type Fetcher = (input: string | URL, init?: RequestInit) => Promise<Response>;

export type FetchMicroblogPostsOptions = {
  fetchFn?: Fetcher;
  token?: string;
  instanceUrl?: string;
  account?: string;
  fetchLimit?: number;
};

const DEFAULT_INSTANCE_URL = siteConfig.microblog.instanceUrl;
const DEFAULT_ACCOUNT = siteConfig.microblog.account;
const DEFAULT_FETCH_LIMIT = siteConfig.microblog.fetchLimit;

const allowedElements = [
  "a",
  "abbr",
  "b",
  "blockquote",
  "br",
  "code",
  "del",
  "em",
  "h1",
  "h2",
  "h3",
  "h4",
  "h5",
  "h6",
  "hr",
  "i",
  "img",
  "li",
  "ol",
  "p",
  "pre",
  "small",
  "span",
  "strong",
  "sub",
  "sup",
  "u",
  "ul",
];

const allowedAttributes = {
  alt: ["img"],
  class: ["*"],
  href: ["a"],
  lang: ["*"],
  loading: ["img"],
  rel: ["a"],
  src: ["img"],
  target: ["a"],
  title: ["a", "abbr", "img"],
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function requireString(value: unknown, field: string) {
  if (typeof value !== "string") {
    throw new Error(`GoToSocial returned an invalid ${field} field.`);
  }

  return value;
}

function parseStatus(value: unknown): GoToSocialStatus {
  if (!isRecord(value)) {
    throw new Error("GoToSocial returned a non-object status.");
  }

  const account = value.account;
  if (!isRecord(account)) {
    throw new Error("GoToSocial returned a status without an account.");
  }

  return {
    id: requireString(value.id, "status id"),
    account: {
      id: requireString(account.id, "account id"),
      acct: requireString(account.acct, "account handle"),
      display_name:
        typeof account.display_name === "string" ? account.display_name : "",
      username: typeof account.username === "string" ? account.username : "",
    },
    content: requireString(value.content, "status content"),
    created_at: requireString(value.created_at, "status created_at"),
    url: typeof value.url === "string" ? value.url : null,
    visibility: requireString(value.visibility, "status visibility"),
    spoiler_text:
      typeof value.spoiler_text === "string" ? value.spoiler_text : "",
    sensitive: value.sensitive === true,
    in_reply_to_id:
      typeof value.in_reply_to_id === "string" ? value.in_reply_to_id : null,
    reblog: value.reblog ?? null,
    emojis: Array.isArray(value.emojis)
      ? (value.emojis as GoToSocialEmoji[])
      : [],
    media_attachments: Array.isArray(value.media_attachments)
      ? (value.media_attachments as GoToSocialMediaAttachment[])
      : [],
    poll: isRecord(value.poll)
      ? (value.poll as unknown as GoToSocialPoll)
      : null,
  };
}

function isSafeHttpUrl(value: string, baseUrl: string) {
  try {
    const url = new URL(value, baseUrl);
    return url.protocol === "http:" || url.protocol === "https:"
      ? url.toString()
      : null;
  } catch {
    return null;
  }
}

export function sanitizeStatusHtml(
  content: string,
  instanceUrl = DEFAULT_INSTANCE_URL,
) {
  const document = parse(content);
  const sanitized = sanitize({
    allowElements: allowedElements,
    allowAttributes: allowedAttributes,
  })(document);

  walkSync(sanitized, (node) => {
    if (node.type !== ELEMENT_NODE) {
      return;
    }

    const element = node as ElementNode;
    const attributes = element.attributes;

    for (const attribute of ["href", "src"] as const) {
      if (!(attribute in attributes)) {
        continue;
      }

      const safeUrl = isSafeHttpUrl(attributes[attribute], instanceUrl);
      if (safeUrl) {
        attributes[attribute] = safeUrl;
      } else {
        delete attributes[attribute];
      }
    }

    if (element.name === "a") {
      attributes.target = "_blank";
      attributes.rel = "nofollow noopener noreferrer";
    }

    if (element.name === "img") {
      attributes.loading = "lazy";
      attributes.alt ??= "";
    }
  });

  return renderSync(sanitized);
}

function parseNextLink(linkHeader: string | null, origin: string) {
  if (!linkHeader) {
    return null;
  }

  for (const link of linkHeader.split(",")) {
    const match = link.match(
      /<([^>]+)>\s*;\s*rel\s*=\s*(?:"([^"]+)"|'([^']+)'|([^;\s]+))/i,
    );
    const relations = match?.[2] ?? match?.[3] ?? match?.[4] ?? "";
    if (!match || !relations.split(/\s+/).includes("next")) {
      continue;
    }

    const nextUrl = new URL(match[1], origin);
    if (nextUrl.origin !== origin) {
      throw new Error(
        "GoToSocial returned a pagination link to another origin.",
      );
    }

    return nextUrl.toString();
  }

  return null;
}

async function fetchJson(fetchFn: Fetcher, url: string, token: string) {
  let response: Response;
  try {
    response = await fetchFn(url, {
      headers: {
        accept: "application/json",
        authorization: `Bearer ${token}`,
      },
    });
  } catch (error) {
    throw new Error(
      `Unable to reach GoToSocial at ${url}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  const responseText = await response.text();
  if (!response.ok) {
    throw new Error(
      `GoToSocial request failed (${response.status} ${response.statusText}): ${responseText.slice(0, 240)}`,
    );
  }

  try {
    return { body: JSON.parse(responseText) as unknown, response };
  } catch {
    throw new Error(`GoToSocial returned invalid JSON for ${url}.`);
  }
}

function buildStatusesUrl(
  instanceUrl: string,
  accountId: string,
  fetchLimit: number,
) {
  const url = new URL(
    `/api/v1/accounts/${encodeURIComponent(accountId)}/statuses`,
    instanceUrl,
  );
  url.searchParams.set("limit", String(fetchLimit));
  url.searchParams.set("exclude_replies", "true");
  url.searchParams.set("exclude_reblogs", "true");
  url.searchParams.set("only_public", "true");
  return url;
}

export async function fetchMicroblogPosts(
  options: FetchMicroblogPostsOptions = {},
): Promise<MicroblogPost[]> {
  const instanceUrl = (options.instanceUrl ?? DEFAULT_INSTANCE_URL).replace(
    /\/$/,
    "",
  );
  const accountName = options.account ?? DEFAULT_ACCOUNT;
  const fetchFn = options.fetchFn ?? fetch;
  const buildToken =
    typeof process !== "undefined"
      ? process.env.GOTOSOCIAL_ACCESS_TOKEN
      : undefined;
  const token = options.token ?? buildToken;

  if (!token) {
    throw new Error(
      "GOTOSOCIAL_ACCESS_TOKEN is required to build the microblog. Create a read-only token with read:accounts and read:statuses scopes.",
    );
  }

  const origin = new URL(instanceUrl).origin;
  const lookupUrl = new URL("/api/v1/accounts/lookup", instanceUrl);
  lookupUrl.searchParams.set("acct", accountName);
  const lookup = await fetchJson(fetchFn, lookupUrl.toString(), token);
  if (!isRecord(lookup.body)) {
    throw new Error("GoToSocial account lookup returned an invalid response.");
  }

  const accountId = requireString(lookup.body.id, "account lookup id");
  let nextUrl = buildStatusesUrl(
    instanceUrl,
    accountId,
    options.fetchLimit ?? DEFAULT_FETCH_LIMIT,
  ).toString();
  const seenUrls = new Set<string>();
  const seenStatusIds = new Set<string>();
  const posts: MicroblogPost[] = [];

  while (nextUrl) {
    if (seenUrls.has(nextUrl)) {
      throw new Error("GoToSocial returned a repeated pagination link.");
    }
    seenUrls.add(nextUrl);

    const page = await fetchJson(fetchFn, nextUrl, token);
    if (!Array.isArray(page.body)) {
      throw new Error(
        `GoToSocial returned an invalid status page for ${nextUrl}.`,
      );
    }

    for (const value of page.body) {
      const status = parseStatus(value);
      if (
        status.visibility !== "public" ||
        status.in_reply_to_id !== null ||
        status.reblog !== null ||
        seenStatusIds.has(status.id)
      ) {
        continue;
      }

      seenStatusIds.add(status.id);
      posts.push({
        ...status,
        contentHtml: sanitizeStatusHtml(status.content, instanceUrl),
      });
    }

    nextUrl = parseNextLink(page.response.headers.get("link"), origin) ?? "";
  }

  return posts;
}

let cachedPosts: Promise<MicroblogPost[]> | undefined;

export function getMicroblogPosts() {
  cachedPosts ??= fetchMicroblogPosts();
  return cachedPosts;
}

export function paginateMicroblogPosts(
  posts: MicroblogPost[],
  pageNumber: number,
  pageSize = siteConfig.microblog.pageSize,
): PaginatedMicroblogPosts {
  const totalPages = Math.max(1, Math.ceil(posts.length / pageSize));
  const currentPage = Math.min(Math.max(1, Math.trunc(pageNumber)), totalPages);
  const start = (currentPage - 1) * pageSize;

  return {
    posts: posts.slice(start, start + pageSize),
    currentPage,
    totalPages,
    totalPosts: posts.length,
  };
}
