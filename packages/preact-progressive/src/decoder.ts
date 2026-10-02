import { Fragment, h } from "preact";
import { Suspense, lazy } from "preact/compat";

import type { ClientReferenceKind } from "./encoder.ts";
import {
  FRAGMENT_SENTINEL,
  PLUGIN_CLIENT_REFERENCE,
  PLUGIN_VNODE,
  SUSPENSE_SENTINEL,
  TAG_ARRAY_BUFFER,
  TAG_BIG_INT_64_ARRAY,
  TAG_BIG_UINT_64_ARRAY,
  TAG_DATA_VIEW,
  TAG_DATE,
  TAG_ERROR,
  TAG_FLOAT_32_ARRAY,
  TAG_FLOAT_64_ARRAY,
  TAG_INT_16_ARRAY,
  TAG_INT_32_ARRAY,
  TAG_INT_8_ARRAY,
  TAG_MAP,
  TAG_PLUGIN,
  TAG_PROMISE,
  TAG_REFERENCE,
  TAG_REGEXP,
  TAG_SET,
  TAG_SETTLED,
  TAG_SYMBOL,
  TAG_UINT_16_ARRAY,
  TAG_UINT_32_ARRAY,
  TAG_UINT_8_ARRAY,
  TAG_UINT_8_ARRAY_CLAMPED,
  TAG_URL,
} from "./shared.ts";

/**
 * Shared per-namespace decode state, stored on the namespace bag itself
 * (`globalThis[ns]`) so it lives and dies with the row data and is visible
 * to every `Decoder` instance — the client creates one per island.
 *
 * `refs` is an array of materialized instances indexed by reference id: the
 * encoder claims ids monotonically across all rows it writes, and decoding
 * a row fills the array at exactly those indices. Reference equality is
 * therefore preserved within rows, across rows, and across islands.
 */
type NamespaceBag = {
  d?: Record<string, string>;
  refs?: unknown[];
  roots?: Map<string, unknown>;
  parsed?: Set<string>;
  /** Deferreds for promise placeholders awaiting their result frame. */
  open?: Map<number, Deferred>;
  settled?: Map<number, Deferred>;
  /** Per row: payload length consumed so far (for `pump`). */
  progress?: Map<string, number>;
};

/** The two ends of a decoded promise placeholder. */
interface Deferred {
  resolve: (value: unknown) => void;
  reject: (reason: unknown) => void;
  /** The placeholder itself, so hosts can await settlement. */
  promise: Promise<unknown>;
}

/**
 * Resolves the named export of a client-reference module.
 *
 * Return the implementation directly when it is already available — a
 * synchronous module cache such as webpack's `__webpack_require__` — or a
 * promise for it otherwise. The decoder uses the synchronous form to hand
 * out the real component or function, so hydration never suspends on
 * preact's `lazy`. Implementations should be idempotent: the decoder may
 * call the loader again at call time for function-kind references.
 */
export type LoadModule = (mod: string, name: string) => unknown;

/** Options shared by `Decoder` and `DataDecoder`. */
export interface DecoderOptions {
  /**
   * Module-loading strategy for client references. Override this to resolve
   * modules from a non-ESM cache (for example webpack's
   * `__webpack_require__`). Defaults to the `__pp` registry plus a dynamic
   * ESM `import()`.
   */
  loadModule?: LoadModule;
}

/**
 * Shared parse context: one per linear source (a document row, or a whole
 * data stream). The counter runs across every frame of the source so
 * back-references stay aligned with the encoder's monotonic ids.
 */
interface ParseContext {
  /** Absolute-indexed reference table for this source. */
  refs: unknown[];
  counter: number;
  /** Materialize live values (false = collect-mode walk, e.g. preload). */
  construct: boolean;
  /** Collect-mode sink: referenced module ids mapped to their export names. */
  mods?: Map<string, Set<string>>;
  /** Live deferreds for `p<id>` placeholders, resolved by `!<id>` frames. */
  open?: Map<number, Deferred>;
  /** Shared stash of settlements that outran their placeholder. */
  settled?: Map<number, { sign: string; value: unknown }>;
  /**
   * Document mode only: materialize whichever row owns an unresolved id and
   * return the value (or undefined when still missing).
   */
  resolveForeign?: (id: number) => unknown;
  /** Resolves client-reference modules; see `LoadModule`. */
  loadModule?: LoadModule;
}

const NUMBER_CHARS = "+-0123456789.eE";

/** Document payloads with a nonzero first id carry a `<base>|` header. */
const BASE_HEADER = /^(\d+)\|/;

function baseOf(payload: string): number {
  const match = BASE_HEADER.exec(payload);
  return match === null ? 0 : Number(match[1]);
}

