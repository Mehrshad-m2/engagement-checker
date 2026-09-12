// Engagement Checker — Cloudflare Worker
// Routen: /analyze, /search, /deepsearch, /img — alles andere kommt aus /public (Assets).
// Secret: APIFY_TOKEN (Worker -> Settings -> Variables and Secrets)

const ACTOR = "apify~instagram-profile-scraper";

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (url.pathname === "/analyze") return analyze(url, env);
    if (url.pathname === "/search") return search(url);
    if (url.pathname === "/deepsearch") return deepsearch(url, env);
    if (url.pathname === "/img") return img(url);

    // Statische Dateien (index.html usw.)
    return env.ASSETS.fetch(request);
  },
};

/* ---------------- Analyse ---------------- */
async function analyze(url, env) {
  const token = env.APIFY_TOKEN;
  if (!token) return json(500, { error: "APIFY_TOKEN ist in den Worker-Einstellungen nicht gesetzt (Settings → Variables and Secrets)." });

  const action = url.searchParams.get("action");
  const username = url.searchParams.get("username");
  const runId = url.searchParams.get("runId");

  try {
    if (action === "start") {
      const clean = String(username || "")
        .trim()
        .replace(/^@/, "")
        .replace(/^https?:\/\/(www\.)?instagram\.com\//i, "")
        .replace(/\/.*$/, "");
      if (!/^[a-zA-Z0-9._]{1,30}$/.test(clean)) {
        return json(400, { error: "Das sieht nicht nach einem gültigen Instagram-Benutzernamen aus." });
      }
      const r = await fetch(`https://api.apify.com/v2/acts/${ACTOR}/runs?token=${token}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ usernames: [clean] }),
      });
      const data = await r.json();
      if (!r.ok) return json(r.status, { error: data?.error?.message || "Apify hat die Anfrage abgelehnt." });
      return json(200, { runId: data.data.id, username: clean });
    }

    if (action === "status") {
      const r = await fetch(`https://api.apify.com/v2/actor-runs/${runId}?token=${token}`);
      const data = await r.json();
      if (!r.ok) return json(r.status, { error: data?.error?.message || "Status konnte nicht geprüft werden." });
      return json(200, { status: data.data.status, datasetId: data.data.defaultDatasetId });
    }

    if (action === "results") {
      const runRes = await fetch(`https://api.apify.com/v2/actor-runs/${runId}?token=${token}`);
      const runData = await runRes.json();
      const datasetId = runData?.data?.defaultDatasetId;
      if (!datasetId) return json(500, { error: "Lauf beendet, aber kein Datensatz gefunden." });
      const r = await fetch(`https://api.apify.com/v2/datasets/${datasetId}/items?token=${token}&clean=true`);
      const items = await r.json();
      if (Array.isArray(items) && items[0]) {
        const picUrl = items[0].profilePicUrlHD || items[0].profilePicUrl;
        if (picUrl) items[0].picData = await Promise.race([
          fetchImageDataUri(picUrl),
          new Promise(resolve => setTimeout(() => resolve(null), 2000)),
        ]);
      }
      return json(200, items);
    }

    return json(400, { error: "Unbekannte Aktion." });
  } catch (err) {
    return json(500, { error: err.message || "Unerwarteter Serverfehler." });
  }
}

/* ---------------- Schnellsuche (Instagram-Typeahead) ---------------- */
async function search(url) {
  const q = (url.searchParams.get("q") || "").trim();
  if (q.length < 2) return json(200, { users: [] });

  const headers = {
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
    "Accept": "*/*",
    "Accept-Language": "de-DE,de;q=0.9,en;q=0.8",
    "Referer": "https://www.instagram.com/",
    "X-IG-App-ID": "936619743392459",
    "X-Requested-With": "XMLHttpRequest",
  };
  const endpoints = [
    `https://www.instagram.com/api/v1/web/search/topsearch/?context=blended&query=${encodeURIComponent(q)}&include_reel=false`,
    `https://www.instagram.com/web/search/topsearch/?context=blended&query=${encodeURIComponent(q)}`,
  ];
  for (const ep of endpoints) {
    try {
      const r = await fetch(ep, { headers, redirect: "manual", signal: AbortSignal.timeout(4000) });
      const ct = r.headers.get("content-type") || "";
      if (!r.ok || !ct.includes("json")) continue;
      const data = await r.json();
      const users = (data.users || []).slice(0, 8).map(u => ({
        username: u.user.username,
        fullName: u.user.full_name,
        pic: u.user.profile_pic_url || "",
        verified: !!u.user.is_verified,
      }));
      return json(200, { users });
    } catch (e) { /* nächster Endpoint */ }
  }
  return json(200, { blocked: true, users: [] });
}

/* ---------------- Tiefensuche über Apify ---------------- */
async function deepsearch(url, env) {
  const token = env.APIFY_TOKEN;
  if (!token) return json(500, { error: "APIFY_TOKEN ist nicht gesetzt." });
  const q = (url.searchParams.get("q") || "").trim();
  if (q.length < 2) return json(200, { users: [] });

  try {
    const r = await fetch(
      `https://api.apify.com/v2/acts/apify~instagram-search-scraper/run-sync-get-dataset-items?token=${token}&timeout=90`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ search: q, searchType: "user", searchLimit: 8 }),
      }
    );
    const items = await r.json();
    if (!r.ok) return json(500, { error: items?.error?.message || "Apify-Suche fehlgeschlagen." });
    const users = (Array.isArray(items) ? items : []).slice(0, 8).map(u => ({
      username: u.username,
      fullName: u.fullName || u.full_name || "",
      pic: u.profilePicUrl || u.profile_pic_url || "",
      verified: !!(u.verified ?? u.isVerified ?? u.is_verified),
    })).filter(u => u.username);
    return json(200, { users });
  } catch (e) {
    return json(500, { error: e.message || "Apify-Suche fehlgeschlagen." });
  }
}

