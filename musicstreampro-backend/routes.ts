import type { Express } from "express";
import { createServer, type Server } from "http";
import { storage } from "./storage";
import axios from "axios";
import NodeCache from "node-cache";
import { setupAuth } from "./auth";

// Create cache with 15 minute TTL
const searchCache = new NodeCache({ stdTTL: 900 });

export async function registerRoutes(app: Express): Promise<Server> {
  // Configurar autenticação
  setupAuth(app);

  // Keep-alive endpoint
  app.get("/api/ping", (req, res) => {
    res.json({ 
      status: 'alive', 
      timestamp: new Date().toISOString(),
      uptime: process.uptime(),
      message: 'MusicStreamPro está ativo!'
    });
  });

  // Analytics endpoints
  app.post("/api/analytics/track", async (req, res) => {
    try {
      const { eventType, metadata } = req.body;
      
      const analyticsData = {
        eventType,
        userAgent: req.get('User-Agent') || 'unknown',
        ipAddress: req.ip || req.connection.remoteAddress || 'unknown',
        userId: req.user?.id || null,
        metadata: metadata ? JSON.stringify(metadata) : null,
        createdAt: new Date().toISOString(),
      };

      await storage.trackEvent(analyticsData);
      res.json({ success: true });
    } catch (error) {
      console.error('Analytics tracking error:', error);
      res.status(500).json({ message: "Erro ao registrar evento" });
    }
  });

  app.get("/api/analytics/summary", async (req, res) => {
    try {
      // Verificar se é admin
      if (!req.user || req.user.username !== 'admin') {
        return res.status(403).json({ message: "Acesso negado. Apenas admin pode ver analytics." });
      }

      const summary = await storage.getAnalyticsSummary();
      res.json(summary);
    } catch (error) {
      console.error('Analytics summary error:', error);
      res.status(500).json({ message: "Erro ao buscar analytics" });
    }
  });

  app.get("/api/analytics/events", async (req, res) => {
    try {
      // Verificar se é admin
      if (!req.user || req.user.username !== 'admin') {
        return res.status(403).json({ message: "Acesso negado. Apenas admin pode ver analytics." });
      }

      const events = await storage.getAnalytics();
      res.json(events);
    } catch (error) {
      console.error('Analytics events error:', error);
      res.status(500).json({ message: "Erro ao buscar eventos" });
    }
  });

  // API routes for YouTube Search (com web scraper + cache no banco)
  app.get("/api/search", async (req, res) => {
    try {
      const { q, maxResults = 15 } = req.query;
      
      if (!q || typeof q !== 'string') {
        return res.status(400).json({ message: "Query parameter 'q' is required" });
      }
      
      let limit = 15;
      if (typeof maxResults === 'string') {
        const parsed = parseInt(maxResults);
        limit = isNaN(parsed) || parsed <= 0 ? 15 : Math.min(parsed, 20);
      } else if (typeof maxResults === 'number') {
        limit = Math.min(Math.max(maxResults, 1), 20);
      }
      
      // Track search event
      if (req.user) {
        await storage.trackEvent({
          eventType: "search",
          userId: req.user.id,
          userAgent: req.headers['user-agent'],
          ipAddress: req.ip,
          metadata: JSON.stringify({ query: q }),
          createdAt: new Date().toISOString()
        });
      }

      console.log(`🔍 Buscando: ${q} - Executando web scraper...`);
      
      // Executar Web Scraper do YouTube para obter múltiplos resultados
      const { scrapeYouTubeSearch } = await import('./youtube-scraper');
      const videos = await scrapeYouTubeSearch(q, limit);
      
      if (videos.length === 0) {
        return res.status(404).json({ 
          message: "Nenhum vídeo encontrado para esta busca",
          query: q,
          data: []
        });
      }
      
      // Salvar o primeiro resultado no cache (para busca rápida futura)
      if (videos.length > 0) {
        try {
          await storage.saveToCache({
            query: q,
            youtubeId: videos[0].videoId,
            title: videos[0].title,
            thumbnail: videos[0].thumbnail,
            channelTitle: videos[0].channelTitle,
            duration: videos[0].duration || null,
            createdAt: new Date().toISOString()
          });
          console.log(`💾 Salvo no cache: ${q} -> ${videos[0].videoId}`);
        } catch (cacheError) {
          console.warn('Erro ao salvar no cache (não crítico):', cacheError);
        }
      }
      
      // Retornar todos os resultados
      return res.json({
        query: q,
        total: videos.length,
        data: videos.map(video => ({
          videoId: video.videoId,
          title: video.title,
          thumbnail: video.thumbnail,
          channelTitle: video.channelTitle,
          duration: video.duration
        })),
        source: 'scraper'
      });
    } catch (error) {
      console.error('Error searching YouTube:', error);
      return res.status(500).json({ message: 'Erro ao buscar no YouTube' });
    }
  });

  // Get track details
  app.get("/api/tracks/:id", async (req, res) => {
    try {
      const { id } = req.params;
      
      if (!id) {
        return res.status(400).json({ message: "Track ID is required" });
      }
      
      // Create a cache key
      const cacheKey = `track:${id}`;
      
      // Check if we have cached results
      const cachedResults = searchCache.get(cacheKey);
      if (cachedResults) {
        return res.json(cachedResults);
      }
      
      // Make request to Deezer API
      const response = await axios.get(`https://api.deezer.com/track/${id}`);
      
      // Transform Deezer response
      const trackData = {
        id: response.data.id,
        title: response.data.title,
        artist: response.data.artist.name,
        album: response.data.album.title,
        duration: response.data.duration,
        preview: response.data.preview,
        cover: response.data.album.cover_medium,
        coverSmall: response.data.album.cover_small,
        coverBig: response.data.album.cover_big
      };
      
      // Cache the results
      searchCache.set(cacheKey, trackData);
      
      return res.json(trackData);
    } catch (error) {
      console.error('Error fetching track details:', error);
      if (axios.isAxiosError(error) && error.response) {
        return res.status(error.response.status).json({ message: error.response.data.error?.message || 'Error fetching track details' });
      }
      return res.status(500).json({ message: 'Error fetching track details' });
    }
  });

  // Playlists CRUD
  app.post("/api/playlists", async (req, res) => {
    try {
      const { name, userId } = req.body;
      
      if (!name) {
        return res.status(400).json({ message: "Playlist name is required" });
      }
      
      const playlist = await storage.createPlaylist({
        name,
        userId,
        createdAt: new Date().toISOString()
      });
      
      return res.status(201).json(playlist);
    } catch (error) {
      console.error('Error creating playlist:', error);
      return res.status(500).json({ message: 'Error creating playlist' });
    }
  });

  app.get("/api/playlists", async (req, res) => {
    try {
      const playlists = await storage.getAllPlaylists();
      return res.json(playlists);
    } catch (error) {
      console.error('Error fetching playlists:', error);
      return res.status(500).json({ message: 'Error fetching playlists' });
    }
  });

  app.get("/api/playlists/:id", async (req, res) => {
    try {
      const { id } = req.params;
      const playlistId = parseInt(id);
      
      if (isNaN(playlistId)) {
        return res.status(400).json({ message: "Invalid playlist ID" });
      }
      
      const playlist = await storage.getPlaylist(playlistId);
      
      if (!playlist) {
        return res.status(404).json({ message: "Playlist not found" });
      }
      
      const tracks = await storage.getTracksByPlaylist(playlistId);
      
      return res.json({ ...playlist, tracks });
    } catch (error) {
      console.error('Error fetching playlist:', error);
      return res.status(500).json({ message: 'Error fetching playlist' });
    }
  });

  // Tracks CRUD
  app.post("/api/tracks", async (req, res) => {
    try {
      const { videoId, title, thumbnail, channelTitle, duration, playlistId } = req.body;
      
      if (!videoId || !title || !playlistId) {
        return res.status(400).json({ message: "videoId, title, and playlistId are required" });
      }
      
      const track = await storage.addTrackToPlaylist({
        videoId,
        title,
        thumbnail,
        channelTitle,
        duration,
        playlistId
      });
      
      return res.status(201).json(track);
    } catch (error) {
      console.error('Error adding track to playlist:', error);
      return res.status(500).json({ message: 'Error adding track to playlist' });
    }
  });

  app.delete("/api/tracks/:id", async (req, res) => {
    try {
      const { id } = req.params;
      const trackId = parseInt(id);
      
      if (isNaN(trackId)) {
        return res.status(400).json({ message: "Invalid track ID" });
      }
      
      await storage.removeTrack(trackId);
      
      return res.status(204).send();
    } catch (error) {
      console.error('Error removing track:', error);
      return res.status(500).json({ message: 'Error removing track' });
    }
  });

  const httpServer = createServer(app);
  return httpServer;
}
