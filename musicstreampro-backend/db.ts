import { Pool, neonConfig } from '@neondatabase/serverless';
import { drizzle } from 'drizzle-orm/neon-serverless';
import ws from "ws";
import * as schema from "@shared/schema";

neonConfig.webSocketConstructor = ws;

// Allow empty DATABASE_URL temporarily while Replit provisions the database
const DATABASE_URL = process.env.DATABASE_URL || '';

if (!DATABASE_URL) {
  console.warn('⚠️  DATABASE_URL is not set yet. Waiting for database provisioning...');
}

export const pool = DATABASE_URL ? new Pool({ connectionString: DATABASE_URL }) : null as any;
export const db = DATABASE_URL ? drizzle({ client: pool, schema }) : null as any;
