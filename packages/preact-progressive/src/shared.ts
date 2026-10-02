/**
 * Wire-format tags shared by the `Encoder` and `Decoder`.
 *
 * The format is a text-based, line-delimited data protocol inspired by
 * turbo-stream. A row payload consists of one or more newline-terminated
 * frames; the first frame holds the root value. Values are self-describing:
 *
 *   u              undefined          null/true/false  literals
 *   NaN / I / i    NaN / +Inf / -Inf  z                -0
 *   "..."          JSON string        <digits>         number
 *   b<int>         bigint             s"key"           Symbol.for(key)
 *   D"json"        Date               U"href"          URL
 *   r[src,flags]   RegExp             E{...}           Error
 *   A/o/C/L/l/G/g/H/h/J/j/V"<b64>"   ArrayBuffer / typed arrays / DataView
 *   M[k,v,...]     Map (flat pairs)   S[v,...]         Set
 *   [...]          array              {...}            object
 *   @<id>          back-reference to an earlier value
 *   P[v,type,key,props]  preact VNode (children, when present, is an
 *                        optional trailing field instead of a "children"
 *                        prop: `P[v,type,key,props,children]`)
 *   P[R,kind,mod,name]   client reference (optional fifth field: $bound)
 *   p<id>          promise placeholder (claims reference id <id>)
 *   !<id>+<val>    fulfillment frame for promise <id>
 *   !<id>-<err>    rejection frame for promise <id>
 *
 * Every object-ish value (arrays, objects, Maps, Sets, Dates, RegExps,
 * URLs, Errors, binary views, promises) claims one reference id in
 * encounter order on both the encoding and decoding side, which makes
 * cycles and repeated references fall out as `@id` tokens. Strings are
 * always inline — only instance values are ever referenced.
 *
 * Promises are the one asynchronously-completed value: the root frame
 * carries only the `p<id>` placeholder, and each settled promise is
 * delivered in a follow-up frame appended after it (its own optional
 * `<base>|` header included). Decoding yields a real Promise immediately;
 * result frames resolve or reject it in arrival order.
 */
export const TAG_ARRAY_BUFFER = "A";
export const TAG_BIG_INT_64_ARRAY = "J";
export const TAG_BIG_UINT_64_ARRAY = "j";
export const TAG_BIGINT = "b";
export const TAG_DATA_VIEW = "V";
export const TAG_DATE = "D";
export const TAG_ERROR = "E";
export const TAG_FALSE = "false";
export const TAG_FLOAT_32_ARRAY = "H";
export const TAG_FLOAT_64_ARRAY = "h";
export const TAG_INFINITY = "I";
export const TAG_INT_16_ARRAY = "L";
export const TAG_INT_32_ARRAY = "G";
export const TAG_INT_8_ARRAY = "O";
export const TAG_MAP = "M";
export const TAG_NAN = "NaN";
export const TAG_NEGATIVE_INFINITY = "i";
export const TAG_NEGATIVE_ZERO = "z";
export const TAG_NULL = "null";
export const TAG_PLUGIN = "P";
export const TAG_PROMISE = "p";
export const TAG_REFERENCE = "@";
export const TAG_SETTLED = "!";
export const TAG_REGEXP = "r";
export const TAG_SET = "S";
export const TAG_SYMBOL = "s";
export const TAG_TRUE = "true";
export const TAG_UINT_16_ARRAY = "l";
export const TAG_UINT_32_ARRAY = "g";
export const TAG_UINT_8_ARRAY = "o";
export const TAG_UINT_8_ARRAY_CLAMPED = "C";
export const TAG_UNDEFINED = "u";
export const TAG_URL = "U";

/** Plugin id for preact VNodes: P[v, type, key, props] */
export const PLUGIN_VNODE = "v";

/** Plugin id for client references: P[R, kind, mod, name] */
export const PLUGIN_CLIENT_REFERENCE = "R";

/**
 * String sentinel for the preact `Fragment` component inside a `P[v,...]`
 * type slot. (A user-defined element literally tagged "$F" would collide;
 * this matches the previous wire format's behavior.)
 */
export const FRAGMENT_SENTINEL = "$F";

/**
 * String sentinel for the preact/compat `Suspense` boundary inside a
 * `P[v,...]` type slot. Suspense must be instantiated by the renderer (its
 * constructor assigns instance fields), so it can never run inside the
 * encoder; the boundary travels as data and is rebuilt from the client's
 * own compat import.
 */
export const SUSPENSE_SENTINEL = "$S";

/** Typed-array tag lookup used by both directions. */
export const TYPED_ARRAY_TAGS: ReadonlyMap<Function, string> = new Map<Function, string>([
  [Int8Array, TAG_INT_8_ARRAY],
  [Uint8Array, TAG_UINT_8_ARRAY],
  [Uint8ClampedArray, TAG_UINT_8_ARRAY_CLAMPED],
  [Int16Array, TAG_INT_16_ARRAY],
  [Uint16Array, TAG_UINT_16_ARRAY],
  [Int32Array, TAG_INT_32_ARRAY],
  [Uint32Array, TAG_UINT_32_ARRAY],
  [Float32Array, TAG_FLOAT_32_ARRAY],
  [Float64Array, TAG_FLOAT_64_ARRAY],
  [BigInt64Array, TAG_BIG_INT_64_ARRAY],
  [BigUint64Array, TAG_BIG_UINT_64_ARRAY],
] as [Function, string][]);

export function typedArrayTag(value: object): string | undefined {
  return TYPED_ARRAY_TAGS.get((value as { constructor: Function }).constructor);
}
