// Generation tools until providers land (phase 8): listed, never executed.
import { capabilityUnavailableMessage, type ToolCapability } from "@opennan/mcp-schema";
import { unavailable } from "../outcome";
import type { ToolHandler } from "./types";

export const capabilityUnavailable: ToolHandler = async (_args, { tool }) => {
    const capability = tool.capability as ToolCapability;
    return unavailable(capabilityUnavailableMessage(tool.name, capability), capability);
};
