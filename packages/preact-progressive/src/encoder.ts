import { Component, Fragment, options, type VNode } from "preact";
import "preact/hooks";
import { Suspense } from "preact/compat";

import {
  FRAGMENT_SENTINEL,
  PLUGIN_CLIENT_REFERENCE,
  PLUGIN_VNODE,
  SUSPENSE_SENTINEL,
  TAG_ARRAY_BUFFER,
  TAG_BIGINT,
  TAG_DATA_VIEW,
  TAG_DATE,
  TAG_ERROR,
  TAG_FALSE,
  TAG_INFINITY,
  TAG_MAP,
  TAG_NAN,
  TAG_NEGATIVE_INFINITY,
  TAG_NEGATIVE_ZERO,
  TAG_NULL,
  TAG_PLUGIN,
  TAG_PROMISE,
  TAG_REFERENCE,
  TAG_REGEXP,
  TAG_SET,
  TAG_SETTLED,
  TAG_SYMBOL,
  TAG_TRUE,
  TAG_UNDEFINED,
  TAG_URL,
  typedArrayTag,
} from "./shared.ts";

export type ClientReferenceKind = "component" | "function";

export type EncoderOptions = {
  isClientReference?: (v: unknown) => boolean;
  /**
   * Throw on VNode `ref`s instead of warning.
   *
   * @default false — false: warn+skip refs; true: throw
   */
  strictRefs?: boolean;
  /**
   * Warn on non-reference functions instead of throwing.
   *
   * @default true — true: throw on non-reference functions; false: warn+skip
   */
  strictFunctions?: boolean;
  /**
   * Controls Error redaction.
   *
   * @default true — redact Error name/message/stack before serializing.
   * Pass false to serialize as-is, or a string to use a custom redacted
   * message. `cause` is always serialized (recursively).
   */
  redactErrors?: boolean | string;
};

const PP_CLIENT_REFERENCE = Symbol.for("pp.client-reference");

/** Runtime shape of the component object hooks are invoked against. */
type HookedComponent = {
  __v?: VNode;
  _vnode?: VNode;
  __H?: unknown;
  __hooks?: unknown;
  __h?: unknown[];
  _renderCallbacks?: unknown[];
  __d?: boolean;
  context: unknown;
  props: Record<string, unknown>;
  setState: () => void;
  forceUpdate: () => void;
};

/** Minimal provider component that satisfies `useContext` during encoding. */
type ProviderComponent = {
  props: { value: unknown };
  sub: (component: unknown) => void;
};

type ContextEntry = { id: string; component: ProviderComponent };

/** Reads a context's runtime id (`__c` in dist builds, `_id` in source). */
function contextId(type: unknown): string | undefined {
  const t = type as { _id?: unknown; __c?: unknown };
  if (typeof t._id === "string") return t._id;
  if (typeof t.__c === "string") return t.__c;
  return undefined;
}

/** Reads a context's default value (`__` in dist builds, `_defaultValue` in source). */
function contextDefaultValue(type: unknown): unknown {
  const t = type as { _defaultValue?: unknown; __?: unknown };
  return "_defaultValue" in t ? t._defaultValue : t.__;
}

function isContextProvider(type: unknown): type is Function & { contextType?: unknown } {
  return (
    typeof type === "function" &&
    (type as { Provider?: unknown }).Provider === type &&
    contextId(type) !== undefined
  );
}

function defaultIsClientReference(v: unknown): boolean {
  return (
    typeof v === "function" &&
    "$type" in (v as object) &&
    (v as { $type?: unknown }).$type === PP_CLIENT_REFERENCE
  );
}

function isVNode(v: unknown): v is VNode {
  return typeof v === "object" && v !== null && "__v" in v && "type" in v && "props" in v;
}

function isPromiseLike(v: unknown): boolean {
  return (
    typeof v === "object" && v !== null && typeof (v as PromiseLike<unknown>).then === "function"
  );
}

/** A promise encountered while writing a frame, awaiting its settlement. */
type PendingPromise = {
  id: number;
  source: PromiseLike<unknown>;
  /** Outcome captured via microtask as soon as `source` settles. */
  settlement?: Settlement;
};

/** The outcome of one pending promise, ready to travel as a result frame. */
type Settlement = { ok: boolean; value: unknown };

/** Adopts a thenable into a settlement without ever throwing. */
function settlePromise(source: PromiseLike<unknown>): Promise<Settlement> {
  return Promise.resolve(source).then(
    (value) => ({ ok: true, value }),
    (value) => ({ ok: false, value }),
  );
}

/** Settles a batch of pending promises in parallel, preserving their order. */
async function settleBatch(
  batch: PendingPromise[],
): Promise<{ id: number; settlement: Settlement }[]> {
  return Promise.all(
    batch.map(async ({ id, source }) => ({ id, settlement: await settlePromise(source) })),
  );
}

