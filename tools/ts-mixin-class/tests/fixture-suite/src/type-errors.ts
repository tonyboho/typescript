import { RequiredMixin } from "./mixins.js"
import { mixin } from "ts-mixin-class"

class UnrelatedRequiredConsumerBase {
}

// @ts-expect-error RequiredMixin requires a RequiredBase-compatible consumer base.
class BadRequiredConsumer extends UnrelatedRequiredConsumerBase implements RequiredMixin {
}

@mixin()
class LinearizationA {
}

@mixin()
class LinearizationB {
}

@mixin()
class LinearizationX implements LinearizationA, LinearizationB {
}

@mixin()
class LinearizationY implements LinearizationB, LinearizationA {
}

@mixin()
class BadLinearizationMixin implements LinearizationX, LinearizationY {
}

// @ts-expect-error BadLinearizationMixin has inconsistent C3 requirements.
class BadLinearizationConsumer implements BadLinearizationMixin {
}

@mixin()
class StaticCollisionLeftMixin {
    static shared: string = "left"
}

@mixin()
class StaticCollisionRightMixin {
    static shared: number = 1
}

// @ts-expect-error StaticCollisionLeftMixin and StaticCollisionRightMixin have incompatible static members.
class BadStaticCollisionConsumer implements StaticCollisionLeftMixin, StaticCollisionRightMixin {
}

void [ BadRequiredConsumer, BadLinearizationConsumer, BadStaticCollisionConsumer ]
