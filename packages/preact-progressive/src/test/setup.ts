/**
 * Node test environment polyfill: the decoder resolves promise placeholders
 * through `requestAnimationFrame` (matching the browser's frame-boundary
 * handshake with the transport swap), which node lacks. Defer on the
 * microtask queue so tests can settle them with a plain `await` / tick,
 * mirroring how the browser's frame callbacks run after the current task.
 */
(globalThis as Record<string, unknown>).requestAnimationFrame ??= (
  callback: FrameRequestCallback,
) => {
  queueMicrotask(() => callback(performance.now()));
  return 0;
};

(globalThis as Record<string, unknown>).cancelAnimationFrame ??= () => {};
