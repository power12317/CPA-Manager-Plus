import { beforeEach, expect, it, vi } from 'vitest';
import type { ModelInfo } from '@/utils/models';

const { fetchModels } = vi.hoisted(() => ({ fetchModels: vi.fn() }));
vi.mock('@/services/api/models', () => ({ modelsApi: { fetchModels } }));
import { useModelsStore } from './useModelsStore';

beforeEach(() => {
  fetchModels.mockReset();
  useModelsStore.getState().clearCache();
});

it('ignores a previous instance model response arriving after the new instance', async () => {
  let resolveOld!: (models: ModelInfo[]) => void;
  fetchModels.mockImplementationOnce(
    () =>
      new Promise<ModelInfo[]>((resolve) => {
        resolveOld = resolve;
      })
  );
  const old = useModelsStore.getState().fetchModels('http://old');
  useModelsStore.getState().clearCache();
  const current: ModelInfo[] = [{ name: 'current' }];
  fetchModels.mockResolvedValueOnce(current);
  await useModelsStore.getState().fetchModels('http://new');
  resolveOld([{ name: 'old' }]);
  await old;
  expect(useModelsStore.getState().models).toEqual(current);
  expect(useModelsStore.getState().cache?.apiBase).toBe('http://new');
});