/**
 * Document encoder: serializes values (including preact VNode trees and
 * client references) into rows stored on a global namespace, for inline
 * `<script>` transport during SSR.
 *
 * Unlike the previous generation of this encoder, the payload contains no
 * executable JavaScript — it is pure data that the `Decoder` parses back
 * into live values, so nothing on the wire can execute at hydration time.
 *
 * Each `encode` call produces one row stored under a name:
 *
 *   globalThis[ns]??={};globalThis[ns].d??={};
 *   globalThis[ns].d[name]="<payload>";
 *
 * Promises are transported as `p<id>` placeholders in that first payload;
 * once they settle, `flush(name)` yields follow-up chunks of JavaScript
 * that append `!<id>` result frames to the stored row (`+=`), which the
 * client applies via `Decoder.pump`.
 *
 * See `ValueWriter` for the frame format and `DataEncoder` for the stream
 * variant of this codec.
 *
 * Not representable in this format (and rejected or dropped):
 *   - non-reference functions outside component positions (throw unless
 *     strictFunctions=false)
 *   - VNode refs (warn unless strictRefs=true)
 *   - symbol-keyed properties (warn)
 *
 * Plain-function components (server components) are not shipped at all:
 * they render inline during encoding and only their output travels.
 *
 * ### Wire format
 *
 * The exact bytes on the wire, for debugging payloads and building
 * compatible tooling.
 *
 * #### Frames
 *
 * A payload holds one or more newline-terminated frames. The first frame
 * holds the root value, and later frames settle promises. A document row
 * script stores concatenated frames as a JS string with `<` escaped as
 * `\u003c`, while a data stream sends one frame per line.
 *
 * Frames whose first claimed reference id differs from `0` carry a
 * `<base>|` header, so rows decode independently and align lazily.
 * Reference ids run monotonic per writer. The first encounter of an
 * instance value claims the next id. Repeats emit `@<id>` while strings
 * stay inline. Only instances take references.
 *
 * #### Value tags
 *
 * Literals: `u` (undefined), `null`, `true`, `false`, `NaN`, `I`/`i`
 * (`±Infinity`), `z` (`-0`), `"..."` (JSON string), `<digits>` (number),
 * `b<int>` (bigint), `s"key"` (`Symbol.for(key)`).
 *
 * Instances, each claiming an id: `D"..."` (Date), `U"..."` (URL),
 * `r[src,flags]` (RegExp), `E{...}` (Error body), `A`/`o`/`C`/`L`/`l`/`G`/
 * `g`/`H`/`h`/`J`/`j`/`V` plus `"base64"` for `ArrayBuffer` / typed arrays /
 * `DataView`, `M[k,v,...]` for flat Map pairs, `S[v,...]` for Set, `[...]`
 * for arrays, `{...}` for objects.
 *
 * Async: `p<id>` (placeholder, claims `<id>`), `!<id>+<value>`
 * (fulfillment), `!<id>-<reason>` (rejection).
 *
 * Cycles and shared values: `@<id>` back-reference.
 *
 * #### Plugin tokens
 *
 * A client reference serializes as:
 *
 * ```
 * P["$R",<kind>,<mod>,<name>]
 * P["$R",<kind>,<mod>,<name>,[<bound...>]]   // with captured values
 * ```
 *
 * - `<kind>` reads `"component"` in a vnode type slot and `"function"`
 *   everywhere else.
 * - `<mod>` and `<name>` repeat the `$mod` and `$name` strings.
 * - The fifth field carries `$bound` values. It appears only with captures
 *   to send, and empty bindings keep the four-field form.
 *
 * A vnode serializes as:
 *
 * ```
 * P["$V",<type>,<key>,<props>]
 * ```
 *
 * - `<type>` is a DOM tag string, the `"$F"` Fragment sentinel, the `"$S"`
 *   Suspense sentinel, or a component-kind `$R` token. Plain function types
 *   (server components) render at encode time and replace themselves with
 *   output, so they never reach the wire.
 * - `<key>` reads `null` without a key.
 * - `<props>` is the serialized props object. `children` leaves the props
 *   and travels as an optional trailing field, so the wire never carries a
 *   `children` prop. Function-kind references inside props keep their shape,
 *   which means an `onClick` passed to a client component arrives as a `$R`
 *   token and reattaches at hydration.
 *
 * Rows store on a per-request namespace at `globalThis[ns].d[<id>]`.
 * Payloads write as JS string literals with `<` escaped as `\u003c`, so
 * they can never close their host `<script>` tag.
 *
 * Two details close out references. Reference-tracked values like objects
 * and arrays claim ids in encounter order. Repeats decode to one live
 * identity through `@<id>` tokens, while functions take no reference slots,
 * so each use site emits its own `$R` token. Promise props ship as `p<id>`
 * placeholders, and their settlements follow as frames (`!<id>+<value>`,
 * `!<id>-<reason>`) appended to the row in script chunks the client applies.
 *
 * #### Codec options
 *
 * Codec strictness is configurable. `strictRefs` throws on VNode `ref`s
 * instead of warning, and `strictFunctions` warns on non-reference functions
 * instead of throwing. `redactErrors` controls Error redaction. `false`
 * sends as-is, while a string becomes the redacted message. `cause` always
 * serializes.
 *
 * #### Reading a payload
 *
 * 1. Find the island script past the markers:
 *    `globalThis["__pd"].d["P0-0"] = "..."`.
 * 2. Unescape `\u003c` back to `<` and split on newlines. Line 1 is the
 *    root, and `!`-lines settle.
 * 3. `P["v",...]` nests like the vnode tree and `P["R",...]` names module
 *    and export. `p<N>` placeholders resolve from later `!N` frames in the
 *    same row (or follow-up script chunks running `row += frame; ns.f(row)`).
 */
