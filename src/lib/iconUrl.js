// Builds a same-origin icon URL. Icons are downloaded from Blizzard's render CDN
// by scripts/fetchIcons.js and committed under public/talent-icons/, so they're
// served first-party — third-party icon requests are blocked by common content
// blockers and browser tracking protection, which left users with broken icons.
// The path is /talent-icons (not /icons) because
// Apache reserves /icons for mod_autoindex's directory-listing graphics, and
// that server-level alias would shadow our files. Falls back to a transparent
// 1x1 gif when the icon name is missing so a bad data row can't crash a render.
const BLANK =
  "data:image/gif;base64,R0lGODlhAQABAAAAACH5BAEKAAEALAAAAAABAAEAAAICTAEAOw==";

const getBaseUrl = () => import.meta.env?.BASE_URL?.replace(/\/$/, "") ?? "";

/**
 * @param {string} icon Icon slug name
 * @returns {string} Same-origin icon URL path
 */
export const iconUrl = (icon) =>
  typeof icon === "string" && icon
    ? `${getBaseUrl()}/talent-icons/${icon.toLowerCase()}.jpg`
    : BLANK;

/**
 * onError handler for icon <img>s: swap a failed load for the blank pixel so a
 * missing file (a handful of upstream slugs have no real art) degrades to a
 * clean empty slot instead of the browser's broken-image glyph. The guard stops
 * the swap from re-triggering once the src is already the blank.
 * @param {import("react").SyntheticEvent<HTMLImageElement, Event>} e Image error event
 */
export const onIconError = (e) => {
  if (e.currentTarget.src !== BLANK) e.currentTarget.src = BLANK;
};
