import assert from "node:assert/strict";
import test from "node:test";
import {
  buildRolls,
  formatCaption,
  planNextPublish,
  telegramRequestForBatch,
} from "../src/publisher.js";

test("selects the first 10 photos from the oldest roll when state is empty", () => {
  const catalog = catalogWith([
    roll("2024-002", 2),
    roll("2024-001", 12),
  ]);

  const plan = planNextPublish(catalog, {}, { now: fixedNow() });

  assert.equal(plan.status, "ready");
  assert.equal(plan.batch.roll, "2024-001");
  assert.equal(plan.batch.photos.length, 10);
  assert.deepEqual(
    plan.batch.photos.map((photo) => photo.id),
    ids("2024-001", 1, 10),
  );
  assert.equal(plan.nextState.currentRoll, "2024-001");
  assert.equal(plan.nextState.publishedImageIds.length, 10);
});

test("continues a partial roll and advances state to the next roll after completion", () => {
  const catalog = catalogWith([
    roll("2024-001", 12),
    roll("2024-002", 3),
  ]);
  const state = {
    currentRoll: "2024-001",
    publishedImageIds: ids("2024-001", 1, 10),
  };

  const plan = planNextPublish(catalog, state, { now: fixedNow() });

  assert.equal(plan.status, "ready");
  assert.equal(plan.batch.roll, "2024-001");
  assert.deepEqual(
    plan.batch.photos.map((photo) => photo.id),
    ids("2024-001", 11, 12),
  );
  assert.equal(plan.nextState.currentRoll, "2024-002");
  assert.deepEqual(plan.nextState.publishedImageIds, []);
});

test("stops after the final roll is complete", () => {
  const catalog = catalogWith([roll("2024-001", 2)]);
  const state = {
    currentRoll: "2024-001",
    publishedImageIds: ids("2024-001", 1, 2),
  };

  const plan = planNextPublish(catalog, state);

  assert.equal(plan.status, "exhausted");
});

test("resumes when a newer roll appears after the previous final roll", () => {
  const catalog = catalogWith([
    roll("2024-001", 2),
    roll("2024-002", 1),
  ]);
  const state = {
    currentRoll: "2024-001",
    publishedImageIds: ids("2024-001", 1, 2),
  };

  const plan = planNextPublish(catalog, state, { now: fixedNow() });

  assert.equal(plan.status, "ready");
  assert.equal(plan.batch.roll, "2024-002");
  assert.deepEqual(plan.batch.photos.map((photo) => photo.id), ["2024-002-001"]);
});

test("formats captions with film, camera, and a compact date range", () => {
  assert.equal(
    formatCaption({
      film: "Kodak Gold 200",
      camera: "Canon A-1",
      dateRange: "1 апр. - 9 апр. 2026 г.",
    }),
    "<b>Новая партия фоточек!</b>\n\nПлёнка: Kodak Gold 200\nКамера: Canon A-1\nДаты: 1 апр. - 9 апр. 2026 г.",
  );
});

test("formats a single known photo date without a range", () => {
  const [builtRoll] = buildRolls([photo("2024-001", 1)]);

  assert.equal(
    formatCaption(builtRoll),
    "<b>Новая партия фоточек!</b>\n\nПлёнка: Kodak Gold 200\nКамера: Canon A-1\nДаты: 1 апр. 2026 г.",
  );
});

test("keeps both years in date ranges that cross years", () => {
  const [builtRoll] = buildRolls([
    {
      ...photo("2024-001", 1),
      metadata: {
        ...photo("2024-001", 1).metadata,
        date: "2025:12:30 12:00:00",
      },
    },
    {
      ...photo("2024-001", 2),
      metadata: {
        ...photo("2024-001", 2).metadata,
        date: "2026:01:02 12:00:00",
      },
    },
  ]);

  assert.equal(
    formatCaption(builtRoll),
    "<b>Новая партия фоточек!</b>\n\nПлёнка: Kodak Gold 200\nКамера: Canon A-1\nДаты: 30 дек. 2025 г. - 2 янв. 2026 г.",
  );
});

test("formats missing film, camera, and dates with fallbacks", () => {
  const [builtRoll] = buildRolls([
    {
      ...photo("2024-001", 1),
      metadata: {},
      sourcePath: "2024-001/001.jpg",
    },
  ]);

  assert.equal(
    formatCaption(builtRoll),
    "<b>Новая партия фоточек!</b>\n\nПлёнка: Unknown Film\nКамера: Unknown Camera\nДаты: даты неизвестны",
  );
});

test("formats captions from a template and escapes dynamic values", () => {
  assert.equal(
    formatCaption(
      {
        film: "Cinestill <800T> & Friends",
        camera: "Canon A-1",
        dateRange: "1 апр. 2026 г.",
      },
      "<b>{{ film }}</b>\n{{camera}}\n{{dateRange}}",
    ),
    "<b>Cinestill &lt;800T&gt; &amp; Friends</b>\nCanon A-1\n1 апр. 2026 г.",
  );
});

test("uses sendPhoto for one image", () => {
  const request = telegramRequestForBatch("@channel", {
    caption: "Caption",
    photos: [photo("2024-001", 1)],
  });

  assert.equal(request.method, "sendPhoto");
  assert.equal(request.payload.photo, "https://photos.example/2024-001-001.jpg");
  assert.equal(request.payload.caption, "Caption");
  assert.equal(request.payload.parse_mode, "HTML");
});

test("uses sendMediaGroup for 2-10 images and captions only the first item", () => {
  const request = telegramRequestForBatch("@channel", {
    caption: "Caption",
    photos: [photo("2024-001", 1), photo("2024-001", 2)],
  });

  assert.equal(request.method, "sendMediaGroup");
  assert.equal(request.payload.media.length, 2);
  assert.equal(request.payload.media[0].caption, "Caption");
  assert.equal(request.payload.media[0].parse_mode, "HTML");
  assert.equal(request.payload.media[1].caption, undefined);
  assert.equal(request.payload.media[1].parse_mode, undefined);
});

function catalogWith(rolls) {
  return {
    photos: rolls.flat(),
  };
}

function roll(rollId, count) {
  return Array.from({ length: count }, (_, index) => photo(rollId, index + 1));
}

function photo(rollId, number) {
  const padded = String(number).padStart(3, "0");

  return {
    id: `${rollId}-${padded}`,
    filename: `${padded}.jpg`,
    roll: rollId,
    sourcePath: `${rollId} - Canon A-1, Kodak Gold 200/${padded}.jpg`,
    metadata: {
      date: number === 1 ? "2026:04:01 12:00:00" : "2026:04:09 12:00:00",
      film: "Kodak Gold 200",
      cameraModel: "Canon A-1",
    },
    images: {
      telegram: {
        url: `https://photos.example/${rollId}-${padded}.jpg`,
      },
    },
  };
}

function ids(rollId, start, end) {
  return Array.from({ length: end - start + 1 }, (_, index) => {
    return `${rollId}-${String(start + index).padStart(3, "0")}`;
  });
}

function fixedNow() {
  return new Date("2026-06-14T09:00:00.000Z");
}
