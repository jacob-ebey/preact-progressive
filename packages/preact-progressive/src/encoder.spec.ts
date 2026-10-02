import * as vm from "node:vm";
import { createContext, Fragment, h } from "preact";
import { Suspense, memo } from "preact/compat";
import { useContext, useEffect, useMemo, useState } from "preact/hooks";
import { expect, test, vi } from "vite-plus/test";

import { Encoder } from "./encoder.ts";

const PP_CLIENT_REFERENCE = Symbol.for("pp.client-reference");

function clientRef(mod: string, name: string, bound: unknown[] = []) {
  return Object.assign(() => {}, {
    $type: PP_CLIENT_REFERENCE,
    $mod: mod,
    $name: name,
    $bound: bound,
  });
}

type Sandbox = Record<string, unknown>;

/** Evaluates emitted code. The new format only performs property assignments. */
function run(code: string): Sandbox {
  const sandbox: Sandbox = {};
  sandbox.globalThis = sandbox;
  vm.runInNewContext(code, sandbox);
  return sandbox;
}

function payload(sandbox: Sandbox, ns: string, id: string): string {
  return (sandbox[ns] as { d: Record<string, string> }).d[id];
}

test("stores a data payload under the row name", () => {
  const enc = new Encoder("__enc");
  const code = enc.encode("a", { s: "hi", n: 42 });
  const sb = run(code);
  expect(payload(sb, "__enc", "a")).toBe('{"s":"hi","n":42}\n');
});

test("encodes primitives with self-describing tags", () => {
  const enc = new Encoder("__enc");
  const code = enc.encode("a", {
    s: "hi",
    n: 42,
    f: 1.5,
    nan: NaN,
    inf: Infinity,
    ninf: -Infinity,
    negZero: -0,
    b: true,
    bi: 9007199254740993n,
    u: undefined,
    nil: null,
    sym: Symbol.for("pp.test.known"),
  });
  expect(payload(run(code), "__enc", "a")).toBe(
    '{"s":"hi","n":42,"f":1.5,"nan":NaN,"inf":I,"ninf":i,"negZero":z,"b":true,' +
      '"bi":b9007199254740993,"u":u,"nil":null,"sym":s"pp.test.known"}\n',
  );
});

test("encodes built-in types as tagged tokens", () => {
  const enc = new Encoder("__enc");
  const value = {
    date: new Date("2024-01-02T03:04:05.000Z"),
    re: /ab+c/gi,
    url: new URL("https://example.com/x"),
    map: new Map<unknown, unknown>([["k", { deep: [1, 2] }]]),
    set: new Set([1, "two"]),
    bytes: new Uint8Array([1, 2, 3]),
    buf: new Uint8Array([1, 2, 3]).buffer,
    i64: new BigInt64Array([1n]),
  };
  const code = enc.encode("a", value);
  expect(payload(run(code), "__enc", "a")).toBe(
    '{"date":D"2024-01-02T03:04:05.000Z","re":r["ab+c","gi"],' +
      '"url":U"https://example.com/x",' +
      '"map":M["k",{"deep":[1,2]}],"set":S[1,"two"],"bytes":o"AQID","buf":A"AQID",' +
      '"i64":J"AQAAAAAAAAA="}\n',
  );
});

test("encodes a VNode tree via the $V plugin", () => {
  const enc = new Encoder("__enc");
  const vnode = h(
    "div",
    { id: "root" },
    h("span", { key: "k1" }, "hello"),
    h(Fragment, null, "a", "b"),
    h("p", null, h("em", null, "nested")),
  );
  expect(payload(run(enc.encodeVNode("tree", vnode)), "__enc", "tree")).toBe(
    'P[v,"div",null,{"id":"root"},' +
      '[P[v,"span","k1",{},"hello"],' +
      'P[v,"$F",null,{},["a","b"]],' +
      'P[v,"p",null,{},P[v,"em",null,{},"nested"]]]]\n',
  );
});

