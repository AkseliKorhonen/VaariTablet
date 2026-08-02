import type { Language } from "./i18n";

const LANGUAGE_LOCALES: Record<Language, string> = {
  en: "en",
  fi: "fi",
};

export function formatCallTime(timestamp: number, language: Language) {
  return new Intl.DateTimeFormat(LANGUAGE_LOCALES[language], {
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
    month: "short",
  }).format(new Date(timestamp));
}
