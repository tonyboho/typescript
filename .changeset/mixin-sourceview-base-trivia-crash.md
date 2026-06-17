---
"ts-mixin-class": patch
---

Fix a source-view (tsserver/IDE) crash where quickinfo and rename on a mixin name threw "Did not expect InterfaceDeclaration to have an Identifier in its trivia". The generated `$base` interface/class reused the original class's text range, which for a `@mixin` class reaches back over the `@mixin()` decorator — stranding the decorator's `mixin` identifier in the node's trivia gap. Decorated `$base` helpers (never navigated to) now collapse to a fully-synthetic range; and a generic `$base`'s type parameters now span the source `<...>` instead of a zero-width range past them, which had stranded the source type-parameter name (the `A` in `Consumer<A>`).
