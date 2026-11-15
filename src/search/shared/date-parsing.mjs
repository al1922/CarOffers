import { normalizeText } from "./portal-screening.mjs";

const POLISH_MONTHS = new Map([
  ["stycznia", 1], ["styczen", 1], ["sty", 1],
  ["lutego", 2], ["luty", 2], ["lut", 2],
  ["marca", 3], ["marzec", 3], ["mar", 3],
  ["kwietnia", 4], ["kwiecien", 4], ["kwi", 4],
  ["maja", 5], ["maj", 5],
  ["czerwca", 6], ["czerwiec", 6], ["cze", 6],
  ["lipca", 7], ["lipiec", 7], ["lip", 7],
  ["sierpnia", 8], ["sierpien", 8], ["sie", 8],
  ["wrzesnia", 9], ["wrzesien", 9], ["wrz", 9],
  ["pazdziernika", 10], ["pazdziernik", 10], ["paz", 10],
  ["listopada", 11], ["listopad", 11], ["lis", 11],
  ["grudnia", 12], ["grudzien", 12], ["gru", 12],
]);

export const FIRST_REGISTRATION_DATE_PATTERN = /(?:data pierwszej rejestracji(?:\s+w historii pojazdu)?|pierwsza rejestracja|rok rejestracji)\s*[:\-]?\s*(\d{1,2}[./-]\d{1,2}[./-]\d{4}|\d{1,2}\s+[a-ząćęłńóśźż.]+\s+\d{4}|(?:19|20)\d{2})/i;

function isoDate(year, month, day) {
  const date = new Date(Date.UTC(year, month - 1, day));
  if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) return null;
  return `${String(year).padStart(4, "0")}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

export function parseFullDate(value) {
  const text = String(value ?? "").trim();
  let match = text.match(/\b((?:19|20)\d{2})-(\d{1,2})-(\d{1,2})\b/);
  if (match) return isoDate(Number(match[1]), Number(match[2]), Number(match[3]));

  match = text.match(/\b(\d{1,2})[./-](\d{1,2})[./-]((?:19|20)\d{2})\b/);
  if (match) return isoDate(Number(match[3]), Number(match[2]), Number(match[1]));

  match = text.match(/\b(\d{1,2})\s+([a-ząćęłńóśźż.]+)\s+((?:19|20)\d{2})\b/i);
  if (!match) return null;
  const month = POLISH_MONTHS.get(normalizeText(match[2]).replace(/\.$/, ""));
  return month ? isoDate(Number(match[3]), month, Number(match[1])) : null;
}

export function parseDateOrYear(value) {
  const text = String(value ?? "");
  return parseFullDate(text) ?? text.match(/\b(?:19|20)\d{2}\b/)?.[0] ?? null;
}
