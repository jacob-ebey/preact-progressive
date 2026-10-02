import { Fragment, h, type VNode } from "preact";
import { Suspense } from "preact/compat";
import { afterEach, expect, test } from "vite-plus/test";

import { DataEncoder } from "./encoder.ts";
import { DataDecoder } from "./decoder.ts";

type ModuleRegistry = Record<string, { p: Promise<unknown>; m?: Record<string, unknown> }>;

const PP_CLIENT_REFERENCE = Symbol.for("pp.client-reference");

function clientRef(mod: string, name = "A") {
  return Object.assign(() => {}, {
    $type: PP_CLIENT_REFERENCE,
    $mod: mod,
    $name: name,
  });
}

async function roundtrip(value: unknown): Promise<unknown> {
  const stream = new DataEncoder().encode(value);
  expect(stream).toBeInstanceOf(ReadableStream);
  return new DataDecoder().decode(stream);
}

/** Reads a byte stream back to text (test helper; consumes the stream). */
async function frameOf(stream: ReadableStream<Uint8Array>): Promise<string> {
  const chunks: Uint8Array[] = [];
  const reader = stream.getReader();
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
  }
  const total = chunks.reduce((n, c) => n + c.length, 0);
  const all = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    all.set(chunk, offset);
    offset += chunk.length;
  }
  return new TextDecoder().decode(all);
}

function setModules(mods: ModuleRegistry) {
  (globalThis as Record<string, unknown>).__pp = mods;
}

afterEach(() => {
  delete (globalThis as Record<string, unknown>).__pp;
});

test("encodes a single self-contained UTF-8 frame per stream", async () => {
  const stream = new DataEncoder().encode({ s: "hi", n: 42 });
  expect(await frameOf(stream)).toBe('{"s":"hi","n":42}\n');

  // VNode roots use the $V plugin like the document encoder.
  const vnodeStream = new DataEncoder().encodeVNode(h("div", { id: "root" }, "x"));
  expect(await frameOf(vnodeStream)).toBe('P[v,"div",null,{"id":"root"},"x"]\n');
});

test("roundtrips primitives and built-in types", async () => {
  const result = (await roundtrip({
    s: "hi",
    nan: NaN,
    inf: Infinity,
    ninf: -Infinity,
    negZero: -0,
    bi: 9007199254740993n,
    u: undefined,
    nil: null,
    sym: Symbol.for("pp.test.known"),
    date: new Date("2024-01-02T03:04:05.000Z"),
    invalidDate: new Date("not-a-date"),
    re: /ab+c/gi,
    url: new URL("https://example.com/x"),
    map: new Map<unknown, unknown>([["k", [1, 2]]]),
    set: new Set([1, "two"]),
    bytes: new Uint8Array([1, 2, 3]),
    dv: new DataView(new Uint8Array([1, 2, 3]).buffer),
    bigI64: new BigInt64Array([1n]),
  })) as Record<string, any>;

  expect(result.s).toBe("hi");
  expect(Number.isNaN(result.nan)).toBe(true);
  expect(result.inf).toBe(Infinity);
  expect(result.ninf).toBe(-Infinity);
  expect(Object.is(result.negZero, -0)).toBe(true);
  expect(result.bi).toBe(9007199254740993n);
  expect("u" in result && result.u === undefined).toBe(true);
  expect(result.nil).toBe(null);
  expect(result.sym).toBe(Symbol.for("pp.test.known"));
  expect(result.date).toBeInstanceOf(Date);
  expect(result.date.getTime()).toBe(new Date("2024-01-02T03:04:05.000Z").getTime());
  expect(Number.isNaN(result.invalidDate.getTime())).toBe(true);
  expect(result.re).toEqual(/ab+c/gi);
  expect(result.url).toBeInstanceOf(URL);
  expect(result.map).toBeInstanceOf(Map);
  expect([...result.map.get("k")]).toEqual([1, 2]);
  expect([...result.set]).toEqual([1, "two"]);
  expect(Array.from(result.bytes)).toEqual([1, 2, 3]);
  expect(Array.from(new Uint8Array(result.dv.buffer))).toEqual([1, 2, 3]);
  expect(Array.from(result.bigI64)).toEqual([1n]);
});

test("preserves identity for cycles and shared values", async () => {
  const obj: Record<string, unknown> = { name: "cycle" };
  obj.self = obj;
  const shared = { tag: "shared" };
  const result = (await roundtrip({ cycle: obj, list: [shared, shared] })) as Record<string, any>;

  expect(result.cycle.self).toBe(result.cycle);
  expect(result.list[0]).toBe(result.list[1]);
});

