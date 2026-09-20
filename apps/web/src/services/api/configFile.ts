/**
 * 配置文件相关 API（/config.yaml）
 */

import { apiClient, createScopedApiRequestConfig, type ApiClientRequestScope } from './client';

export const configFileApi = {
  async fetchConfigYaml(requestScope?: ApiClientRequestScope): Promise<string> {
    const config = requestScope ? createScopedApiRequestConfig(requestScope) : {};
    const response = await apiClient.getRaw('/config.yaml', {
      ...config,
      responseType: 'text',
      headers: { ...config.headers, Accept: 'application/yaml, text/yaml, text/plain' },
    });
    const data: unknown = response.data;
    if (typeof data === 'string') return data;
    if (data === undefined || data === null) return '';
    return String(data);
  },

  async saveConfigYaml(content: string, requestScope?: ApiClientRequestScope): Promise<void> {
    const config = requestScope ? createScopedApiRequestConfig(requestScope) : {};
    await apiClient.put('/config.yaml', content, {
      ...config,
      headers: {
        ...config.headers,
        'Content-Type': 'application/yaml',
        Accept: 'application/json, text/plain, */*',
      },
    });
  },
};
