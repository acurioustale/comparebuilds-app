// ─── Server-side share links ──────────────────────────────────────────────────
//
// Creates persistent, content-addressed share links (/s/<id>) backed by the server.

/**
 * POSTs build data to the share API and returns the generated short-link ID.
 * @param {{ classId: number, specId: number, builds: string[], labels?: string[], className: string, specName: string, layoutHash?: string|null }} payload Share payload
 * @returns {Promise<{ id: string }>} Resolves with short-link ID
 */
export async function createServerShare({
  classId,
  specId,
  builds,
  labels,
  className,
  specName,
  layoutHash,
}) {
  const apiBase = import.meta.env.BASE_URL + "api/share.php";
  const res = await fetch(apiBase, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      // X-CompareBuilds-Client is a custom header that forces a CORS preflight on
      // any cross-origin request, providing defence-in-depth against CSRF.
      // The server rejects POST requests that omit this header (see api/share.php).
      "X-CompareBuilds-Client": "1",
    },
    body: JSON.stringify({
      classId,
      specId,
      builds,
      labels,
      className,
      specName,
      layoutHash,
    }),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.error ?? `HTTP ${res.status}`);
  }
  // A 200 doesn't guarantee the expected body: a misconfigured proxy/CDN can
  // return a success page, or the API contract could drift. Require a non-empty
  // string id so a malformed-but-200 response fails loudly here instead of
  // resolving as success and surfacing downstream as a dead "/s/undefined" link
  // the caller copies to the clipboard.
  const data = await res.json().catch(() => null);
  if (!data || typeof data.id !== "string" || data.id.length === 0) {
    throw new Error("Share API returned an unexpected response.");
  }
  return data;
}