export class Encoder {
  private readonly namespace: string;
  private readonly writer: ValueWriter;

  // Promises stashed by `encode`/`encodeVNode`, each bound to the row that
  // currently ships its placeholder; `flush(name)` settles that row's share.
  private readonly pendingQueue: (PendingPromise & { home: string })[] = [];

  /** Store code per already-written row name: a row is written at most once. */
  private readonly emittedRows = new Map<string, string>();

  /**
   * Frame payload per encoded VNode row, keyed by the vnode itself. A
   * Suspense boundary re-renders its client component after a thrown
   * promise and encodes the same vnode under a fresh row name (useId
   * advances across attempts) — the earlier attempt's script never ships.
   * Replaying the stored payload under the new name keeps every delivered
   * frame free of back-references into attempts whose output was discarded.
   */
  private readonly vnodePayloads = new WeakMap<object, string>();

  /** Promise id -> the vnode row that claimed its placeholder. */
  private readonly promiseOwners = new Map<number, object>();

  constructor(namespace: string, options: EncoderOptions = {}) {
    this.namespace = namespace;
    this.writer = new ValueWriter(options);
  }

  /**
   * Serialize a value under a given name.
   * Returns JavaScript code (or `<script>...</script>` if wrapInScript is
   * true) which stores the encoded payload string in the row namespace.
   */
  encode(name: string, value: unknown, wrapInScript = false): string {
    return this.emit(name, value, false, wrapInScript);
  }

  /**
   * Serialize a VNode (or VNode-shaped object) as the root of a row.
   */
  encodeVNode(
    name: string,
    vnode: VNode | { type: unknown; props: unknown; key?: unknown; ref?: unknown },
    wrapInScript = false,
  ): string {
    return this.emit(name, vnode, true, wrapInScript);
  }

  private emit(name: string, value: unknown, forceVNode: boolean, wrapInScript: boolean): string {
    // A row is written at most once. Renderers may attempt a frame whose
    // output never ships (a Suspense boundary re-rendering after a thrown
    // promise), and such an attempt still claims reference ids and stashes
    // promises. Re-encoding must replay the stored payload — under the same
    // name verbatim, or under a new name with settlements re-homed — since
    // writing a fresh frame would emit back-references into the discarded
    // payload and strand its promise placeholders.
    let payload = this.emittedRows.get(name);
    if (payload === undefined && forceVNode) {
      payload = this.vnodePayloads.get(value as object);
      if (payload !== undefined) {
        this.rehomePending(value as object, name);
        payload = this.appendSettledFrames(name, payload);
      }
    }
    if (payload === undefined) {
      payload = this.writer.frame(value, forceVNode);
      if (forceVNode) this.vnodePayloads.set(value as object, payload);
      this.stashPending(name, value);
      this.emittedRows.set(name, payload);
    }

    const nsPath = `globalThis[${JSON.stringify(this.namespace)}]`;
    const code =
      `${nsPath}??={};${nsPath}.d??={};` +
      `${nsPath}.d[${JSON.stringify(name)}]=${this.escapeScriptLiteral(JSON.stringify(payload))};`;
    return wrapInScript ? `<script>${code}document.currentScript?.remove();</script>` : code;
  }

  /**
   * Appends the result frames of any promises that settled since the row's
   * payload was first written, then returns the extended payload. A Suspense
   * boundary re-encodes this row only after its promise resolved, so the
   * retry's script ships self-contained: the client decodes the settlement
   * inline and hydration never races the settlement transport (which streams
   * as a separate chunk after the HTML). Delivered promises leave the queue,
   * so a later `flush` won't re-emit them.
   */
  private appendSettledFrames(name: string, payload: string): string {
    let out = payload;
    for (let i = 0; i < this.pendingQueue.length;) {
      const pending = this.pendingQueue[i]!;
      if (pending.home === name && pending.settlement !== undefined) {
        this.pendingQueue.splice(i, 1);
        out += this.writer.settledFrame(pending.id, pending.settlement);
        // Nested promises inside the settlement land on this row too, and
        // may themselves be settled enough to inline on a later pass.
        this.stashPending(name);
      } else {
        i++;
      }
    }
    return out;
  }

  /**
   * Await every promise encoded under `name` and yield one chunk per
   * settlement. Each chunk is JavaScript that appends a `!<id>` result
   * frame to the stored row payload; evaluate it as it arrives (e.g. flush
   * during SSR), then let `Decoder.pump` apply it client-side. Settlements
   * may contain further promises, which are flushed by subsequent chunks.
   *
   * With `wait = false` the generator yields only promises whose outcome is
   * already captured and returns otherwise — the caller drains repeatedly
   * (e.g. after each HTML chunk) so settlements stream as they're generated
   * instead of being held until the whole response is ready.
   */
  async *flush(
    name: string,
    wrapInScript = false,
    nonce?: string,
    wait = true,
  ): AsyncGenerator<string> {
    while (true) {
      const batch: (PendingPromise & { home: string })[] = [];
      for (let i = this.pendingQueue.length - 1; i >= 0; i--) {
        const pending = this.pendingQueue[i]!;
        if (pending.home !== name) continue;
        if (!wait && pending.settlement === undefined) continue;
        batch.unshift(this.pendingQueue.splice(i, 1)[0]!);
      }
      if (batch.length === 0) break;
      for (const { id, settlement } of await settleBatch(batch)) {
        const frame = this.writer.settledFrame(id, settlement);
        this.stashPending(name);
        yield this.appendFrame(name, frame, wrapInScript, nonce);
      }
    }
  }

