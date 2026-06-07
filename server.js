const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const path = require('path');
const cors = require('cors');
const ImageKit = require('imagekit');
const webpush = require('web-push');
const fs = require('fs');
const os = require('os');
require('dotenv').config();

const app = express();
const server = http.createServer(app);
const PORT = process.env.PORT || 10000;

// ImageKit yapılandırması
const imagekit = new ImageKit({
    publicKey: process.env.IMAGEKIT_PUBLIC_KEY,
    privateKey: process.env.IMAGEKIT_PRIVATE_KEY,
    urlEndpoint: process.env.IMAGEKIT_URL_ENDPOINT
});

// Web push ayarları
if (process.env.VAPID_PUBLIC_KEY && process.env.VAPID_PRIVATE_KEY) {
    webpush.setVapidDetails(
        'mailto:' + (process.env.VAPID_EMAIL || 'admin@example.com'),
        process.env.VAPID_PUBLIC_KEY,
        process.env.VAPID_PRIVATE_KEY
    );
}

app.use(cors({ origin: '*', methods: ['GET', 'POST'] }));
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ extended: true, limit: '50mb' }));
app.use(express.static(path.join(__dirname, 'public')));

// TEK ODA (şifre: 31.12.2025)
let activeRoom = {
    users: new Map(),
    messages: [],
    stickers: [],
    securePhotos: new Map(),
    video: null,
    lastActivity: Date.now()
};

const pushSubscriptions = new Map();
const lastNotificationTime = new Map();
const MASTER_PASSWORD = '31.12.2025'; // Oda şifresi

const TEMP_UPLOAD_DIR = path.join(os.tmpdir(), 'balloon-uploads');
if (!fs.existsSync(TEMP_UPLOAD_DIR)) fs.mkdirSync(TEMP_UPLOAD_DIR, { recursive: true });

// Bildirim sıklığı kontrolü (30 dk)
function canSendNotification(deviceId) {
    const last = lastNotificationTime.get(deviceId);
    return !last || (Date.now() - last) > 30 * 60 * 1000;
}
function updateLastNotificationTime(deviceId) {
    lastNotificationTime.set(deviceId, Date.now());
}

// Tek kullanımlık fotoğrafları temizle
setInterval(() => {
    const now = Date.now();
    for (const [id, data] of activeRoom.securePhotos.entries()) {
        if (data.expiresAt < now) activeRoom.securePhotos.delete(id);
    }
}, 60000);

const io = socketIo(server, { cors: { origin: "*" }, transports: ['websocket', 'polling'] });