/* ---------------- Bild-Proxy (Fallback hinter weserv) ---------------- */
async function img(url) {
  try {
    const target = new URL(url.searchParams.get("u") || "");
    const okHost = /(^|\.)cdninstagram\.com$|(^|\.)fbcdn\.net$|(^|\.)fbsbx\.com$|(^|\.)instagram\.com$/.test(target.hostname);
    if (!okHost || target.protocol !== "https:") return new Response(null, { status: 400 });
    const r = await fetch(target, {
      headers: { "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36" },
      redirect: "follow",
      signal: AbortSignal.timeout(2500),
    });
    if (!r.ok || !(r.headers.get("content-type") || "").startsWith("image/")) return new Response(null, { status: 404 });
    return new Response(r.body, {
      status: 200,
      headers: { "Content-Type": r.headers.get("content-type"), "Cache-Control": "public, max-age=3600" },
    });
  } catch (e) {
    return new Response(null, { status: 404 });
  }
}

/* ---------------- Helfer ---------------- */
function json(status, body) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function toBase64(buf) {
  const bytes = new Uint8Array(buf);
  let binary = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}

async function fetchImageDataUri(u, perAttemptMs = 1200) {
  try {
    const target = new URL(u);
    if (target.protocol !== "https:") return null;
    const attempts = [
      {},
      { "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36" },
    ];
    for (const headers of attempts) {
      try {
        const r = await fetch(target, { headers, redirect: "follow", signal: AbortSignal.timeout(perAttemptMs) });
        if (r.ok) {
          const ct = r.headers.get("content-type") || "image/jpeg";
          if (!ct.startsWith("image/")) continue;
          const buf = await r.arrayBuffer();
          if (buf.byteLength > 3_000_000) return null;
          return `data:${ct};base64,${toBase64(buf)}`;
        }
      } catch (e) { /* Timeout -> nächste Variante */ }
    }
  } catch (e) {}
  return null;
}
