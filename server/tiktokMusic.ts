import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

export interface PreferredMusicTrack {
  artist: string;
  title: string;
  previewUrl: string;
  localPath: string;
  durationSec: number;
}

const PREFERRED_ARTISTS = ['Xishqa', 'Shluzov', 'Migas'] as const;
const FALLBACK_SEARCH_TERMS = ['phonk slowed', 'dark trap beat', 'electronic beat'] as const;
const MUSIC_CACHE_DIR = path.resolve(process.cwd(), 'server', 'data', 'music-cache');

interface ItunesTrackItem {
  trackName?: string;
  artistName?: string;
  previewUrl?: string;
  trackTimeMillis?: number;
}

function normalizeText(value: string): string {
  return value
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .trim();
}

function shuffleArray<T>(items: readonly T[]): T[] {
  const copy = [...items];
  for (let i = copy.length - 1; i > 0; i--) {
    const j = crypto.randomInt(0, i + 1);
    const tmp = copy[i];
    copy[i] = copy[j];
    copy[j] = tmp;
  }
  return copy;
}

async function queryItunesTracks(term: string, exactArtistFilter?: string): Promise<ItunesTrackItem[]> {
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 7000);
    const resp = await fetch(
      `https://itunes.apple.com/search?term=${encodeURIComponent(term)}&media=music&limit=15`,
      { signal: controller.signal },
    );
    clearTimeout(timer);
    if (!resp.ok) return [];
    const data = (await resp.json()) as { results?: ItunesTrackItem[] };
    const results = Array.isArray(data.results) ? data.results : [];
    const valid = results.filter(
      (item) =>
        typeof item.previewUrl === 'string' &&
        item.previewUrl.startsWith('https://') &&
        typeof item.trackName === 'string' &&
        typeof item.artistName === 'string',
    );
    if (!exactArtistFilter) return valid;
    const needle = normalizeText(exactArtistFilter);
    return valid.filter((item) => normalizeText(item.artistName || '').includes(needle));
  } catch {
    return [];
  }
}

async function downloadAudioPreview(previewUrl: string, cacheKey: string): Promise<string | null> {
  fs.mkdirSync(MUSIC_CACHE_DIR, { recursive: true });
  const safeKey = cacheKey.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 64);
  const outPath = path.resolve(MUSIC_CACHE_DIR, `${safeKey}.m4a`);

  if (fs.existsSync(outPath) && fs.statSync(outPath).size > 8_000) {
    return outPath;
  }

  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 10_000);
    const resp = await fetch(previewUrl, { signal: controller.signal });
    clearTimeout(timer);
    if (!resp.ok) return null;
    const buf = Buffer.from(await resp.arrayBuffer());
    if (buf.byteLength < 8_000) return null;
    fs.writeFileSync(outPath, buf);
    return outPath;
  } catch {
    return null;
  }
}

/**
 * Selects a random soundtrack from preferred artists (Xishqa, Shluzov, Migas),
 * falling back to compatible profile tracks if none are reachable.
 */
export async function selectRandomPreferredTrack(): Promise<PreferredMusicTrack | null> {
  const candidates: ItunesTrackItem[] = [];

  for (const artist of shuffleArray(PREFERRED_ARTISTS)) {
    const found = await queryItunesTracks(artist, artist);
    if (found.length > 0) {
      candidates.push(...found);
    }
  }

  if (candidates.length === 0) {
    for (const term of shuffleArray(FALLBACK_SEARCH_TERMS)) {
      const found = await queryItunesTracks(term);
      if (found.length > 0) {
        candidates.push(...found);
        break;
      }
    }
  }

  if (candidates.length === 0) {
    return null;
  }

  const shuffled = shuffleArray(candidates);
  for (const pick of shuffled) {
    if (!pick.previewUrl) continue;
    const hash = crypto
      .createHash('sha1')
      .update(pick.previewUrl)
      .digest('hex')
      .slice(0, 12);
    const localPath = await downloadAudioPreview(
      pick.previewUrl,
      `${pick.artistName || 'track'}_${hash}`,
    );
    if (localPath) {
      return {
        artist: pick.artistName || 'Desconhecido',
        title: pick.trackName || 'Faixa',
        previewUrl: pick.previewUrl,
        localPath,
        durationSec: 15,
      };
    }
  }

  return null;
}
