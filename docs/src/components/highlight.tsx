"use client";

import { useEffect } from "preact/hooks";

export function Highlight() {
  useEffect(() => {
    requestAnimationFrame(() => {
      // @ts-expect-error - consume from CDN to avoid having to deal with bundler concerns
      void import("https://cdn.jsdelivr.net/npm/microlighter@2.1.0/dist/highlight.js").then((mod) =>
        mod.highlightAll(),
      );
    });
  }, []);

  return null;
}
