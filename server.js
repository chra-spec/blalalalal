const express = require('express');
const app = express();
const http = require('http').createServer(app);
const io = require('socket.io')(http);
const multer = require('multer');
const path = require('path');
const fs = require('fs');

const PORT = process.env.PORT || 3000;

// ============ DOSYA YÜKLEME AYARLARI ============
const storage = multer.diskStorage({
    destination: (req, file, cb) => {
        const dir = './uploads';
        if (!fs.existsSync(dir)) fs.mkdirSync(dir);
        cb(null, dir);
    },
    filename: (req, file, cb) => {
        const unique = Date.now() + '-' + Math.round(Math.random() * 1E9);
        cb(null, unique + path.extname(file.originalname));
    }
});

const upload = multer({ 
    storage: storage,
    limits: { fileSize: 100 * 1024 * 1024 }
});

app.use(express.static(__dirname));
app.use('/uploads', express.static('uploads'));

// ============ VERİ DEPOLARI ============
const users = new Map();
const socketToUser = new Map();
const onlineUsers = new Map();
const chatHistory = [];
const MAX_HISTORY = 1000;
const SECRET_CODE = 'efkaza7634';

// ============ ROTALAR ============
app.get('*', (req, res) => {
    res.sendFile(__dirname + '/index.html');
});

app.post('/upload', upload.single('file'), (req, res) => {
    if (!req.file) {
        return res.status(400).json({ error: 'Dosya yüklenemedi' });
    }
    res.json({ 
        url: `/uploads/${req.file.filename}`,
        type: req.file.mimetype,
        name: req.file.originalname
    });
});

