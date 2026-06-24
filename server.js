const express = require('express');
const app = express();
const http = require('http').createServer(app);
const io = require('socket.io')(http);
const crypto = require('crypto');

const PORT = process.env.PORT || 3000;

// ============ VERİ DEPOLARI ============
const games = new Map();
const players = new Map();
const socketToPlayer = new Map();
const matchmakingQueue = [];

// ============ MIDDLEWARE ============
app.use(express.static(__dirname));
app.get('*', (req, res) => res.sendFile(__dirname + '/index.html'));

// ============ KART SİSTEMİ ============
const CARD_TYPES = {
    WARRIOR: 'warrior',
    ARCHER: 'archer',
    MAGE: 'mage',
    HEALER: 'healer',
    DRAGON: 'dragon',
    KNIGHT: 'knight',
    ASSASSIN: 'assassin',
    QUEEN: 'queen'
};

const CARD_DATA = {
    warrior: { name: '⚔️ Savaşçı', attack: 8, defense: 6, health: 10, cost: 2, emoji: '⚔️', description: 'Güçlü saldırı' },
    archer: { name: '🏹 Okçu', attack: 6, defense: 4, health: 8, cost: 1, emoji: '🏹', description: 'Uzun menzilli' },
    mage: { name: '🔮 Büyücü', attack: 10, defense: 3, health: 6, cost: 3, emoji: '🔮', description: 'Yüksek hasar' },
    healer: { name: '💚 Şifacı', attack: 2, defense: 5, health: 8, cost: 2, emoji: '💚', description: 'Can yeniler' },
    dragon: { name: '🐉 Ejderha', attack: 12, defense: 8, health: 15, cost: 5, emoji: '🐉', description: 'En güçlü' },
    knight: { name: '🛡️ Şövalye', attack: 7, defense: 9, health: 12, cost: 3, emoji: '🛡️', description: 'Yüksek savunma' },
    assassin: { name: '🗡️ Suikastçı', attack: 9, defense: 3, health: 6, cost: 2, emoji: '🗡️', description: 'Kritik vuruş' },
    queen: { name: '👑 Kraliçe', attack: 15, defense: 10, health: 20, cost: 7, emoji: '👑', description: 'Kraliçe! Kazanmak için onu koru!' }
};

// ============ YARDIMCI FONKSİYONLAR ============
function generateGameCode() {
    return Math.floor(100000 + Math.random() * 900000).toString();
}

function shuffleArray(array) {
    for (let i = array.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [array[i], array[j]] = [array[j], array[i]];
    }
    return array;
}

function createDeck() {
    const deck = [];
    const cardTypes = Object.keys(CARD_TYPES);
    
    // Her karttan 2 tane ekle (Kraliçe hariç)
    cardTypes.forEach(type => {
        if (type !== 'QUEEN') {
            for (let i = 0; i < 2; i++) {
                deck.push({ ...CARD_DATA[type], type: type, id: crypto.randomUUID() });
            }
        }
    });
    
    // 1 Kraliçe ekle
    deck.push({ ...CARD_DATA.queen, type: 'queen', id: crypto.randomUUID() });
    
    return shuffleArray(deck);
}

function getPlayerCards(deck, count = 5) {
    const hand = [];
    for (let i = 0; i < Math.min(count, deck.length); i++) {
        hand.push(deck.pop());
    }
    return hand;
}

function calculateDamage(attacker, defender) {
    const baseDamage = attacker.attack;
    const defenseReduction = defender.defense * 0.3;
    const damage = Math.max(1, Math.floor(baseDamage - defenseReduction + (Math.random() * 3 - 1)));
    return damage;
}

function checkWinner(game) {
    const players = game.players;
    const player1 = players[0];
    const player2 = players[1];
    
    // Kraliçe öldü mü?
    if (player1.queenHealth <= 0) return player2.username;
    if (player2.queenHealth <= 0) return player1.username;
    
    // Tüm kartlar bitti mi?
    if (player1.hand.length === 0 && player1.deck.length === 0) return player2.username;
    if (player2.hand.length === 0 && player2.deck.length === 0) return player1.username;
    
    return null;
}

