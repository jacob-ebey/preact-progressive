import * as vm from "node:vm";
import { Fragment, h, type VNode } from "preact";
import { afterEach, expect, test } from "vite-plus/test";

import { Encoder } from "./encoder.ts";
import { Decoder } from "./decoder.ts";

type ModuleRegistry = Record<string, { p: Promise<unknown>; m?: Record<string, unknown> }>;

type Sandbox = Record<string, unknown>;

/** Evaluates encoder output so the stored payload lands in a fake globalThis. */
function run(code: string): Sandbox {
  const sandbox: Sandbox = {};
  sandbox.globalThis = sandbox;
  vm.runInNewContext(code, sandbox);
  return sandbox;
}

/** Stores an encoded payload where the Decoder can read it, then decodes it. */
function decodePayload(ns: string, id: string, payload: string, namespace = ns): unknown {
  const row = ((globalThis as Record<string, any>)[ns] ??= {});
  (row.d ??= {})[id] = payload;
  return new Decoder(namespace).decode(id);
}

let rowCounter = 0;

/** Encode -> evaluate -> decode roundtrip. Rows get unique names (like islands). */
function roundtrip(value: unknown, encoderOptions?: ConstructorParameters<typeof Encoder>[1]) {
  const row = `row-${rowCounter++}`;
  const enc = new Encoder("__enc", encoderOptions);
  const sb = run(enc.encode(row, value));
  const stored = (sb.__enc as { d: Record<string, string> }).d;
  ((globalThis as Record<string, any>).__dec ??= {}).d = {
    ...(globalThis as Record<string, any>).__dec?.d,
    ...stored,
  };
  return new Decoder("__dec").decode(row);
}

function setModules(mods: ModuleRegistry) {
  (globalThis as Record<string, unknown>).__pp = mods;
}

afterEach(() => {
  delete (globalThis as Record<string, unknown>).__dec;
  delete (globalThis as Record<string, unknown>).__enc;
  delete (globalThis as Record<string, unknown>).__pp;
  delete (globalThis as Record<string, unknown>).__pm;
});

test("roundtrips primitives", () => {
  const result = roundtrip({
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
  }) as Record<string, unknown>;
  expect(result.s).toBe("hi");
  expect(result.n).toBe(42);
  expect(result.f).toBe(1.5);
  expect(Number.isNaN(result.nan)).toBe(true);
  expect(result.inf).toBe(Infinity);
  expect(result.ninf).toBe(-Infinity);
  expect(Object.is(result.negZero, -0)).toBe(true);
  expect(result.b).toBe(true);
  expect(result.bi).toBe(9007199254740993n);
  expect("u" in result && result.u === undefined).toBe(true);
  expect(result.nil).toBe(null);
  expect(result.sym).toBe(Symbol.for("pp.test.known"));
});

