const fs = require('fs');
const express = require('express');
const QRCode = require('qrcode');
const pino = require('pino');
const {
  default: makeWASocket,
  useMultiFileAuthState,
  DisconnectReason,
  fetchLatestBaileysVersion,
  downloadMediaMessage,
  normalizeMessageContent,
  getContentType,
} = require('@whiskeysockets/baileys');

const PORT = process.env.PORT || 3000;
const API_KEY = process.env.API_KEY || '';
const TG_TOKEN = process.env.TELEGRAM_BOT_TOKEN || '';
const TG_CHAT = String(process.env.TELEGRAM_CHAT_ID || '');
const INCLUDE_STATUS = process.env.INCLUDE_STATUS === 'true';

const logger = pino({ level: 'silent' });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let sock = null;
let lastQR = null;
let status = 'starting';
let notifiedNeedLink = false;
let registered = false; // age theke kono WhatsApp account pair kora ache kina
let linking = false; // /qr ba /link ekta shomoy e ekbar e cholche
let pairingResolve = null;
const inbox = [];
const topicCache = new Map();   // jid -> message_thread_id (ei process-e cache)
const threadToJid = new Map();  // message_thread_id -> jid (Telegram theke reply pathate)

// WA message id <-> Telegram message mapping (delete-mark ar reaction forward korar jonne).
// Boro hote hote memory na bhore jay tai ekta simple size-capped Map.
const MAP_CAP = 2000;
function boundedSet(map, key, value) {
  if (map.size >= MAP_CAP) {
    const oldestKey = map.keys().next().value;
    map.delete(oldestKey);
  }
  map.set(key, value);
}
const waIdToTg = new Map();   // `${jid}:${waMsgId}` -> { chatId, messageId, isCaption }
const tgMsgToWa = new Map();  // `${chatId}:${messageId}` -> { jid, key }
const outgoingWaToTg = new Map(); // `${jid}:${waMsgId}` -> { chatId, messageId } - amader pathano reply er status (sent/delivered/seen) dekhate
const topicLocks = new Map();   // jid -> in-flight creation promise
const groupNameCache = new Map();
let forumDisabled = false;      // group e Topics chalu na thakle true hoye jabe

// e?.message || e kokhono kokhono puro object (session/crypto key shoho) print kore felte pare -
// tai shudhu message ba stack-er prothom line i log kori, kokhono puro object na.
function safeErrText(e) {
  if (e instanceof Error) return e.stack?.split('\n')[0] || e.message;
  if (typeof e === 'string') return e;
  return 'non-error thrown (type: ' + typeof e + ')';
}
process.on('unhandledRejection', (e) => console.log('unhandledRejection:', safeErrText(e)));
process.on('uncaughtException', (e) => console.log('uncaughtException:', safeErrText(e)));