// ============ SOCKET.IO ============
io.on('connection', (socket) => {
    console.log('✅ Yeni bağlantı:', socket.id);

    // ======== 1. KAYIT ========
    socket.on('register', (data) => {
        const { username, avatar } = data;
        
        if (!username || username.length < 2 || username.length > 20) {
            socket.emit('error', 'Kullanıcı adı 2-20 karakter olmalı!');
            return;
        }
        
        for (const [id, user] of users) {
            if (user.username.toLowerCase() === username.toLowerCase() && id !== socket.id) {
                socket.emit('error', 'Bu kullanıcı adı zaten kullanılıyor!');
                return;
            }
        }
        
        const user = {
            id: socket.id,
            username: username,
            avatar: avatar || '😀',
            isAdmin: false,
            joinedAt: Date.now(),
            theme: 'dark',
            lastActive: Date.now()
        };
        
        users.set(socket.id, user);
        socketToUser.set(socket.id, user);
        onlineUsers.set(socket.id, user);
        
        socket.emit('registerSuccess', {
            user: user,
            history: chatHistory.slice(-50),
            onlineUsers: Array.from(onlineUsers.values())
        });
        
        io.emit('userJoined', user);
        io.emit('onlineUsersUpdate', Array.from(onlineUsers.values()));
        console.log('👤 Kullanıcı:', username);
    });

    // ======== 2. MESAJ GÖNDER ========
    socket.on('sendMessage', (data) => {
        const user = socketToUser.get(socket.id);
        if (!user) return;
        
        if (data.message.includes('🚨')) {
            chatHistory.length = 0;
            io.emit('chatCleared', { 
                clearedBy: user.username,
                timestamp: Date.now()
            });
            console.log('🧹 Sohbet temizlendi:', user.username);
            return;
        }
        
        const message = {
            id: Date.now() + '-' + Math.random().toString(36).substr(2, 9),
            username: user.username,
            avatar: user.avatar,
            message: data.message,
            timestamp: Date.now(),
            type: 'text',
            isAdmin: user.isAdmin || false,
            reactions: [],
            replies: [],
            edited: false,
            deleted: false
        };
        
        chatHistory.push(message);
        if (chatHistory.length > MAX_HISTORY) {
            chatHistory.shift();
        }
        
        io.emit('newMessage', message);
    });

    // ======== 3. DOSYA MESAJI ========
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
            isAdmin: user.isAdmin || false,
            reactions: [],
            replies: [],
            edited: false,
            deleted: false
        };
        
        chatHistory.push(message);
        if (chatHistory.length > MAX_HISTORY) {
            chatHistory.shift();
        }
        
        io.emit('newMessage', message);
    });

    // ======== 4. SES MESAJI ========
    socket.on('sendVoice', (data) => {
        const user = socketToUser.get(socket.id);
        if (!user) return;
        
        const voiceData = data.voiceData;
        const duration = data.duration || 0;
        const filename = `voice_${Date.now()}.webm`;
        const filepath = path.join(__dirname, 'uploads', filename);
        
        try {
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
                isAdmin: user.isAdmin || false,
                reactions: [],
                replies: [],
                edited: false,
                deleted: false
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

    // ======== 5. MESAJ DÜZENLE ========
    socket.on('editMessage', (data) => {
        const user = socketToUser.get(socket.id);
        if (!user) return;
        
        const msgIndex = chatHistory.findIndex(m => m.id === data.messageId);
        if (msgIndex === -1) return;
        
        const msg = chatHistory[msgIndex];
        if (msg.username !== user.username && !user.isAdmin) return;
        
        msg.message = data.newMessage;
        msg.edited = true;
        msg.editedAt = Date.now();
        
        io.emit('messageEdited', {
            messageId: data.messageId,
            newMessage: data.newMessage,
            editedAt: msg.editedAt
        });
    });

    // ======== 6. MESAJ SİL ========
    socket.on('deleteMessage', (data) => {
        const user = socketToUser.get(socket.id);
        if (!user) return;
        
        const msgIndex = chatHistory.findIndex(m => m.id === data.messageId);
        if (msgIndex === -1) return;
        
        const msg = chatHistory[msgIndex];
        if (msg.username !== user.username && !user.isAdmin) return;
        
        msg.deleted = true;
        msg.message = 'Bu mesaj silindi';
        
        io.emit('messageDeleted', {
            messageId: data.messageId,
            deletedAt: Date.now()
        });
    });

    // ======== 7. MESAJ YANITLA ========
    socket.on('replyMessage', (data) => {
        const user = socketToUser.get(socket.id);
        if (!user) return;
        
        const originalMsg = chatHistory.find(m => m.id === data.messageId);
        if (!originalMsg) return;
        
        const reply = {
            id: Date.now() + '-' + Math.random().toString(36).substr(2, 9),
            username: user.username,
            avatar: user.avatar,
            message: data.replyMessage,
            timestamp: Date.now(),
            type: 'text',
            isAdmin: user.isAdmin || false,
            replyTo: {
                id: originalMsg.id,
                username: originalMsg.username,
                message: originalMsg.message
            },
            reactions: [],
            replies: [],
            edited: false,
            deleted: false
        };
        
        chatHistory.push(reply);
        if (chatHistory.length > MAX_HISTORY) {
            chatHistory.shift();
        }
        
        io.emit('newMessage', reply);
    });

    // ======== 8. TEPKİ EKLE ========
    socket.on('addReaction', (data) => {
        const user = socketToUser.get(socket.id);
        if (!user) return;
        
        const msg = chatHistory.find(m => m.id === data.messageId);
        if (!msg) return;
        
        const existingReaction = msg.reactions.find(r => r.username === user.username && r.emoji === data.emoji);
        if (existingReaction) {
            msg.reactions = msg.reactions.filter(r => !(r.username === user.username && r.emoji === data.emoji));
        } else {
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

    // ======== 9. ÇIKARTMA OLUŞTUR ========
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
            isAdmin: user.isAdmin || false,
            reactions: [],
            replies: [],
            edited: false,
            deleted: false
        };
        
        chatHistory.push(message);
        if (chatHistory.length > MAX_HISTORY) {
            chatHistory.shift();
        }
        
        io.emit('newMessage', message);
    });

    // ======== 10. GIF ARA ========
    socket.on('searchGif', (data) => {
        const gifs = [
            'https://media.giphy.com/media/3o7abKhOpu0N9H8l8Y/giphy.gif',
            'https://media.giphy.com/media/l0HlNQ3J5J4Nl7Ff6/giphy.gif',
            'https://media.giphy.com/media/3o6Zt481isNVuQI1l6/giphy.gif'
        ];
        
        const searchTerm = data.searchTerm?.toLowerCase() || '';
        let results = gifs;
        if (searchTerm) {
            results = gifs.filter(gif => gif.toLowerCase().includes(searchTerm));
        }
        
        socket.emit('gifResults', {
            results: results.slice(0, 20),
            searchTerm: searchTerm
        });
    });

    // ======== 11. TEMA DEĞİŞTİR ========
    socket.on('changeTheme', (data) => {
        const user = socketToUser.get(socket.id);
        if (!user) return;
        user.theme = data.theme;
        socket.emit('themeChanged', { theme: data.theme });
    });

    // ======== 12. YAZIYOR BİLDİRİMİ ========
    socket.on('typing', (data) => {
        const user = socketToUser.get(socket.id);
        if (!user) return;
        socket.broadcast.emit('userTyping', {
            username: user.username,
            isTyping: data.isTyping
        });
    });

    // ======== 13. KULLANICI GÜNCELLE ========
    socket.on('updateUser', (data) => {
        const user = socketToUser.get(socket.id);
        if (!user) return;
        
        if (data.username) {
            let nameTaken = false;
            for (const [id, u] of users) {
                if (u.username.toLowerCase() === data.username.toLowerCase() && id !== socket.id) {
                    nameTaken = true;
                    break;
                }
            }
            if (!nameTaken) {
                user.username = data.username;
            } else {
                socket.emit('error', 'Bu kullanıcı adı zaten kullanılıyor!');
                return;
            }
        }
        if (data.avatar) user.avatar = data.avatar;
        
        io.emit('userUpdated', user);
        io.emit('onlineUsersUpdate', Array.from(onlineUsers.values()));
    });

    // ======== 14. ÖZEL MESAJ ========
    socket.on('privateMessage', (data) => {
        const user = socketToUser.get(socket.id);
        if (!user) return;
        
        let targetId = null;
        for (const [id, u] of users) {
            if (u.username === data.targetUsername) {
                targetId = id;
                break;
            }
        }
        
        if (targetId) {
            const targetSocket = io.sockets.sockets.get(targetId);
            if (targetSocket) {
                targetSocket.emit('privateMessage', {
                    from: user.username,
                    avatar: user.avatar,
                    message: data.message,
                    timestamp: Date.now()
                });
                socket.emit('privateMessageSent', {
                    to: data.targetUsername,
                    message: data.message
                });
            } else {
                socket.emit('error', 'Kullanıcı çevrimiçi değil!');
            }
        } else {
            socket.emit('error', 'Kullanıcı bulunamadı!');
        }
    });

    // ======== 15. PİNG ========
    socket.on('ping', () => {
        socket.emit('pong');
        const user = socketToUser.get(socket.id);
        if (user) {
            user.lastActive = Date.now();
        }
    });

    // ======== 16. BAĞLANTI KESİL ========
    socket.on('disconnect', () => {
        console.log('❌ Bağlantı koptu:', socket.id);
        const user = socketToUser.get(socket.id);
        if (user) {
            onlineUsers.delete(socket.id);
            io.emit('userLeft', user);
            io.emit('onlineUsersUpdate', Array.from(onlineUsers.values()));
            socketToUser.delete(socket.id);
        }
        users.delete(socket.id);
    });
});

// ============ SERVER BAŞLAT ============
http.listen(PORT, () => {
    console.log(`🚀 Sunucu: http://localhost:${PORT}`);
    console.log(`💬 Sohbet Uygulaması Aktif`);
    console.log(`👥 Toplam kullanıcı: ${users.size}`);
    console.log(`🟢 Çevrimiçi: ${onlineUsers.size}`);
    console.log(`📝 Mesaj geçmişi: ${chatHistory.length}`);
});