test("roundtrips built-in types", () => {
  const date = new Date("2024-01-02T03:04:05.000Z");
  const invalid = new Date("not-a-date");
  const result = roundtrip({
    date,
    invalid,
    re: /ab+c/gi,
    url: new URL("https://example.com/x"),
    map: new Map<unknown, unknown>([["k", { deep: [1, 2] }]]),
    set: new Set([1, "two"]),
    bytes: new Uint8Array([1, 2, 3]),
    clamped: new Uint8ClampedArray([255, 300, -1]),
    i8: new Int8Array([-128, 127]),
    i16: new Int16Array([-32768]),
    u16: new Uint16Array([65535]),
    i32: new Int32Array([-2147483648]),
    u32: new Uint32Array([4294967295]),
    f32: new Float32Array([0.5]),
    f64: new Float64Array([0.1]),
    bigI64: new BigInt64Array([-9007199254740993n]),
    bigU64: new BigUint64Array([18446744073709551615n]),
    dv: new DataView(new Uint8Array([1, 2, 3]).buffer),
    ab: new Uint8Array([9, 8, 7]).buffer,
  }) as Record<string, any>;

  expect(result.date).toBeInstanceOf(Date);
  expect(result.date.getTime()).toBe(date.getTime());
  // Invalid dates survive as invalid dates.
  expect(result.invalid).toBeInstanceOf(Date);
  expect(Number.isNaN(result.invalid.getTime())).toBe(true);

  expect(result.re).toBeInstanceOf(RegExp);
  expect(result.re.source).toBe("ab+c");
  expect(result.re.flags).toBe("gi");

  expect(result.url).toBeInstanceOf(URL);
  expect(result.url.href).toBe("https://example.com/x");

  expect(result.map).toBeInstanceOf(Map);
  expect(result.map.get("k").deep).toEqual([1, 2]);
  expect(result.set).toBeInstanceOf(Set);
  expect([...result.set]).toEqual([1, "two"]);

  expect(result.bytes).toBeInstanceOf(Uint8Array);
  expect(Array.from(result.bytes)).toEqual([1, 2, 3]);
  expect(Array.from(result.clamped)).toEqual([255, 255, 0]);
  expect(Array.from(result.i8)).toEqual([-128, 127]);
  expect(Array.from(result.i16)).toEqual([-32768]);
  expect(Array.from(result.u16)).toEqual([65535]);
  expect(Array.from(result.i32)).toEqual([-2147483648]);
  expect(Array.from(result.u32)).toEqual([4294967295]);
  expect(Array.from(result.f32)).toEqual([0.5]);
  expect(Array.from(result.f64)).toEqual([0.1]);
  expect(Array.from(result.bigI64)).toEqual([-9007199254740993n]);
  expect(Array.from(result.bigU64)).toEqual([18446744073709551615n]);

  expect(result.dv).toBeInstanceOf(DataView);
  expect(Array.from(new Uint8Array(result.dv.buffer))).toEqual([1, 2, 3]);
  expect(result.ab).toBeInstanceOf(ArrayBuffer);
  expect(Array.from(new Uint8Array(result.ab))).toEqual([9, 8, 7]);
});

test("preserves identity for shared values across the tree", () => {
  const shared = { id: "shared" };
  const list = [shared];
  const map = new Map<unknown, unknown>([[shared, "v"]]);
  const result = roundtrip({ list, map, alias: shared }) as Record<string, any>;

  expect(result.list[0]).toBe(result.alias);
  // Map keys that are also present elsewhere resolve to the same identity.
  expect([...result.map.keys()][0]).toBe(result.alias);
});

test("resolves cyclic references to a single live object", () => {
  const obj: Record<string, unknown> = { name: "cycle" };
  obj.self = obj;
  const result = roundtrip(obj) as Record<string, unknown>;
  expect(result.name).toBe("cycle");
  expect(result.self).toBe(result);
});

test("roundtrips VNode trees including fragments, keys, and nesting", () => {
  const vnode = h(
    "div",
    { id: "root" },
    h("span", { key: "k1" }, "hello"),
    h(Fragment, null, "a", "b"),
    h("p", null, h("em", null, "nested")),
  );
  const tree = roundtrip(vnode) as VNode;

  expect(tree.type).toBe("div");
  const props = tree.props as Record<string, unknown>;
  expect(props.id).toBe("root");

  const children = props.children as VNode[];
  expect(children[0].type).toBe("span");
  expect(children[0].key).toBe("k1");
  expect(children[1].type).toBe(Fragment);
  expect(children[2].type).toBe("p");
  const em = (children[2].props as Record<string, unknown>).children as VNode;
  expect(em.type).toBe("em");
});

test("decodes deeply nested VNode chains", () => {
  let node: unknown = h("em", null, "leaf");
  for (let i = 0; i < 300; i++) {
    node = h("div", { class: `l${i}` }, node as never);
  }
  const result = roundtrip(node) as VNode;

  let cur = result as VNode;
  for (let i = 299; i >= 0; i--) {
    expect(cur.type).toBe("div");
    expect((cur.props as Record<string, unknown>).class).toBe(`l${i}`);
    cur = (cur.props as Record<string, unknown>).children as VNode;
  }
  expect(cur.type).toBe("em");
  expect(cur.props.children).toBe("leaf");
});