// ================= Telegram helpers =================
async function tg(method, fields = {}, file = null) {
  if (!TG_TOKEN || !TG_CHAT) { console.log('Telegram env set kora nai'); return null; }
  const form = new FormData();
  form.append('chat_id', TG_CHAT);
  for (const [k, v] of Object.entries(fields)) form.append(k, String(v));
  if (file) form.append(file.field, new Blob([file.buffer]), file.name);
  try {
    const r = await fetch(`https://api.telegram.org/bot${TG_TOKEN}/${method}`, {
      method: 'POST',
      body: form,
    });
    const j = await r.json();
    if (!j.ok) console.log('Telegram error:', j.description);
    return j;
  } catch (e) {
    console.log('Telegram fetch error:', e.message);
    return null;
  }
}
async function setTgReaction(chatId, messageId, emoji) {
  return tgJSON('setMessageReaction', {
    chat_id: chatId,
    message_id: messageId,
    reaction: emoji ? [{ type: 'emoji', emoji }] : [],
  });
}
async function tgJSON(method, bodyObj) {
  if (!TG_TOKEN) { console.log('Telegram env set kora nai'); return null; }
  try {
    const r = await fetch(`https://api.telegram.org/bot${TG_TOKEN}/${method}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(bodyObj),
    });
    const j = await r.json();
    if (!j.ok) console.log('Telegram error (' + method + '):', j.description);
    return j;
  } catch (e) {
    console.log('Telegram fetch error (' + method + '):', e.message);
    return null;
  }
}
const say = (text) => tg('sendMessage', { text: String(text).slice(0, 4096) });
const sayHTML = (text) => tg('sendMessage', { text: String(text).slice(0, 4096), parse_mode: 'HTML' });

// ================= Telegram Forum Topics (proti contact/group er jonno alada topic) =================
async function getTopicId(jid) {
  if (!USE_DB) return null;
  try {
    const token = await fbToken();
    const r = await fetch(`${FIREBASE_DB_URL}/tg_topics/${encKey(jid)}.json?access_token=${token}`);
    if (!r.ok) return null;
    return await r.json();
  } catch (e) {
    console.log('getTopicId error:', e.message);
    return null;
  }
}
async function saveTopicId(jid, threadId) {
  if (!USE_DB) return;
  try {
    const token = await fbToken();
    await fetch(`${FIREBASE_DB_URL}/tg_topics/${encKey(jid)}.json?access_token=${token}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(threadId),
    });
  } catch (e) {
    console.log('saveTopicId error:', e.message);
  }
}
// Shudhu existing topic khuje dekhe, notun banay na (presence update er jonno - message na ashle topic banano uchit na)
async function getExistingTopicId(jid) {
  if (topicCache.has(jid)) return topicCache.get(jid);
  const id = await getTopicId(jid);
  if (id) topicCache.set(jid, id);
  return id;
}
async function getJidByThread(threadId) {
  if (threadToJid.has(threadId)) return threadToJid.get(threadId);
  if (!USE_DB) return null;
  try {
    const token = await fbToken();
    const r = await fetch(`${FIREBASE_DB_URL}/tg_topic_jid/${threadId}.json?access_token=${token}`);
    if (!r.ok) return null;
    const jid = await r.json();
    if (jid) threadToJid.set(threadId, jid);
    return jid;
  } catch (e) {
    console.log('getJidByThread error:', e.message);
    return null;
  }
}
async function saveJidByThread(threadId, jid) {
  threadToJid.set(threadId, jid);
  if (!USE_DB) return;
  try {
    const token = await fbToken();
    await fetch(`${FIREBASE_DB_URL}/tg_topic_jid/${threadId}.json?access_token=${token}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(jid),
    });
  } catch (e) {
    console.log('saveJidByThread error:', e.message);
  }
}
async function createForumTopic(name) {
  const r = await fetch(`https://api.telegram.org/bot${TG_TOKEN}/createForumTopic`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id: TG_CHAT, name: String(name).slice(0, 128) }),
  });
  const j = await r.json();
  if (!j.ok) throw new Error(j.description || 'createForumTopic failed');
  return j.result.message_thread_id;
}
// Notun topic banar shomoy, shei contact/group er WhatsApp profile picture
// (thakle) প্রথম মেসেজ হিসেবে ওই topic e pathiye dey, jate topic khulei bojha jay ke
async function sendProfilePicToTopic(jid, threadId) {
  try {
    const url = await sock.profilePictureUrl(jid, 'image');
    if (!url) return;
    await tgJSON('sendPhoto', { chat_id: TG_CHAT, message_thread_id: threadId, photo: url });
  } catch (e) {
    // profile picture na thakle ba private thakle WhatsApp error dey - chup chap skip
  }
}

async function getOrCreateTopic(jid, nameHint) {
  if (forumDisabled) return null;
  if (topicCache.has(jid)) return topicCache.get(jid);
  if (topicLocks.has(jid)) return topicLocks.get(jid);

  const task = (async () => {
    let id = await getTopicId(jid);
    let isNew = false;
    if (!id) {
      try {
        id = await createForumTopic(nameHint || jid);
        await saveTopicId(jid, id);
        isNew = true;
      } catch (e) {
        console.log('createForumTopic error:', e.message);
        if (/not enough rights|administrator|forum|supergroup/i.test(e.message)) {
          forumDisabled = true;
          say('⚠️ Topic banano jacche na. Bot k group e admin banao ar group settings e "Topics" chalu koro.\nEkhon theke shob message main chat e ashbe (topic chhara).');
        }
        id = null;
      }
    }
    if (id) {
      topicCache.set(jid, id);
      threadToJid.set(id, jid);
      await saveJidByThread(id, jid); // reply-to-WhatsApp er jonno reverse mapping o save kori
      if (isNew) sendProfilePicToTopic(jid, id).catch(() => {});
    }
    return id;
  })();

  topicLocks.set(jid, task);
  try {
    return await task;
  } finally {
    topicLocks.delete(jid);
  }
}
async function getChatName(jid, pushName) {
  if (jid.endsWith('@g.us')) {
    if (groupNameCache.has(jid)) return groupNameCache.get(jid);
    let name = jid.split('@')[0];
    try {
      const meta = await sock.groupMetadata(jid);
      if (meta?.subject) name = meta.subject;
    } catch (e) {
      console.log('groupMetadata error:', e.message);
    }
    groupNameCache.set(jid, name);
    return name;
  }
  return pushName || `+${jid.split('@')[0]}`;
}

// ================= Online/Last seen tracking =================
const subscribedPresence = new Set(); // jid - already subscribe kora hoyeche
const lastPresence = new Map();       // jid -> 'available' | 'unavailable' (last pathano state)

function fmtLastSeen(unixSeconds) {
  if (!unixSeconds) return '';
  const d = new Date(unixSeconds * 1000);
  try {
    return d.toLocaleString('en-GB', { timeZone: 'Asia/Dhaka', hour12: true });
  } catch (e) {
    return d.toISOString();
  }
}

