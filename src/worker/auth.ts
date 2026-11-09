import { drizzleAdapter } from "@better-auth/drizzle-adapter";
import { betterAuth } from "better-auth";
import { username } from "better-auth/plugins";
import { drizzle } from "drizzle-orm/d1";
import { emailHtml, sendEmail } from "./email";
import type { Env } from "./env";
import { randomId } from "./ids";
import { hashPassword, verifyPassword } from "./password";
import * as schema from "./schema";

export const USERNAME_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{1,18}[A-Za-z0-9]$/;
const RESERVED = new Set(["admin", "administrator", "root", "system", "stockfish", "anonymous", "bulletchess", "moderator", "support", "api", "guest"]);

export function createAuth(env: Env) {
  const secure = env.ENVIRONMENT === "production";
  return betterAuth({
    appName: "bulletchess",
    baseURL: env.APP_ORIGIN,
    basePath: "/api/auth",
    secret: env.BETTER_AUTH_SECRET,
    database: drizzleAdapter(drizzle(env.DB), { provider: "sqlite", schema }),
    trustedOrigins: [env.APP_ORIGIN],
    emailAndPassword: {
      enabled: true,
      requireEmailVerification: true,
      minPasswordLength: 10,
      maxPasswordLength: 256,
      revokeSessionsOnPasswordReset: true,
      resetPasswordTokenExpiresIn: 3600,
      password: { hash: hashPassword, verify: verifyPassword },
      sendResetPassword: async ({ user, token }) => {
        const url = `${env.APP_ORIGIN}/reset-password#token=${encodeURIComponent(token)}`;
        await sendEmail(env, {
          to: user.email,
          subject: "Reset your bulletchess password",
          text: `Someone asked to reset the password for this address on bulletchess.dev. If it was you, open:\n${url}\n\nThe link expires in an hour. If it was not you, ignore this email.`,
          html: emailHtml("Reset your password", "Someone asked to reset the password for this address. If it was you, choose a new one below. The link expires in an hour.", { label: "Choose a new password", url }, "If you didn't ask for this, ignore this email; your password stays the same."),
        });
      },
    },
    emailVerification: {
      sendOnSignUp: true,
      sendOnSignIn: true,
      autoSignInAfterVerification: true,
      expiresIn: 60 * 60 * 24,
      sendVerificationEmail: async ({ user, token }) => {
        const url = `${env.APP_ORIGIN}/verify-email#token=${encodeURIComponent(token)}`;
        await sendEmail(env, {
          to: user.email,
          subject: "Confirm your email for bulletchess",
          text: `Welcome to bulletchess.dev! Confirm this address to start playing:\n${url}\n\nThe link expires in 24 hours. If you did not sign up, ignore this email.`,
          html: emailHtml("Confirm your email", "Welcome to bulletchess. Confirm this address and you can start playing rated games straight away.", { label: "Confirm email", url }, "The link expires in 24 hours. If you didn't sign up, ignore this email."),
        });
      },
    },
    user: {
      deleteUser: { enabled: true },
    },
    session: {
      expiresIn: 60 * 60 * 24 * 30,
      updateAge: 60 * 60 * 24,
      cookieCache: { enabled: true, maxAge: 60 },
    },
    rateLimit: {
      enabled: env.ENVIRONMENT !== "test",
      storage: "database",
      window: 60,
      max: 100,
      customRules: {
        "/sign-in/email": { window: 300, max: 10 },
        "/sign-in/username": { window: 300, max: 10 },
        "/sign-up/email": { window: 3600, max: 10 },
        "/request-password-reset": { window: 3600, max: 5 },
        "/send-verification-email": { window: 3600, max: 5 },
        "/change-password": { window: 300, max: 10 },
        "/delete-user": { window: 300, max: 5 },
      },
    },
    advanced: {
      cookiePrefix: "bc",
      useSecureCookies: secure,
      defaultCookieAttributes: { httpOnly: true, sameSite: "lax", secure, path: "/" },
      database: { generateId: () => randomId(16) },
      ipAddress: { ipAddressHeaders: ["cf-connecting-ip"] },
    },
    plugins: [
      username({
        minUsernameLength: 3,
        maxUsernameLength: 20,
        usernameValidator: (u) => USERNAME_RE.test(u) && !RESERVED.has(u.toLowerCase()),
      }),
    ],
  });
}

export type Auth = ReturnType<typeof createAuth>;

export interface SessionUser {
  id: string;
  username: string;
  email: string;
}

export async function getSessionUser(env: Env, headers: Headers): Promise<SessionUser | null> {
  const auth = createAuth(env);
  const s = await auth.api.getSession({ headers });
  if (!s?.user) return null;
  const u = s.user as typeof s.user & { username?: string | null; displayUsername?: string | null };
  if (!u.emailVerified) return null;
  return { id: u.id, username: u.displayUsername || u.username || u.name, email: u.email };
}