  /** Moves promises claimed while writing the latest frame onto the queue. */
  private stashPending(name: string, owner?: unknown): void {
    const pending = this.writer.takePendingPromises();
    for (const pendingPromise of pending) {
      if (owner !== undefined && typeof owner === "object" && owner !== null) {
        this.promiseOwners.set(pendingPromise.id, owner);
      }
      const queued = { ...pendingPromise, home: name };
      this.pendingQueue.push(queued);
      this.captureSettlement(queued);
    }
  }

  /**
   * Records a pending promise's outcome as soon as it settles, so the row
   * can ship its result frame inline (see `appendSettledFrames`) or a
   * non-blocking flush can pick it up without waiting on the source.
   */
  private captureSettlement(pending: PendingPromise & { home: string }): void {
    Promise.resolve(pending.source).then(
      (value) => {
        pending.settlement = { ok: true, value };
      },
      (value) => {
        pending.settlement = { ok: false, value };
      },
    );
  }

  /**
   * Re-binds a replayed vnode row's promises to its new row name: only the
   * latest attempt ships the placeholder, so its settlements must append to
   * the payload that is actually delivered.
   */
  private rehomePending(owner: object, name: string): void {
    for (const pending of this.pendingQueue) {
      if (this.promiseOwners.get(pending.id) === owner) pending.home = name;
    }
  }

  /** Code appending a follow-up result frame to an already-stored row. */
  private appendFrame(name: string, frame: string, wrapInScript: boolean, nonce?: string): string {
    const nsPath = `globalThis[${JSON.stringify(this.namespace)}]`;
    // The trailing `f?.()` notifies listeners (see Decoder / client hydrate
    // runtime) that new frames landed, so placeholders decoded earlier are
    // pumped without waiting for a page event.
    const code =
      `${nsPath}.d[${JSON.stringify(name)}]+=${this.escapeScriptLiteral(JSON.stringify(frame))};` +
      `${nsPath}.f?.(${JSON.stringify(name)});`;
    if (!wrapInScript) return code;
    // Inline scripts only execute under CSP with a matching nonce.
    const attr = nonce === undefined ? "" : ` nonce=${JSON.stringify(nonce)}`;
    return `<script${attr}>${code}document.currentScript?.remove();</script>`;
  }

  /**
   * Escape `<` inside an emitted JS string literal so inline payloads can
   * never close their host `<script>` element (`</script>`) or open HTML
   * comments (`<!--`). `\u003c` is a valid escape inside the literal and
   * unescapes back to "<" at runtime.
   */
  private escapeScriptLiteral(literal: string): string {
    return literal.replace(/</g, "\\u003c");
  }
}

/**
 * Data encoder: the same codec as `Encoder`, without the namespace concept.
 * Each `encode` call writes one self-contained frame to its own
 * `ReadableStream<Uint8Array>` — reference ids start at 0 and never escape
 * the returned stream, so separate streams are independent worlds.
 *
 * This is the transport behind client navigation. One route serves two
 * representations, and the `Accept` header picks between them: full document
 * loads omit the header and get `renderToProgressiveStream` HTML, while
 * navigations send `Accept: text/x-component` and get a `DataEncoder`
 * stream served as `text/x-component; charset=UTF-8`.
 *
 * Document rows share one reference-id space with a namespace bag on
 * `globalThis`. Data streams work differently. Each `DataEncoder` call owns
 * a fresh writer with reference ids starting at 0. One self-contained root
 * frame leads, with settlement frames following for promises left
 * placeholder in the root. A promise that never settles holds its stream
 * open by design.
 */
export class DataEncoder {
  private readonly options: EncoderOptions;

  constructor(options: EncoderOptions = {}) {
    this.options = options;
  }

  /** Encode a value into a byte stream containing a single frame. */
  encode(value: unknown): ReadableStream<Uint8Array> {
    return this.emit(value, false);
  }

  /** Encode a VNode (or VNode-shaped object) into a byte stream. */
  encodeVNode(
    vnode: VNode | { type: unknown; props: unknown; key?: unknown },
  ): ReadableStream<Uint8Array> {
    return this.emit(vnode, true);
  }

  private emit(value: unknown, forceVNode: boolean): ReadableStream<Uint8Array> {
    // A fresh writer per call keeps every returned stream self-contained.
    const writer = new ValueWriter(this.options);
    const text = new TextEncoder();
    const bytes = text.encode(writer.frame(value, forceVNode));
    return new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(bytes);
      },
      async pull(controller) {
        // Result frames for settled promises (if any), then close. A
        // never-settling promise keeps the stream open by design.
        for await (const frame of writer.drain()) {
          controller.enqueue(text.encode(frame));
        }
        controller.close();
      },
    });
  }
}

