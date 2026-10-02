declare module "*?assets=client" {
  /** Built client entry assets (hiogawa/vite-plugin-fullstack `?assets` contract). */
  const assets: {
    entry: string;
    js: { href: string }[];
    css: { href: string }[];
    /** False when the assets are classic JSONP scripts rather than ES modules. */
    module?: boolean;
  };
  export default assets;
}
