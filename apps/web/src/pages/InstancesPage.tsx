import { Instances } from '@/features/cluster/Instances';
import { Navigate } from 'react-router-dom';
import { useAuthStore } from '@/stores/useAuthStore';

export function InstancesPage() {
  const managerSession = useAuthStore((state) => state.sessionMode === 'manager_embedded');
  if (!managerSession) return <Navigate to="/config" replace />;
  return <Instances />;
}
