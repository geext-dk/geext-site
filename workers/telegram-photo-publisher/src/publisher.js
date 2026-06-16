export const STATE_KEY = "telegram-photo-publisher:state";
export const STATE_SCHEMA_VERSION = 1;
export const BATCH_SIZE = 10;
export const DEFAULT_CAPTION_TEMPLATE = `<b>Новая партия фоточек!</b>

Плёнка: {{film}}
Камера: {{camera}}
Даты: {{dateRange}}`;

const dateFormatter = new Intl.DateTimeFormat("ru-RU", {
  year: "numeric",
  month: "short",
  day: "numeric",
  timeZone: "UTC",
});
const dateWithoutYearFormatter = new Intl.DateTimeFormat("ru-RU", {
  month: "short",
  day: "numeric",
  timeZone: "UTC",
});
const yearFormatter = new Intl.DateTimeFormat("ru-RU", {
  year: "numeric",
  timeZone: "UTC",
});

export async function publishNextBatch(env, options = {}) {
  const { dryRun = false, now = new Date(), fetchImpl = fetch } = options;
  assertEnvironment(env, { dryRun });

  const catalog = await fetchCatalog(env.PHOTO_CATALOG_URL, fetchImpl);
  const state = await readState(env);
  const plan = planNextPublish(catalog, state, {
    now,
    captionTemplate: env.CAPTION_TEMPLATE,
  });

  if (plan.status !== "ready") {
    return {
      ok: true,
      dryRun,
      status: plan.status,
      reason: plan.reason,
      state: summarizeState(state),
    };
  }

  validateBatchForTelegram(plan.batch);

  let telegram = null;
  if (!dryRun) {
    telegram = await sendTelegramBatch(env, plan.batch, fetchImpl);
    await writeState(env, plan.nextState);
  }

  return {
    ok: true,
    dryRun,
    status: plan.status,
    roll: plan.batch.roll,
    caption: plan.batch.caption,
    batch: summarizeBatch(plan.batch),
    nextState: summarizeState(plan.nextState),
    telegram,
  };
}

export async function fetchCatalog(catalogUrl, fetchImpl = fetch) {
  if (!catalogUrl) {
    throw new Error("PHOTO_CATALOG_URL is required");
  }

  const response = await fetchImpl(catalogUrl, {
    headers: {
      Accept: "application/json",
    },
  });

  if (!response.ok) {
    throw new Error(`Failed to fetch photo catalog: ${response.status}`);
  }

  return response.json();
}

export async function readState(env) {
  if (!env.PHOTO_PUBLISHER_STATE) {
    throw new Error("PHOTO_PUBLISHER_STATE KV binding is required");
  }

  const value = await env.PHOTO_PUBLISHER_STATE.get(STATE_KEY, { type: "json" });
  return normalizeState(value);
}

export async function writeState(env, state) {
  await env.PHOTO_PUBLISHER_STATE.put(STATE_KEY, JSON.stringify(normalizeState(state)));
}

export function planNextPublish(catalog, state = {}, options = {}) {
  const {
    batchSize = BATCH_SIZE,
    now = new Date(),
    captionTemplate = DEFAULT_CAPTION_TEMPLATE,
  } = options;
  const rolls = buildRolls(catalog?.photos ?? []);
  const currentState = normalizeState(state);

  if (rolls.length === 0) {
    return {
      status: "empty",
      reason: "Photo catalog contains no rolls",
    };
  }

  let rollIndex = initialRollIndex(rolls, currentState.currentRoll);
  let publishedImageIds = new Set(currentState.publishedImageIds);

  while (rollIndex >= 0 && rollIndex < rolls.length) {
    const roll = rolls[rollIndex];

    if (roll.roll !== currentState.currentRoll) {
      publishedImageIds = new Set();
    }

    const knownPublishedIds = new Set(
      [...publishedImageIds].filter((id) => roll.photoIds.has(id)),
    );
    const unpublishedPhotos = roll.photos.filter((photo) => !knownPublishedIds.has(photo.id));

    if (unpublishedPhotos.length === 0) {
      rollIndex += 1;
      publishedImageIds = new Set();
      continue;
    }

    const photos = unpublishedPhotos.slice(0, batchSize);
    const nextPublishedIds = uniqueStrings([...knownPublishedIds, ...photos.map((photo) => photo.id)]);
    const willCompleteRoll = nextPublishedIds.length >= roll.photos.length;
    const nextRoll = willCompleteRoll ? rolls[rollIndex + 1] : null;
    const nextState = normalizeState({
      schemaVersion: STATE_SCHEMA_VERSION,
      currentRoll: nextRoll?.roll ?? roll.roll,
      lastFilmStock: roll.film,
      publishedImageIds: nextRoll ? [] : nextPublishedIds,
      lastPostedAt: now.toISOString(),
    });

    return {
      status: "ready",
      batch: {
        roll: roll.roll,
        film: roll.film,
        camera: roll.camera,
        dateRange: roll.dateRange,
        caption: formatCaption(roll, captionTemplate),
        photos,
      },
      nextState,
    };
  }

  return {
    status: "exhausted",
    reason: "All known rolls have been published",
  };
}

