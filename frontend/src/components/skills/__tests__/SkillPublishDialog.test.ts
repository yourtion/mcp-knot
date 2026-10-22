import { flushPromises, mount } from '@vue/test-utils';
import { MessagePlugin } from 'tdesign-vue-next';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import SkillPublishDialog from '../SkillPublishDialog.vue';
import {
  first,
  groupDetail,
  groupInfo,
  other,
  second,
  source,
  stubs,
} from '../test-utils/fixtures';
import { getGroup, getGroups, updateGroup } from '@/services/group';
import { skillService } from '@/services/skill';

vi.mock('@/services/group', () => ({
  getGroup: vi.fn(),
  getGroups: vi.fn(),
  updateGroup: vi.fn(),
}));
vi.mock('@/services/skill', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/services/skill')>()),
  skillService: { listSources: vi.fn(), listRevisions: vi.fn() },
}));
vi.mock('tdesign-vue-next', async (importOriginal) => ({
  ...(await importOriginal<typeof import('tdesign-vue-next')>()),
  MessagePlugin: { success: vi.fn() },
}));

async function open(revision = second.revision) {
  const wrapper = mount(SkillPublishDialog, {
    props: { visible: true, groupId: 'design', sourceId: 'team', revision },
    global: { stubs },
  });
  await flushPromises();
  return wrapper;
}

describe('Group skill publication', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    vi.mocked(skillService.listSources).mockResolvedValue([source]);
    vi.mocked(skillService.listRevisions).mockResolvedValue([second, first]);
    vi.mocked(getGroups).mockResolvedValue({ groups: [groupInfo()] } as Awaited<
      ReturnType<typeof getGroups>
    >);
    vi.mocked(getGroup).mockResolvedValue(groupDetail([...first.selections, other]));
    vi.mocked(updateGroup).mockResolvedValue({} as Awaited<ReturnType<typeof updateGroup>>);
  });

  it('previews an explicit publication and preserves other skill selections and Group configuration', async () => {
    const wrapper = await open();
    expect(updateGroup).not.toHaveBeenCalled();
    expect(wrapper.text()).toContain(first.revision.slice(0, 12));
    expect(wrapper.text()).toContain(second.revision.slice(0, 12));
    expect(wrapper.text()).toContain('/design/mcp');
    await wrapper
      .findAll('button')
      .find((button) => button.text() === '发布所选版本')!
      .trigger('click');
    await flushPromises();
    expect(updateGroup).toHaveBeenCalledExactlyOnceWith('design', {
      skills: { include: [other, ...second.selections] },
    });
    expect(wrapper.emitted('saved')).toHaveLength(1);
    expect(MessagePlugin.success).toHaveBeenCalled();
  });

  it('rolls back using saved historical selections without source synchronization', async () => {
    vi.mocked(getGroup).mockResolvedValue(groupDetail([...second.selections, other]));
    const wrapper = await open(first.revision);
    const button = wrapper
      .findAll('button')
      .find((item) => item.text() === '回滚 / 发布此历史版本')!;
    expect(button.attributes('disabled')).toBeUndefined();
    await button.trigger('click');
    await flushPromises();
    expect(updateGroup).toHaveBeenCalledWith('design', {
      skills: { include: [other, ...first.selections] },
    });
  });

  it('blocks no-op publications and empty skill selections', async () => {
    const wrapper = await open(first.revision);
    expect(
      wrapper
        .findAll('button')
        .find((button) => button.text() === '回滚 / 发布此历史版本')!
        .attributes('disabled'),
    ).toBeDefined();
    await wrapper.findAll('select')[2].setValue(second.revision);
    await wrapper.find('select[multiple]').setValue([]);
    expect(
      wrapper
        .findAll('button')
        .find((button) => button.text() === '发布所选版本')!
        .attributes('disabled'),
    ).toBeDefined();
    expect(updateGroup).not.toHaveBeenCalled();
  });

  it('requires a new choice when the requested historical version is unavailable', async () => {
    vi.mocked(skillService.listRevisions).mockResolvedValue([second]);
    const wrapper = await open(first.revision);
    expect(wrapper.text()).toContain('所选版本已不可用');
    expect(
      wrapper
        .findAll('button')
        .find((button) => button.text() === '发布所选版本')!
        .attributes('disabled'),
    ).toBeDefined();
    expect(updateGroup).not.toHaveBeenCalled();
  });

  it('refreshes a changed Group instead of overwriting a stale selection', async () => {
    const wrapper = await open();
    vi.mocked(getGroup).mockResolvedValue(groupDetail([other]));
    await wrapper
      .findAll('button')
      .find((button) => button.text() === '发布所选版本')!
      .trigger('click');
    await flushPromises();
    expect(updateGroup).not.toHaveBeenCalled();
    expect(wrapper.text()).toContain('已被其他操作修改');
  });

  it('keeps the dialog open and reports a failed publication without a success event', async () => {
    vi.mocked(updateGroup).mockRejectedValue(new Error('保存失败'));
    const wrapper = await open();
    await wrapper
      .findAll('button')
      .find((button) => button.text() === '发布所选版本')!
      .trigger('click');
    await flushPromises();
    expect(wrapper.text()).toContain('保存失败');
    expect(wrapper.emitted('saved')).toBeUndefined();
    expect(wrapper.emitted('update:visible')).toBeUndefined();
  });

  it('revokes a skill while retaining other source selections', async () => {
    const wrapper = await open();
    await wrapper.findAll('.confirm-revoke')[0].trigger('click');
    await flushPromises();
    expect(updateGroup).toHaveBeenCalledWith('design', { skills: { include: [other] } });
  });

  it('prevents revoking the final skill from a Group without servers', async () => {
    vi.mocked(getGroup).mockResolvedValue({ ...groupDetail(), servers: [] });
    const wrapper = await open();
    expect(wrapper.text()).toContain('纯技能 Group 至少需要保留一个技能');
    expect(
      wrapper
        .findAll('button')
        .find((button) => button.text() === '撤销')!
        .attributes('disabled'),
    ).toBeDefined();
    await wrapper.find('.confirm-revoke').trigger('click');
    await flushPromises();
    expect(updateGroup).not.toHaveBeenCalled();
  });
});
