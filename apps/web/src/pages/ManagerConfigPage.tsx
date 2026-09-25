import { ConfigPage } from '@/features/config/ConfigPage';
import { Navigate } from 'react-router-dom';
import { useAuthStore } from '@/stores/useAuthStore';

export function ManagerConfigPage() {
  const managerSession = useAuthStore((state) => state.sessionMode === 'manager_embedded');
  if (!managerSession) return <Navigate to="/config" replace />;
  return <ConfigPage managerOnly />;
}