async function subscribePresence(jid) {
  if (jid.endsWith('@g.us')) return; // group e presence subscribe kaj kore na
  if (subscribedPresence.has(jid)) return;
  subscribedPresence.add(jid);
  try {
    await sock.presenceSubscribe(jid);
  } catch (e) {
    console.log('presenceSubscribe error:', e.message);
  }
}

async function handlePresenceUpdate(jid, presences) {
  const p = presences?.[jid];
  if (!p) return;
  const state = p.lastKnownPresence; // 'available' | 'unavailable' | 'composing' | 'recording' | 'paused'
  if (state !== 'available' && state !== 'unavailable') return; // typing/recording skip kori, spam na hoy

  if (lastPresence.get(jid) === state) return; // age theke eki obostha, abar pathano dorkar nai
  lastPresence.set(jid, state);

  const threadId = await getExistingTopicId(jid);
  if (!threadId) return; // ei contact er shathe kokhono message hoyni, topic nai

  if (state === 'available') {
    tg('sendMessage', { text: '🟢 Online', message_thread_id: threadId });
  } else {
    const seenText = p.lastSeen ? ` (last seen: ${fmtLastSeen(p.lastSeen)})` : '';
    tg('sendMessage', { text: `⚪ Offline${seenText}`, message_thread_id: threadId });
  }
}

// ================= Forward WhatsApp -> Telegram =================
const MEDIA = {
  imageMessage:    { method: 'sendPhoto',    field: 'photo' },
  videoMessage:    { method: 'sendVideo',    field: 'video' },
  audioMessage:    { method: 'sendAudio',    field: 'audio' },
  documentMessage: { method: 'sendDocument', field: 'document' },
  stickerMessage:  { method: 'sendDocument', field: 'document' },
};

function extFromMime(mime = '') {
  const e = mime.split(';')[0].split('/')[1] || 'bin';
  return e === 'jpeg' ? 'jpg' : e.replace('x-', '');
}
function isViewOnceRaw(raw) {
  return !!(raw.viewOnceMessage || raw.viewOnceMessageV2 || raw.viewOnceMessageV2Extension);
}

// Mucche fela (delete for everyone) message dhorle, matching Telegram message e
// "(deleted message)" jog kore dey
async function handleRevoke(m) {
  const pm = m.message?.protocolMessage;
  if (!pm || !pm.key) return;
  if (pm.type !== 0 && pm.type !== 'REVOKE') return;

  const jid = m.key.remoteJid;
  const mapKey = `${jid}:${pm.key.id}`;
  const info = waIdToTg.get(mapKey);
  if (!info) return; // amra age forward kori nai, kichu korar nai

  if (info.isCaption) {
    await tgJSON('editMessageCaption', {
      chat_id: info.chatId,
      message_id: info.messageId,
      caption: (info.caption || '').slice(0, 1000) + '\n\n(deleted message)',
    });
  } else {
    await tgJSON('editMessageText', {
      chat_id: info.chatId,
      message_id: info.messageId,
      text: (info.text || '').slice(0, 4000) + '\n\n(deleted message)',
    });
  }
}