test("decodes loaded component references directly and pending ones as lazy", () => {
  const Counter = function Counter() {};
  const refVNode = (mod: string) =>
    h(
      Object.assign(() => {}, {
        $type: Symbol.for("pp.client-reference"),
        $mod: mod,
        $name: "Counter",
      }) as never,
      {},
    );

  setModules({ "/m.js": { p: Promise.resolve(), m: { Counter } } });
  const loaded = roundtrip(refVNode("/m.js")) as VNode;
  expect(loaded.type).toBe(Counter);

  setModules({ "/pending.js": { p: new Promise(() => {}) } }); // pending, no exports yet
  const lazyResult = roundtrip(refVNode("/pending.js")) as VNode & {
    type: { displayName?: string };
  };
  expect(typeof lazyResult.type).toBe("function"); // lazy() component
  expect(lazyResult.type.displayName).toBe("Lazy");
});

test("decodes function-kind references into callables resolved at call time", () => {
  setModules({
    "/m.js": { p: Promise.resolve(), m: { add: (a: number, b: number) => a + b } },
  });

  const result = roundtrip({
    cb: Object.assign(() => {}, {
      $type: Symbol.for("pp.client-reference"),
      $mod: "/m.js",
      $name: "add",
    }),
  }) as { cb: (a: number, b: number) => number };
  expect(result.cb(3, 4)).toBe(7);

  // Not-yet-loaded modules still produce a working call-time wrapper.
  setModules({
    "/later.js": { p: Promise.resolve(), m: { mul: (a: number, b: number) => a * b } },
  });
  const later = roundtrip({
    cb: Object.assign(() => {}, {
      $type: Symbol.for("pp.client-reference"),
      $mod: "/later.js",
      $name: "mul",
    }),
  }) as { cb: () => void };
  expect(typeof later.cb).toBe("function");
});

test("applies bound scope values to component references", () => {
  const calls: unknown[][] = [];
  const Counter = (...args: unknown[]) => {
    calls.push(args);
    return h("b", null, "ok");
  };
  setModules({ "/m.js": { p: Promise.resolve(), m: { Counter } } });

  const ref = Object.assign(() => {}, {
    $type: Symbol.for("pp.client-reference"),
    $mod: "/m.js",
    $name: "Counter",
    $bound: ["scope-value"],
  });
  const tree = roundtrip(h(ref as never, { initialValue: 2 })) as VNode & {
    type: (...args: unknown[]) => unknown;
    props: Record<string, unknown>;
  };

  expect(typeof tree.type).toBe("function");
  (tree.type as (...args: unknown[]) => unknown)(tree.props);
  expect(calls).toEqual([["scope-value", { initialValue: 2 }]]);
});

test("applies bound scope values to function-kind references at call time", () => {
  setModules({
    "/m.js": { p: Promise.resolve(), m: { add: (a: number, b: number) => a + b } },
  });

  const ref = Object.assign(() => {}, {
    $type: Symbol.for("pp.client-reference"),
    $mod: "/m.js",
    $name: "add",
    $bound: [40],
  });
  const result = roundtrip({ cb: ref }) as { cb: (b: number) => number };
  expect(result.cb(2)).toBe(42);
});

test("resolves client references nested inside Maps and Sets", () => {
  const ref = Object.assign(() => {}, {
    $type: Symbol.for("pp.client-reference"),
    $mod: "/m.js",
    $name: "add",
  });
  setModules({
    "/m.js": { p: Promise.resolve(), m: { add: (a: number, b: number) => a + b } },
  });

  const result = roundtrip({
    handlers: new Map<unknown, unknown>([["onClick", ref]]),
    group: new Set([ref]),
  }) as { handlers: Map<string, unknown>; group: Set<unknown> };

  const handler = result.handlers.get("onClick") as (a: number, b: number) => number;
  expect(handler(20, 22)).toBe(42);
  const grouped = [...result.group][0] as (a: number, b: number) => number;
  expect(grouped(1, 41)).toBe(42);
});

test("keeps client references identical when the same ref appears twice", () => {
  const Counter = function Counter() {};
  setModules({ "/m.js": { p: Promise.resolve(), m: { Counter } } });
  const ref = Object.assign(() => {}, {
    $type: Symbol.for("pp.client-reference"),
    $mod: "/m.js",
    $name: "Counter",
  });
  const result = roundtrip([ref, ref, { deep: [ref] }]) as unknown[];
  expect(result[0]).toBe(result[1]);
  expect((result[2] as any).deep[0]).toBe(result[0]);
});

