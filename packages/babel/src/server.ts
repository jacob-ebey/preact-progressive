import type { NodePath, PluginAPI, PluginObject, PluginPass, Scope } from "@babel/core";
import type * as T from "@babel/types";

// Server transform for `"use client"` boundaries.
// Full documentation lives on the default export below.

interface ClientReferenceState extends PluginPass {
  programPath: NodePath<T.Program>;
  helperInserted: boolean;
}

/** True when `scope` is `ancestor` or one of its descendants. */
function isWithinScope(scope: Scope, ancestor: Scope): boolean {
  let current: Scope | null | undefined = scope;
  while (current) {
    if (current === ancestor) return true;
    current = current.parent;
  }
  return false;
}

/**
 * Server transform for `"use client"` boundaries.
 *
 * A client reference stands in for code that lives in the browser. On the
 * server it calls like any other function, so client components render to
 * HTML during SSR. It never ships as code. At the wire it becomes a small
 * token naming where the implementation lives, and the browser resolves that
 * token back into the component or function from the referenced module.
 *
 * Every reference carries the same metadata:
 *
 * - `$type`: `Symbol.for("pp.client-reference")`, which identifies a reference.
 * - `$mod`: the module id exporting the implementation.
 * - `$name`: the export to look up inside that module.
 * - `$deps`: chunk dependencies to load before the module (build only).
 * - `$bound`: values captured from an outer server scope (scoped directives only).
 *
 * A reference passes through three stages. This plugin creates it at build
 * time, as described below. The renderer serializes it at render time
 * (`renderToProgressiveStream`). The client resolves it at hydration time
 * (`prgressiveHydrate` / `Decoder`).
 *
 * #### Module directives
 *
 * `"use client"` at the top of a module marks every export as a client
 * reference. The server plugin rewrites each exported function into a call
 * to a small `__pp_create_ref` helper:
 *
 * ```tsx
 * "use client";
 *
 * export function Counter({ initial = 0 }) {
 *   // ...
 * }
 * ```
 *
 * becomes roughly:
 *
 * ```tsx
 * "use client";
 *
 * function Counter({ initial = 0 }) {
 *   // ...
 * }
 *
 * const __pp_ref_Counter = __pp_create_ref(Counter, "Counter");
 *
 * export { __pp_ref_Counter as Counter };
 * ```
 *
 * The helper returns a plain function that forwards calls to the original
 * with the metadata attached:
 *
 * ```ts
 * function __pp_create_ref(fn, name, bound) {
 *   var boundArgs = bound || [];
 *   var ref = function () {
 *     return fn.apply(this, boundArgs.concat(Array.prototype.slice.call(arguments)));
 *   };
 *   ref.$type = Symbol.for("pp.client-reference");
 *   ref.$mod = "<module id>";
 *   ref.$name = name;
 *   ref.$deps = ["<chunk deps>"];
 *   ref.$bound = boundArgs;
 *   ref.bind = function () {
 *     // returns a new reference with more bound arguments
 *   };
 *   return ref;
 * }
 * ```
 *
 * Re-exports follow the same path. `export { foo } from "./mod"` becomes an
 * import turned reference, re-exported under the same name. `export *` is
 * rejected, since statically unknowable names cannot become references.
 *
 * #### Scoped directives
 *
 * `"use client"` inside a function body hoists the function to the top of
 * the module and turns every free variable into a parameter:
 *
 * ```tsx
 * function makeHandler(x) {
 *   function handler(y) {
 *     "use client";
 *
 *     return x + y;
 *   }
 *   return handler;
 * }
 * ```
 *
 * becomes:
 *
 * ```tsx
 * function _pp_hoisted_handler(x, y) {
 *   return x + y;
 * }
 *
 * const __pp_ref_handler = __pp_create_ref(_pp_hoisted_handler, "_pp_hoisted_handler");
 *
 * function makeHandler(x) {
 *   const handler = __pp_ref_handler.bind(null, x);
 *   return handler;
 * }
 * ```
 *
 * The hoisted function takes captured values first and real arguments after.
 * The definition site binds the reference over those values, which is how
 * they land in `$bound`. Module-scope bindings such as imports are never
 * captured, since they stay in scope after hoisting. Globals like `console`
 * are skipped for the same reason.
 *
 * One hazard worth knowing: other transforms can demote a module-level
 * directive into a plain string statement, which is what happens when
 * `@preact/preset-vite` prepends imports above it. The server plugin revives
 * such statements into directives before branching on them.
 *
 * #### Placeholders
 *
 * Production server transforms cannot know chunk URLs, since the client
 * compiles after the server. References carry content-hashed placeholders
 * instead, derived from the module path relative to project root:
 *
 * - `__PP_MOD__<sha256>` for the module chunk URL (`$mod`).
 * - `__PP_DEPS__<hash>` for the chunk dependencies to preload (`$deps`).
 *
 * Dev skips placeholders. Module URLs resolve from the module graph, with
 * deps staying empty.
 *
 * #### Server registration
 *
 * Every reference site also registers its server implementation on
 * `globalThis.__pp_server_modules` under its `$mod`/`$name`, so
 * `virtual:server-load-module` can resolve client references on the server
 * (prerendering, server actions) without knowing every module up front and
 * without relying on bundled export names, which minifiers may mangle.
 * Both module-level and scoped sites register the ref (which forwards to
 * the implementation); the decoder derives bound copies through the ref's
 * own `.bind`, so decoded values stay client references that re-encode as
 * `$R` tokens. The `MOD` string travels through the same placeholder
 * rewriting as `$mod`, so registry keys match encoded references at runtime.
 *
 * Options (passed as the second element of the `[plugin, options]` tuple):
 * `mod` is stamped into each reference's `$mod`, `deps` into `$deps`, and
 * `onTransformed` fires once when the file produced at least one reference
 * so the build plugin can record the module as a client entry.
 */
