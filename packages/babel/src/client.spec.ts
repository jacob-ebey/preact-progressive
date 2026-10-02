import { transformSync } from "@babel/core";
import { expect, test } from "vite-plus/test";

import preactProgressive from "./client.ts";

function transform(code: string): string {
  return transformSync(code, {
    plugins: [[preactProgressive, { mod: "__PP_MOD__<hash>", deps: ["__PP_DEPS__<hash>"] }]],
    filename: "test.js",
    parserOpts: { sourceType: "module" },
  })!.code!;
}

test('leaves modules without "use client" untouched', () => {
  const code = `
    export function handler(props) { return props; }
    const local = () => {};
  `;
  const output = transform(code);
  expect(output).not.toContain("__pp_create_ref");
  expect(output).toContain("export function handler");
});

test.only('inserts the __pp_create_ref helper once for module-level "use client"', () => {
  const code = `"use client";
    export function foo() { return 1; }
  `;
  const output = transform(code);
  expect(output).toBe("export function foo() {\n  return 1;\n}");
});

test("rewrites `export function` declarations into refs", () => {
  const output = transform(`"use client";
    export function handler(props) { return props; }
  `);
  expect(output).toContain("function handler(props) {\n  return props;\n}");
  expect(output).toMatch(/const __pp_ref_handler = __pp_create_ref\(handler, "handler"\);/);
  expect(output).toContain("export { __pp_ref_handler as handler };");
});

test("rewrites `export { ... }` specifiers into refs", () => {
  const output = transform(`"use client";
    const action = () => {};
    export { action, action as renamed };
  `);
  expect(output).toMatch(/const __pp_ref_action = __pp_create_ref\(action, "action"\);/);
  expect(output).toContain("export { __pp_ref_action as action };");
  expect(output).toMatch(/const __pp_ref_action2? = __pp_create_ref\(action, "renamed"\);/);
  expect(output).toContain("as renamed };");
  // Original local declaration stays
  expect(output).toContain("const action = () => {};");
});

test("rewrites named default export function", () => {
  const output = transform(`"use client";
    export default function Page() { return null; }
  `);
  expect(output).toContain("function Page() {\n  return null;\n}");
  expect(output).toMatch(/const __pp_ref_default = __pp_create_ref\(Page, "default"\);/);
  expect(output).toContain("export default __pp_ref_default;");
});

test("rewrites anonymous default export function expression", () => {
  const output = transform(`"use client";
    export default function () { return null; }
  `);
  expect(output).toContain("function _pp_default() {\n  return null;\n}");
  expect(output).toContain('const __pp_ref_default = __pp_create_ref(_pp_default, "default");');
  expect(output).toContain("export default __pp_ref_default;");
});

test("rewrites default export identifier", () => {
  const output = transform(`"use client";
    function Comp() { return null; }
    export default Comp;
  `);
  expect(output).toContain("function Comp() {\n  return null;\n}");
  expect(output).toMatch(/const __pp_ref_default = __pp_create_ref\(Comp, "default"\);/);
  expect(output).toContain("export default __pp_ref_default;");
});

test("rewrites re-exports into import + ref + export", () => {
  const output = transform(`"use client";
    export { serverAction } from "./actions.js";
    export { default } from "./page.js";
  `);
  expect(output).toContain(
    'import { serverAction as _pp_imported_serverAction } from "./actions.js";',
  );
  expect(output).toContain(
    'const __pp_ref_serverAction = __pp_create_ref(_pp_imported_serverAction, "serverAction");',
  );
  expect(output).toContain('import { default as _pp_imported_default } from "./page.js";');
  expect(output).toContain(
    'const __pp_ref_default = __pp_create_ref(_pp_imported_default, "default");',
  );
});

test("throws on `export *` statements", () => {
  expect(() =>
    transform(`"use client";
      export * from "./mod.js";
    `),
  ).toThrow('"use client" modules cannot use `export *` statements');
});

test("generated refs are callable and carry client reference metadata", () => {
  const output = transform(`"use client";
    export function handler(a) { return a + 1; }
  `);
  // Note: In the client version, refs don't have $type/$mod/$deps/$bound
  // they are just the bound function references
  expect(output).toContain("function handler(a) {\n  return a + 1;\n}");
});

test('hoists function-level "use client" functions and binds free variables', () => {
  const code = `
    function makeHandler(x) {
      function handler(y) {
        "use client";
        return x + y;
      }
      return handler;
    }
  `;
  const output = transform(code);
  // Hoisted to the top of the program with free vars prepended to params
  expect(output).toContain("function _pp_hoisted_handler(x, y) {\n  return x + y;\n}");
  // Ref created for the hoisted function
  expect(output).toContain(
    'const __pp_ref_handler = __pp_create_ref(_pp_hoisted_handler, "handler");',
  );
  // Original site binds the ref over the free variable
  expect(output).toContain("const handler = __pp_ref_handler.bind(null, x);");

  // oxlint-disable-next-line typescript/no-implied-eval
  const factory = new Function(`${output}; return makeHandler;`)() as (x: number) => {
    (y: number): number;
    $bound: unknown[];
  };
  const handler = factory(40);
  expect(handler(2)).toBe(42);
  expect(handler.$bound).toEqual([40]);
});

test('replaces function expressions containing "use client" with bound refs', () => {
  const code = `
    const external = 1;
    const get = function () {
      "use client";
      return external;
    };
  `;
  const output = transform(code);
  expect(output).toContain("function _pp_hoisted_anonymous(external) {\n  return external;\n}");
  expect(output).toContain("const get = __pp_ref_anonymous.bind(null, external);");

  // oxlint-disable-next-line typescript/no-implied-eval
  const result = new Function(`${output}; return get();`)() as number;
  expect(result).toBe(1);
});

test('only one helper is emitted even with multiple "use client" functions', () => {
  const code = `
    function a() {
      "use client";
      return 1;
    }
    function b() {
      "use client";
      return 2;
    }
  `;
  const output = transform(code);
  expect(output.match(/function __pp_create_ref\(/g)).toHaveLength(1);
  expect(output).not.toContain('"use client"');
});

test("prunes bare side-effect imports", () => {
  const code = `
    import { notUsed } from "./unused.js";
    "use client";
    export function handler() { return 1; }
  `;
  const output = transform(code);
  expect(output).not.toContain('from "./unused.js"');
  expect(output).toContain("export function handler() { return 1; }");
});

test("prunes unreferenced functions", () => {
  const code = `
    function unused() { return 1; }
    "use client";
    export function handler() { return 2; }
  `;
  const output = transform(code);
  expect(output).not.toContain("function unused");
  expect(output).toContain("export function handler() { return 2; }");
});

test("keeps referenced imports", () => {
  const code = `
    import { external } from "./data.js";
    "use client";
    export function handler() { return external; }
  `;
  const output = transform(code);
  expect(output).toContain('from "./data.js"');
  expect(output).toContain("export function handler() { return external; }");
});
