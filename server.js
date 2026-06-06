const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const path = require('path');
const cors = require('cors');
const multer = require('multer');
const ImageKit = require('imagekit');
const CronJob = require('cron').CronJob;
const webpush = require('web-push');
const fs = require('fs');
const os = require('os');
require('dotenv').config();

const app = express();
const server = http.createServer(app);
const PORT = process.env.PORT || 10000;

const vapidKeys = {
    publicKey: process.env.VAPID_PUBLIC_KEY,
    privateKey: process.env.VAPID_PRIVATE_KEY
};

webpush.setVapidDetails(
    'mailto:' + process.env.VAPID_EMAIL,
    vapidKeys.publicKey,
    vapidKeys.privateKey
);

const imagekit = new ImageKit({
    publicKey: process.env.IMAGEKIT_PUBLIC_KEY,
    privateKey: process.env.IMAGEKIT_PRIVATE_KEY,
    urlEndpoint: process.env.IMAGEKIT_URL_ENDPOINT
});

const rooms = new Map();
const users = new Map();
const messages = new Map();
const userStickers = new Map();
const securePhotos = new Map();
const videoLibrary = new Map();
const roomVideos = new Map();
const deviceRelations = new Map();
const pushSubscriptions = new Map();
const userProfiles = new Map();
const userSessions = new Map();
const uploadSessions = new Map();

const ADMIN_MAC_ADDRESS = process.env.ADMIN_MAC_ADDRESS;
let currentMacAddress = null;

const TEMP_UPLOAD_DIR = path.join(os.tmpdir(), 'birlikte-izle-uploads');
if (!fs.existsSync(TEMP_UPLOAD_DIR)) {
    fs.mkdirSync(TEMP_UPLOAD_DIR, { recursive: true });
    console.log(`📁 Geçici klasör oluşturuldu: ${TEMP_UPLOAD_DIR}`);
}

setInterval(() => {
    const https = require('https');
    const http = require('http');
    const url = process.env.RENDER_EXTERNAL_URL || `http://localhost:${PORT}`;
    const protocol = url.startsWith('https') ? https : http;
    protocol.get(`${url}/api/health`, (res) => {
        console.log('💓 Self-ping:', new Date().toLocaleTimeString());
    }).on('error', (err) => {});
}, 60 * 1000);

const cleanupJob = new CronJob('0 * * * *', () => {
    console.log('🧹 Temizlik başladı...');
    const now = Date.now();
    videoLibrary.forEach((video, id) => {
        if (video.expiresAt < now) {
            imagekit.deleteFile(video.fileId, () => {});
            videoLibrary.delete(id);
        }
    });
    roomVideos.forEach((video, id) => {
        if (video.expiresAt < now) {
            imagekit.deleteFile(video.fileId, () => {});
            roomVideos.delete(id);
        }
    });
    pushSubscriptions.forEach((sub, deviceId) => {
        if (sub.expiresAt < now) {
            pushSubscriptions.delete(deviceId);
        }
    });
    rooms.forEach((room, code) => {
        if (room.users.size === 0 && (now - room.lastActivity) > 60 * 60 * 1000) {
            rooms.delete(code);
            messages.delete(code);
            userStickers.delete(code);
            securePhotos.delete(code);
        }
    });
});
cleanupJob.start();

setInterval(() => {
    const now = Date.now();
    const files = fs.readdirSync(TEMP_UPLOAD_DIR);
    files.forEach(file => {
        const filePath = path.join(TEMP_UPLOAD_DIR, file);
        try {
            const stats = fs.statSync(filePath);
            if (now - stats.mtimeMs > 60 * 60 * 1000) {
                fs.unlinkSync(filePath);
                console.log(`🗑️ Eski geçici dosya silindi: ${file}`);
            }
        } catch (e) {}
    });
    uploadSessions.forEach((session, uploadId) => {
        if (now - session.createdAt > 60 * 60 * 1000) {
            if (session.tempFilePath && fs.existsSync(session.tempFilePath)) {
                try { fs.unlinkSync(session.tempFilePath); } catch (e) {}
            }
            uploadSessions.delete(uploadId);
        }
    });
}, 30 * 60 * 1000);

app.use(cors({
    origin: '*',
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization'],
    credentials: true
}));
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));
app.use(express.static(path.join(__dirname, 'public')));

const upload = multer({ 
    storage: multer.memoryStorage(),
    limits: { fileSize: 5 * 1024 * 1024 * 1024 },
    fileFilter: (req, file, cb) => {
        if (file.mimetype.startsWith('video/') || file.mimetype.startsWith('image/')) {
            cb(null, true);
        } else {
            cb(new Error('Sadece video ve resim dosyaları yüklenebilir!'));
        }
    }
});

function generateRoomCode() {
    const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
    let result = '';
    for (let i = 0; i < 6; i++) {
        result += chars.charAt(Math.floor(Math.random() * chars.length));
    }
    return result;
}

function generateUserColor(username) {
    const colors = ['#405DE6', '#5851DB', '#833AB4', '#C13584', '#E1306C', '#FD1D1D', '#F56040', '#F77737', '#FCAF45', '#FFDC80'];
    const index = username ? username.split('').reduce((acc, c) => acc + c.charCodeAt(0), 0) : 0;
    return colors[index % colors.length];
}

function generateDefaultAvatar(username) {
    const name = encodeURIComponent(username || 'Kullanici');
    return `https://ui-avatars.com/api/?name=${name}&background=0095F6&color=fff&length=1&bold=true&size=128`;
}