/**
 * Parses a payload — a root value frame optionally followed by promise
 * result frames — into `ctx.refs` and returns the root plus how many
 * characters were consumed (so late-appended result frames can be applied
 * later via `Decoder.pump`).
 *
 * Each frame may start with a `<base>|` header aligning `ctx.counter` with
 * the encoder's absolute reference ids; frames after the root must be
 * `!<id>` promise settlements. With `resume`, the root is skipped and only
 * settlements are parsed.
 *
 * Reference ids were claimed by the encoder in pre-order, and this parser
 * registers instances at exactly those indices, so cycles, shared values,
 * and values shared across frames all resolve to single live identities.
 */
function parseFrames(
  input: string,
  ctx: ParseContext,
  options: { resume?: boolean } = {},
): { root: unknown; end: number } {
  let pos = 0;

  const claim = () => ctx.counter++;
  const register = (id: number, value: object) => {
    ctx.refs[id] = value;
  };

  // Closure bridge to the class method (nested function declarations cannot
  // reference `this` directly).
  const resolveRef = (
    kind: ClientReferenceKind,
    mod: string,
    name: string,
    bound?: unknown[],
  ): unknown => resolveClientReference(kind, mod, name, bound, ctx.loadModule);

  function expect(char: string): void {
    if (input[pos] !== char) {
      throw new SyntaxError(`Expected "${char}" at position ${pos}.`);
    }
  }

  /**
   * Applies a `<base>|` header at the current position, if present: ids
   * are monotonic per source, so each frame realigns the counter. Frames
   * without a header start at base 0.
   */
  function readBaseHeader(): void {
    let i = pos;
    while (i < input.length && input[i] >= "0" && input[i] <= "9") i++;
    if (i > pos && input[i] === "|") {
      ctx.counter = Number(input.slice(pos, i));
      pos = i + 1;
    } else {
      ctx.counter = 0;
    }
  }

  /** Reads a bare digit run as a reference id (promise slots). */
  function readDigits(): number {
    const start = pos;
    while (pos < input.length && input[pos] >= "0" && input[pos] <= "9") pos++;
    if (pos === start) {
      throw new SyntaxError(`Expected a reference id at position ${start}.`);
    }
    return Number(input.slice(start, pos));
  }

  /** Parses one `!<id>+<value>` / `!<id>-<reason>` settlement frame. */
  function parseSettlement(): void {
    pos++; // !
    const id = readDigits();
    if (!Number.isInteger(id) || id < 0) {
      throw new SyntaxError(`Invalid promise reference @${id}.`);
    }
    const sign = input[pos];
    if (sign !== "+" && sign !== "-") {
      throw new SyntaxError(`Expected "+" or "-" at position ${pos}.`);
    }
    pos++;
    const value = parseValue();
    if (!ctx.construct) return; // collect-mode walk: settlements carry no state

    const deferred = ctx.open?.get(id);
    if (deferred === undefined) {
      // The frame outran its placeholder (streaming chunks and row decode
      // are unordered); hold it until `p<id>` materializes.
      (ctx.settled ??= new Map()).set(id, { sign, value });
      return;
    }
    ctx.open?.delete(id);
    if (sign === "+") deferred.resolve(value);
    else deferred.reject(value);
  }

  /** Parses a JSON string (never interned — strings are always inline). */
  function parseString(): string {
    expect('"');
    pos++;
    let raw = "";
    let escaped = false;
    while (true) {
      const ch = input[pos];
      if (ch === undefined) throw new SyntaxError("Unterminated string.");
      pos++;
      if (ch === '"') break;
      if (ch === "\\") {
        escaped = true;
        raw += ch + (input[pos] ?? "");
        pos++;
        continue;
      }
      raw += ch;
    }
    return escaped ? (JSON.parse(`"${raw}"`) as string) : raw;
  }

  function parseNumberText(): string {
    let out = "";
    while (pos < input.length && NUMBER_CHARS.includes(input[pos])) {
      out += input[pos++];
    }
    return out;
  }

  function parseValue(): unknown {
    const c = input[pos];

    // Multi-character literals first.
    if (input.startsWith("null", pos)) {
      pos += 4;
      return null;
    }
    if (input.startsWith("true", pos)) {
      pos += 4;
      return true;
    }
    if (input.startsWith("false", pos)) {
      pos += 5;
      return false;
    }
    if (input.startsWith("NaN", pos)) {
      pos += 3;
      return Number.NaN;
    }

    switch (c) {
      case "u":
        pos++;
        return undefined;
      case '"':
        return parseString();
      case "I":
        pos++;
        return Number.POSITIVE_INFINITY;
      case "i":
        pos++;
        return Number.NEGATIVE_INFINITY;
      case "z":
        pos++;
        return -0;
      case "b": {
        pos++;
        return BigInt(parseNumberText());
      }
      case TAG_SYMBOL:
        pos++;
        return Symbol.for(parseString());
      case TAG_DATE: {
        pos++;
        const id = claim();
        const date = new Date(parseString());
        register(id, date);
        return date;
      }
      case TAG_URL: {
        pos++;
        const id = claim();
        const url = new URL(parseString());
        register(id, url);
        return url;
      }
      case TAG_REGEXP: {
        pos++;
        const id = claim();
        expect("[");
        pos++;
        const source = parseValue() as string;
        expect(",");
        pos++;
        const flags = parseValue() as string;
        expect("]");
        pos++;
        const regexp = new RegExp(source, flags);
        register(id, regexp);
        return regexp;
      }
      case TAG_ARRAY_BUFFER:
      case TAG_INT_8_ARRAY:
      case TAG_UINT_8_ARRAY:
      case TAG_UINT_8_ARRAY_CLAMPED:
      case TAG_INT_16_ARRAY:
      case TAG_UINT_16_ARRAY:
      case TAG_INT_32_ARRAY:
      case TAG_UINT_32_ARRAY:
      case TAG_FLOAT_32_ARRAY:
      case TAG_FLOAT_64_ARRAY:
      case TAG_BIG_INT_64_ARRAY:
      case TAG_BIG_UINT_64_ARRAY:
      case TAG_DATA_VIEW:
        return parseBinary(c);
      case TAG_ERROR:
        pos++; // E
        expect("{");
        pos++;
        return parseObjectInto(new Error());
      case "{":
        pos++;
        return parseObjectInto({});
      case TAG_MAP: {
        pos += 2; // M[
        const id = claim();
        const map = new Map<unknown, unknown>();
        register(id, map);
        while (input[pos] !== "]") {
          if (pos >= input.length) throw new SyntaxError("Unterminated map.");
          const key = parseValue();
          expect(",");
          pos++;
          const value = parseValue();
          if (ctx.construct) map.set(key, value);
          if (input[pos] === ",") pos++;
        }
        pos++;
        return ctx.construct ? map : undefined;
      }
      case TAG_SET: {
        pos += 2; // S[
        const id = claim();
        const set = new Set<unknown>();
        register(id, set);
        while (input[pos] !== "]") {
          if (pos >= input.length) throw new SyntaxError("Unterminated set.");
          const value = parseValue();
          if (ctx.construct) set.add(value);
          if (input[pos] === ",") pos++;
        }
        pos++;
        return ctx.construct ? set : undefined;
      }
      case "[": {
        pos++;
        const id = claim();
        const arr: unknown[] = [];
        register(id, arr);
        while (input[pos] !== "]") {
          if (pos >= input.length) throw new SyntaxError("Unterminated array.");
          const value = parseValue();
          if (ctx.construct) arr.push(value);
          if (input[pos] === ",") pos++;
        }
        pos++;
        return ctx.construct ? arr : undefined;
      }
      case TAG_REFERENCE: {
        pos++;
        return resolveReference(parseReferenceToken());
      }
      case TAG_PROMISE: {
        pos++; // p
        const id = readDigits();
        if (!Number.isInteger(id) || id < 0) {
          throw new SyntaxError(`Invalid promise reference @${id}.`);
        }
        // Align the counter with the encoder's explicit claim.
        ctx.counter = Math.max(ctx.counter, id + 1);
        if (!ctx.construct) return undefined;
        let resolve!: (value: unknown) => void;
        let reject!: (reason: unknown) => void;
        const promise = new Promise((res, rej) => {
          resolve = (value) =>
            requestAnimationFrame(() => {
              // oxlint-disable typescript/no-floating-promises
              Object.assign(promise, { value });
              res(value);
            });
          reject = (cause) =>
            requestAnimationFrame(() => {
              // oxlint-disable typescript/no-floating-promises
              Object.assign(promise, { cause });
              rej(cause);
            });
        });
        register(id, promise);
        (ctx.open ??= new Map()).set(id, { resolve, reject, promise });
        const stashed = ctx.settled?.get(id);
        if (stashed) {
          ctx.settled!.delete(id);
          if (stashed.sign === "+") resolve(stashed.value);
          else reject(stashed.value);
        }
        return promise;
      }
      case TAG_PLUGIN:
        return parsePlugin();
      default:
        if (c === "-" || c === "." || (c >= "0" && c <= "9")) {
          return Number(parseNumberText());
        }
        throw new SyntaxError(`Unexpected character '${c}' at position ${pos}.`);
    }
  }

  /** Reads a reference token: bare digits naming an index in `ctx.refs`. */
  function parseReferenceToken(): string {
    let token = "";
    while (pos < input.length) {
      const ch = input[pos];
      if (ch === "," || ch === "]" || ch === "}" || ch === "\n") break;
      token += ch;
      pos++;
    }
    return token;
  }

  const resolveReference = (token: string): unknown => {
    const id = Number(token);
    if (!Number.isInteger(id) || id < 0) {
      throw new SyntaxError(`Invalid reference @${token}.`);
    }
    const known = ctx.refs[id];
    if (known !== undefined) return known;

    // Not materialized yet: give the host a chance to locate the frame that
    // owns this id (document rows can be decoded independently and lazily).
    const resolved = ctx.resolveForeign?.(id);
    if (resolved !== undefined) return resolved;
    throw new SyntaxError(`Missing reference @${id}.`);
  };

  function parseBinary(tag: string): unknown {
    pos++; // tag
    const id = claim();
    const bytes = decodeBase64(parseString());
    let value: object;
    switch (tag) {
      case TAG_ARRAY_BUFFER:
        value = bytes.buffer;
        break;
      case TAG_UINT_8_ARRAY:
        value = bytes;
        break;
      case TAG_UINT_8_ARRAY_CLAMPED:
        value = new Uint8ClampedArray(bytes.buffer);
        break;
      case TAG_BIG_INT_64_ARRAY:
        value = new BigInt64Array(bytes.buffer);
        break;
      case TAG_BIG_UINT_64_ARRAY:
        value = new BigUint64Array(bytes.buffer);
        break;
      case TAG_DATA_VIEW:
        value = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
        break;
      default:
        value = new (BINARY_CONSTRUCTORS.get(tag)!)(bytes.buffer);
        break;
    }
    register(id, value);
    return value;
  }

  /**
   * Parse `{key:value,...}` entries into an existing target. Errors are
   * decoded through the same path (E{"name":...,"message":...}) so their
   * fields land as own properties. `__proto__` is assigned safely.
   */
  function parseObjectInto(target: object): object {
    register(claim(), target);
    while (input[pos] !== "}") {
      if (pos >= input.length) throw new SyntaxError("Unterminated object.");
      const key = parseString();
      expect(":");
      pos++;
      const value = parseValue();
      if (key === "__proto__") {
        Object.defineProperty(target, key, {
          value,
          writable: true,
          enumerable: true,
          configurable: true,
        });
      } else {
        (target as Record<string, unknown>)[key] = value;
      }
      if (input[pos] === ",") pos++;
    }
    pos++;
    return target;
  }

  function parsePlugin(): unknown {
    pos++; // P
    expect("[");
    pos++;
    // Plugin ids are bare tokens (e.g. `v`, `R`), read up to the first ",".
    const pluginStart = pos;
    while (pos < input.length && input[pos] !== ",") pos++;
    if (pos === pluginStart) {
      throw new SyntaxError(`Expected a plugin id at position ${pluginStart}.`);
    }
    const type = input.slice(pluginStart, pos);

    if (type === PLUGIN_VNODE) {
      expect(",");
      pos++;
      let vnodeType = parseValue();
      expect(",");
      pos++;
      const key = parseValue();
      expect(",");
      pos++;
      const props = parseValue();
      // Children travel as an optional trailing field (see the encoder's
      // `writeVNode`); a vnode without children keeps the 4-field form.
      let hasChildren = false;
      let children: unknown;
      if (input[pos] === ",") {
        pos++;
        hasChildren = true;
        children = parseValue();
      }
      expect("]");
      pos++;

      if (!ctx.construct) return undefined;
      if (vnodeType === FRAGMENT_SENTINEL) vnodeType = Fragment;
      else if (vnodeType === SUSPENSE_SENTINEL) vnodeType = Suspense;
      const materializedProps: Record<string, unknown> =
        props !== null && typeof props === "object"
          ? { ...(props as Record<string, unknown>) }
          : {};
      if (key !== null && key !== undefined) materializedProps.key = key;
      if (hasChildren) materializedProps.children = children;
      return h(vnodeType as never, materializedProps);
    }

    if (type === PLUGIN_CLIENT_REFERENCE) {
      expect(",");
      pos++;
      const kind = parseString();
      expect(",");
      pos++;
      const mod = parseString();
      expect(",");
      pos++;
      const name = parseString();

      // The fifth field is optional: bound scope values captured by the
      // server transform. Empty bindings use the legacy 4-field form.
      let bound: unknown[] | undefined;
      if (input[pos] === ",") {
        pos++;
        const parsed = parseValue();
        bound = Array.isArray(parsed) ? parsed : [];
      }
      expect("]");
      pos++;

      if (kind !== "component" && kind !== "function") {
        throw new SyntaxError(`Unknown client reference kind "${kind}".`);
      }
      if (ctx.mods) {
        let names = ctx.mods.get(mod);
        if (!names) ctx.mods.set(mod, (names = new Set()));
        names.add(name);
      }
      if (!ctx.construct) return undefined;
      return resolveRef(kind, mod, name, bound);
    }

    throw new SyntaxError(`Unknown plugin type ${JSON.stringify(type)}.`);
  }

  if (input.length === 0) {
    throw new SyntaxError("Empty frame.");
  }

  readBaseHeader();
  const root = options.resume ? undefined : parseValue();

  // Only frame terminators and promise result frames may follow.
  while (input[pos] === "\n") pos++;

  // In normal mode the header read above belonged to the root frame, so the
  // first settlement must read its own header. In resume mode there is no
  // root frame: that first readBaseHeader already consumed the first
  // settlement's header, so skip re-reading it for the first frame.
  let needsHeader = !options.resume;
  while (pos < input.length) {
    if (needsHeader) readBaseHeader();
    needsHeader = true;
    if (input[pos] !== TAG_SETTLED) {
      throw new SyntaxError(`Unexpected trailing content at position ${pos}.`);
    }
    parseSettlement();
    while (input[pos] === "\n") pos++;
  }

  return { root, end: pos };
}

