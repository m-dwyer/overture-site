// Registers the cross-origin isolation shim, then reloads once so it serves
// this document. Loaded by any page that needs `SharedArrayBuffer`: the Try
// page, and the emulator itself for a visitor who arrived by deep link and has
// never been through the Try page.
//
// Only fetched when isolation is missing — the dev servers send the headers
// directly, so nothing here runs there.
//
// The reload waits for the worker to be *controlling*, not merely registered.
// `register()` resolves while the worker is still installing, so `active` is
// null and `controller` unset at that moment; bailing there leaves a
// registered, soon-to-be-controlling worker and a document that was fetched
// before it — which reads as isolated-next-time and is indistinguishable from
// working.
//
// A session flag keeps a shim that never takes control to one reload rather
// than a loop, and is cleared once isolation holds so a later failure can
// still retry.

(() => {
  const RELOADED = "overture-coi-reloaded";
  if (window.crossOriginIsolated) {
    sessionStorage.removeItem(RELOADED);
    return;
  }
  if (!("serviceWorker" in navigator)) return;
  if (sessionStorage.getItem(RELOADED)) return;

  const controlling = () =>
    new Promise((resolve) => {
      if (navigator.serviceWorker.controller) return resolve(true);
      navigator.serviceWorker.addEventListener(
        "controllerchange",
        () => resolve(true),
        { once: true },
      );
      setTimeout(
        () => resolve(Boolean(navigator.serviceWorker.controller)),
        3000,
      );
    });

  navigator.serviceWorker
    // Root scope, from the root script, so one worker covers the Try page and
    // the emulator it frames — and the emulator on its own.
    .register("/coi-serviceworker.js", { scope: "/" })
    .then(() => navigator.serviceWorker.ready)
    .then(controlling)
    .then((isControlling) => {
      if (!isControlling) return;
      sessionStorage.setItem(RELOADED, "1");
      window.location.reload();
    })
    .catch(() => {});
})();
