import catalog from "../../data/photos.json";

export const PAGE_SIZE = 36;

type ImageVariant = {
  url: string;
  objectKey: string;
  width: number | null;
  height: number | null;
};

type SourcePhoto = {
  filename: string;
  roll: string;
  metadata: {
    date: string | null;
    aperture: string | number | null;
    shutterSpeed: string | null;
    iso: string | number | null;
    film: string | null;
    cameraModel: string | null;
    lensModel: string | null;
    focalLength: string | null;
  };
  id: string;
  sourcePath: string;
  images: {
    thumb: ImageVariant;
    grid: ImageVariant;
    large: ImageVariant;
    original: ImageVariant;
  };
};

export type Photo = SourcePhoto & {
  camera: string;
  film: string;
  dateDisplay: string;
  timestamp: number;
};

export type Facet = {
  name: string;
  slug: string;
  count: number;
};

export type PaginatedPhotos = {
  photos: Photo[];
  currentPage: number;
  totalPages: number;
  totalPhotos: number;
};

const dateFormatter = new Intl.DateTimeFormat("en", {
  year: "numeric",
  month: "short",
  day: "numeric",
});

function normalizeDate(value: string | null) {
  if (!value) {
    return { timestamp: 0, display: "" };
  }

  const match = value.match(
    /^(\d{4}):(\d{2}):(\d{2})(?:[ T](\d{2}):(\d{2}):(\d{2}))?/,
  );

  if (!match) {
    const fallbackDate = new Date(value);
    const timestamp = fallbackDate.getTime();

    return {
      timestamp: Number.isFinite(timestamp) ? timestamp : 0,
      display: Number.isFinite(timestamp) ? dateFormatter.format(fallbackDate) : value,
    };
  }

  const [, year, month, day, hour = "00", minute = "00", second = "00"] = match;
  const date = new Date(
    Number(year),
    Number(month) - 1,
    Number(day),
    Number(hour),
    Number(minute),
    Number(second),
  );

  return {
    timestamp: date.getTime(),
    display: dateFormatter.format(date),
  };
}

function cameraFromRoll(roll: string) {
  const [, afterDash] = roll.split(" - ");

  if (!afterDash) {
    return null;
  }

  const [camera] = afterDash.split(",");
  return camera.trim() || null;
}

export function slugify(value: string) {
  return value
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

export function photoCountLabel(count: number) {
  return `${count} photo${count === 1 ? "" : "s"}`;
}

function normalizePhoto(photo: SourcePhoto): Photo {
  const date = normalizeDate(photo.metadata.date);

  return {
    ...photo,
    camera: photo.metadata.cameraModel ?? cameraFromRoll(photo.roll) ?? "Unknown Camera",
    film: photo.metadata.film ?? "Unknown Film",
    dateDisplay: date.display,
    timestamp: date.timestamp,
  };
}

export const photos = (catalog.photos as SourcePhoto[])
  .map(normalizePhoto)
  .sort((a, b) => b.timestamp - a.timestamp || a.filename.localeCompare(b.filename));

export function paginate(items: Photo[], page: number): PaginatedPhotos {
  const totalPages = Math.max(1, Math.ceil(items.length / PAGE_SIZE));
  const start = (page - 1) * PAGE_SIZE;

  return {
    photos: items.slice(start, start + PAGE_SIZE),
    currentPage: page,
    totalPages,
    totalPhotos: items.length,
  };
}

export function facetsFor(field: "camera" | "film"): Facet[] {
  const counts = new Map<string, { name: string; count: number }>();

  for (const photo of photos) {
    const name = photo[field];
    const slug = slugify(name);
    const current = counts.get(slug);

    counts.set(slug, {
      name,
      count: (current?.count ?? 0) + 1,
    });
  }

  return [...counts.entries()]
    .map(([slug, value]) => ({ slug, ...value }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

export function photosForFacet(field: "camera" | "film", slug: string) {
  return photos.filter((photo) => slugify(photo[field]) === slug);
}

export const cameras = facetsFor("camera");
export const films = facetsFor("film");
