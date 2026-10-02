import type { NodePath, PluginAPI, PluginObject, PluginPass, Scope } from "@babel/core";
import type * as T from "@babel/types";

// Client transform for `"use client"` boundaries.
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
 * Client transform for `"use client"` boundaries.
 *
 * Mirrors the server transform's module/scoped directive handling, but
 * instead of creating client references it strips directives and keeps only
 * the browser implementation:
 *
 * - A module-level `"use client"` keeps every export as-is and drops the
 *   directive. No `__pp_create_ref` helper is emitted; the module already
 *   *is* the implementation the server's reference token names.
 * - A scoped `"use client"` hoists the function to the top of the module
 *   (free variables become leading parameters, exactly as on the server) and
 *   exports the hoisted function, so the client chunk exposes the same
 *   export name the reference's `$name` points at. Server-only code around
 *   the definition site is treeshaken: unreachable top-level bindings, their
 *   imports, and side-effect statements referencing only removed bindings are
 *   dropped, with export roots driving reachability.
 *
 * Like the server transform, demoted module-level directives (a plain
 * `"use client"` string statement left behind when another transform
 * prepends imports above it) are revived into real directives before
 * branching.
 */
export default function preactProgressiveClient(babel: PluginAPI): PluginObject {
  const { types: t } = babel;

  // Check for module-level "use client" directive in a body
  function hasUseClientDirective(body?: T.BlockStatement | T.Program | null): boolean {
    if (!body || !body.directives) return false;
    return body.directives.some((dir) => dir.value.value === "use client");
  }

  /**
   * Other transforms (e.g. @preact/preset-vite's injected `preact/debug`
   * import) can end up above the `"use client"` directive, demoting it from
   * a real directive to a plain string-expression statement. Revive such a
   * statement back into a program directive so the module-level branch is
   * detected.
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

  return {
    name: "pp-client-references",
    visitor: {
      Program(path, state) {
        let toKeep = new Set<any>();
        let hasClientDirective = false;

        // Process function-level "use client" directives
        function processFunctionLevel(
          programPath: NodePath<T.Program>,
          state: ClientReferenceState,
        ) {
          let processed = false;
          programPath.traverse({
            Function(path: NodePath<T.Function>) {
              const node = path.node as T.Function & { __ppProcessed?: boolean };
              if (!functionHasUseClient(node)) return;

              // Prevent processing the same function twice (e.g., after replacement)
              if (node.__ppProcessed) return;
              node.__ppProcessed = true;
              processed = true;
              hasClientDirective = true;

              // Hoist and bind function
              transformFunctionLevel(path, programPath, state);
            },
          });
          return processed;
        }

        function transformFunctionLevel(
          functionPath: NodePath<T.Function>,
          programPath: NodePath<T.Program>,
          _state: ClientReferenceState,
        ) {
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
              ) {
                return;
              }

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
          programPath.pushContainer("body", hoistedFn);

          // 3. Create the export specifier
          const exportSpecifier = t.exportNamedDeclaration(null, [
            t.exportSpecifier(hoistedId, hoistedId),
          ]);
          // We need to insert this after the hoisted function, but we can unshift again; order will be [refDecl, hoistedFn] but we want [hoistedFn, refDecl].
          // Instead, we can insert ref after the hoisted function by using path.insertAfter on the hoisted function's path.
          // const hoistedPath = programPath.get("body.0"); // the hoisted function we just inserted
          // const bodyPaths = programPath.get("body");
          // const hoistedPath = bodyPaths.filter((p) => p.isImportDeclaration()).pop() ?? bodyPaths.at(-1);
          // hoistedPath.insertAfter(exportSpecifier);
          programPath.pushContainer("body", exportSpecifier);

          toKeep.add(hoistedFn);
          toKeep.add(exportSpecifier);
        }

        // Save program path for helper insertion
        const st = state as ClientReferenceState;
        st.programPath = path;
        st.helperInserted = false;

        reviveDemotedDirective(path);

        // Check for module-level "use client"
        const hasModuleUseClient = hasUseClientDirective(path.node);

        if (hasModuleUseClient) {
          path.node.directives = path.node.directives.filter((d) => d.value.value !== "use client");
          hasClientDirective = true;
        } else {
          // Function-level transform
          // const referenced = findReferencedIdentifiers(path.parent as any);
          if (processFunctionLevel(path, st)) {
            for (let i = path.node.body.length - 1; i >= 0; i--) {
              const node = path.node.body[i];
              if (
                node.type !== "ImportDeclaration" &&
                !toKeep.has(node) &&
                node.type.startsWith("Export")
              ) {
                const toRemove = path.get("body").at(i);
                toRemove?.remove();
              }
            }
          }
          if (hasClientDirective) treeshakeCode(path);
          // deadCodeElimination(path.parent as any, referenced);
        }
      },
    },
  };
}

function treeshakeCode(programPath: NodePath<T.Program>) {
  const programScope = programPath.scope;

  // Collect all top-level bindings and how they are declared.
  const bindingInfo = Object.create(null);

  for (const name of Object.keys(programScope.bindings)) {
    const binding = programScope.bindings[name];
    if (binding.scope !== programScope) continue;

    if (
      binding.path.isImportSpecifier() ||
      binding.path.isImportDefaultSpecifier() ||
      binding.path.isImportNamespaceSpecifier()
    ) {
      bindingInfo[name] = {
        binding,
        kind: "import",
        declPath: binding.path.findParent((p) => p.isImportDeclaration()),
      };
    } else if (binding.path.isVariableDeclarator()) {
      bindingInfo[name] = {
        binding,
        kind: "variable",
        declPath: binding.path,
      };
    } else if (binding.path.isFunctionDeclaration() || binding.path.isClassDeclaration()) {
      bindingInfo[name] = {
        binding,
        kind: "declaration",
        declPath: binding.path,
      };
    }
  }

  function isJSXTagReference(path: NodePath) {
    const parent = path.parentPath;
    if (parent.isJSXOpeningElement() && parent.node.name === path.node) return true;
    if (parent.isJSXClosingElement() && parent.node.name === path.node) return true;
    if (parent.isJSXMemberExpression() && parent.node.object === path.node) return true;
    return false;
  }

  // Call `callback` for every top-level binding referenced inside `nodePath`.
  function forEachTopLevelReference(nodePath: NodePath, callback: (name: string) => void) {
    nodePath.traverse({
      Identifier(p) {
        if (!p.isReferencedIdentifier()) return;
        const name = p.node.name;
        const info = bindingInfo[name];
        if (!info) return;

        const binding = p.scope.getBinding(name);
        if (binding === info.binding) callback(name);
      },
      JSXIdentifier(p) {
        if (!isJSXTagReference(p)) return;
        const name = p.node.name;
        const info = bindingInfo[name];
        if (!info) return;

        const binding = p.scope.getBinding(name);
        if (binding === info.binding) callback(name);
      },
    });
  }

  function getBindingNames(path: NodePath) {
    const names = [];
    if (path.isIdentifier()) {
      names.push(path.node.name);
    } else {
      path.traverse({
        Identifier(p) {
          if (p.isBindingIdentifier()) names.push(p.node.name);
        },
      });
    }
    return names;
  }

  // Exports are the roots for reachability.
  const rootNames = new Set<string>();
  const extraRootPaths = [];

  for (const stmtPath of programPath.get("body")) {
    if (stmtPath.isExportNamedDeclaration()) {
      const decl = stmtPath.get("declaration");

      if (decl && decl.isVariableDeclaration()) {
        for (const declarator of decl.get("declarations")) {
          for (const name of getBindingNames(declarator.get("id"))) {
            rootNames.add(name);
          }
        }
      } else if (decl && (decl.isFunctionDeclaration() || decl.isClassDeclaration())) {
        if (decl.node.id) rootNames.add(decl.node.id.name);
      }

      const specifiers = stmtPath.get("specifiers") || [];
      for (const spec of specifiers) {
        if (spec.isExportSpecifier()) {
          const local = spec.get("local");
          if (local.isIdentifier()) rootNames.add(local.node.name);
        }
      }
    } else if (stmtPath.isExportDefaultDeclaration()) {
      const decl = stmtPath.get("declaration");

      if (decl.isFunctionDeclaration() || decl.isClassDeclaration()) {
        if (decl.node.id) {
          rootNames.add(decl.node.id.name);
        } else {
          // Anonymous default export: still need to traverse its body.
          extraRootPaths.push(decl);
        }
      } else if (decl.isIdentifier()) {
        rootNames.add(decl.node.name);
      } else {
        // `export default <expression>`
        extraRootPaths.push(decl);
      }
    }
  }

  const reachable = new Set();

  function markReachable(name: string) {
    const info = bindingInfo[name];
    if (!info || reachable.has(name)) return;

    reachable.add(name);

    // Import declarations don't have runtime references to other top-level bindings.
    if (info.kind === "import") return;

    forEachTopLevelReference(info.declPath, (refName) => {
      markReachable(refName);
    });
  }

  rootNames.forEach((name) => markReachable(name));
  extraRootPaths.forEach((path) => {
    forEachTopLevelReference(path, (name) => {
      markReachable(name);
    });
  });

  function hasUnreachableTopLevelReference(stmtPath: NodePath<T.Statement>) {
    let found = false;
    forEachTopLevelReference(stmtPath, (name) => {
      if (!reachable.has(name)) found = true;
    });
    return found;
  }

  // Precompute side-effect statements that reference removed top-level bindings.
  // This must happen before any declarations are removed, because Babel updates
  // scope bindings when we mutate the AST.
  const sideEffectStatementsToRemove = new Set<NodePath>();

  for (const stmtPath of programPath.get("body")) {
    // Only look at statements that are handled by the `default` branch later.
    if (
      stmtPath.isImportDeclaration() ||
      stmtPath.isVariableDeclaration() ||
      stmtPath.isFunctionDeclaration() ||
      stmtPath.isClassDeclaration() ||
      stmtPath.isExportNamedDeclaration() ||
      stmtPath.isExportDefaultDeclaration() ||
      stmtPath.isExportAllDeclaration()
    ) {
      continue;
    }

    if (hasUnreachableTopLevelReference(stmtPath)) {
      sideEffectStatementsToRemove.add(stmtPath);
    }
  }

  // Mutate the program: remove unreferenced top-level values and any
  // side-effect statement that references a removed top-level binding.
  const bodyPaths = [...programPath.get("body")];

  for (const stmtPath of bodyPaths) {
    if (stmtPath.removed) continue;

    switch (stmtPath.node.type) {
      case "ImportDeclaration": {
        // Keep side-effect-only imports.
        if (stmtPath.node.specifiers.length === 0) continue;

        const specifiers = stmtPath.get("specifiers") as NodePath[];
        const toRemove = specifiers.filter((spec) => !reachable.has((spec.node as any).local.name));

        if (toRemove.length === specifiers.length) {
          stmtPath.remove();
        } else {
          toRemove.forEach((spec) => spec.remove());
        }
        break;
      }

      case "VariableDeclaration": {
        const declarators = stmtPath.get("declarations") as NodePath[];
        const toRemove = declarators.filter((declarator) => {
          const names = getBindingNames(declarator.get("id") as NodePath);
          return !names.some((name) => reachable.has(name));
        });

        if (toRemove.length === declarators.length) {
          stmtPath.remove();
        } else {
          toRemove.forEach((declarator) => declarator.remove());
        }
        break;
      }

      case "FunctionDeclaration":
      case "ClassDeclaration": {
        const id = stmtPath.node.id;
        if (!id || !reachable.has(id.name)) {
          stmtPath.remove();
        }
        break;
      }

      case "ExportNamedDeclaration":
      case "ExportDefaultDeclaration":
      case "ExportAllDeclaration":
        // Exports are roots; leave them intact.
        break;

      default:
        // Side-effect statements referencing any removed top-level binding
        // were identified before mutation.
        if (sideEffectStatementsToRemove.has(stmtPath)) {
          stmtPath.remove();
        }
        break;
    }
  }
}
