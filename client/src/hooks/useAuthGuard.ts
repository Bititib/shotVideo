import { useCallback } from 'react';
import { useAuthStore } from '../stores/authStore';

/**
 * 操作级别的登录拦截 Hook
 * 未登录用户可以浏览页面，但执行操作时弹出登录弹窗
 * 
 * @example
 * const guard = useAuthGuard();
 * const handleSubmit = () => {
 *   if (!guard()) return; // 未登录则弹窗并中断
 *   // ...正常逻辑
 * };
 */
export function useAuthGuard() {
  const { isAuthenticated, openLoginModal } = useAuthStore();

  return useCallback(() => {
    if (!isAuthenticated) {
      openLoginModal();
      return false;
    }
    return true;
  }, [isAuthenticated, openLoginModal]);
}
