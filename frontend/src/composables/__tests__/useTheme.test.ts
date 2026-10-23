import { beforeEach, describe, expect, it, vi } from 'vitest';

// 当前 jsdom 测试环境没有 localStorage，这里提供带真实语义的内存实现
const createLocalStorage = () => {
  let store: Record<string, string> = {};
  return {
    getItem: (key: string) => (key in store ? store[key] : null),
    setItem: (key: string, value: string) => {
      store[key] = String(value);
    },
    removeItem: (key: string) => {
      delete store[key];
    },
    clear: () => {
      store = {};
    },
  };
};

const setSystemPreference = (dark: boolean) => {
  vi.stubGlobal(
    'matchMedia',
    vi.fn().mockReturnValue({
      matches: dark,
      media: '(prefers-color-scheme: dark)',
      onchange: null,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    }),
  );
};

// resetModules 后 vue 与 useTheme 共用同一全新模块实例，nextTick 才能刷新其 watcher
const loadUseTheme = async () => {
  const { nextTick } = await import('vue');
  const { useTheme } = await import('../useTheme');
  return { nextTick, useTheme };
};

describe('useTheme', () => {
  beforeEach(() => {
    vi.stubGlobal('localStorage', createLocalStorage());
    document.documentElement.removeAttribute('data-theme');
    setSystemPreference(false);
    vi.resetModules();
  });

  it('本地无记录时默认 auto 并跟随系统偏好', async () => {
    setSystemPreference(true);
    const { useTheme } = await loadUseTheme();

    const { mode, resolvedTheme } = useTheme();

    expect(mode.value).toBe('auto');
    expect(resolvedTheme()).toBe('dark');
  });

  it('从本地存储恢复主题模式', async () => {
    (globalThis.localStorage as Storage).setItem('mcp-knot-theme', 'dark');
    const { useTheme } = await loadUseTheme();

    const { mode, resolvedTheme } = useTheme();

    expect(mode.value).toBe('dark');
    expect(resolvedTheme()).toBe('dark');
  });

  it('setTheme 更新模式、持久化并应用 data-theme', async () => {
    const { nextTick, useTheme } = await loadUseTheme();
    const { mode, setTheme } = useTheme();

    setTheme('dark');
    await nextTick();

    expect(mode.value).toBe('dark');
    expect((globalThis.localStorage as Storage).getItem('mcp-knot-theme')).toBe('dark');
    expect(document.documentElement.getAttribute('data-theme')).toBe('dark');
  });

  it('auto 模式下按系统偏好应用主题', async () => {
    (globalThis.localStorage as Storage).setItem('mcp-knot-theme', 'light');
    setSystemPreference(true);
    const { nextTick, useTheme } = await loadUseTheme();
    const { setTheme } = useTheme();

    setTheme('auto');
    await nextTick();

    expect((globalThis.localStorage as Storage).getItem('mcp-knot-theme')).toBe('auto');
    expect(document.documentElement.getAttribute('data-theme')).toBe('dark');
  });

  it('applyTheme 直接应用解析后的主题', async () => {
    setSystemPreference(false);
    const { useTheme } = await loadUseTheme();
    const { applyTheme } = useTheme();

    applyTheme('auto');
    expect(document.documentElement.getAttribute('data-theme')).toBe('light');

    applyTheme('dark');
    expect(document.documentElement.getAttribute('data-theme')).toBe('dark');
  });

  it('toggleTheme 在亮暗之间切换', async () => {
    const { useTheme } = await loadUseTheme();
    const { mode, setTheme, toggleTheme } = useTheme();

    setTheme('light');
    toggleTheme();
    expect(mode.value).toBe('dark');

    toggleTheme();
    expect(mode.value).toBe('light');
  });

  it('auto 模式下 toggleTheme 按当前解析主题切换', async () => {
    setSystemPreference(true);
    const { useTheme } = await loadUseTheme();
    const { mode, toggleTheme } = useTheme();

    expect(mode.value).toBe('auto');
    toggleTheme();

    expect(mode.value).toBe('light');
  });
});
