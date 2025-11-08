import connectPg from "connect-pg-simple";
import session from "express-session";
import { eq } from "drizzle-orm";
import { 
  users, playlists, tracks, analytics, musicCache,
  type User, type InsertUser, type UpdateProfile,
  type Playlist, type InsertPlaylist, 
  type Track, type InsertTrack,
  type Analytics, type InsertAnalytics,
  type MusicCache, type InsertMusicCache
} from "@shared/schema";
import type { IStorage } from "./storage";
import { db, pool } from "./db";

const PostgresSessionStore = connectPg(session);

export class DatabaseStorage implements IStorage {
  private db = db;
  private pool = pool;
  public sessionStore: session.Store;

  constructor() {
    this.sessionStore = new PostgresSessionStore({ 
      pool: this.pool as any, 
      createTableIfMissing: true 
    });

    // Criar dados iniciais se não existirem (apenas se o database estiver disponível)
    if (this.db && this.pool) {
      this.initializeDefaultData();
    }
  }

  private async initializeDefaultData() {
    try {
      if (!this.db) {
        console.warn('Database not available, skipping default data initialization');
        return;
      }
      
      // Verificar se já existe o admin
      const existingAdmin = await this.getUserByUsername("admin");
      if (!existingAdmin) {
        // Criar usuário admin
        await this.createUser({
          username: "admin",
          password: "3ba6f35a8e11acecc25b37619de141d7b3f4794e9a7d191a18f6239f2a3edd61750997c929cc0e56aa8ecab8a27240d4141110b906731f0a3653df8d674f970e.106a83ab698b820f82fe283e8ecb53a7",
        });
      }

      // Verificar se já existem playlists padrão
      const existingPlaylists = await this.getAllPlaylists();
      if (existingPlaylists.length === 0) {
        await this.createPlaylist({
          name: "Favorite Tracks",
          userId: null,
          createdAt: new Date().toISOString()
        });
        
        await this.createPlaylist({
          name: "Workout Mix", 
          userId: null,
          createdAt: new Date().toISOString()
        });
        
        await this.createPlaylist({
          name: "Chill Vibes",
          userId: null,
          createdAt: new Date().toISOString()
        });
      }
    } catch (error) {
      console.error("Error initializing default data:", error);
    }
  }

  // User methods
  async getUser(id: number): Promise<User | undefined> {
    if (!this.db) return undefined;
    const result = await this.db.select().from(users).where(eq(users.id, id));
    return result[0];
  }

  async getUserByUsername(username: string): Promise<User | undefined> {
    if (!this.db) return undefined;
    const result = await this.db.select().from(users).where(eq(users.username, username));
    return result[0];
  }

  async createUser(user: InsertUser): Promise<User> {
    if (!this.db) throw new Error('Database not available');
    const result = await this.db.insert(users).values(user).returning();
    return result[0];
  }

  async updateUser(id: number, updates: UpdateProfile): Promise<User | undefined> {
    if (!this.db) return undefined;
    
    // Check if trying to update username to one that already exists
    if (updates.username) {
      const currentUser = await this.getUser(id);
      if (currentUser && updates.username !== currentUser.username) {
        const existingUser = await this.getUserByUsername(updates.username);
        if (existingUser) {
          throw new Error("Username already taken");
        }
      }
    }
    
    const result = await this.db.update(users)
      .set(updates)
      .where(eq(users.id, id))
      .returning();
    return result[0];
  }

  // Playlist methods
  async createPlaylist(playlist: InsertPlaylist): Promise<Playlist> {
    if (!this.db) throw new Error('Database not available');
    const result = await this.db.insert(playlists).values(playlist).returning();
    return result[0];
  }

  async getPlaylist(id: number): Promise<Playlist | undefined> {
    if (!this.db) return undefined;
    const result = await this.db.select().from(playlists).where(eq(playlists.id, id));
    return result[0];
  }