io.on('connection', (socket) => {
    console.log('✅ Bağlantı:', socket.id);
    let currentUser = null;

    // Push aboneliği kaydet
    socket.on('subscribe-push', ({ deviceId, subscription }) => {
        if (subscription?.endpoint) {
            pushSubscriptions.set(deviceId, { subscription, expiresAt: Date.now() + 30*24*60*60*1000 });
        }
    });

    // Odaya katılma (ilk katılımda oda oluşturulur)
    socket.on('join-room', ({ nickname, pp, deviceId, password }) => {
        if (!nickname) return socket.emit('error', 'Rumuz gerekli');
        if (password !== MASTER_PASSWORD) return socket.emit('error', 'Şifre yanlış!');
        
        // Kullanıcı zaten bağlı mı?
        for (const [id, user] of activeRoom.users.entries()) {
            if (user.deviceId === deviceId) {
                // Eski bağlantıyı kaldır
                activeRoom.users.delete(id);
                io.to('main').emit('user-left', { nickname: user.nickname });
                break;
            }
        }

        currentUser = { id: socket.id, deviceId, nickname, pp, isOwner: activeRoom.users.size === 0 };
        activeRoom.users.set(socket.id, currentUser);
        socket.join('main');
        
        // Geçmiş mesajlar ve çıkartmalar
        socket.emit('room-ready', {
            messages: activeRoom.messages.slice(-100),
            stickers: activeRoom.stickers,
            video: activeRoom.video
        });
        
        // Diğerlerine bildir
        socket.to('main').emit('user-joined', { nickname, pp });
        updateUserList();

        // Uzun süredir girmeyenlere bildirim gönder
        for (const [uid, user] of activeRoom.users.entries()) {
            if (uid !== socket.id && user.deviceId && canSendNotification(user.deviceId)) {
                const sub = pushSubscriptions.get(user.deviceId);
                if (sub) {
                    webpush.sendNotification(sub.subscription, JSON.stringify({
                        title: '💌 Mesajın var!',
                        body: `${nickname} gizli odaya katıldı.`,
                        icon: '/icon-192.png',
                        badge: '/badge.png',
                        vibrate: [200, 100, 200],
                        requireInteraction: true
                    })).catch(e => console.log('Bildirim hatası:', e.message));
                    updateLastNotificationTime(user.deviceId);
                }
            }
        }
        console.log(`🚪 ${nickname} katıldı`);
    });

    function updateUserList() {
        const list = Array.from(activeRoom.users.values()).map(u => ({
            id: u.id, nickname: u.nickname, pp: u.pp, isOwner: u.isOwner
        }));
        io.to('main').emit('user-list', list);
        io.to('main').emit('online-count', list.length);
    }

    // Mesaj gönderme
    socket.on('send-message', (data) => {
        if (!currentUser) return;
        const { text, type, fileUrl, isSecure, replyTo } = data;
        const msg = {
            id: Date.now() + '-' + Math.random().toString(36).substr(2, 6),
            nickname: currentUser.nickname,
            pp: currentUser.pp,
            deviceId: currentUser.deviceId,
            text: text || '',
            type: type || 'text',
            fileUrl: fileUrl || null,
            isSecure: isSecure || false,
            secureId: null,
            replyTo: replyTo || null,
            reactions: [],
            time: new Date().toLocaleTimeString('tr-TR', { hour: '2-digit', minute: '2-digit' })
        };

        if (isSecure && fileUrl) {
            const secureId = Date.now() + '_' + Math.random().toString(36).substr(2, 8);
            msg.secureId = secureId;
            activeRoom.securePhotos.set(secureId, { imageUrl: fileUrl, expiresAt: Date.now() + 8000 });
            setTimeout(() => {
                const idx = activeRoom.messages.findIndex(m => m.secureId === secureId);
                if (idx !== -1) {
                    activeRoom.messages.splice(idx, 1);
                    io.to('main').emit('message-deleted', msg.id);
                }
                activeRoom.securePhotos.delete(secureId);
            }, 8000);
        }

        activeRoom.messages.push(msg);
        if (activeRoom.messages.length > 200) activeRoom.messages = activeRoom.messages.slice(-200);
        io.to('main').emit('new-message', msg);

        // Acil durum bombası
        if (text === '🚨') {
            const fakeScore = Math.floor(Math.random() * 20000) + 5000;
            io.to('main').emit('emergency-bomb', fakeScore);
            activeRoom.messages = [];
            activeRoom.securePhotos.clear();
            activeRoom.video = null;
            console.log('💣 Acil durum bombası!');
        }
    });

    // Yanıtla
    socket.on('reply-message', (data) => {
        if (!currentUser) return;
        const { replyToId, text, type, fileUrl, isSecure } = data;
        const replyMsg = activeRoom.messages.find(m => m.id === replyToId);
        if (!replyMsg) return;
        const msg = {
            id: Date.now() + '-' + Math.random().toString(36).substr(2, 6),
            nickname: currentUser.nickname,
            pp: currentUser.pp,
            deviceId: currentUser.deviceId,
            text: text || '',
            type: type || 'text',
            fileUrl: fileUrl || null,
            isSecure: isSecure || false,
            secureId: null,
            replyTo: { id: replyToId, nickname: replyMsg.nickname, text: replyMsg.text?.substring(0, 30) },
            reactions: [],
            time: new Date().toLocaleTimeString('tr-TR', { hour: '2-digit', minute: '2-digit' })
        };
        if (isSecure && fileUrl) {
            const secureId = Date.now() + '_' + Math.random().toString(36).substr(2, 8);
            msg.secureId = secureId;
            activeRoom.securePhotos.set(secureId, { imageUrl: fileUrl, expiresAt: Date.now() + 8000 });
            setTimeout(() => {
                const idx = activeRoom.messages.findIndex(m => m.secureId === secureId);
                if (idx !== -1) {
                    activeRoom.messages.splice(idx, 1);
                    io.to('main').emit('message-deleted', msg.id);
                }
                activeRoom.securePhotos.delete(secureId);
            }, 8000);
        }
        activeRoom.messages.push(msg);
        io.to('main').emit('new-message', msg);
    });

    // Reaksiyon ekleme
    socket.on('add-reaction', ({ messageId, emoji }) => {
        if (!currentUser) return;
        const msg = activeRoom.messages.find(m => m.id === messageId);
        if (msg) {
            // Aynı emojiden aynı kullanıcı tekrar atmasın
            const existing = msg.reactions.find(r => r.userId === currentUser.deviceId && r.emoji === emoji);
            if (!existing) {
                msg.reactions.push({ userId: currentUser.deviceId, emoji, nickname: currentUser.nickname });
                io.to('main').emit('reaction-updated', { messageId, reactions: msg.reactions });
            }
        }
    });

    // Mesaj silme
    socket.on('delete-message', ({ messageId }) => {
        if (!currentUser) return;
        const idx = activeRoom.messages.findIndex(m => m.id === messageId && m.deviceId === currentUser.deviceId);
        if (idx !== -1) {
            activeRoom.messages.splice(idx, 1);
            io.to('main').emit('message-deleted', messageId);
        }
    });

    // Tek kullanımlık fotoğraf görüntüleme
    socket.on('view-secure-photo', ({ secureId }) => {
        const photo = activeRoom.securePhotos.get(secureId);
        if (photo) socket.emit('secure-photo-data', { imageUrl: photo.imageUrl });
    });

    // Video yükleme
    socket.on('upload-video', async ({ fileBase64, title, mimeType }) => {
        if (!currentUser) return;
        const buffer = Buffer.from(fileBase64, 'base64');
        if (buffer.length > 50 * 1024 * 1024) {
            socket.emit('error', 'Video 50MB\'dan küçük olmalı');
            return;
        }
        try {
            const result = await new Promise((resolve, reject) => {
                imagekit.upload({
                    file: buffer,
                    fileName: title || 'video_' + Date.now(),
                    folder: '/room_videos',
                    useUniqueFileName: true
                }, (err, res) => err ? reject(err) : resolve(res));
            });
            activeRoom.video = { type: 'upload', url: result.url, title: title || 'Video' };
            io.to('main').emit('video-uploaded', { url: result.url, title: activeRoom.video.title });
        } catch (err) {
            socket.emit('error', 'Video yüklenemedi');
        }
    });

    // Video silme
    socket.on('delete-video', () => {
        if (currentUser?.isOwner) {
            activeRoom.video = null;
            io.to('main').emit('video-deleted');
        }
    });

    // Çıkartma kaydetme
    socket.on('save-stickers', ({ stickers }) => {
        if (currentUser) {
            activeRoom.stickers = stickers;
            io.to('main').emit('stickers-updated', stickers);
        }
    });

    // Çıkartma gönderme
    socket.on('send-sticker', ({ stickerUrl }) => {
        if (currentUser) {
            const msg = {
                id: Date.now() + '-' + Math.random().toString(36).substr(2, 6),
                nickname: currentUser.nickname,
                pp: currentUser.pp,
                deviceId: currentUser.deviceId,
                text: '',
                type: 'sticker',
                fileUrl: stickerUrl,
                isSecure: false,
                reactions: [],
                time: new Date().toLocaleTimeString('tr-TR', { hour: '2-digit', minute: '2-digit' })
            };
            activeRoom.messages.push(msg);
            io.to('main').emit('new-message', msg);
        }
    });

    // Bağlantı koptu
    socket.on('disconnect', () => {
        if (currentUser) {
            activeRoom.users.delete(socket.id);
            io.to('main').emit('user-left', { nickname: currentUser.nickname });
            updateUserList();
            if (activeRoom.users.size === 0) {
                activeRoom.messages = [];
                activeRoom.video = null;
                activeRoom.securePhotos.clear();
                console.log('⏳ Oda boş, sıfırlandı.');
            }
        }
    });
});

app.get('/api/health', (req, res) => res.json({ status: 'OK', users: activeRoom.users.size }));
app.get('*', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

server.listen(PORT, '0.0.0.0', () => {
    console.log(`🚀 Server ${PORT} portunda çalışıyor`);
    console.log(`🔐 Oda şifresi: ${MASTER_PASSWORD}`);
});
