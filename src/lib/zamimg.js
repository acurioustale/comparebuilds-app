// Builds a Wowhead/zamimg icon URL. Falls back to a transparent 1x1 gif when the
// icon is missing so a bad/incomplete data row can't crash a tree render.
const BLANK = 'data:image/gif;base64,R0lGODlhAQABAAAAACH5BAEKAAEALAAAAAABAAEAAAICTAEAOw=='

export const zamimg = (icon) =>
  icon
    ? `https://wow.zamimg.com/images/wow/icons/medium/${icon.toLowerCase()}.jpg`
    : BLANK
