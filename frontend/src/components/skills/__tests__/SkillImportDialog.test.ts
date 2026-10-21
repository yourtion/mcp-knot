import { flushPromises, mount } from '@vue/test-utils';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import SkillImportDialog from '../SkillImportDialog.vue';
import { second, source, stubs } from '../test-utils/fixtures';
import { skillService } from '@/services/skill';

vi.mock('@/services/skill', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/services/skill')>()),
  skillService: { saveSource: vi.fn(), syncSource: vi.fn() },
}));

function open() {
  return mount(SkillImportDialog, { props: { visible: true }, global: { stubs } });
}

async function fillGit(wrapper: ReturnType<typeof open>) {
  const inputs = wrapper.findAll('input');
  await inputs[0].setValue('team');
  await inputs[1].setValue(source.type === 'git' ? source.repository : '');
  await inputs[2].setValue('main');
  await wrapper.find('textarea').setValue('review');
}

describe('Skill imports', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    vi.mocked(skillService.saveSource).mockResolvedValue(source);
    vi.mocked(skillService.syncSource).mockResolvedValue(second);
  });

  it('registers then imports a source without publishing it', async () => {
    const wrapper = open();
    await fillGit(wrapper);
    await wrapper
      .findAll('button')
      .find((button) => button.text() === '登记并导入')!
      .trigger('click');
    await flushPromises();
    expect(skillService.saveSource).toHaveBeenCalledWith({
      id: 'team',
      type: 'git',
      repository: 'https://github.com/team/skills.git',
      ref: 'main',
      skills: ['review'],
    });
    expect(skillService.syncSource).toHaveBeenCalledExactlyOnceWith('team');
    expect(wrapper.emitted('imported')).toEqual([['team']]);
    expect(wrapper.emitted('update:visible')).toEqual([[false]]);
  });

  it('keeps registered source identity and lets a failed import retry', async () => {
    vi.mocked(skillService.syncSource).mockRejectedValueOnce(new Error('Git 无法连接'));
    const wrapper = open();
    await fillGit(wrapper);
    await wrapper
      .findAll('button')
      .find((button) => button.text() === '登记并导入')!
      .trigger('click');
    await flushPromises();
    expect(wrapper.text()).toContain('Git 无法连接');
    expect(wrapper.find('input').attributes('disabled')).toBeDefined();
    expect(wrapper.emitted('update:visible')).toBeUndefined();
    await wrapper
      .findAll('button')
      .find((button) => button.text() === '重试导入')!
      .trigger('click');
    await flushPromises();
    expect(skillService.saveSource).toHaveBeenCalledTimes(1);
    expect(skillService.syncSource).toHaveBeenCalledTimes(2);
    expect(wrapper.emitted('imported')).toEqual([['team']]);
  });

  it('validates IDs and duplicate skill names before making requests', async () => {
    const wrapper = open();
    await fillGit(wrapper);
    await wrapper.find('input').setValue('../team');
    await wrapper
      .findAll('button')
      .find((button) => button.text() === '登记并导入')!
      .trigger('click');
    await flushPromises();
    expect(skillService.saveSource).not.toHaveBeenCalled();
    await wrapper.find('input').setValue('team');
    await wrapper.find('textarea').setValue('review, review');
    await wrapper
      .findAll('button')
      .find((button) => button.text() === '登记并导入')!
      .trigger('click');
    await flushPromises();
    expect(skillService.saveSource).not.toHaveBeenCalled();
    expect(wrapper.emitted('update:visible')).toBeUndefined();
  });

  it('supports the server directory and structured CLI source forms', async () => {
    for (const type of ['local', 'skills-cli']) {
      const wrapper = open();
      await wrapper.find('input').setValue('team');
      await wrapper.find('select').setValue(type);
      await wrapper.findAll('input')[1].setValue(type === 'local' ? '/srv/skills' : 'team/skills');
      await wrapper.find('textarea').setValue('review，design\ncode');
      await wrapper
        .findAll('button')
        .find((button) => button.text() === '登记并导入')!
        .trigger('click');
      await flushPromises();
      expect(skillService.saveSource).toHaveBeenLastCalledWith({
        id: 'team',
        type,
        skills: ['review', 'design', 'code'],
        ...(type === 'local'
          ? { directory: '/srv/skills' }
          : { repository: 'team/skills', cliVersion: 'latest' }),
      });
      wrapper.unmount();
    }
  });
});
