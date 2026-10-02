/**
 * Server-inlined runtime shim for `window.__pm`. It only queues calls; the
 * client bundle's `installModuleLoader` replaces it and loads the modules.
 * Pass it as the `runtime` option wherever the server renders client
 * references.
 */
export const runtime = [
  "window.__pp??={};",
  "window.__ppq??=[];",
  "window.__pm??=function(){window.__ppq.push([].slice.call(arguments))};",
].join("");
