// Provider capabilities that MCP generation tools need (spec §5.4, §5.11). The provider SDK owns the lists and
// the guidance text; this module re-exports them so tool definitions and hosts keep one import.
export {
    OPEN_CAPABILITIES, OPENNAN_CAPABILITIES, PROVIDER_RUNTIME_CAPABILITIES,
    isToolCapability, isOpenNanCapability, isProviderRuntimeCapability, capabilityUnavailableMessage,
    type OpenCapability, type OpenNanCapability, type ProviderRuntimeCapability, type ToolCapability,
} from "@opennan/provider-sdk";
