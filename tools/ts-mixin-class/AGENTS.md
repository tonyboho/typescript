# Agent Notes: ts-mixin-class

This package follows the same broad shape as `tools/ts-lazy-property`: it is intended to
be a `ts-patch` ProgramTransformer, not a regular runtime library.

Current skeleton behavior:

- Entry point: `src/index.ts`.
- Default export: `transformProgram`.
- The transformer detects class decorators imported from this package.
- The default marker is `@mixin(...)`, imported as a named import or through a namespace
  import from `ts-mixin-class`.
- A detected marker decorator is removed from the class AST. The actual mixin expansion is
  intentionally not implemented yet.

Keep import-aware detection. A local function named `mixin` must not be treated as the
package marker.

When the future implementation starts generating class members for mixins, keep the root
`AGENTS.md` rule in mind: mixin class members must not use `private` or `protected`.
