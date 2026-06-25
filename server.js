const express = require('express');
const app = express();
const http = require('http').createServer(app);
const io = require('socket.io')(http);
const multer = require('multer');
const path = require('path');
const fs = require('fs');

const PORT = process.env.PORT || 3000;

// ============================================================
// 1. DOSYA YÜKLEME AYARLARI
// ============================================================

const storage = multer.diskStorage({
    destination: (req, file, cb) => {
        const dir = './uploads';
        if (!fs.existsSync(dir)) {
            fs.mkdirSync(dir, { recursive: true });
        }
        cb(null, dir);
    },
    filename: (req, file, cb) => {
        const unique = Date.now() + '-' + Math.round(Math.random() * 1E9);
        const ext = path.extname(file.originalname);
        cb(null, unique + ext);
    }
});

const upload = multer({ 
    storage: storage,
    limits: { fileSize: 100 * 1024 * 1024 },
    fileFilter: (req, file, cb) => {
        const allowedTypes = ['image/jpeg', 'image/png', 'image/gif', 'video/mp4', 'video/webm', 'audio/webm', 'application/pdf'];
        if (allowedTypes.includes(file.mimetype)) {
            cb(null, true);
        } else {
            cb(new Error('Desteklenmeyen dosya türü!'));
        }
    }
});

// ============================================================
// 2. STATİK DOSYALAR
// ============================================================

app.use(express.static(__dirname));
app.use('/uploads', express.static('uploads'));
app.use(express.json({ limit: '100mb' }));
app.use(express.urlencoded({ extended: true, limit: '100mb' }));

// ============================================================
// 3. VERİ DEPOLARI
// ============================================================

const users = new Map();           // socketId -> user
const socketToUser = new Map();    // socketId -> user
const onlineUsers = new Map();     // socketId -> user
const chatHistory = [];            // tüm mesajlar
const MAX_HISTORY = 1000;          // maksimum mesaj sayısı
const activeRooms = new Map();     // oda sistemi için
const messageReactions = new Map(); // mesaj tepkileri

// ============================================================
// 4. ROTALAR
// ============================================================

// Ana sayfa
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'index.html'));
});

// Tüm yollar index.html'e yönlendir
app.get('*', (req, res) => {
    res.sendFile(path.join(__dirname, 'index.html'));
});

// Dosya yükleme
app.post('/upload', upload.single('file'), (req, res) => {
    try {
        if (!req.file) {
            return res.status(400).json({ 
                success: false, 
                error: 'Dosya yüklenemedi!' 
            });
        }
        
        res.json({ 
            success: true,
            url: `/uploads/${req.file.filename}`,
            type: req.file.mimetype,
            name: req.file.originalname,
            size: req.file.size
        });
    } catch (error) {
        res.status(500).json({ 
            success: false, 
            error: error.message 
        });
    }
});

// Tüm kullanıcıları getir (admin için)
app.get('/api/users', (req, res) => {
    const userList = Array.from(users.values()).map(u => ({
        username: u.username,
        avatar: u.avatar,
        joinedAt: u.joinedAt,
        isOnline: onlineUsers.has(u.id)
    }));
    res.json(userList);
});

// Mesaj geçmişi
app.get('/api/history', (req, res) => {
    res.json(chatHistory.slice(-50));
});

// ============================================================
// 5. SOCKET.IO
// ============================================================

