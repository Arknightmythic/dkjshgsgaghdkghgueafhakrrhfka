# --- Tahap 1: Builder ---
# Gunakan image Node.js versi LTS (Long Term Support) untuk membangun
FROM node:20-alpine AS builder

# Tentukan direktori kerja di dalam container
WORKDIR /app

# Salin package.json dan package-lock.json terlebih dahulu
# Ini memanfaatkan cache Docker
COPY package.json package-lock.json* ./

# Instal dependensi (npm ci lebih cepat dan aman untuk produksi)
RUN npm ci --omit=dev

# Salin sisa kode aplikasi
COPY . .

# --- Tahap 2: Produksi ---
# Gunakan image Alpine yang ramping untuk image final
FROM node:20-alpine AS production

WORKDIR /app

# Salin file yang diperlukan dari tahap 'builder'
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/package.json ./package.json
COPY --from=builder /app/server.js ./server.js

# Ekspos port yang akan digunakan (Anda menggunakan 8080)
EXPOSE 8080

# Perintah untuk menjalankan aplikasi
# Ini akan menjalankan "start": "node server.js" dari package.json Anda
CMD [ "npm", "start" ]