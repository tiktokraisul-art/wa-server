// Chat history (dashboard-er jonno) - shudhu TEXT content Firebase e sthayi vabe
// thake. Chobi/file-er purnanga data sthayi vabe rakha hoy na (Firebase-er free
// 1GB jaiga bachate) - shudhu naam/caption thake. Recent media kichukkhoner jonne
// memory-te cache thake, jate recent chobi dashboard theke dekha jay.
const { fbGet, fbSet, fbPush, fbQueryLastN, encKey, decodeKey, USE_DB } = require('./firebase');

const HIST_CAP_PER_CONTACT = 500; // protyek contact er jonno shorbochcho eto ta history line rakhi

// ---- In-memory media cache (recent media-i shudhu dashboard theke dekha jay) ----
const MEDIA_CACHE_CAP = 60;
const mediaCache = new Map(); // id -> { buffer, mimetype, fileName }
function cacheMedia(id, buffer, mimetype, fileName) {
  if (mediaCache.size >= MEDIA_CACHE_CAP) {
    const oldest = mediaCache.keys().next().value;
    mediaCache.delete(oldest);
  }
  mediaCache.set(id, { buffer, mimetype, fileName });
}
function getMedia(id) {
  return mediaCache.get(id) || null;
}

// ---- Status/Story cache (in-memory, recent gulo) ----
const STATUS_CACHE_CAP = 100;
const statusCache = []; // newest first: { id, jid, name, type, text, mediaId, time }
function addStatus(entry) {
  statusCache.unshift(entry);
  if (statusCache.length > STATUS_CACHE_CAP) statusCache.pop();
}
function getStatuses() {
  return statusCache;
}

// ---- Persistent text history (Firebase) ----
// entry: { dir: 'in'|'out', type, text, caption, fileName, mediaId, name, time }
async function appendHistory(jid, entry) {
  if (!USE_DB) return;
  try {
    await fbPush(`history/${encKey(jid)}`, entry);
    // Purono entry chhata bad dei na (push key time-ordered, tai size trim kora
    // jay list kore - kintu eta ghono ghono korle extra read lage, tai shudhu
    // majhe majhe kore dile hobe). Ekhon shudhu notun rekhe dicchi.
  } catch (e) {
    console.log('appendHistory error:', e.message);
  }
}

// Shesh N ta message ane (oldest -> newest order e)
async function getHistory(jid, limit = 200) {
  if (!USE_DB) return [];
  try {
    const obj = await fbQueryLastN(`history/${encKey(jid)}`, 'time', limit);
    return Object.entries(obj)
      .map(([pushId, v]) => ({ id: pushId, ...v }))
      .sort((a, b) => a.time - b.time);
  } catch (e) {
    console.log('getHistory error:', e.message);
    return [];
  }
}

// Shob contact er list, shesh message shoho (contact list dekhanor jonne)
async function listContacts() {
  if (!USE_DB) return [];
  try {
    const all = (await fbGet('history')) || {};
    const out = [];
    for (const encJid in all) {
      const node = all[encJid];
      const entries = Object.values(node || {});
      if (!entries.length) continue;
      entries.sort((a, b) => a.time - b.time);
      const last = entries[entries.length - 1];
      out.push({
        jid: decodeKey(encJid),
        lastText: last.text || last.caption || last.fileName || `[${last.type}]`,
        lastTime: last.time,
        lastDir: last.dir,
      });
    }
    out.sort((a, b) => b.lastTime - a.lastTime);
    return out;
  } catch (e) {
    console.log('listContacts error:', e.message);
    return [];
  }
}

// Shob contact er history ghure kono keyword khoje (shudhu text/caption/fileName e)
async function searchHistory(query) {
  if (!USE_DB || !query) return [];
  const q = query.toLowerCase();
  try {
    const all = (await fbGet('history')) || {};
    const results = [];
    for (const encJid in all) {
      const node = all[encJid];
      for (const pushId in node) {
        const v = node[pushId];
        const hay = `${v.text || ''} ${v.caption || ''} ${v.fileName || ''}`.toLowerCase();
        if (hay.includes(q)) {
          results.push({ jid: decodeKey(encJid), id: pushId, ...v });
        }
      }
    }
    results.sort((a, b) => b.time - a.time);
    return results.slice(0, 100); // beshi result hole UI bhore jay, tai cap dilam
  } catch (e) {
    console.log('searchHistory error:', e.message);
    return [];
  }
}

module.exports = {
  cacheMedia,
  getMedia,
  addStatus,
  getStatuses,
  appendHistory,
  getHistory,
  listContacts,
  searchHistory,
};
