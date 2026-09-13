/** Shared text normalisation for search and answer matching. */

const COMBINING_MARKS = new RegExp(`[${String.fromCharCode(0x300)}-${String.fromCharCode(0x36f)}]`, 'g');
const SMART_QUOTES = /[‘’ʼ'`]/g;

/** Lowercase, strip accents and punctuation, collapse whitespace. */
export function normalize(s) {
  return String(s || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(COMBINING_MARKS, '')
    .replace(SMART_QUOTES, '')
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

/**
 * Drops release-variant noise so "Song - 2011 Remaster" and "Song" are the
 * same answer. Only used for comparison; the UI always shows the real title.
 */
const VARIANT = String.raw`remaster(?:ed)?(?:\s*\d{4})?|\d{4}\s*remaster(?:ed)?|radio edit|single version|album version|extended(?: mix| version)?|deluxe(?: edition)?|bonus track|mono|stereo|live(?: version)?|acoustic(?: version)?|demo|explicit|clean`;

const VARIANT_SUFFIX = new RegExp(String.raw`\s*[-–—]\s*(?:${VARIANT})\b.*$`, 'i');
const VARIANT_BRACKET = new RegExp(String.raw`\s*[\(\[](?:${VARIANT})[^\)\]]*[\)\]]`, 'ig');
const FEATURING = /\s*[\(\[](?:feat\.?|ft\.?|with)\s[^\)\]]*[\)\]]/ig;

export function stripVariant(title) {
  return String(title || '')
    .replace(VARIANT_SUFFIX, '')
    .replace(VARIANT_BRACKET, '')
    .replace(FEATURING, '')
    .replace(/\s{2,}/g, ' ')
    .trim();
}

export const tokens = (s) => normalize(s).split(' ').filter(Boolean);

/** Stable answer key: two entries matching here count as the same song. */
export function answerKey(track) {
  return `${normalize(stripVariant(track.name))}|${normalize(track.artists.join(' '))}`;
}
