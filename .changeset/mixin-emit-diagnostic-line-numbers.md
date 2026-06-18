---
"ts-mixin-class": patch
---

Fix `tsc` reporting type errors on the **wrong line** for files containing a mixin class. The emit path reprints the transformed (value-cast) tree to text — mixin expansion adds and removes lines — so diagnostics landed on regenerated lines that do not exist in the source on disk, diverging from the IDE / `--noEmit` positions (a problem for CI logs and error navigation). The transformer now captures the printer's source map for each reprinted file and remaps every emit-path diagnostic (`getSyntactic`/`getSemantic`/`getDeclarationDiagnostics` and `emit`) back to its real source position, so `tsc` and the editor agree. The reprinted tree is still what gets emitted, so runtime output is unchanged.
