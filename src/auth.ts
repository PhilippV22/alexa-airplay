import { randomBytes } from "node:crypto";
import argon2 from "argon2";
import { Request, Response, NextFunction } from "express";

interface SessionRecord {
  username: string;
  expiresAt: number;
}

export class AuthService {
  private readonly adminUser: string;
  private readonly sessionTtlMs: number;
  private readonly sessions = new Map<string, SessionRecord>();
  private passwordHash: string;

  private constructor(adminUser: string, passwordHash: string, sessionTtlSeconds: number) {
    this.adminUser = adminUser;
    this.passwordHash = passwordHash;
    this.sessionTtlMs = sessionTtlSeconds * 1000;
  }

  static async create(params: {
    adminUser: string;
    passwordHash?: string;
    passwordPlain?: string;
    sessionTtlSeconds: number;
  }): Promise<AuthService> {
    let hash = params.passwordHash;
    if (!hash) {
      if (!params.passwordPlain) {
        throw new Error("Either passwordHash or passwordPlain is required");
      }
      hash = await argon2.hash(params.passwordPlain, { type: argon2.argon2id });
    }
    return new AuthService(params.adminUser, hash, params.sessionTtlSeconds);
  }

  async login(username: string, password: string): Promise<string | null> {
    if (username !== this.adminUser) {
      return null;
    }

    const valid = await argon2.verify(this.passwordHash, password);
    if (!valid) {
      return null;
    }

    const token = randomBytes(32).toString("hex");
    this.sessions.set(token, {
      username,
      expiresAt: Date.now() + this.sessionTtlMs,
    });
    return token;
  }

  logout(token: string): void {
    this.sessions.delete(token);
  }

  validateSession(token: string | undefined): SessionRecord | null {
    if (!token) {
      return null;
    }
    const record = this.sessions.get(token);
    if (!record) {
      return null;
    }

    if (Date.now() >= record.expiresAt) {
      this.sessions.delete(token);
      return null;
    }

    return record;
  }

  getSessionCookieOptions(isProduction: boolean, maxAgeMs: number) {
    return {
      httpOnly: true,
      secure: isProduction,
      sameSite: "lax" as const,
      signed: true,
      maxAge: maxAgeMs,
      path: "/",
    };
  }

  requireAuth = (req: Request, res: Response, next: NextFunction): void => {
    const token = req.signedCookies?.airbridge_session as string | undefined;
    const record = this.validateSession(token);
    if (!record) {
      res.status(401).json({
        error: "UNAUTHORIZED",
        message: "Authentication required",
      });
      return;
    }
    req.user = {
      username: record.username,
      token: token as string,
    };
    next();
  };
}

declare global {
  namespace Express {
    interface Request {
      user?: {
        username: string;
        token: string;
      };
      requestId?: string;
    }
  }
}