test("roundtrips VNode trees including fragments and client references", async () => {
  const Counter = function Counter() {};
  setModules({ "/m.js": { p: Promise.resolve(), m: { Counter } } });

  const tree = (await roundtrip(
    h("div", { id: "root" }, h(Fragment, null, "a"), h(clientRef("/m.js", "Counter") as never, {})),
  )) as VNode;

  expect(tree.type).toBe("div");
  const children = tree.props.children as VNode[];
  expect(children[0].type).toBe(Fragment);
  expect(children[1].type).toBe(Counter);
});

test("roundtrips Suspense boundaries back to preact/compat Suspense", async () => {
  const tree = (await roundtrip(
    h(Suspense, { fallback: h("p", null, "..."), children: h("div", null, "x") }),
  )) as VNode;

  expect(tree.type).toBe(Suspense);
  const props = tree.props as Record<string, VNode>;
  expect(props.fallback.type).toBe("p");
  expect(props.children.type).toBe("div");
});

test("resolves pending component references as lazy components", async () => {
  setModules({ "/pending.js": { p: new Promise(() => {}) } }); // no exports yet
  const tree = (await roundtrip(h(clientRef("/pending.js", "Counter") as never, {}))) as VNode & {
    type: { displayName?: string };
  };
  expect(typeof tree.type).toBe("function");
  expect(tree.type.displayName).toBe("Lazy");
});

test("self-imported client references register their module exports", async () => {
  const mod = `data:text/javascript,${encodeURIComponent("export const Counter = function Counter(){}")}`;
  const vnode = h(clientRef(mod, "Counter") as never, {});

  const first = (await roundtrip(vnode)) as VNode & {
    type: { name?: string; displayName?: string };
  };
  // Before the import settles, the component decodes to a lazy wrapper.
  expect(first.type.displayName).toBe("Lazy");

  // Wait for the import kicked off by resolveClientReference, then decode
  // again: the resolved export should now be returned directly.
  const pp = (globalThis as Record<string, unknown>).__pp as Record<
    string,
    { p: Promise<unknown>; m?: Record<string, unknown> }
  >;
  await pp[mod].p;

  const second = (await roundtrip(vnode)) as VNode & { type: { name?: string } };
  expect(second.type.name).toBe("Counter");
});

test("decodes function-kind references into callables", async () => {
  setModules({
    "/m.js": { p: Promise.resolve(), m: { add: (a: number, b: number) => a + b } },
  });
  const result = (await roundtrip({ cb: clientRef("/m.js", "add") })) as {
    cb: (a: number, b: number) => number;
  };
  expect(result.cb(20, 22)).toBe(42);
});

test("DataDecoder resolves references through a custom loadModule", async () => {
  const Counter = function Counter() {};
  const stream = new DataEncoder().encode(h(clientRef("/custom.js", "Counter") as never, {}));
  const decoder = new DataDecoder({
    loadModule: (_mod, name) => (name === "Counter" ? Counter : undefined),
  });
  const tree = (await decoder.decode(stream)) as VNode;
  expect(tree.type).toBe(Counter);
});

test("redacts errors by default", async () => {
  const result = (await roundtrip(new TypeError("boom"))) as Error;
  expect(result).toBeInstanceOf(Error);
  expect(result.name).toBe("Error");
  expect(result.message).toBe("<redacted>");
});

test("each encode call yields an independent, fully decodable stream", async () => {
  const encoder = new DataEncoder();
  const shared = { tag: "shared" };

  // The same instance can encode twice; neither stream references the other.
  const first = await frameOf(encoder.encode(shared));
  const second = await frameOf(encoder.encode([shared]));
  expect(first).toBe('{"tag":"shared"}\n');
  expect(second).toBe('[{"tag":"shared"}]\n');

  const decoder = new DataDecoder();
  const a = (await decoder.decode(bytes(first))) as Record<string, unknown>;
  const b = (await decoder.decode(bytes(second))) as unknown[];
  expect(a.tag).toBe("shared");
  expect(b[0]).toEqual({ tag: "shared" });
});

test("emits a result frame per promise and closes the stream", async () => {
  const stream = new DataEncoder().encode({ p: Promise.resolve(42) });
  expect(await frameOf(stream)).toBe('{"p":p1}\n2|!1+42\n');

  // Rejections travel as `-` frames carrying the (redacted) reason.
  const rejected = await frameOf(
    new DataEncoder().encode({ p: Promise.reject(new TypeError("x")) }),
  );
  expect(rejected).toBe(
    '{"p":p1}\n2|!1-E{"name":"Error","message":"<redacted>","stack":u,"cause":u}\n',
  );
});

