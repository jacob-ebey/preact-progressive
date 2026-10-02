import { useId } from "preact/hooks";
import { expect, test } from "vite-plus/test";

// @ts-ignore
import runtime from "virtual:client-runtime";
import { CLIENT_REFERENCE, renderToProgressiveStream } from "./server.ts";

test("can override client reference event", async () => {
  const clientReference = Object.assign(() => {}, {
    $type: CLIENT_REFERENCE,
    $mod: "/test.js",
    $name: "handler",
  });
  const stream = renderToProgressiveStream(<div onClick={clientReference} />);
  const html = await consumeStream(stream);
  expect(html).toBe(
    `<div></div><script>${runtime}document.currentScript.previousElementSibling.addEventListener("click",function(){return window.__pp?.["/test.js"]?.m?.["handler"](...arguments);});window.__pm("/test.js");document.currentScript?.remove();</script>`,
  );
});

test("serializes manually-bound args for client reference events", async () => {
  const clientReference = Object.assign(() => {}, {
    $type: CLIENT_REFERENCE,
    $mod: "/test.js",
    $name: "handler",
    $bound: ["event-counter"],
  });
  const stream = renderToProgressiveStream(<div onClick={clientReference} />);
  const html = await consumeStream(stream);
  expect(html).toBe(
    `<div></div><script>${runtime}document.currentScript.previousElementSibling.addEventListener("click",function(){return window.__pp?.["/test.js"]?.m?.["handler"]("event-counter",...arguments);});window.__pm("/test.js");document.currentScript?.remove();</script>`,
  );
});

test("evaluates bound event args back to live values", async () => {
  const nested = Object.assign(() => {}, {
    $type: CLIENT_REFERENCE,
    $mod: "/nested.js",
    $name: "other",
    $bound: [1],
  });
  const clientReference = Object.assign(() => {}, {
    $type: CLIENT_REFERENCE,
    $mod: "/test.js",
    $name: "handler",
    $bound: [
      "event-counter",
      42,
      undefined,
      NaN,
      Infinity,
      -0,
      10n,
      new Date("2024-01-02T03:04:05.000Z"),
      new Map([["k", [1, { deep: true }]]]),
      new Set(["a", "b"]),
      nested,
    ],
  });
  const stream = renderToProgressiveStream(<div onClick={clientReference} />);
  const html = await consumeStream(stream);

  const start = html.indexOf("document.currentScript.previousElementSibling.addEventListener");
  const end = html.indexOf("});", start) + "});".length;
  const script = html.slice(start, end);

  const listeners: [string, (...args: unknown[]) => unknown][] = [];
  const outerCalls: unknown[][] = [];
  const nestedCalls: unknown[][] = [];
  const documentFake = {
    currentScript: {
      previousElementSibling: {
        addEventListener: (name: string, fn: (...args: unknown[]) => unknown) => {
          listeners.push([name, fn]);
        },
      },
    },
  };
  const windowFake = {
    __pp: {
      "/test.js": {
        m: {
          handler: (...args: unknown[]) => {
            outerCalls.push(args);
          },
        },
      },
      "/nested.js": {
        m: {
          other: (...args: unknown[]) => {
            nestedCalls.push(args);
          },
        },
      },
    },
  };
  // oxlint-disable-next-line typescript/no-implied-eval
  new Function("document", "window", script)(documentFake, windowFake);

  expect(listeners).toHaveLength(1);
  expect(listeners[0]![0]).toBe("click");
  const event = { type: "click" };
  (listeners[0]![1] as (...args: unknown[]) => void)(event);

  expect(outerCalls).toHaveLength(1);
  const received = outerCalls[0]!;
  expect(received).toHaveLength(12);
  expect(received[0]).toBe("event-counter");
  expect(received[1]).toBe(42);
  expect(received[2]).toBeUndefined();
  expect(Number.isNaN(received[3])).toBe(true);
  expect(received[4]).toBe(Infinity);
  expect(Object.is(received[5], -0)).toBe(true);
  expect(received[6]).toBe(10n);
  expect(received[7]).toEqual(new Date("2024-01-02T03:04:05.000Z"));
  expect(received[8]).toEqual(new Map([["k", [1, { deep: true }]]]));
  expect(received[9]).toEqual(new Set(["a", "b"]));
  // Nested client references arrive as callables with their own bound prepended.
  const nestedFn = received[10] as (...args: unknown[]) => void;
  expect(typeof nestedFn).toBe("function");
  expect(received[11]).toBe(event);
  nestedFn("x");
  expect(nestedCalls).toEqual([[1, "x"]]);
});

