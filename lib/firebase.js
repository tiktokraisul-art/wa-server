// Generic Firebase Realtime Database REST helper - WhatsApp session, Telegram
// topic mapping, ar chat history - shobar jonne eki helper e babohar hoy.
const fs = require('fs');
const { GoogleAuth } = require('google-auth-library');
const B = require('@whiskeysockets/baileys');

const FIREBASE_DB_URL = (process.env.FIREBASE_DB_URL || '').replace(/\/+$/, '');
const FIREBASE_SERVICE_ACCOUNT = process.env.FIREBASE_SERVICE_ACCOUNT || '';
const USE_DB = !!(FIREBASE_DB_URL && FIREBASE_SERVICE_ACCOUNT);

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

// Baileys er key id te '.', '#', '$', '[', ']' thakte pare, Firebase e eigula path e
// allowed na, tai base64url diye safe kore felchi. Onno module gulo o ei function
// diye nijeder key safe korbe.
const encKey = (k) => Buffer.from(String(k), 'utf8').toString('base64url');
const decodeKey = (enc) => Buffer.from(enc, 'base64url').toString('utf8');

// ---- Generic path-level read/write (wa_auth chhara onno shob kichur jonne) ----
async function fbGet(path) {
  if (!USE_DB) return null;
  const token = await fbToken();
  const r = await fetch(`${FIREBASE_DB_URL}/${path}.json?access_token=${token}`);
  if (!r.ok) throw new Error('fbGet ' + path + ' -> ' + r.status);
  return r.json();
}
async function fbSet(path, value) {
  if (!USE_DB) return;
  const token = await fbToken();
  const r = await fetch(`${FIREBASE_DB_URL}/${path}.json?access_token=${token}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(value),
  });
  if (!r.ok) throw new Error('fbSet ' + path + ' -> ' + r.status + ' ' + (await r.text()));
}
// path er nodeTa te notun ekta child push kore (Firebase-style push id, somoy onujayi sajano)
async function fbPush(path, value) {
  if (!USE_DB) return null;
  const token = await fbToken();
  const r = await fetch(`${FIREBASE_DB_URL}/${path}.json?access_token=${token}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(value),
  });
  if (!r.ok) throw new Error('fbPush ' + path + ' -> ' + r.status);
  const j = await r.json();
  return j.name; // notun toiri howa push key
}
async function fbDelete(path) {
  if (!USE_DB) return;
  const token = await fbToken();
  const r = await fetch(`${FIREBASE_DB_URL}/${path}.json?access_token=${token}`, { method: 'DELETE' });
  if (!r.ok) throw new Error('fbDelete ' + path + ' -> ' + r.status);
}
// Query: child ke kono field diye order kore, last N ta ber kore ane (shesh porjonto newest).
// Firebase REST orderBy+limitToLast babohar kore.
async function fbQueryLastN(path, orderByChild, n) {
  if (!USE_DB) return {};
  const token = await fbToken();
  const url = `${FIREBASE_DB_URL}/${path}.json?orderBy=${encodeURIComponent('"' + orderByChild + '"')}&limitToLast=${n}&access_token=${token}`;
  const r = await fetch(url);
  if (!r.ok) throw new Error('fbQueryLastN ' + path + ' -> ' + r.status);
  return (await r.json()) || {};
}

// ---- WhatsApp session (Baileys auth state) - wa_auth node e, BufferJSON diye ----
async function dbGet(k) {
  const token = await fbToken();
  const r = await fetch(`${FIREBASE_DB_URL}/wa_auth/${encKey(k)}.json?access_token=${token}`);
  if (!r.ok) throw new Error('db get ' + r.status);
  return r.json();
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
  const { useMultiFileAuthState } = require('@whiskeysockets/baileys');
  return USE_DB ? useFirebaseAuthState() : useMultiFileAuthState('auth');
}
async function clearAuth() {
  if (USE_DB) await dbDelAll().catch((e) => console.log('clearAuth error:', e.message));
  else fs.rmSync('auth', { recursive: true, force: true });
}

module.exports = {
  USE_DB,
  FIREBASE_DB_URL,
  encKey,
  decodeKey,
  fbGet,
  fbSet,
  fbPush,
  fbDelete,
  fbQueryLastN,
  getAuthState,
  clearAuth,
};
