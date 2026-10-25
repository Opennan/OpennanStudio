// Desktop settings and secret names shared by main (validation, storage) and the renderer (Settings screen).
import { z } from "zod";

export const TERMINAL_PROFILES = ["claude", "codex", "gemini", "shell", "custom"] as const;
export type TerminalProfileId = (typeof TERMINAL_PROFILES)[number];

/** Per-capability provider picks and "Use OpenNan by default" (Settings → AI providers). */
export const ProviderRoutingSchema = z.object({
    overrides: z.record(z.string().regex(/^[a-z]+(\.[a-z-]+)+$/).max(64), z.string().regex(/^[a-z0-9_-]{1,64}$/)).refine((value) => Object.keys(value).length <= 64, { message: "too many overrides" }),
    opennanDefault: z.boolean(),
}).strict();

export const SettingsSchema = z.object({
    mcpPort: z.number().int().min(1024).max(65535),
    terminalCustomCommand: z.string().max(1024),
    terminalDefaultProfile: z.enum(TERMINAL_PROFILES),
    providerRouting: ProviderRoutingSchema,
    /** The first-launch Sign in with OpenNan prompt has been shown. */
    signInPrompted: z.boolean(),
});
export type DesktopSettings = z.infer<typeof SettingsSchema>;
export const SettingsPatchSchema = SettingsSchema.partial().strict();

export const DEFAULT_SETTINGS: DesktopSettings = {
    mcpPort: 4319, terminalCustomCommand: "", terminalDefaultProfile: "shell",
    providerRouting: { overrides: {}, opennanDefault: true }, signInPrompted: false,
};

/** API keys the app can keep. Each terminal profile gets its own key only (main/terminal/profiles.ts). */
export const SECRET_NAMES = ["ANTHROPIC_API_KEY", "OPENAI_API_KEY", "GEMINI_API_KEY", "OPENNAN_API_KEY", "FAL_KEY"] as const;
/** Keys Settings → AI providers manages (not the terminal's API keys list). */
export const PROVIDER_SECRET_NAMES: readonly SecretName[] = ["FAL_KEY"];
export type SecretName = (typeof SECRET_NAMES)[number];
export const SecretValueSchema = z.string().min(1).max(4096).regex(/^[\x21-\x7e]+$/, "API keys are printable characters without spaces");

export interface SecretStatus {
    name: SecretName;
    set: boolean;
}
