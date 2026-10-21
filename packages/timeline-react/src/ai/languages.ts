// Languages offered by Translate captions (phase 11): common caption languages with the codes the server takes (2–3
// letters, optional region: zh-CN, zh-TW, pt-BR), each with its English and native name for the search. Data, not UI
// text: names stay as written in every locale.

export interface CaptionLanguage {
    code: string;
    name: string;
    native: string;
}

export const TRANSLATE_LANGUAGES: readonly CaptionLanguage[] = [
    { code: "en", name: "English", native: "English" },
    { code: "es", name: "Spanish", native: "Español" },
    { code: "pt-BR", name: "Portuguese (Brazil)", native: "Português (Brasil)" },
    { code: "pt", name: "Portuguese", native: "Português" },
    { code: "fr", name: "French", native: "Français" },
    { code: "de", name: "German", native: "Deutsch" },
    { code: "it", name: "Italian", native: "Italiano" },
    { code: "nl", name: "Dutch", native: "Nederlands" },
    { code: "pl", name: "Polish", native: "Polski" },
    { code: "sv", name: "Swedish", native: "Svenska" },
    { code: "da", name: "Danish", native: "Dansk" },
    { code: "nb", name: "Norwegian", native: "Norsk bokmål" },
    { code: "fi", name: "Finnish", native: "Suomi" },
    { code: "cs", name: "Czech", native: "Čeština" },
    { code: "sk", name: "Slovak", native: "Slovenčina" },
    { code: "hu", name: "Hungarian", native: "Magyar" },
    { code: "ro", name: "Romanian", native: "Română" },
    { code: "bg", name: "Bulgarian", native: "Български" },
    { code: "el", name: "Greek", native: "Ελληνικά" },
    { code: "ru", name: "Russian", native: "Русский" },
    { code: "uk", name: "Ukrainian", native: "Українська" },
    { code: "tr", name: "Turkish", native: "Türkçe" },
    { code: "ar", name: "Arabic", native: "العربية" },
    { code: "he", name: "Hebrew", native: "עברית" },
    { code: "fa", name: "Persian", native: "فارسی" },
    { code: "hi", name: "Hindi", native: "हिन्दी" },
    { code: "bn", name: "Bengali", native: "বাংলা" },
    { code: "ur", name: "Urdu", native: "اردو" },
    { code: "ta", name: "Tamil", native: "தமிழ்" },
    { code: "th", name: "Thai", native: "ไทย" },
    { code: "vi", name: "Vietnamese", native: "Tiếng Việt" },
    { code: "id", name: "Indonesian", native: "Bahasa Indonesia" },
    { code: "ms", name: "Malay", native: "Bahasa Melayu" },
    { code: "fil", name: "Filipino", native: "Filipino" },
    { code: "ja", name: "Japanese", native: "日本語" },
    { code: "ko", name: "Korean", native: "한국어" },
    { code: "zh-CN", name: "Chinese (Simplified)", native: "简体中文" },
    { code: "zh-TW", name: "Chinese (Traditional)", native: "繁體中文" },
    { code: "sw", name: "Swahili", native: "Kiswahili" },
];

const fold = (text: string) => text.normalize("NFD").replace(/\p{M}/gu, "").toLowerCase().trim();

/** Languages whose code, English name, or native name contains the query (accents ignored). */
export function searchLanguages(query: string, languages: readonly CaptionLanguage[] = TRANSLATE_LANGUAGES): CaptionLanguage[] {
    const q = fold(query);
    if (!q) return [...languages];
    return languages.filter((l) => fold(l.code).includes(q) || fold(l.name).includes(q) || fold(l.native).includes(q));
}

/** Filler word languages (timeline-core FILLER_WORDS keys) with their English names. */
export const FILLER_LANGUAGE_NAMES: Record<string, string> = {
    en: "English", th: "Thai", ja: "Japanese", zh: "Chinese", ko: "Korean", es: "Spanish", fr: "French", de: "German", pt: "Portuguese",
};
