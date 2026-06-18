---
"ts-mixin-class": patch
---

Fix a tsserver crash ("Did not expect <kind> to have an Identifier in its trivia")
when navigating a generic construction-base mixin/consumer in source view. The
generated generic `static new<T>` overload deep-clones the class type parameters,
which keep their source positions while the method itself is pinned to a tiny
synthetic overload range; the stranded `T` identifier crashed tsserver's
getChildren (quickinfo/rename). The cloned type parameters are now collapsed to a
synthetic range so they normalise into the method's range with its other children.
