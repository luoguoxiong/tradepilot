import { create } from 'zustand';
import { persist } from 'zustand/middleware';

export interface AuthUser {
  id: string;
  email: string;
  name: string;
}

interface AuthState {
  token: string | null;
  user: AuthUser | null;
  setAuth: (token: string, user: AuthUser) => void;
  logout: () => void;
}

/**
 * 已知取舍：JWT Bearer 方案需客户端存储 token（PRD 已确认非 httpOnly cookie）。
 * MVP 单实例 + 同源代理、无第三方脚本，接受 localStorage 存储风险；生产化时换 httpOnly cookie + CSRF。
 */
export const useAuthStore = create<AuthState>()(
  persist(
    (set) => ({
      token: null,
      user: null,
      setAuth: (token, user) => set({ token, user }),
      logout: () => set({ token: null, user: null }),
    }),
    { name: 'tradepilot-auth' },
  ),
);
