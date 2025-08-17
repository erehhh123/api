const express = require("express");
const axios = require("axios");
const { Parser } = require("m3u8-parser");
const puppeteer = require("puppeteer");

const app = express();
const PORT = 3000;

// ---- AUTH STATE ----
let bearerToken = "";
let refreshToken = "";
let lastTokenRefresh = 0;

// ---- CACHE ----
let cachedStreams = [];
let lastCacheTime = 0;
const CACHE_TTL = 30 * 1000; // 30s
const REFRESH_INTERVAL = 15 * 60 * 1000; // 15 min

// ---- API URLS ----
const REFRESH_URL = "https://app.blasttv.ph/api/v2/token/refresh";
const LIVE_EVENTS_URL = "https://app.blasttv.ph/api/v2/event/live?p=1&rpp=25";
const EVENT_METADATA_URL = (id) =>
  `https://app.blasttv.ph/api/v4/event/${id}?includePlaybackDetails=URL&displayGeoblocked=HIDE`;

// ---- AUTH HELPERS ----
async function refreshTokenIfNeeded() {
  if (Date.now() - lastTokenRefresh < REFRESH_INTERVAL) return;
  if (!refreshToken) return loginWithPuppeteer();

  try {
    const res = await axios.post(
      REFRESH_URL,
      {},
      { headers: { Authorization: `Bearer ${refreshToken}` } }
    );

    if (res.data?.token) {
      bearerToken = res.data.token;
      refreshToken = res.data.refreshToken;
      lastTokenRefresh = Date.now();
      console.log("✅ Token refreshed");
    } else {
      console.warn("⚠️ Refresh failed, relogging...");
      await loginWithPuppeteer();
    }
  } catch (err) {
    console.error("❌ Refresh error:", err.message);
    await loginWithPuppeteer();
  }
}

async function loginWithPuppeteer() {
  console.log("🧪 Logging in with Puppeteer...");
  const browser = await puppeteer.launch({ headless: true });
  const page = await browser.newPage();

  try {
    await page.goto("https://app.blasttv.ph/login", { waitUntil: "networkidle2" });

    await page.type("#email", process.env.BLASTTV_EMAIL || "Email");
    await page.type("#secret", process.env.BLASTTV_PASS || "Password");

    await Promise.all([
      page.click("button[data-test-id='submit-btn-login']"),
      page.waitForNavigation({ waitUntil: "networkidle2" }),
    ]);

    const tokenDump = await page.evaluate(() => {
      const dump = {};
      for (let i = 0; i < localStorage.length; i++) {
        dump[localStorage.key(i)] = localStorage.getItem(localStorage.key(i));
      }
      return dump;
    });

    bearerToken = tokenDump["dice:authToken"];
    refreshToken = tokenDump["dice:refreshToken"];
    lastTokenRefresh = Date.now();

    console.log("✅ Puppeteer login successful");
  } catch (err) {
    console.error("❌ Puppeteer login failed:", err.message);
  } finally {
    await browser.close();
  }
}

// ---- AXIOS INSTANCE WITH INTERCEPTORS ----
const api = axios.create();
api.interceptors.request.use((config) => {
  if (bearerToken) {
    config.headers["Authorization"] = `Bearer ${bearerToken}`;
  }
  config.headers["x-api-key"] = "857a1e5d-e35e-4fdf-805b-a87b6f8364bf";
  config.headers["app"] = "dice";
  config.headers["realm"] = "dce.tapgo";
  return config;
});

api.interceptors.response.use(
  (res) => res,
  async (error) => {
    if (error.response && error.response.status === 401) {
      console.warn("⚠️ 401 detected, refreshing token...");
      await refreshTokenIfNeeded();
      if (bearerToken) {
        error.config.headers["Authorization"] = `Bearer ${bearerToken}`;
        return api.request(error.config);
      }
    }
    return Promise.reject(error);
  }
);

// ---- UTILS ----
function slugify(text) {
  return text.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
}

async function getStreamVariants(url) {
  try {
    const res = await axios.get(url);
    const parser = new Parser();
    parser.push(res.data);
    parser.end();
    return parser.manifest.playlists.map((p) => ({
      resolution: p.attributes.RESOLUTION?.height + "p",
      bandwidth: p.attributes.BANDWIDTH,
      uri: p.uri,
    }));
  } catch (err) {
    console.warn("⚠️ Variant parse failed:", err.message);
    return [];
  }
}

// ---- MAIN FETCH ----
async function getChannelsWithStreams(force = false) {
  if (!force && Date.now() - lastCacheTime < CACHE_TTL && cachedStreams.length > 0) {
    console.log("📦 Serving from cache");
    return cachedStreams;
  }

  await refreshTokenIfNeeded();
  const streams = [];

  try {
    const liveRes = await api.get(LIVE_EVENTS_URL);
    const events = Array.isArray(liveRes.data) ? liveRes.data : liveRes.data?.data || [];
    console.log("🔎 Found", events.length, "live events");

    for (const event of events) {
      const eventId = event.id;
      const title = event.event_title || "Untitled";
      const slug = slugify(title);

      try {
        const metaRes = await api.get(EVENT_METADATA_URL(eventId));
        const masterUrl = metaRes.data?.playback?.urls?.find((u) => u.format === "HLS")?.url;
        if (!masterUrl) continue;

        const variants = await getStreamVariants(masterUrl);
        streams.push({ title, slug, event_id: eventId, master_url: masterUrl, variants });
      } catch (err) {
        console.warn(`⚠️ Event ${eventId} metadata failed:`, err.message);
      }
    }

    cachedStreams = streams;
    lastCacheTime = Date.now();
    return streams;
  } catch (err) {
    console.error("❌ Live events fetch failed:", err.message);
    return cachedStreams; // fallback
  }
}

// ---- ROUTES ----
app.get("/streams", async (req, res) => {
  const keyword = req.query.search?.toLowerCase() || "";
  const allStreams = await getChannelsWithStreams();
  const filtered = keyword
    ? allStreams.filter((s) => s.title.toLowerCase().includes(keyword))
    : allStreams;

  res.json({
    cached: Date.now() - lastCacheTime < CACHE_TTL,
    timestamp: Date.now(),
    streams: filtered,
  });
});

// raw playback
app.get("/play/:slug/playlist.m3u8", async (req, res) => {
  const stream = (await getChannelsWithStreams()).find((s) => s.slug === req.params.slug);
  if (!stream) return res.status(404).send("Stream not found");

  try {
    const { data } = await axios.get(stream.master_url);
    res.setHeader("Content-Type", "application/vnd.apple.mpegurl");
    res.send(data);
  } catch {
    res.status(500).send("Failed to fetch playlist");
  }
});

// proxy & rewrite (absolute URLs)
app.get("/proxy/:slug/playlist.m3u8", async (req, res) => {
  const stream = (await getChannelsWithStreams()).find((s) => s.slug === req.params.slug);
  if (!stream) return res.status(404).send("Stream not found");

  try {
    const { data } = await axios.get(stream.master_url);
    const baseUrl = new URL(stream.master_url).origin + new URL(stream.master_url).pathname.replace(/\/[^\/]+$/, "/");

    const rewritten = data.replace(/^(?!#)(.+\.m3u8|.+\.ts)/gm, (line) => `${baseUrl}${line}`);
    res.setHeader("Content-Type", "application/vnd.apple.mpegurl");
    res.send(rewritten);
  } catch {
    res.status(500).send("Failed to rewrite playlist");
  }
});

app.listen(PORT, () => {
  console.log(`🚀 Server running at http://localhost:${PORT}/streams`);
});