test("roundtrips errors unredacted when redactErrors is false", () => {
  const cause = new Error("root cause");
  const error = new TypeError("boom", { cause });
  const result = roundtrip(error, { redactErrors: false }) as Error & { cause: Error };
  expect(result).toBeInstanceOf(Error);
  expect(result.name).toBe("TypeError");
  expect(result.message).toBe("boom");
  expect(result.cause).toBeInstanceOf(Error);
  expect((result.cause as Error).message).toBe("root cause");
});

test("redacts errors by default", () => {
  const result = roundtrip(new TypeError("boom")) as Error;
  expect(result).toBeInstanceOf(Error);
  expect(result.name).toBe("Error");
  expect(result.message).toBe("<redacted>");
});

test("drops symbol-keyed properties during encoding", () => {
  const sym = Symbol.for("pp.test.prop");
  const result = roundtrip({ ok: 1, [sym]: 2 }) as Record<symbol | string, unknown>;
  expect(result.ok).toBe(1);
  expect(result[sym]).toBeUndefined();
});

test("guards against __proto__ pollution from crafted payloads", () => {
  const crafted = '{"__proto__":{"polluted":true},"ok":1}\n';
  const result = decodePayload("__dec", "proto", crafted) as Record<string, unknown>;
  expect(result.ok).toBe(1);
  expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  expect(Object.getOwnPropertyDescriptor(result, "__proto__")?.value).toEqual({ polluted: true });
});

test("returns undefined for missing rows and rejects malformed trailing content", () => {
  expect(new Decoder("__dec").decode("missing")).toBeUndefined();

  expect(() => decodePayload("__dec", "bad", '42\n"garbage"\n')).toThrow(SyntaxError);
  expect(() => decodePayload("__dec", "bad2", '{"a":}\n')).toThrow(SyntaxError);
});

test("preload triggers module import for every referenced module", async () => {
  const enc = new Encoder("__enc");
  const mk = ($mod: string) =>
    Object.assign(() => {}, {
      $type: Symbol.for("pp.client-reference"),
      $mod,
      $name: "A",
    });
  const sb = run(enc.encode("x", [mk("/b.js"), mk("/a.js"), mk("/a.js")]));

  const pp: ModuleRegistry = {};
  setModules(pp);
  (globalThis as Record<string, unknown>).__pm = (mod: string) => {
    pp[mod] = { p: Promise.resolve() };
  };

  const row = (sb.__enc as { d: Record<string, string> }).d;
  ((globalThis as Record<string, any>).__dec ??= {}).d = row;
  await new Decoder("__dec").preload("x");
  expect(pp["/a.js"]).toBeDefined();
  expect(pp["/b.js"]).toBeDefined();
});

test("preload warms a custom loadModule instead of __pm", async () => {
  const enc = new Encoder("__enc");
  const sb = run(enc.encode("x", { ref: clientRefLike("/custom-preload.js", "A") }));
  const row = (sb.__enc as { d: Record<string, string> }).d;
  ((globalThis as Record<string, any>).__dec ??= {}).d = row;

  let pmCalls = 0;
  (globalThis as Record<string, unknown>).__pm = () => {
    pmCalls++;
  };
  const warmed: [string, string][] = [];
  await new Decoder("__dec", {
    loadModule: (mod, name) => {
      warmed.push([mod, name]);
      return () => {};
    },
  }).preload("x");

  expect(warmed).toEqual([["/custom-preload.js", "A"]]);
  expect(pmCalls).toBe(0);
});

test("preload resolves even when modules were already registered", async () => {
  setModules({
    "/loaded.js": { p: Promise.resolve(), m: { A: () => {} } },
  });
  const enc = new Encoder("__enc");
  const ref = Object.assign(() => {}, {
    $type: Symbol.for("pp.client-reference"),
    $mod: "/loaded.js",
    $name: "A",
  });
  const sb = run(enc.encode("y", { cb: ref }));
  const row = (sb.__enc as { d: Record<string, string> }).d;
  ((globalThis as Record<string, any>).__dec ??= {}).d = row;
  await expect(new Decoder("__dec").preload("y")).resolves.toBeUndefined();
});