/**
 * The value codec shared by `Encoder` and `DataEncoder`.
 *
 * A frame is a single newline-terminated line holding the root value,
 * encoded with the self-describing tags listed in `./shared.ts`:
 *
 *   VNode         -> P[v, type, key, props]  ("$F" Fragment,
 *                    "$S" Suspense; plain-function types render before
 *                    encoding, so only tags/sentinels and client
 *                    references appear as types). Children — when the
 *                    vnode has them — is a trailing `,children` field,
 *                    so the wire never carries a "children" prop.
 *   client ref    -> P[R, kind, mod, name]
 *   cycles/refs   -> @<id> back-reference
 *
 * Reference ids come from a monotonic counter paired with a WeakMap that
 * correlates instances to ids: the first time an instance value is
 * encountered it claims the next id, and every later encounter emits
 * `@<id>`. Strings are always inline — only instance values are
 * referenced. Shared state is therefore sent once and decodes to a single
 * live identity. When a writer spans multiple frames (Document rows), a
 * frame whose first claim is not id 0 carries a `<base>|` header so rows
 * can be decoded independently and aligned lazily.
 */
class ValueWriter {
  private readonly isClientReference: (v: unknown) => boolean;
  private readonly strictRefs: boolean;
  private readonly strictFunctions: boolean;
  private readonly redactErrors: boolean | string;

  // Instance-lifetime state: a monotonic reference counter plus an
  // instance-to-id correlation map, so reference equality holds across
  // every frame this writer produces.
  private refIndex: WeakMap<object, number>;
  private nextRefId: number;

  // Per-frame state
  private chunks: string[];

  // Promises claimed while writing frames, awaiting their result frames.
  private pendingPromises: PendingPromise[];

  // Context providers in scope while rendering server components inline.
  private contextStack: ContextEntry[] = [];

  // Context captured when a promise placeholder is claimed, so its settled
  // value renders with the same providers in scope.
  private promiseContexts = new Map<number, ContextEntry[]>();

  constructor(options: EncoderOptions = {}) {
    this.isClientReference = options.isClientReference ?? defaultIsClientReference;
    this.strictRefs = options.strictRefs ?? false;
    this.strictFunctions = options.strictFunctions ?? true;
    this.redactErrors = options.redactErrors ?? true;
    this.refIndex = new WeakMap();
    this.nextRefId = 0;
    this.chunks = [];
    this.pendingPromises = [];
  }

  /** Serialize a root value into a complete frame (trailing newline included). */
  frame(value: unknown, forceVNode = false): string {
    this.chunks = [];
    const base = this.nextRefId;

    this.write(value, "function", forceVNode);
    this.chunks.push("\n");

    const body = this.chunks.join("");
    // Frames that start past id 0 declare their base so decoders can align
    // their reference tables without reading every preceding frame first.
    return base === 0 ? body : `${base}|${body}`;
  }

  /** Claims and returns the promises stashed since the last call. */
  takePendingPromises(): PendingPromise[] {
    const taken = this.pendingPromises;
    this.pendingPromises = [];
    return taken;
  }

  /**
   * Frame delivering one settled promise: `!<id>+<value>` when fulfilled,
   * `!<id>-<reason>` when rejected (trailing newline included, base header
   * like any other frame). Values written here may claim further reference
   * ids — including new promise placeholders.
   */
  settledFrame(id: number, settlement: Settlement): string {
    const base = this.nextRefId;
    this.chunks = [TAG_SETTLED, String(id), settlement.ok ? "+" : "-"];

    // Re-enter the provider scope captured when the placeholder was claimed,
    // so a settled value that contains server components renders with the
    // same context it would have had synchronously.
    const previousStack = this.contextStack;
    this.contextStack = this.promiseContexts.get(id) ?? [];
    try {
      this.write(settlement.value, "function");
    } finally {
      this.contextStack = previousStack;
      this.promiseContexts.delete(id);
    }
    this.chunks.push("\n");

    const body = this.chunks.join("");
    return base === 0 ? body : `${base}|${body}`;
  }

  /**
   * Yields one settled frame per outstanding promise until none are left.
   * Each settlement is streamed as soon as its source settles, so
   * independent promises resolve independently instead of waiting for the
   * slowest member of a batch. Promises discovered inside a settlement join
   * the same queue and stream as they settle.
   */
  async *drain(): AsyncGenerator<string> {
    const pending = this.takePendingPromises();
    while (true) {
      pending.push(...this.takePendingPromises());
      if (pending.length === 0) break;

      const winner = await Promise.race(
        pending.map(async (entry) => ({
          entry,
          settlement: await settlePromise(entry.source),
        })),
      );

      const index = pending.indexOf(winner.entry);
      if (index !== -1) pending.splice(index, 1);
      yield this.settledFrame(winner.entry.id, winner.settlement);
    }
  }

  /** Serialize any value into the current chunk buffer. */
  private write(
    value: unknown,
    kind: ClientReferenceKind,
    forceVNode = false,
    skipKey?: string,
  ): void {
    if (value === undefined) {
      this.chunks.push(TAG_UNDEFINED);
      return;
    }
    if (value === null) {
      this.chunks.push(TAG_NULL);
      return;
    }

    switch (typeof value) {
      case "boolean":
        this.chunks.push(value ? TAG_TRUE : TAG_FALSE);
        return;
      case "string":
        this.chunks.push(JSON.stringify(value));
        return;
      case "number":
        this.writeNumber(value);
        return;
      case "bigint":
        this.chunks.push(TAG_BIGINT, value.toString());
        return;
      case "symbol":
        this.writeSymbol(value);
        return;
      case "function":
        this.writeFunction(value, kind);
        return;
    }

    this.writeObject(value, forceVNode, skipKey);
  }