export default function preactProgressiveServer(
  babel: PluginAPI,
): PluginObject<PluginPass<{ mod: string; deps: string[]; onTransformed?: () => void }>> {
  const { types: t } = babel;

  // Check for a "use client" directive in a body
  function hasUseClientDirective(body?: T.BlockStatement | T.Program | null): boolean {
    if (!body || !body.directives) return false;
    return body.directives.some((dir) => dir.value.value === "use client");
  }

  /**
   * Other transforms (e.g. @preact/preset-vite's injected `preact/debug`
   * import) can end up above a module-level `"use client"` directive,
   * demoting it from a real directive to a plain string-expression
   * statement. Revive such a statement back into a program directive so the
   * module-level branch is detected.
   */
  function reviveDemotedDirective(programPath: NodePath<T.Program>): void {
    // Other transforms (e.g. @preact/preset-vite) prepend several imports
    // above the directive — do not assume a fixed position.
    for (const stmt of programPath.get("body")) {
      if (
        stmt.isExpressionStatement() &&
        stmt.node.expression.type === "StringLiteral" &&
        stmt.node.expression.value === "use client"
      ) {
        programPath.node.directives.push(t.directive(t.directiveLiteral("use client")));
        stmt.remove();
        return;
      }
    }
  }

  // Check if a function node has a "use client" directive in its body
  function functionHasUseClient(node?: T.Node | null): boolean {
    if (!node) return false;
    if (t.isFunctionDeclaration(node) || t.isFunctionExpression(node)) {
      return hasUseClientDirective(node.body);
    }
    if (t.isArrowFunctionExpression(node)) {
      // Arrow with block body has directives; arrow with expression body cannot have directives
      return t.isBlockStatement(node.body) && hasUseClientDirective(node.body);
    }
    return false;
  }

  // Create a call to __pp_create_ref(fn, name)
  function createRefCall(
    fnExpression: T.Expression | string,
    nameString: string,
    _scope?: Scope,
  ): T.CallExpression {
    const fnIdentifier =
      typeof fnExpression === "string" ? t.identifier(fnExpression) : fnExpression;
    return t.callExpression(t.identifier("__pp_create_ref"), [
      fnIdentifier,
      t.stringLiteral(nameString),
    ]);
  }

  function generateDoubleUid(scope: Scope, base: string): T.Identifier {
    const id = scope.generateUidIdentifier(base);
    // generateUidIdentifier produces `_pp_...`; we need `__pp_...`
    if (id.name.startsWith("_") && !id.name.startsWith("__")) {
      id.name = `_${id.name}`;
    }
    return id;
  }

  // Create a new variable declaration for a ref
  function createRefVarDecl(
    refName: string,
    fnExpression: T.Expression | string,
    exportName: string,
    scope: Scope,
  ): { decl: T.VariableDeclaration; id: T.Identifier } {
    const refId = generateDoubleUid(scope, `__pp_ref_${refName}`);
    const refCall = createRefCall(fnExpression, exportName, scope);
    return {
      decl: t.variableDeclaration("const", [t.variableDeclarator(refId, refCall)]),
      id: refId,
    };
  }

  // Register a server-side implementation for `virtual:server-load-module`:
  // ((globalThis.__pp_server_modules ??= {})[MOD] ??= {})[NAME] = IMPL;
  // Direct identifier references keep this minifier-safe (no export names
  // involved), and the MOD string travels through the same placeholder
  // rewriting as `$mod`, so registry keys match encoded references at runtime.
  function createRegisterStmt(
    modString: string,
    nameString: string,
    impl: T.Expression,
  ): T.ExpressionStatement {
    const registry = t.memberExpression(
      t.identifier("globalThis"),
      t.identifier("__pp_server_modules"),
    );
    const ensureRegistry = t.assignmentExpression("??=", registry, t.objectExpression([]));
    const modSlot = t.memberExpression(ensureRegistry, t.stringLiteral(modString), true);
    const ensureMod = t.assignmentExpression("??=", modSlot, t.objectExpression([]));
    const nameSlot = t.memberExpression(ensureMod, t.stringLiteral(nameString), true);
    return t.expressionStatement(t.assignmentExpression("=", nameSlot, impl));
  }

  // Handler for `export function foo() {}`
  function handleExportFunctionDeclaration(
    path: NodePath<T.ExportNamedDeclaration>,
    mod: string,
    _state: ClientReferenceState,
  ) {
    const functionDecl = path.node.declaration;
    if (!functionDecl || !t.isFunctionDeclaration(functionDecl)) return;
    if (!functionDecl.id) return;
    const functionName = functionDecl.id.name;
    const exportName = functionName; // named export with same name

    // 1. Remove export keyword from function declaration
    const plainFunction = t.functionDeclaration(
      functionDecl.id,
      functionDecl.params,
      functionDecl.body,
      functionDecl.generator ?? false,
      functionDecl.async ?? false,
    );
    // Copy directives if any
    plainFunction.body.directives = functionDecl.body.directives;

    // 2. Create ref variable: const __pp_ref_Name = __pp_create_ref(Name, "Name");
    const { decl: refDecl, id: refId } = createRefVarDecl(
      functionName,
      t.identifier(functionName),
      exportName,
      path.scope,
    );

    // 3. Create export specifier: export { __pp_ref_Name as Name };
    const exportSpecifier = t.exportNamedDeclaration(null, [
      t.exportSpecifier(refId, t.identifier(exportName)),
    ]);

    // 4. Register the server implementation for virtual:server-load-module.
    const register = createRegisterStmt(mod, exportName, refId);

    // Replace the original export declaration with these nodes
    path.replaceWithMultiple([plainFunction, refDecl, register, exportSpecifier]);
  }

  // Handler for `export { foo, bar as baz };`
  function handleExportSpecifiers(
    path: NodePath<T.ExportNamedDeclaration>,
    mod: string,
    _state: ClientReferenceState,
  ) {
    const specifiers = path.node.specifiers;
    const replacements: T.Statement[] = [];

    specifiers.forEach((spec) => {
      if (!t.isExportSpecifier(spec)) return; // skip ExportNamespaceSpecifier
      const localName = spec.local.name;
      const exportedName = t.isIdentifier(spec.exported) ? spec.exported.name : spec.exported.value;

      // Create ref variable: const __pp_ref_local = __pp_create_ref(local, "exported");
      const { decl: refDecl, id: refId } = createRefVarDecl(
        localName,
        t.identifier(localName),
        exportedName,
        path.scope,
      );

      // Create export specifier: export { __pp_ref_local as exported };
      const exportSpecifier = t.exportNamedDeclaration(null, [
        t.exportSpecifier(refId, t.identifier(exportedName)),
      ]);

      replacements.push(refDecl);
      replacements.push(createRegisterStmt(mod, exportedName, refId));
      replacements.push(exportSpecifier);
    });

    path.replaceWithMultiple(replacements);
  }

  // Handler for default export
  function handleDefaultExport(
    path: NodePath<T.ExportDefaultDeclaration>,
    mod: string,
    _state: ClientReferenceState,
  ) {
    const declaration = path.node.declaration;

    // Case: export default function Foo() {}
    if (t.isFunctionDeclaration(declaration)) {
      const functionName = declaration.id ? declaration.id.name : "__default_anon";
      const actualName = declaration.id ? functionName : null;

      // Remove export keyword, keep declaration
      const plainFunction = t.functionDeclaration(
        actualName ? t.identifier(functionName) : null,
        declaration.params,
        declaration.body,
        declaration.generator ?? false,
        declaration.async ?? false,
      );
      if (plainFunction.body) plainFunction.body.directives = declaration.body.directives;

      // If anonymous, we need to give it a name for referencing
      const fnId = actualName
        ? t.identifier(actualName)
        : path.scope.generateUidIdentifier("__pp_default");
      if (!actualName) {
        plainFunction.id = fnId;
      }

      // Create ref var
      const { decl: refDecl, id: refId } = createRefVarDecl("default", fnId, "default", path.scope);

      // export default __pp_ref_default;
      const exportDefault = t.exportDefaultDeclaration(refId);

      path.replaceWithMultiple([
        plainFunction,
        refDecl,
        createRegisterStmt(mod, "default", refId),
        exportDefault,
      ]);
    }
    // Case: export default function() {} or export default () => {}
    else if (t.isFunctionExpression(declaration) || t.isArrowFunctionExpression(declaration)) {
      const fnId = path.scope.generateUidIdentifier("__pp_default");

      // Assign the function expression to the generated id
      const fnDecl = t.variableDeclaration("const", [t.variableDeclarator(fnId, declaration)]);

      // Create ref var
      const { decl: refDecl, id: refId } = createRefVarDecl("default", fnId, "default", path.scope);

      const exportDefault = t.exportDefaultDeclaration(refId);

      path.replaceWithMultiple([
        fnDecl,
        refDecl,
        createRegisterStmt(mod, "default", refId),
        exportDefault,
      ]);
    }
    // Case: export default localIdentifier;
    else if (t.isIdentifier(declaration)) {
      const localName = declaration.name;

      // Create ref var
      const { decl: refDecl, id: refId } = createRefVarDecl(
        "default",
        t.identifier(localName),
        "default",
        path.scope,
      );

      // export default __pp_ref_default;
      const exportDefault = t.exportDefaultDeclaration(refId);

      path.replaceWithMultiple([
        refDecl,
        createRegisterStmt(mod, "default", refId),
        exportDefault,
      ]);
    } else {
      // Unsupported default export type
      throw path.buildCodeFrameError('Unsupported default export in "use client" module.');
    }
  }

  // Handler for re-exports: export { foo } from "mod";
  function handleReExport(
    path: NodePath<T.ExportNamedDeclaration>,
    mod: string,
    _state: ClientReferenceState,
  ) {
    const { source, specifiers } = path.node;

    if (!source) return;

    const replacements: T.Statement[] = [];

    specifiers.forEach((spec) => {
      if (t.isExportSpecifier(spec)) {
        const importedName = spec.local.name; // name exported by source module
        const exportedName = t.isIdentifier(spec.exported)
          ? spec.exported.name
          : spec.exported.value;

        // import { importedName as __pp_imported_<name> } from source;
        const importLocal = path.scope.generateUidIdentifier(`__pp_imported_${importedName}`);
        const importDecl = t.importDeclaration(
          [t.importSpecifier(importLocal, t.identifier(importedName))],
          t.stringLiteral(source.value),
        );

        // const __pp_ref_<name> = __pp_create_ref(__pp_imported_<name>, "<exported>");
        const { decl: refDecl, id: refId } = createRefVarDecl(
          exportedName,
          importLocal,
          exportedName,
          path.scope,
        );

        // export { __pp_ref_<name> as exportedName };
        const exportSpecifier = t.exportNamedDeclaration(null, [
          t.exportSpecifier(refId, t.identifier(exportedName)),
        ]);

        replacements.push(importDecl);
        replacements.push(refDecl);
        replacements.push(createRegisterStmt(mod, exportedName, refId));
        replacements.push(exportSpecifier);
      } else if (t.isExportDefaultSpecifier(spec)) {
        // export { default } from "mod";
        // import { default as __pp_imported_default } from source;
        const importLocal = path.scope.generateUidIdentifier("__pp_imported_default");
        const importDecl = t.importDeclaration(
          [t.importDefaultSpecifier(importLocal)],
          t.stringLiteral(source.value),
        );

        // const __pp_ref_default = __pp_create_ref(__pp_imported_default, "default");
        const { decl: refDecl, id: refId } = createRefVarDecl(
          "default",
          importLocal,
          "default",
          path.scope,
        );

        // export { __pp_ref_default as default };
        const exportSpecifier = t.exportNamedDeclaration(null, [
          t.exportSpecifier(refId, t.identifier("default")),
        ]);

        replacements.push(importDecl);
        replacements.push(refDecl);
        replacements.push(createRegisterStmt(mod, "default", refId));
        replacements.push(exportSpecifier);
      }
    });

    path.replaceWithMultiple(replacements);
  }

  return {
    name: "pp-client-references",
    visitor: {
      Program(path, state) {
        if (!state.opts.mod || !state.opts.deps) {
          throw new Error("an option, either `mod` or `deps`.");
        }
        let mod = state.opts.mod;
        let deps = state.opts.deps;

        // Process function-level "use client" directives
        function processFunctionLevel(
          programPath: NodePath<T.Program>,
          state: ClientReferenceState,
          onTransformed?: () => void,
        ) {
          let transformed = false;
          programPath.traverse({
            Function(path: NodePath<T.Function>) {
              const node = path.node as T.Function & { __ppProcessed?: boolean };
              if (!functionHasUseClient(node)) return;

              // Prevent processing the same function twice (e.g., after replacement)
              if (node.__ppProcessed) return;
              node.__ppProcessed = true;

              // Hoist and bind function
              transformFunctionLevel(path, programPath, state);
              transformed = true;
            },
          });

          if (transformed) {
            onTransformed?.();
          }
        }

        // Build the __pp_create_ref helper function AST once
        function buildCreateRefHelper() {
          // function __pp_create_ref(fn, name, bound) {
          //   var boundArgs = bound || [];
          //   var ref = function() {
          //     return fn.apply(this, boundArgs.concat(Array.prototype.slice.call(arguments)));
          //   };
          //   ref.$type = Symbol.for("pp.client-reference");
          //   ref.$mod = "__PP_MOD__<hash>";
          //   ref.$name = name;
          //   ref.$deps = ["__PP_DEPS__<hash>"];
          //   ref.$bound = boundArgs;
          //   ref.bind = function() {
          //     var start = (arguments.length > 0 && arguments[0] === null) ? 1 : 0;
          //     var newBound = boundArgs.concat(Array.prototype.slice.call(arguments, start));
          //     return __pp_create_ref(fn, name, newBound);
          //   };
          //   return ref;
          // }

          const fnParam = t.identifier("fn");
          const nameParam = t.identifier("name");
          const boundParam = t.identifier("bound");

          // Array.prototype.slice
          const arrayProtoSlice = t.memberExpression(
            t.memberExpression(t.identifier("Array"), t.identifier("prototype")),
            t.identifier("slice"),
          );
          const argumentsId = t.identifier("arguments");

          const boundArgsId = t.identifier("boundArgs");
          const refId = t.identifier("ref");
          const newBoundId = t.identifier("newBound");

          // var boundArgs = bound || [];
          const boundArgsInit = t.variableDeclaration("var", [
            t.variableDeclarator(
              boundArgsId,
              t.logicalExpression("||", boundParam, t.arrayExpression([])),
            ),
          ]);

          // fn.apply(this, boundArgs.concat(Array.prototype.slice.call(arguments)))
          const applyCall = t.callExpression(t.memberExpression(fnParam, t.identifier("apply")), [
            t.thisExpression(),
            t.callExpression(t.memberExpression(boundArgsId, t.identifier("concat")), [
              t.callExpression(t.memberExpression(arrayProtoSlice, t.identifier("call")), [
                argumentsId,
              ]),
            ]),
          ]);

          // var ref = function() { ... }
          const refFunction = t.functionExpression(
            null,
            [],
            t.blockStatement([t.returnStatement(applyCall)]),
          );

          const refDecl = t.variableDeclaration("var", [t.variableDeclarator(refId, refFunction)]);

          // ref.$type = Symbol.for("pp.client-reference");
          const assignType = t.assignmentExpression(
            "=",
            t.memberExpression(refId, t.identifier("$type")),
            t.callExpression(t.memberExpression(t.identifier("Symbol"), t.identifier("for")), [
              t.stringLiteral("pp.client-reference"),
            ]),
          );

          // ref.$mod = "__PP_MOD__<hash>";
          const assignMod = t.assignmentExpression(
            "=",
            t.memberExpression(refId, t.identifier("$mod")),
            t.stringLiteral(mod),
          );

          // ref.$name = name;
          const assignName = t.assignmentExpression(
            "=",
            t.memberExpression(refId, t.identifier("$name")),
            nameParam,
          );

          // ref.$deps = ["__PP_DEPS__<hash>"];
          const assignDeps = t.assignmentExpression(
            "=",
            t.memberExpression(refId, t.identifier("$deps")),
            t.arrayExpression(deps.map((dep) => t.stringLiteral(dep))),
          );

          // ref.$bound = boundArgs;
          const assignBound = t.assignmentExpression(
            "=",
            t.memberExpression(refId, t.identifier("$bound")),
            boundArgsId,
          );

          // var start = (arguments.length > 0 && arguments[0] === null) ? 1 : 0  -> skip `this` when bind(null, ...)
          const startId = t.identifier("start");
          const startInit = t.variableDeclaration("var", [
            t.variableDeclarator(
              startId,
              t.conditionalExpression(
                t.logicalExpression(
                  "&&",
                  t.binaryExpression(
                    ">",
                    t.memberExpression(argumentsId, t.identifier("length")),
                    t.numericLiteral(0),
                  ),
                  t.binaryExpression(
                    "===",
                    t.memberExpression(argumentsId, t.numericLiteral(0), true),
                    t.nullLiteral(),
                  ),
                ),
                t.numericLiteral(1),
                t.numericLiteral(0),
              ),
            ),
          ]);

          // var newBound = boundArgs.concat(Array.prototype.slice.call(arguments, start));
          const newBoundInit = t.variableDeclaration("var", [
            t.variableDeclarator(
              newBoundId,
              t.callExpression(t.memberExpression(boundArgsId, t.identifier("concat")), [
                t.callExpression(t.memberExpression(arrayProtoSlice, t.identifier("call")), [
                  argumentsId,
                  startId,
                ]),
              ]),
            ),
          ]);

          // return __pp_create_ref(fn, name, newBound);
          const returnCreateRef = t.returnStatement(
            t.callExpression(t.identifier("__pp_create_ref"), [fnParam, nameParam, newBoundId]),
          );

          // ref.bind = function() { ... }
          const bindFunction = t.functionExpression(
            null,
            [],
            t.blockStatement([startInit, newBoundInit, returnCreateRef]),
          );

          const assignBind = t.assignmentExpression(
            "=",
            t.memberExpression(refId, t.identifier("bind")),
            bindFunction,
          );

          // return ref;
          const returnRef = t.returnStatement(refId);

          const helperBody = t.blockStatement([
            boundArgsInit,
            refDecl,
            t.expressionStatement(assignType),
            t.expressionStatement(assignMod),
            t.expressionStatement(assignName),
            t.expressionStatement(assignDeps),
            t.expressionStatement(assignBound),
            t.expressionStatement(assignBind),
            returnRef,
          ]);

          return t.functionDeclaration(
            t.identifier("__pp_create_ref"),
            [fnParam, nameParam, boundParam],
            helperBody,
          );
        }

        // Process module-level "use client" exports
        function processModuleLevelExports(
          programPath: NodePath<T.Program>,
          state: ClientReferenceState,
        ) {
          ensureHelper(programPath, state);

          // Collect all export declarations up front; transforming during traversal
          // would revisit the exports we ourselves create and loop forever.
          const namedExportPaths: NodePath<T.ExportNamedDeclaration>[] = [];
          const defaultExportPaths: NodePath<T.ExportDefaultDeclaration>[] = [];

          programPath.traverse({
            ExportNamedDeclaration(path: NodePath<T.ExportNamedDeclaration>) {
              if (path.node.source) {
                // Re-export from another module
                namedExportPaths.push(path);
              } else if (path.node.declaration) {
                // export function foo() {}
                if (t.isFunctionDeclaration(path.node.declaration)) {
                  namedExportPaths.push(path);
                } else {
                  // Other declarations (var, let, const) are not transformed unless they export functions.
                  // We'll skip for now.
                  path.skip();
                }
              } else if (path.node.specifiers.length > 0) {
                // export { foo, bar as baz };
                namedExportPaths.push(path);
              }
            },

            ExportDefaultDeclaration(path: NodePath<T.ExportDefaultDeclaration>) {
              defaultExportPaths.push(path);
            },

            ExportAllDeclaration(path: NodePath<T.ExportAllDeclaration>) {
              // export * from "module"
              // Cannot statically transform; throw an error
              throw path.buildCodeFrameError(
                '"use client" modules cannot use `export *` statements. Use explicit named exports instead.',
              );
            },
          });

          for (const path of namedExportPaths) {
            if (path.node.source) {
              handleReExport(path, mod, state);
            } else if (path.node.declaration) {
              handleExportFunctionDeclaration(path, mod, state);
            } else {
              handleExportSpecifiers(path, mod, state);
            }
          }

          for (const path of defaultExportPaths) {
            handleDefaultExport(path, mod, state);
          }
        }

        // Ensure the helper is inserted at the top of the program
        function ensureHelper(programPath: NodePath<T.Program>, state: ClientReferenceState) {
          if (state.helperInserted) return;
          state.helperInserted = true;

          const helper = buildCreateRefHelper();
          // Insert after any existing directives (e.g., "use strict")
          // const body = programPath.get("body");
          // let insertIndex = 0;
          // if (programPath.node.directives && programPath.node.directives.length > 0) {
          //   insertIndex = programPath.node.directives.length;
          // }
          // Find the index of the first statement after directives
          // Actually, directives are not separate statements, they are part of the first statement's directives.
          // We'll just unshift at the beginning; Babel will handle directives correctly.
          programPath.unshiftContainer("body", helper);
        }

        function transformFunctionLevel(
          functionPath: NodePath<T.Function>,
          programPath: NodePath<T.Program>,
          state: ClientReferenceState,
        ) {
          ensureHelper(programPath, state);

          const originalNode = functionPath.node;
          const originalName =
            (t.isFunctionDeclaration(originalNode) || t.isFunctionExpression(originalNode)) &&
            originalNode.id
              ? originalNode.id.name
              : "anonymous";
          const functionScope = functionPath.scope;

          // 1. Collect free variables (identifiers used but not declared in function)
          const freeVars = new Set<string>();

          // Collect all referenced identifiers inside the function
          functionPath.traverse({
            Identifier(innerPath: NodePath<T.Identifier>) {
              const name = innerPath.node.name;
              if (
                name === "this" ||
                name === "arguments" ||
                name === "super" ||
                name === "new.target"
              )
                return;
              if (!innerPath.isReferencedIdentifier()) return;
              // Ignore function ids (their binding lives in the surrounding scope,
              // so they must not be treated as free variables of the function itself)
              const parentNode = innerPath.parent;
              if (
                (t.isFunctionDeclaration(parentNode) || t.isFunctionExpression(parentNode)) &&
                parentNode.id === innerPath.node
              )
                return;

              // Resolve the identifier's actual binding so shadowed bindings in
              // nested scopes are not mistaken for captures from an outer scope.
              const binding = innerPath.scope.getBinding(name);
              if (!binding) return; // global (e.g. console, alert, Promise)
              // Module-scope bindings (imports, top-level declarations) remain in
              // scope after the function is hoisted to the program top, so they do
              // not need to be captured in `$bound`.
              if (binding.scope.path.isProgram()) return;
              // Bindings declared in this function or one of its nested scopes are
              // not free variables.
              if (isWithinScope(binding.scope, functionScope)) return;
              freeVars.add(name);
            },
          });

          // 2. Create hoisted function
          // Clone the original function, remove directives, add free vars as parameters
          const hoistedId = programPath.scope.generateUidIdentifier(`__pp_hoisted_${originalName}`);
          const hoistedParams = [...freeVars].map((name) => t.identifier(name));

          let hoistedFn: T.FunctionDeclaration;
          if (t.isFunctionDeclaration(originalNode)) {
            hoistedFn = t.functionDeclaration(
              hoistedId,
              [...hoistedParams, ...originalNode.params],
              originalNode.body,
              originalNode.generator ?? false,
              originalNode.async ?? false,
            );
          } else if (
            t.isFunctionExpression(originalNode) ||
            t.isArrowFunctionExpression(originalNode)
          ) {
            // Convert to function declaration (arrow becomes function)
            const body = originalNode.body;
            hoistedFn = t.functionDeclaration(
              hoistedId,
              [...hoistedParams, ...originalNode.params],
              t.isBlockStatement(body) ? body : t.blockStatement([t.returnStatement(body)]),
              originalNode.generator ?? false,
              originalNode.async ?? false,
            );
          } else {
            return; // unsupported
          }

          // Remove any directives from hoisted function body
          hoistedFn.body.directives = [];

          // Insert hoisted function at top of program
          programPath.unshiftContainer("body", hoistedFn);

          // 3. Create ref for hoisted function
          // const __pp_ref_<name> = __pp_create_ref(hoistedId, "_pp_hoisted_<originalName>");
          const { decl: refDecl, id: refId } = createRefVarDecl(
            originalName,
            hoistedId,
            hoistedId.name,
            programPath.scope,
          );
          // We need to insert this after the hoisted function, but we can unshift again; order will be [refDecl, hoistedFn] but we want [hoistedFn, refDecl].
          // Instead, we can insert ref after the hoisted function by using path.insertAfter on the hoisted function's path.
          const hoistedPath = programPath.get("body.0"); // the hoisted function we just inserted
          hoistedPath.insertAfter(refDecl);

          // Register the ref for `virtual:server-load-module` (keyed by
          // `$mod`/`$name`). The decoder derives bound copies through the
          // ref's own `.bind`, so registered values stay client references
          // that re-encode as `$R` tokens. Direct identifier references keep
          // this minifier-safe.
          programPath.pushContainer("body", createRegisterStmt(mod, hoistedId.name, refId));

          // 4. At original definition site, replace with .bind(null, ...freeVars)
          const freeVarIdentifiers = [...freeVars].map((name) => t.identifier(name));
          const bindCall = t.callExpression(t.memberExpression(refId, t.identifier("bind")), [
            t.nullLiteral(),
            ...freeVarIdentifiers,
          ]);

          if (t.isFunctionDeclaration(originalNode)) {
            if (!originalNode.id) return;
            // Replace `function original() {}` with `const original = __pp_ref_orig.bind(null, ...);`
            const varDecl = t.variableDeclaration("const", [
              t.variableDeclarator(t.identifier(originalNode.id.name), bindCall),
            ]);
            functionPath.replaceWith(varDecl);
          } else {
            // For expressions, replace the function node itself
            functionPath.replaceWith(bindCall);
          }
        }

        // Save program path for helper insertion
        const st = state as ClientReferenceState;
        st.programPath = path;
        st.helperInserted = false;

        reviveDemotedDirective(path);

        // Check for module-level "use client"
        const hasModuleUseClient = hasUseClientDirective(path.node);

        if (hasModuleUseClient) {
          // Module-level transform
          processModuleLevelExports(path, st);
          state.opts.onTransformed?.();
        } else {
          // Function-level transform
          processFunctionLevel(path, st, state.opts.onTransformed);
        }
      },
    },
  };
}