export function buildRolls(photos) {
  const groups = new Map();

  for (const photo of photos) {
    if (!photo?.roll || !photo?.id) {
      continue;
    }

    const roll = String(photo.roll);
    const group = groups.get(roll) ?? [];
    group.push(photo);
    groups.set(roll, group);
  }

  return [...groups.entries()]
    .map(([roll, rollPhotos]) => {
      const sortedPhotos = [...rollPhotos].sort(comparePhotosInRoll);
      const datedPhotos = sortedPhotos
        .map((photo) => parsePhotoDate(photo.metadata?.date))
        .filter(Boolean)
        .sort((a, b) => a.timestamp - b.timestamp);

      return {
        roll,
        photos: sortedPhotos,
        photoIds: new Set(sortedPhotos.map((photo) => photo.id)),
        film: firstPresent(sortedPhotos.map((photo) => photo.metadata?.film)) ?? "Unknown Film",
        camera:
          firstPresent(sortedPhotos.map((photo) => photo.metadata?.cameraModel)) ??
          cameraFromRoll(sortedPhotos[0]?.sourcePath) ??
          "Unknown Camera",
        dateRange: formatDateRange(datedPhotos),
      };
    })
    .sort((a, b) => naturalCompare(a.roll, b.roll));
}

export function formatCaption(roll, template = DEFAULT_CAPTION_TEMPLATE) {
  const values = {
    film: roll.film || "?",
    camera: roll.camera || "?",
    dateRange: roll.dateRange || "?",
  };

  return String(template || DEFAULT_CAPTION_TEMPLATE).replace(
    /\{\{\s*(film|camera|dateRange)\s*\}\}/g,
    (_placeholder, key) => escapeTelegramHtml(values[key]),
  );
}

export function telegramRequestForBatch(chatId, batch) {
  if (!chatId) {
    throw new Error("TELEGRAM_CHAT_ID is required");
  }

  if (batch.photos.length === 1) {
    return {
      method: "sendPhoto",
      payload: {
        chat_id: chatId,
        photo: telegramUrlForPhoto(batch.photos[0]),
        caption: batch.caption,
        parse_mode: "HTML",
      },
    };
  }

  return {
    method: "sendMediaGroup",
    payload: {
      chat_id: chatId,
      media: batch.photos.map((photo, index) => ({
        type: "photo",
        media: telegramUrlForPhoto(photo),
        ...(index === 0 ? { caption: batch.caption, parse_mode: "HTML" } : {}),
      })),
    },
  };
}

export function summarizeState(state) {
  const normalizedState = normalizeState(state);

  return {
    schemaVersion: normalizedState.schemaVersion,
    currentRoll: normalizedState.currentRoll,
    lastFilmStock: normalizedState.lastFilmStock,
    publishedImageCount: normalizedState.publishedImageIds.length,
    lastPostedAt: normalizedState.lastPostedAt,
  };
}

async function sendTelegramBatch(env, batch, fetchImpl) {
  const request = telegramRequestForBatch(env.TELEGRAM_CHAT_ID, batch);
  const response = await fetchImpl(
    `https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/${request.method}`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify(request.payload),
    },
  );
  const data = await response.json().catch(() => null);

  if (!response.ok || data?.ok !== true) {
    throw new Error(
      `Telegram ${request.method} failed: ${data?.description ?? response.status}`,
    );
  }

  return {
    method: request.method,
    messageCount: Array.isArray(data.result) ? data.result.length : 1,
  };
}

function assertEnvironment(env, options) {
  if (!env.PHOTO_PUBLISHER_STATE) {
    throw new Error("PHOTO_PUBLISHER_STATE KV binding is required");
  }

  if (!env.PHOTO_CATALOG_URL) {
    throw new Error("PHOTO_CATALOG_URL is required");
  }

  if (!options.dryRun && !env.TELEGRAM_BOT_TOKEN) {
    throw new Error("TELEGRAM_BOT_TOKEN is required");
  }

  if (!options.dryRun && !env.TELEGRAM_CHAT_ID) {
    throw new Error("TELEGRAM_CHAT_ID is required");
  }
}