  async getAllPlaylists(): Promise<Playlist[]> {
    if (!this.db) return [];
    return await this.db.select().from(playlists);
  }

  async getPlaylistsByUser(userId: number): Promise<Playlist[]> {
    if (!this.db) return [];
    return await this.db.select().from(playlists).where(eq(playlists.userId, userId));
  }

  async updatePlaylist(id: number, playlistData: Partial<InsertPlaylist>): Promise<Playlist | undefined> {
    if (!this.db) return undefined;
    const result = await this.db.update(playlists)
      .set(playlistData)
      .where(eq(playlists.id, id))
      .returning();
    return result[0];
  }

  async deletePlaylist(id: number): Promise<void> {
    if (!this.db) return;
    // Delete tracks first (foreign key constraint)
    await this.db.delete(tracks).where(eq(tracks.playlistId, id));
    // Then delete playlist
    await this.db.delete(playlists).where(eq(playlists.id, id));
  }

  // Track methods
  async addTrackToPlaylist(track: InsertTrack): Promise<Track> {
    if (!this.db) throw new Error('Database not available');
    const result = await this.db.insert(tracks).values(track).returning();
    return result[0];
  }

  async removeTrack(id: number): Promise<void> {
    if (!this.db) return;
    await this.db.delete(tracks).where(eq(tracks.id, id));
  }

  async getTracksByPlaylist(playlistId: number): Promise<Track[]> {
    if (!this.db) return [];
    return await this.db.select().from(tracks).where(eq(tracks.playlistId, playlistId));
  }

  // Analytics methods
  async trackEvent(event: InsertAnalytics): Promise<Analytics> {
    if (!this.db) {
      // Return a dummy analytics object when DB is not available
      return { id: 0, ...event } as Analytics;
    }
    const result = await this.db.insert(analytics).values(event).returning();
    return result[0];
  }

  async getAnalytics(): Promise<Analytics[]> {
    if (!this.db) return [];
    return await this.db.select().from(analytics).orderBy(analytics.createdAt);
  }

  async getAnalyticsSummary(): Promise<{
    totalPageViews: number;
    totalUsers: number;
    totalLogins: number;
    todayViews: number;
    totalSearches: number;
    todaySearches: number;
  }> {
    if (!this.db) {
      return {
        totalPageViews: 0,
        totalUsers: 0,
        totalLogins: 0,
        todayViews: 0,
        totalSearches: 0,
        todaySearches: 0,
      };
    }
    
    const [analyticsData, usersData] = await Promise.all([
      this.db.select().from(analytics),
      this.db.select().from(users)
    ]);

    const today = new Date().toISOString().split('T')[0];
    
    return {
      totalPageViews: analyticsData.filter((e: Analytics) => e.eventType === 'page_view').length,
      totalUsers: usersData.length,
      totalLogins: analyticsData.filter((e: Analytics) => e.eventType === 'user_login').length,
      todayViews: analyticsData.filter((e: Analytics) => 
        e.eventType === 'page_view' && 
        e.createdAt.startsWith(today)
      ).length,
      totalSearches: analyticsData.filter((e: Analytics) => e.eventType === 'search').length,
      todaySearches: analyticsData.filter((e: Analytics) => 
        e.eventType === 'search' && 
        e.createdAt.startsWith(today)
      ).length,
    };
  }

  // Music Cache methods
  async getFromCache(query: string): Promise<MusicCache | undefined> {
    if (!this.db) return undefined;
    const normalizedQuery = query.toLowerCase().trim();
    const result = await this.db.select().from(musicCache).where(eq(musicCache.query, normalizedQuery));
    return result[0];
  }

  async saveToCache(data: InsertMusicCache): Promise<MusicCache> {
    if (!this.db) throw new Error('Database not available');
    const normalizedQuery = data.query.toLowerCase().trim();
    
    const result = await this.db.insert(musicCache).values({
      ...data,
      query: normalizedQuery
    }).returning();
    return result[0];
  }
}