io.on('connection', (socket) => {
    console.log('✅ Yeni bağlantı:', socket.id);
    console.log('📊 Toplam bağlantı:', io.engine.clientsCount);

    // ======== 5.1. KAYIT ========
    socket.on('register', (data) => {
        const { username, avatar } = data;
        
        // Validasyon
        if (!username || username.length < 2 || username.length > 20) {
            socket.emit('error', 'Kullanıcı adı 2-20 karakter olmalı!');
            return;
        }
        
        // Kullanıcı adı kontrolü
        for (const [id, user] of users) {
            if (user.username.toLowerCase() === username.toLowerCase() && id !== socket.id) {
                socket.emit('error', 'Bu kullanıcı adı zaten kullanılıyor!');
                return;
            }
        }
        
        // Kullanıcı oluştur
        const user = {
            id: socket.id,
            username: username,
            avatar: avatar || '😀',
            joinedAt: Date.now(),
            lastActive: Date.now(),
            isAdmin: username.toLowerCase() === 'admin' || username.toLowerCase() === 'efkaza'
        };
        
        // Depolara ekle
        users.set(socket.id, user);
        socketToUser.set(socket.id, user);
        onlineUsers.set(socket.id, user);
        
        // Başarılı kayıt
        socket.emit('registerSuccess', {
            user: user,
            history: chatHistory.slice(-50),
            onlineUsers: Array.from(onlineUsers.values())
        });
        
        // Diğer kullanıcılara bildir
        socket.broadcast.emit('userJoined', user);
        io.emit('onlineUsersUpdate', Array.from(onlineUsers.values()));
        
        console.log('👤 Kullanıcı giriş yaptı:', username);
        console.log('📊 Çevrimiçi:', onlineUsers.size);
    });

    // ======== 5.2. MESAJ GÖNDER ========
    socket.on('sendMessage', (data) => {
        const user = socketToUser.get(socket.id);
        if (!user) {
            socket.emit('error', 'Oturum bulunamadı!');
            return;
        }
        
        // 🚨 Emoji ile sohbet temizleme (sadece admin)
        if (data.message.includes('🚨')) {
            if (user.isAdmin) {
                chatHistory.length = 0;
                io.emit('chatCleared', { 
                    clearedBy: user.username,
                    timestamp: Date.now()
                });
                console.log('🧹 Sohbet temizlendi:', user.username);
            } else {
                socket.emit('error', 'Bu işlem için admin yetkisi gerekli!');
            }
            return;
        }
        
        // Mesaj oluştur
        const message = {
            id: Date.now() + '-' + Math.random().toString(36).substr(2, 9),
            username: user.username,
            avatar: user.avatar,
            message: data.message,
            timestamp: Date.now(),
            type: 'text',
            reactions: [],
            replies: [],
            edited: false,
            deleted: false,
            isAdmin: user.isAdmin || false
        };
        
        // Geçmişe ekle
        chatHistory.push(message);
        if (chatHistory.length > MAX_HISTORY) {
            const removed = chatHistory.shift();
            // Eski mesajları temizle
        }
        
        // Herkese gönder
        io.emit('newMessage', message);
    });

    // ======== 5.3. DOSYA MESAJI ========
    socket.on('sendFile', (data) => {
        const user = socketToUser.get(socket.id);
        if (!user) return;
        
        const message = {
            id: Date.now() + '-' + Math.random().toString(36).substr(2, 9),
            username: user.username,
            avatar: user.avatar,
            message: data.url,
            timestamp: Date.now(),
            type: data.type || 'file',
            fileName: data.name || 'dosya',
            fileSize: data.size || 0,
            reactions: [],
            replies: [],
            edited: false,
            deleted: false,
            isAdmin: user.isAdmin || false
        };
        
        chatHistory.push(message);
        if (chatHistory.length > MAX_HISTORY) {
            chatHistory.shift();
        }
        
        io.emit('newMessage', message);
        console.log('📁 Dosya gönderildi:', user.username, data.name);
    });

    // ======== 5.4. SES MESAJI ========
    socket.on('sendVoice', (data) => {
        const user = socketToUser.get(socket.id);
        if (!user) return;
        
        try {
            const voiceData = data.voiceData;
            const duration = data.duration || 0;
            const filename = `voice_${Date.now()}.webm`;
            const filepath = path.join(__dirname, 'uploads', filename);
            
            // Base64'ten dosya oluştur
            const base64String = voiceData.split(',')[1] || voiceData;
            const buffer = Buffer.from(base64String, 'base64');
            fs.writeFileSync(filepath, buffer);
            
            const message = {
                id: Date.now() + '-' + Math.random().toString(36).substr(2, 9),
                username: user.username,
                avatar: user.avatar,
                message: `/uploads/${filename}`,
                timestamp: Date.now(),
                type: 'voice',
                duration: duration,
                reactions: [],
                replies: [],
                edited: false,
                deleted: false,
                isAdmin: user.isAdmin || false
            };
            
            chatHistory.push(message);
            if (chatHistory.length > MAX_HISTORY) {
                chatHistory.shift();
            }
            
            io.emit('newMessage', message);
            console.log('🎤 Ses mesajı:', user.username, duration + 's');
            
        } catch (err) {
            console.error('Ses kaydetme hatası:', err);
            socket.emit('error', 'Ses kaydedilemedi!');
        }
    });

    // ======== 5.5. MESAJ DÜZENLE ========
    socket.on('editMessage', (data) => {
        const user = socketToUser.get(socket.id);
        if (!user) return;
        
        const msgIndex = chatHistory.findIndex(m => m.id === data.messageId);
        if (msgIndex === -1) {
            socket.emit('error', 'Mesaj bulunamadı!');
            return;
        }
        
        const msg = chatHistory[msgIndex];
        if (msg.username !== user.username && !user.isAdmin) {
            socket.emit('error', 'Bu mesajı düzenleme yetkiniz yok!');
            return;
        }
        
        msg.message = data.newMessage;
        msg.edited = true;
        msg.editedAt = Date.now();
        
        io.emit('messageEdited', {
            messageId: data.messageId,
            newMessage: data.newMessage,
            editedAt: msg.editedAt
        });
    });

    // ======== 5.6. MESAJ SİL ========
    socket.on('deleteMessage', (data) => {
        const user = socketToUser.get(socket.id);
        if (!user) return;
        
        const msgIndex = chatHistory.findIndex(m => m.id === data.messageId);
        if (msgIndex === -1) {
            socket.emit('error', 'Mesaj bulunamadı!');
            return;
        }
        
        const msg = chatHistory[msgIndex];
        if (msg.username !== user.username && !user.isAdmin) {
            socket.emit('error', 'Bu mesajı silme yetkiniz yok!');
            return;
        }
        
        msg.deleted = true;
        msg.message = 'Bu mesaj silindi';
        msg.deletedAt = Date.now();
        
        io.emit('messageDeleted', {
            messageId: data.messageId,
            deletedAt: msg.deletedAt
        });
    });

    // ======== 5.7. MESAJ YANITLA ========
    socket.on('replyMessage', (data) => {
        const user = socketToUser.get(socket.id);
        if (!user) return;
        
        const originalMsg = chatHistory.find(m => m.id === data.messageId);
        if (!originalMsg) {
            socket.emit('error', 'Yanıtlanacak mesaj bulunamadı!');
            return;
        }
        
        const reply = {
            id: Date.now() + '-' + Math.random().toString(36).substr(2, 9),
            username: user.username,
            avatar: user.avatar,
            message: data.replyMessage,
            timestamp: Date.now(),
            type: 'text',
            replyTo: {
                id: originalMsg.id,
                username: originalMsg.username,
                message: originalMsg.message
            },
            reactions: [],
            replies: [],
            edited: false,
            deleted: false,
            isAdmin: user.isAdmin || false
        };
        
        chatHistory.push(reply);
        if (chatHistory.length > MAX_HISTORY) {
            chatHistory.shift();
        }
        
        io.emit('newMessage', reply);
    });

    // ======== 5.8. TEPKİ EKLE ========
    socket.on('addReaction', (data) => {
        const user = socketToUser.get(socket.id);
        if (!user) return;
        
        const msg = chatHistory.find(m => m.id === data.messageId);
        if (!msg) {
            socket.emit('error', 'Mesaj bulunamadı!');
            return;
        }
        
        // Tepki zaten var mı kontrol et
        const existingReaction = msg.reactions.find(
            r => r.username === user.username && r.emoji === data.emoji
        );
        
        if (existingReaction) {
            // Tepkiyi kaldır
            msg.reactions = msg.reactions.filter(
                r => !(r.username === user.username && r.emoji === data.emoji)
            );
        } else {
            // Tepki ekle
            msg.reactions.push({
                username: user.username,
                emoji: data.emoji,
                timestamp: Date.now()
            });
        }
        
        io.emit('reactionUpdated', {
            messageId: data.messageId,
            reactions: msg.reactions
        });
    });

    // ======== 5.9. ÇIKARTMA OLUŞTUR ========
    socket.on('createSticker', (data) => {
        const user = socketToUser.get(socket.id);
        if (!user) return;
        
        const message = {
            id: Date.now() + '-' + Math.random().toString(36).substr(2, 9),
            username: user.username,
            avatar: user.avatar,
            message: data.stickerData,
            timestamp: Date.now(),
            type: 'sticker',
            reactions: [],
            replies: [],
            edited: false,
            deleted: false,
            isAdmin: user.isAdmin || false
        };
        
        chatHistory.push(message);
        if (chatHistory.length > MAX_HISTORY) {
            chatHistory.shift();
        }
        
        io.emit('newMessage', message);
        console.log('💠 Çıkartma oluşturuldu:', user.username);
    });

    // ======== 5.10. GIF ARA ========
    socket.on('searchGif', (data) => {
        const searchTerm = data.searchTerm?.toLowerCase() || '';
        
        // Örnek GIF'ler (gerçek API için genişletilebilir)
        const gifLibrary = [
            { url: 'https://media.giphy.com/media/3o7abKhOpu0N9H8l8Y/giphy.gif', tags: ['happy', 'joy'] },
            { url: 'https://media.giphy.com/media/l0HlNQ3J5J4Nl7Ff6/giphy.gif', tags: ['funny', 'laugh'] },
            { url: 'https://media.giphy.com/media/3o6Zt481isNVuQI1l6/giphy.gif', tags: ['sad', 'cry'] },
            { url: 'https://media.giphy.com/media/26BRzozg4TCBXvYQU/giphy.gif', tags: ['excited', 'party'] },
            { url: 'https://media.giphy.com/media/xT9IgzoKnwFNmISR8I/giphy.gif', tags: ['love', 'heart'] },
            { url: 'https://media.giphy.com/media/3o6Zt1f0ZqVlZvRZgU/giphy.gif', tags: ['shocked', 'wow'] },
            { url: 'https://media.giphy.com/media/3o6ZtY8tBvLJw2TvUc/giphy.gif', tags: ['angry', 'mad'] },
            { url: 'https://media.giphy.com/media/3o6ZtY8tBvLJw2TvUc/giphy.gif', tags: ['cool', 'awesome'] }
        ];
        
        let results = gifLibrary;
        if (searchTerm) {
            results = gifLibrary.filter(gif => 
                gif.tags.some(tag => tag.includes(searchTerm)) ||
                gif.url.toLowerCase().includes(searchTerm)
            );
        }
        
        socket.emit('gifResults', {
            results: results.map(g => g.url).slice(0, 10),
            searchTerm: searchTerm
        });
    });

    // ======== 5.11. YAZIYOR BİLDİRİMİ ========
    socket.on('typing', (data) => {
        const user = socketToUser.get(socket.id);
        if (!user) return;
        
        socket.broadcast.emit('userTyping', {
            username: user.username,
            isTyping: data.isTyping
        });
    });

    // ======== 5.12. KULLANICI GÜNCELLEME ========
    socket.on('updateUser', (data) => {
        const user = socketToUser.get(socket.id);
        if (!user) return;
        
        if (data.avatar) {
            user.avatar = data.avatar;
        }
        if (data.username && data.username.length >= 2 && data.username.length <= 20) {
            user.username = data.username;
        }
        
        users.set(socket.id, user);
        socketToUser.set(socket.id, user);
        onlineUsers.set(socket.id, user);
        
        io.emit('userUpdated', user);
        io.emit('onlineUsersUpdate', Array.from(onlineUsers.values()));
    });

    // ======== 5.13. BAĞLANTI KESİL ========
    socket.on('disconnect', () => {
        console.log('❌ Bağlantı koptu:', socket.id);
        
        const user = socketToUser.get(socket.id);
        if (user) {
            onlineUsers.delete(socket.id);
            io.emit('userLeft', user);
            io.emit('onlineUsersUpdate', Array.from(onlineUsers.values()));
            socketToUser.delete(socket.id);
            
            console.log('👤 Kullanıcı ayrıldı:', user.username);
            console.log('📊 Çevrimiçi:', onlineUsers.size);
        }
        
        users.delete(socket.id);
    });

    // ======== 5.14. HATA YAKALAMA ========
    socket.on('error', (error) => {
        console.error('Socket hata:', error);
        socket.emit('error', 'Bir hata oluştu!');
    });
});

