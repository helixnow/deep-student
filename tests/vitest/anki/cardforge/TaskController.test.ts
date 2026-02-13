import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@tauri-apps/api/core', () => ({
  invoke: vi.fn(),
}));

import { invoke } from '@tauri-apps/api/core';
import { TaskController } from '@/components/anki/cardforge/engines/TaskController';

const backendTasks = [
  {
    task_id: 'task-1',
    segment_index: 0,
    status: 'Processing',
    cards_generated: 2,
    error_message: null,
  },
  {
    id: 'task-2',
    segment_index: 1,
    status: 'Failed',
    cards_generated: 0,
    error_message: 'boom',
  },
];

const expectedTasks = [
  {
    taskId: 'task-1',
    segmentIndex: 0,
    status: 'processing',
    cardsGenerated: 2,
    errorMessage: undefined,
  },
  {
    taskId: 'task-2',
    segmentIndex: 1,
    status: 'failed',
    cardsGenerated: 0,
    errorMessage: 'boom',
  },
];

describe('TaskController', () => {
  let controller: TaskController;

  beforeEach(() => {
    vi.clearAllMocks();
    controller = new TaskController();
  });

  it('pause should call backend and return tasks', async () => {
    vi.mocked(invoke).mockImplementation(async (command) => {
      if (command === 'pause_document_processing') {
        return undefined;
      }
      if (command === 'get_document_tasks') {
        return backendTasks;
      }
      return undefined;
    });

    const result = await controller.pause(' doc-1 ');

    expect(invoke).toHaveBeenCalledWith('pause_document_processing', { documentId: 'doc-1' });
    expect(result.ok).toBe(true);
    expect(result.tasks).toEqual(expectedTasks);
  });

  it('resume should call backend and return tasks', async () => {
    vi.mocked(invoke).mockImplementation(async (command) => {
      if (command === 'resume_document_processing') {
        return undefined;
      }
      if (command === 'get_document_tasks') {
        return backendTasks;
      }
      return undefined;
    });

    const result = await controller.resume('doc-1');

    expect(invoke).toHaveBeenCalledWith('resume_document_processing', { documentId: 'doc-1' });
    expect(result.ok).toBe(true);
    expect(result.tasks).toEqual(expectedTasks);
  });

  it('retry should call backend and return tasks', async () => {
    vi.mocked(invoke).mockImplementation(async (command, payload) => {
      if (command === 'trigger_task_processing') {
        expect(payload).toEqual({ task_id: 'task-2' });
        return undefined;
      }
      if (command === 'get_document_tasks') {
        return backendTasks;
      }
      return undefined;
    });

    const result = await controller.retry('doc-1', ' task-2 ');

    expect(invoke).toHaveBeenCalledWith('trigger_task_processing', { task_id: 'task-2' });
    expect(result.ok).toBe(true);
    expect(result.tasks).toEqual(expectedTasks);
  });

  it('cancel should call backend and clear tasks', async () => {
    vi.mocked(invoke).mockResolvedValue(undefined);

    const result = await controller.cancel(' doc-1 ');

    expect(invoke).toHaveBeenCalledWith('delete_document_session', { documentId: 'doc-1' });
    expect(result.ok).toBe(true);
    expect(result.tasks).toEqual([]);
  });
});