function getAvatarColor(username) {
    const colors = ['#667eea', '#764ba2', '#f093fb', '#f5576c', '#4facfe', '#00f2fe', '#ffd700', '#ff6b6b'];
    const hash = username.split('').reduce((acc, char) => acc + char.charCodeAt(0), 0);
    return colors[hash % colors.length];
}

// ============ SOCKET.IO ============
io.on('connection', (socket) => {
    console.log('✅ Yeni bağlantı:', socket.id);

    // ======== 1. KULLANICI KAYDI ========
    socket.on('register', (data) => {
        const username = data.username?.trim();
        
        if (!username || username.length < 2 || username.length > 15) {
            socket.emit('registerError', 'Kullanıcı adı 2-15 karakter olmalı!');
            return;
        }
        
        // Kullanıcı zaten var mı?
        if (players.has(username.toLowerCase())) {
            socket.emit('registerError', 'Bu kullanıcı adı zaten kullanılıyor!');
            return;
        }
        
        const player = {
            id: socket.id,
            username: username,
            avatarColor: getAvatarColor(username),
            joinedAt: Date.now(),
            stats: {
                wins: 0,
                losses: 0,
                draws: 0,
                gamesPlayed: 0
            }
        };
        
        players.set(username.toLowerCase(), player);
        socketToPlayer.set(socket.id, player);
        
        socket.emit('registerSuccess', {
            username: username,
            avatarColor: player.avatarColor,
            stats: player.stats
        });
        
        console.log('👤 Yeni oyuncu:', username);
    });

    // ======== 2. EŞLEŞME (MATCHMAKING) ========
    socket.on('findMatch', () => {
        const player = socketToPlayer.get(socket.id);
        if (!player) {
            socket.emit('error', 'Önce kaydolmalısınız!');
            return;
        }
        
        // Zaten eşleşme kuyruğunda mı?
        if (matchmakingQueue.includes(socket.id)) {
            socket.emit('error', 'Zaten eşleşme arıyorsunuz!');
            return;
        }
        
        // Zaten oyunda mı?
        for (const [gameId, game] of games) {
            if (game.players.some(p => p.id === socket.id)) {
                socket.emit('error', 'Zaten bir oyundasınız!');
                return;
            }
        }
        
        matchmakingQueue.push(socket.id);
        socket.emit('matchmakingStarted', { message: 'Rakip aranıyor...' });
        
        // Kuyrukta 2 kişi varsa eşleştir
        if (matchmakingQueue.length >= 2) {
            const player1Id = matchmakingQueue.shift();
            const player2Id = matchmakingQueue.shift();
            
            const player1 = socketToPlayer.get(player1Id);
            const player2 = socketToPlayer.get(player2Id);
            
            if (player1 && player2) {
                createGame(player1Id, player2Id);
            } else {
                // Eğer oyuncu bağlantısı kopmuşsa tekrar kuyruğa ekle
                if (player1Id && !socketToPlayer.has(player1Id)) {
                    socket.emit('matchmakingStarted', { message: 'Oyuncu bulundu, bağlanılıyor...' });
                }
                if (player2Id && !socketToPlayer.has(player2Id)) {
                    socket.emit('matchmakingStarted', { message: 'Oyuncu bulundu, bağlanılıyor...' });
                }
            }
        }
    });

    // ======== 3. OYUN OLUŞTUR ========
    function createGame(player1Id, player2Id) {
        const player1 = socketToPlayer.get(player1Id);
        const player2 = socketToPlayer.get(player2Id);
        
        if (!player1 || !player2) {
            if (player1Id) matchmakingQueue.push(player1Id);
            if (player2Id) matchmakingQueue.push(player2Id);
            return;
        }
        
        const gameCode = generateGameCode();
        const deck1 = createDeck();
        const deck2 = createDeck();
        
        const game = {
            code: gameCode,
            players: [
                {
                    id: player1Id,
                    username: player1.username,
                    socketId: player1Id,
                    deck: deck1,
                    hand: getPlayerCards(deck1),
                    queenHealth: 20,
                    avatarColor: player1.avatarColor,
                    isReady: false,
                    energy: 1,
                    maxEnergy: 1
                },
                {
                    id: player2Id,
                    username: player2.username,
                    socketId: player2Id,
                    deck: deck2,
                    hand: getPlayerCards(deck2),
                    queenHealth: 20,
                    avatarColor: player2.avatarColor,
                    isReady: false,
                    energy: 1,
                    maxEnergy: 1
                }
            ],
            currentTurn: player1Id,
            turnNumber: 0,
            phase: 'waiting', // waiting, playing, ended
            winner: null,
            battleLog: [],
            createdAt: Date.now()
        };
        
        games.set(gameCode, game);
        
        // Her iki oyuncuya oyun bilgilerini gönder
        const gameData = {
            gameCode: gameCode,
            players: game.players.map(p => ({
                username: p.username,
                avatarColor: p.avatarColor,
                queenHealth: p.queenHealth,
                handCount: p.hand.length,
                isReady: p.isReady
            })),
            currentTurn: game.currentTurn,
            phase: game.phase
        };
        
        io.to(player1Id).emit('gameCreated', {
            ...gameData,
            myHand: game.players[0].hand,
            myUsername: player1.username,
            myQueenHealth: game.players[0].queenHealth,
            myDeckCount: game.players[0].deck.length,
            myEnergy: game.players[0].energy,
            maxEnergy: game.players[0].maxEnergy,
            opponentUsername: player2.username
        });
        
        io.to(player2Id).emit('gameCreated', {
            ...gameData,
            myHand: game.players[1].hand,
            myUsername: player2.username,
            myQueenHealth: game.players[1].queenHealth,
            myDeckCount: game.players[1].deck.length,
            myEnergy: game.players[1].energy,
            maxEnergy: game.players[1].maxEnergy,
            opponentUsername: player1.username
        });
        
        // Her iki oyuncuyu odaya ekle
        const roomName = `game_${gameCode}`;
        io.sockets.sockets.get(player1Id)?.join(roomName);
        io.sockets.sockets.get(player2Id)?.join(roomName);
        
        console.log('🎮 Oyun oluşturuldu:', gameCode, '-', player1.username, 'vs', player2.username);
        
        // Oyun başlaması için geri sayım
        game.phase = 'waiting';
        let countdown = 5;
        const timer = setInterval(() => {
            io.to(roomName).emit('countdown', { 
                count: countdown,
                message: countdown > 0 ? `${countdown}` : 'OYUN BAŞLIYOR!'
            });
            
            if (countdown <= 0) {
                clearInterval(timer);
                startGame(gameCode);
            }
            countdown--;
        }, 1000);
    }

    // ======== 4. OYUN BAŞLAT ========
    function startGame(gameCode) {
        const game = games.get(gameCode);
        if (!game) return;
        
        game.phase = 'playing';
        game.turnNumber = 1;
        
        // İlk oyuncuyu rastgele seç
        const firstPlayer = game.players[Math.random() < 0.5 ? 0 : 1];
        game.currentTurn = firstPlayer.id;
        
        const roomName = `game_${gameCode}`;
        
        // Kartları karıştır ve el dağıt
        game.players.forEach(p => {
            p.isReady = true;
            p.energy = 1;
            p.maxEnergy = 1;
        });
        
        io.to(roomName).emit('gameStarted', {
            players: game.players.map(p => ({
                username: p.username,
                avatarColor: p.avatarColor,
                queenHealth: p.queenHealth,
                handCount: p.hand.length
            })),
            currentTurn: game.currentTurn,
            turnNumber: game.turnNumber,
            message: 'Oyun başladı!'
        });
        
        // İlk oyuncunun sırasını bildir
        const currentPlayer = game.players.find(p => p.id === game.currentTurn);
        const opponent = game.players.find(p => p.id !== game.currentTurn);
        
        io.to(roomName).emit('turnStarted', {
            username: currentPlayer.username,
            turnNumber: game.turnNumber,
            energy: currentPlayer.energy,
            maxEnergy: currentPlayer.maxEnergy,
            handSize: currentPlayer.hand.length,
            opponentHealth: opponent.queenHealth,
            myHealth: currentPlayer.queenHealth
        });
        
        console.log('🎮 Oyun başladı:', gameCode);
    }

    // ======== 5. KART OYNA ========
    socket.on('playCard', (data) => {
        const { gameCode, cardId, target } = data;
        const game = games.get(gameCode);
        if (!game) return;
        
        const player = game.players.find(p => p.id === socket.id);
        if (!player) return;
        
        if (game.phase !== 'playing') {
            socket.emit('error', 'Oyun aktif değil!');
            return;
        }
        
        if (game.currentTurn !== socket.id) {
            socket.emit('error', 'Sıra sizde değil!');
            return;
        }
        
        const cardIndex = player.hand.findIndex(c => c.id === cardId);
        if (cardIndex === -1) {
            socket.emit('error', 'Kart elinizde yok!');
            return;
        }
        
        const card = player.hand[cardIndex];
        
        // Enerji kontrolü
        if (player.energy < card.cost) {
            socket.emit('error', 'Yeterli enerjiniz yok!');
            return;
        }
        
        // Kartı oynat
        player.hand.splice(cardIndex, 1);
        player.energy -= card.cost;
        
        const opponent = game.players.find(p => p.id !== socket.id);
        const roomName = `game_${gameCode}`;
        
        // Kartın etkisini uygula
        let damage = 0;
        let healing = 0;
        let targetQueen = false;
        let message = '';
        
        if (card.type === 'healer') {
            healing = card.attack * 0.5;
            player.queenHealth = Math.min(20, player.queenHealth + healing);
            message = `${player.username} 💚 ${card.emoji} ${card.name} oynadı ve ${Math.floor(healing)} can yeniledi!`;
        } else if (card.type === 'queen') {
            targetQueen = true;
            damage = card.attack;
            opponent.queenHealth = Math.max(0, opponent.queenHealth - damage);
            message = `${player.username} 👑 KRALİÇE oynadı! ${opponent.username} ${damage} hasar aldı!`;
        } else {
            if (target === 'queen' || target === 'queen_attack') {
                damage = calculateDamage(card, { defense: 5 });
                opponent.queenHealth = Math.max(0, opponent.queenHealth - damage);
                message = `${player.username} ${card.emoji} ${card.name} ile Kraliçe'ye ${damage} hasar verdi!`;
            } else {
                // Rastgele hasar
                damage = calculateDamage(card, { defense: 3 });
                opponent.queenHealth = Math.max(0, opponent.queenHealth - damage);
                message = `${player.username} ${card.emoji} ${card.name} ile saldırdı! ${damage} hasar!`;
            }
        }
        
        // Oyun durumunu kontrol et
        const winner = checkWinner(game);
        if (winner) {
            game.phase = 'ended';
            game.winner = winner;
            
            // İstatistikleri güncelle
            const winnerPlayer = game.players.find(p => p.username === winner);
            const loserPlayer = game.players.find(p => p.username !== winner);
            
            if (winnerPlayer) {
                const winnerData = players.get(winnerPlayer.username.toLowerCase());
                if (winnerData) {
                    winnerData.stats.wins++;
                    winnerData.stats.gamesPlayed++;
                }
            }
            if (loserPlayer) {
                const loserData = players.get(loserPlayer.username.toLowerCase());
                if (loserData) {
                    loserData.stats.losses++;
                    loserData.stats.gamesPlayed++;
                }
            }
            
            io.to(roomName).emit('gameEnded', {
                winner: winner,
                players: game.players.map(p => ({
                    username: p.username,
                    queenHealth: p.queenHealth,
                    stats: players.get(p.username.toLowerCase())?.stats || { wins: 0, losses: 0 }
                })),
                message: `🏆 ${winner} kazandı!`
            });
            
            // Oyunu temizle
            setTimeout(() => {
                games.delete(gameCode);
                console.log('🗑️ Oyun temizlendi:', gameCode);
            }, 60000);
            
            return;
        }
        
        // Sırayı değiştir
        game.currentTurn = opponent.id;
        game.turnNumber++;
        
        // Yeni turda enerji yenile
        opponent.energy = Math.min(10, opponent.energy + 2);
        opponent.maxEnergy = Math.min(10, opponent.maxEnergy + 1);
        
        // Yeni kart çek
        if (opponent.deck.length > 0) {
            const newCard = opponent.deck.pop();
            opponent.hand.push(newCard);
        }
        
        // Hamle bilgilerini gönder
        io.to(roomName).emit('cardPlayed', {
            player: player.username,
            card: card,
            damage: damage,
            healing: healing,
            targetQueen: targetQueen,
            message: message,
            boardState: {
                player1Health: game.players[0].queenHealth,
                player2Health: game.players[1].queenHealth,
                player1HandCount: game.players[0].hand.length,
                player2HandCount: game.players[1].hand.length,
                player1DeckCount: game.players[0].deck.length,
                player2DeckCount: game.players[1].deck.length,
                currentTurn: game.currentTurn,
                turnNumber: game.turnNumber
            }
        });
        
        // Oyunculara özel bilgi gönder
        game.players.forEach(p => {
            const isMyTurn = p.id === game.currentTurn;
            const socketId = p.id;
            
            io.to(socketId).emit('yourTurn', {
                isMyTurn: isMyTurn,
                hand: p.hand,
                energy: p.energy,
                maxEnergy: p.maxEnergy,
                queenHealth: p.queenHealth,
                deckCount: p.deck.length,
                opponentHealth: game.players.find(op => op.id !== p.id)?.queenHealth || 0,
                turnNumber: game.turnNumber
            });
        });
    });

    // ======== 6. KART ÇEK ========
    socket.on('drawCard', (data) => {
        const { gameCode } = data;
        const game = games.get(gameCode);
        if (!game) return;
        
        const player = game.players.find(p => p.id === socket.id);
        if (!player) return;
        
        if (game.phase !== 'playing') {
            socket.emit('error', 'Oyun aktif değil!');
            return;
        }
        
        if (player.deck.length === 0) {
            socket.emit('error', 'Destede kart kalmadı!');
            return;
        }
        
        if (player.hand.length >= 7) {
            socket.emit('error', 'Eliniz dolu!');
            return;
        }
        
        const newCard = player.deck.pop();
        player.hand.push(newCard);
        
        socket.emit('cardDrawn', {
            card: newCard,
            hand: player.hand,
            deckCount: player.deck.length
        });
    });

    // ======== 7. OYUNDAN ÇIK ========
    socket.on('leaveGame', (data) => {
        const { gameCode } = data;
        const game = games.get(gameCode);
        if (!game) return;
        
        const player = game.players.find(p => p.id === socket.id);
        if (!player) return;
        
        const opponent = game.players.find(p => p.id !== socket.id);
        
        if (opponent) {
            const roomName = `game_${gameCode}`;
            io.to(roomName).emit('playerLeft', {
                username: player.username,
                message: `${player.username} oyundan ayrıldı. ${opponent.username} kazandı!`
            });
        }
        
        socket.leave(`game_${gameCode}`);
        games.delete(gameCode);
        console.log('👋 Oyundan ayrıldı:', player.username, '-', gameCode);
    });

    // ======== 8. SOYBET ========
    socket.on('sendChat', (data) => {
        const { gameCode, message } = data;
        const game = games.get(gameCode);
        if (!game) return;
        
        const player = game.players.find(p => p.id === socket.id);
        if (!player) return;
        
        const roomName = `game_${gameCode}`;
        io.to(roomName).emit('chatMessage', {
            username: player.username,
            message: message.trim(),
            timestamp: Date.now(),
            avatarColor: player.avatarColor
        });
    });

    // ======== 9. BAĞLANTI KESME ========
    socket.on('disconnect', () => {
        console.log('❌ Bağlantı koptu:', socket.id);
        
        const player = socketToPlayer.get(socket.id);
        if (player) {
            // Eşleşme kuyruğundan çıkar
            const queueIndex = matchmakingQueue.indexOf(socket.id);
            if (queueIndex !== -1) {
                matchmakingQueue.splice(queueIndex, 1);
            }
            
            // Oyunlardan çıkar
            games.forEach((game, gameCode) => {
                const playerIndex = game.players.findIndex(p => p.id === socket.id);
                if (playerIndex !== -1) {
                    const opponent = game.players.find(p => p.id !== socket.id);
                    if (opponent) {
                        const roomName = `game_${gameCode}`;
                        io.to(roomName).emit('playerLeft', {
                            username: player.username,
                            message: `${player.username} bağlantısı koptu. ${opponent.username} kazandı!`
                        });
                    }
                    games.delete(gameCode);
                }
            });
            
            socketToPlayer.delete(socket.id);
        }
    });

    // ======== 10. OYUNCU İSTATİSTİKLERİ ========
    socket.on('getStats', () => {
        const player = socketToPlayer.get(socket.id);
        if (!player) {
            socket.emit('error', 'Önce kaydolmalısınız!');
            return;
        }
        
        socket.emit('statsUpdate', {
            username: player.username,
            stats: player.stats,
            avatarColor: player.avatarColor
        });
    });

    // ======== 11. ODA KODU İLE KATIL ========
    socket.on('joinGameByCode', (data) => {
        const { gameCode } = data;
        const player = socketToPlayer.get(socket.id);
        if (!player) {
            socket.emit('error', 'Önce kaydolmalısınız!');
            return;
        }
        
        const game = games.get(gameCode);
        if (!game) {
            socket.emit('error', 'Oyun bulunamadı!');
            return;
        }
        
        if (game.players.length >= 2) {
            socket.emit('error', 'Oyun dolu!');
            return;
        }
        
        if (game.phase !== 'waiting') {
            socket.emit('error', 'Oyun başlamış!');
            return;
        }
        
        // Kullanıcıyı oyuna ekle
        const newPlayer = {
            id: socket.id,
            username: player.username,
            socketId: socket.id,
            deck: createDeck(),
            hand: [],
            queenHealth: 20,
            avatarColor: player.avatarColor,
            isReady: false,
            energy: 1,
            maxEnergy: 1
        };
        
        // Yeni oyuncunun elini oluştur
        newPlayer.hand = getPlayerCards(newPlayer.deck);
        
        game.players.push(newPlayer);
        socket.join(`game_${gameCode}`);
        
        // Diğer oyuncuya bildir
        const existingPlayer = game.players[0];
        io.to(existingPlayer.id).emit('opponentJoined', {
            username: player.username,
            avatarColor: player.avatarColor
        });
        
        // Yeni oyuncuya bilgi ver
        socket.emit('gameCreated', {
            gameCode: gameCode,
            players: game.players.map(p => ({
                username: p.username,
                avatarColor: p.avatarColor,
                queenHealth: p.queenHealth,
                handCount: p.hand.length,
                isReady: p.isReady
            })),
            currentTurn: game.currentTurn,
            phase: game.phase,
            myHand: newPlayer.hand,
            myUsername: player.username,
            myQueenHealth: newPlayer.queenHealth,
            myDeckCount: newPlayer.deck.length,
            myEnergy: newPlayer.energy,
            maxEnergy: newPlayer.maxEnergy,
            opponentUsername: existingPlayer.username
        });
        
        // Geri sayım başlat
        let countdown = 5;
        const roomName = `game_${gameCode}`;
        const timer = setInterval(() => {
            io.to(roomName).emit('countdown', {
                count: countdown,
                message: countdown > 0 ? `${countdown}` : 'OYUN BAŞLIYOR!'
            });
            
            if (countdown <= 0) {
                clearInterval(timer);
                startGame(gameCode);
            }
            countdown--;
        }, 1000);
    });
});

// ============ SERVER BAŞLAT ============
http.listen(PORT, () => {
    console.log(`🚀 Sunucu: http://localhost:${PORT}`);
    console.log(`🎮 Queen Battle - Kraliçe Savaşı`);
    console.log(`📊 ${games.size} aktif oyun, ${matchmakingQueue.length} oyuncu bekliyor`);
});
