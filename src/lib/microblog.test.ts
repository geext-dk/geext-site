import assert from "node:assert/strict";
import test from "node:test";
import {
  fetchMicroblogPosts,
  paginateMicroblogPosts,
  sanitizeStatusHtml,
  type MicroblogPost,
} from "./microblog.ts";
import { formatLocalDateTime } from "./local-time.ts";

const instanceUrl = "https://social.example";

function status(id: string, overrides: Partial<Record<string, unknown>> = {}) {
  return {
    id,
    account: {
      id: "account-1",
      acct: "geext@social.example",
      username: "geext",
    },
    content: `<p>Post ${id}</p>`,
    created_at: "2026-08-18T08:00:00.000Z",
    url: `${instanceUrl}/@geext/${id}`,
    visibility: "public",
    spoiler_text: "",
    sensitive: false,
    in_reply_to_id: null,
    reblog: null,
    emojis: [],
    media_attachments: [],
    poll: null,
    ...overrides,
  };
}

function response(body: unknown, init: ResponseInit = {}) {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
    ...init,
  });
}

test("fetches account statuses in 40-item pages and filters to public originals", async () => {
  const requestedUrls: string[] = [];
  const fetchFn = async (input: string | URL) => {
    const url = String(input);
    requestedUrls.push(url);

    if (url.includes("/accounts/lookup")) {
      return response({ id: "account-1" });
    }

    if (!url.includes("max_id=older")) {
      return response(
        [
          status("newest"),
          status("reply", { in_reply_to_id: "other" }),
          status("boost", { reblog: { id: "original" } }),
          status("unlisted", { visibility: "unlisted" }),
        ],
        {
          headers: {
            "content-type": "application/json",
            link: `<${instanceUrl}/api/v1/accounts/account-1/statuses?limit=40&max_id=older>; rel="next"`,
          },
        },
      );
    }

    return response([status("older")]);
  };

  const posts = await fetchMicroblogPosts({
    fetchFn,
    token: "read-token",
    instanceUrl,
    account: "geext",
  });

  assert.deepEqual(
    posts.map((post) => post.id),
    ["newest", "older"],
  );
  assert.match(requestedUrls[1], /limit=40/);
  assert.match(requestedUrls[1], /only_public=true/);
  assert.equal(posts[0].contentHtml, "<p>Post newest</p>");
});

test("rejects a pagination link that would forward the token cross-origin", async () => {
  const fetchFn = async (input: string | URL) => {
    if (String(input).includes("/accounts/lookup")) {
      return response({ id: "account-1" });
    }

    return response([status("newest")], {
      headers: {
        link: `<https://attacker.example/statuses?max_id=1>; rel="next"`,
      },
    });
  };

  await assert.rejects(
    fetchMicroblogPosts({ fetchFn, token: "read-token", instanceUrl }),
    /another origin/,
  );
});

test("rejects repeated pagination links", async () => {
  const repeatedUrl = `${instanceUrl}/api/v1/accounts/account-1/statuses?limit=40&max_id=repeat`;
  const fetchFn = async (input: string | URL) => {
    if (String(input).includes("/accounts/lookup")) {
      return response({ id: "account-1" });
    }

    return response([status("newest")], {
      headers: { link: `<${repeatedUrl}>; rel="next"` },
    });
  };

  await assert.rejects(
    fetchMicroblogPosts({ fetchFn, token: "read-token", instanceUrl }),
    /repeated pagination link/,
  );
});

test("sanitizes unsafe markup while preserving safe rich content", () => {
  const html = sanitizeStatusHtml(
    '<p>Hello <strong>world</strong> <a href="javascript:alert(1)">bad</a> <a href="https://example.com">good</a><script>alert(1)</script></p>',
    instanceUrl,
  );

  assert.match(html, /<strong>world<\/strong>/);
  assert.match(html, /href="https:\/\/example.com\/?"/);
  assert.doesNotMatch(html, /javascript|script|alert/);
  assert.match(html, /target="_blank"/);
});

test("paginates the website at 18 posts and keeps an empty site on page one", () => {
  const posts = Array.from({ length: 37 }, (_, index) => ({
    id: String(index),
  })) as unknown as MicroblogPost[];

  assert.equal(paginateMicroblogPosts([], 1).totalPages, 1);
  assert.equal(paginateMicroblogPosts(posts, 1).posts.length, 18);
  assert.equal(paginateMicroblogPosts(posts, 2).posts.length, 18);
  assert.equal(paginateMicroblogPosts(posts, 3).posts.length, 1);
  assert.equal(paginateMicroblogPosts(posts, 4).currentPage, 3);
  assert.equal(paginateMicroblogPosts(posts, 3).totalPages, 3);
});

test("formats timestamps in the requested timezone while preserving invalid fallbacks", () => {
  const timestamp = "2026-08-18T23:30:00.000Z";
  const utc = formatLocalDateTime(timestamp, "en-US", "UTC");
  const tbilisi = formatLocalDateTime(timestamp, "en-US", "Asia/Tbilisi");

  assert.notEqual(utc, tbilisi);
  assert.equal(formatLocalDateTime("not-a-date", "en-US", "UTC"), "not-a-date");
});