test("full hydration-style flow: preload then decode a component boundary row", async () => {
  const Counter = function Counter() {};
  const enc = new Encoder("__enc", {
    isClientReference: (v) =>
      typeof v === "function" &&
      "$type" in (v as object) &&
      (v as any).$type === Symbol.for("pp.client-reference"),
  });
  const ref = Object.assign(() => {}, {
    $type: Symbol.for("pp.client-reference"),
    $mod: "/counter.js",
    $name: "Counter",
  });
  const code = enc.encodeVNode("P0-0", {
    type: ref,
    props: { initialValue: 2 },
    key: undefined,
    ref: undefined,
  });
  const row = (run(code).__enc as { d: Record<string, string> }).d;
  ((globalThis as Record<string, any>).__dec ??= {}).d = row;

  const pp: ModuleRegistry = {};
  setModules(pp);
  (globalThis as Record<string, unknown>).__pm = (mod: string) => {
    pp[mod] = {
      p: Promise.resolve().then(() => {}),
      get m() {
        return exports;
      },
    };
  };
  const exports = { Counter };

  const decoder = new Decoder("__dec");
  await decoder.preload("P0-0");
  const tree = decoder.decode("P0-0") as VNode;
  expect(tree.type).toBe(Counter);
  expect((tree.props as Record<string, unknown>).initialValue).toBe(2);
});

test("uses a custom loadModule for component references", () => {
  const Counter = function Counter() {};
  const enc = new Encoder("__enc");
  const code = enc.encodeVNode("P0-0", {
    type: clientRefLike("/custom.js", "Counter"),
    props: { initialValue: 1 },
    key: undefined,
    ref: undefined,
  });
  ((globalThis as Record<string, any>).__dec ??= {}).d = (
    run(code).__enc as { d: Record<string, string> }
  ).d;

  const calls: [string, string][] = [];
  const decoder = new Decoder("__dec", {
    loadModule: (mod, name) => {
      calls.push([mod, name]);
      return name === "Counter" ? Counter : undefined;
    },
  });
  const tree = decoder.decode("P0-0") as VNode;
  expect(tree.type).toBe(Counter);
  expect((tree.props as Record<string, unknown>).initialValue).toBe(1);
  expect(calls).toEqual([["/custom.js", "Counter"]]);
});

test("wraps pending custom-loaded components in lazy", () => {
  const Counter = function Counter() {};
  const enc = new Encoder("__enc");
  const code = enc.encodeVNode("c", {
    type: clientRefLike("/pending-custom.js", "Counter"),
    props: {},
    key: undefined,
    ref: undefined,
  });
  ((globalThis as Record<string, any>).__dec ??= {}).d = (
    run(code).__enc as { d: Record<string, string> }
  ).d;

  const decoder = new Decoder("__dec", {
    loadModule: (_mod, name) => Promise.resolve(name === "Counter" ? Counter : undefined),
  });
  const tree = decoder.decode("c") as VNode & { type: { displayName?: string } };
  expect(tree.type.displayName).toBe("Lazy");
});

test("uses a custom loadModule for function references", () => {
  storeRows(["f", { add: clientRefLike("/custom-fn.js", "add") }]);

  const decoder = new Decoder("__dec", {
    loadModule: (_mod, name) => (name === "add" ? (a: number, b: number) => a + b : undefined),
  });
  const result = decoder.decode("f") as { add: (a: number, b: number) => number };
  expect(result.add(20, 22)).toBe(42);
});

test("resolves function references through the loader at call time", () => {
  storeRows(["g", { add: clientRefLike("/lazy-fn.js", "add") }]);

  let loaded: ((a: number, b: number) => number) | undefined;
  const decoder = new Decoder("__dec", {
    loadModule: (_mod, name) => (name === "add" ? loaded : undefined),
  });
  const result = decoder.decode("g") as { add: (a: number, b: number) => number };
  expect(() => result.add(1, 2)).toThrow(/not found/);
  loaded = (a, b) => a + b;
  expect(result.add(20, 22)).toBe(42);
});