  private writeNumber(value: number): void {
    if (Number.isNaN(value)) {
      this.chunks.push(TAG_NAN);
    } else if (value === Infinity) {
      this.chunks.push(TAG_INFINITY);
    } else if (value === -Infinity) {
      this.chunks.push(TAG_NEGATIVE_INFINITY);
    } else if (Object.is(value, -0)) {
      this.chunks.push(TAG_NEGATIVE_ZERO);
    } else {
      this.chunks.push(String(value));
    }
  }

  private writeSymbol(value: symbol): void {
    const key = Symbol.keyFor(value);
    if (key === undefined) {
      throw new Error(
        `Cannot serialize symbol "${String(value)}". Only Symbol.for() symbols are supported.`,
      );
    }
    this.chunks.push(TAG_SYMBOL, JSON.stringify(key));
  }

  private writeFunction(value: unknown, kind: ClientReferenceKind): void {
    if (this.isClientReference(value)) {
      this.writeClientReference(value, kind);
      return;
    }
    this.handleFunction(value);
    this.chunks.push(TAG_UNDEFINED);
  }

  private writeClientReference(value: unknown, kind: ClientReferenceKind): void {
    const ref = value as { $mod?: unknown; $name?: unknown; $bound?: unknown };
    if (typeof ref.$mod !== "string" || typeof ref.$name !== "string") {
      throw new Error("Client reference is missing $mod or $name.");
    }
    this.chunks.push(TAG_PLUGIN, "[", PLUGIN_CLIENT_REFERENCE, ",");
    this.chunks.push(
      JSON.stringify(kind),
      ",",
      JSON.stringify(ref.$mod),
      ",",
      JSON.stringify(ref.$name),
    );
    // Bound scope values captured by the server transform are transmitted as
    // the reference's fifth field; empty bindings keep the legacy 4-field form.
    if (Array.isArray(ref.$bound) && ref.$bound.length > 0) {
      this.chunks.push(",");
      this.write(ref.$bound, "function");
    }
    this.chunks.push("]");
  }

  private writeVNode(vnode: VNode): void {
    // Server components: plain functions in the component-kind type slot are
    // rendered eagerly with their props, and their output replaces the
    // element entirely — only client references survive as types on the
    // wire. A returned promise rides the placeholder machinery like any
    // other async value. (Type is widened: compat Suspense does not overlap
    // the VNode["type"] typings but is a legitimate runtime value.)
    const Type: unknown = vnode.type;
    if (
      typeof Type === "function" &&
      Type !== Fragment &&
      Type !== Suspense &&
      !this.isClientReference(Type)
    ) {
      // Context providers do not travel as elements: their children render
      // inline with the provided value in scope, matching how server
      // components are resolved to their output during encoding.
      if (isContextProvider(Type)) {
        const provider: ProviderComponent = {
          props: { value: (vnode.props as { value?: unknown }).value },
          sub() {},
        };
        this.contextStack.push({ id: contextId(Type)!, component: provider });
        try {
          this.write((vnode.props as { children?: unknown }).children, "function");
        } finally {
          this.contextStack.pop();
        }
        return;
      }

      // memo() wrappers assign to `this` when invoked, so calling one bare
      // corrupts state or crashes; render their wrapped component instead —
      // memoization cannot cross the wire anyway.
      const wrapped = (Type as { type?: unknown }).type;
      if (typeof wrapped === "function") {
        this.write(
          { type: wrapped, props: vnode.props, key: vnode.key } as VNode,
          "function",
          true,
        );
        return;
      }

      if (Type.prototype && typeof Type.prototype.render == "function") {
        this.write(
          new (Type as { new (props: any): Component })(vnode.props).render(vnode.props),
          "function",
        );
      } else {
        this.write(this.renderFunctionComponent(vnode), "function");
      }
      return;
    }

    this.chunks.push(TAG_PLUGIN, "[", PLUGIN_VNODE, ",");

    // type ("component"-kind slot for client references)
    if (vnode.type === Fragment) {
      this.chunks.push(JSON.stringify(FRAGMENT_SENTINEL));
    } else if ((vnode.type as unknown) === Suspense) {
      this.chunks.push(JSON.stringify(SUSPENSE_SENTINEL));
    } else {
      this.write(vnode.type, "component");
    }
    this.chunks.push(",");

    // key ("" normalizes to null)
    if (vnode.key === undefined || vnode.key === null || vnode.key === "") {
      this.chunks.push(TAG_NULL);
    } else {
      this.write(vnode.key, "function");
    }
    this.chunks.push(",");

    // props — with `children` extracted into a trailing field so the
    // wire never carries the "children" key. Only emitted when present;
    // children-less vnodes keep the 4-field form.
    const props = vnode.props as { children?: unknown };
    this.write(props, "function", false, "children");
    if ("children" in props) {
      this.chunks.push(",");
      this.write(props.children, "function");
    }

    // ref (skipped — re-attached during hydration)
    this.handleRef(vnode.ref);

    this.chunks.push("]");
  }