test("escapes script-breaking bound strings", async () => {
  const clientReference = Object.assign(() => {}, {
    $type: CLIENT_REFERENCE,
    $mod: "/test.js",
    $name: "handler",
    $bound: ["</script><script>alert(1)</script>"],
  });
  const stream = renderToProgressiveStream(<div onClick={clientReference} />);
  const html = await consumeStream(stream);
  expect(html).toContain('"\\u003c/script>');
  expect(html).not.toContain("</script><script>alert(1)");
});

test("keeps __proto__ bound keys as own properties", async () => {
  // NB: an object literal would set the prototype, so build the input via
  // JSON.parse to get a real own "__proto__" key.
  const withProto = JSON.parse('{"__proto__":{"polluted":true},"ok":1}');
  const clientReference = Object.assign(() => {}, {
    $type: CLIENT_REFERENCE,
    $mod: "/test.js",
    $name: "handler",
    $bound: [withProto],
  });
  const stream = renderToProgressiveStream(<div onClick={clientReference} />);
  const html = await consumeStream(stream);
  expect(html).toContain('["__proto__"]:');

  const start = html.indexOf("document.currentScript.previousElementSibling.addEventListener");
  const end = html.indexOf("});", start) + "});".length;
  const script = html.slice(start, end);

  const listeners: [string, (...args: unknown[]) => unknown][] = [];
  const calls: unknown[][] = [];
  const documentFake = {
    currentScript: {
      previousElementSibling: {
        addEventListener: (name: string, fn: (...args: unknown[]) => unknown) => {
          listeners.push([name, fn]);
        },
      },
    },
  };
  const windowFake = {
    __pp: {
      "/test.js": {
        m: {
          handler: (...args: unknown[]) => {
            calls.push(args);
          },
        },
      },
    },
  };
  // oxlint-disable-next-line typescript/no-implied-eval
  new Function("document", "window", script)(documentFake, windowFake);
  (listeners[0]![1] as (...args: unknown[]) => void)({ type: "click" });

  const received = calls[0]![0] as Record<string, unknown>;
  expect(Object.getOwnPropertyDescriptor(received, "__proto__")?.value).toEqual({
    polluted: true,
  });
  expect(({} as Record<string, unknown>).polluted).toBeUndefined();
});

test("throws on unserializable bound event args", async () => {
  // NB: prerender mode surfaces render errors as a single rejection; the
  // streaming renderer duplicates them across internal branches.
  const render = (bound: unknown[]) => {
    const ref = Object.assign(() => {}, {
      $type: CLIENT_REFERENCE,
      $mod: "/test.js",
      $name: "handler",
      $bound: bound,
    });
    return consumeStream(renderToProgressiveStream(<div onClick={ref} />, { prerender: true }));
  };

  await expect(render([() => {}])).rejects.toThrow(/Cannot serialize a function/);
  await expect(render([Promise.resolve(1)])).rejects.toThrow(/Cannot serialize a promise/);

  const circular: Record<string, unknown> = {};
  circular.self = circular;
  await expect(render([circular])).rejects.toThrow(/circular/);
});

test("can wrap client reference component", async () => {
  const ClientComponent = Object.assign(
    () => {
      const id = useId();
      return <div>Hello, World {id}!</div>;
    },
    {
      $type: CLIENT_REFERENCE,
      $mod: "/test.js",
      $name: "ClientComponent",
    },
  );
  const stream = renderToProgressiveStream(<ClientComponent />);
  const html = await consumeStream(stream);
  expect(html).toBe(
    `<!--h:P0-0 [&quot;__pd&quot;,&quot;/test.js&quot;,&quot;ClientComponent&quot;]--><div>Hello, World P0-1!</div><script>${runtime}window.__pm("/test.js");globalThis["__pd"]??={};globalThis["__pd"].d??={};globalThis["__pd"].d["P0-0"]="P[v,P[R,\\"component\\",\\"/test.js\\",\\"ClientComponent\\"],null,{}]\\n";document.currentScript?.remove();</script><!--/h:P0-0-->`,
  );
});

async function consumeStream(stream: ReadableStream<Uint8Array>) {
  const chunks: string[] = [];
  await stream.pipeThrough(new TextDecoderStream() as TransformStream<Uint8Array, string>).pipeTo(
    new WritableStream({
      write(chunk) {
        chunks.push(chunk);
      },
    }),
  );
  return chunks.join("");
}
