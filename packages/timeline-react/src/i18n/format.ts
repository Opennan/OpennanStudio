// Message lookup + ICU formatting (intl-messageformat, the formatter behind the app's i18n library).
import { IntlMessageFormat } from "intl-messageformat";
import { en, type TimelineMessages, type TimelineNamespace } from "./en";

export type MessageValues = Record<string, string | number | boolean | Date | null | undefined>;

/** (namespace, key, values) -> text. Hosts may pass their own (e.g. backed by their i18n library). */
export type TimelineTranslate = (namespace: string, key: string, values?: MessageValues) => string;

export type TimelineMessagesOverrides = {
    [N in TimelineNamespace]?: Partial<TimelineMessages[N]>;
};

export type MessageKey<N extends TimelineNamespace> = keyof TimelineMessages[N] & string;

type MessageTable = Record<string, Record<string, string>>;

export function mergeMessages(overrides?: TimelineMessagesOverrides): MessageTable {
    const table: MessageTable = {};
    for (const [namespace, entries] of Object.entries(en)) table[namespace] = { ...(entries as Record<string, string>) };
    for (const [namespace, entries] of Object.entries(overrides ?? {})) {
        table[namespace] = { ...(table[namespace] ?? {}), ...(entries as Record<string, string>) };
    }
    return table;
}

export function createTranslator(messages: MessageTable, locale = "en"): TimelineTranslate {
    const cache = new Map<string, IntlMessageFormat>();
    const english = en as unknown as MessageTable;
    return (namespace, key, values) => {
        const raw = messages[namespace]?.[key] ?? english[namespace]?.[key];
        if (raw === undefined) return `${namespace}.${key}`;
        if (!raw.includes("{")) return raw;
        const id = `${namespace}.${key}`;
        try {
            let format = cache.get(id);
            if (!format) {
                format = new IntlMessageFormat(raw, locale, undefined, { ignoreTag: true });
                cache.set(id, format);
            }
            const out = format.format(values ?? {});
            return Array.isArray(out) ? out.join("") : String(out);
        } catch {
            return raw;
        }
    };
}

export const DEFAULT_TRANSLATE: TimelineTranslate = createTranslator(mergeMessages(), "en");
