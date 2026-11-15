import { normalizeText } from "./portal-screening.mjs";

const DAMAGE_KEYS = new Set([
  "damaged", "isdamaged", "vehicledamaged", "vehicleisdamaged", "cardamaged", "carisdamaged",
  "hasdamage", "hasdamages", "damage", "damagestatus", "vehicledamagestatus", "cardamagestatus",
  "uszkodzony", "uszkodzenia", "czyuszkodzony",
]);

const CONDITION_KEYS = new Set([
  "condition", "vehiclecondition", "carcondition", "stanpojazdu", "stantechniczny",
]);

const DAMAGE_VALUE = /\b(?:damaged|damage(?:d)?|uszkodzon\w*|powypadkow\w*|after accident|after collision|po wypadku|po kolizji|do naprawy|wymaga napraw\w*|needs? repair|for repair|szkoda calkowita|total loss)\b/;
const CLEAN_VALUE = /\b(?:undamaged|not damaged|non[- ]damaged|nieuszkodzon\w*|bezwypadkow\w*|bezkolizyjn\w*|without damage|damage[- ]free|no (?:known |reported |visible )?damage|accident[- ]free|bez uszkod\w*|brak (?:jakichkolwiek )?uszkod\w*|bez wypadk\w*|brak (?:historii )?wypadk\w*)\b/;
const DAMAGE_MENTION = /\b(?:damaged|uszkodzon\w*|powypadkow\w*|szkoda calkowita|total loss)\b/g;
const REPAIR_CONTEXT_MENTION = /\b(?:auto|samochod\w*|pojazd\w*|silnik\w*|skrzyn\w*|karoseri\w*)\s+(?:jest\s+)?(?:do naprawy|wymaga napraw\w*|needs? repair|for repair)\b/g;
const MINOR_COSMETIC_MENTION = /\b(?:rys(?:a|y|e|ami|ach|om|em)?|rysk\w*|otar\w*|przetar\w*|zarysowan\w*|porysowan\w*|odprysk\w*)\b/;
const MINOR_PARKING_DAMAGE = /\b(?:drobna|niewielka|mala)\s+szkod\w*.{0,45}\bparking\w*\b|\bparking\w*.{0,45}\b(?:drobna|niewielka|mala)\s+szkod\w*\b/;
const MINOR_BUMPER_CRACK = /\b(?:pekniet\w*|peknieci\w*)\b.{0,55}\bzderzak\w*\b|\bzderzak\w*.{0,55}\b(?:pekniet\w*|peknieci\w*)\b/;
const MINOR_PDR_DENTS = /\b(?:lekko|delikatnie)\s+uszkodzon\w*.{0,220}\b(?:male\s+)?wgniotk\w*.{0,100}\bpdr\b|\bwgniotk\w*.{0,100}\bpdr\b.{0,100}\bmale\b/;
const MAJOR_DAMAGE_MENTION = /\b(?:mocno|powaznie)\s+uszkodzon\w*\b|\b(?:uszkodzon\w*.{0,30}(?:silnik|skrzyn\w*|zawieszen\w*|poduszk\w*|slupk\w*|podluznic\w*|konstrukcj\w*|pas tylny|przod|tyl)|(?:silnik|skrzyn\w*|zawieszen\w*|poduszk\w*|slupk\w*|podluznic\w*|konstrukcj\w*)\s+uszkodzon\w*)\b|\b(?:airbag\w*|zalany|po gradobiciu|po powaznym wypadku)\b/;
const CLEAN_MENTION = /\b(?:undamaged|not damaged|non[- ]damaged|nieuszkodzon\w*|bezwypadkow\w*|bezkolizyjn\w*|without damage|damage[- ]free|no (?:known |reported |visible )?damage|accident[- ]free|bez uszkod\w*|brak (?:jakichkolwiek )?uszkod\w*|bez wypadk\w*|brak (?:historii )?wypadk\w*)\b/;

