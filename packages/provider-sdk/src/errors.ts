// Typed errors of the provider SDK (spec §10): a missing capability is guidance, not a crash.
import { capabilityUnavailableMessage, isOpenNanCapability, type ToolCapability } from "./capabilities";

export type UnavailableReason = "connect-opennan" | "needs-provider";

/** No registered provider offers the capability. The UI shows `message` as guidance. */
export class CapabilityUnavailableError extends Error {
    readonly capability: ToolCapability;
    readonly reason: UnavailableReason;

    constructor(capability: ToolCapability, feature: string = capability) {
        super(capabilityUnavailableMessage(feature, capability));
        this.name = "CapabilityUnavailableError";
        this.capability = capability;
        this.reason = isOpenNanCapability(capability) ? "connect-opennan" : "needs-provider";
    }
}

/** ProviderRegistry.register() refused a provider (opennan.* rule, duplicate id, unknown capability). */
export class ProviderRegistrationError extends Error {
    constructor(message: string) {
        super(message);
        this.name = "ProviderRegistrationError";
    }
}

/** A job ended in "failed"; the message is the provider's. `refunded`: the provider says nothing was charged. */
export class JobFailedError extends Error {
    readonly code?: string;
    readonly refunded?: boolean;

    constructor(message: string, options?: { cause?: unknown; code?: string; refunded?: boolean }) {
        super(message, options?.cause === undefined ? undefined : { cause: options.cause });
        this.name = "JobFailedError";
        if (options?.code !== undefined) this.code = options.code;
        if (options?.refunded !== undefined) this.refunded = options.refunded;
    }
}

/** A job ended in "cancelled". */
export class JobCancelledError extends Error {
    constructor(message = "The job was cancelled") {
        super(message);
        this.name = "JobCancelledError";
    }
}