/**
 * Document decoder: parses rows produced by the `Encoder` back into live
 * values. Rows are read from `globalThis[namespace].d[id]`; VNode plugin
 * tokens become preact VNodes, client references become resolved components
 * (`lazy()` when their module has not loaded yet) or call-time-resolved
 * functions, and every built-in type is reconstructed natively.
 *
 * Rows are materialized lazily and at most once: decoding a row that
 * references instances defined in another row locates it via its base
 * header, so decode order never matters. Promise placeholders decode to
 * real Promises; result frames already present in the payload settle them
 * during decode, and frames appended later are applied by `pump`.
 * See `DataDecoder` for the stream variant of this codec.
 *
 * ### Cross-row references
 *
 * One `Encoder` numbers reference ids monotonically across every row it
 * writes, so a row may reference instances defined in another row. Decoding
 * such an id finds the owning row by its `<base>|` header, taking the
 * greatest base at or below the id. It parses that row into the same table.
 * Decode order never matters, and rows materialize at most once.
 */
export class Decoder {
  private readonly namespace: string;
  private readonly loadModule: LoadModule;
  /** Whether `loadModule` is the built-in ESM loader (vs. user supplied). */
  private readonly usesDefaultLoader: boolean;

  constructor(namespace: string, options: DecoderOptions = {}) {
    this.namespace = namespace;
    this.loadModule = options.loadModule ?? defaultLoadModule;
    this.usesDefaultLoader = options.loadModule === undefined;
  }

