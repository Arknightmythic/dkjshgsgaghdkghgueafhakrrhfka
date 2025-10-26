
const WebSocket = require('ws');
const http = require('http');
const { createClient } = require('redis');
const url = require('url');
require('dotenv').config();


const PORT = process.env.PORT || 8080; 
const WEBSOCKET_SECRET_KEY = process.env.WEBSOCKET_SECRET_KEY;
const REDIS_URL = process.env.REDIS_URL;

if (!WEBSOCKET_SECRET_KEY) {
  console.error("ERROR: WEBSOCKET_SECRET_KEY tidak diatur di file .env");
  process.exit(1);
}
if (!REDIS_URL) {
  console.error("ERROR: REDIS_URL tidak diatur di file .env");
  process.exit(1);
}


const server = http.createServer();

const wss = new WebSocket.Server({ server });



const channels = new Map(); 

const activeStreamReaders = new Set(); 


const metrics = {
  messagesIn: 0,
  messagesOut: 0,
  publishLatencyTotal: 0,
  publishCount: 0,
};


let isRedisReady = false;


const redisClient = createClient({ url: REDIS_URL });
const subscriber = redisClient.duplicate();


const setupRedisListeners = (client, clientName) => {
  client.on('error', (err) => {
    console.error(`[REDIS-${clientName}] Error:`, err);
    if (clientName === 'PUB') isRedisReady = false;
  });
  client.on('connect', () => console.log(`✅ [REDIS-${clientName}] Sedang terhubung...`));
  client.on('ready', () => {
    console.log(`✅ [REDIS-${clientName}] Terhubung dan siap.`);
    if (clientName === 'PUB') isRedisReady = true;
  });
  client.on('end', () => {
    console.warn(`[REDIS-${clientName}] Koneksi terputus.`);
    if (clientName === 'PUB') isRedisReady = false;
  });
  client.on('reconnecting', () => console.log(`[REDIS-${clientName}] Mencoba terhubung kembali...`));
};

setupRedisListeners(redisClient, 'PUB');
setupRedisListeners(subscriber, 'SUB');


(async () => {
  try {
    await redisClient.connect();
    await subscriber.connect();

    
    setInterval(() => {
      const avgLatency = (metrics.publishCount > 0) ? (metrics.publishLatencyTotal / metrics.publishCount).toFixed(2) : 0;
      console.log(`\n--- METRICS (10s) ---`);
      console.log(`Messages In (from Clients): ${metrics.messagesIn}`);
      console.log(`Messages Out (to Clients):  ${metrics.messagesOut}`);
      console.log(`Avg. Redis Publish Latency: ${avgLatency} ms`);
      console.log(`-----------------------\n`);

      
      metrics.messagesIn = 0;
      metrics.messagesOut = 0;
      metrics.publishLatencyTotal = 0;
      metrics.publishCount = 0;
    }, 10000);

  } catch (err) {
    console.error('❌ Gagal terhubung ke Redis saat startup:', err);
    process.exit(1);
  }
})();


/**
 * ==========================================================
 * FUNGSI BARU: Mengirim riwayat (catch-up) ke SATU klien
 * ==========================================================
 * Ini adalah fungsi sekali jalan, non-blocking.
 */
async function sendHistoricalMessages(ws, channel, startId) {
  console.log(`[CATCH-UP] Mengambil riwayat untuk ${channel} dari ID: ${startId}...`);
  let currentId = startId;

  try {
    while (true) {
      
      const response = await redisClient.xRead(
        { key: channel, id: currentId },
        { COUNT: 100 } 
      );

      
      if (!response || response.length === 0) {
        break; 
      }

      const messages = response[0].messages;
      if (messages.length === 0) {
        break;
      }

      for (const msg of messages) {
        currentId = msg.id; 
        let data;
        try {
          data = JSON.parse(msg.message.messageData); 
        } catch (e) {
          console.error('[CATCH-UP] Gagal parse JSON dari stream:', msg.message.messageData);
          continue;
        }
        
        const broadcastMessage = JSON.stringify({
          event: 'message',
          channel: channel,
          streamId: msg.id,
          data: data,
        });

        
        if (ws.readyState === WebSocket.OPEN) {
          ws.send(broadcastMessage);
          metrics.messagesOut++;
        }
      }
    }
  } catch (err) {
    console.error(`[CATCH-UP] Error mengambil riwayat ${channel}:`, err);
  }
  console.log(`[CATCH-UP] Selesai mengambil riwayat untuk ${channel}.`);
}


/**
 * ==========================================================
 * FUNGSI LAMA (Diperbaiki): Memastikan reader REAL-TIME berjalan
 * ==========================================================
 * Fungsi ini HANYA mendengarkan pesan BARU ('$')
 */
