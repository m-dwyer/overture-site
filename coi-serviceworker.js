// Cross-origin isolation for a host that cannot set response headers.
//
// `SharedArrayBuffer` needs `Cross-Origin-Opener-Policy: same-origin` and
// `Cross-Origin-Embedder-Policy: require-corp`, and GitHub Pages serves static
// files with no way to add either. A Service Worker can: once it controls the
// scope it re-serves every same-origin response with the two headers attached.
//
// Isolation is a property of the whole frame tree, so this has to cover the Try
// page and the emulator it frames, not just the emulator. Registering at the
// site root gives both.
//
// Cross-origin responses are passed through untouched. Under `require-corp`
// they are admitted only if they carry `Cross-Origin-Resource-Policy` or are
// fetched in CORS mode and pass the check — which is why the analytics tag
// carries `crossorigin`.

self.addEventListener("install", () => {
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(self.clients.claim());
});

self.addEventListener("fetch", (event) => {
  const request = event.request;
  // Cross-origin requests are left entirely alone — not even `respondWith`.
  // Re-serving one copies `response.headers`, which on a CORS response does not
  // expose `access-control-allow-origin`, so the rewritten copy fails the CORS
  // check the original passed. That silently blocked the analytics tag, which is
  // the one subresource this whole arrangement was chosen to keep.
  if (new URL(request.url).origin !== self.location.origin) return;
  // A range request re-served through `new Response` loses its 206 semantics,
  // and audio and video elements depend on them.
  if (request.cache === "only-if-cached" && request.mode !== "same-origin")
    return;

  event.respondWith(
    fetch(request)
      .then((response) => {
        if (response.status === 0) return response;
        const headers = new Headers(response.headers);
        headers.set("Cross-Origin-Opener-Policy", "same-origin");
        headers.set("Cross-Origin-Embedder-Policy", "require-corp");
        return new Response(response.body, {
          status: response.status,
          statusText: response.statusText,
          headers,
        });
      })
      // Opaque failures reach the page as the ordinary network error they are.
      .catch((error) => {
        console.error("coi-serviceworker:", error);
        throw error;
      }),
  );
});