  /**
   * Ensure every module referenced by a row — including modules reachable
   * through references into other rows — is loaded.
   *
   * This is the first move of the hydration pipeline (`preload`, then
   * `decode`, then preact `hydrate`). It walks the row and constructs
   * nothing: it collects `$R` module references, including through
   * references into other rows. With the default loader it awaits the
   * module load promise (`__pp[mod].p`), triggering the import via `__pm`
   * where needed; with a custom loader it warms the loader itself. Either
   * way modules load before decode, so component references resolve to
   * implementations directly and hydration never suspends.
   */
  preload(id: string): Promise<void> {
    const bag = this.bag();
    const payload = bag.d?.[id];
    const mods = new Map<string, Set<string>>();
    if (payload) {
      // Walk without constructing anything; just gather referenced modules
      // (transitively through references into other rows).
      const ctx: ParseContext & { visited: Set<string> } = {
        refs: [],
        counter: 0,
        construct: false,
        mods,
        visited: new Set(),
      };
      ctx.resolveForeign = resolveForeignIn(this.namespace, ctx);
      parseRow(this.namespace, id, payload, ctx);
    }

    // A custom loader owns module loading. Warm it so decode can hand out
    // implementations synchronously, and deliberately skip the ESM `__pm`
    // runtime — otherwise a webpack (or similar) setup would also trigger
    // native dynamic imports.
    if (!this.usesDefaultLoader) {
      const warm: Promise<unknown>[] = [];
      for (const [mod, names] of mods) {
        for (const name of names) {
          warm.push(Promise.resolve().then(() => this.loadModule(mod, name)));
        }
      }
      return Promise.all(warm).then(() => undefined);
    }

    const pp = (globalThis as unknown as { __pp?: Record<string, { p: Promise<unknown> }> }).__pp;
    const pm = (globalThis as unknown as { __pm?: (mod: string) => unknown }).__pm;

    const pending: Promise<unknown>[] = [];
    for (const mod of mods.keys()) {
      let entry = pp?.[mod];
      if (!entry) {
        pm?.(mod);
        entry = pp?.[mod];
      }
      if (entry) pending.push(entry.p);
    }
    return Promise.all(pending).then(() => undefined);
  }