function key(value) {
  return normalizeText(value).replace(/[^a-z0-9]/g, "");
}

function scalar(value, depth = 0) {
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") return String(value).trim();
  if (depth > 5 || value == null) return "";
  if (Array.isArray(value)) return value.map((item) => scalar(item, depth + 1)).filter(Boolean).join(" ");
  if (typeof value !== "object") return "";
  for (const name of ["value", "displayValue", "text", "name", "title", "label", "code"] ) {
    const text = scalar(value[name], depth + 1);
    if (text) return text;
  }
  return "";
}

function booleanValue(value) {
  if (typeof value === "boolean") return value;
  const text = normalizeText(scalar(value)).trim();
  if (/^(?:true|1|tak|yes|y)$/.test(text)) return true;
  if (/^(?:false|0|nie|no|n)$/.test(text)) return false;
  return null;
}

function classifyFieldValue(label, value) {
  const normalizedLabel = key(label);
  const isDamageFlag = DAMAGE_KEYS.has(normalizedLabel);
  if (!isDamageFlag && !CONDITION_KEYS.has(normalizedLabel)) return null;

  if (isDamageFlag) {
    const flag = booleanValue(value);
    if (flag !== null) return flag ? "damaged" : "undamaged";
  }

  const text = normalizeText(scalar(value)).replace(/\s+/g, " ").trim();
  if (!text) return null;
  if (CLEAN_VALUE.test(text)) return "undamaged";
  if (DAMAGE_VALUE.test(text)) return "damaged";
  return null;
}

function isNegatedMention(text, match) {
  const before = text.slice(Math.max(0, match.index - 45), match.index);
  const after = text.slice(match.index + match[0].length, match.index + match[0].length + 24);
  const negatedBefore = /\b(?:nie(?:\s+jest|\s+byl|\s+byla|\s+bylo|\s+byly|\s+posiada|\s+ma)?|bez|brak|without|no|not)\s+(?:[a-z0-9]+\s+){0,2}$/i.test(before);
  const clauseNegation = before.match(/\b(?:nie\s+(?:ma|posiada|widac)|brak|bez|woln\w*\s+od)\b([^.!?;]{0,50})$/i);
  const negatedByClause = Boolean(clauseNegation && !/\bale\b/i.test(clauseNegation[1]));
  const negatedAfter = /^\s*[:,-]?\s*(?:brak|nie|none|no)\b/i.test(after);
  return negatedBefore || negatedByClause || negatedAfter;
}

function positiveMention(text, pattern) {
  const globalPattern = new RegExp(pattern.source, "g");
  return [...text.matchAll(globalPattern)].find((match) => !isNegatedMention(text, match)) ?? null;
}

function inspectFields(value, basePath, method, signals, depth = 0) {
  if (depth > 9 || value == null || typeof value !== "object") return;
  if (Array.isArray(value)) {
    value.slice(0, 100).forEach((item, index) => {
      if (item && typeof item === "object" && !Array.isArray(item)) {
        const label = item.label ?? item.key ?? item.name ?? item.title;
        const fieldValue = item.value ?? item.displayValue ?? item.text ?? item.code;
        if (typeof label === "string" && fieldValue !== undefined) {
          const status = classifyFieldValue(label, fieldValue);
          if (status) signals.push({ status, sourcePath: `${basePath}[${index}].${label}`, method,
            value: scalar(fieldValue).slice(0, 240) });
        }
      }
      inspectFields(item, `${basePath}[${index}]`, method, signals, depth + 1);
    });
    return;
  }

  const label = value.label ?? value.key ?? value.name ?? value.title;
  const fieldValue = value.value ?? value.displayValue ?? value.text ?? value.code;
  if (typeof label === "string" && fieldValue !== undefined) {
    const status = classifyFieldValue(label, fieldValue);
    if (status) signals.push({ status, sourcePath: `${basePath}.${label}`, method,
      value: scalar(fieldValue).slice(0, 240) });
  }

  for (const [field, child] of Object.entries(value)) {
    const status = classifyFieldValue(field, child);
    if (status) signals.push({ status, sourcePath: `${basePath}.${field}`, method,
      value: scalar(child).slice(0, 240) });
    if (child && typeof child === "object") inspectFields(child, `${basePath}.${field}`, method, signals, depth + 1);
  }
}

