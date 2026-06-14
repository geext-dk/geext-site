import {
  publishNextBatch,
  readState,
  summarizeState,
} from "./publisher.js";

export default {
  async scheduled(_controller, env, ctx) {
    ctx.waitUntil(publishNextBatch(env));
  },

  async fetch(request, env) {
    const url = new URL(request.url);

    if (request.method === "GET" && url.pathname === "/health") {
      const state = await readState(env);

      return jsonResponse({
        ok: true,
        state: summarizeState(state),
        config: {
          catalogUrlConfigured: Boolean(env.PHOTO_CATALOG_URL),
          chatIdConfigured: Boolean(env.TELEGRAM_CHAT_ID),
          adminTokenConfigured: Boolean(env.ADMIN_TOKEN),
        },
      });
    }

    if (request.method === "POST" && url.pathname === "/run") {
      if (!isAuthorized(request, env)) {
        return jsonResponse({ ok: false, error: "Unauthorized" }, 401);
      }

      const result = await publishNextBatch(env, {
        dryRun: url.searchParams.get("dryRun") === "1",
      });

      return jsonResponse(result, result.ok ? 200 : 500);
    }

    return jsonResponse({ ok: false, error: "Not found" }, 404);
  },
};

function isAuthorized(request, env) {
  if (!env.ADMIN_TOKEN) {
    return false;
  }

  const authorization = request.headers.get("Authorization") ?? "";
  const bearer = authorization.match(/^Bearer\s+(.+)$/i)?.[1];
  const headerToken = request.headers.get("X-Admin-Token");

  return bearer === env.ADMIN_TOKEN || headerToken === env.ADMIN_TOKEN;
}

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body, null, 2), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
    },
  });
}
