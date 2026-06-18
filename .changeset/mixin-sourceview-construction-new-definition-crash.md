---
"ts-mixin-class": patch
---

Fix a tsserver crash ("Cannot read properties of undefined (reading 'members')")
when running go-to-definition or rename on a construction-base mixin's generated
`Mixin.new(...)` in source view. The generated `static new` carried an
`originalNode` to the original class, which only exists in the throwaway clone the
program never binds; tsserver mapped the overload back to that unbound clone and
crashed in the checker. The construction members now skip `setOriginalNode` in
source view (they are fully synthetic and need no original for declaration emit).
