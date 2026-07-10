import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => {
  const makeRegistration = () => vi.fn();
  return {
    setupNoteBinding: vi.fn(),
    clearSummarizers: vi.fn(),
    registerSummarizer: vi.fn(),
    mindmap: makeRegistration(),
    note: makeRegistration(),
    todo: makeRegistration(),
    finder: makeRegistration(),
    fsrs: makeRegistration(),
    qbank: makeRegistration(),
    pomodoro: makeRegistration(),
  };
});

vi.mock('../noteBinding', () => ({ setupNoteBinding: mocks.setupNoteBinding }));
vi.mock('../userPatch', () => ({
  clearUserPatchSummarizersForTests: mocks.clearSummarizers,
  registerUserPatchSummarizer: mocks.registerSummarizer,
}));
vi.mock('../drivers/mindmapDriver', () => ({ registerMindmapDriver: mocks.mindmap }));
vi.mock('../drivers/noteDriver', () => ({ registerNoteDriver: mocks.note }));
vi.mock('../drivers/todoDriver', () => ({ registerTodoDriver: mocks.todo }));
vi.mock('../drivers/finderDriver', () => ({ registerFinderDriver: mocks.finder }));
vi.mock('../drivers/fsrsDriver', () => ({ registerFsrsDriver: mocks.fsrs }));
vi.mock('../drivers/qbankDriver', () => ({ registerQbankDriver: mocks.qbank }));
vi.mock('../drivers/pomodoroDriver', () => ({ registerPomodoroDriver: mocks.pomodoro }));

import { disposeAllDrivers, registerAllDrivers } from '../drivers';
import type { StageManagerApi } from '../types';

const stage = {} as StageManagerApi;
const domainRegistrations = [mocks.todo, mocks.finder, mocks.fsrs, mocks.qbank];

beforeEach(() => {
  disposeAllDrivers();
  vi.clearAllMocks();
  mocks.setupNoteBinding.mockImplementation(() => vi.fn());
  for (const registration of domainRegistrations) {
    registration.mockImplementation(() => vi.fn());
  }
});

describe('registerAllDrivers lifecycle', () => {
  it('start -> stop -> start restores each domain listener without duplication', () => {
    registerAllDrivers(stage);
    const firstDomainDisposers = domainRegistrations.map(
      (registration) => registration.mock.results[0]!.value as ReturnType<typeof vi.fn>,
    );
    const firstNoteDisposer = mocks.setupNoteBinding.mock.results[0]!.value as ReturnType<typeof vi.fn>;

    disposeAllDrivers();
    disposeAllDrivers();

    for (const dispose of firstDomainDisposers) {
      expect(dispose).toHaveBeenCalledTimes(1);
    }
    expect(firstNoteDisposer).toHaveBeenCalledTimes(1);

    registerAllDrivers(stage);
    for (const registration of domainRegistrations) {
      expect(registration).toHaveBeenCalledTimes(2);
    }

    const secondDomainDisposers = domainRegistrations.map(
      (registration) => registration.mock.results[1]!.value as ReturnType<typeof vi.fn>,
    );
    disposeAllDrivers();
    for (const dispose of secondDomainDisposers) {
      expect(dispose).toHaveBeenCalledTimes(1);
    }
  });

  it('registering again first disposes the previous generation', () => {
    registerAllDrivers(stage);
    const firstDomainDisposers = domainRegistrations.map(
      (registration) => registration.mock.results[0]!.value as ReturnType<typeof vi.fn>,
    );

    registerAllDrivers(stage);

    for (const dispose of firstDomainDisposers) {
      expect(dispose).toHaveBeenCalledTimes(1);
    }
    for (const registration of domainRegistrations) {
      expect(registration).toHaveBeenCalledTimes(2);
    }
  });
});