  /** Builds the context map visible to the component currently rendering. */
  private currentContext(): Record<string, ProviderComponent> {
    const context: Record<string, ProviderComponent> = {};
    for (const entry of this.contextStack) context[entry.id] = entry.component;
    return context;
  }

  /** Creates the minimal component instance preact hooks are invoked against. */
  private createHookComponent(vnode: VNode, context: unknown): HookedComponent {
    const component = {
      context,
      props: vnode.props as Record<string, unknown>,
      setState() {
        (this as HookedComponent).__d = true;
      },
      forceUpdate() {
        (this as HookedComponent).__d = true;
      },
      __d: true,
      __h: [] as unknown[],
      _renderCallbacks: [] as unknown[],
    } as HookedComponent;
    component.__v = vnode;
    component._vnode = vnode;
    return component;
  }

  private setDirty(component: HookedComponent): void {
    component.__d = true;
  }

  private unsetDirty(component: HookedComponent): void {
    component.__d = false;
  }

  private isDirty(component: HookedComponent): boolean {
    return component.__d === true;
  }

  /**
   * Renders a function component with preact's hook runtime active, so hooks
   * (`useState`, `useContext`, `useMemo`, ...) work exactly as they do during
   * SSR. Mirrors preact-render-to-string's component invocation: a transient
   * component object is attached to the vnode, the hook render hook establishes
   * the hook state, effects are skipped, and `options.diffed`/`options.unmount`
   * clean it up afterwards.
   */
  private renderFunctionComponent(vnode: VNode): unknown {
    const Type = vnode.type as Function & {
      contextType?: unknown;
    };
    const context = this.currentContext();

    // Resolve contextType like preact's diff does: a declared context wins,
    // otherwise the full context map is passed (which `useContext` reads).
    let cctx: unknown = context;
    const contextType = Type.contextType;
    if (contextType != null) {
      const id = contextId(contextType);
      const provider = typeof id === "string" ? context[id] : undefined;
      cctx = provider ? provider.props.value : contextDefaultValue(contextType);
    }

    const component = this.createHookComponent(vnode, cctx);
    (vnode as { __c?: unknown; _component?: unknown }).__c = component;
    (vnode as { __c?: unknown; _component?: unknown })._component = component;

    let rendered: unknown;
    const opts = options as unknown as {
      __s?: boolean;
      _skipEffects?: boolean;
      __r?: (vnode: VNode) => void;
      _render?: (vnode: VNode) => void;
    };
    const previousSkipEffects = opts.__s;
    const previousSourceSkipEffects = opts._skipEffects;
    opts.__s = true;
    opts._skipEffects = true;
    try {
      let count = 0;
      this.setDirty(component);
      const renderHook = opts.__r ?? opts._render;
      while (this.isDirty(component) && count++ < 25) {
        this.unsetDirty(component);
        renderHook?.(vnode);
        rendered = (Type as (props: unknown, ctx: unknown) => unknown).call(
          component,
          vnode.props,
          cctx,
        );
      }
      this.setDirty(component);

      (options as unknown as { diffed?: (vnode: VNode) => void }).diffed?.(vnode);
      (options as unknown as { unmount?: (vnode: VNode) => void }).unmount?.(vnode);
    } finally {
      opts.__s = previousSkipEffects;
      opts._skipEffects = previousSourceSkipEffects;
    }

    return rendered;
  }

