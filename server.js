// Import modul yang diperlukan
const WebSocket = require('ws');
const http = require('http');
const { createClient } = require('redis');
const url = require('url');
require('dotenv').config();

// Ambil konfigurasi dari file .env
const PORT = process.env.PORT || 9696;
const WEBSOCKET_SECRET_KEY = process.env.WEBSOCKET_SECRET_KEY;
// Ambil REDIS_URL dari .env, pastikan Anda sudah menggantinya ke redis://...
const REDIS_URL = process.env.REDIS_URL; 

if (!WEBSOCKET_SECRET_KEY) {
  console.error("ERROR: WEBSOCKET_SECRET_KEY tidak diatur di file .env");
  process.exit(1);
}
if (!REDIS_URL) {
  console.error("ERROR: REDIS_URL tidak diatur di file .env");
  process.exit(1);
}

console.log(`[INIT] Mencoba terhubung ke Redis di: ${REDIS_URL}`);

// Buat server HTTP dasar (diperlukan oleh 'ws')
const server = http.createServer();

// Inisialisasi WebSocket Server (WSS)
const wss = new WebSocket.Server({ server });

const channels = new Map();
const redisSubscribedTopics = new Set();

// --- Konfigurasi Klien Redis ---
const redisClient = createClient({ url: REDIS_URL });
const subscriber = redisClient.duplicate();

// --- LOG DIAGNOSTIK untuk Redis ---
redisClient.on('error', (err) => console.error('[REDIS-PUB] Publisher Error:', err));
subscriber.on('error', (err) => console.error('[REDIS-SUB] Subscriber Error:', err));
// ---------------------------------

(async () => {
  try {
    await redisClient.connect();
    await subscriber.connect();
    console.log('✅ [REDIS] Terhubung ke Redis server (Publisher dan Subscriber).');

    // --- PERBAIKAN: Handler global 'message' DIHAPUS DARI SINI ---
    // Logika broadcast akan dipindahkan ke callback .subscribe()

  } catch (err) {
    console.error('❌ Gagal terhubung ke Redis:', err);
    process.exit(1);
  }
})();

// --- Handler untuk Koneksi WebSocket Baru ---
wss.on('connection', (ws, req) => {
  const { query } = url.parse(req.url, true);
  const clientToken = query.token;

  if (clientToken !== WEBSOCKET_SECRET_KEY) {
    console.log('[AUTH] Koneksi ditolak: Secret key salah.');
    ws.send(JSON.stringify({ error: 'Unauthorized', status: 401 }));
    ws.close(1008, 'Unauthorized');
    return;
  }

  console.log('✅ [WSS] Klien terhubung dengan sukses.');
  ws.send(JSON.stringify({ status: 'connected', message: 'Welcome!' }));

  // Handler untuk Pesan Masuk dari Klien
  ws.on('message', async (message) => {
    let parsed;
    try {
      parsed = JSON.parse(message);
    } catch (e) {
      console.warn('Menerima format pesan non-JSON:', message);
      return;
    }

    const { action, channel, data } = parsed;

    switch (action) {
      case 'subscribe':
        if (!channel) return;

        if (!channels.has(channel)) {
          channels.set(channel, new Set());
        }
        channels.get(channel).add(ws);
        console.log(`[SUB] Klien subscribe ke channel: ${channel}. Total klien di channel ini: ${channels.get(channel).size}`);

        if (!redisSubscribedTopics.has(channel)) {
          try {
            // --- PERBAIKAN: Logika broadcast dipindahkan ke sini ---
            await subscriber.subscribe(channel, (message, topic) => {
              // --- LOG DIAGNOSTIK #1 ---
              console.log(`\n🔥 [REDIS SUB] Pesan diterima dari Redis di topik: '${topic}'`);
              
              const clients = channels.get(topic);
              if (!clients) {
                console.warn(`[REDIS SUB] Menerima pesan, tapi tidak ada klien lokal untuk topik '${topic}'`);
                return;
              }

              console.log(`[REDIS SUB] Menyiarkan ke ${clients.size} klien lokal.`);

              let data;
              try {
                // 'message' di sini adalah data string yang kita publish
                data = JSON.parse(message);
              } catch (e) {
                console.error('[REDIS SUB] Gagal mem-parsing JSON dari Redis:', e.message);
                return;
              }
              
              const broadcastMessage = JSON.stringify({
                event: 'message',
                channel: topic,
                data: data,
              });

              // Kirim pesan ke setiap klien yang terhubung di server INI
              clients.forEach(client => {
                if (client.readyState === WebSocket.OPEN) {
                  // --- LOG DIAGNOSTIK #2 ---
                  console.log(`[WSS] Mengirim pesan ke klien...`);
                  client.send(broadcastMessage);
                } else {
                  console.warn(`[WSS] Klien tidak 'OPEN', melewatkan pengiriman.`);
                }
              });
            });
            // --- AKHIR DARI LOGIKA CALLBACK ---

            redisSubscribedTopics.add(channel);
            console.log(`[REDIS] Server ini sekarang subscribe ke topik Redis: ${channel}`);
          } catch (e) {
            console.error(`[REDIS] Gagal subscribe ke topik ${channel}:`, e);
          }
        }

        ws.send(JSON.stringify({ status: 'subscribed', channel }));
        break;

      case 'publish':
        if (!channel || !data) return;

        console.log(`[PUB] Klien mem-publish ke channel: ${channel}`);
        
        try {
          await redisClient.publish(channel, JSON.stringify(data));
          // --- LOG DIAGNOSTIK #3 ---
          console.log(`[REDIS-PUB] Berhasil publish ke Redis channel: ${channel}`);
        } catch (err) {
          // --- LOG DIAGNOSTIK #4 ---
          console.error(`❌ [REDIS-PUB] GAGAL publish ke Redis:`, err);
        }
        break;

      default:
        console.warn(`Menerima aksi tidak dikenal: ${action}`);
        ws.send(JSON.stringify({ error: `Aksi tidak dikenal: ${action}` }));
    }
  });

  // Handler saat Klien Terputus
  ws.on('close', () => {
    console.log('[CLOSE] Klien terputus.');
    
    channels.forEach((clients, channel) => {
      if (clients.has(ws)) {
        clients.delete(ws);
        console.log(`[UNSUB] Klien dihapus dari channel: ${channel}. Sisa klien: ${clients.size}`);

        if (clients.size === 0) {
          channels.delete(channel);
          redisSubscribedTopics.delete(channel);
          // Kita tidak perlu memanggil .unsubscribe() secara eksplisit
          // saat menggunakan mode callback per channel,
          // tapi jika kita tambahkan, kita perlu menangani logic-nya
          // Untuk saat ini, biarkan Redis menangani timeout subscriber
          console.log(`[REDIS] Tidak ada klien lagi di channel: ${channel}`);
        }
      }
    });
  });

  ws.on('error', (err) => {
    console.error('WebSocket error:', err);
  });
});

// Jalankan server
server.listen(PORT, () => {
  console.log(`🚀 Server WebSocket berjalan di ws://localhost:${PORT}`);
});

