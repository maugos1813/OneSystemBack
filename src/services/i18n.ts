/** The languages a person can see the app, the alerts and the emails in. Spanish is the original and the default. */
export const LANGUAGES = ["es", "it"] as const;
export type Language = (typeof LANGUAGES)[number];

export const DEFAULT_LANGUAGE: Language = "es";

export function isLanguage(value: unknown): value is Language {
  return typeof value === "string" && (LANGUAGES as readonly string[]).includes(value);
}

/** What is stored for a user, as a language the app knows (anything else falls back to the default). */
export function toLanguage(value: string | null | undefined): Language {
  return isLanguage(value) ? value : DEFAULT_LANGUAGE;
}

/** A text written once per language, for what is composed before knowing who will read it (an alert goes to several people). */
export type Localized = Record<Language, string>;

export function localized(build: (language: Language) => string): Localized {
  return { es: build("es"), it: build("it") };
}

/** The text in this language, with the default one as the fallback. */
export function pick<T>(language: Language, texts: Record<Language, T>): T {
  return texts[language] ?? texts[DEFAULT_LANGUAGE];
}

/** The locale for formatting numbers and dates in this language. */
export const LOCALE: Record<Language, string> = { es: "es-ES", it: "it-IT" };