async function forwardToTelegram(m) {
  const jid = m.key.remoteJid;
  if (jid === 'status@broadcast' && !INCLUDE_STATUS) return;

  if (m.message?.protocolMessage) {
    return handleRevoke(m);
  }

  if (m.key.fromMe) {
    // Amra nijera (bot diye, Telegram theke reply kore) ei message pathiyechi kina check kori -
    // na hole Telegram e nijer lekha message abar duplicate hoye ashbe
    if (outgoingWaToTg.has(`${jid}:${m.key.id}`)) return;
  }

  const content = normalizeMessageContent(m.message);
  if (!content) return;
  const type = getContentType(content);

  // Debug log (Render Logs e dekha jabe) - kon type ashche bujhte
  console.log('incoming:', type, 'jid:', jid, 'viewOnceFlag:', content[type]?.viewOnce === true, 'fromMe:', m.key.fromMe);

  const raw = m.message;
  const isViewOnce =
    !!(raw.viewOnceMessage || raw.viewOnceMessageV2 || raw.viewOnceMessageV2Extension) ||
    content[type]?.viewOnce === true;
  const tag = isViewOnce ? '👁 VIEW ONCE\n' : '';

  const sender = m.key.participant || jid;
  const label = m.key.fromMe
    ? 'Tumi (phone theke)' + (jid.endsWith('@g.us') ? ' [group]' : '')
    : `${m.pushName || 'Unknown'} (+${sender.split('@')[0]})` +
      (jid.endsWith('@g.us') ? ' [group]' : '');

  const chatName = await getChatName(jid, m.pushName);
  const threadId = await getOrCreateTopic(jid, chatName);
  const threadField = threadId ? { message_thread_id: threadId } : {};
  subscribePresence(jid).catch(() => {});
  const sayIn = (text) => tg('sendMessage', { text: String(text).slice(0, 4096), ...threadField });

  const mapKey = `${jid}:${m.key.id}`;

  if (type === 'conversation' || type === 'extendedTextMessage') {
    const text = content.conversation || content.extendedTextMessage?.text || '';
    inbox.unshift({ from: jid, name: m.pushName || '', text, time: Date.now() });
    if (inbox.length > 100) inbox.pop();
    const fullText = `${label}:\n${text}`;
    const res = await sayIn(fullText);
    if (res?.ok) {
      boundedSet(waIdToTg, mapKey, { chatId: TG_CHAT, messageId: res.result.message_id, isCaption: false, text: fullText });
      boundedSet(tgMsgToWa, `${TG_CHAT}:${res.result.message_id}`, { jid, key: m.key });
    }
    return;
  }

  const cfg = MEDIA[type];
  if (!cfg) {
    if (isViewOnceRaw(m.message)) {
      // view once wrapper elo kintu ador bhetore chena media type pelam na
      console.log('view-once wrapper but unknown inner type:', type);
    }
    return;
  }

  try {
    const buffer = await downloadMediaMessage(
      { key: m.key, message: content },
      'buffer',
      {},
      { logger, reuploadRequest: sock.updateMediaMessage }
    );
    const info = content[type];
    const name =
      info.fileName ||
      `${type.replace('Message', '')}_${Date.now()}.${
        type === 'stickerMessage' ? 'webp' : extFromMime(info.mimetype)
      }`;
    let method = cfg.method, field = cfg.field;
    if (type === 'audioMessage' && info.ptt) { method = 'sendVoice'; field = 'voice'; }

    const caption = `${tag}${label}${info.caption ? '\n' + info.caption : ''}`.slice(0, 1024);
    const res = await tg(method, { caption, ...threadField }, { field, buffer, name });
    if (res?.ok) {
      boundedSet(waIdToTg, mapKey, { chatId: TG_CHAT, messageId: res.result.message_id, isCaption: true, caption });
      boundedSet(tgMsgToWa, `${TG_CHAT}:${res.result.message_id}`, { jid, key: m.key });
    }
  } catch (e) {
    console.log('Media forward error:', e.message);
    sayIn(`${tag}${label}: file download hoy nai (${e.message})`);
  }
}

// ================= Session storage (Firebase Realtime Database) =================
// BEGIN AUTH
const { GoogleAuth } = require('google-auth-library');
const FIREBASE_DB_URL = (process.env.FIREBASE_DB_URL || '').replace(/\/+$/, '');
const FIREBASE_SERVICE_ACCOUNT = process.env.FIREBASE_SERVICE_ACCOUNT || '';
const USE_DB = !!(FIREBASE_DB_URL && FIREBASE_SERVICE_ACCOUNT);
const B = require('@whiskeysockets/baileys');

let googleAuthClient = null;
function getGoogleAuth() {
  if (!googleAuthClient) {
    const credentials = JSON.parse(FIREBASE_SERVICE_ACCOUNT);
    googleAuthClient = new GoogleAuth({
      credentials,
      scopes: [
        'https://www.googleapis.com/auth/firebase.database',
        'https://www.googleapis.com/auth/userinfo.email',
      ],
    });
  }
  return googleAuthClient;
}
async function fbToken() {
  const client = await getGoogleAuth().getClient();
  const res = await client.getAccessToken();
  return typeof res === 'string' ? res : res.token;
}
// Baileys er key id te '.', '#', '$', '[', ']' thakte pare, Firebase e eigula path e allowed na,
// tai base64url diye safe kore felchi.
const encKey = (k) => Buffer.from(k, 'utf8').toString('base64url');

