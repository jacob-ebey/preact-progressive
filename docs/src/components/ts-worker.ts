import * as Comlink from "comlink";
import ts from "ts-js";
import {
  createDefaultMapFromCDN,
  createSystem,
  createVirtualTypeScriptEnvironment,
} from "@typescript/vfs";
import { createWorker } from "@valtown/codemirror-ts/worker";

Comlink.expose(
  createWorker(async () => {
    const fsMap = await createDefaultMapFromCDN(
      { target: ts.ScriptTarget.ES2022 },
      ts.version,
      false,
      // vfs is typed against the project's typescript@7 (native CLI, no JS
      // API); at runtime it only needs the JS compiler, which is ts-js.
      ts as any,
    );

    // preact ships its own types as a small tree of relative-import .d.ts files.
    // Keep in sync with the preact version in package.json.
    const PREACT_VERSION = "11.0.0-rc.1";
    const preactTypes = [
      "src/index.d.ts",
      "src/jsx.d.ts",
      "src/dom.d.ts",
      "src/internal.d.ts",
      "hooks/src/index.d.ts",
      "hooks/src/internal.d.ts",
      "jsx-runtime/src/index.d.ts",
      // preact/compat (Suspense, use) for the async guide steps. Its
      // relative imports resolve to files already fetched above.
      "compat/src/index.d.ts",
      "compat/src/internal.d.ts",
      "compat/src/suspense.d.ts",
    ];
    const base = `https://cdn.jsdelivr.net/npm/preact@${PREACT_VERSION}/`;
    await Promise.all(
      preactTypes.map(async (file) => {
        const res = await fetch(base + file);
        if (res.ok) fsMap.set("/node_modules/preact/" + file, await res.text());
      }),
    );
    // Bare-specifier resolution needs package.json "types" entries in the VFS.
    for (const entry of ["", "/hooks", "/jsx-runtime", "/compat"]) {
      fsMap.set(
        `/node_modules/preact${entry}/package.json`,
        JSON.stringify({ types: "./src/index.d.ts" }),
      );
    }

    const system = createSystem(fsMap);
    return createVirtualTypeScriptEnvironment(system, [], ts as any, {
      target: ts.ScriptTarget.ES2022,
      module: ts.ModuleKind.ESNext,
      moduleResolution: ts.ModuleResolutionKind.Bundler,
      jsx: ts.JsxEmit.ReactJSX,
      jsxImportSource: "preact",
      // preact/compat ships `export =` types; named imports need interop.
      esModuleInterop: true,
      strict: true,
      noEmit: true,
      skipLibCheck: true,
    });
  }),
);