test("bound references decode to re-encodable client references", () => {
  // Mimics the babel `__pp_create_ref` shape: a callable carrying
  // `$type`/`$mod`/`$name`/`$bound` plus an own `.bind` deriving bound copies.
  const impl = (a: number, b: number) => a + b;
  const makeRef = (bound: unknown[]) =>
    Object.assign((...args: number[]) => impl(...(bound as [number]), ...(args as [number])), {
      $type: Symbol.for("pp.client-reference"),
      $mod: "/m.js",
      $name: "add",
      $bound: bound,
      bind(_thisArg: unknown, ...args: unknown[]) {
        const start = args.length > 0 && args[0] === null ? 1 : 0;
        return makeRef([...bound, ...args.slice(start)]);
      },
    });

  storeRows(["rt", { cb: makeRef([40]) }]);
  const decoder = new Decoder("__dec", { loadModule: () => makeRef([]) });
  const result = decoder.decode("rt") as { cb: (...args: unknown[]) => unknown };
  const decoded = result.cb as unknown as Record<string | symbol, unknown>;
  expect(decoded.$type).toBe(Symbol.for("pp.client-reference"));
  expect(decoded.$bound).toEqual([40]);
  expect(result.cb(2)).toBe(42);

  // The decoded value travels back through the encoder as a `$R` token.
  const re = new Encoder("__re");
  expect(() => re.encode("rt2", result)).not.toThrow();
});

function clientRefLike(mod: string, name = "A") {
  return Object.assign(() => {}, {
    $type: Symbol.for("pp.client-reference"),
    $mod: mod,
    $name: name,
  });
}

/** Encodes several rows with one Encoder and stores all payloads for decode. */
function storeRows(...entries: [id: string, value: unknown][]): void {
  const enc = new Encoder("__enc");
  const d: Record<string, string> = {};
  for (const [id, value] of entries) {
    d[id] = (run(enc.encode(id, value)).__enc as { d: Record<string, string> }).d[id];
  }
  ((globalThis as Record<string, any>).__dec ??= {}).d = d;
}

test("shares cross-row instances with identity regardless of decode order", () => {
  const shared = { tag: "shared" };
  storeRows(["a", { list: [shared] }], ["b", { alias: shared, nested: { deep: shared } }]);

  const decoder = new Decoder("__dec");
  // Decode the LATER row first: @2 is not materialized yet, so the decoder
  // locates the row owning id 2 via base headers and materializes it first.
  const b = decoder.decode("b") as Record<string, any>;
  const a = decoder.decode("a") as Record<string, any>;
  expect(b.alias).toBe(a.list[0]);
  expect(b.nested.deep).toBe(a.list[0]);
});

test("throws when a reference id was never claimed by any row", () => {
  expect(() => decodePayload("__dec", "c", '{"x":@9}\n')).toThrow(/Missing reference @9/);
});

test("shares instances across separate Decoder instances (per-island decoders)", () => {
  const shared = { tag: "shared" };
  storeRows(["a", { list: [shared] }], ["b", { alias: shared }]);

  // client.ts creates a fresh Decoder per island; the shared refs array
  // lives on the namespace, not the instance.
  const b = new Decoder("__dec").decode("b") as Record<string, any>;
  const a = new Decoder("__dec").decode("a") as Record<string, any>;
  expect(b.alias).toBe(a.list[0]);
});

test("preload collects modules transitively through cross-row references", async () => {
  const holder = { cb: clientRefLike("/shared.js") };
  storeRows(["a", { holder }], ["b", { link: holder }]);

  const pp: ModuleRegistry = {};
  setModules(pp);
  (globalThis as Record<string, unknown>).__pm = (mod: string) => {
    pp[mod] = { p: Promise.resolve() };
  };

  await new Decoder("__dec").preload("b");
  expect(pp["/shared.js"]).toBeDefined();
});