async function dbGet(k) {
  const token = await fbToken();
  const r = await fetch(`${FIREBASE_DB_URL}/wa_auth/${encKey(k)}.json?access_token=${token}`);
  if (!r.ok) throw new Error('db get ' + r.status);
  return r.json(); // null jodi na thake, na hoy amader save kora string
}
async function dbSet(k, v) {
  const token = await fbToken();
  const r = await fetch(`${FIREBASE_DB_URL}/wa_auth/${encKey(k)}.json?access_token=${token}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(v),
  });
  if (!r.ok) throw new Error('db set ' + r.status + ' ' + (await r.text()));
}
async function dbDel(k) {
  const token = await fbToken();
  const r = await fetch(`${FIREBASE_DB_URL}/wa_auth/${encKey(k)}.json?access_token=${token}`, { method: 'DELETE' });
  if (!r.ok) throw new Error('db del ' + r.status);
}
async function dbDelAll() {
  const token = await fbToken();
  const r = await fetch(`${FIREBASE_DB_URL}/wa_auth.json?access_token=${token}`, { method: 'DELETE' });
  if (!r.ok) throw new Error('db delall ' + r.status);
}

async function useFirebaseAuthState() {
  const read = async (k) => {
    const v = await dbGet(k);
    return v ? JSON.parse(v, B.BufferJSON.reviver) : null;
  };
  const write = (k, data) => dbSet(k, JSON.stringify(data, B.BufferJSON.replacer));

  const creds = (await read('creds')) || B.initAuthCreds();

  return {
    state: {
      creds,
      keys: {
        get: async (type, ids) => {
          const data = {};
          await Promise.all(
            ids.map(async (id) => {
              let value = await read(`${type}-${id}`);
              if (type === 'app-state-sync-key' && value) {
                value = B.proto.Message.AppStateSyncKeyData.fromObject(value);
              }
              data[id] = value;
            })
          );
          return data;
        },
        set: async (data) => {
          const tasks = [];
          for (const category in data) {
            for (const id in data[category]) {
              const value = data[category][id];
              const key = `${category}-${id}`;
              tasks.push(value ? write(key, value) : dbDel(key));
            }
          }
          await Promise.all(tasks);
        },
      },
    },
    saveCreds: () => write('creds', creds),
  };
}

async function getAuthState() {
  return USE_DB ? useFirebaseAuthState() : useMultiFileAuthState('auth');
}
async function clearAuth() {
  if (USE_DB) await dbDelAll().catch((e) => console.log('clearAuth error:', e.message));
  else fs.rmSync('auth', { recursive: true, force: true });
}
// END AUTH

// ================= WhatsApp connection =================
async function startWA(pairNumber) {
  const { state, saveCreds } = await getAuthState();
  registered = !!state.creds.registered;
  const { version } = await fetchLatestBaileysVersion();

  const s = makeWASocket({
    version,
    auth: state,
    logger,
    browser: ['WA Server', 'Chrome', '1.0.0'],
  });
  sock = s;

  // Pairing code WS khola matroi chaite hobe, QR dekha deoar pore na -
  // socket.waitForSocketOpen() diye WS ready howa porjonto wait kori, tarpor
  // shathe shathei code request kori (WhatsApp er registration decision
  // er age e creds.me set hoye jay).
  if (pairNumber) {
    (async () => {
      try {
        await s.waitForSocketOpen();
        const raw = await s.requestPairingCode(pairNumber);
        if (pairingResolve) pairingResolve({ ok: true, raw });
      } catch (e) {
        if (pairingResolve) pairingResolve({ ok: false, error: e.message });
      }
    })();
  }

  s.ev.on('creds.update', saveCreds);

  s.ev.on('connection.update', async ({ connection, lastDisconnect, qr }) => {
    if (s !== sock) return;

    if (qr) {
      lastQR = qr;
      status = 'waiting_qr';
      if (!notifiedNeedLink) {
        notifiedNeedLink = true;
        say('WhatsApp link kora nai.\n\n/qr  - QR code pathabo\n/link 8801XXXXXXXXX  - number diye code pathabo');
      }
    }

    if (connection === 'open') {
      lastQR = null;
      status = 'connected';
      notifiedNeedLink = false;
      registered = true;
      console.log('WhatsApp connected');
      say('✅ WhatsApp connected. Ekhon theke message/file ekhane ashbe.');
      // Bot 24/7 connected thake bole WhatsApp "always online" dekhay; nijeke
      // unavailable bole jaliye dilei online/last-seen sudhu phone er obostha onujayi dekhabe
      s.sendPresenceUpdate('unavailable').catch((e) =>
        console.log('sendPresenceUpdate error:', e.message)
      );
    }

    if (connection === 'close') {
      const code = lastDisconnect?.error?.output?.statusCode;
      status = 'disconnected';
      if (code === DisconnectReason.loggedOut) {
        // session sesh: purano auth muche notun kore shuru
        await clearAuth();
        lastQR = null;
        notifiedNeedLink = false;
        registered = false;
        say('⚠️ WhatsApp logged out hoyeche. Abar link korte /qr ba /link NUMBER pathao.');
        setTimeout(() => startWA().catch((e) => console.log('restart error:', e.message)), 2000);
      } else {
        const delay = code === DisconnectReason.connectionReplaced ? 20000 : 3000;
        setTimeout(() => startWA().catch((e) => console.log('restart error:', e.message)), delay);
      }
    }
  });

  s.ev.on('messages.upsert', ({ messages, type }) => {
    if (type !== 'notify') return;
    for (const m of messages) {
      if (!m.message) continue;
      // fromMe:true o ekhon forward kori (phone theke pathano message dekhanor jonne);
      // amra nijera Telegram theke pathano reply abar duplicate hishebe asha thekate
      // forwardToTelegram nijei check kore (outgoingWaToTg te thakle skip kore)
      forwardToTelegram(m).catch((e) => console.log('forward error:', e.message));
    }
  });

  s.ev.on('presence.update', ({ id, presences }) => {
    if (s !== sock) return;
    handlePresenceUpdate(id, presences).catch((e) => console.log('presence handle error:', e.message));
  });

  // Amra WhatsApp e ja পাঠাই, tar status (sent/delivered/seen) e update ashle
  // matching Telegram message e reaction diye dekhiye dei
  s.ev.on('messages.update', (updates) => {
    for (const u of updates) {
      const st = u.update?.status;
      if (st == null) continue;
      const mapKey = `${u.key.remoteJid}:${u.key.id}`;
      const info = outgoingWaToTg.get(mapKey);
      if (!info) continue;
      let emoji = null;
      if (st === 2) emoji = '🕐';       // SERVER_ACK - WA server e pouche geche
      else if (st === 3) emoji = '✅';  // DELIVERY_ACK - recipient er phone e pouche geche
      else if (st === 4) emoji = '👀';  // READ - dekhe fele geche
      if (emoji) {
        setTgReaction(info.chatId, info.messageId, emoji).catch((e) =>
          console.log('status reaction error:', e.message)
        );
      }
    }
  });
}

// Notun kore QR ba pairing code neoar jonne, purono session muche fresh socket banay
async function relink(pairNumber) {
  const old = sock;
  await clearAuth();
  lastQR = null;
  notifiedNeedLink = false;
  registered = false;
  await startWA(pairNumber);
  if (old) {
    try { old.end(new Error('Relinking')); } catch (e) { /* ignore */ }
  }
}

async function waitForQR(ms = 25000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (status === 'connected') return false;
    if (lastQR) return true;
    await sleep(500);
  }
  return false;
}

// ================= Telegram bot commands =================
async function handleCommand(text) {
  const [cmdRaw, ...args] = text.trim().split(/\s+/);
  const cmd = cmdRaw.split('@')[0].toLowerCase();

  if (cmd === '/start' || cmd === '/help') {
    return say(
      'Commands:\n' +
      '/qr - WhatsApp link korar QR code\n' +
      '/link 8801XXXXXXXXX - number diye link code (country code shoho, + chhara)\n' +
      '/status - ekhon kon obosthay ache\n' +
      '/logout - WhatsApp theke bichchhinno'
    );
  }

  if (cmd === '/status') {
    const map = {
      starting: 'Shuru hocche...',
      waiting_qr: 'Link kora nai (QR/code dorkar)',
      connected: 'Connected ✅',
      disconnected: 'Disconnected, abar connect hocche...',
    };
    return say(map[status] || status);
  }

  if (cmd === '/qr') {
    if (status === 'connected') return say('Already connected ✅. Notun kore link korte age /logout dao.');
    if (registered && status !== 'waiting_qr') {
      return say('Age theke ekta WhatsApp session ache, reconnect hocche. Notun kore QR nite hole age /logout dao.');
    }
    if (linking) return say('Ektu ager kaj cholche, ektu opekkha koro...');
    linking = true;
    try {
      say('QR toiri hocche, ektu opekkha koro...');
      await relink();
      const ok = await waitForQR();
      if (!ok) return say(status === 'connected' ? 'Already connected ✅' : 'QR ashe nai. Ektu pore abar /qr dao.');
      const buffer = await QRCode.toBuffer(lastQR, { width: 500, margin: 2 });
      await tg('sendPhoto', {
        caption: 'Onno ekta device e eta kholo, tarpor tomar phone e WhatsApp > Linked devices > Link a device diye scan koro.\n\nQR 20 second e expire hoy, na hole abar /qr dao.\n\nEkoi phone e thakle /link NUMBER babohar koro.',
      }, { field: 'photo', buffer, name: 'qr.png' });
    } catch (e) {
      console.log('qr error:', e.message);
      say('QR toiri hoy nai: ' + e.message);
    } finally {
      linking = false;
    }
    return;
  }

  if (cmd === '/link') {
    if (status === 'connected') return say('Already connected ✅. Notun kore link korte age /logout dao.');
    if (registered && status !== 'waiting_qr') {
      return say('Age theke ekta WhatsApp session ache, reconnect hocche. Notun number link korte age /logout dao.');
    }
    const number = (args[0] || '').replace(/\D/g, '');
    if (number.length < 8) {
      return say('Number den: /link 8801XXXXXXXXX\n(country code shoho, + ba space chhara)');
    }
    if (linking) return say('Ektu ager kaj cholche, ektu opekkha koro...');
    linking = true;
    say('Code toiri hocche, ektu opekkha koro...');
    try {
      const result = await new Promise((resolve) => {
        pairingResolve = resolve;
        relink(number).catch((e) => resolve({ ok: false, error: e.message }));
        setTimeout(() => resolve({ ok: false, error: 'Shomoy sesh hoye geche (timeout), abar chesta koro' }), 20000);
      });
      pairingResolve = null;
      if (!result.ok) {
        return say('Code toiri hoy nai: ' + result.error + '\nAbar /link dao, ba /qr babohar koro.');
      }
      const code = result.raw.match(/.{1,4}/g).join('-');
      await sayHTML(
        'Phone e: WhatsApp > Linked devices > Link a device > "Link with phone number instead" e jao.\n\n' +
        'Niche code e ekbar chap dilei copy hoye jabe, tarpor WhatsApp e 60 second er moddhe paste koro 👇'
      );
      await sayHTML(`<code>${code}</code>`);
      return say('Code kaj na korle /link abar dao.');
    } catch (e) {
      console.log('pairing error:', e.message);
      return say('Code toiri hoy nai: ' + e.message + '\nAbar /link dao, ba /qr babohar koro.');
    } finally {
      linking = false;
    }
  }

  if (cmd === '/logout') {
    if (status !== 'connected') return say('Connected nai, tai logout dorkar nai.');
    try {
      await sock.logout();
      return say('Logout hocche... kichukkhon pore /qr ba /link dao.');
    } catch (e) {
      return say('Logout error: ' + e.message);
    }
  }
}

async function replyToWhatsApp(threadId, text, tgMessageId) {
  console.log('replyToWhatsApp: threadId=', threadId, 'textLen=', text?.length);
  const jid = await getJidByThread(threadId);
  console.log('replyToWhatsApp: resolved jid=', jid);
  if (!jid) {
    // Age chupchap kichu na kore chole jeto - ekhon keno pathano gelo na seta
    // Telegram e e dekhiye dicchi, jate bujha jay sommosya ki.
    return tg('sendMessage', {
      text: '⚠️ Ei topic ta kono WhatsApp contact er shathe match pawa jacche na (threadId: ' + threadId + '). Topic ta notun kore message asle banbe.',
      message_thread_id: threadId,
    });
  }
  if (status !== 'connected') {
    return tg('sendMessage', {
      text: '⚠️ WhatsApp ekhon connected nai, message পাঠানো gelo na.',
      message_thread_id: threadId,
    });
  }
  try {
    const res = await sock.sendMessage(jid, { text });
    console.log('replyToWhatsApp: sent ok, wa message id=', res?.key?.id);
    if (res?.key?.id && tgMessageId) {
      boundedSet(outgoingWaToTg, `${jid}:${res.key.id}`, { chatId: TG_CHAT, messageId: tgMessageId });
      setTgReaction(TG_CHAT, tgMessageId, '🕐').catch(() => {}); // "pathano hoyeche" - WA server theke ack asar age
    }
  } catch (e) {
    console.log('reply-to-whatsapp error:', e.message);
    tg('sendMessage', { text: '⚠️ Message pathano gelo na: ' + e.message, message_thread_id: threadId });
  }
}

// Telegram theke file/photo download kore Buffer hisebe ferot dey
async function tgDownloadFile(fileId) {
  const infoRes = await fetch(`https://api.telegram.org/bot${TG_TOKEN}/getFile?file_id=${fileId}`);
  const info = await infoRes.json();
  if (!info.ok) throw new Error(info.description || 'getFile failed');
  const fileRes = await fetch(`https://api.telegram.org/file/bot${TG_TOKEN}/${info.result.file_path}`);
  const arrBuf = await fileRes.arrayBuffer();
  return Buffer.from(arrBuf);
}

// Telegram theke pathano chobi/file/voice WhatsApp e forward kore
async function replyMediaToWhatsApp(threadId, msg) {
  const jid = await getJidByThread(threadId);
  if (!jid) return;
  if (status !== 'connected') {
    return tg('sendMessage', {
      text: '⚠️ WhatsApp ekhon connected nai, file পাঠানো gelo na.',
      message_thread_id: threadId,
    });
  }
  try {
    let content;
    const caption = msg.caption || undefined;
    if (msg.photo) {
      const biggest = msg.photo[msg.photo.length - 1];
      const buffer = await tgDownloadFile(biggest.file_id);
      content = { image: buffer, caption };
    } else if (msg.video) {
      const buffer = await tgDownloadFile(msg.video.file_id);
      content = { video: buffer, caption };
    } else if (msg.voice) {
      const buffer = await tgDownloadFile(msg.voice.file_id);
      content = { audio: buffer, mimetype: 'audio/ogg; codecs=opus', ptt: true };
    } else if (msg.audio) {
      const buffer = await tgDownloadFile(msg.audio.file_id);
      content = { audio: buffer, mimetype: msg.audio.mime_type || 'audio/mpeg' };
    } else if (msg.document) {
      const buffer = await tgDownloadFile(msg.document.file_id);
      content = { document: buffer, mimetype: msg.document.mime_type, fileName: msg.document.file_name, caption };
    } else if (msg.sticker) {
      const buffer = await tgDownloadFile(msg.sticker.file_id);
      content = { sticker: buffer };
    } else {
      return;
    }
    await sock.sendMessage(jid, content);
  } catch (e) {
    console.log('reply-media-to-whatsapp error:', e.message);
    tg('sendMessage', { text: '⚠️ File pathano gelo na: ' + e.message, message_thread_id: threadId });
  }
}

// Telegram e kono forward-kora message e react korle, ota WhatsApp e o react hisebe cole jay
async function handleTelegramReaction(mr) {
  const key = `${mr.chat.id}:${mr.message_id}`;
  const info = tgMsgToWa.get(key);
  if (!info) return; // ei message ta amader map e nai (purono/restart-er age kar hote pare)
  if (status !== 'connected') return;
  const emoji = mr.new_reaction?.[0]?.emoji || ''; // khali mane reaction tule newa hoyeche
  try {
    await sock.sendMessage(info.jid, { react: { text: emoji, key: info.key } });
  } catch (e) {
    console.log('reaction forward error:', e.message);
  }
}

async function pollTelegram() {
  if (!TG_TOKEN || !TG_CHAT) return console.log('TELEGRAM_BOT_TOKEN / TELEGRAM_CHAT_ID set koro');
  let offset = 0;
  try {
    await fetch(`https://api.telegram.org/bot${TG_TOKEN}/deleteWebhook`);
    await fetch(`https://api.telegram.org/bot${TG_TOKEN}/setMyCommands`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        commands: [
          { command: 'qr', description: 'WhatsApp link korar QR code' },
          { command: 'link', description: 'Number diye link: /link 8801XXXXXXXXX' },
          { command: 'status', description: 'Obostha dekho' },
          { command: 'logout', description: 'WhatsApp theke bichchhinno' },
        ],
      }),
    });
  } catch (e) {
    console.log('tg init error:', e.message);
  }

  const ALLOWED_UPDATES = JSON.stringify(['message', 'message_reaction']);

  while (true) {
    try {
      const r = await fetch(
        `https://api.telegram.org/bot${TG_TOKEN}/getUpdates?timeout=30&offset=${offset}&allowed_updates=${encodeURIComponent(ALLOWED_UPDATES)}`
      );
      const j = await r.json();
      if (!j.ok) {
        console.log('getUpdates error:', j.description);
        await sleep(5000);
        continue;
      }
      for (const u of j.result) {
        offset = u.update_id + 1;
        console.log('tg update keys:', Object.keys(u).filter((k) => k !== 'update_id'));

        if (u.message_reaction) {
          console.log('message_reaction raw:', JSON.stringify(u.message_reaction));
          if (String(u.message_reaction.chat.id) !== TG_CHAT) continue;
          handleTelegramReaction(u.message_reaction).catch((e) =>
            console.log('handleTelegramReaction error:', e.message)
          );
          continue;
        }

        const msg = u.message;
        if (!msg) continue;
        if (String(msg.chat.id) !== TG_CHAT) continue; // shudhu amader group
        if (msg.from?.is_bot) continue; // bot nijer message abar na porke

        if (msg.text?.startsWith('/')) {
          handleCommand(msg.text).catch((e) => {
            console.log('command error:', e.message);
            say('Error: ' + e.message);
          });
          continue;
        }

        if (!msg.message_thread_id) continue; // General topic - kichu kora hobe na

        if (msg.text) {
          // Kono Topic er bhetore shadharon text likhle, ota shei contact er
          // WhatsApp number e reply hisebe cole jay
          replyToWhatsApp(msg.message_thread_id, msg.text, msg.message_id).catch((e) =>
            console.log('replyToWhatsApp error:', e.message)
          );
        } else if (msg.photo || msg.video || msg.voice || msg.audio || msg.document || msg.sticker) {
          replyMediaToWhatsApp(msg.message_thread_id, msg).catch((e) =>
            console.log('replyMediaToWhatsApp error:', e.message)
          );
        }
      }
    } catch (e) {
      console.log('poll error:', e.message);
      await sleep(5000);
    }
  }
}

// ================= HTTP (health + optional API) =================
const app = express();
app.use(express.json());

function auth(req, res, next) {
  if (!API_KEY || req.headers['x-api-key'] === API_KEY) return next();
  res.status(401).json({ error: 'unauthorized' });
}

app.get('/', (req, res) => res.json({ status }));

app.post('/send', auth, async (req, res) => {
  try {
    if (status !== 'connected') return res.status(503).json({ error: 'not connected' });
    const { number, text } = req.body;
    if (!number || !text) return res.status(400).json({ error: 'number & text lagbe' });
    const jid = number.includes('@') ? number : number.replace(/\D/g, '') + '@s.whatsapp.net';
    const r = await sock.sendMessage(jid, { text });
    res.json({ ok: true, id: r.key.id });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/messages', auth, (req, res) => res.json(inbox));

app.listen(PORT, () => console.log('Server running on ' + PORT));
if (!USE_DB) say('⚠️ FIREBASE_DB_URL/FIREBASE_SERVICE_ACCOUNT set kora nai. Server restart hole WhatsApp abar link korte hobe.');
startWA().catch((e) => console.log('start error:', e.message));
pollTelegram();
