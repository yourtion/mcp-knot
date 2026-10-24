/**
 * JsonStorage 测试
 * mock node:fs/promises，验证目录创建、读取默认值回退与写入格式
 */
import * as fs from 'node:fs/promises';
import path from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { JsonStorage } from './json_storage.js';
import { logger } from './logger.js';

vi.mock('node:fs/promises', () => ({
  access: vi.fn(),
  mkdir: vi.fn(async () => undefined),
  readFile: vi.fn(),
  writeFile: vi.fn(async () => undefined),
}));

vi.mock('./logger.js', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

const mockedFs = vi.mocked(fs);
const flushAsync = () => new Promise<void>((resolve) => setImmediate(resolve));

function enoent(): NodeJS.ErrnoException {
  return Object.assign(new Error('ENOENT: no such file or directory'), { code: 'ENOENT' });
}

describe('JsonStorage', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('构造与目录确保', () => {
    it('目录已存在时不创建目录', async () => {
      mockedFs.access.mockResolvedValue(undefined);

      new JsonStorage('/tmp/data/config.json');
      await flushAsync();

      expect(mockedFs.access).toHaveBeenCalledWith(path.resolve('/tmp/data'));
      expect(mockedFs.mkdir).not.toHaveBeenCalled();
    });

    it('目录不存在时递归创建', async () => {
      mockedFs.access.mockRejectedValue(enoent());

      new JsonStorage('/tmp/missing-dir/data/config.json');
      await flushAsync();

      expect(mockedFs.mkdir).toHaveBeenCalledWith(path.resolve('/tmp/missing-dir/data'), {
        recursive: true,
      });
    });

    it('路径被解析为绝对路径', async () => {
      mockedFs.access.mockResolvedValue(undefined);

      const storage = new JsonStorage('relative/data.json');

      // 读取任意内容验证内部路径基于 cwd 解析
      mockedFs.readFile.mockResolvedValue('{}');
      await storage.read();

      expect(mockedFs.readFile).toHaveBeenCalledWith(
        path.resolve(process.cwd(), 'relative/data.json'),
        'utf-8',
      );
    });
  });

  describe('read', () => {
    it('解析并返回文件内容', async () => {
      mockedFs.access.mockResolvedValue(undefined);
      mockedFs.readFile.mockResolvedValue('{"name":"mcp-hub"}');

      const storage = new JsonStorage<Record<string, unknown>>('/tmp/data/config.json');
      const data = await storage.read();

      expect(data).toEqual({ name: 'mcp-hub' });
    });

    it('文件不存在且有默认值时写入默认值并返回', async () => {
      mockedFs.access.mockResolvedValue(undefined);
      mockedFs.readFile.mockRejectedValue(enoent());
      const defaultValue = { servers: {} };

      const storage = new JsonStorage('/tmp/data/mcp.json', defaultValue);
      const data = await storage.read();

      expect(data).toBe(defaultValue);
      expect(mockedFs.writeFile).toHaveBeenCalledWith(
        path.resolve('/tmp/data/mcp.json'),
        JSON.stringify(defaultValue, null, 2),
        'utf-8',
      );
    });

    it('文件不存在且无默认值时抛出原始错误', async () => {
      mockedFs.access.mockResolvedValue(undefined);
      const error = enoent();
      mockedFs.readFile.mockRejectedValue(error);

      const storage = new JsonStorage('/tmp/data/mcp.json');
      await expect(storage.read()).rejects.toBe(error);
      expect(mockedFs.writeFile).not.toHaveBeenCalled();
      expect(logger.error).toHaveBeenCalledWith(
        'JSON 文件读取失败',
        expect.any(Error),
        expect.objectContaining({ filePath: path.resolve('/tmp/data/mcp.json') }),
      );
    });

    it('文件内容非法 JSON 时抛出解析错误且不覆盖文件', async () => {
      mockedFs.access.mockResolvedValue(undefined);
      mockedFs.readFile.mockResolvedValue('not-json{{{');

      const storage = new JsonStorage('/tmp/data/broken.json', { fallback: true });
      await expect(storage.read()).rejects.toThrow();
      expect(mockedFs.writeFile).not.toHaveBeenCalled();
    });

    it('非 ENOENT 错误（如权限）不回退默认值', async () => {
      mockedFs.access.mockResolvedValue(undefined);
      mockedFs.readFile.mockRejectedValue(
        Object.assign(new Error('EACCES: permission denied'), { code: 'EACCES' }),
      );

      const storage = new JsonStorage('/tmp/data/protected.json', { fallback: true });
      await expect(storage.read()).rejects.toMatchObject({ code: 'EACCES' });
    });

    it('被拒绝的是普通对象（非 Error）时不回退默认值', async () => {
      mockedFs.access.mockResolvedValue(undefined);
      mockedFs.readFile.mockRejectedValue({ code: 'ENOENT' });

      const storage = new JsonStorage('/tmp/data/odd.json', { fallback: true });
      await expect(storage.read()).rejects.toEqual({ code: 'ENOENT' });
    });
  });

  describe('write', () => {
    it('以两空格缩进写入 JSON', async () => {
      mockedFs.access.mockResolvedValue(undefined);

      const storage = new JsonStorage('/tmp/data/config.json');
      await storage.write({ a: 1, b: { c: 2 } });

      expect(mockedFs.writeFile).toHaveBeenCalledWith(
        path.resolve('/tmp/data/config.json'),
        '{\n  "a": 1,\n  "b": {\n    "c": 2\n  }\n}',
        'utf-8',
      );
    });

    it('写入失败时记录日志并重新抛出', async () => {
      mockedFs.access.mockResolvedValue(undefined);
      const error = new Error('disk full');
      mockedFs.writeFile.mockRejectedValue(error);

      const storage = new JsonStorage('/tmp/data/config.json');
      await expect(storage.write({})).rejects.toBe(error);
      expect(logger.error).toHaveBeenCalledWith(
        'JSON 文件写入失败',
        expect.any(Error),
        expect.objectContaining({ filePath: path.resolve('/tmp/data/config.json') }),
      );
    });
  });
});
