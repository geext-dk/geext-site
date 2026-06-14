import catalog from "../../data/photos.json";

export const prerender = true;

export function GET() {
  return new Response(JSON.stringify(catalog), {
    headers: {
      "Cache-Control": "public, max-age=300",
      "Content-Type": "application/json; charset=utf-8",
    },
  });
}