  /**
   * Decode a row into a live value. Rows are materialized at most once.
   *
   * This is the second move of the hydration pipeline. It parses the row
   * into a live tree: `P["$V"]` becomes a preact vnode through `h()`, and
   * `P["$R"]` becomes a resolved reference. Component kind means the loaded
   * export when present, else a `lazy()` wrapper that resolves on module
   * load. Function kind means the loaded export when present, else a
   * function resolving the module at call time. `$bound` values prepend to
   * props or call arguments.
   *
   * Loaded modules return implementations directly, so initial hydration
   * suspends on nothing. That directness matters because preact `lazy`
   * always throws once on first render, which would mis-hydrate sibling DOM.
   */
  decode(id: string): unknown {
    const bag = this.bag();
    const roots = (bag.roots ??= new Map());
    if (roots.has(id)) return roots.get(id);

    const payload = bag.d?.[id];
    if (!payload) return undefined;

    const ctx = parseContext(bag, this.loadModule);
    ctx.resolveForeign = resolveForeignIn(this.namespace, ctx);
    return parseRow(this.namespace, id, payload, ctx);
  }

  /**
   * Apply result frames appended to an already-decoded row (e.g. promise
   * settlements streamed in after hydration). No-op for rows that were
   * never decoded or have no new content.
   */
  pump(id: string): void {
    pump(this.namespace, id, this.loadModule);
  }