test("encodes client references as plugin tokens; type slots use the component kind", () => {
  const enc = new Encoder("__enc");
  const ref = clientRef("/mod.js", "Counter");
  const code = enc.encodeVNode("c", h(ref as never, { initialValue: 2 }));
  expect(payload(run(code), "__enc", "c")).toBe(
    'P[v,P[R,"component","/mod.js","Counter"],null,{"initialValue":2}]\n',
  );
});

test("renders server components inline (their output replaces the element)", () => {
  const enc = new Encoder("__enc");
  const Greeting = ({ name }: { name: string }) => h("div", null, "Hello ", name);
  const code = enc.encodeVNode("c", h(Greeting, { name: "world" }));
  expect(payload(run(code), "__enc", "c")).toBe('P[v,"div",null,{},["Hello ","world"]]\n');
});

test("does not run useEffect callbacks during encoding", () => {
  const enc = new Encoder("__enc");
  let ran = false;
  const WithEffect = () => {
    useEffect(() => {
      ran = true;
    });
    return h("div", null, "ok");
  };

  expect(payload(run(enc.encodeVNode("c", h(WithEffect, {}))), "__enc", "c")).toBe(
    'P[v,"div",null,{},"ok"]\n',
  );
  expect(ran).toBe(false);
});

test("renders server components that use hooks", () => {
  const enc = new Encoder("__enc");
  const Counter = () => {
    const [n] = useState(2);
    return h("span", null, "n=", n);
  };
  expect(payload(run(enc.encodeVNode("c", h(Counter, {}))), "__enc", "c")).toBe(
    'P[v,"span",null,{},["n=",2]]\n',
  );
});

test("renders useContext from a context's default value", () => {
  const enc = new Encoder("__enc");
  const Theme = createContext("light");
  const Themed = () => h("em", null, useContext(Theme));
  expect(payload(run(enc.encodeVNode("c", h(Themed, {}))), "__enc", "c")).toBe(
    'P[v,"em",null,{},"light"]\n',
  );
});

test("renders useContext inside a context provider and restores scope after", () => {
  const enc = new Encoder("__enc");
  const Theme = createContext("light");
  const Themed = () => h("em", null, useContext(Theme));

  const tree = h(
    Fragment,
    null,
    h(Theme.Provider, { value: "dark" }, h(Themed, {})),
    h(Themed, {}),
  );
  expect(payload(run(enc.encodeVNode("c", tree)), "__enc", "c")).toBe(
    'P[v,"$F",null,{},[' + 'P[v,"em",null,{},"dark"],' + 'P[v,"em",null,{},"light"]' + "]]\n",
  );
});

test("carries provider scope through element vnode children", () => {
  const enc = new Encoder("__enc");
  const Theme = createContext("light");
  const Themed = () => h("em", null, useContext(Theme));

  const tree = h(
    "section",
    null,
    h(Theme.Provider, { value: "dark" }, h("div", null, h(Themed, {}))),
  );
  expect(payload(run(enc.encodeVNode("c", tree)), "__enc", "c")).toBe(
    'P[v,"section",null,{},' + 'P[v,"div",null,{},' + 'P[v,"em",null,{},"dark"]]' + "]\n",
  );
});

test("renders context consumers and nested providers", () => {
  const enc = new Encoder("__enc");
  const Theme = createContext("light");
  const Read = () => h("b", null, useContext(Theme));

  const tree = h(
    Theme.Provider,
    { value: "outer" },
    h(Theme.Consumer, {
      children: (value: string) => h(Theme.Provider, { value: `${value}+inner` }, h(Read, {})),
    }),
  );
  expect(payload(run(enc.encodeVNode("c", tree)), "__enc", "c")).toBe(
    'P[v,"b",null,{},"outer+inner"]\n',
  );
});

test("carries provider scope into settled promise values", async () => {
  const enc = new Encoder("__enc");
  const Theme = createContext("light");
  const Read = () => h("i", null, useContext(Theme));

  const sb = run(
    enc.encodeVNode("c", h(Theme.Provider, { value: "dark" }, Promise.resolve(h(Read, {})))),
  );
  expect(payload(sb, "__enc", "c")).toBe("p0\n");

  for await (const chunk of enc.flush("c")) {
    vm.runInNewContext(chunk, sb);
  }
  expect(payload(sb, "__enc", "c")).toContain('P[v,"i",null,{},"dark"]');
});