function textSignal(text, sourcePath) {
  const normalized = normalizeText(text).replace(/\s+/g, " ").trim();
  if (!normalized) return null;
  const cosmeticMatch = positiveMention(normalized, MINOR_COSMETIC_MENTION);
  const parkingDamageMatch = positiveMention(normalized, MINOR_PARKING_DAMAGE);
  const bumperCrackMatch = positiveMention(normalized, MINOR_BUMPER_CRACK);
  const pdrMatch = positiveMention(normalized, MINOR_PDR_DENTS);
  const minorMatch = cosmeticMatch ?? (parkingDamageMatch && bumperCrackMatch ? parkingDamageMatch : null) ?? pdrMatch;
  const minorCosmetic = Boolean(minorMatch);
  if (minorCosmetic && !MAJOR_DAMAGE_MENTION.test(normalized)) {
    const match = minorMatch;
    const start = Math.max(0, (match?.index ?? 0) - 80);
    return { status: "minor_cosmetic", sourcePath, method: "text_rule",
      value: normalized.slice(start, Math.min(normalized.length, (match?.index ?? 0) + (match?.[0]?.length ?? 0) + 120)).slice(0, 240) };
  }
  const damageMatches = [...normalized.matchAll(DAMAGE_MENTION), ...normalized.matchAll(REPAIR_CONTEXT_MENTION)]
    .sort((left, right) => left.index - right.index);
  const damaged = damageMatches.find((match) => {
    return !isNegatedMention(normalized, match);
  });
  if (damaged) {
    const start = Math.max(0, damaged.index - 80);
    return { status: "damaged", sourcePath, method: "text_rule",
      value: normalized.slice(start, Math.min(normalized.length, damaged.index + damaged[0].length + 80)).slice(0, 240) };
  }
  if (CLEAN_MENTION.test(normalized)) {
    const match = CLEAN_MENTION.exec(normalized);
    const start = Math.max(0, match.index - 80);
    return { status: "undamaged", sourcePath, method: "text_rule",
      value: normalized.slice(start, Math.min(normalized.length, match.index + match[0].length + 80)).slice(0, 240) };
  }
  return null;
}

export function assessVehicleCondition({ sourceId, listing, detail } = {}) {
  const signals = [];
  inspectFields(listing?.sourceFields ?? listing?.sourceData, `sourcePayload.${sourceId}.listingFields`, "structured_field", signals);
  inspectFields(detail?.sourceFields ?? detail?.sourceData, `sourcePayload.${sourceId}.detailFields`, "structured_field", signals);
  inspectFields(detail?.fields, "detail.fields", "label_value", signals);
  inspectFields(detail?.structuredData, "detail.structuredData", "structured_field", signals);

  for (const [sourcePath, text] of [
    ["detail.bodyText", detail?.bodyText],
    ["listing.title", listing?.title],
    ["detail.title", detail?.title],
  ]) {
    if (typeof text === "string") {
      const signal = textSignal(text.slice(0, 30000), sourcePath);
      if (signal) signals.push(signal);
    }
  }

  const evidence = signals.find((signal) => signal.status === "damaged") ?? signals[0] ?? null;
  const status = evidence?.status ?? "unknown";
  return {
    status,
    isDamaged: status === "damaged" ? true : status === "undamaged" || status === "minor_cosmetic" ? false : null,
    ...(evidence ? { evidence } : {}),
    signals: signals.slice(0, 8),
  };
}