test("decodes promise placeholders with inline result frames", async () => {
  const result = decodePayload("__dec", "p1", '{"ok":p1}\n2|!1+7\n') as {
    ok: Promise<number>;
  };
  expect(result.ok).toBeInstanceOf(Promise);
  await expect(result.ok).resolves.toBe(7);

  const rejected = decodePayload("__dec", "p2", '{"e":p1}\n!1-"boom"\n') as {
    e: Promise<never>;
  };
  await expect(rejected.e).rejects.toBe("boom");
});

test("pump settles placeholders from frames appended after decode", async () => {
  const row = ((globalThis as Record<string, any>)["__dec"] ??= {});
  (row.d ??= {})["late"] = '{"p":p1}\n';
  const decoder = new Decoder("__dec");
  const root = decoder.decode("late") as { p: Promise<string> };
  expect(root.p).toBeInstanceOf(Promise);

  // Simulate a streamed-in append chunk (as produced by Encoder.flush).
  (globalThis as Record<string, any>)["__dec"].d["late"] += '2|!1+"delayed"\n';
  decoder.pump("late");

  await expect(root.p).resolves.toBe("delayed");
  // Pumping again with no new content is a harmless no-op.
  expect(() => decoder.pump("late")).not.toThrow();
});

test("settlements can reference instances owned by other rows", async () => {
  const bag = ((globalThis as Record<string, any>)["__dec"] ??= {});
  (bag.d ??= {}).a = '{"shared":{"tag":"shared"}}\n';
  // Row "b" starts at id 3: its root object claims 3, its promise claims 4,
  // and its result frame (base 5) fulfills with a back-reference to @1.
  bag.d.b = '3|{"p":p4}\n5|!4+@1\n';

  const decoder = new Decoder("__dec");
  const a = decoder.decode("a") as Record<string, any>;
  const b = decoder.decode("b") as { p: Promise<unknown> };
  await expect(b.p).resolves.toBe(a.shared);
});

test("preload collects modules referenced inside promise results", async () => {
  const bag = ((globalThis as Record<string, any>)["__dec"] ??= {});
  (bag.d ??= {}).x = '{"p":p1}\n2|!1+P[R,"function","/late.js","A"]\n';

  const pp: ModuleRegistry = {};
  setModules(pp);
  (globalThis as Record<string, unknown>).__pm = (mod: string) => {
    pp[mod] = { p: Promise.resolve() };
  };

  await new Decoder("__dec").preload("x");
  expect(pp["/late.js"]).toBeDefined();
});

test("hydrates a Suspense-retried island whose props carry a promise", async () => {
  const InlineCounter = function InlineCounter() {};
  const Counter = function Counter() {};
  const enc = new Encoder("__enc", {
    isClientReference: (v) =>
      typeof v === "function" &&
      "$type" in (v as object) &&
      (v as any).$type === Symbol.for("pp.client-reference"),
  });

  const shared = { tag: "shared" };
  const promise = Promise.resolve(1);

  // Island A renders plainly; island B sits inside Suspense, so its first
  // render attempt throws while awaiting the promise and its script never
  // ships. The retry re-encodes the same row with the same vnode.
  const codeA = enc.encodeVNode("P0-0", {
    type: clientRefLike("/counter.js", "Counter"),
    props: { initialValue: 2, shared },
    key: undefined,
    ref: undefined,
  });
  const boundary = {
    type: clientRefLike("/inline.js", "InlineCounter"),
    props: { initialValue: promise, shared },
    key: undefined,
    ref: undefined,
  };
  enc.encodeVNode("P0-1", boundary); // discarded attempt (useId advances)
  const codeB = enc.encodeVNode("P0-2", boundary); // delivered retry

  const sb = run(codeA);
  vm.runInNewContext(codeB, sb);
  const bag = ((globalThis as Record<string, any>)["__dec"] ??= {});
  bag.d = { ...(sb.__enc as { d: Record<string, string> }).d };

  // Settlement append chunks stream in after the HTML; evaluate them like
  // inline scripts and mirror the accumulated payload.
  for await (const chunk of enc.flush("P0-2")) {
    vm.runInNewContext(chunk, sb);
    bag.d["P0-2"] = (sb.__enc as { d: Record<string, string> }).d["P0-2"];
  }

  const pp: ModuleRegistry = {};
  setModules(pp);
  (globalThis as Record<string, unknown>).__pm = (mod: string) => {
    pp[mod] = {
      p: Promise.resolve(),
      get m() {
        return exports;
      },
    };
  };
  const exports = { Counter, InlineCounter };

  const decoder = new Decoder("__dec");
  // Threw "Missing reference @3." when the retry re-encoded fresh ids.
  await expect(decoder.preload("P0-2")).resolves.toBeUndefined();

  const tree = decoder.decode("P0-2") as VNode & {
    type: unknown;
    props: Record<string, any>;
  };
  expect(tree.type).toBe(InlineCounter);
  expect(tree.props.initialValue).toBeInstanceOf(Promise);
  await expect(tree.props.initialValue).resolves.toBe(1);

  // The shared object aliases across rows with identity.
  const islandA = decoder.decode("P0-0") as VNode & { props: Record<string, any> };
  expect(tree.props.shared).toBe(islandA.props.shared);
});

