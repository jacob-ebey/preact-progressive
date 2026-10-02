declare global {
  interface Window {
    __pp: Record<string, { p: Promise<void>; m?: unknown }>;
    __pm: (m: string, ...d: string[]) => void;
  }
}

window.__pp ??= {};
window.__pm ??= (m, ...d) => (
  (window.__pp[m] ??= {
    p: (d.map((m) => import(/* @vite-ignore */ /* webpackIgnore: true */ m)),
    import(/* @vite-ignore */ /* webpackIgnore: true */ m)).then((r) => {
      window.__pp[m].m = r;
    }),
  }),
  document.currentScript?.remove()
);