function validateBatchForTelegram(batch) {
  if (batch.photos.length < 1 || batch.photos.length > BATCH_SIZE) {
    throw new Error(`Telegram batch must contain 1-${BATCH_SIZE} photos`);
  }

  for (const photo of batch.photos) {
    if (!telegramUrlForPhoto(photo)) {
      throw new Error(`Photo is missing images.telegram.url: ${photo.id}`);
    }
  }
}

function summarizeBatch(batch) {
  return {
    size: batch.photos.length,
    photoIds: batch.photos.map((photo) => photo.id),
  };
}

function normalizeState(value) {
  const state = value && typeof value === "object" ? value : {};

  return {
    schemaVersion: STATE_SCHEMA_VERSION,
    currentRoll: stringOrNull(state.currentRoll),
    lastFilmStock: stringOrNull(state.lastFilmStock),
    publishedImageIds: uniqueStrings(
      Array.isArray(state.publishedImageIds) ? state.publishedImageIds : [],
    ),
    lastPostedAt: stringOrNull(state.lastPostedAt),
  };
}

function initialRollIndex(rolls, currentRoll) {
  if (!currentRoll) {
    return 0;
  }

  const exactIndex = rolls.findIndex((roll) => roll.roll === currentRoll);
  if (exactIndex !== -1) {
    return exactIndex;
  }

  return rolls.findIndex((roll) => naturalCompare(roll.roll, currentRoll) > 0);
}

function comparePhotosInRoll(a, b) {
  return (
    String(a.filename ?? "").localeCompare(String(b.filename ?? ""), undefined, {
      numeric: true,
      sensitivity: "base",
    }) || String(a.id).localeCompare(String(b.id))
  );
}

function naturalCompare(a, b) {
  return String(a).localeCompare(String(b), undefined, {
    numeric: true,
    sensitivity: "base",
  });
}

function firstPresent(values) {
  return values.find((value) => typeof value === "string" && value.trim())?.trim() ?? null;
}

function stringOrNull(value) {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function uniqueStrings(values) {
  return [...new Set(values.filter((value) => typeof value === "string" && value.trim()))];
}

function telegramUrlForPhoto(photo) {
  return photo.images?.telegram?.url ?? "";
}

function escapeTelegramHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

function cameraFromRoll(sourcePath) {
  const folder = String(sourcePath ?? "").split("/").at(-2) ?? "";
  const [, afterDash] = folder.split(" - ");

  if (!afterDash) {
    return null;
  }

  return afterDash.split(",")[0]?.trim() || null;
}

function parsePhotoDate(value) {
  if (!value) {
    return null;
  }

  const match = String(value).match(
    /^(\d{4}):(\d{2}):(\d{2})(?:[ T](\d{2}):(\d{2}):(\d{2})(?:([+-]\d{2}:?\d{2}|Z))?)?/,
  );

  if (!match) {
    const date = new Date(value);
    const timestamp = date.getTime();
    return Number.isFinite(timestamp) ? { date, timestamp } : null;
  }

  const [, year, month, day, hour = "00", minute = "00", second = "00", offset] = match;
  const isoDate = `${year}-${month}-${day}T${hour}:${minute}:${second}${offset ?? "Z"}`;
  const date = new Date(isoDate);
  const timestamp = date.getTime();

  return Number.isFinite(timestamp) ? { date, timestamp } : null;
}

function formatDateRange(datedPhotos) {
  if (datedPhotos.length === 0) {
    return "даты неизвестны";
  }

  const first = dateFormatter.format(datedPhotos[0].date);
  const lastDate = datedPhotos.at(-1).date;
  const last = dateFormatter.format(lastDate);

  if (first === last) {
    return first;
  }

  const firstYear = yearFormatter.format(datedPhotos[0].date);
  const lastYear = yearFormatter.format(lastDate);

  if (firstYear === lastYear) {
    const firstWithoutYear = dateWithoutYearFormatter.format(datedPhotos[0].date);
    const lastWithoutYear = dateWithoutYearFormatter.format(lastDate);

    return `${firstWithoutYear} - ${lastWithoutYear} ${lastYear} г.`;
  }

  return `${first} - ${last}`;
}