test("materializing a foreign row preserves the current frame's reference ids", () => {
  const bag = ((globalThis as Record<string, any>)["__dec"] ??= {});
  // Row a claims ids 0 (root), 1 (s), 2 (deep).
  (bag.d ??= {}).a = '{"s":{"deep":[1]}}\n';
  // Row b starts at base 3: root claims 3, and after resolving @1 into row a
  // it still must claim 4 for `second` — not collide with its own root.
  bag.d.b = '3|{"first":@1,"second":{"own":1}}\n';
  // Row c aliases row b's root via @3.
  bag.d.c = '5|{"alias":@3}\n';

  const decoder = new Decoder("__dec");
  const c = decoder.decode("c") as Record<string, any>;
  const b = c.alias;
  const a = decoder.decode("a") as Record<string, any>;

  expect(b.first).toBe(a.s);
  expect(b.first.deep).toEqual([1]);
  expect(b.second.own).toBe(1);
});

test("settlements may arrive before their placeholder", () => {
  // A settlement whose placeholder was never decoded is stashed, not an
  // error: stream chunks and row decode are unordered.
  const root = decodePayload("__dec", "m1", '{"a":1}\n9|!9+true\n') as { a: number };
  expect(root.a).toBe(1);
});

test("a stashed settlement resolves a later placeholder", async () => {
  const bag = ((globalThis as Record<string, any>)["__dec"] ??= {});
  const decoder = new Decoder("__dec");

  // Row r1 decodes normally, then receives a settlement for a promise
  // that no live decode has materialized yet (id 7 belongs to a future
  // row): pump must stash it instead of throwing.
  (bag.d ??= {})["r1"] = '0|{"a":1}\n';
  decoder.decode("r1");
  bag.d["r1"] += '5|!7+"early"\n';
  decoder.pump("r1");

  // Later row claims placeholder 7; the stashed frame must settle it.
  bag.d["r2"] = '3|{"v":p7}\n';
  const root = decoder.decode("r2") as { v: Promise<unknown> & { value?: unknown } };
  expect(root.v).toBeInstanceOf(Promise);
  await Promise.resolve();
  expect(root.v.value).toBe("early");
});

test("rejects malformed promise traffic", () => {
  expect(() => decodePayload("__dec", "m2", '{"a":1}garbage\n')).toThrow(/trailing/i);
});

test("flush + pump transport a late-settling promise end to end", async () => {
  const gate = new Promise<string>((resolve) => setTimeout(() => resolve("slow"), 5));

  const enc = new Encoder("__enc");
  const sb = run(enc.encode("r", { p: gate }));
  const stored = (sb.__enc as { d: Record<string, string> }).d;
  const bag = ((globalThis as Record<string, any>)["__dec"] ??= {});
  bag.d = { r: stored.r };

  const decoder = new Decoder("__dec");
  const root = decoder.decode("r") as { p: Promise<string> };

  // Evaluate each append chunk like a browser executing the inline script,
  // mirror the accumulated payload into the decode namespace, apply it.
  for await (const chunk of enc.flush("r")) {
    vm.runInNewContext(chunk, sb);
    bag.d.r = stored.r;
    decoder.pump("r");
  }

  await expect(root.p).resolves.toBe("slow");
});