  private bag(): NamespaceBag {
    return namespaceBag(this.namespace);
  }
}

/** Shared per-namespace parse context over the bag's reference tables. */
function parseContext(
  bag: NamespaceBag,
  loadModule: LoadModule = defaultLoadModule,
): ParseContext & { visited: Set<string> } {
  return {
    refs: (bag.refs ??= []),
    counter: 0,
    construct: true,
    open: (bag.open ??= new Map()),
    settled: (bag.settled ??= new Map()),
    loadModule,
    visited: new Set(),
  };
}

/**
 * The row whose base header is the greatest value <= id: ids are
 * monotonic across rows, so that row owns the id.
 */
function ownerRowFor(bag: NamespaceBag, id: number): string | undefined {
  const d = bag.d ?? {};
  let best: string | undefined;
  let bestBase = -1;
  for (const name of Object.keys(d)) {
    const candidateBase = baseOf(d[name]!);
    if (candidateBase <= id && candidateBase >= bestBase) {
      best = name;
      bestBase = candidateBase;
    }
  }
  return best;
}

/**
 * Document-mode resolver for unmaterialized reference ids: locates the row
 * owning the id and parses it with the same context. The current frame's
 * counter progress is saved across the detour — parsing the foreign frame
 * realigns the counter with that frame's own base header, and since ids
 * are monotonic across rows, resuming at the saved position cannot collide
 * with anything the foreign frame claimed.
 */
function resolveForeignIn(
  namespace: string,
  ctx: ParseContext & { visited?: Set<string> },
): NonNullable<ParseContext["resolveForeign"]> {
  return (refId: number) => {
    const bag = namespaceBag(namespace);
    const owner = ownerRowFor(bag, refId);
    if (owner !== undefined && !ctx.visited?.has(owner)) {
      const resumeAt = ctx.counter;
      parseRow(namespace, owner, bag.d![owner]!, ctx);
      ctx.counter = Math.max(ctx.counter, resumeAt);
    }
    return ctx.refs[refId];
  };
}

/** Aligns the frame with its base header and caches document results. */
function parseRow(
  namespace: string,
  rowName: string,
  rawInput: string,
  ctx: ParseContext & { visited?: Set<string> },
): unknown {
  // Re-entering a row that is currently being parsed is impossible from
  // well-formed encoder output; the guard keeps malformed streams from
  // recursing forever.
  if (ctx.visited?.has(rowName)) return undefined;
  ctx.visited?.add(rowName);
  try {
    const { root, end } = parseFrames(rawInput, ctx);

    if (ctx.construct) {
      const bag = namespaceBag(namespace);
      (bag.parsed ??= new Set()).add(rowName);
      (bag.roots ??= new Map()).set(rowName, root);
      // Remember how much of the payload was consumed so pump() can pick
      // up frames appended later.
      (bag.progress ??= new Map()).set(rowName, end);
    }
    return root;
  } finally {
    ctx.visited?.delete(rowName);
  }
}

/**
 * Applies settlement frames appended to an already-decoded row (e.g.
 * promise resolutions streamed in after hydration). Standalone so the
 * client can invoke it from the namespace append hook (`bag.f`, emitted by
 * `Encoder.appendFrame`) without holding a `Decoder` instance. No-op for
 * rows that were never decoded or have no new content.
 */