async function ensureRealtimeReader(channel) {
  
  if (activeStreamReaders.has(channel)) return;

  activeStreamReaders.add(channel);
  console.log(`[STREAM] Memulai reader REAL-TIME untuk channel: ${channel}`);

  
  let currentId = '$';

  while (channels.has(channel) && channels.get(channel).size > 0) {
    try {
      if (!isRedisReady) {
        console.warn(`[STREAM] Redis tidak siap, reader ${channel} dijeda...`);
        await new Promise(resolve => setTimeout(resolve, 2000));
        continue;
      }

      
      const response = await subscriber.xRead(
        { key: channel, id: currentId },
        { BLOCK: 5000, COUNT: 100 }
      );

      if (response) {
        const messages = response[0].messages;
        
        const clients = channels.get(channel); 
        if (!clients) break; 

        for (const msg of messages) {
          currentId = msg.id; 
          let data;
          try {
            data = JSON.parse(msg.message.messageData); 
          } catch (e) {
            console.error('[STREAM] Gagal parse JSON dari stream:', msg.message.messageData);
            continue;
          }
          
          const broadcastMessage = JSON.stringify({
            event: 'message',
            channel: channel,
            streamId: msg.id,
            data: data,
          });

          
          clients.forEach(client => {
            if (client.readyState === WebSocket.OPEN) {
              client.send(broadcastMessage);
              metrics.messagesOut++;
            }
          });
        }
      }
    } catch (err) {
      console.error(`[STREAM] Error di XREAD untuk ${channel}:`, err);
      await new Promise(resolve => setTimeout(resolve, 2000));
    }
  }

  activeStreamReaders.delete(channel);
  console.log(`[STREAM] Menghentikan reader REAL-TIME untuk channel: ${channel}`);
}



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

  
  ws.on('message', async (message) => {
    let parsed;
    try {
      parsed = JSON.parse(message);
    } catch (e) {
      console.warn('Menerima format pesan non-JSON:', message);
      return;
    }

    const { action, channel, data, messageId } = parsed;
    
    metrics.messagesIn++;

    switch (action) {
      
      case 'subscribe': {
        if (!channel) return;

        if (!channels.has(channel)) {
          channels.set(channel, new Set());
        }
        
        channels.get(channel).add(ws);
        console.log(`[SUB] Klien subscribe ke channel: ${channel}. Total: ${channels.get(channel).size}`);

        
        
        const startId = (parsed.lastMessageId && parsed.lastMessageId !== '$') 
                          ? parsed.lastMessageId 
                          : '0';

        
        ensureRealtimeReader(channel); 

        
        
        sendHistoricalMessages(ws, channel, startId);

        
        ws.send(JSON.stringify({ status: 'subscribed', channel }));
        break;
      }
      
      case 'publish':
        if (!channel || !data || !messageId) {
          ws.send(JSON.stringify({ error: 'Format publish salah. Wajib ada: channel, data, messageId' }));
          return;
        }

        if (!isRedisReady) {
          ws.send(JSON.stringify({ status: 'error_ack', messageId: messageId, error: 'Server Redis tidak siap' }));
          return;
        }

        console.log(`[PUB] Klien mem-publish ke channel: ${channel}`);
        
        try {
          const startTime = Date.now();
          
          await redisClient.xAdd(channel, '*', { 
            messageData: JSON.stringify(data) 
          }); 
          
          const latency = Date.now() - startTime;
          metrics.publishLatencyTotal += latency;
          metrics.publishCount++;

          ws.send(JSON.stringify({ status: 'ack', messageId: messageId }));
          
          console.log(`[REDIS-STREAM] Berhasil XADD ke ${channel} (Latency: ${latency}ms)`);
          
        } catch (err) {
          console.error(`❌ [REDIS-STREAM] GAGAL XADD ke Redis:`, err);
          ws.send(JSON.stringify({ status: 'error_ack', messageId: messageId, error: err.message }));
        }
        break;

      default:
        console.warn(`Menerima aksi tidak dikenal: ${action}`);
        ws.send(JSON.stringify({ error: `Aksi tidak dikenal: ${action}` }));
    }
  });

  
  ws.on('close', () => {
    console.log('[CLOSE] Klien terputus.');
    
    channels.forEach((clients, channel) => {
      if (clients.has(ws)) {
        clients.delete(ws);
        console.log(`[UNSUB] Klien dihapus dari channel: ${channel}. Sisa: ${clients.size}`);

        if (clients.size === 0) {
          channels.delete(channel);
          console.log(`[STREAM] Klien terakhir untuk ${channel} terputus. Reader akan berhenti.`);
        }
      }
    });
  });

  ws.on('error', (err) => {
    console.error('[WSS] WebSocket error:', err);
  });
});


server.listen(PORT, () => {
  console.log(`🚀 Server WebSocket berjalan di ws://localhost:${PORT}`);
});