import passport from "passport";
import { Strategy as LocalStrategy } from "passport-local";
import { Express } from "express";
import session from "express-session";
import { scrypt, randomBytes, timingSafeEqual } from "crypto";
import { promisify } from "util";
import { storage } from "./storage";
import { User as SelectUser } from "@shared/schema";

declare global {
  namespace Express {
    interface User extends SelectUser {}
  }
}

const scryptAsync = promisify(scrypt);

async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16).toString("hex");
  const buf = (await scryptAsync(password, salt, 64)) as Buffer;
  return `${buf.toString("hex")}.${salt}`;
}

async function comparePasswords(supplied: string, stored: string): Promise<boolean> {
  const [hashed, salt] = stored.split(".");
  const hashedBuf = Buffer.from(hashed, "hex");
  const suppliedBuf = (await scryptAsync(supplied, salt, 64)) as Buffer;
  return timingSafeEqual(hashedBuf, suppliedBuf);
}

export function setupAuth(app: Express): void {
  // Gera um secret aleatório seguro se não houver um configurado
  const sessionSecret = process.env.SESSION_SECRET || randomBytes(32).toString('hex');
  
  if (!process.env.SESSION_SECRET) {
    console.warn('SESSION_SECRET not set. Using a randomly generated secret. Sessions will not persist across server restarts.');
  }
  
  const sessionSettings: session.SessionOptions = {
    secret: sessionSecret,
    resave: false,
    saveUninitialized: false,
    store: storage.sessionStore,
    cookie: {
      maxAge: 1000 * 60 * 60 * 24 * 7, // 1 semana
      secure: process.env.NODE_ENV === "production",
    }
  };

  app.set("trust proxy", 1);
  app.use(session(sessionSettings));
  app.use(passport.initialize());
  app.use(passport.session());

  passport.use(
    new LocalStrategy(async (username: string, password: string, done) => {
      try {
        const user = await storage.getUserByUsername(username);
        
        if (!user || !(await comparePasswords(password, user.password))) {
          return done(null, false);
        }
        
        return done(null, user);
      } catch (error) {
        return done(error);
      }
    }),
  );

  passport.serializeUser((user, done) => {
    done(null, user.id);
  });

  passport.deserializeUser(async (id: number, done) => {
    try {
      const user = await storage.getUser(id);
      
      if (!user) {
        return done(new Error("Usuário não encontrado"));
      }
      
      done(null, user);
    } catch (error) {
      done(error);
    }
  });

  // Rotas de autenticação
  app.post("/api/register", async (req, res, next) => {
    try {
      const { username, password } = req.body;
      
      if (!username || !password) {
        return res.status(400).json({ message: "Nome de usuário e senha são obrigatórios" });
      }
      
      // Validação de nome de usuário e senha
      if (username.length < 3) {
        return res.status(400).json({ message: "O nome de usuário deve ter pelo menos 3 caracteres" });
      }
      
      if (password.length < 6) {
        return res.status(400).json({ message: "A senha deve ter pelo menos 6 caracteres" });
      }
      
      // Verifica se o usuário já existe
      const existingUser = await storage.getUserByUsername(username);
      if (existingUser) {
        return res.status(400).json({ message: "Nome de usuário já está em uso" });
      }

      // Cria o usuário com senha hash
      const hashedPassword = await hashPassword(password);
      const user = await storage.createUser({
        username,
        password: hashedPassword,
      });

      // Faz login automático após registro
      req.login(user, (err) => {
        if (err) return next(err);
        
        // Omite a senha da resposta
        const { password: _, ...userResponse } = user;
        
        res.status(201).json(userResponse);
      });
    } catch (error) {
      console.error("Erro no registro:", error);
      res.status(500).json({ message: "Erro ao criar conta. Tente novamente." });
    }
  });

  app.post("/api/login", (req, res, next) => {
    passport.authenticate("local", (err: any, user: any, info: any) => {
      if (err) return next(err);
      
      if (!user) {
        return res.status(401).json({ message: "Nome de usuário ou senha incorretos" });
      }
      
      req.login(user, async (err) => {
        if (err) return next(err);
        
        // Registrar evento de login
        try {
          await storage.trackEvent({
            eventType: 'user_login',
            userAgent: req.get('User-Agent') || 'unknown',
            ipAddress: req.ip || req.connection.remoteAddress || 'unknown',
            userId: user.id,
            metadata: JSON.stringify({ username: user.username }),
            createdAt: new Date().toISOString(),
          });
        } catch (error) {
          console.error('Failed to track login event:', error);
        }
        
        // Omite a senha da resposta
        const { password: _, ...userResponse } = user;
        
        return res.json(userResponse);
      });
    })(req, res, next);
  });

  app.post("/api/logout", (req, res, next) => {
    req.logout((err) => {
      if (err) return next(err);
      req.session.destroy((err) => {
        if (err) return next(err);
        res.sendStatus(200);
      });
    });
  });

  app.get("/api/user", (req, res) => {
    if (!req.isAuthenticated()) {
      return res.status(401).json({ message: "Não autenticado" });
    }
    
    // Omite a senha da resposta
    const { password: _, ...userResponse } = req.user;
    
    res.json(userResponse);
  });
  
  // Rota para obter playlists do usuário autenticado
  app.get("/api/user/playlists", async (req, res) => {
    if (!req.isAuthenticated()) {
      return res.status(401).json({ message: "Não autenticado" });
    }
    
    try {
      const playlists = await storage.getPlaylistsByUser(req.user.id);
      res.json(playlists);
    } catch (error) {
      console.error("Erro ao buscar playlists do usuário:", error);
      res.status(500).json({ message: "Erro ao buscar playlists" });
    }
  });

  // Rota para atualizar perfil do usuário
  app.patch("/api/user/profile", async (req, res) => {
    if (!req.isAuthenticated()) {
      return res.status(401).json({ message: "Não autenticado" });
    }

    try {
      const { displayName, bio, avatar, username } = req.body;
      
      // Validar username se fornecido
      if (username && username.length < 3) {
        return res.status(400).json({ message: "O nome de usuário deve ter pelo menos 3 caracteres" });
      }

      const updatedUser = await storage.updateUser(req.user.id, {
        displayName,
        bio,
        avatar,
        username
      });

      if (!updatedUser) {
        return res.status(404).json({ message: "Usuário não encontrado" });
      }

      // Atualizar sessão com dados do usuário atualizado
      req.login(updatedUser, (err) => {
        if (err) {
          console.error("Erro ao atualizar sessão:", err);
          // Mesmo assim retorna o usuário atualizado
        }
      });

      // Omite a senha da resposta
      const { password: _, ...userResponse } = updatedUser;
      
      res.json(userResponse);
    } catch (error: any) {
      console.error("Erro ao atualizar perfil:", error);
      
      if (error.message === "Username already taken") {
        return res.status(400).json({ message: "Nome de usuário já está em uso" });
      }
      
      res.status(500).json({ message: "Erro ao atualizar perfil" });
    }
  });
}