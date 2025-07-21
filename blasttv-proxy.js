const express = require("express");
const axios = require("axios");
const { Parser } = require("m3u8-parser");
const puppeteer = require("puppeteer");
const fs = require("fs");

const app = express();
const PORT = 3000;

let bearerToken = "";
let refreshToken = "";
let lastTokenRefresh = 0;

const REFRESH_INTERVAL = 15 * 60 * 1000;
const CACHE_TTL = 30 * 1000;
const REFRESH_URL = "https://app.blasttv.ph/api/v2/token/refresh";
const EVENT_METADATA_URL = (id) =>
  `https://app.blasttv.ph/api/v4/event/${id}?includePlaybackDetails=URL&displayGeoblocked=HIDE`;
const CACHE_FILE = "./cache.json";

// Replace this with event IDs you want to fetch
const KNOWN_EVENT_IDS = [274551]; // Add more as needed

async function refreshTokenIfNeeded() {
  if (Date.now() - lastTokenRefresh < REFRESH_INTERVAL) return;
  if (!refreshToken) return loginWithPuppeteer();

  try {
    const res = await axios.post(REFRESH_URL, {}, {
      headers: {
        Authorization: `Bearer ${refreshToken}`,
      }
    });

    if (res.data?.token) {
      bearerToken = res.data.token;
      refreshToken = res.data.refreshToken;
      lastTokenRefresh = Date.now();
      console.log("✅ Token refreshed");
    } else {
      console.warn("⚠️ Token refresh failed. Trying Puppeteer...");
      await loginWithPuppeteer();
    }
  } catch (err) {
    console.error("❌ Refresh error:", err.message);
    await loginWithPuppeteer();
  }
}

async function loginWithPuppeteer() {
  console.log("🧪 Logging in with Puppeteer...");
  const browser = await puppeteer.launch({ headless: false, slowMo: 100 });
  const page = await browser.newPage();

  try {
    await page.goto("https://app.blasttv.ph/login", { waitUntil: "networkidle2" });
    await page.type("#email", "candadofrances@gmail.com");
    await page.type("#secret", "Lmatt0603!");
    await Promise.all([
      page.click("button[data-test-id='submit-btn-login']"),
      page.waitForNavigation({ waitUntil: "networkidle2" }),
    ]);

    const tokenDump = await page.evaluate(() => {
      const dump = {};
      for (let i = 0; i < localStorage.length; i++) {
        const key = localStorage.key(i);
        dump[key] = localStorage.getItem(key);
      }
      return dump;
    });

    bearerToken = tokenDump["dice:authToken"];
    refreshToken = tokenDump["dice:refreshToken"];
    lastTokenRefresh = Date.now();

    if (bearerToken) {
      console.log("✅ New token from Puppeteer");
    } else {
      console.error("❌ Failed to extract authToken");
    }
  } catch (err) {
    console.error("❌ Puppeteer login failed:", err.message);
  } finally {
    await browser.close();
  }
}

async function getStreamVariants(url) {
  try {
    const res = await axios.get(url);
    const parser = new Parser();
    parser.push(res.data);
    parser.end();
    return parser.manifest.playlists.map(p => ({
      resolution: p.attributes.RESOLUTION?.height + "p",
      bandwidth: p.attributes.BANDWIDTH,
      uri: p.uri
    }));
  } catch (err) {
    console.warn("⚠️ Variant parse error:", err.message);
    return [];
  }
}

async function getChannelsWithStreams() {
  await refreshTokenIfNeeded();
  const streams = [];

  try {
    const liveRes = await axios.get("https://app.blasttv.ph/api/v2/event/live?p=1&rpp=25", {
      headers: {
        Authorization: `Bearer ${bearerToken}`,
        "x-api-key": "857a1e5d-e35e-4fdf-805b-a87b6f8364bf",
        app: "dice",
        realm: "dce.tapgo",
        "User-Agent": "Mozilla/5.0",
      }
    });

    const liveEvents = liveRes.data?.data || [];

    for (const event of liveEvents) {
      const eventId = event?.id;
      const title = event?.event_title || "Untitled";
      const channelId = event?.channel_id;

      try {
        const metaRes = await axios.get(EVENT_METADATA_URL(eventId), {
          headers: {
            Authorization: `Bearer ${bearerToken}`,
            "x-api-key": "857a1e5d-e35e-4fdf-805b-a87b6f8364bf",
            app: "dice",
          }
        });

        const playback = metaRes.data?.playback;
        const masterUrl = playback?.urls?.find(u => u.format === "HLS")?.url;

        if (masterUrl) {
          const variants = await getStreamVariants(masterUrl);
          const slug = title.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");

          streams.push({
            title,
            slug,
            channel_id: channelId,
            event_id: eventId,
            master_url: masterUrl,
            variants
          });
        } else {
          console.warn(`⚠️ No HLS URL for event ${eventId} (${title})`);
        }

      } catch (err) {
        console.warn(`⚠️ Error fetching metadata for event ${eventId}: ${err.message}`);
      }
    }

  } catch (err) {
    console.error("❌ Failed to fetch live events:", err.message);
  }

  return streams;
}

function loadCache() {
  try {
    return JSON.parse(fs.readFileSync(CACHE_FILE, "utf-8"));
  } catch {
    return { timestamp: 0, streams: [] };
  }
}

function saveCache(data) {
  fs.writeFileSync(CACHE_FILE, JSON.stringify(data, null, 2));
}

app.get("/streams", async (req, res) => {
  const cache = loadCache();
  if (Date.now() - cache.timestamp < CACHE_TTL) {
    return res.json({ cached: true, ...cache });
  }

  const streams = await getChannelsWithStreams();
  const result = { timestamp: Date.now(), streams };
  saveCache(result);
  res.json({ cached: false, ...result });
});

app.get("/play/:channelId/playlist.m3u8", async (req, res) => {
  const { channelId } = req.params;
  const cache = loadCache();
  const stream = cache.streams.find(s => s.channel_id == channelId);

  if (!stream) return res.status(404).send("Channel not found");

  try {
    const m3u8Res = await axios.get(stream.master_url);
    res.setHeader("Content-Type", "application/vnd.apple.mpegurl");
    res.send(m3u8Res.data);
  } catch {
    res.status(500).send("Failed to fetch playlist");
  }
});

app.listen(PORT, () => {
  console.log(`🚀 Server running at http://localhost:${PORT}/streams`);
});
