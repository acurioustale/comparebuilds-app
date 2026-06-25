// Builds a same-origin icon URL. Icons are downloaded from wow.zamimg.com by
// scripts/fetchIcons.js and committed under public/talent-icons/, so they're
// served first-party — third-party requests to the zamimg (Fandom/ZAM) domain
// are blocked by common content blockers and browser tracking protection, which
// left users with broken icons. The path is /talent-icons (not /icons) because
// Apache reserves /icons for mod_autoindex's directory-listing graphics, and
// that server-level alias would shadow our files. Falls back to a transparent
// 1x1 gif when the icon name is missing so a bad data row can't crash a render.
const BLANK =
  "data:image/gif;base64,R0lGODlhAQABAAAAACH5BAEKAAEALAAAAAABAAEAAAICTAEAOw==";

export const iconUrl = (icon) =>
  icon ? `/talent-icons/${icon.toLowerCase()}.jpg` : BLANK;
