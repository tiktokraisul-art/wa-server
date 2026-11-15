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
const inbox = [];

process.on('unhandledRejection', (e) => console.log('unhandledRejection:', e?.message || e));
process.on('uncaughtException', (e) => console.log('uncaughtException:', e?.message || e));

// ================= Telegram helpers =================
async function tg(method, fields = {}, file = null) {
  if (!TG_TOKEN || !TG_CHAT) return console.log('Telegram env set kora nai');
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
  } catch (e) {
    console.log('Telegram fetch error:', e.message);
  }
}
const say = (text) => tg('sendMessage', { text: String(text).slice(0, 4096) });
const sayHTML = (text) => tg('sendMessage', { text: String(text).slice(0, 4096), parse_mode: 'HTML' });

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

async function forwardToTelegram(m) {
  const jid = m.key.remoteJid;
  if (jid === 'status@broadcast' && !INCLUDE_STATUS) return;

  const content = normalizeMessageContent(m.message);
  if (!content) return;
  const type = getContentType(content);

  // Debug log (Render Logs e dekha jabe) - kon type ashche bujhte
  console.log('incoming:', type, 'viewOnceFlag:', content[type]?.viewOnce === true);

  const raw = m.message;
  const isViewOnce =
    !!(raw.viewOnceMessage || raw.viewOnceMessageV2 || raw.viewOnceMessageV2Extension) ||
    content[type]?.viewOnce === true;
  const tag = isViewOnce ? '👁 VIEW ONCE\n' : '';

  const sender = m.key.participant || jid;
  const label =
    `${m.pushName || 'Unknown'} (+${sender.split('@')[0]})` +
    (jid.endsWith('@g.us') ? ' [group]' : '');

  if (type === 'conversation' || type === 'extendedTextMessage') {
    const text = content.conversation || content.extendedTextMessage?.text || '';
    inbox.unshift({ from: jid, name: m.pushName || '', text, time: Date.now() });
    if (inbox.length > 100) inbox.pop();
    return say(`${label}:\n${text}`);
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
    await tg(method, { caption }, { field, buffer, name });
  } catch (e) {
    console.log('Media forward error:', e.message);
    say(`${tag}${label}: file download hoy nai (${e.message})`);
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
async function startWA() {
  const { state, saveCreds } = await getAuthState();
  const { version } = await fetchLatestBaileysVersion();

  const s = makeWASocket({
    version,
    auth: state,
    logger,
    browser: ['WA Server', 'Chrome', '1.0.0'],
  });
  sock = s;

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
      console.log('WhatsApp connected');
      say('✅ WhatsApp connected. Ekhon theke message/file ekhane ashbe.');
    }

    if (connection === 'close') {
      const code = lastDisconnect?.error?.output?.statusCode;
      status = 'disconnected';
      if (code === DisconnectReason.loggedOut) {
        // session sesh: purano auth muche notun kore shuru
        await clearAuth();
        lastQR = null;
        notifiedNeedLink = false;
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
      if (!m.message || m.key.fromMe) continue;
      forwardToTelegram(m).catch((e) => console.log('forward error:', e.message));
    }
  });
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
    say('QR toiri hocche, ektu opekkha koro...');
    const ok = await waitForQR();
    if (!ok) return say(status === 'connected' ? 'Already connected ✅' : 'QR ashe nai. Ektu pore abar /qr dao.');
    const buffer = await QRCode.toBuffer(lastQR, { width: 500, margin: 2 });
    await tg('sendPhoto', {
      caption: 'Onno ekta device e eta kholo, tarpor tomar phone e WhatsApp > Linked devices > Link a device diye scan koro.\n\nQR 20 second e expire hoy, na hole abar /qr dao.\n\nEkoi phone e thakle /link NUMBER babohar koro.',
    }, { field: 'photo', buffer, name: 'qr.png' });
    return;
  }

  if (cmd === '/link') {
    if (status === 'connected') return say('Already connected ✅. Notun kore link korte age /logout dao.');
    const number = (args[0] || '').replace(/\D/g, '');
    if (number.length < 8) {
      return say('Number den: /link 8801XXXXXXXXX\n(country code shoho, + ba space chhara)');
    }
    say('Code toiri hocche, ektu opekkha koro...');
    const ready = await waitForQR();
    if (!ready) return say(status === 'connected' ? 'Already connected ✅' : 'Server ready na. Ektu pore abar chesta koro.');
    try {
      const raw = await sock.requestPairingCode(number);
      await sayHTML(
        'Phone e: WhatsApp > Linked devices > Link a device > "Link with phone number instead" e jao.\n\n' +
        'Niche code e ekbar chap dilei copy hoye jabe, tarpor WhatsApp e paste koro 👇'
      );
      await sayHTML(`<code>${raw}</code>`);
      return say('Code kaj na korle /link abar dao.');
    } catch (e) {
      console.log('pairing error:', e.message);
      return say('Code toiri hoy nai: ' + e.message + '\nAbar /link dao, ba /qr babohar koro.');
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

  while (true) {
    try {
      const r = await fetch(
        `https://api.telegram.org/bot${TG_TOKEN}/getUpdates?timeout=30&offset=${offset}`
      );
      const j = await r.json();
      if (!j.ok) {
        console.log('getUpdates error:', j.description);
        await sleep(5000);
        continue;
      }
      for (const u of j.result) {
        offset = u.update_id + 1;
        const msg = u.message;
        if (!msg || !msg.text) continue;
        if (String(msg.chat.id) !== TG_CHAT) continue; // shudhu tumi
        if (!msg.text.startsWith('/')) continue;
        handleCommand(msg.text).catch((e) => {
          console.log('command error:', e.message);
          say('Error: ' + e.message);
        });
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
