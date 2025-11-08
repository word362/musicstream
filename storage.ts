import { users, type User, type InsertUser, type UpdateProfile } from "@shared/schema";
import { playlists, type Playlist, type InsertPlaylist } from "@shared/schema";
import { tracks, type Track, type InsertTrack } from "@shared/schema";
import { analytics, type Analytics, type InsertAnalytics } from "@shared/schema";
import { musicCache, type MusicCache, type InsertMusicCache } from "@shared/schema";
import session from "express-session";
import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import connectPg from "connect-pg-simple";
import createMemoryStore from "memorystore";

const MemoryStore = createMemoryStore(session);
const PostgresSessionStore = connectPg(session);

export interface IStorage {
  // User methods
  getUser(id: number): Promise<User | undefined>;
  getUserByUsername(username: string): Promise<User | undefined>;
  createUser(user: InsertUser): Promise<User>;
  updateUser(id: number, updates: UpdateProfile): Promise<User | undefined>;
  
  // Playlist methods
  createPlaylist(playlist: InsertPlaylist): Promise<Playlist>;
  getPlaylist(id: number): Promise<Playlist | undefined>;
  getAllPlaylists(): Promise<Playlist[]>;
  getPlaylistsByUser(userId: number): Promise<Playlist[]>;
  updatePlaylist(id: number, playlist: Partial<InsertPlaylist>): Promise<Playlist | undefined>;
  deletePlaylist(id: number): Promise<void>;
  
  // Track methods
  addTrackToPlaylist(track: InsertTrack): Promise<Track>;
  removeTrack(id: number): Promise<void>;
  getTracksByPlaylist(playlistId: number): Promise<Track[]>;
  
  // Analytics methods
  trackEvent(event: InsertAnalytics): Promise<Analytics>;
  getAnalytics(): Promise<Analytics[]>;
  getAnalyticsSummary(): Promise<{
    totalPageViews: number;
    totalUsers: number;
    totalLogins: number;
    todayViews: number;
  }>;
  
  // Music Cache methods (para web scraper do YouTube)
  getFromCache(query: string): Promise<MusicCache | undefined>;
  saveToCache(data: InsertMusicCache): Promise<MusicCache>;
  
  // Session store
  sessionStore: session.Store;
}

class MemStorage implements IStorage {
  private users: Map<number, User>;
  private playlists: Map<number, Playlist>;
  private tracks: Map<number, Track>;
  private analyticsEvents: Map<number, Analytics>;
  private musicCacheMap: Map<string, MusicCache>;
  private userIdCounter: number;
  private playlistIdCounter: number;
  private trackIdCounter: number;
  private analyticsIdCounter: number;
  private cacheIdCounter: number;
  public sessionStore: session.Store;

  constructor() {
    this.users = new Map();
    this.playlists = new Map();
    this.tracks = new Map();
    this.analyticsEvents = new Map();
    this.musicCacheMap = new Map();
    this.userIdCounter = 1;
    this.playlistIdCounter = 1;
    this.trackIdCounter = 1;
    this.analyticsIdCounter = 1;
    this.cacheIdCounter = 1;
    this.sessionStore = new MemoryStore({
      checkPeriod: 86400000 // prune expired entries every 24h
    });
    
    // Add some default playlists
    this.createPlaylist({
      name: "Favorite Tracks",
      userId: null,
      createdAt: new Date().toISOString()
    });
    
    this.createPlaylist({
      name: "Workout Mix",
      userId: null,
      createdAt: new Date().toISOString()
    });
    
    this.createPlaylist({
      name: "Chill Vibes",
      userId: null,
      createdAt: new Date().toISOString()
    });

    // Criar usuário admin padrão (senha: admin123)
    this.createUser({
      username: "admin",
      password: "3ba6f35a8e11acecc25b37619de141d7b3f4794e9a7d191a18f6239f2a3edd61750997c929cc0e56aa8ecab8a27240d4141110b906731f0a3653df8d674f970e.106a83ab698b820f82fe283e8ecb53a7",
    });
  }

  // User methods
  async getUser(id: number): Promise<User | undefined> {
    return this.users.get(id);
  }

  async getUserByUsername(username: string): Promise<User | undefined> {
    return Array.from(this.users.values()).find(
      (user) => user.username === username,
    );
  }

  async createUser(insertUser: InsertUser): Promise<User> {
    const id = this.userIdCounter++;
    const user: User = { 
      ...insertUser, 
      id,
      displayName: null,
      bio: null,
      avatar: null
    };
    this.users.set(id, user);
    return user;
  }

  async updateUser(id: number, updates: UpdateProfile): Promise<User | undefined> {
    const user = this.users.get(id);
    if (!user) return undefined;
    
    // Check if trying to update username to one that already exists
    if (updates.username && updates.username !== user.username) {
      const existingUser = await this.getUserByUsername(updates.username);
      if (existingUser) {
        throw new Error("Username already taken");
      }
    }
    
    const updatedUser: User = {
      ...user,
      ...(updates.username && { username: updates.username }),
      ...(updates.displayName !== undefined && { displayName: updates.displayName }),
      ...(updates.bio !== undefined && { bio: updates.bio }),
      ...(updates.avatar !== undefined && { avatar: updates.avatar }),
    };
    
    this.users.set(id, updatedUser);
    return updatedUser;
  }

