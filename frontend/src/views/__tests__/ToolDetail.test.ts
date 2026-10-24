import { flushPromises, mount } from '@vue/test-utils';
import { createPinia } from 'pinia';
import { expect, it, vi } from 'vitest';
import { createMemoryHistory, createRouter } from 'vue-router';

import ToolDetail from '../ToolDetail.vue';
import { getToolDetail } from '@/services/tool';

vi.mock('@/services/tool', () => ({ getToolDetail: vi.fn() }));

it('shows a retryable error and disables tool actions until full details are loaded', async () => {
  vi.mocked(getToolDetail)
    .mockRejectedValueOnce(new Error('404'))
    .mockResolvedValueOnce({
      name: 'echo',
      description: 'Recovered tool',
      serverId: 'qa',
      status: 'available',
      inputSchema: { type: 'object', properties: {} },
    });
  const router = createRouter({
    history: createMemoryHistory(),
    routes: [{ path: '/tools/:toolName/detail', component: ToolDetail }],
  });
  await router.push('/tools/echo/detail');
  const wrapper = mount(ToolDetail, { global: { plugins: [createPinia(), router] } });
  await flushPromises();
  expect(wrapper.get('[role="alert"]').text()).toContain('无法加载工具详情');
  expect(wrapper.text()).not.toContain('加载中...');
  const action = () => wrapper.findAll('button').find((b) => b.text().includes('执行工具'))!;
  expect(action().attributes()).toHaveProperty('disabled');
  await wrapper
    .findAll('button')
    .find((b) => b.text() === '重试')!
    .trigger('click');
  await flushPromises();
  expect(wrapper.find('[role="alert"]').exists()).toBe(false);
  expect(wrapper.text()).toContain('Recovered tool');
  expect(action().attributes()).not.toHaveProperty('disabled');
  wrapper.unmount();
});
