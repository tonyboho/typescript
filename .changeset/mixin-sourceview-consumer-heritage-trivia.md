---
"ts-mixin-class": patch
---

Fix tsserver crashes ("Did not expect <kind> to have an Identifier in its trivia")
when navigating an `implements`-only mixin consumer in source view. Two facets:
the generated `extends $base` was stretched over the dropped source `implements`
clause, and the generated `$base` class's metadata cast (`(Object as unknown as
...)`) was mapped onto the source heritage types it cannot cover. The consumer now
keeps its real `implements` clause (matching the emit path) so those mixin
references stay navigable, the generated `extends` is pinned to a tight synthetic
range, and any metadata-cast heritage clause is pinned to a tight synthetic range
rather than stretched over source.
