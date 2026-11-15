export const numberFormat = new Intl.NumberFormat("pl-PL");
export const money = (value) => Number.isFinite(value) ? `${numberFormat.format(value)} zł` : "—";
export const kilometers = (value) => Number.isFinite(value) ? `${numberFormat.format(value)} km` : "—";
export const safeURL = (value) => {
  try {
    const url = new URL(value);
    return ["https:", "http:"].includes(url.protocol) && !url.username && !url.password ? url.href : null;
  } catch {
    return null;
  }
};
export const bodyNames = { wagon: "Kombi", sedan: "Sedan", suv: "SUV", crossover: "Crossover", hatchback: "Hatchback", minivan: "Minivan" };
