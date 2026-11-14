function parseRobotsRules(text) {
  const rules = [];
  let agents = [];
  let groupRules = [];
  const saveGroup = () => {
    if (agents.some((agent) => agent === "*")) rules.push(...groupRules);
    groupRules = [];
  };

  for (const line of text.split(/\r?\n/)) {
    const [, rawKey, rawValue] = line.replace(/#.*$/, "").match(/^\s*([-\w]+)\s*:\s*(.*?)\s*$/) ?? [];
    const key = rawKey?.toLowerCase();
    const value = rawValue ?? "";
    if (key === "user-agent") {
      if (groupRules.length) {
        saveGroup();
        agents = [];
      }
      agents.push(value.toLowerCase());
      continue;
    }
    if ((key === "allow" || key === "disallow") && agents.length && value) {
      const anchoredAtEnd = value.endsWith("$");
      const pattern = (anchoredAtEnd ? value.slice(0, -1) : value)
        .split("*").map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join(".*");
      groupRules.push({ regex: new RegExp(`^${pattern}${anchoredAtEnd ? "$" : ""}`),
        length: value.length, allow: key === "allow" });
    }
  }
  saveGroup();
  return rules.sort((left, right) => right.length - left.length || Number(right.allow) - Number(left.allow));
}

function policyError(url, message, { blocked = false, status = null } = {}) {
  return Object.assign(new Error(message), { url, blocked, status, unavailable: !blocked });
}

export async function browserNavigationPolicy(context, sourceUrl, timings) {
  const origin = new URL(sourceUrl).origin;
  const robotsUrl = new URL("/robots.txt", origin).href;
  const page = await timings.measure("robots_page_create", { url: robotsUrl }, () => context.newPage());
  try {
    await page.route("**/*", async (route) => {
      let target;
      try { target = new URL(route.request().url()); } catch { return route.abort("blockedbyclient"); }
      if (target.origin !== origin || target.protocol !== "https:" || target.pathname !== "/robots.txt" || route.request().method() !== "GET") {
        return route.abort("blockedbyclient");
      }
      return route.continue();
    });

    const response = await timings.measure("robots_navigation", { url: robotsUrl }, () =>
      page.goto(robotsUrl, { waitUntil: "domcontentloaded", timeout: 15000 }));
    const status = response?.status() ?? null;
    if ([404, 410].includes(status)) return () => true;
    if (!response || !response.ok()) {
      const blocked = [401, 403, 429].includes(status);
      throw policyError(robotsUrl, status
        ? `Nie udało się sprawdzić robots.txt (HTTP ${status}).`
        : "Nie otrzymano odpowiedzi podczas sprawdzania robots.txt.", { blocked, status });
    }
    if (new URL(response.url()).href !== robotsUrl) {
      throw policyError(robotsUrl, "Adres robots.txt przekierował poza ścieżkę źródłową.");
    }

    const rulesText = await timings.measure("robots_read", { url: robotsUrl }, () => page.locator("body").textContent());
    const rules = parseRobotsRules(rulesText ?? "");
    return (url) => {
      try {
        const target = new URL(url);
        if (target.origin !== origin || target.protocol !== "https:") return false;
        const path = target.pathname + target.search;
        return rules.find(({ regex }) => regex.test(path))?.allow ?? true;
      } catch { return false; }
    };
  } catch (error) {
    if (error?.blocked !== undefined) throw error;
    throw policyError(robotsUrl, `Nie udało się odczytać robots.txt przez przeglądarkę: ${String(error?.message ?? error).split("\n")[0].slice(0, 240)}`);
  } finally {
    await page.close().catch(() => {});
  }
}