test("carries provider scope into async server component output", async () => {
  const enc = new Encoder("__enc");
  const Theme = createContext("light");
  const Read = () => h("i", null, useContext(Theme));
  const Async = async () => h(Read, {});

  const sb = run(enc.encodeVNode("c", h(Theme.Provider, { value: "dark" }, h(Async, {}))));
  expect(payload(sb, "__enc", "c")).toBe("p0\n");

  for await (const chunk of enc.flush("c")) {
    vm.runInNewContext(chunk, sb);
  }
  expect(payload(sb, "__enc", "c")).toContain('P[v,"i",null,{},"dark"]');
});

test("keeps hook state isolated across siblings and useMemo results", () => {
  const enc = new Encoder("__enc");
  const Make = ({ base }: { base: number }) => {
    const doubled = useMemo(() => base * 2, [base]);
    const [n] = useState(doubled);
    return h("i", null, n);
  };

  const tree = h(Fragment, null, h(Make, { base: 2 }), h(Make, { base: 5 }));
  expect(payload(run(enc.encodeVNode("c", tree)), "__enc", "c")).toBe(
    'P[v,"$F",null,{},[' + 'P[v,"i",null,{},4],' + 'P[v,"i",null,{},10]' + "]]\n",
  );
});

test("renders nested server components down to client references", () => {
  const enc = new Encoder("__enc");
  const ref = clientRef("/mod.js", "Counter");
  const Shell = ({ children }: { children?: unknown }) => h("section", null, children as never);
  const code = enc.encodeVNode("c", h(Shell, null, h(ref as never, {}) as never));
  expect(payload(run(code), "__enc", "c")).toBe(
    'P[v,"section",null,{},P[v,P[R,"component","/mod.js","Counter"],null,{}]]\n',
  );
});

test("renders async server components that use hooks", async () => {
  const enc = new Encoder("__enc");
  const Late = async () => {
    const [n] = useState(3);
    return h("p", null, n);
  };
  const code = enc.encodeVNode("c", h(Late, {}));
  expect(payload(run(code), "__enc", "c")).toBe("p0\n");

  const chunks: string[] = [];
  for await (const chunk of enc.flush("c")) chunks.push(chunk);
  expect(chunks).toHaveLength(1);
  expect(chunks[0]).toContain('!0+P[v,\\"p\\",null,{},3]');
});

test("renders async server components as promise placeholders settled by flush", async () => {
  const enc = new Encoder("__enc");
  const Late = async () => h("p", null, "later");
  const code = enc.encodeVNode("c", h(Late, {}));
  expect(payload(run(code), "__enc", "c")).toBe("p0\n");

  const chunks: string[] = [];
  for await (const chunk of enc.flush("c")) chunks.push(chunk);
  expect(chunks).toHaveLength(1);
  expect(chunks[0]).toContain('!0+P[v,\\"p\\",null,{},\\"later\\"]');
});

test("functions inside server component output are still rejected", () => {
  const enc = new Encoder("__enc");
  const Bad = () => ({ onClick: () => {} });
  expect(() => enc.encodeVNode("c", h(Bad, {}))).toThrow(/function/);
});

test("serializes Suspense boundaries as sentinels instead of invoking them", () => {
  const enc = new Encoder("__enc");
  const tree = h(Suspense, {
    fallback: h("span", null, "..."),
    children: h("div", null, "content"),
  });
  const code = enc.encodeVNode("c", tree);
  expect(payload(run(code), "__enc", "c")).toBe(
    'P[v,"$S",null,{"fallback":P[v,"span",null,{},"..."]},P[v,"div",null,{},"content"]]\n',
  );
});

test("keeps Suspense boundaries found in server component output", () => {
  const enc = new Encoder("__enc");
  const Page = () => h(Suspense, null, h("p", null, "streamed"));
  const code = enc.encodeVNode("c", h(Page, {}));
  expect(payload(run(code), "__enc", "c")).toBe('P[v,"$S",null,{},P[v,"p",null,{},"streamed"]]\n');
});