export function pump(
  namespace: string,
  id: string,
  loadModule: LoadModule = defaultLoadModule,
): void {
  const bag = namespaceBag(namespace);
  const payload = bag.d?.[id];
  if (!payload) return;
  const progress = (bag.progress ??= new Map());
  const consumed = progress.get(id);
  if (consumed === undefined || consumed >= payload.length) return;

  const ctx = parseContext(bag, loadModule);
  ctx.resolveForeign = resolveForeignIn(namespace, ctx);

  // The remainder must be settlement frames; each carries its own base
  // header so ids stay aligned with the encoder no matter which rows
  // claimed references in between.
  const { end } = parseFrames(payload.slice(consumed), ctx, { resume: true });
  progress.set(id, consumed + end);
}

/** Module-level bag access mirroring `Decoder.bag()` for standalone use. */
function namespaceBag(namespace: string): NamespaceBag {
  const global = globalThis as unknown as Record<string, NamespaceBag | undefined>;
  const existing = global[namespace];
  if (existing) return existing;
  const created: NamespaceBag = {};
  global[namespace] = created;
  return created;
}

/**
 * Data decoder: the same codec as `Decoder`, without the namespace concept.
 * Reads byte streams produced by `DataEncoder` and resolves them to a live
 * value. Each stream starts with one self-contained root frame followed by
 * zero or more promise result frames, so each `decode` call starts from an
 * empty reference table.
 *
 * This is the transport behind client navigation. `decode(stream, onValue?)`
 * reads incrementally, parsing each newline-terminated frame on arrival. The
 * root delivers through `onValue` before close so hosts can paint early,
 * while settlements apply to the same parse context and resolve placeholders
 * in place. The returned promise resolves with the root on close. Malformed
 * input rejects, whether trailing bytes or an empty stream.
 *
 * Module resolution here has no `__pm` inline scripts to lean on, since
 * those exist only in HTML responses. When the decoder imports a module
 * itself it mirrors `__pm`: it caches the load promise and exposes resolved
 * exports on the registry entry. Otherwise component lookups miss their
 * export and hang suspended forever.
 */
export class DataDecoder {
  private readonly loadModule: LoadModule;

  constructor(options: DecoderOptions = {}) {
    this.loadModule = options.loadModule ?? defaultLoadModule;
  }

  /**
   * Decode a byte stream into a live value.
   *
   * The stream is consumed incrementally: the root frame is parsed as soon
   * as its newline-terminated frame arrives, and with `onValue` it is
   * delivered immediately — before the stream closes — so hosts can render
   * the first paint while later promise result frames are still streaming.
   * Settlement frames are applied to the same parse context as they arrive,
   * resolving any promise placeholders in the root.
   *
   * The returned promise resolves with the root once the stream closes and
   * rejects on malformed input. Callers that only need the first paint can
   * drive rendering from `onValue` and ignore the returned promise.
   */
  async decode(
    stream: ReadableStream<Uint8Array>,
    onValue?: (value: unknown) => void,
  ): Promise<unknown> {
    const ctx: ParseContext = {
      refs: [],
      counter: 0,
      construct: true,
      open: new Map(),
      loadModule: this.loadModule,
    };
    const decoder = new TextDecoder();
    const reader = stream.getReader();
    let buffer = "";
    let root: unknown;
    let hasRoot = false;

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (!done) {
          buffer += decoder.decode(value, { stream: true });
        }

        // Frames are newline-terminated, so any complete line can be parsed
        // without waiting for the rest of the stream.
        let newline = buffer.indexOf("\n");
        while (newline !== -1) {
          const frame = buffer.slice(0, newline + 1);
          buffer = buffer.slice(newline + 1);
          if (!hasRoot) {
            root = parseFrames(frame, ctx).root;
            hasRoot = true;
            onValue?.(root);
          } else {
            parseFrames(frame, ctx, { resume: true });
          }
          newline = buffer.indexOf("\n");
        }

        if (done) break;
      }

      // A well-formed encoder stream is fully frame-delimited; anything left
      // over after the final flush is malformed.
      const tail = buffer + decoder.decode();
      if (tail.length > 0) {
        throw new SyntaxError("Unexpected trailing content after the final frame.");
      }
      if (!hasRoot) {
        throw new SyntaxError("Empty stream.");
      }
      return root;
    } finally {
      reader.releaseLock();
    }
  }
}

/**
 * Default client-reference loader: resolves `name` through the namespace
 * module registry (`__pp[mod]`). When no entry exists it defers to the
 * page's loader hook (`__pm`) if one is installed, and otherwise triggers a
 * dynamic ESM `import()`.
 *
 * Deferring to `__pm` lets non-ESM chunk formats work without a custom
 * `loadModule`: Rsbuild's JSONP runtime installs a `__pm` that loads classic
 * chunks, and `DataDecoder` (client navigation) reuses it. Registered
 * modules that have already resolved return their export synchronously, so
 * decode gives back the real implementation and hydration does not suspend.
 * In-flight modules return the load promise instead.
 */