test("streams settlement frames as each promise settles, not in a batch", async () => {
  let resolveFast!: (v: string) => void;
  let resolveSlow!: (v: string) => void;
  const fast = new Promise<string>((resolve) => (resolveFast = resolve));
  const slow = new Promise<string>((resolve) => (resolveSlow = resolve));

  const stream = new DataEncoder().encode({ fast, slow });
  const reader = stream.getReader();
  const decoder = new TextDecoder();

  const root = await reader.read();
  expect(root.done).toBe(false);
  expect(decoder.decode(root.value!)).toBe('{"fast":p1,"slow":p2}\n');

  // The fast promise settles first; its frame must arrive before the slow
  // promise has settled.
  resolveFast("fast");
  const fastFrame = await reader.read();
  expect(fastFrame.done).toBe(false);
  expect(decoder.decode(fastFrame.value!)).toContain('!1+"fast"');

  resolveSlow("slow");
  const slowFrame = await reader.read();
  expect(slowFrame.done).toBe(false);
  expect(decoder.decode(slowFrame.value!)).toContain('!2+"slow"');

  const done = await reader.read();
  expect(done.done).toBe(true);
});

test("roundtrips fulfilled, rejected, and nested promises", async () => {
  const result = (await roundtrip({
    ok: Promise.resolve({ deep: [1] }),
    nope: Promise.reject(new TypeError("boom")),
    outer: Promise.resolve(Promise.resolve("flattened")),
    list: [Promise.resolve("in-array"), "plain"],
    insideMap: new Map<unknown, unknown>([["p", Promise.resolve("in-map")]]),
  })) as Record<string, any>;

  expect(result.ok).toBeInstanceOf(Promise);
  expect(await result.ok).toEqual({ deep: [1] });

  await expect(result.nope).rejects.toThrow("<redacted>");
  // Native promises flatten resolutions-with-promises.
  await expect(result.outer).resolves.toBe("flattened");
  const list = result.list as unknown[];
  await expect(list[0]).resolves.toBe("in-array");
  expect(list[1]).toBe("plain");
  await expect((result.insideMap as Map<string, unknown>).get("p")).resolves.toBe("in-map");
});

test("preserves identity for the same promise encoded twice", async () => {
  const shared = Promise.resolve("same");
  const result = (await roundtrip({ a: shared, b: shared })) as Record<string, Promise<string>>;
  expect(result.a).toBe(result.b);
  await expect(result.a).resolves.toBe("same");
});

test("keeps the stream open until late-settling promises resolve", async () => {
  let release!: (v: string) => void;
  const gate = new Promise<string>((resolve) => (release = resolve));
  setTimeout(() => release("late"), 5);

  const result = (await roundtrip({ p: gate })) as { p: Promise<string> };
  await expect(result.p).resolves.toBe("late");
});

test("delivers the root frame through onValue before the stream closes", async () => {
  const encoder = new TextEncoder();
  const frames = ['{"p":p1}\n', '2|!1+{"a":1,"self":@2}\n'];

  let release!: () => void;
  const gate = new Promise<void>((resolve) => (release = resolve));
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      controller.enqueue(encoder.encode(frames[0]));
      await gate;
      controller.enqueue(encoder.encode(frames[1]));
      controller.close();
    },
  });

  const decoder = new DataDecoder();
  const seen: unknown[] = [];
  let markSeen!: () => void;
  const rootSeen = new Promise<void>((resolve) => (markSeen = resolve));

  const decoding = decoder.decode(stream, (value) => {
    seen.push(value);
    markSeen();
  });

  await rootSeen;
  expect(seen.length).toBe(1);

  release();
  const root = (await decoding) as { p: Promise<{ a: number; self: unknown }> };
  expect(root).toBe(seen[0]);
  const settled = await root.p;
  expect(settled.a).toBe(1);
  expect(settled.self).toBe(settled);
});

/** Builds a byte stream from text, independent of DataEncoder. */
function bytes(text: string): ReadableStream<Uint8Array> {
  return new Blob([text]).stream() as unknown as ReadableStream<Uint8Array>;
}

test("rejects empty streams and trailing content", async () => {
  const decoder = new DataDecoder();
  await expect(decoder.decode(bytes(""))).rejects.toThrow(SyntaxError);
  await expect(decoder.decode(bytes('42\n"garbage"\n'))).rejects.toThrow(SyntaxError);
});