test("unwraps memo-wrapped components instead of invoking the wrapper", () => {
  const enc = new Encoder("__enc");
  const Inner = ({ n }: { n: number }) => h("em", null, n);
  const Wrapped = memo(Inner);
  const code = enc.encodeVNode("c", h(Wrapped, { n: 1 }));
  expect(payload(run(code), "__enc", "c")).toBe('P[v,"em",null,{},1]\n');
});

test("does not dedupe repeated client references (each site emits a token)", () => {
  const enc = new Encoder("__enc");
  const ref = clientRef("/mod.js", "Counter");
  const code = enc.encode("c", { a: ref, b: ref });
  expect(payload(run(code), "__enc", "c")).toBe(
    '{"a":P[R,"function","/mod.js","Counter"],"b":P[R,"function","/mod.js","Counter"]}\n',
  );
});

test("transmits client reference $bound (server-side closure capture)", () => {
  const enc = new Encoder("__enc");
  const ref = clientRef("/mod.js", "onRender", [42]);
  const code = enc.encode("c", { render: ref });
  expect(payload(run(code), "__enc", "c")).toBe(
    '{"render":P[R,"function","/mod.js","onRender",[42]]}\n',
  );
});

test("transmits bound scope values on component references", () => {
  const enc = new Encoder("__enc");
  const ref = clientRef("/mod.js", "InlineCounter", ["Count"]);
  const code = enc.encodeVNode("c", h(ref as never, { initialValue: 2 }));
  expect(payload(run(code), "__enc", "c")).toBe(
    'P[v,P[R,"component","/mod.js","InlineCounter",["Count"]],null,{"initialValue":2}]\n',
  );
});

test("omits empty client reference $bound args", () => {
  const enc = new Encoder("__enc");
  const ref = clientRef("/mod.js", "onRender");
  const code = enc.encode("c", { render: ref });
  expect(payload(run(code), "__enc", "c")).toBe(
    '{"render":P[R,"function","/mod.js","onRender"]}\n',
  );
});

test("encodes cycles and repeated objects as @id back-references", () => {
  const enc = new Encoder("__enc");
  const obj: Record<string, unknown> = { name: "cycle" };
  obj.self = obj;
  const code = enc.encode("cycle", obj);
  expect(payload(run(code), "__enc", "cycle")).toBe('{"name":"cycle","self":@0}\n');

  const shared = { deep: [1, 2, 3] };
  // This Encoder already claimed id 0 in the cycle row above, so this row
  // starts at base 1: root=1, shared=2, deep=3, and y aliases @2.
  const sharedCode = enc.encode("shared", { x: shared, y: shared });
  expect(payload(run(sharedCode), "__enc", "shared")).toBe('1|{"x":{"deep":[1,2,3]},"y":@2}\n');
});

test("plugin tokens do not consume reference ids (their contents may)", () => {
  const enc = new Encoder("__enc");
  const date = new Date(0);
  const code = enc.encode("mixed", [h("br", {}), date, date]);
  // ids: array=0, the vnode's empty props object=1, date=2; the second date
  // is a back-reference. The plugin token itself consumed nothing.
  expect(payload(run(code), "__enc", "mixed")).toBe(
    '[P[v,"br",null,{}],D"1970-01-01T00:00:00.000Z",@2]\n',
  );
});

test("throws on non-reference functions by default and warns when lenient", () => {
  const enc = new Encoder("__enc");
  expect(() => enc.encode("c", { fn: () => {} })).toThrow(/function/);

  const lenient = new Encoder("__lenient", { strictFunctions: false });
  const warn = vi.fn();
  const original = console.warn;
  console.warn = warn;
  try {
    const sb = run(lenient.encode("c", { fn: () => {} }));
    expect(payload(sb, "__lenient", "c")).toBe('{"fn":u}\n');
    expect(warn).toHaveBeenCalled();
  } finally {
    console.warn = original;
  }
});

test("encodes promises as placeholders that claim reference ids", () => {
  const enc = new Encoder("__enc");
  const code = enc.encode("c", { p: Promise.resolve(1) });
  // ids: root object=0, promise=1.
  expect(payload(run(code), "__enc", "c")).toBe('{"p":p1}\n');
});

