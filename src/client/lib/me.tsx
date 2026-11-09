import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from "react";
import { api } from "./api";

export interface Me {
  user: { id: string; username: string; email: string } | null;
  ratings: Record<string, { rating: number; provisional: boolean; games: number }>;
}

const Ctx = createContext<{ me: Me | null; refresh: () => Promise<void> }>({ me: null, refresh: async () => {} });

export function MeProvider({ children }: { children: ReactNode }) {
  const [me, setMe] = useState<Me | null>(null);
  const refresh = useCallback(async () => {
    try {
      const r = await api<Partial<Me>>("/api/me");
      setMe({ user: r.user ?? null, ratings: r.ratings ?? {} });
    } catch {
      setMe({ user: null, ratings: {} });
    }
  }, []);
  useEffect(() => {
    void refresh();
  }, [refresh]);
  return <Ctx.Provider value={{ me, refresh }}>{children}</Ctx.Provider>;
}

export function useMe() {
  return useContext(Ctx);
}
