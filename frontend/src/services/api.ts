import axios, {
  type AxiosInstance,
  type AxiosResponse,
  type InternalAxiosRequestConfig,
} from 'axios';

import type { ApiResponse } from '@/types/api';

// 创建axios实例
const api: AxiosInstance = axios.create({
  baseURL: '/api',
  timeout: 10000,
  headers: {
    'Content-Type': 'application/json',
  },
});

// Token 刷新锁，防止多个 401 并发触发多次刷新
let isRefreshing = false;
let refreshSubscribers: Array<{
  resolve: (token: string) => void;
  reject: (error: unknown) => void;
}> = [];

function onTokenRefreshed(token: string): void {
  refreshSubscribers.forEach((subscriber) => subscriber.resolve(token));
  refreshSubscribers = [];
}

function addRefreshSubscriber(
  callback: (token: string) => void,
  reject: (error: unknown) => void,
): void {
  refreshSubscribers.push({ resolve: callback, reject });
}

// 扩展 AxiosRequestConfig 以支持 _retry 标记
interface RetryableConfig extends InternalAxiosRequestConfig {
  _retry?: boolean;
}

// 请求拦截器 - 添加token
api.interceptors.request.use(
  (config) => {
    const token = localStorage.getItem('auth_token');
    if (token) {
      config.headers.Authorization = `Bearer ${token}`;
    }
    return config;
  },
  (error) => {
    return Promise.reject(error);
  },
);

// 响应拦截器 - 处理token刷新（防竞态）
api.interceptors.response.use(
  (response: AxiosResponse) => {
    return response;
  },
  async (error) => {
    const originalRequest = error.config as RetryableConfig;

    if (error.response?.status === 401 && !originalRequest._retry) {
      originalRequest._retry = true;

      const storedRefreshToken = localStorage.getItem('refresh_token');
      if (!storedRefreshToken) {
        localStorage.removeItem('auth_token');
        window.location.href = '/login';
        throw error;
      }

      // 如果已经在刷新中，排队等待
      if (isRefreshing) {
        return new Promise<AxiosResponse>((resolve, reject) => {
          addRefreshSubscriber((newToken: string) => {
            originalRequest.headers.Authorization = `Bearer ${newToken}`;
            resolve(api(originalRequest));
          }, reject);
        });
      }

      isRefreshing = true;

      try {
        const response = await axios.post('/api/auth/refresh', {
          refreshToken: storedRefreshToken,
        });

        const { accessToken } = response.data.data || response.data;
        localStorage.setItem('auth_token', accessToken);

        // 通知所有排队的请求
        onTokenRefreshed(accessToken);

        // 重试原始请求
        originalRequest.headers.Authorization = `Bearer ${accessToken}`;
        return api(originalRequest);
      } catch {
        // 刷新失败，清除token并跳转到登录页
        localStorage.removeItem('auth_token');
        localStorage.removeItem('refresh_token');
        refreshSubscribers.forEach((subscriber) => subscriber.reject(error));
        refreshSubscribers = [];
        window.location.href = '/login';
        return Promise.reject(error);
      } finally {
        isRefreshing = false;
      }
    }

    throw error;
  },
);

export default api;

// 通用API响应处理函数
export const handleApiResponse = <T>(response: AxiosResponse<ApiResponse<T>>): T => {
  if (response.data.success && response.data.data !== undefined) {
    return response.data.data;
  }
  throw new Error(response.data.error?.message || '请求失败');
};