test("aliases repeated promises to a single placeholder", () => {
  const enc = new Encoder("__enc");
  const shared = Promise.resolve(1);
  const code = enc.encode("c", { a: shared, b: shared });
  expect(payload(run(code), "__enc", "c")).toBe('{"a":p1,"b":@1}\n');
});

test("flush yields append chunks for settled promises in claim order", async () => {
  const enc = new Encoder("__enc");
  const sb = run(enc.encode("r", { p: Promise.resolve(41), q: Promise.reject(new Error("boom")) }));

  const chunks: string[] = [];
  for await (const chunk of enc.flush("r", true)) chunks.push(chunk);

  // Two settlements -> two script-wrapped chunks; fulfillment first.
  expect(chunks).toHaveLength(2);
  expect(chunks[0]).toMatch(/^<script>.*\+=".*!1\+41\\n";.*f\?\./);
  expect(chunks[0]).toContain("document.currentScript");
  expect(chunks[1]).toContain("!2-E");

  // Evaluating them appends the result frames to the stored row payload.
  const rootPayload = payload(sb, "__enc", "r");
  for (const chunk of chunks) {
    const code = chunk.slice("<script>".length, chunk.indexOf("document.currentScript"));
    vm.runInNewContext(code, sb);
  }
  expect(payload(sb, "__enc", "r")).toBe(
    `${rootPayload}3|!1+41\n3|!2-E{"name":"Error","message":"<redacted>","stack":u,"cause":u}\n`,
  );

  // Flushing again is a no-op once every promise has settled.
  const drained: string[] = [];
  for await (const chunk of enc.flush("r")) drained.push(chunk);
  expect(drained).toHaveLength(0);
});

test("flush emits raw code when wrapInScript is false and drains nested promises", async () => {
  const enc = new Encoder("__enc");
  run(enc.encode("r", { p: Promise.resolve({ p: Promise.resolve("inner") }) }));

  const chunks: string[] = [];
  for await (const chunk of enc.flush("r")) chunks.push(chunk);
  // The outer settlement carries a nested promise placeholder (id 3); the
  // inner value arrives in a follow-up chunk. Quotes are escaped in the
  // emitted JS string literal.
  expect(chunks).toHaveLength(2);
  expect(chunks[0]).toContain('!1+{\\"p\\":p3');
  expect(chunks[1]).toContain('!3+\\"inner\\"');
});

test("skips VNode refs with a warning by default and throws when strict", () => {
  const vnode = h("div", { ref: { current: null } }, "x");

  const enc = new Encoder("__enc");
  const warn = vi.fn();
  const original = console.warn;
  console.warn = warn;
  try {
    expect(payload(run(enc.encodeVNode("c", vnode)), "__enc", "c")).toContain('P[v,"div",null,{');
    expect(warn).toHaveBeenCalled();
  } finally {
    console.warn = original;
  }

  const strict = new Encoder("__strict", { strictRefs: true });
  expect(() => strict.encodeVNode("c", vnode)).toThrow(/ref/);
});

test("warns on symbol-keyed properties (not representable in object bodies)", () => {
  const enc = new Encoder("__enc");
  const sym = Symbol.for("pp.test.prop");
  const warn = vi.fn();
  const original = console.warn;
  console.warn = warn;
  try {
    const code = enc.encode("c", { ok: 1, [sym]: 2 });
    expect(payload(run(code), "__enc", "c")).toBe('{"ok":1}\n');
    expect(warn).toHaveBeenCalled();
  } finally {
    console.warn = original;
  }
});

test("redacts errors by default and can be disabled", () => {
  const enc = new Encoder("__enc");
  expect(payload(run(enc.encode("c", { e: new TypeError("boom") })), "__enc", "c")).toContain(
    '"e":E{"name":"Error","message":"<redacted>","stack":u',
  );

  const open = new Encoder("__open", { redactErrors: false });
  const raw = payload(
    run(open.encode("c", { e: new TypeError("boom", { cause: new Error("root") }) })),
    "__open",
    "c",
  );
  expect(raw).toContain('"e":E{"name":"TypeError","message":"boom"');
  expect(raw).toContain('"cause":E{"name":"Error"');

  const custom = new Encoder("__custom", { redactErrors: "[redacted]" });
  expect(payload(run(custom.encode("c", { e: new Error("boom") })), "__custom", "c")).toContain(
    '"message":"[redacted]"',
  );
});