function extractYouTubeId(url) {
    const regex = /(?:youtube\.com\/(?:[^\/]+\/.+\/|(?:v|e(?:mbed)?)\/|.*[?&]v=)|youtu\.be\/)([^"&?\/\s]{11})/;
    const match = url.match(regex);
    return match ? match[1] : null;
}

function getLibraryList() {
    const list = [];
    videoLibrary.forEach((video, id) => {
        list.push({
            id: id,
            title: video.title,
            url: video.url,
            thumbnail: video.thumbnail,
            uploadedBy: video.uploadedBy,
            uploadedAt: video.uploadedAt,
            timeRemaining: Math.max(0, Math.floor((video.expiresAt - Date.now()) / 1000))
        });
    });
    return list.sort((a, b) => b.uploadedAt - a.uploadedAt);
}

const io = socketIo(server, {
    cors: { origin: "*", methods: ["GET", "POST"] },
    transports: ['websocket', 'polling'],
    maxHttpBufferSize: 10 * 1024 * 1024,
    pingTimeout: 120000,
    pingInterval: 25000
});

function updateUserList(roomCode) {
    const room = rooms.get(roomCode);
    if (!room) return;
    const userList = Array.from(room.users.values()).map(user => ({
        id: user.id,
        deviceId: user.deviceId,
        userName: user.userName,
        userPhoto: user.userPhoto,
        userColor: user.userColor,
        isOwner: user.isOwner,
        isAdmin: user.isAdmin || false
    }));
    io.to(roomCode).emit('user-list-update', userList);
}

function recordInteraction(deviceId1, deviceId2) {
    if (!deviceId1 || !deviceId2 || deviceId1 === deviceId2) return;
    const profile1 = userProfiles.get(deviceId1);
    const profile2 = userProfiles.get(deviceId2);
    if (profile1) profile1.interactions.add(deviceId2);
    if (profile2) profile2.interactions.add(deviceId1);
    const key = [deviceId1, deviceId2].sort().join(':');
    deviceRelations.set(key, {
        deviceIds: [deviceId1, deviceId2],
        lastInteraction: Date.now(),
        count: (deviceRelations.get(key)?.count || 0) + 1
    });
}

io.on('connection', (socket) => {
    console.log('✅ Yeni bağlantı:', socket.id);
    
    let currentUser = null;
    let currentRoomCode = null;
    let currentDeviceId = null;
    currentMacAddress = null;

    const pingInterval = setInterval(() => {
        if (socket.connected) {
            socket.emit('ping', { timestamp: Date.now() });
        }
    }, 25000);

    socket.on('pong', (data) => {});

    socket.on('register-device', (data) => {
        const { deviceId, userName, userPhoto, macAddress } = data;
        currentDeviceId = deviceId;
        currentMacAddress = macAddress;
        const isAdmin = (macAddress === ADMIN_MAC_ADDRESS);
        if (isAdmin) console.log('👑 Admin girişi yapıldı!');
        if (!userProfiles.has(deviceId)) {
            userProfiles.set(deviceId, {
                deviceId,
                userName,
                userPhoto: userPhoto || generateDefaultAvatar(userName),
                macAddress: macAddress,
                firstSeen: Date.now(),
                lastSeen: Date.now(),
                interactions: new Set()
            });
        } else {
            const profile = userProfiles.get(deviceId);
            profile.lastSeen = Date.now();
            profile.userName = userName;
            if (userPhoto) profile.userPhoto = userPhoto;
            if (macAddress) profile.macAddress = macAddress;
        }
        socket.emit('device-registered', { success: true });
    });

    socket.on('subscribe-push', (data) => {
        const { deviceId, subscription } = data;
        if (!subscription || !subscription.endpoint) {
            console.log('❌ Geçersiz push aboneliği');
            return;
        }
        pushSubscriptions.set(deviceId, {
            subscription,
            expiresAt: Date.now() + (30 * 24 * 60 * 60 * 1000),
            createdAt: Date.now()
        });
        console.log(`✅ Push aboneliği kaydedildi: ${deviceId}`);
        setTimeout(() => {
            try {
                webpush.sendNotification(subscription, JSON.stringify({
                    title: '🔔 Bildirimler Aktif',
                    body: 'Artık davet bildirimleri alacaksın!',
                    icon: 'https://ik.imagekit.io/5v8xlfyfa/icon.png'
                })).catch(e => console.log('Test bildirimi hatası:', e.message));
            } catch (e) {}
        }, 1000);
    });

    socket.on('send-invite', async (data) => {
        const { fromDeviceId, toDeviceId, roomCode, roomName, fromUserName } = data;
        const subscription = pushSubscriptions.get(toDeviceId);
        if (!subscription) {
            console.log(`❌ Bildirim gönderilemedi: ${toDeviceId} aboneliği yok`);
            socket.emit('invite-error', { message: 'Kullanıcı çevrimdışı veya bildirimlere kapalı' });
            return;
        }
        try {
            const payload = JSON.stringify({
                title: '📱 Birlikte İzle Daveti',
                body: `${fromUserName} seni "${roomName}" odasına davet ediyor!`,
                icon: 'https://ik.imagekit.io/5v8xlfyfa/icon.png',
                badge: 'https://ik.imagekit.io/5v8xlfyfa/badge.png',
                vibrate: [200, 100, 200],
                data: {
                    url: `/?room=${roomCode}`,
                    roomCode: roomCode
                },
                actions: [
                    { action: 'open', title: '🚪 Odaya Git' },
                    { action: 'close', title: '❌ Kapat' }
                ]
            });
            await webpush.sendNotification(subscription.subscription, payload);
            console.log(`✅ Bildirim gönderildi: ${toDeviceId}`);
            socket.emit('invite-sent', { success: true });
        } catch (error) {
            console.error('❌ Bildirim gönderilemedi:', error.statusCode, error.body);
            if (error.statusCode === 410 || error.statusCode === 404) {
                console.log(`🗑️ Geçersiz abonelik silindi: ${toDeviceId}`);
                pushSubscriptions.delete(toDeviceId);
            }
            socket.emit('invite-error', { 
                message: error.statusCode === 410 || error.statusCode === 404 
                    ? 'Kullanıcı bildirimleri kapatmış' 
                    : 'Bildirim gönderilemedi'
            });
        }
    });

    socket.on('get-interactions', (data) => {
        const { deviceId } = data;
        const profile = userProfiles.get(deviceId);
        if (!profile) {
            socket.emit('interactions-list', []);
            return;
        }
        const interactions = [];
        profile.interactions.forEach(otherDeviceId => {
            const otherProfile = userProfiles.get(otherDeviceId);
            if (otherProfile) {
                interactions.push({
                    deviceId: otherDeviceId,
                    userName: otherProfile.userName,
                    userPhoto: otherProfile.userPhoto,
                    lastSeen: otherProfile.lastSeen,
                    isOnline: Array.from(users.values()).some(u => u.deviceId === otherDeviceId)
                });
            }
        });
        interactions.sort((a, b) => b.lastSeen - a.lastSeen);
        socket.emit('interactions-list', interactions);
    });

    // ============ DEĞİŞİKLİK 1: ODA OLUŞTURMA (BASİTLEŞTİRİLDİ) ============
    socket.on('create-room', (data) => {
        const { userName, userPhoto, deviceId, macAddress } = data;
        
        // Oda adı otomatik, şifre sabit
        const roomName = 'Oda';
        const password = 'efkaza7634';
        
        if (!userName) {
            socket.emit('error', { message: 'Kullanıcı adı gerekli' });
            return;
        }
        
        const isAdmin = (macAddress === ADMIN_MAC_ADDRESS);
        if (isAdmin) console.log('👑 Admin girişi yapıldı!');
        
        // Sabit oda kodu: EFKAZA
        let roomCode = 'EFKAZA';
        
        // Eğer EFKAZA zaten varsa ve doluysa yeni oda oluştur
        if (rooms.has(roomCode) && rooms.get(roomCode).users.size > 0) {
            roomCode = generateRoomCode();
            while (rooms.has(roomCode)) roomCode = generateRoomCode();
        }
        
        currentUser = {
            id: socket.id,
            deviceId: deviceId,
            macAddress: macAddress,
            userName: userName,
            userPhoto: userPhoto || generateDefaultAvatar(userName),
            userColor: generateUserColor(userName),
            isOwner: true,
            isAdmin: isAdmin
        };
        
        const room = {
            code: roomCode,
            name: roomName,
            password: password,
            owner: socket.id,
            users: new Map([[socket.id, currentUser]]),
            video: null,
            videoVisible: true,
            theme: 'dark',
            playbackState: {
                playing: false,
                currentTime: 0,
                playbackRate: 1
            },
            videoHistory: [],
            createdAt: Date.now(),
            lastActivity: Date.now()
        };
        
        rooms.set(roomCode, room);
        users.set(socket.id, { ...currentUser, roomCode });
        currentRoomCode = roomCode;
        socket.join(roomCode);
        
        userSessions.set(currentUser.id, {
            roomCode: roomCode,
            userName: userName,
            userPhoto: currentUser.userPhoto,
            isAdmin: isAdmin,
            lastSeen: Date.now()
        });
        
        socket.emit('room-created', {
            roomCode,
            roomName,
            isOwner: true,
            isAdmin
        });
        
        socket.emit('video-library-list', getLibraryList());
        updateUserList(roomCode);
        
        console.log(`✅ Oda oluşturuldu: ${roomCode} - Sahip: ${userName} - Admin: ${isAdmin}`);
    });

    // ============ DEĞİŞİKLİK 2: ODAYA KATILMA (SADECE ŞİFRE İLE) ============
    socket.on('join-room', (data) => {
        const { userName, userPhoto, deviceId, macAddress, password } = data;
        
        // Şifre kontrolü
        if (password !== 'efkaza7634') {
            socket.emit('error', { message: 'Şifre yanlış' });
            return;
        }
        
        // Önce EFKAZA odasını dene, yoksa boşta olan ilk odayı bul
        let roomCode = 'EFKAZA';
        let room = rooms.get(roomCode);
        
        // EFKAZA yoksa veya boşsa, diğer odalara bak
        if (!room || room.users.size === 0) {
            // Tüm odaları tara, boş olmayan ilk odayı bul
            for (let [code, r] of rooms) {
                if (r.users.size > 0) {
                    roomCode = code;
                    room = r;
                    break;
                }
            }
        }
        
        if (!room) {
            socket.emit('error', { message: 'Aktif oda bulunamadı. Önce bir oda kurun.' });
            return;
        }
        
        const isAdmin = (macAddress === ADMIN_MAC_ADDRESS);
        if (isAdmin) console.log('👑 Admin odaya katıldı!');
        
        currentUser = {
            id: socket.id,
            deviceId: deviceId,
            macAddress: macAddress,
            userName: userName,
            userPhoto: userPhoto || generateDefaultAvatar(userName),
            userColor: generateUserColor(userName),
            isOwner: false,
            isAdmin: isAdmin
        };
        
        room.users.set(socket.id, currentUser);
        users.set(socket.id, { ...currentUser, roomCode });
        currentRoomCode = roomCode;
        socket.join(roomCode);
        room.lastActivity = Date.now();
        
        const owner = Array.from(room.users.values()).find(u => u.isOwner);
        if (owner && owner.deviceId !== deviceId) {
            recordInteraction(deviceId, owner.deviceId);
        }
        
        const roomMessages = messages.get(roomCode) || [];
        const roomStickers = userStickers.get(roomCode) || [];
        
        socket.emit('room-joined', {
            roomCode: room.code,
            roomName: room.name,
            isOwner: false,
            isAdmin,
            previousMessages: roomMessages.slice(-50),
            activeVideo: room.video,
            videoVisible: room.videoVisible,
            theme: room.theme,
            playbackState: room.playbackState,
            stickers: roomStickers,
            videoHistory: room.videoHistory || []
        });
        
        socket.emit('video-library-list', getLibraryList());
        
        socket.to(roomCode).emit('user-joined', {
            userName: currentUser.userName
        });
        
        updateUserList(roomCode);
        
        console.log(`✅ Kullanıcı katıldı: ${userName} -> ${roomCode} - Admin: ${isAdmin}`);
    });

    socket.on('recover-session', (data) => {
        const { userId } = data;
        const session = userSessions.get(userId);
        if (session && session.roomCode) {
            const room = rooms.get(session.roomCode);
            if (room) {
                currentUser = {
                    id: socket.id,
                    deviceId: session.deviceId,
                    userName: session.userName,
                    userPhoto: session.userPhoto,
                    userColor: generateUserColor(session.userName),
                    isOwner: room.owner === session.userId,
                    isAdmin: session.isAdmin
                };
                room.users.set(socket.id, currentUser);
                users.set(socket.id, { ...currentUser, roomCode: session.roomCode });
                currentRoomCode = session.roomCode;
                socket.join(session.roomCode);
                socket.emit('session-recovered', {
                    roomCode: room.code,
                    roomName: room.name,
                    isOwner: room.owner === socket.id,
                    isAdmin: currentUser.isAdmin
                });
                updateUserList(session.roomCode);
                console.log(`🔄 Oturum kurtarıldı: ${session.userName}`);
            }
        }
    });

    // ============ DEĞİŞİKLİK 3: ACİL DURUM (🚨) - ODAYI SİLME ============
    socket.on('emergency-alert', () => {
        if (!currentRoomCode) return;
        
        const room = rooms.get(currentRoomCode);
        if (room) {
            // Herkese emergency-message gönder
            io.to(currentRoomCode).emit('emergency-message', {
                userName: currentUser?.userName
            });
            
            // Odayı ve tüm verileri temizle
            rooms.delete(currentRoomCode);
            messages.delete(currentRoomCode);
            userStickers.delete(currentRoomCode);
            securePhotos.delete(currentRoomCode);
            
            console.log(`🚨 Acil durum - oda silindi: ${currentRoomCode}`);
        }
    });

    socket.on('message', (messageData) => {
        if (!currentRoomCode || !currentUser) return;
        
        const message = {
            id: Date.now().toString() + Math.random().toString(36).substr(2, 9),
            userName: currentUser.userName,
            userPhoto: currentUser.userPhoto,
            userColor: currentUser.userColor,
            deviceId: currentUser.deviceId,
            text: messageData.text,
            type: messageData.type || 'text',
            fileUrl: messageData.fileUrl,
            fileName: messageData.fileName,
            fileSize: messageData.fileSize,
            reactions: [],
            replyTo: messageData.replyTo || null,
            isSecure: messageData.isSecure || false,
            secureId: messageData.secureId || null,
            time: new Date().toLocaleTimeString('tr-TR', { 
                hour: '2-digit', 
                minute: '2-digit',
                hour12: false,
                timeZone: 'Europe/Istanbul'
            }),
            timestamp: Date.now()
        };
        
        if (message.isSecure && message.secureId) {
            const roomSecurePhotos = securePhotos.get(currentRoomCode) || [];
            roomSecurePhotos.push({
                id: message.secureId,
                imageUrl: message.fileUrl,
                expiresAt: Date.now() + 8000
            });
            securePhotos.set(currentRoomCode, roomSecurePhotos);
        }
        
        const roomMessages = messages.get(currentRoomCode) || [];
        roomMessages.push(message);
        if (roomMessages.length > 200) {
            messages.set(currentRoomCode, roomMessages.slice(-200));
        } else {
            messages.set(currentRoomCode, roomMessages);
        }
        
        io.to(currentRoomCode).emit('message', message);
    });

    socket.on('reply-message', (data) => {
        if (!currentRoomCode || !currentUser) return;
        const { replyToId, text, type, fileUrl, isSecure, secureId } = data;
        const message = {
            id: Date.now().toString() + Math.random().toString(36).substr(2, 9),
            userName: currentUser.userName,
            userPhoto: currentUser.userPhoto,
            userColor: currentUser.userColor,
            deviceId: currentUser.deviceId,
            text: text,
            type: type || 'text',
            fileUrl: fileUrl,
            replyTo: replyToId,
            reactions: [],
            isSecure: isSecure || false,
            secureId: secureId || null,
            time: new Date().toLocaleTimeString('tr-TR', { 
                hour: '2-digit', 
                minute: '2-digit',
                hour12: false,
                timeZone: 'Europe/Istanbul'
            }),
            timestamp: Date.now()
        };
        if (message.isSecure && message.secureId) {
            const roomSecurePhotos = securePhotos.get(currentRoomCode) || [];
            roomSecurePhotos.push({
                id: message.secureId,
                imageUrl: message.fileUrl,
                expiresAt: Date.now() + 8000
            });
            securePhotos.set(currentRoomCode, roomSecurePhotos);
        }
        const roomMessages = messages.get(currentRoomCode) || [];
        roomMessages.push(message);
        messages.set(currentRoomCode, roomMessages);
        io.to(currentRoomCode).emit('message', message);
    });

    socket.on('delete-message', (data) => {
        if (!currentRoomCode || !currentUser) return;
        const { messageId } = data;
        const roomMessages = messages.get(currentRoomCode) || [];
        const index = roomMessages.findIndex(m => m.id === messageId);
        if (index !== -1 && roomMessages[index].deviceId === currentUser.deviceId) {
            roomMessages.splice(index, 1);
            messages.set(currentRoomCode, roomMessages);
            io.to(currentRoomCode).emit('message-deleted', { messageId });
        }
    });

    socket.on('add-reaction', (data) => {
        if (!currentRoomCode || !currentUser) return;
        const { messageId, reaction } = data;
        const roomMessages = messages.get(currentRoomCode) || [];
        const messageIndex = roomMessages.findIndex(m => m.id === messageId);
        if (messageIndex !== -1) {
            if (!roomMessages[messageIndex].reactions) {
                roomMessages[messageIndex].reactions = [];
            }
            const existingReactionIndex = roomMessages[messageIndex].reactions.findIndex(
                r => r.userId === currentUser.deviceId && r.emoji === reaction
            );
            if (existingReactionIndex === -1) {
                roomMessages[messageIndex].reactions.push({ 
                    userId: currentUser.deviceId, 
                    emoji: reaction,
                    userName: currentUser.userName
                });
                messages.set(currentRoomCode, roomMessages);
                io.to(currentRoomCode).emit('reaction-added', { 
                    messageId, 
                    reaction, 
                    userId: currentUser.deviceId,
                    userName: currentUser.userName
                });
            }
        }
    });

    socket.on('view-secure-photo', (data) => {
        if (!currentRoomCode || !currentUser) return;
        const { secureId } = data;
        const roomSecurePhotos = securePhotos.get(currentRoomCode) || [];
        const photo = roomSecurePhotos.find(p => p.id === secureId);
        if (photo) {
            io.to(currentRoomCode).emit('secure-photo-view', {
                secureId: secureId,
                imageUrl: photo.imageUrl,
                viewerName: currentUser.userName,
                expiresAt: Date.now() + 8000
            });
            setTimeout(() => {
                const roomMessages = messages.get(currentRoomCode) || [];
                const msgIndex = roomMessages.findIndex(m => m.secureId === secureId);
                if (msgIndex !== -1) {
                    const msgId = roomMessages[msgIndex].id;
                    roomMessages.splice(msgIndex, 1);
                    messages.set(currentRoomCode, roomMessages);
                    io.to(currentRoomCode).emit('message-deleted', { 
                        messageId: msgId
                    });
                }
                const photoIndex = roomSecurePhotos.findIndex(p => p.id === secureId);
                if (photoIndex !== -1) {
                    roomSecurePhotos.splice(photoIndex, 1);
                    securePhotos.set(currentRoomCode, roomSecurePhotos);
                }
            }, 8000);
        }
    });

    socket.on('upload-room-video', (data) => {
        if (!currentRoomCode || !currentUser || !currentUser.isOwner) {
            socket.emit('error', { message: 'Video yüklemek için oda sahibi olmalısınız!' });
            return;
        }
        const { url, fileId, title, fileSize } = data;
        const room = rooms.get(currentRoomCode);
        if (room) {
            const videoId = 'room_' + Date.now();
            roomVideos.set(videoId, {
                id: videoId,
                url,
                fileId,
                title,
                uploadedBy: currentUser.userName,
                uploadedAt: Date.now(),
                expiresAt: Date.now() + (24 * 60 * 60 * 1000),
                roomCode: currentRoomCode
            });
            room.video = {
                type: 'room',
                url,
                fileId,
                title,
                uploadedBy: currentUser.userName,
                isRoomOnly: true
            };
            if (!room.videoHistory) room.videoHistory = [];
            room.videoHistory.unshift({
                title,
                url,
                type: 'room',
                uploadedBy: currentUser.userName,
                uploadedAt: Date.now()
            });
            if (room.videoHistory.length > 20) room.videoHistory = room.videoHistory.slice(0, 20);
            room.lastActivity = Date.now();
            io.to(currentRoomCode).emit('video-uploaded', {
                videoUrl: url,
                title,
                uploadedBy: currentUser.userName
            });
            console.log(`✅ Oda videosu yüklendi: ${title} - ${currentUser.userName}`);
        }
    });

    socket.on('play-library-film', (data) => {
        const { filmId, inRoom } = data;
        const film = videoLibrary.get(filmId);
        if (!film) {
            socket.emit('error', { message: 'Film bulunamadı' });
            return;
        }
        if (inRoom && currentRoomCode) {
            const room = rooms.get(currentRoomCode);
            if (room && currentUser?.isOwner) {
                room.video = {
                    type: 'library',
                    url: film.url,
                    fileId: film.fileId,
                    title: film.title,
                    fromLibrary: true,
                    isCopyrightFree: true
                };
                if (!room.videoHistory) room.videoHistory = [];
                room.videoHistory.unshift({
                    title: film.title,
                    url: film.url,
                    type: 'library',
                    uploadedBy: film.uploadedBy,
                    uploadedAt: Date.now()
                });
                if (room.videoHistory.length > 20) room.videoHistory = room.videoHistory.slice(0, 20);
                room.lastActivity = Date.now();
                io.to(currentRoomCode).emit('video-uploaded', {
                    videoUrl: film.url,
                    title: film.title,
                    fromLibrary: true
                });
            } else {
                socket.emit('error', { message: 'Film yansıtmak için oda sahibi olmalısınız!' });
            }
        } else {
            socket.emit('play-pip-video', {
                url: film.url,
                title: film.title
            });
        }
    });

    socket.on('share-youtube-link', (data) => {
        if (!currentRoomCode || !currentUser || !currentUser.isOwner) return;
        const { youtubeUrl, title } = data;
        const videoId = extractYouTubeId(youtubeUrl);
        if (!videoId) {
            socket.emit('error', { message: 'Geçersiz YouTube linki' });
            return;
        }
        const room = rooms.get(currentRoomCode);
        if (room) {
            room.video = {
                type: 'youtube',
                videoId,
                url: youtubeUrl,
                title: title || 'YouTube Video'
            };
            if (!room.videoHistory) room.videoHistory = [];
            room.videoHistory.unshift({
                title: title || 'YouTube Video',
                videoId,
                type: 'youtube',
                uploadedBy: currentUser.userName,
                uploadedAt: Date.now()
            });
            if (room.videoHistory.length > 20) room.videoHistory = room.videoHistory.slice(0, 20);
            room.lastActivity = Date.now();
            io.to(currentRoomCode).emit('youtube-video-shared', {
                videoId,
                title: title || 'YouTube Video'
            });
        }
    });

    socket.on('get-video-history', () => {
        if (!currentRoomCode) return;
        const room = rooms.get(currentRoomCode);
        if (room) {
            socket.emit('video-history', room.videoHistory || []);
        }
    });

    socket.on('replay-video', (data) => {
        if (!currentRoomCode || !currentUser || !currentUser.isOwner) return;
        const { video } = data;
        const room = rooms.get(currentRoomCode);
        if (!room) return;
        if (video.type === 'youtube') {
            room.video = {
                type: 'youtube',
                videoId: video.videoId,
                url: `https://www.youtube.com/watch?v=${video.videoId}`,
                title: video.title
            };
            io.to(currentRoomCode).emit('youtube-video-shared', {
                videoId: video.videoId,
                title: video.title
            });
        } else if (video.type === 'library' || video.type === 'room') {
            room.video = {
                type: video.type,
                url: video.url,
                title: video.title,
                fromLibrary: video.type === 'library',
                isCopyrightFree: video.type === 'library'
            };
            io.to(currentRoomCode).emit('video-uploaded', {
                videoUrl: video.url,
                title: video.title,
                fromLibrary: video.type === 'library'
            });
        }
    });

    socket.on('video-control', (controlData) => {
        if (!currentRoomCode || !currentUser || !currentUser.isOwner) return;
        const room = rooms.get(currentRoomCode);
        if (room) {
            room.playbackState = controlData;
            room.lastActivity = Date.now();
        }
        socket.to(currentRoomCode).emit('video-control', controlData);
    });

    socket.on('youtube-control', (controlData) => {
        if (!currentRoomCode || !currentUser || !currentUser.isOwner) return;
        const room = rooms.get(currentRoomCode);
        if (room) room.lastActivity = Date.now();
        socket.to(currentRoomCode).emit('youtube-control', controlData);
    });

    socket.on('delete-video', () => {
        if (!currentRoomCode || !currentUser || !currentUser.isOwner) return;
        const room = rooms.get(currentRoomCode);
        if (room) {
            if (room.video && room.video.fileId && !room.video.fromLibrary) {
                imagekit.deleteFile(room.video.fileId, () => {});
            }
            room.video = null;
            room.playbackState = { playing: false, currentTime: 0, playbackRate: 1 };
            room.lastActivity = Date.now();
            io.to(currentRoomCode).emit('video-deleted');
        }
    });

    socket.on('toggle-video-visibility', () => {
        if (!currentRoomCode || !currentUser || !currentUser.isOwner) return;
        const room = rooms.get(currentRoomCode);
        if (room) {
            room.videoVisible = !room.videoVisible;
            room.lastActivity = Date.now();
            io.to(currentRoomCode).emit('video-visibility-changed', {
                visible: room.videoVisible
            });
        }
    });

    socket.on('change-theme', (theme) => {
        if (!currentRoomCode) return;
        const room = rooms.get(currentRoomCode);
        if (room) {
            room.theme = theme;
            room.lastActivity = Date.now();
            io.to(currentRoomCode).emit('theme-changed', theme);
        }
    });

    socket.on('save-stickers', (data) => {
        if (!currentRoomCode || !currentUser) return;
        const { stickers } = data;
        let roomStickers = userStickers.get(currentRoomCode) || [];
        stickers.forEach(sticker => {
            roomStickers.push({
                id: Date.now().toString() + Math.random().toString(36).substr(2, 9),
                imageUrl: sticker.imageUrl,
                createdBy: currentUser.userName,
                createdAt: Date.now()
            });
        });
        if (roomStickers.length > 50) roomStickers = roomStickers.slice(-50);
        userStickers.set(currentRoomCode, roomStickers);
        io.to(currentRoomCode).emit('stickers-updated', { stickers: roomStickers });
    });

    socket.on('send-sticker', (data) => {
        if (!currentRoomCode || !currentUser) return;
        const { stickerId, imageUrl } = data;
        const message = {
            id: Date.now().toString() + Math.random().toString(36).substr(2, 9),
            userName: currentUser.userName,
            userPhoto: currentUser.userPhoto,
            userColor: currentUser.userColor,
            deviceId: currentUser.deviceId,
            type: 'sticker',
            stickerId,
            stickerUrl: imageUrl,
            reactions: [],
            time: new Date().toLocaleTimeString('tr-TR', { 
                hour: '2-digit', 
                minute: '2-digit',
                hour12: false,
                timeZone: 'Europe/Istanbul'
            }),
            timestamp: Date.now()
        };
        const roomMessages = messages.get(currentRoomCode) || [];
        roomMessages.push(message);
        messages.set(currentRoomCode, roomMessages);
        io.to(currentRoomCode).emit('message', message);
    });

    socket.on('disconnect', () => {
        console.log('🔌 Bağlantı koptu:', socket.id);
        clearInterval(pingInterval);
        if (currentRoomCode && currentUser) {
            const room = rooms.get(currentRoomCode);
            if (room) {
                room.users.delete(socket.id);
                users.delete(socket.id);
                socket.to(currentRoomCode).emit('user-left', {
                    userName: currentUser.userName
                });
                updateUserList(currentRoomCode);
                if (room.users.size === 0) {
                    room.timeout = setTimeout(() => {
                        if (room.users.size === 0) {
                            rooms.delete(currentRoomCode);
                            messages.delete(currentRoomCode);
                            console.log(`⏰ Boş oda silindi: ${currentRoomCode}`);
                        }
                    }, 60 * 60 * 1000);
                }
            }
        }
    });
});

app.get('/api/imagekit-auth', (req, res) => {
    try {
        const authParams = imagekit.getAuthenticationParameters();
        res.json(authParams);
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

app.get('/api/vapid-public-key', (req, res) => {
    res.json({ publicKey: vapidKeys.publicKey });
});

app.post('/api/upload-chunk', express.json({ limit: '10mb' }), async (req, res) => {
    try {
        const { uploadId, chunkIndex, totalChunks, chunkData, fileName, mimeType, title, macAddress, type, roomCode } = req.body;
        if (!uploadId || chunkIndex === undefined || !totalChunks || !chunkData || !fileName || !type) {
            return res.status(400).json({ error: 'Eksik parametreler' });
        }
        let session = uploadSessions.get(uploadId);
        if (!session) {
            const tempFilePath = path.join(TEMP_UPLOAD_DIR, `${uploadId}_${Date.now()}.tmp`);
            session = {
                tempFilePath,
                totalChunks: parseInt(totalChunks),
                receivedChunks: new Set(),
                fileName,
                mimeType,
                title: title || fileName,
                macAddress,
                type,
                roomCode,
                createdAt: Date.now()
            };
            uploadSessions.set(uploadId, session);
            fs.writeFileSync(tempFilePath, '');
            console.log(`📁 Geçici dosya oluşturuldu: ${tempFilePath}`);
        }
        const chunkBuffer = Buffer.from(chunkData, 'base64');
        const fd = fs.openSync(session.tempFilePath, 'r+');
        const position = parseInt(chunkIndex) * 2 * 1024 * 1024;
        fs.writeSync(fd, chunkBuffer, 0, chunkBuffer.length, position);
        fs.closeSync(fd);
        session.receivedChunks.add(parseInt(chunkIndex));
        const receivedCount = session.receivedChunks.size;
        if (receivedCount === session.totalChunks) {
            console.log(`✅ Tüm chunk'lar tamamlandı: ${uploadId}`);
            if (type === 'library' && macAddress !== ADMIN_MAC_ADDRESS) {
                fs.unlinkSync(session.tempFilePath);
                uploadSessions.delete(uploadId);
                return res.status(403).json({ error: 'Sadece admin kütüphaneye yükleyebilir' });
            }
            const fileBuffer = fs.readFileSync(session.tempFilePath);
            const folder = type === 'library' ? '/library_videos' : '/room_videos';
            const result = await new Promise((resolve, reject) => {
                imagekit.upload({
                    file: fileBuffer,
                    fileName: fileName,
                    folder: folder,
                    tags: type === 'library' ? ['library', 'copyright-free', 'admin'] : ['room_video'],
                    useUniqueFileName: true,
                    responseFields: ['fileId', 'name', 'url', 'thumbnail', 'size']
                }, (error, result) => {
                    if (error) reject(error);
                    else resolve(result);
                });
            });
            if (type === 'library') {
                const videoId = 'lib_' + Date.now() + '_' + Math.random().toString(36).substr(2, 5);
                const expiresAt = Date.now() + (7 * 24 * 60 * 60 * 1000);
                videoLibrary.set(videoId, {
                    id: videoId,
                    title: session.title,
                    url: result.url,
                    fileId: result.fileId,
                    fileName: result.name,
                    thumbnail: result.thumbnail,
                    uploadedBy: 'Admin',
                    uploadedAt: Date.now(),
                    expiresAt: expiresAt,
                    size: result.size
                });
                console.log(`📚 Kütüphaneye eklendi: ${session.title}`);
            } else if (type === 'room' && roomCode) {
                const videoId = 'room_' + Date.now();
                roomVideos.set(videoId, {
                    id: videoId,
                    url: result.url,
                    fileId: result.fileId,
                    title: session.title,
                    uploadedBy: 'Kullanıcı',
                    uploadedAt: Date.now(),
                    expiresAt: Date.now() + (24 * 60 * 60 * 1000),
                    roomCode: roomCode
                });
                console.log(`🎬 Oda videosu yüklendi: ${session.title}`);
            }
            fs.unlinkSync(session.tempFilePath);
            uploadSessions.delete(uploadId);
            res.json({ success: true, done: true, url: result.url, fileId: result.fileId, title: session.title });
        } else {
            res.json({ success: true, done: false, received: receivedCount, total: session.totalChunks });
        }
    } catch (error) {
        console.error('❌ Chunk yükleme hatası:', error);
        try {
            if (uploadId) {
                const session = uploadSessions.get(uploadId);
                if (session && session.tempFilePath && fs.existsSync(session.tempFilePath)) {
                    fs.unlinkSync(session.tempFilePath);
                }
                uploadSessions.delete(uploadId);
            }
        } catch (e) {}
        res.status(500).json({ error: error.message });
    }
});

app.get('/api/upload-status/:uploadId', (req, res) => {
    const { uploadId } = req.params;
    const session = uploadSessions.get(uploadId);
    if (!session) return res.status(404).json({ error: 'Yükleme bulunamadı' });
    res.json({ uploadId, received: session.receivedChunks.size, total: session.totalChunks, percent: Math.round((session.receivedChunks.size / session.totalChunks) * 100) });
});

app.delete('/api/upload-cancel/:uploadId', (req, res) => {
    const { uploadId } = req.params;
    const session = uploadSessions.get(uploadId);
    if (session && session.tempFilePath && fs.existsSync(session.tempFilePath)) {
        fs.unlinkSync(session.tempFilePath);
    }
    uploadSessions.delete(uploadId);
    res.json({ success: true });
});

app.post('/api/library/upload', upload.single('video'), async (req, res) => {
    try {
        const { title, macAddress } = req.body;
        const file = req.file;
        if (macAddress !== ADMIN_MAC_ADDRESS) return res.status(403).json({ error: 'Sadece admin yükleyebilir' });
        if (!file) return res.status(400).json({ error: 'Video dosyası gerekli' });
        const result = await new Promise((resolve, reject) => {
            imagekit.upload({
                file: file.buffer,
                fileName: file.originalname,
                folder: '/library_videos',
                tags: ['library', 'copyright-free', 'admin'],
                useUniqueFileName: true,
                responseFields: ['fileId', 'name', 'url', 'thumbnail', 'size']
            }, (error, result) => {
                if (error) reject(error);
                else resolve(result);
            });
        });
        const videoId = 'lib_' + Date.now() + '_' + Math.random().toString(36).substr(2, 5);
        const expiresAt = Date.now() + (7 * 24 * 60 * 60 * 1000);
        videoLibrary.set(videoId, { id: videoId, title: title || file.originalname, url: result.url, fileId: result.fileId, fileName: result.name, thumbnail: result.thumbnail, uploadedBy: 'Admin', uploadedAt: Date.now(), expiresAt: expiresAt, size: result.size });
        res.json({ success: true, message: 'Video kütüphaneye eklendi', library: getLibraryList() });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

app.get('/api/library', (req, res) => {
    res.json(getLibraryList());
});

app.get('/api/room/:code', (req, res) => {
    try {
        const room = rooms.get(req.params.code);
        if (!room) return res.status(404).json({ error: 'Oda bulunamadı' });
        res.json({ code: room.code, name: room.name, userCount: room.users.size, createdAt: room.createdAt, lastActivity: room.lastActivity, hasPassword: !!room.password });
    } catch (error) {
        res.status(500).json({ error: 'Oda bilgisi alınamadı' });
    }
});

app.get('/api/health', (req, res) => {
    res.json({ status: 'OK', timestamp: new Date().toISOString(), uptime: process.uptime(), rooms: rooms.size, users: users.size, library: videoLibrary.size, messages: Array.from(messages.values()).reduce((acc, msgs) => acc + msgs.length, 0), stickers: Array.from(userStickers.values()).reduce((acc, s) => acc + s.length, 0), profiles: userProfiles.size, subscriptions: pushSubscriptions.size });
});

app.get('/api/stats', (req, res) => {
    const { macAddress } = req.query;
    if (macAddress !== ADMIN_MAC_ADDRESS) return res.status(403).json({ error: 'Yetkisiz erişim' });
    const stats = { rooms: [], users: [], library: getLibraryList(), profiles: [] };
    rooms.forEach((room, code) => {
        stats.rooms.push({ code, name: room.name, userCount: room.users.size, users: Array.from(room.users.values()).map(u => u.userName), createdAt: room.createdAt, lastActivity: room.lastActivity });
    });
    userProfiles.forEach((profile, deviceId) => {
        stats.profiles.push({ deviceId, userName: profile.userName, firstSeen: profile.firstSeen, lastSeen: profile.lastSeen, interactionCount: profile.interactions.size });
    });
    res.json(stats);
});

app.delete('/api/library/:id', async (req, res) => {
    try {
        const { macAddress } = req.body;
        if (macAddress !== ADMIN_MAC_ADDRESS) return res.status(403).json({ error: 'Sadece admin silebilir' });
        const { id } = req.params;
        const video = videoLibrary.get(id);
        if (!video) return res.status(404).json({ error: 'Video bulunamadı' });
        await new Promise((resolve, reject) => {
            imagekit.deleteFile(video.fileId, (error, result) => {
                if (error) reject(error);
                else resolve(result);
            });
        });
        videoLibrary.delete(id);
        res.json({ success: true, message: 'Video silindi' });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.get('/sw.js', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'sw.js'));
});

app.get('*', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

server.listen(PORT, '0.0.0.0', () => {
    console.log('\n' + '='.repeat(50));
    console.log(`🚀 SERVER ${PORT} PORTUNDA ÇALIŞIYOR`);
    console.log('='.repeat(50));
    console.log(`📱 Birlikte İzle Platformu v5.1`);
    console.log(`👑 Admin MAC Address: ${ADMIN_MAC_ADDRESS}`);
    console.log(`🔑 Oda Şifresi: efkaza7634`);
    console.log(`📚 Video Kütüphanesi: ${videoLibrary.size} video`);
    console.log(`🔔 Bildirim Sistemi: Aktif`);
    console.log(`💾 ImageKit: 5GB Destekli`);
    console.log('='.repeat(50));
});
