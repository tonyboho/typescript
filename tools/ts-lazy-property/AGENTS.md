# Agent Notes: ts-lazy-property

This package is a `ts-patch` **ProgramTransformer**, not a normal emit transformer.
It rewrites the `Program` before type checking so `@lazy()` class properties are visible
to the binder/checker as:

```ts
@lazy()
value: T = init
```

roughly becoming:

```ts
$value: T | undefined = undefined
get value(): T { ... }
set value(value: T) { ... }
```

## Core Shape

- Entry point: `src/index.ts`, default export `transformProgram`.
- `transformProgram` creates a new `Program` with `createLazyPropertyCompilerHost`.
- The host wraps `getSourceFile`.
- Emit path prints transformed AST to text, then reparses that text.
- IDE / tsserver path keeps original `sourceFile.text` and mutates only virtual AST shape with `preserveLazyDecorator: true`.

Do not casually convert this into a regular `before` transformer. The point is that
the checker must see generated members before semantic diagnostics and editor features.

## TypeScript Internals Learned Here

The false `TS2551 Property '$lazyProperty' does not exist...` bug was not fixed by
filtering diagnostics. Filtering was removed.

What happened:

- TypeScript creates class member symbols in binder via `declareClassMember`.
- Property access is checked in `checkPropertyAccessExpressionOrQualifiedName`.
- Missing property diagnostics come from `reportNonexistentProperty`.
- Class type/member caches live around `symbol.members`, `declaredType`,
  `declaredProperties`, and structured type member resolution.
- A previous workaround used a second diagnostics `Program` with `oldProgram`.
  That made diagnostics and navigation observe different checker/cache worlds.
- QuickInfo/GoTo Definition could work while diagnostics produced false `TS2551`.
- Current fix: use one fresh transformed `Program`; no generated backing diagnostic filter.

If a future bug tempts you to patch `getSemanticDiagnostics`, first suspect program/checker
reuse and SourceFile identity. A diagnostic filter is a last resort and should be tested
as a temporary workaround, not treated as architecture.

## SourceFile Rules

IDE mode must not share mutable language-service AST nodes with the transformed program.
TypeScript stores binder/checker/navigation state on nodes.

Keep these invariants:

- Clone SourceFiles before preserve-mode transformation.
- Keep `sourceFile.text` identical in preserve mode.
- Preserve source ranges for original nodes.
- Generated `$property` declaration name intentionally points at original `property` text.
- Run `setParentRecursive` after transforming.
- Keep `clearSynthesizedFlags`; rename/references treat synthesized nodes as non-source
  even when ranges are real.

These pieces are ugly but load-bearing. Tests cover them indirectly via tsserver
quickinfo, definition, rename, references, highlights, diagnostics, and source positions.

## Compatibility With Other Program Transformers

ts-patch composes `transformProgram` entries sequentially:

```text
original Program -> transformer A -> transformer B -> transformer C
```

But this only works if each transformer treats the incoming `program` as a possible
virtual AST layer. Do not assume `host.getSourceFile()` contains previous transformer
changes. Previous layers may have changed only the AST, not file text.

This transformer is written to be stackable:

- It receives `baseProgram` in `createLazyPropertyCompilerHost`.
- It compares `baseProgram.getSourceFile(fileName)` with `compilerHost.getSourceFile(...)`.
- If the incoming program has a different AST shape, that SourceFile is treated as the
  previous virtual layer.
- Layered SourceFiles are cloned as AST, not reparsed from text, so prior virtual nodes
  survive.
- If AST shape is identical, normal text reparse is used; this avoids TypeScript scanner
  failures seen when cloning ordinary compiler SourceFiles unnecessarily.

Regression test: `tests/program-transformer-composition.t.ts`.

When adding another similar transformer, follow the same layering rule:

```text
prefer incoming program SourceFile when it has virtual AST changes;
otherwise use compilerHost SourceFile;
clone before mutating;
never require previous virtual nodes to exist in source text.
```

## Test Expectations

Run at least:

```bash
pnpm --dir tools/ts-lazy-property test
pnpm --dir tools/ts-lazy-property run fixture
```

Important test groups:

- `source-transform.t.ts`: direct `transformSourceFile` AST expansion rules.
- `source-position-preservation.t.ts`: stable source positions outside generated lazy members.
- `diagnostic-locations.t.ts`: diagnostics point at source declarations, not decorators.
- `program-transformer-composition.t.ts`: previous virtual ProgramTransformer layer survives.
- `compiler-host-stale-source.t.ts`: stale-version compiler host regressions.
- `tsserver-source-file-view.t.ts`: tsserver sees original text plus transformed AST.
- `tsserver-editor-features.t.ts`: quickinfo/definition/references/highlights after live edits.
- `tsserver-diagnostic-recovery.t.ts`: typo -> fix IDE flows do not leave stale diagnostics.
- `tsserver-rename.t.ts`: rename behavior for regular and lazy properties.
- `fixture-build-and-runtime.t.ts`: installs, builds, and runs `tests/fixture-suite` as a real package.
- `tests/fixture-suite`: strict runtime suite compiled under standard and legacy decorator modes.

If you change AST construction, assume editor features can regress even when `tsc` passes.