test("encodes missing array entries as explicit undefined tokens", () => {
  const enc = new Encoder("__enc");
  const code = enc.encode("a", [[undefined, 1]]);
  expect(payload(run(code), "__enc", "a")).toBe("[[u,1]]\n");
});

test("encodes other iterables as arrays", () => {
  const enc = new Encoder("__enc");
  function* gen() {
    yield 1;
    yield 2;
  }
  const code = enc.encode("a", { g: gen() });
  expect(payload(run(code), "__enc", "a")).toBe('{"g":[1,2]}\n');
});

test("inlines toJSON results without consuming reference ids", () => {
  const enc = new Encoder("__enc");
  const wrapped = {
    toJSON: () => ({ v: 1 }),
  };
  const code = enc.encode("a", [wrapped, wrapped]);
  expect(payload(run(code), "__enc", "a")).toBe('[{"v":1},{"v":1}]\n');
});

test("re-encoding a row replays its payload and re-homes settlements", async () => {
  const enc = new Encoder("__enc");
  const shared = { tag: "shared" };
  const promise = Promise.resolve(7);
  const vnode = h(clientRef("/b.js", "C") as never, { initialValue: promise, shared });

  // A Suspense boundary renders its client component twice: the first
  // attempt throws while awaiting a promise and its script is discarded,
  // the retry encodes the same vnode under a fresh row name (useId
  // advances across attempts).
  const first = enc.encodeVNode("island-a", vnode);
  const retry = enc.encodeVNode("island-b", vnode);

  // The retry must ship the first attempt's payload — the discarded frame
  // claimed reference ids, so a freshly written frame would emit
  // back-references into a payload that never ships.
  expect(payload(run(first), "__enc", "island-a")).toBe(payload(run(retry), "__enc", "island-b"));
  expect(payload(run(retry), "__enc", "island-b")).toContain("p1");

  // Re-encoding under the same name replays verbatim as well.
  expect(enc.encodeVNode("island-b", vnode)).toBe(retry);

  // The placeholder stashed by the discarded attempt settles under the row
  // name that actually shipped, exactly once.
  const drainedA: string[] = [];
  for await (const chunk of enc.flush("island-a")) drainedA.push(chunk);
  expect(drainedA).toHaveLength(0);

  const drainedB: string[] = [];
  for await (const chunk of enc.flush("island-b")) drainedB.push(chunk);
  expect(drainedB).toHaveLength(1);
  expect(drainedB[0]).toContain("!1+7");
});

test("a retry whose promise already settled ships the settlement inline", async () => {
  const enc = new Encoder("__enc");
  const gate = new Promise<string>((resolve) => setTimeout(() => resolve("slow"), 1));
  const vnode = h(clientRef("/b.js", "C") as never, { initialValue: gate });

  const first = enc.encodeVNode("island-a", vnode);
  expect(payload(run(first), "__enc", "island-a")).toContain("p1");

  // Real suspense: the boundary only retries after its promise resolved, so
  // by the time the retry row is encoded the settlement has been captured.
  await gate;
  const retry = enc.encodeVNode("island-b", vnode);

  // The retry payload carries the placeholder's result frame inline — the
  // shipped script is self-contained, so the client decodes the settlement
  // without waiting for a follow-up append chunk (which could race the
  // hydration of the island's own markup).
  const retryPayload = payload(run(retry), "__enc", "island-b");
  expect(retryPayload).toContain("p1");
  expect(retryPayload).toContain('!1+"slow"');

  // The delivered promise leaves the queue: flushing the retry row is a no-op
  // instead of double-emitting the same frame.
  const drained: string[] = [];
  for await (const chunk of enc.flush("island-b")) drained.push(chunk);
  expect(drained).toHaveLength(0);
});