  private writeObject(value: object, forceVNode: boolean, skipKey?: string): void {
    // Repeated values (and cycles, since ids are claimed before children are
    // written) become back-references. Instances claimed in earlier rows of
    // this Encoder resolve to the same live object on the client.
    const cached = this.refIndex.get(value);
    if (cached !== undefined) {
      this.chunks.push(TAG_REFERENCE, String(cached));
      return;
    }

    if (forceVNode || isVNode(value)) {
      this.writeVNode(value as VNode);
      return;
    }

    if (isPromiseLike(value)) {
      // Promises travel as placeholders: the reference slot is claimed
      // up-front (repeats and cycles alias to it) and the settled value is
      // delivered later as a `!<id>` result frame — see settledFrame.
      const id = this.nextRefId++;
      this.refIndex.set(value, id);
      this.pendingPromises.push({ id, source: value as PromiseLike<unknown> });
      this.promiseContexts.set(id, this.contextStack.slice());
      this.chunks.push(TAG_PROMISE, String(id));
      return;
    }

    // Claim the reference id up-front so children may point back here.
    const id = this.nextRefId++;
    this.refIndex.set(value, id);

    // Built-ins first (several of them, like Date, define toJSON).
    if (value instanceof Date) {
      // Invalid dates stringify to null on the wire and decode back invalid.
      const json = value.toJSON() as string | null;
      this.chunks.push(TAG_DATE, '"', json ?? "null", '"');
    } else if (value instanceof RegExp) {
      this.chunks.push(TAG_REGEXP, JSON.stringify([value.source, value.flags]));
    } else if (value instanceof URL) {
      this.chunks.push(TAG_URL, JSON.stringify(value.href));
    } else if (value instanceof Error) {
      this.chunks.push(TAG_ERROR);
      this.writeObjectBody(this.prepareError(value));
    } else if (value instanceof ArrayBuffer) {
      this.chunks.push(TAG_ARRAY_BUFFER);
      this.writeBase64(new Uint8Array(value));
    } else if (value instanceof DataView) {
      this.chunks.push(TAG_DATA_VIEW);
      this.writeBase64(new Uint8Array(value.buffer, value.byteOffset, value.byteLength));
    } else if (ArrayBuffer.isView(value)) {
      const tag = typedArrayTag(value);
      if (tag === undefined) {
        throw new Error(`Cannot serialize view of unsupported type ${value.constructor.name}.`);
      }
      this.chunks.push(tag);
      this.writeBase64(new Uint8Array(value.buffer, value.byteOffset, value.byteLength));
    } else if (value instanceof Map) {
      this.chunks.push(TAG_MAP, "[");
      let i = 0;
      for (const [entryKey, entryValue] of value) {
        if (i++ > 0) this.chunks.push(",");
        this.write(entryKey, "function");
        this.chunks.push(",");
        this.write(entryValue, "function");
      }
      this.chunks.push("]");
    } else if (value instanceof Set) {
      this.chunks.push(TAG_SET, "[");
      let i = 0;
      for (const entryValue of value.values()) {
        if (i++ > 0) this.chunks.push(",");
        this.write(entryValue, "function");
      }
      this.chunks.push("]");
    } else if (Array.isArray(value)) {
      this.writeArrayItems(value);
    } else if (typeof (value as Iterable<unknown>)[Symbol.iterator] === "function") {
      // Other iterables (arguments, generators, ...) travel as arrays.
      this.writeArrayItems(Array.from(value as Iterable<unknown>));
    } else if (typeof (value as { toJSON?: unknown }).toJSON === "function") {
      // Plain-ish objects with a toJSON hook travel as their result. Checked
      // after the built-ins above because several of them define toJSON.
      // The replacement is not registered, so it never becomes a reference
      // target — matching how the decoder skips an id for it entirely.
      const replacement = (value as { toJSON: () => unknown }).toJSON();
      // Undo the claim above: neither side consumes a reference slot here.
      this.refIndex.delete(value);
      this.nextRefId--;
      this.write(replacement, "function");
    } else {
      this.chunks.push("{");
      this.writeEntries(value, skipKey);
      this.chunks.push("}");
    }
  }

  /** Emit `[e0,e1,...]`; holes become explicit undefined tokens. */
  private writeArrayItems(items: ArrayLike<unknown>): void {
    this.chunks.push("[");
    for (let i = 0; i < items.length; i++) {
      if (i > 0) this.chunks.push(",");
      this.write(items[i], "function");
    }
    this.chunks.push("]");
  }

  /**
   * Emit `{...}` including braces from enumerable string-keyed properties.
   * Symbol-keyed properties cannot be represented in object bodies and are
   * dropped with a warning.
   */
  private writeObjectBody(obj: object): void {
    this.chunks.push("{");
    this.writeEntries(obj);
    this.chunks.push("}");
  }

  private writeEntries(obj: object, skipKey?: string): void {
    let i = 0;
    for (const [key, propValue] of Object.entries(obj)) {
      if (key === skipKey) continue;
      if (i++ > 0) this.chunks.push(",");
      // Keys travel inline like any other string.
      this.chunks.push(JSON.stringify(key), ":");
      this.write(propValue, "function");
    }
    const symbols = Object.getOwnPropertySymbols(obj);
    if (symbols.length > 0) {
      console.warn("Skipping symbol-keyed properties during serialization.");
    }
  }

  private prepareError(error: Error): Record<string, unknown> {
    const shouldRedact = this.redactErrors === true || typeof this.redactErrors === "string";
    const redacted = typeof this.redactErrors === "string" ? this.redactErrors : "<redacted>";
    return {
      name: shouldRedact ? "Error" : error.name,
      message: shouldRedact ? redacted : error.message,
      stack: shouldRedact ? undefined : error.stack,
      cause: error.cause,
    };
  }

  /** Base64-encode a byte view into a quoted JSON-free token. */
  private writeBase64(view: Uint8Array): void {
    this.chunks.push('"');
    const chunkSize = 65535 - (65535 % 3);
    for (let i = 0; i < view.length; i += chunkSize) {
      const sub = view.subarray(i, i + chunkSize);
      let binary = "";
      for (let j = 0; j < sub.length; j += 8192) {
        binary += String.fromCharCode.apply(null, sub.subarray(j, j + 8192) as unknown as number[]);
      }
      this.chunks.push(btoa(binary));
    }
    this.chunks.push('"');
  }

  private handleFunction(value: unknown): void {
    if (this.strictFunctions) {
      throw new Error(
        `Cannot serialize a function across the wire. Move it behind a "use client" boundary. (got ${(value as { name?: string }).name ?? "<anonymous>"})`,
      );
    }
    console.warn("Skipping function value during serialization.");
  }

  private handleRef(ref: unknown): void {
    if (ref == null) return;
    if (this.strictRefs) {
      throw new Error(
        "Cannot serialize a VNode ref across the wire. Refs are re-attached during hydration.",
      );
    }
    console.warn("Skipping VNode ref during serialization.");
  }
}
