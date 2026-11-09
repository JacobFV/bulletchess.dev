import { createAuthClient } from "better-auth/react";
import { usernameClient } from "better-auth/client/plugins";

export const authClient = createAuthClient({
  baseURL: `${location.origin}/api/auth`,
  plugins: [usernameClient()],
});

/** Human-friendly message for a Better Auth error. */
export function authMessage(err: { message?: string; code?: string; status?: number } | null | undefined, fallback = "Something went wrong."): string {
  if (!err) return fallback;
  switch (err.code) {
    case "INVALID_EMAIL_OR_PASSWORD":
    case "INVALID_USERNAME_OR_PASSWORD":
      return "Wrong email/username or password.";
    case "EMAIL_NOT_VERIFIED":
      return "Confirm your email first. We just sent you a new link.";
    case "USER_ALREADY_EXISTS":
    case "USER_ALREADY_EXISTS_USE_ANOTHER_EMAIL":
      return "An account with this email already exists.";
    case "USERNAME_IS_ALREADY_TAKEN":
    case "USERNAME_IS_ALREADY_TAKEN_PLEASE_TRY_ANOTHER":
      return "That username is taken.";
    case "INVALID_USERNAME":
      return "Usernames are 3–20 letters, digits, _ or -, starting and ending with a letter or digit.";
    case "PASSWORD_TOO_SHORT":
      return "Use at least 10 characters.";
    case "INVALID_TOKEN":
      return "This link is invalid or has expired.";
  }
  if (err.status === 429) return "Too many attempts. Wait a few minutes and try again.";
  return err.message || fallback;
}