// ============================================================
// 6. SUNUCU BAŞLAT
// ============================================================

http.listen(PORT, '0.0.0.0', () => {
    console.log('\n========================================');
    console.log('🚀 SUNUCU BAŞLATILDI');
    console.log('========================================');
    console.log(`📡 Adres: http://localhost:${PORT}`);
    console.log(`💬 Uygulama: RGB Renk Tahmin + Sohbet`);
    console.log(`👥 Toplam kullanıcı: ${users.size}`);
    console.log(`🟢 Çevrimiçi: ${onlineUsers.size}`);
    console.log(`📝 Mesaj geçmişi: ${chatHistory.length}`);
    console.log(`💾 Maksimum mesaj: ${MAX_HISTORY}`);
    console.log('========================================\n');
});

// ============================================================
// 7. PERİYODİK BAKIM
// ============================================================

// 5 dakikada bir aktiflik kontrolü
setInterval(() => {
    const now = Date.now();
    let inactiveUsers = 0;
    
    for (const [id, user] of onlineUsers) {
        if (now - user.lastActive > 30 * 60 * 1000) { // 30 dakika
            onlineUsers.delete(id);
            inactiveUsers++;
            io.emit('userLeft', user);
        }
    }
    
    if (inactiveUsers > 0) {
        io.emit('onlineUsersUpdate', Array.from(onlineUsers.values()));
        console.log(`🕐 ${inactiveUsers} inaktif kullanıcı temizlendi`);
    }
}, 5 * 60 * 1000);

// 1 saatte bir eski dosyaları temizle
setInterval(() => {
    const uploadDir = './uploads';
    const files = fs.readdirSync(uploadDir);
    const now = Date.now();
    let deletedFiles = 0;
    
    files.forEach(file => {
        const filePath = path.join(uploadDir, file);
        const stats = fs.statSync(filePath);
        const fileAge = now - stats.mtimeMs;
        
        // 24 saatten eski dosyaları temizle
        if (fileAge > 24 * 60 * 60 * 1000 && file.startsWith('voice_')) {
            fs.unlinkSync(filePath);
            deletedFiles++;
        }
    });
    
    if (deletedFiles > 0) {
        console.log(`🗑️ ${deletedFiles} eski ses dosyası temizlendi`);
    }
}, 60 * 60 * 1000);