  // Playlist methods
  async createPlaylist(insertPlaylist: InsertPlaylist): Promise<Playlist> {
    const id = this.playlistIdCounter++;
    const playlist: Playlist = { 
      id,
      name: insertPlaylist.name,
      userId: insertPlaylist.userId ?? null,
      createdAt: insertPlaylist.createdAt
    };
    this.playlists.set(id, playlist);
    return playlist;
  }

  async getPlaylist(id: number): Promise<Playlist | undefined> {
    return this.playlists.get(id);
  }

  async getAllPlaylists(): Promise<Playlist[]> {
    return Array.from(this.playlists.values());
  }
  
  async getPlaylistsByUser(userId: number): Promise<Playlist[]> {
    return Array.from(this.playlists.values()).filter(
      (playlist) => playlist.userId === userId
    );
  }

  async updatePlaylist(id: number, playlistData: Partial<InsertPlaylist>): Promise<Playlist | undefined> {
    const playlist = this.playlists.get(id);
    if (!playlist) return undefined;
    
    const updatedPlaylist = { ...playlist, ...playlistData };
    this.playlists.set(id, updatedPlaylist);
    return updatedPlaylist;
  }

  async deletePlaylist(id: number): Promise<void> {
    this.playlists.delete(id);
    // Also remove all tracks from this playlist
    const tracksToDelete: number[] = [];
    this.tracks.forEach((track, trackId) => {
      if (track.playlistId === id) {
        tracksToDelete.push(trackId);
      }
    });
    tracksToDelete.forEach(trackId => this.tracks.delete(trackId));
  }

  // Track methods
  async addTrackToPlaylist(insertTrack: InsertTrack): Promise<Track> {
    const id = this.trackIdCounter++;
    const track: Track = {
      id,
      videoId: insertTrack.videoId,
      title: insertTrack.title,
      thumbnail: insertTrack.thumbnail ?? null,
      channelTitle: insertTrack.channelTitle ?? null,
      duration: insertTrack.duration ?? null,
      playlistId: insertTrack.playlistId ?? null
    };
    this.tracks.set(id, track);
    return track;
  }

  async removeTrack(id: number): Promise<void> {
    this.tracks.delete(id);
  }

  async getTracksByPlaylist(playlistId: number): Promise<Track[]> {
    return Array.from(this.tracks.values()).filter(
      (track) => track.playlistId === playlistId
    );
  }

  // Analytics methods
  async trackEvent(insertAnalytics: InsertAnalytics): Promise<Analytics> {
    const id = this.analyticsIdCounter++;
    const analytics: Analytics = {
      id,
      userId: insertAnalytics.userId ?? null,
      createdAt: insertAnalytics.createdAt,
      eventType: insertAnalytics.eventType,
      userAgent: insertAnalytics.userAgent ?? null,
      ipAddress: insertAnalytics.ipAddress ?? null,
      metadata: insertAnalytics.metadata ?? null
    };
    this.analyticsEvents.set(id, analytics);
    return analytics;
  }

  async getAnalytics(): Promise<Analytics[]> {
    return Array.from(this.analyticsEvents.values()).sort((a, b) => 
      new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()
    );
  }

  async getAnalyticsSummary(): Promise<{
    totalPageViews: number;
    totalUsers: number;
    totalLogins: number;
    todayViews: number;
    totalSearches: number;
    todaySearches: number;
  }> {
    const events = Array.from(this.analyticsEvents.values());
    const today = new Date().toISOString().split('T')[0];
    
    return {
      totalPageViews: events.filter(e => e.eventType === 'page_view').length,
      totalUsers: this.users.size,
      totalLogins: events.filter(e => e.eventType === 'user_login').length,
      todayViews: events.filter(e => 
        e.eventType === 'page_view' && 
        e.createdAt.startsWith(today)
      ).length,
      totalSearches: events.filter(e => e.eventType === 'search').length,
      todaySearches: events.filter(e => 
        e.eventType === 'search' && 
        e.createdAt.startsWith(today)
      ).length,
    };
  }

  // Music Cache methods
  async getFromCache(query: string): Promise<MusicCache | undefined> {
    const normalizedQuery = query.toLowerCase().trim();
    return this.musicCacheMap.get(normalizedQuery);
  }

  async saveToCache(insertCache: InsertMusicCache): Promise<MusicCache> {
    const normalizedQuery = insertCache.query.toLowerCase().trim();
    const id = this.cacheIdCounter++;
    const cache: MusicCache = {
      id,
      query: normalizedQuery,
      youtubeId: insertCache.youtubeId,
      title: insertCache.title ?? null,
      thumbnail: insertCache.thumbnail ?? null,
      channelTitle: insertCache.channelTitle ?? null,
      duration: insertCache.duration ?? null,
      createdAt: insertCache.createdAt
    };
    this.musicCacheMap.set(normalizedQuery, cache);
    return cache;
  }
}

import { DatabaseStorage } from "./database-storage";

// Use MemStorage as fallback when DATABASE_URL is not available
// This allows the app to function fully during database provisioning
if (!process.env.DATABASE_URL) {
  console.warn('⚠️  DATABASE_URL not available - using in-memory storage as fallback');
  console.warn('   Data will not persist across server restarts until database is provisioned');
}

export const storage = process.env.DATABASE_URL 
  ? new DatabaseStorage() 
  : new MemStorage();

// Keep MemStorage export for backwards compatibility
export { MemStorage };
