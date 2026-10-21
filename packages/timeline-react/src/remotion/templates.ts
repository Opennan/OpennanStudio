// Template lookups (SRC/remotion/template-registry.ts:28-38): the registered Remotion add-on's templates, else the
// built-in graphics templates (phase 10d, timeline-core graphics), which the preview and both exports draw.
import { GRAPHICS_TEMPLATES } from "@opennan/timeline-core/graphics/templates";
import { getRemotionAddon, type TemplateDef } from "./registry";

export type { TemplateDef, TemplateParam } from "./registry";

export function getTemplates(): TemplateDef[] {
    return getRemotionAddon()?.templates ?? (GRAPHICS_TEMPLATES as TemplateDef[]);
}

export function templateById(id: string): TemplateDef | undefined {
    return getTemplates().find((template) => template.id === id);
}

export function defaultPropsFor(id: string): Record<string, unknown> {
    const params = templateById(id)?.params ?? [];
    return Object.fromEntries(params.map((param) => [param.key, param.default]));
}