const defaultLoadModule: LoadModule = (mod, name) => {
  const storage = globalThis as unknown as {
    __pp?: Record<string, { p: Promise<unknown>; m?: Record<string, unknown> }>;
    __pm?: (mod: string, ...deps: string[]) => void;
  };
  let entry = storage.__pp?.[mod];
  if (!entry) {
    // Prefer the page's loader hook when present: it may load a non-ESM chunk
    // format (e.g. Rsbuild's JSONP) that `import()` cannot handle.
    if (storage.__pm) {
      storage.__pm(mod);
      entry = storage.__pp?.[mod];
    }
    if (!entry) {
      storage.__pp ??= {};
      entry = {
        p: import(/* @vite-ignore */ /* webpackIgnore: true */ mod),
      };
      entry.p.then(
        (ns) => {
          entry!.m = ns as Record<string, unknown>;
        },
        () => {},
      );
      storage.__pp[mod] = entry;
    }
  }
  if (entry.m) return entry.m[name];
  // Await the load, then read the export the registry captured (the loader
  // above, or `__pm`). Reading `entry.m` rather than the promise's value
  // keeps working when the promise resolves to something other than the
  // namespace.
  return entry.p.then(() => entry!.m?.[name]);
};

/**
 * True for values carrying the client-reference marker. Mirrors the
 * encoder's default predicate without depending on it: only the babel
 * transform produces `$type`-marked functions, each with its own `.bind`
 * partial-application helper.
 */
function isClientReference(fn: object): boolean {
  return (
    "$type" in fn &&
    (fn as { $type?: unknown }).$type === Symbol.for("pp.client-reference") &&
    Object.prototype.hasOwnProperty.call(fn, "bind")
  );
}

/**
 * Resolve one client reference against the module loader.
 *
 * Loading is entirely the loader's concern: `loadModule(mod, name)` returns
 * the named export synchronously when it is cached, or a promise for it
 * otherwise. Everything below is kind-specific wrapping.
 *
 * Component kind means the loaded export when available, else a `lazy()`
 * wrapper that resolves on module load. Function kind means the loaded
 * export when available, else a function resolving the module at call time.
 * `$bound` values prepend to props or call arguments.
 */
function resolveClientReference(
  kind: ClientReferenceKind,
  mod: string,
  name: string,
  bound?: unknown[],
  loadModule: LoadModule = defaultLoadModule,
): unknown {
  // Prepend captured scope values to whatever args the client supplies
  // (props for components, call args for function references). Values that
  // are already client references derive a bound copy through their own
  // `.bind` (which shadows `Function.prototype.bind` with partial
  // application), so decoded values stay references that re-encode as `$R`
  // tokens — enabling server-side round trips (`decode` then `encode`).
  // Plain implementations keep the equivalent closure behavior.
  const applyBound = (fn: unknown): unknown => {
    if (typeof fn !== "function") return fn;
    if (!bound || bound.length === 0) return fn;
    if (isClientReference(fn)) {
      return (fn as { bind: (thisArg: null, ...args: unknown[]) => unknown }).bind(null, ...bound);
    }
    return (...args: unknown[]) => (fn as (...a: unknown[]) => unknown)(...bound, ...args);
  };

  const loaded = loadModule(mod, name);

  // Component kind: already-loaded modules return their implementation
  // directly so initial hydration does not suspend (preact `lazy` always
  // throws once on first render, which mis-hydrates sibling DOM).
  if (kind === "component") {
    if (typeof loaded === "function") return applyBound(loaded);

    return lazy(() =>
      Promise.resolve(loaded).then((fn) => {
        if (typeof fn !== "function") {
          throw new Error(`Client reference "${name}" not found in module "${mod}".`);
        }
        return applyBound(fn) as never;
      }),
    );
  }

  // "function" kind: raw module function, resolved at call time when not yet
  // loaded. The loader is consulted again so a synchronous cache can supply
  // the implementation once the module has settled.
  if (typeof loaded === "function") return applyBound(loaded);

  return (...args: unknown[]) => {
    const fn = loadModule(mod, name);
    if (typeof fn !== "function") {
      throw new Error(`Client reference "${name}" not found in module "${mod}".`);
    }
    return (fn as (...args: unknown[]) => unknown)(...(bound ?? []), ...args);
  };
}

const BINARY_CONSTRUCTORS = new Map<string, new (buffer: ArrayBufferLike) => object>([
  [TAG_INT_8_ARRAY, Int8Array],
  [TAG_INT_16_ARRAY, Int16Array],
  [TAG_UINT_16_ARRAY, Uint16Array],
  [TAG_INT_32_ARRAY, Int32Array],
  [TAG_UINT_32_ARRAY, Uint32Array],
  [TAG_FLOAT_32_ARRAY, Float32Array],
  [TAG_FLOAT_64_ARRAY, Float64Array],
]);

function decodeBase64(base64: string): Uint8Array {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}
