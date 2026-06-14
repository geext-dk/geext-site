# Telegram Photo Publisher Worker

Posts the next batch of film photos to Telegram from the public photo catalog.

## Configure

1. Create a Workers KV namespace and put its ID in `wrangler.toml`.
2. Set `TELEGRAM_CHAT_ID` and `PHOTO_CATALOG_URL` in `wrangler.toml`.
3. Set secrets:

```sh
npx wrangler secret put TELEGRAM_BOT_TOKEN --config workers/telegram-photo-publisher/wrangler.toml
npx wrangler secret put ADMIN_TOKEN --config workers/telegram-photo-publisher/wrangler.toml
```

## Endpoints

- `GET /health` returns a compact status payload.
- `POST /run` publishes the next batch when authorized.
- `POST /run?dryRun=1` computes the next batch without writing KV or calling Telegram.

Authorize manual runs with either `Authorization: Bearer <ADMIN_TOKEN>` or `X-Admin-Token: <ADMIN_TOKEN>`.

Run `npm run sync:photos` before deploying so `data/photos.json` includes the `images.telegram.url` JPEG variant.
