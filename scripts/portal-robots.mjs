function robotsRules(text) {
  const rules = [];
  let agents = [];
  let hasDirectives = false;
  for (const line of text.split(/\r?\n/)) {
    const [, key, value] = line.replace(/#.*$/, "").match(/^\s*([-\w]+)\s*:\s*(.*?)\s*$/) ?? [];
    const directive = key?.toLowerCase();
    if (directive === "user-agent") {
      if (hasDirectives) agents = [];
      hasDirectives = false;
      agents.push(value.toLowerCase());
    } else if (directive === "allow" || directive === "disallow") {
      hasDirectives = true;
      if (agents.includes("*") && value) {
        const end = value.endsWith("$");
        const pattern = (end ? value.slice(0, -1) : value)
          .split("*").map((part) => part.replace(/[.*+?^{}$()|[\]\\]/g, "\\$&")).join(".*");
        rules.push({ pattern: new RegExp("^" + pattern + (end ? "$" : "")),
          length: value.length, allow: directive === "allow" });
      }
    }
  }
  return rules.sort((a, b) => b.length - a.length || Number(b.allow) - Number(a.allow));
}

export function readError(url, message, blocked = false) {
  return Object.assign(new Error(message), { url, blocked });
}

export async function portalNavigationPolicy(context, sourceUrl) {
  const origin = new URL(sourceUrl).origin;
  const robotsUrl = new URL("/robots.txt", origin).href;
  const robots = await context.request.get(robotsUrl, { timeout: 10000, maxRedirects: 0 });
  if (!robots.ok() && ![404, 410].includes(robots.status())) {
    throw readError(robotsUrl, "Nie udało się sprawdzić robots.txt (HTTP " + robots.status() + ").", true);
  }
  const rules = robots.ok() ? robotsRules(await robots.text()) : [];
  return (url) => {
    const target = new URL(url);
    return target.origin === origin && target.protocol === "https:" &&
      (rules.find(({ pattern }) => pattern.test(target.pathname + target.search))?.allow ?? true);
  };
}
