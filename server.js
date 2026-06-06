const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const path = require('path');
const cors = require('cors');
const multer = require('multer');
const ImageKit = require('imagekit');
const webpush = require('web-push');
const fs = require('fs');
const os = require('os');
require('dotenv').config();

const app = express();
const server = http.createServer(app);
const PORT = process.env.PORT || 10000;

const imagekit = new ImageKit({
    publicKey: process.env.IMAGEKIT_PUBLIC_KEY,
    privateKey: process.env.IMAGEKIT_PRIVATE_KEY,
    urlEndpoint: process.env.IMAGEKIT_URL_ENDPOINT
});

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

// TEK ODA (şifre: efkaza7634)
let activeRoom = {
    users: new Map(),
    messages: [],
    stickers: [],
    securePhotos: new Map(),
    video: null,
    videoVisible: true,
    lastActivity: Date.now()
};

const pushSubscriptions = new Map();
const lastNotificationTime = new Map();
const MASTER_PASSWORD = 'efkaza7634';

const TEMP_UPLOAD_DIR = path.join(os.tmpdir(), 'balloon-uploads');
if (!fs.existsSync(TEMP_UPLOAD_DIR)) fs.mkdirSync(TEMP_UPLOAD_DIR, { recursive: true });

function canSendNotification(deviceId) {
    const last = lastNotificationTime.get(deviceId);
    if (!last) return true;
    return (Date.now() - last) > 30 * 60 * 1000;
}
function updateLastNotificationTime(deviceId) {
    lastNotificationTime.set(deviceId, Date.now());
}

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

    socket.on('subscribe-push', ({ deviceId, subscription }) => {
        if (subscription?.endpoint) {
            pushSubscriptions.set(deviceId, { subscription, expiresAt: Date.now() + 30*24*60*60*1000 });
        }
    });

    socket.on('create-room', ({ userName, userPhoto, deviceId, password }) => {
        if (!userName) return socket.emit('error', 'Kullanıcı adı gerekli');
        if (password !== MASTER_PASSWORD) return socket.emit('error', 'Şifre yanlış! Oda kurulamadı.');
        
        if (activeRoom.users.size === 0) {
            currentUser = { id: socket.id, deviceId, userName, userPhoto: userPhoto || null, isOwner: true };
            activeRoom.users.set(socket.id, currentUser);
            socket.join('main');
            socket.emit('room-ready', { isOwner: true, messages: [], stickers: activeRoom.stickers, video: null, videoVisible: true });
            updateUserList();
            console.log(`🏠 Oda kuruldu (şifre: ${MASTER_PASSWORD}) - ${userName}`);
        } else {
            joinUser(socket, userName, userPhoto, deviceId);
        }
    });

    socket.on('join-room', ({ userName, userPhoto, deviceId, password }) => {
        if (!userName) return socket.emit('error', 'Kullanıcı adı gerekli');
        if (password !== MASTER_PASSWORD) return socket.emit('error', 'Şifre yanlış!');
        if (activeRoom.users.size === 0) return socket.emit('error', 'Henüz oda kurulmamış. Önce birisi oda kursun.');
        joinUser(socket, userName, userPhoto, deviceId);
    });

    function joinUser(socket, userName, userPhoto, deviceId) {
        currentUser = { id: socket.id, deviceId, userName, userPhoto: userPhoto || null, isOwner: false };
        activeRoom.users.set(socket.id, currentUser);
        socket.join('main');
        socket.emit('room-ready', {
            messages: activeRoom.messages.slice(-100),
            stickers: activeRoom.stickers,
            video: activeRoom.video,
            videoVisible: activeRoom.videoVisible
        });
        socket.to('main').emit('user-joined', { userName, userPhoto: currentUser.userPhoto });
        updateUserList();

        for (const [uid, user] of activeRoom.users.entries()) {
            if (uid !== socket.id && user.deviceId && canSendNotification(user.deviceId)) {
                const sub = pushSubscriptions.get(user.deviceId);
                if (sub) {
                    webpush.sendNotification(sub.subscription, JSON.stringify({
                        title: '🎈 Balon Patlatmaca',
                        body: 'Uzun süredir oyuna girmedin!',
                        icon: '/icon.png',
                        badge: '/badge.png'
                    })).catch(e => console.log('Bildirim hatası:', e.message));
                    updateLastNotificationTime(user.deviceId);
                }
            }
        }
        console.log(`🚪 Katıldı: ${userName}`);
    }

    function updateUserList() {
        const list = Array.from(activeRoom.users.values()).map(u => ({
            id: u.id, userName: u.userName, isOwner: u.isOwner, userPhoto: u.userPhoto
        }));
        io.to('main').emit('user-list', list);
        io.to('main').emit('online-count', list.length);
    }

    socket.on('send-message', (data) => {
        if (!currentUser) return;
        const { text, type, fileUrl, isSecure, replyTo } = data;
        const msg = {
            id: Date.now() + '-' + Math.random().toString(36).substr(2, 6),
            userName: currentUser.userName,
            userPhoto: currentUser.userPhoto,
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

        if (text === '🚨') {
            const fakeScore = Math.floor(Math.random() * 20000) + 5000;
            io.to('main').emit('emergency-bomb', fakeScore);
            activeRoom.messages = [];
            activeRoom.securePhotos.clear();
            activeRoom.video = null;
            console.log('💣 Acil durum bombası!');
        }
    });

    socket.on('reply-message', (data) => {
        if (!currentUser) return;
        const { replyToId, text, type, fileUrl, isSecure } = data;
        const replyMsg = activeRoom.messages.find(m => m.id === replyToId);
        if (!replyMsg) return;
        const msg = {
            id: Date.now() + '-' + Math.random().toString(36).substr(2, 6),
            userName: currentUser.userName,
            userPhoto: currentUser.userPhoto,
            deviceId: currentUser.deviceId,
            text: text || '',
            type: type || 'text',
            fileUrl: fileUrl || null,
            isSecure: isSecure || false,
            secureId: null,
            replyTo: { id: replyToId, userName: replyMsg.userName, text: replyMsg.text?.substring(0, 30) },
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

    socket.on('add-reaction', ({ messageId, emoji }) => {
        if (!currentUser) return;
        const msg = activeRoom.messages.find(m => m.id === messageId);
        if (msg) {
            const existing = msg.reactions.find(r => r.userId === currentUser.deviceId && r.emoji === emoji);
            if (!existing) {
                msg.reactions.push({ userId: currentUser.deviceId, emoji, userName: currentUser.userName });
                io.to('main').emit('reaction-updated', { messageId, reactions: msg.reactions });
            }
        }
    });

    socket.on('delete-message', ({ messageId }) => {
        if (!currentUser) return;
        const idx = activeRoom.messages.findIndex(m => m.id === messageId && m.deviceId === currentUser.deviceId);
        if (idx !== -1) {
            activeRoom.messages.splice(idx, 1);
            io.to('main').emit('message-deleted', messageId);
        }
    });

    socket.on('view-secure-photo', ({ secureId }) => {
        const photo = activeRoom.securePhotos.get(secureId);
        if (photo) socket.emit('secure-photo-data', { imageUrl: photo.imageUrl });
    });

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

    socket.on('delete-video', () => {
        if (currentUser?.isOwner) {
            activeRoom.video = null;
            io.to('main').emit('video-deleted');
        }
    });

    socket.on('toggle-video-visibility', () => {
        if (currentUser?.isOwner) {
            activeRoom.videoVisible = !activeRoom.videoVisible;
            io.to('main').emit('video-visibility', activeRoom.videoVisible);
        }
    });

    socket.on('save-stickers', ({ stickers }) => {
        if (currentUser) {
            activeRoom.stickers = stickers;
            io.to('main').emit('stickers-updated', stickers);
        }
    });

    socket.on('send-sticker', ({ stickerUrl }) => {
        if (currentUser) {
            const msg = {
                id: Date.now() + '-' + Math.random().toString(36).substr(2, 6),
                userName: currentUser.userName,
                userPhoto: currentUser.userPhoto,
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

    socket.on('disconnect', () => {
        if (currentUser) {
            activeRoom.users.delete(socket.id);
            io.to('main').emit('user-left', { userName: currentUser.userName });
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
