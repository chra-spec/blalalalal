import express from 'express';
import cors from 'cors';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ============ ANİME ARA (AniList GraphQL) ============
app.get('/api/anime/search', async (req, res) => {
    try {
        const { q, limit = 12 } = req.query;
        if (!q || q.trim().length < 2) {
            return res.json({ results: [] });
        }

        const response = await fetch('https://graphql.anilist.co', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                query: `query ($search: String, $perPage: Int) {
                    Page(perPage: $perPage) {
                        media(search: $search, type: ANIME, sort: POPULARITY_DESC) {
                            id
                            title { romaji english }
                            episodes
                            format
                            seasonYear
                            coverImage { large }
                        }
                    }
                }`,
                variables: { search: q.trim(), perPage: parseInt(limit) }
            })
        });

        const data = await response.json();
        const media = data?.data?.Page?.media || [];

        res.json({
            results: media.map(m => ({
                id: m.id,
                title: m.title.english || m.title.romaji,
                titleRomaji: m.title.romaji,
                episodes: m.episodes || 0,
                format: m.format || 'TV',
                year: m.seasonYear || '',
                poster: m.coverImage?.large || ''
            }))
        });
    } catch (e) {
        console.error('Arama hatası:', e);
        res.json({ results: [], error: e.message });
    }
});

// ============ ANİME VİDEO LİNKİ (aniplay) ============
app.get('/api/anime/stream', async (req, res) => {
    try {
        const { id, ep, server = 'hd1', mode = 'sub' } = req.query;
        if (!id || !ep) {
            return res.json({ error: 'id ve ep gerekli' });
        }

        // aniplay ESM modülü — dinamik import
        const aniplayModule = await import('aniplay');
        const hd = aniplayModule.default;

        const serverMap = {
            hd1: 'fetchHD1Stream',
            hd2: 'fetchHD2Stream',
            hd3: 'fetchHD3Stream',
            hd4: 'fetchHD4Stream',
            hd5: 'fetchHD5Stream',
            hd6: 'fetchHD6Stream'
        };

        const fnName = serverMap[server] || 'fetchHD1Stream';

        let url = null;
        let usedServer = fnName;

        // İstenen server'ı dene
        try {
            url = await hd[fnName](id.toString(), ep.toString(), mode);
        } catch (e) {
            console.error(`${fnName} hatası:`, e.message);
        }

        // Başarısızsa sırayla diğerlerini dene
        if (!url) {
            for (const [key, fn] of Object.entries(serverMap)) {
                if (fn === fnName) continue;
                try {
                    url = await hd[fn](id.toString(), ep.toString(), mode);
                    if (url) {
                        usedServer = fn;
                        console.log(`Yedek server kullanıldı: ${fn}`);
                        break;
                    }
                } catch (e) {}
            }
        }

        if (!url) {
            return res.json({ error: 'Hiçbir kaynakta video bulunamadı' });
        }

        res.json({ url, server: usedServer, mode, episode: ep });
    } catch (e) {
        console.error('Stream hatası:', e);
        res.json({ error: e.message });
    }
});

app.listen(PORT, () => {
    console.log(`🚀 Anime test sunucusu ${PORT} portunda çalışıyor`);
    console.log(`🌐 Tarayıcıda aç: http://localhost:${PORT}`);
});
