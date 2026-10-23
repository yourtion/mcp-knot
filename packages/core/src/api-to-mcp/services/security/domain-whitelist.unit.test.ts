/**
 * 域名白名单测试
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

import { DomainWhitelistImpl } from './domain-whitelist.js';

// Mock日志记录器
vi.mock('../../../utils/logger.js', () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
}));

describe('DomainWhitelistImpl', () => {
  let domainWhitelist: DomainWhitelistImpl;

  beforeEach(() => {
    domainWhitelist = new DomainWhitelistImpl();
  });

  describe('基本域名验证', () => {
    it('应该允许白名单中的域名', () => {
      domainWhitelist.addDomain('api.example.com');

      expect(domainWhitelist.isAllowed('https://api.example.com/test')).toBe(true);
      expect(domainWhitelist.isAllowed('http://api.example.com/api/v1')).toBe(true);
    });

    it('应该拒绝不在白名单中的域名', () => {
      domainWhitelist.addDomain('api.example.com');

      expect(domainWhitelist.isAllowed('https://malicious.com/test')).toBe(false);
      expect(domainWhitelist.isAllowed('http://api.other.com/api')).toBe(false);
    });

    it('应该在空白名单时拒绝所有域名', () => {
      expect(domainWhitelist.isAllowed('https://api.example.com/test')).toBe(false);
      expect(domainWhitelist.isAllowed('http://localhost:3000')).toBe(false);
    });

    it('应该处理无效的URL', () => {
      domainWhitelist.addDomain('api.example.com');

      expect(domainWhitelist.isAllowed('not-a-url')).toBe(false);
      expect(domainWhitelist.isAllowed('')).toBe(false);
      expect(domainWhitelist.isAllowed('http://')).toBe(false);
    });
  });

  describe('域名管理', () => {
    it('应该添加单个域名', () => {
      domainWhitelist.addDomain('api.example.com');

      const domains = domainWhitelist.getAllowedDomains();
      expect(domains).toContain('api.example.com');
      expect(domains).toHaveLength(1);
    });

    it('应该添加多个域名', () => {
      const domainsToAdd = ['api.example.com', 'api.test.com', 'localhost'];

      domainsToAdd.forEach((domain) => domainWhitelist.addDomain(domain));

      const domains = domainWhitelist.getAllowedDomains();
      expect(domains).toEqual(expect.arrayContaining(domainsToAdd));
      expect(domains).toHaveLength(3);
    });

    it('应该移除域名', () => {
      domainWhitelist.addDomain('api.example.com');
      domainWhitelist.addDomain('api.test.com');

      expect(domainWhitelist.getAllowedDomains()).toHaveLength(2);

      domainWhitelist.removeDomain('api.example.com');

      const domains = domainWhitelist.getAllowedDomains();
      expect(domains).not.toContain('api.example.com');
      expect(domains).toContain('api.test.com');
      expect(domains).toHaveLength(1);
    });

    it('应该避免重复添加相同域名', () => {
      domainWhitelist.addDomain('api.example.com');
      domainWhitelist.addDomain('api.example.com');

      expect(domainWhitelist.getAllowedDomains()).toHaveLength(1);
    });
  });

  describe('通配符支持', () => {
    it('应该支持子域名通配符', () => {
      domainWhitelist.addDomain('*.example.com');

      expect(domainWhitelist.isAllowed('https://api.example.com/test')).toBe(true);
      expect(domainWhitelist.isAllowed('https://www.example.com/page')).toBe(true);
      expect(domainWhitelist.isAllowed('https://sub.api.example.com/api')).toBe(true);
    });

    it('应该支持精确匹配和通配符混合', () => {
      domainWhitelist.addDomain('api.example.com'); // 精确匹配
      domainWhitelist.addDomain('*.test.com'); // 通配符匹配

      expect(domainWhitelist.isAllowed('https://api.example.com/test')).toBe(true);
      expect(domainWhitelist.isAllowed('https://www.test.com/page')).toBe(true);
      expect(domainWhitelist.isAllowed('https://api.test.com/api')).toBe(true);
      expect(domainWhitelist.isAllowed('https://www.example.com/test')).toBe(false);
    });

    it('非通配符域名不应误放行其他子域名', () => {
      domainWhitelist.addDomain('example.com');

      // 仅精确域名允许；子域名与前缀相似的域名都应拒绝
      expect(domainWhitelist.isAllowed('https://example.com/path')).toBe(true);
      expect(domainWhitelist.isAllowed('https://api.example.com/path')).toBe(false);
      expect(domainWhitelist.isAllowed('https://notexample.com/path')).toBe(false);
    });
  });

  describe('validateDomain', () => {
    it('白名单内域名应返回 allowed 且无 reason', () => {
      domainWhitelist.addDomain('api.example.com');

      const result = domainWhitelist.validateDomain('https://api.example.com/test');

      expect(result.allowed).toBe(true);
      expect(result.domain).toBe('api.example.com');
      expect(result.reason).toBeUndefined();
    });

    it('白名单外域名应返回拒绝原因', () => {
      domainWhitelist.addDomain('api.example.com');

      const result = domainWhitelist.validateDomain('https://evil.com/path');

      expect(result).toEqual({
        allowed: false,
        domain: 'evil.com',
        reason: '域名不在白名单中',
      });
    });

    it('无效 URL 应返回空域名与格式错误原因', () => {
      domainWhitelist.addDomain('api.example.com');

      const result = domainWhitelist.validateDomain('not-a-url');

      expect(result.allowed).toBe(false);
      expect(result.domain).toBe('');
      expect(result.reason).toContain('无效的URL格式');
    });
  });

  describe('配置和初始化', () => {
    it('应该从配置数组初始化', () => {
      const initialDomains = ['api.example.com', 'api.test.com', 'localhost'];
      const whitelist = new DomainWhitelistImpl(initialDomains);

      expect(whitelist.getAllowedDomains()).toEqual(expect.arrayContaining(initialDomains));
      expect(whitelist.getAllowedDomains()).toHaveLength(3);
    });

    it('应该处理空的初始配置', () => {
      const whitelist = new DomainWhitelistImpl([]);

      expect(whitelist.getAllowedDomains()).toHaveLength(0);
      expect(whitelist.isAllowed('https://api.example.com/test')).toBe(false);
    });
  });
});