test("non-blocking flush yields only already-captured settlements", async () => {
  const enc = new Encoder("__enc");
  const gate = new Promise<string>((resolve) => setTimeout(() => resolve("later"), 5));
  run(enc.encode("r", { p: gate }));

  // Before the promise settles: nothing is yielded and it is left queued.
  const early: string[] = [];
  for await (const chunk of enc.flush("r", true, undefined, false)) early.push(chunk);
  expect(early).toHaveLength(0);

  // Once settled, the same row drains to completion on a later pass.
  await gate;
  const late: string[] = [];
  for await (const chunk of enc.flush("r", true, undefined, false)) late.push(chunk);
  expect(late).toHaveLength(1);
  expect(late[0]).toContain('!1+\\"later\\"');

  // And the blocking mode (default) still waits for outstanding promises.
  const enc2 = new Encoder("__enc");
  const gate2 = new Promise<string>((resolve) => setTimeout(() => resolve("wait"), 5));
  run(enc2.encode("r", { p: gate2 }));
  const blocking: string[] = [];
  for await (const chunk of enc2.flush("r")) blocking.push(chunk);
  expect(blocking).toHaveLength(1);
  expect(blocking[0]).toContain('!1+\\"wait\\"');
});

test("flush stamps the CSP nonce onto append script tags", async () => {
  const enc = new Encoder("__enc");
  const sb = run(enc.encode("r", { p: Promise.resolve(1) }));

  const chunks: string[] = [];
  for await (const chunk of enc.flush("r", true, "nonce-1")) chunks.push(chunk);
  expect(chunks).toHaveLength(1);
  expect(chunks[0]).toMatch(/^<script nonce="nonce-1">/);

  // Evaluating the stamped chunk still appends the result frame.
  const code = chunks[0].slice(chunks[0].indexOf(">") + 1, chunks[0].indexOf("document"));
  vm.runInNewContext(code, sb);
  expect(payload(sb, "__enc", "r")).toBe('{"p":p1}\n2|!1+1\n');
});

test("wrapInScript emits a script tag", () => {
  const enc = new Encoder("__enc");
  const code = enc.encode("c", 1, true);
  expect(code).toMatch(/^<script>/);
  expect(code).toContain("document.currentScript?.remove();");
});

test("escapes < in the stored payload literal to prevent script breakout", () => {
  const enc = new Encoder("__enc");
  const code = enc.encode("c", { html: "</script><script>alert(1)</script>" });
  // Every "<" in the emitted literal becomes "\u003c", so no "</script>"
  // sequence can appear in the output at all.
  expect(code).not.toContain("</");
  expect(code).toContain("\\u003c/script>");
  // The evaluated payload still holds the original strings.
  const sb = run(code);
  expect(payload(sb, "__enc", "c")).toContain("</script>");
});

test("dedupes object instances across rows via monotonic reference ids", () => {
  const enc = new Encoder("__enc");
  const shared = { deep: [1] };
  // Row "a" claims ids 0 (root), 1 (shared), 2 (deep).
  expect(payload(run(enc.encode("a", { shared })), "__enc", "a")).toBe('{"shared":{"deep":[1]}}\n');
  // Row "b" starts at id 3 (declared by its base header) and points back to
  // id 1 from row "a"; its own root object claims id 3.
  expect(payload(run(enc.encode("b", { other: shared })), "__enc", "b")).toBe('3|{"other":@1}\n');
  // Re-encoding the same instance as a root aliases it without claiming.
  expect(payload(run(enc.encode("c", shared)), "__enc", "c")).toBe("4|@1\n");
});

test("supports a custom isClientReference predicate", () => {
  const marker = Symbol("marker");
  const ref = Object.assign(() => {}, { marker, $mod: "/mod.js", $name: "Thing" });
  const enc = new Encoder("__enc", {
    isClientReference: (v) =>
      typeof v === "function" && "marker" in (v as object) && (v as any).marker === marker,
  });
  const code = enc.encode("c", { ref });
  expect(payload(run(code), "__enc", "c")).toBe('{"ref":P[R,"function","/mod.js","Thing"]}\n');
});
